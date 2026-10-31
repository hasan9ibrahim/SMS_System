defmodule Sms.Switch.Pipeline.ScenariosTest do
  # Regression tests for switch scenarios found broken in review (docs/SMPP_SCENARIOS.md), end to end on fake data: a
  # customer client binds and submits, the switch sends to a fake vendor SMSC, receipts come back.
  use Sms.Switch.Test.VendorCase, async: false
  @moduletag capture_log: true

  alias Sms.Core.Bus.Local
  alias Sms.Switch.Pipeline
  alias Sms.Switch.Test.{Client, CustomerCase, PipelineConfig}
  alias Sms.Switch.Throttle

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

    customers = [
      Keyword.get(opts, :customer, CustomerCase.trunk()) | Keyword.get(opts, :more_customers, [])
    ]

    %{port: port} =
      CustomerCase.start_customer(
        trunks: customers,
        intake: Pipeline.Intake,
        session: Keyword.get(opts, :session, [])
      )

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
    case :ets.lookup(Throttle, {:buffer, key}) do
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
      start_supervised!(Throttle)
      start_supervised!({Pipeline.Buffers, discover_ms: 3_600_000})
      assert Throttle.buffer_take("ct:42", 3)
      assert buffer_count("ct:42") == 1
      Pipeline.Buffers.kick("ct.42")
      # The drain stops after 5 s with nothing to do.
      assert_eventually(fn -> buffer_count("ct:42") == 0 end, 8_000)
    end
  end

  # A message's receipt data as the forwarder keeps it (`Forwarder.core/1`), from client `ip` of trunk `trunk_id`.
  defp held_data(id, ip, trunk_id \\ 1) do
    %{
      id: id,
      ids: [id],
      edr_id: "e-" <> id,
      received_at: System.os_time(:millisecond),
      origin: %{session_id: "gone-" <> id, trunk_id: trunk_id, ip: ip, bind: :trx},
      trunk: %{id: trunk_id, enterprise_id: 11, dlr_session_affinity: :strict, dlr_hold_hours: 72},
      source: "FakeBank",
      source_ton: 5,
      source_npi: 0,
      destination: @dest,
      destination_ton: 1,
      destination_npi: 1,
      registered_delivery: 1,
      text: "hi",
      parts: 1,
      vendor_trunk_id: nil
    }
  end

  defp hold(data, at) do
    receipt = %{status: "DELIVRD", error: "000", network_error: 0, done_at: at, received_at: at}
    entry = %{data: data, receipt: receipt, held_at: at, until: at + 3_600_000}
    :ok = Pipeline.Store.hold(data.trunk.id, entry, at, "#{data.id}:final")
  end

  defp held_ids(trunk_id) do
    {:ok, held} = Pipeline.Store.held(trunk_id, 100)
    Enum.map(held, fn {_, e} -> e.data.id end)
  end

  defp receipted(%Pdu{tlvs: tlvs}), do: List.keyfind(tlvs, :receipted_message_id, 0)

  describe "held receipts (§13.1, S-5.13, S-5.14)" do
    test "a receipt for an IP with no session never blocks the trunk's other held receipts" do
      %{client: client} = start_all()
      now = System.os_time(:millisecond)
      # Oldest first: one for a client IP with no session now, then one for the IP that is bound.
      hold(held_data("other-ip", {10, 1, 2, 3}), now)
      hold(held_data("bound-ip", {127, 0, 0, 1}), now + 1)

      run = Task.async(fn -> Pipeline.Held.run(1) end)
      assert {_, %Pdu{} = dlr} = recv_until(client, &(&1.command == :deliver_sm), 1_500)
      assert receipted(dlr) == {:receipted_message_id, "bound-ip"}
      Task.await(run)
      # (The bind's own drain may be the run that sent it.)
      assert_eventually(fn -> held_ids(1) == ["other-ip"] end)
    end

    test "a receipt the customer refuses for now (0x58) is held and sent again later, once" do
      %{client: client, conn: conn} = start_all()
      send_submit(client, %{short_message: "hello", registered_delivery: 1}, [], 2)

      {client, %Pdu{status: 0, fields: %{message_id: id}}} =
        recv_until(client, &(&1.command == :submit_sm_resp))

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000
      Process.sleep(200)

      text =
        "id:1 sub:001 dlvrd:001 submit date:2610241200 done date:2610241201 stat:DELIVRD err:000 text:"

      FakeSmsc.send_pdu(
        conn,
        Pdu.new(:deliver_sm, %{esm_class: 0x04, short_message: text}, sequence: 900)
      )

      assert {client, %Pdu{command: :deliver_sm} = dlr} = Client.recv(client, 3_000)
      Client.send_pdu(client, Pdu.response(dlr, :esme_rthrottled))

      # Held with a later try, not recorded as delivered.
      assert_eventually(fn -> held_ids(1) == [id] end)
      {:ok, [{member, entry}]} = Pipeline.Store.held(1, 10)
      assert entry.tries == 1 and entry.retry_at > System.os_time(:millisecond)
      refute Enum.any?(edr("edr.receipt"), &(&1["kind"] == "customer"))

      # Not before its time; then sent, and released once answered.
      Pipeline.Held.run(1)
      assert Client.recv(client, 300) == {:error, :timeout}
      :ok = Pipeline.Store.update_held(1, member, %{entry | retry_at: 0})
      run = Task.async(fn -> Pipeline.Held.run(1) end)
      assert {client, %Pdu{command: :deliver_sm} = again} = Client.recv(client, 2_000)
      assert receipted(again) == {:receipted_message_id, id}
      Client.send_pdu(client, Pdu.response(again, :esme_rok, %{message_id: ""}))
      Task.await(run)
      assert held_ids(1) == []

      assert_eventually(fn ->
        Enum.count(edr("edr.receipt"), &(&1["kind"] == "customer")) == 1
      end)

      assert Client.recv(client, 300) == {:error, :timeout}
    end

    test "a receipt is held once however often the bus delivers it, and it waits in progress (S-5.14)" do
      start_all()
      # No session from this IP: held.
      data = held_data("twice", {10, 9, 9, 9})
      receipt = %{status: "DELIVRD", error: "000", network_error: 0, done_at: 1, received_at: 1}
      assert Pipeline.Forwarder.deliver(data, receipt) == :ok
      assert Pipeline.Forwarder.deliver(data, receipt) == :ok
      assert held_ids(1) == ["twice"]

      assert Pipeline.Forwarder.consumer_options()[:progress_ms] <
               Pipeline.Forwarder.consumer_options()[:ack_wait_ms]
    end

    test "a slow customer holds back neither another trunk's receipts nor its own other ones (S-1.18)" do
      more = [CustomerCase.trunk(id: 2, username: "other", name: "OTHER")]

      %{port: port} =
        start_all(
          config: [
            customer_trunks: [
              PipelineConfig.customer_trunk(),
              PipelineConfig.customer_trunk(id: 2)
            ]
          ],
          more_customers: more,
          session: [deliver_timeout_ms: 1_500]
        )

      {fast, %{status: 0}} =
        Client.bind(port, :bind_transceiver, %{system_id: "other", password: "secret"})

      now = System.os_time(:millisecond)
      # Trunk 1's client (bound by start_all) never answers; trunk 2's does.
      for n <- 1..3, do: hold(held_data("slow-#{n}", {127, 0, 0, 1}), now + n)
      hold(held_data("fast", {127, 0, 0, 1}, 2), now)

      send(Pipeline.Held, :sweep)
      assert {_, %Pdu{} = dlr} = recv_until(fast, &(&1.command == :deliver_sm), 1_000)
      assert receipted(dlr) == {:receipted_message_id, "fast"}

      # Trunk 1's run waited once, for its first receipt: all three are kept for a later try.
      assert_eventually(fn -> held_ids(2) == [] end)
      Process.sleep(2_000)
      assert Enum.sort(held_ids(1)) == ["slow-1", "slow-2", "slow-3"]
    end
  end

  # The vendor's submits for one message, until none comes for 300 ms.
  defp vendor_parts(conn, acc \\ []) do
    receive do
      {:smsc, ^conn, %Pdu{command: :submit_sm} = pdu} -> vendor_parts(conn, [pdu | acc])
    after
      300 -> Enum.reverse(acc)
    end
  end

  defp sar(ref, n), do: [sar_msg_ref_num: ref, sar_total_segments: 2, sar_segment_seqnum: n]

  describe "part counts (S-3.1, S-3.10, S-4.1, D3)" do
    test "a client's 160-character SAR parts with no translation go to the vendor, never 'translation grows'" do
      %{client: client, conn: conn} = start_all()
      a = String.duplicate("a", 160)
      b = String.duplicate("b", 160)
      send_submit(client, %{short_message: a, registered_delivery: 1}, sar(77, 1), 2)
      send_submit(client, %{short_message: b, registered_delivery: 1}, sar(77, 2), 3)
      {statuses, _client} = resps(client, 2)
      assert statuses == [0, 0]

      # Split again at 153 for the vendor: 320 characters are 3 parts.
      parts = vendor_parts(conn)
      assert length(parts) == 3

      assert Enum.map_join(
               parts,
               &binary_part(&1.fields.short_message, 6, byte_size(&1.fields.short_message) - 6)
             ) == a <> b

      refute Enum.any?(edr("edr.attempt"), &(&1["command_status"] == 0x45))
    end

    test "UCS-2 SAR parts of 70 characters go too, as parts of 67" do
      %{client: client, conn: conn} = start_all()
      one = :binary.copy(<<0x04, 0x10>>, 70)
      two = :binary.copy(<<0x04, 0x11>>, 70)
      send_submit(client, %{data_coding: 8, short_message: one}, sar(5, 1), 2)
      send_submit(client, %{data_coding: 8, short_message: two}, sar(5, 2), 3)
      {[0, 0], _client} = resps(client, 2)
      parts = vendor_parts(conn)
      assert length(parts) == 3
      assert Enum.all?(parts, &(&1.fields.data_coding == 8))
      assert Enum.map(parts, &(byte_size(&1.fields.short_message) - 6)) == [134, 134, 12]
    end
  end

  describe "UDH elements other than concatenation (D9, S-3.12)" do
    test "a single message's language shift table and a binary message's ports reach the vendor" do
      %{client: client, conn: conn} = start_all()
      # National language single shift (IE 0x24, Turkish).
      shift = <<3, 0x24, 1, 1>>
      send_submit(client, %{esm_class: 0x40, short_message: shift <> "Merhaba"}, [], 2)
      {[0], client} = resps(client, 1)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.esm_class == 0x40
      assert sent.fields.short_message == shift <> "Merhaba"

      # Application ports (IE 0x05: 2948 from 9200), 8-bit data.
      ports = <<6, 0x05, 4, 0x0B, 0x84, 0x23, 0xF0>>
      data = <<1, 6, 4, 3, 0xAE, 0x81, 0xEA>>

      send_submit(
        client,
        %{esm_class: 0x40, data_coding: 0x04, short_message: ports <> data},
        [],
        3
      )

      {[0], _client} = resps(client, 1)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert {sent.fields.esm_class, sent.fields.data_coding} == {0x40, 0x04}
      assert sent.fields.short_message == ports <> data
    end

    test "a multipart message's shift table is in every part the switch makes, and takes its room" do
      %{client: client, conn: conn} = start_all()
      # 149 characters a part: what a 9-octet header (concatenation + shift table) leaves.
      a = String.duplicate("a", 149)
      b = String.duplicate("b", 149)
      udh = fn n -> <<8, 0x00, 3, 42, 2, n, 0x24, 1, 1>> end
      send_submit(client, %{esm_class: 0x40, short_message: udh.(1) <> a}, [], 2)
      send_submit(client, %{esm_class: 0x40, short_message: udh.(2) <> b}, [], 3)
      {[0, 0], _client} = resps(client, 2)

      parts = vendor_parts(conn)
      assert length(parts) == 2

      for {part, n} <- Enum.with_index(parts, 1) do
        assert part.fields.esm_class == 0x40
        assert <<8, 0x00, 3, _ref, 2, ^n, 0x24, 1, 1, text::binary>> = part.fields.short_message
        # 9 octets of header pad to 11 septets: at most 149 characters.
        assert byte_size(text) <= 149
      end

      assert Enum.map_join(parts, &binary_part(&1.fields.short_message, 9, 149)) == a <> b
    end
  end

  describe "Latin-1 Default Coding (S-2.11, S-4.6)" do
    test "data_coding 0 goes to the vendor in GSM when every character has one, else as data_coding 3" do
      %{client: client, conn: conn} =
        start_all(config: [customer_trunks: [PipelineConfig.customer_trunk(default_coding: 3)]])

      send_submit(client, %{data_coding: 0, short_message: <<"caf", 0xE9>>}, [], 2)
      {[0], client} = resps(client, 1)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      # GSM 03.38: é is 0x05.
      assert {sent.fields.data_coding, sent.fields.short_message} == {0, <<"caf", 0x05>>}

      # ï has no GSM character.
      send_submit(client, %{data_coding: 0, short_message: <<"na", 0xEF, "ve">>}, [], 3)
      {[0], _client} = resps(client, 1)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert {sent.fields.data_coding, sent.fields.short_message} == {3, <<"na", 0xEF, "ve">>}
    end
  end
end
