defmodule Sms.Switch.Customer.ClusterTest do
  # Two servers (spec §14, decisions Q12/Q13): Max Connections counts the binds on both (S-1.2), and a receipt finds
  # its session on whichever server holds it (§13.1). The second server is a peer BEAM node.
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
