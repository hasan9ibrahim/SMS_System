defmodule Sms.Switch.Customer.SendersTest do
  # Max Connections per client address and the TPS pool that follows the addresses sending (team trial round 14,
  # spec §5.4), on one server; the two-server case is in cluster_test.exs.
  use ExUnit.Case, async: false
  alias Sms.Switch.Customer.{Senders, Sessions, Trunk}
  alias Sms.Switch.Test.Cluster

  setup do
    start_supervised!(%{
      id: :sessions,
      start: {Supervisor, :start_link, [Sessions.child_specs(), [strategy: :one_for_one]]}
    })

    :ok
  end

  defp trunk(max, tps \\ 5),
    do: %Trunk{id: 41, username: "acme", password: "p", max_connections: max, tps: tps}

  defp meta(id, bind, ip) do
    %{
      id: id,
      trunk_id: 41,
      system_id: "acme",
      ip: ip,
      port: 1,
      bind: bind,
      node: node(),
      bound_at: DateTime.utc_now(),
      tls: nil
    }
  end

  test "each client address may open Max Connections sessions" do
    {a1, :ok} = Cluster.fake_session(trunk(2), meta("a1", :trx, {192, 0, 2, 10}))
    {a2, :ok} = Cluster.fake_session(trunk(2), meta("a2", :tx, {192, 0, 2, 10}))
    {_, refused} = Cluster.fake_session(trunk(2), meta("a3", :rx, {192, 0, 2, 10}))
    assert refused == {:error, :max_connections}

    # A second address, e.g. inside the same allowed network, binds twice too: four sessions in all.
    {b1, :ok} = Cluster.fake_session(trunk(2), meta("b1", :trx, {192, 0, 2, 11}))
    {b2, :ok} = Cluster.fake_session(trunk(2), meta("b2", :rx, {192, 0, 2, 11}))
    assert Sessions.cluster_count(41) == 4
    assert Sessions.cluster_count(41, {192, 0, 2, 10}) == 2
    # A freed slot is the address's own.
    send(a1, :stop)
    wait_until(fn -> Sessions.cluster_count(41, {192, 0, 2, 10}) == 1 end)
    {a4, :ok} = Cluster.fake_session(trunk(2), meta("a4", :trx, {192, 0, 2, 10}))
    for pid <- [a2, a4, b1, b2], do: send(pid, :stop)
  end

  test "the pool is TPS × Max Connections × the addresses sending, at least one" do
    t = trunk(2, 50)
    assert Trunk.trunk_tps(t) == 100
    {a, :ok} = Cluster.fake_session(t, meta("pa", :tx, {198, 51, 100, 1}))
    wait_until(fn -> Senders.count(41) == 1 end)
    assert Trunk.trunk_tps(t) == 100
    {b, :ok} = Cluster.fake_session(t, meta("pb", :trx, {198, 51, 100, 2}))
    # Receive-only sessions send nothing and do not count.
    {r, :ok} = Cluster.fake_session(t, meta("pr", :rx, {198, 51, 100, 3}))
    wait_until(fn -> Senders.count(41) == 2 end)
    assert Trunk.trunk_tps(t) == 200
    assert Trunk.tps_counters(t) == [{:trunk_tps, "ct:41", 200}]
    for pid <- [a, b, r], do: send(pid, :stop)
    wait_until(fn -> Senders.count(41) == 0 end)
    assert Trunk.trunk_tps(t) == 100
  end

  test "counts the groups already there when it starts, ignores other messages, reads 0 when stopped" do
    {a, :ok} = Cluster.fake_session(trunk(3), meta("s1", :tx, {203, 0, 113, 7}))
    wait_until(fn -> Senders.count(41) == 1 end)
    # A restart rebuilds the counts from the scope.
    :ok = GenServer.stop(Senders)
    wait_until(fn -> Process.whereis(Senders) not in [nil] end)
    wait_until(fn -> Senders.count(41) == 1 end)
    send(Senders, :unrelated)
    assert Senders.count(41) == 1
    send(a, :stop)
    stop_supervised!(:sessions)
    assert Senders.count(41) == 0
  end

  defp wait_until(fun, tries \\ 300) do
    cond do
      fun.() -> :ok
      tries == 0 -> flunk("condition not met")
      true -> Process.sleep(10) && wait_until(fun, tries - 1)
    end
  end
end
