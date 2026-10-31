defmodule Sms.Switch.Pipeline.ScenariosTest do
  # Regression tests for switch scenarios found broken in review (docs/SMPP_SCENARIOS.md), end to end on fake data: a
  # customer client binds and submits, the switch sends to a fake vendor SMSC, receipts come back.
  use Sms.Switch.Test.VendorCase, async: false
  @moduletag capture_log: true

  alias Sms.Core.Bus.Local
  alias Sms.Switch.Pipeline
  alias Sms.Switch.Test.{Client, CustomerCase, PipelineConfig}

  @dest "4915112345678"

  setup do
    start_supervised!(Sms.Core.Bus)
    start_supervised!(Pipeline.Store)
    start_supervised!(Pipeline.Delayed)
    start_supervised!(Pipeline.LiveTps)
    :ok
  end

  # Configuration, both sides and the consumers; returns the bound client and the fake SMSC's connection.
  defp start_all(opts \\ []) do
    PipelineConfig.put(Keyword.get(opts, :config, []))
    start_supervised!({Pipeline.Config.Server, loader: PipelineConfig})
    CustomerCase.assert_eventually(&Pipeline.Config.ready?/0)
    start_supervised!(Pipeline.Sender)
    start_supervised!(Pipeline.Forwarder)
    start_supervised!({Pipeline.Held, sweep_ms: 60_000})
    start_supervised!(Pipeline.Held.OnBind)
    start_supervised!({Pipeline.Buffers, discover_ms: 3_600_000})
    smsc = start_smsc()

    vendor =
      trunk(
        FakeSmsc.port(smsc),
        Keyword.merge([id: 1, name: "V1"], Keyword.get(opts, :vendor, []))
      )

    start_vendor([vendor], receipts: Pipeline.Receipts)
    await_bound(1, 1)
    [conn] = FakeSmsc.connections(smsc)
    customer = Keyword.get(opts, :customer, CustomerCase.trunk())
    %{port: port} = CustomerCase.start_customer(trunks: [customer], intake: Pipeline.Intake)

    {client, resp} =
      Client.bind(port, :bind_transceiver, %{system_id: "acme", password: "secret"})

    assert resp.status == 0
    %{client: client, conn: conn, port: port, smsc: smsc}
  end

  defp edr(type), do: for(e <- Local.published(), e.type == type, do: e.data)

  # The start of a TPS second, so a burst meets one count.
  defp align_second, do: Process.sleep(1_000 - rem(System.os_time(:millisecond), 1_000) + 5)

  defp send_submit(client, fields, tlvs, seq) do
    fields = Map.merge(%{source_addr: "FakeBank", destination_addr: @dest}, fields)
    Client.send_pdu(client, Pdu.new(:submit_sm, fields, tlvs: tlvs, sequence: seq))
  end

  # The next PDU that `pred` accepts; receipts on the way are answered OK.
  defp recv_until(client, pred, timeout \\ 5_000) do
    case Client.recv(client, timeout) do
      {:error, _} = error ->
        error

      {client, pdu} ->
        if pdu.command == :deliver_sm,
          do: Client.send_pdu(client, Pdu.response(pdu, :esme_rok, %{message_id: ""}))

        if pred.(pdu), do: {client, pdu}, else: recv_until(client, pred, timeout)
    end
  end

  defp resps(client, n) do
    Enum.map_reduce(1..n, client, fn _, client ->
      {client, pdu} = recv_until(client, &(&1.command == :submit_sm_resp))
      {pdu.status, client}
    end)
  end

  # The trunk's overflow buffer places in use (the local count: these tests run without Redis).
  defp buffer_count(key) do
    case :ets.lookup(Sms.Switch.Throttle, {:buffer, key}) do
      [{_, n}] -> n
      [] -> 0
    end
  end

  describe "overflow buffer places (S-2.4)" do
    test "a duplicate of a buffered submit gives its place back (D6)" do
      %{client: client, conn: conn} =
        start_all(
          customer: CustomerCase.trunk(tps: 1, max_connections: 1, overflow_buffer: 2),
          config: [customer_trunks: [PipelineConfig.customer_trunk(duplicate_window_s: 60)]]
        )

      align_second()
      send_submit(client, %{short_message: "first"}, [], 2)
      send_submit(client, %{short_message: "second"}, [], 3)
      send_submit(client, %{short_message: "second"}, [], 4)
      {statuses, _client} = resps(client, 3)
      assert statuses == [0, 0, 0]

      for _ <- 1..2, do: assert_receive({:smsc, ^conn, %Pdu{command: :submit_sm}}, 3_000)
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 1_500
      assert buffer_count("ct:1") == 0
    end

    test "buffered multipart parts take a place each and give them all back once sent" do
      %{client: client, conn: conn} =
        start_all(customer: CustomerCase.trunk(tps: 1, max_connections: 1, overflow_buffer: 5))

      align_second()
      send_submit(client, %{short_message: "uses the TPS"}, [], 2)

      for n <- 1..3,
          do:
            send_submit(
              client,
              %{esm_class: 0x40, short_message: <<5, 0, 3, 9, 3, n>> <> "part#{n}"},
              [],
              2 + n
            )

      {statuses, _client} = resps(client, 4)
      assert statuses == [0, 0, 0, 0]
      for _ <- 1..2, do: assert_receive({:smsc, ^conn, %Pdu{command: :submit_sm}}, 4_000)
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 1_500
      assert buffer_count("ct:1") == 0
    end

    test "buffered parts of a group that times out give their places back (D1)" do
      %{client: client} =
        start_all(
          customer: CustomerCase.trunk(tps: 1, max_connections: 1, overflow_buffer: 5),
          config: [customer_trunks: [PipelineConfig.customer_trunk(reassembly_timeout_s: 1)]]
        )

      start_supervised!({Pipeline.Timeouts, sweep_ms: 100})
      align_second()
      send_submit(client, %{short_message: "uses the TPS"}, [], 2)
      # Two parts of three: the group never completes.
      for n <- 1..2,
          do:
            send_submit(
              client,
              %{esm_class: 0x40, short_message: <<5, 0, 3, 4, 3, n>> <> "p#{n}"},
              [],
              2 + n
            )

      {statuses, _client} = resps(client, 3)
      assert statuses == [0, 0, 0]
      assert buffer_count("ct:1") == 2

      assert_eventually(
        fn -> Enum.count(edr("edr.attempt"), &(&1["c_msg_status"] == "REJECTD")) == 2 end,
        4_000
      )

      assert buffer_count("ct:1") == 0
    end

    test "a drain that finds its buffer empty clears places lost with a server" do
      start_supervised!(Sms.Switch.Throttle)
      start_supervised!({Pipeline.Buffers, discover_ms: 3_600_000})
      assert Sms.Switch.Throttle.buffer_take("ct:42", 3)
      assert buffer_count("ct:42") == 1
      Pipeline.Buffers.kick("ct.42")
      # The drain stops after 5 s with nothing to do.
      assert_eventually(fn -> buffer_count("ct:42") == 0 end, 8_000)
    end
  end
end
