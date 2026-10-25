defmodule Sms.Switch.Vendor.ManagerQuorumTest do
  # With a witness configured, a server that reaches neither the other server nor the witness opens no vendor
  # connection, and opens them once it has a majority again (backend step 8, Sms.Switch.Vendor.Quorum).
  use Sms.Switch.Test.VendorCase, async: false
  @moduletag capture_log: true

  setup do
    start_supervised!(Sms.Core.Bus)
    smsc = start_smsc()
    before = Application.get_env(:sms_core, Sms.Core.Cluster)
    on_exit(fn -> Application.put_env(:sms_core, Sms.Core.Cluster, before || []) end)
    %{port: FakeSmsc.port(smsc)}
  end

  test "alone in the cluster: no connection; the majority back: the connections open", %{
    port: port
  } do
    Application.put_env(:sms_core, Sms.Core.Cluster,
      peers: ["sms@server-b", "sms@witness"],
      witness: "sms@witness"
    )

    start_vendor([trunk(port, max_connections: 2)])
    Manager.reconcile()
    Process.sleep(300)
    assert Manager.sessions() == %{}

    # The quorum check every 2 s sees the change (here: no witness any more) and opens them.
    Application.put_env(:sms_core, Sms.Core.Cluster, peers: [])
    await_bound(1, 2, 5_000)
    assert map_size(Manager.sessions()) == 2
  end
end
