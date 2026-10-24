defmodule Sms.Switch.Vendor.ClusterTest do
  # Two servers (decision Q12): a vendor trunk's Max Connections are split between them, a server left alone opens
  # them all, and a submit on either server reaches a connection on the other. The second server is a peer node.
  use Sms.Switch.Test.VendorCase, async: false
  alias Sms.Switch.Test.Cluster

  @moduletag :integration
  @moduletag capture_log: true

  setup do
    start_supervised!(Sms.Core.Bus)
    smsc = start_smsc()
    port = FakeSmsc.port(smsc)
    {peer, node} = Cluster.start_peer(:"switch-v-#{System.unique_integer([:positive])}")
    # The failover test stops the peer itself.
    on_exit(fn ->
      try do
        :peer.stop(peer)
      catch
        :exit, _ -> :ok
      end
    end)

    %{port: port, peer: peer, node: node}
  end

  defp count_on(node), do: map_size(:erpc.call(node, Manager, :sessions, []))

  test "connections are split between the servers and taken over when one stops",
       %{port: port} = ctx do
    trunks = [trunk(port, max_connections: 4)]
    start_vendor(trunks)
    await_bound(1, 4)
    # Alone, this server opened all four.
    assert map_size(Manager.sessions()) == 4

    _ = :erpc.call(ctx.node, Cluster, :start_vendor, [trunks, [tick_ms: 50]])
    assert_eventually(fn -> Manager.nodes() == Enum.sort([node(), ctx.node]) end, 5_000)

    assert_eventually(
      fn -> map_size(Manager.sessions()) == 2 and count_on(ctx.node) == 2 end,
      5_000
    )

    await_bound(1, 4, 5_000)
    assert length(:pg.get_local_members(:sms_vendor_sessions, {:tx, 1})) == 2

    # The other server stops: this one opens its connections again.
    :peer.stop(ctx.peer)
    assert_eventually(fn -> Manager.nodes() == [node()] end, 5_000)
    assert_eventually(fn -> map_size(Manager.sessions()) == 4 end, 5_000)
    await_bound(1, 4, 5_000)
  end

  test "a submit on one server is sent on the other's connection when it has none bound",
       %{port: port} = ctx do
    # One connection, on the other server: connection 0 of trunk `id` goes to the node at position rem(id, 2).
    id = if Enum.at(Enum.sort([node(), ctx.node]), 1) == ctx.node, do: 1, else: 2
    trunks = [trunk(port, id: id, max_connections: 1)]
    start_vendor(trunks)
    _ = :erpc.call(ctx.node, Cluster, :start_vendor, [trunks, [tick_ms: 50]])
    assert_eventually(fn -> Manager.sessions() == %{} and count_on(ctx.node) == 1 end, 5_000)
    await_bound(id, 1, 5_000)
    assert :pg.get_local_members(:sms_vendor_sessions, {:tx, id}) == []

    assert {:ok, %{status: 0}} = Vendor.submit(id, :submit_sm, %{destination_addr: "49151"})
  end
end
