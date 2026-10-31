defmodule Sms.Switch.Customer.ClusterTest do
  # Two servers (spec §14, decisions Q12/Q13): Max Connections counts the binds on both (S-1.2), per client address
  # (team trial round 14), and a receipt finds its session on whichever server holds it (§13.1). The second server is
  # a peer BEAM node.
  use ExUnit.Case, async: false
  alias Sms.Switch.Customer.{Affinity, Sessions, Trunk}
  alias Sms.Switch.Test.Cluster

  @moduletag :integration

  setup_all do
    {peer, node} = Cluster.start_peer(:"switch-b-#{System.unique_integer([:positive])}")
    _ = :erpc.call(node, Cluster, :start_sessions, [])
    on_exit(fn -> :peer.stop(peer) end)
    %{node: node}
  end

  setup do
    start_supervised!(%{
      id: :sessions,
      start: {Supervisor, :start_link, [Sessions.child_specs(), [strategy: :one_for_one]]}
    })

    :ok
  end

  defp meta(id, bind, ip \\ {10, 0, 0, 1}) do
    %{
      id: id,
      trunk_id: 7,
      system_id: "acme",
      ip: ip,
      port: 1,
      bind: bind,
      node: node(),
      bound_at: DateTime.utc_now(),
      tls: nil
    }
  end

  defp trunk(max), do: %Trunk{id: 7, username: "acme", password: "p", max_connections: max}

  test "Max Connections counts the sessions on both servers", %{node: node} do
    {remote, :ok} = :erpc.call(node, Cluster, :fake_session, [trunk(2), meta("r1", :trx)])
    assert Sessions.cluster_count(7) == 1
    {local, :ok} = Cluster.fake_session(trunk(2), meta("l1", :trx))
    assert Sessions.cluster_count(7) == 2
    {_, result} = Cluster.fake_session(trunk(2), meta("l2", :trx))
    assert result == {:error, :max_connections}
    {_, result} = :erpc.call(node, Cluster, :fake_session, [trunk(2), meta("r2", :trx)])
    assert result == {:error, :max_connections}
    # A slot freed on the other server is usable here.
    send(remote, :stop)
    wait_until(fn -> Sessions.cluster_count(7) == 1 end)
    {_, :ok} = Cluster.fake_session(trunk(2), meta("l3", :trx))
    send(local, :stop)
  end

  test "Max Connections counts per client address on both servers (team trial round 14)", %{
    node: node
  } do
    a = {10, 0, 0, 1}
    b = {10, 0, 0, 2}
    {remote, :ok} = :erpc.call(node, Cluster, :fake_session, [trunk(1), meta("pa-r", :trx, a)])
    # The address is full on the other server: refused here too.
    {_, result} = Cluster.fake_session(trunk(1), meta("pa-l1", :trx, a))
    assert result == {:error, :max_connections}
    # Another address has its own Max Connections.
    {local, :ok} = Cluster.fake_session(trunk(1), meta("pa-l2", :trx, b))
    assert Sessions.cluster_count(7) == 2
    assert Sessions.cluster_count(7, a) == 1 and Sessions.cluster_count(7, b) == 1
    for pid <- [remote, local], do: send(pid, :stop)
    wait_until(fn -> Sessions.cluster_count(7) == 0 end)
  end

  test "the TPS pool grows with the addresses sending on either server (team trial round 14)", %{
    node: node
  } do
    t = %Trunk{trunk(2) | tps: 10}
    assert Trunk.trunk_tps(t) == 20

    {remote, :ok} =
      :erpc.call(node, Cluster, :fake_session, [t, meta("tp-r", :tx, {10, 0, 0, 1})])

    {local, :ok} = Cluster.fake_session(t, meta("tp-l", :trx, {10, 0, 0, 2}))
    {same, :ok} = Cluster.fake_session(t, meta("tp-s", :tx, {10, 0, 0, 2}))
    # A receive-only session sends nothing: its address adds nothing to the pool.
    {rx, :ok} = Cluster.fake_session(t, meta("tp-rx", :rx, {10, 0, 0, 3}))
    wait_until(fn -> Sessions.sending_addresses(7) == 2 end)
    assert Trunk.trunk_tps(t) == 40
    # The address still sends on its other session.
    send(local, :stop)

    wait_until(fn ->
      :pg.get_members(:sms_customer_sessions, {:sender_ip, 7, {10, 0, 0, 2}}) == [same]
    end)

    assert Sessions.sending_addresses(7) == 2
    send(same, :stop)
    wait_until(fn -> Sessions.sending_addresses(7) == 1 end)
    send(remote, :stop)
    wait_until(fn -> Sessions.sending_addresses(7) == 0 end)
    assert Trunk.trunk_tps(t) == 20
    send(rx, :stop)
  end

  test "binds racing on both servers never exceed Max Connections", %{node: node} do
    results =
      [node(), node, node(), node, node(), node]
      |> Enum.with_index()
      |> Enum.map(fn {n, i} ->
        Task.async(fn ->
          :erpc.call(n, Cluster, :fake_session, [trunk(3), meta("race#{i}", :rx)])
        end)
      end)
      |> Enum.map(&Task.await(&1, 10_000))

    assert Enum.count(results, fn {_, r} -> r == :ok end) == 3
    assert Sessions.cluster_count(7) == 3
    for {pid, _} <- results, do: send(pid, :stop)
  end

  test "a receipt finds its receiving session on the other server (§13.1 rule 2)", %{node: node} do
    {remote, :ok} = :erpc.call(node, Cluster, :fake_session, [trunk(5), meta("rx-remote", :trx)])
    wait_until(fn -> Sessions.receiver("rx-remote") == [remote] end)
    origin = %{session_id: "rx-remote", trunk_id: 7, ip: {10, 0, 0, 1}, bind: :trx}
    assert Affinity.candidates(origin, :strict) == [remote]
    # Same IP: sessions on this server come first.
    {local, :ok} = Cluster.fake_session(trunk(5), meta("rx-local", :rx))
    wait_until(fn -> length(Sessions.receivers(7, {10, 0, 0, 1})) == 2 end)
    assert Sessions.receivers(7, {10, 0, 0, 1}) == [local, remote]
    # TX sessions are never receivers.
    {tx, :ok} = Cluster.fake_session(trunk(5), meta("tx", :tx))
    assert Sessions.receiver("tx") == []
    for pid <- [remote, local, tx], do: send(pid, :stop)
  end

  defp wait_until(fun, tries \\ 200) do
    cond do
      fun.() -> :ok
      tries == 0 -> flunk("condition not met")
      true -> Process.sleep(10) && wait_until(fun, tries - 1)
    end
  end
end
