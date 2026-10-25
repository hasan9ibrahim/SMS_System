defmodule SmppSim.LoopTest do
  # The fake customers against the fake vendor, without a switch: every accepted message gets one receipt.
  use ExUnit.Case, async: false
  alias SmppSim.{Esme, Load, Smsc, Stats}
  alias SmppSim.Smsc.Dlr

  setup do
    Stats.reset()
    Dlr.clear()
    Smsc.reset_config()
    smsc = start_supervised!({Smsc, port: 0, ip: {127, 0, 0, 1}})
    %{smsc: smsc, port: Smsc.port(smsc)}
  end

  defp load(port, opts \\ []) do
    {:ok, _} =
      Load.start(
        Keyword.merge(
          [
            trunks: [%{system_id: "loop1", password: "x"}, %{system_id: "loop2", password: "x"}],
            sessions: 2,
            hosts: [{"127.0.0.1", port}],
            prefixes: {"4477", "3361"},
            window: 50,
            multipart_pct: 20
          ],
          opts
        )
      )
  end

  test "messages, multipart and receipts round trip; the window and rate are respected", %{port: port} do
    Smsc.configure(dlr_ms: {10, 50}, resp_ms: {0, 2})
    load(port)
    Load.set_rate(400)
    Process.sleep(1_500)
    assert Load.info().bound == 4
    Load.set_rate(0)
    assert Load.wait_until(fn -> Stats.awaiting_receipts() == 0 and Dlr.pending() == 0 end, 5_000)
    Load.stop()

    assert Stats.get(:submitted) > 300
    assert Stats.get(:parts_submitted) > Stats.get(:submitted)
    assert Stats.get(:resp_ok) == Stats.get(:parts_submitted)
    assert Stats.get(:receipts) == Stats.get(:resp_ok)
    assert Stats.get(:receipts_dup) == 0
    assert Stats.get(:receipts_unknown) == 0
    assert Stats.get(:smsc_duplicates) == 0
  end

  test "vendor errors, a silent vendor and no receipts asked", %{port: port} do
    Smsc.configure(error_pct: 100.0, error_status: 0x58)
    load(port, receipts: false, multipart_pct: 0)
    Load.set_rate(200)
    Process.sleep(500)
    assert Stats.get(:resp_throttled) > 0
    Smsc.configure(error_pct: 0.0, mode: :silent)
    Process.sleep(300)
    assert Stats.get(:smsc_silent) > 0
    Smsc.configure(mode: :normal)
    Load.set_rate(0)
    Load.stop(500)
    assert Stats.get(:receipts) == 0
  end

  test "a refused bind is retried; dropped connections are counted and bound again", %{smsc: smsc, port: port} do
    Smsc.configure(mode: :refuse)

    {:ok, pid} =
      DynamicSupervisor.start_child(
        SmppSim.EsmeSup,
        {Esme, hosts: [{"127.0.0.1", port}], system_id: "r1", password: "x", prefixes: {"44"}}
      )

    Process.sleep(300)
    assert Stats.get(:bind_fail) >= 1
    Smsc.configure(mode: :normal)
    assert Load.wait_until(fn -> Esme.info(pid).state == :bound end, 3_000)

    Smsc.drop_all(smsc)
    assert Load.wait_until(fn -> Stats.get(:disconnects) >= 1 end, 2_000)
    assert Load.wait_until(fn -> Esme.info(pid).state == :bound end, 3_000)
    Esme.stop(pid)
  end

  test "the switch's requests are answered: enquire_link, unbind, an unknown command", %{port: port} do
    alias Sms.Switch.Smpp.Pdu
    {:ok, s} = :gen_tcp.connect(~c"127.0.0.1", port, [:binary, active: false])
    send_pdu = fn pdu -> :ok = :gen_tcp.send(s, Pdu.encode!(pdu)) end
    send_pdu.(Pdu.new(:bind_transmitter, %{system_id: "tx", password: "x", interface_version: 0x34}, sequence: 1))
    send_pdu.(Pdu.new(:enquire_link, %{}, sequence: 2))
    :ok = :gen_tcp.send(s, <<16::32, 0x00000999::32, 0::32, 3::32>>)
    send_pdu.(Pdu.new(:unbind, %{}, sequence: 4))
    Process.sleep(200)
    {:ok, data} = :gen_tcp.recv(s, 0, 1_000)
    commands = decode_all(data, [])
    assert [:bind_transmitter_resp, :enquire_link_resp, :generic_nack, :unbind_resp] = commands
  end

  defp decode_all(data, acc) do
    case Sms.Switch.Smpp.Pdu.decode(data) do
      {:ok, pdu, rest} -> decode_all(rest, acc ++ [pdu.command])
      _ -> acc
    end
  end

  test "receipt fields come from the TLVs, or from the text when there are none" do
    {fields, tlvs} = Dlr.receipt("ABC", "LoadTest", "4477000", "UNDELIV", 0)
    pdu = %Sms.Switch.Smpp.Pdu{command: :deliver_sm, fields: fields, tlvs: tlvs}
    assert Esme.receipt_fields(pdu) == {"ABC", "UNDELIV"}
    assert Esme.receipt_fields(%{pdu | tlvs: []}) == {"ABC", "UNDELIV"}
  end
end
