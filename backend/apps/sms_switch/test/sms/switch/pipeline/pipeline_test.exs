defmodule Sms.Switch.Pipeline.PipelineTest do
  # The whole message path on fake data (build step 4, spec §2, §6, docs/SMPP_SCENARIOS.md): a customer client binds
  # and submits, the switch routes and sends to a fake vendor SMSC, the vendor's receipt comes back to the customer.
  use Sms.Switch.Test.VendorCase, async: false
  @moduletag capture_log: true

  alias Sms.Core.Bus.Event
  alias Sms.Switch.Pipeline
  alias Sms.Switch.Pipeline.Held.OnBind
  alias Sms.Switch.Test.{Client, CustomerCase, PipelineConfig}

  @dest "4915112345678"

  setup do
    start_supervised!(Sms.Core.Bus)
    start_supervised!(Pipeline.Store)
    :ok
  end

  # Configuration, both sides and the consumers; returns the bound client, the fake SMSC and its connection.
  defp start_all(opts \\ []) do
    PipelineConfig.put(Keyword.get(opts, :config, []))
    start_supervised!({Pipeline.Config.Server, loader: PipelineConfig})
    CustomerCase.assert_eventually(&Pipeline.Config.ready?/0)
    start_supervised!(Pipeline.Sender)
    start_supervised!(Pipeline.Forwarder)
    start_supervised!({Pipeline.Held, sweep_ms: 60_000})
    start_supervised!(Pipeline.Held.OnBind)

    smscs = for _ <- 1..Keyword.get(opts, :smscs, 1), do: start_smsc()

    vendor_fields = Keyword.get(opts, :vendor_fields, %{})

    vendors =
      smscs
      |> Enum.with_index(1)
      |> Enum.map(fn {s, id} ->
        trunk(FakeSmsc.port(s), [id: id, name: "V#{id}"] ++ Map.get(vendor_fields, id, []))
      end)

    start_vendor(vendors, receipts: Pipeline.Receipts)
    for v <- vendors, do: await_bound(v.id, 1)

    conns =
      for s <- smscs do
        [conn] = FakeSmsc.connections(s)
        conn
      end

    customer = Keyword.get(opts, :customer, CustomerCase.trunk())
    %{port: port} = CustomerCase.start_customer(trunks: [customer], intake: Pipeline.Intake)
    bind = Keyword.get(opts, :bind, :bind_transceiver)
    {client, resp} = Client.bind(port, bind, %{system_id: "acme", password: "secret"})
    assert resp.status == 0
    %{client: client, smscs: smscs, conns: conns, port: port}
  end

  defp submit(client, fields, seq \\ 2) do
    fields =
      Map.merge(
        %{
          source_addr: "FakeBank",
          source_addr_ton: 5,
          destination_addr: @dest,
          dest_addr_ton: 1,
          dest_addr_npi: 1
        },
        fields
      )

    Client.send_pdu(client, Pdu.new(:submit_sm, fields, sequence: seq))

    assert {client, %Pdu{command: :submit_sm_resp, sequence: ^seq} = resp} =
             Client.recv(client, 5_000)

    {client, resp}
  end

  defp receipt(conn, vendor_id, stat, err \\ "000") do
    text =
      "id:#{vendor_id} sub:001 dlvrd:001 submit date:2610241200 done date:2610241201 stat:#{stat} err:#{err} text:"

    FakeSmsc.send_pdu(
      conn,
      Pdu.new(:deliver_sm, %{esm_class: 0x04, short_message: text}, sequence: 900)
    )
  end

  # The customer's next deliver_sm, answered.
  defp customer_receipt(client, timeout \\ 3_000) do
    assert {client, %Pdu{command: :deliver_sm} = pdu} = Client.recv(client, timeout)
    Client.send_pdu(client, Pdu.response(pdu, :esme_rok, %{message_id: ""}))
    {client, pdu}
  end

  # The submit_sm_resp and the receipt, in either order: the in-memory bus runs the consumers inside the intake, so a
  # receipt the switch makes at once can be sent while the submit is still open (the session holds it at most 1 s).
  defp resp_and_receipt(client) do
    {client, pdus} =
      Enum.reduce(1..2, {client, []}, fn _, {client, pdus} ->
        assert {client, pdu} = Client.recv(client, 5_000)

        if pdu.command == :deliver_sm,
          do: Client.send_pdu(client, Pdu.response(pdu, :esme_rok, %{message_id: ""}))

        {client, [pdu | pdus]}
      end)

    [resp] = Enum.filter(pdus, &(&1.command == :submit_sm_resp))
    [dlr] = Enum.filter(pdus, &(&1.command == :deliver_sm))
    {client, resp, dlr}
  end

  defp edr(type), do: for(e <- Local.published(), e.type == type, do: e.data)

  describe "a message delivered" do
    test "is routed, rated, sent with receipts asked, and its receipt comes back to the customer" do
      %{client: client, conns: [conn]} = start_all()

      {client, resp} =
        submit(client, %{short_message: "Your code is 1234", registered_delivery: 1})

      assert resp.status == 0
      id = resp.fields.message_id
      assert id =~ ~r/\A[0-9a-f]{20}\z/

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.destination_addr == @dest
      assert sent.fields.source_addr == "FakeBank"
      assert sent.fields.source_addr_ton == 5
      # Receipts are always asked of the vendor (S-2.14).
      assert sent.fields.registered_delivery == 1
      assert sent.fields.short_message == "Your code is 1234"

      assert_eventually(fn -> match?([_], edr("edr.attempt")) end)
      [attempt] = edr("edr.attempt")
      assert attempt["c_message_id"] == id
      assert attempt["is_submit_success"] == 1
      assert attempt["is_final_attempt"] == 1
      assert attempt["c_mccmnc"] == "26201"
      assert attempt["c_rate"] == "0.05"
      assert attempt["v_rate"] == "0.02"
      assert attempt["v_trunk_id"] == 1
      assert attempt["v_message_id"] == "1"
      assert attempt["route_rule_id"] == 1
      assert attempt["c_msg_status"] == "ACCEPTD"

      # (The in-memory bus forwards inside the vendor's receipt handling, so the customer answers first here.)
      receipt(conn, "1", "DELIVRD")
      {_client, dlr} = customer_receipt(client)
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, status: 0}}, 2_000
      assert dlr.fields.esm_class == 0x04
      # From the receiver back to the sender.
      assert dlr.fields.source_addr == @dest
      assert dlr.fields.destination_addr == "FakeBank"
      assert dlr.fields.short_message =~ "id:#{id} sub:001 dlvrd:001"
      assert dlr.fields.short_message =~ "stat:DELIVRD err:000 text:Your code is 1234"
      assert {:receipted_message_id, id} in dlr.tlvs
      assert {:message_state, 2} in dlr.tlvs

      assert_eventually(fn -> length(edr("edr.receipt")) == 2 end)
      [vendor_row, customer_row] = edr("edr.receipt")

      assert %{
               "kind" => "vendor",
               "msg_status" => "DELIVRD",
               "edr_id" => edr_id,
               "is_duplicate" => 0
             } = vendor_row

      assert edr_id == attempt["edr_id"]

      assert %{"kind" => "customer", "c_msg_status" => "DELIVRD", "receipt_session_id" => sid} =
               customer_row

      assert sid != ""
    end

    test "a second final receipt for the same part is recorded as a duplicate and not forwarded (S-5.8)" do
      %{client: client, conns: [conn]} = start_all()
      {client, _} = submit(client, %{short_message: "hello", registered_delivery: 1})
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000

      receipt(conn, "1", "DELIVRD")
      {client, _} = customer_receipt(client)
      receipt(conn, "1", "UNDELIV")
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, status: 0}}, 2_000
      assert {:error, :timeout} = Client.recv(client, 500)

      assert_eventually(fn -> Enum.any?(edr("edr.receipt"), &(&1["is_duplicate"] == 1)) end)
    end

    test "a receipt that comes before the submit_sm_resp is handled is kept and applied (S-5.5)" do
      %{client: client, smscs: [smsc], conns: [conn]} = start_all()
      FakeSmsc.set(smsc, :submit, {:delay, 300})

      fields = %{
        source_addr: "FakeBank",
        destination_addr: @dest,
        short_message: "early",
        registered_delivery: 1
      }

      Client.send_pdu(client, Pdu.new(:submit_sm, fields, sequence: 2))

      # The vendor's receipt overtakes its own submit_sm_resp.
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000
      receipt(conn, "1", "DELIVRD")
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, status: 0}}, 2_000
      {_, resp, dlr} = resp_and_receipt(client)
      assert resp.status == 0
      assert dlr.fields.short_message =~ "stat:DELIVRD"
    end
  end

  describe "what the customer asked for" do
    test "registered_delivery 0: no receipt; 2: failures only" do
      %{client: client, conns: [conn]} = start_all()
      {client, _} = submit(client, %{short_message: "none", registered_delivery: 0}, 2)
      {client, _} = submit(client, %{short_message: "failures", registered_delivery: 2}, 3)
      {client, _} = submit(client, %{short_message: "failures", registered_delivery: 2}, 4)

      receipt(conn, "1", "DELIVRD")
      receipt(conn, "2", "DELIVRD")
      receipt(conn, "3", "UNDELIV", "005")

      {_, dlr} = customer_receipt(client)
      assert dlr.fields.short_message =~ "stat:UNDELIV err:005"
      assert {:error, :timeout} = Client.recv(client, 300)
    end

    test "the customer trunk's DLR status map rewrites the receipt it gets (§6.4)" do
      map = [
        %{
          "fromStatus" => "UNDELIV",
          "fromError" => nil,
          "toStatus" => "EXPIRED",
          "toError" => "011"
        }
      ]

      %{client: client, conns: [conn]} =
        start_all(
          config: [
            translation_rules: [%{id: 7, dlr_status_map: map}],
            translation_targets: [PipelineConfig.target(7, "customer", 1)]
          ]
        )

      {client, _} = submit(client, %{short_message: "map me", registered_delivery: 1})
      receipt(conn, "1", "UNDELIV", "001")
      {_, dlr} = customer_receipt(client)
      assert dlr.fields.short_message =~ "stat:EXPIRED err:011"

      assert_eventually(fn -> Enum.any?(edr("edr.receipt"), &(&1["kind"] == "customer")) end)
      row = Enum.find(edr("edr.receipt"), &(&1["kind"] == "customer"))
      assert row["msg_status"] == "UNDELIV"
      assert row["c_msg_status"] == "EXPIRED"
    end
  end

  describe "vendor failures" do
    test "a vendor refusal moves the message to the next vendor (S-5.4)" do
      %{client: client, smscs: [s1, _s2], conns: [c1, c2]} =
        start_all(
          smscs: 2,
          config: [
            vendor_trunks: [
              PipelineConfig.vendor_trunk(id: 1),
              PipelineConfig.vendor_trunk(id: 2, rate_table_ids: [201])
            ],
            rates: [
              PipelineConfig.rate(100, 1, "26201", "0.05"),
              PipelineConfig.rate(200, 2, "26201", "0.02"),
              PipelineConfig.rate(201, 3, "26201", "0.03")
            ],
            route_vendors: [
              PipelineConfig.route_vendor(1, 1, 1),
              PipelineConfig.route_vendor(1, 2, 2)
            ]
          ]
        )

      FakeSmsc.set(s1, :submit, {:status, 0x45})
      {client, resp} = submit(client, %{short_message: "reroute", registered_delivery: 1})
      assert resp.status == 0
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000

      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      [first, second] = Enum.sort_by(edr("edr.attempt"), & &1["attempt_no"])

      assert %{
               "attempt_no" => 1,
               "is_submit_success" => 0,
               "is_final_attempt" => 0,
               "command_status" => 0x45
             } = first

      assert %{
               "attempt_no" => 2,
               "is_submit_success" => 1,
               "is_final_attempt" => 1,
               "v_trunk_id" => 2
             } = second

      receipt(c2, "1", "DELIVRD")
      {_, dlr} = customer_receipt(client)
      assert dlr.fields.short_message =~ "stat:DELIVRD"
    end

    test "when no vendor takes it, the customer gets a REJECTD receipt from the switch" do
      %{client: client, smscs: [smsc]} = start_all()
      FakeSmsc.set(smsc, :submit, {:status, 0x45})

      fields = %{
        source_addr: "FakeBank",
        destination_addr: @dest,
        short_message: "nobody",
        registered_delivery: 1
      }

      Client.send_pdu(client, Pdu.new(:submit_sm, fields, sequence: 2))
      {_, resp, dlr} = resp_and_receipt(client)
      assert resp.status == 0
      assert dlr.fields.short_message =~ "stat:REJECTD err:045"
      assert {:message_state, 8} in dlr.tlvs

      assert_eventually(fn -> Enum.any?(edr("edr.receipt"), &(&1["source"] == "switch")) end)
      [attempt] = edr("edr.attempt")
      assert attempt["is_final_attempt"] == 1
      assert attempt["c_msg_status"] == "REJECTD"
    end
  end

  describe "overflow buffer (S-2.4)" do
    test "over the trunk's TPS, messages are accepted into the buffer and sent as the TPS allows; past it, 0x58" do
      customer = CustomerCase.trunk(tps: 1, max_connections: 1, overflow_buffer: 2)
      %{client: client, conns: [conn]} = start_all(customer: customer)
      fields = %{source_addr: "FakeBank", destination_addr: @dest, short_message: "burst"}
      # One TPS window, so the four submits meet one count.
      Process.sleep(1_000 - rem(System.os_time(:millisecond), 1_000) + 5)
      for seq <- 2..5, do: Client.send_pdu(client, Pdu.new(:submit_sm, fields, sequence: seq))

      {_, resps} =
        Enum.reduce(1..4, {client, []}, fn _, {client, acc} ->
          assert {client, %Pdu{command: :submit_sm_resp} = resp} = Client.recv(client, 5_000)
          {client, [resp | acc]}
        end)

      statuses = resps |> Enum.map(& &1.status) |> Enum.sort()
      assert statuses == [0, 0, 0, 0x58]

      # The buffered ones reach the vendor one per second.
      for _ <- 1..3, do: assert_receive({:smsc, ^conn, %Pdu{command: :submit_sm}}, 3_000)

      assert_eventually(
        fn -> Enum.count(edr("edr.attempt"), &(&1["is_buffered"] == 1)) == 2 end,
        3_000
      )
    end
  end

  describe "refused at intake" do
    test "a destination without a customer rate is refused 0x0B with an EDR row" do
      %{client: client} = start_all()
      {_, resp} = submit(client, %{destination_addr: "33612345678", short_message: "x"})
      assert resp.status == 0x0B

      assert_eventually(fn ->
        match?([%{"attempt_no" => 0, "c_msg_status" => "REJECTD"}], edr("edr.attempt"))
      end)
    end

    test "no rule routes it: refused 0x45 and nothing goes to a vendor" do
      %{client: client, conns: [conn]} =
        start_all(config: [route_rules: [%{id: 1, status: "inactive"}]])

      {_, resp} = submit(client, %{short_message: "x"})
      assert resp.status == 0x45
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 200
    end
  end

  describe "long messages" do
    test "a long text sent as message_payload goes as UDH parts; one receipt once every part has its own (S-5.9)" do
      %{client: client, conns: [conn]} = start_all()
      text = String.duplicate("a", 200)

      Client.send_pdu(
        client,
        Pdu.new(
          :submit_sm,
          %{
            source_addr: "FakeBank",
            destination_addr: @dest,
            registered_delivery: 1,
            short_message: ""
          },
          tlvs: [message_payload: text],
          sequence: 2
        )
      )

      assert {client, %Pdu{command: :submit_sm_resp, status: 0}} = Client.recv(client, 5_000)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = p1}, 2_000
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = p2}, 2_000
      assert p1.fields.esm_class == 0x40
      assert <<5, 0, 3, ref, 2, 1, _::binary>> = p1.fields.short_message
      assert <<5, 0, 3, ^ref, 2, 2, _::binary>> = p2.fields.short_message

      receipt(conn, "1", "DELIVRD")
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp}}, 2_000
      assert {:error, :timeout} = Client.recv(client, 300)

      receipt(conn, "2", "UNDELIV", "002")
      {_, dlr} = customer_receipt(client)
      assert dlr.fields.short_message =~ "stat:UNDELIV err:002"
    end
  end

  describe "DLR session affinity (§13.1)" do
    test "a receipt with no session to take it is held, and sent when a receiver binds" do
      %{conns: [conn], port: port, client: tx} = start_all(bind: :bind_transmitter)
      {_tx, resp} = submit(tx, %{short_message: "held", registered_delivery: 1})
      id = resp.fields.message_id

      receipt(conn, "1", "DELIVRD")
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, status: 0}}, 2_000
      assert_eventually(fn -> Pipeline.Store.held_trunks() == {:ok, [1]} end)

      {rx, resp} = Client.bind(port, :bind_receiver, %{system_id: "acme", password: "secret"})
      assert resp.status == 0
      {_, dlr} = customer_receipt(rx)
      assert {:receipted_message_id, id} in dlr.tlvs
      assert_eventually(fn -> Pipeline.Store.held_trunks() == {:ok, []} end)

      assert_eventually(fn -> Enum.any?(edr("edr.receipt"), &(&1["kind"] == "customer")) end)
      row = Enum.find(edr("edr.receipt"), &(&1["kind"] == "customer"))
      assert row["receipt_held_ms"] > 0
    end
  end

  # Two vendors on one rule, vendor 1 first; `vendor_trunks` overrides the trunks' fields.
  defp two_vendors(extra \\ []) do
    Keyword.merge(
      [
        vendor_trunks: [
          PipelineConfig.vendor_trunk(id: 1),
          PipelineConfig.vendor_trunk(id: 2, rate_table_ids: [201])
        ],
        rates: [
          PipelineConfig.rate(100, 1, "26201", "0.05"),
          PipelineConfig.rate(200, 2, "26201", "0.02"),
          PipelineConfig.rate(201, 3, "26201", "0.03")
        ],
        route_vendors: [
          PipelineConfig.route_vendor(1, 1, 1),
          PipelineConfig.route_vendor(1, 2, 2)
        ]
      ],
      extra
    )
  end

  # `raw:` in the TLVs is appended as it is: bytes our own encoder refuses to make (a PDU a client may still send).
  defp submit_pdu(client, command, fields, tlvs, seq) do
    fields = Map.merge(%{source_addr: "FakeBank", destination_addr: @dest}, fields)
    {raw, tlvs} = Keyword.pop(tlvs, :raw, <<>>)

    <<length::32, rest::binary>> =
      IO.iodata_to_binary(Pdu.encode!(Pdu.new(command, fields, tlvs: tlvs, sequence: seq)))

    Client.send_raw(client, <<length + byte_size(raw)::32, rest::binary, raw::binary>>)
    assert {client, %Pdu{sequence: ^seq} = resp} = Client.recv(client, 5_000)
    {client, resp}
  end

  # The start of the next second, so a test's submits meet one TPS window.
  defp align_second, do: Process.sleep(1_000 - rem(System.os_time(:millisecond), 1_000) + 5)

  defp attempts, do: Enum.sort_by(edr("edr.attempt"), &{&1["attempt_no"], &1["submit_time"]})

  describe "vendor answers (S-5.1–S-5.4, D2, D4)" do
    test "a temporary refusal (0x58) is tried again on the same vendor, which then takes it (S-5.3)" do
      %{client: client, smscs: [smsc], conns: [conn]} = start_all()
      FakeSmsc.set(smsc, :submit, [{:status, 0x58}, :ok])

      {_, resp} = submit(client, %{short_message: "again"})
      assert resp.status == 0
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 3_000

      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)

      assert [%{"attempt_no" => 1, "is_submit_success" => 1, "v_trunk_id" => 1}] =
               edr("edr.attempt")
    end

    test "a vendor at its TPS limit is waited for up to vendor_wait_ms, then the next vendor takes it (S-5.1)" do
      %{client: client, conns: [c1, c2]} =
        start_all(smscs: 2, config: two_vendors(), vendor_fields: %{1 => [tps: 1]})

      align_second()
      {client, %{status: 0}} = submit(client, %{short_message: "first"}, 2)
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000
      {_, %{status: 0}} = submit(client, %{short_message: "second"}, 3)
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.short_message == "second"
      refute_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 200

      # Waiting is not an attempt: both messages have one row, each sent at its first attempt.
      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      assert Enum.map(attempts(), &{&1["attempt_no"], &1["v_trunk_id"]}) == [{1, 1}, {1, 2}]
    end

    test "a part held back after others went counts as possibly sent: the whole message moves on (D2)" do
      %{client: client, conns: [c1, c2]} =
        start_all(smscs: 2, config: two_vendors(), vendor_fields: %{1 => [tps: 1]})

      align_second()
      {_, %{status: 0}} = submit(client, %{short_message: String.duplicate("b", 200)})

      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm, fields: %{esm_class: 0x40}}}, 2_000
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = p1}, 2_000
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = p2}, 2_000
      assert <<5, 0, 3, _, 2, 1, _::binary>> = p1.fields.short_message
      assert <<5, 0, 3, _, 2, 2, _::binary>> = p2.fields.short_message
      refute_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 200

      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      [first, second] = attempts()

      assert %{"attempt_no" => 1, "v_trunk_id" => 1, "is_submit_success" => 0} = first
      assert first["command_status"] == -1
      assert %{"attempt_no" => 2, "v_trunk_id" => 2, "is_submit_success" => 1} = second
    end

    test "no answer within Submit Timeout: possibly sent, re-routed, the attempt recorded with status -1 (D4)" do
      %{client: client, smscs: [s1, _], conns: [c1, c2]} =
        start_all(smscs: 2, config: two_vendors(), vendor_fields: %{1 => [submit_timeout_s: 1]})

      FakeSmsc.set(s1, :submit, :silent)
      {_, resp} = submit(client, %{short_message: "slow vendor"})
      assert resp.status == 0
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 3_000

      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      [first, second] = attempts()
      assert %{"attempt_no" => 1, "v_trunk_id" => 1, "is_submit_success" => 0} = first
      assert first["command_status"] == -1
      assert %{"attempt_no" => 2, "v_trunk_id" => 2, "is_submit_success" => 1} = second
    end

    test "a routed vendor with no bound connection is skipped for the next (S-5.4)" do
      config =
        two_vendors(
          vendor_trunks: [
            PipelineConfig.vendor_trunk(id: 1),
            PipelineConfig.vendor_trunk(id: 3, rate_table_ids: [203])
          ],
          rates: [
            PipelineConfig.rate(100, 1, "26201", "0.05"),
            PipelineConfig.rate(200, 2, "26201", "0.02"),
            PipelineConfig.rate(203, 4, "26201", "0.01")
          ],
          route_vendors: [
            PipelineConfig.route_vendor(1, 3, 1),
            PipelineConfig.route_vendor(1, 1, 2)
          ]
        )

      %{client: client, conns: [conn]} = start_all(config: config)
      {_, %{status: 0}} = submit(client, %{short_message: "skip 3"})
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000

      # Nothing reached vendor 3, so there is no attempt row for it.
      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)
      assert [%{"attempt_no" => 1, "v_trunk_id" => 1, "is_submit_success" => 1}] = attempts()
    end

    test "a message delivered to the sender again after it was sent is not sent twice (S-7.1)" do
      %{client: client, conns: [conn]} = start_all()
      {_, %{status: 0}} = submit(client, %{short_message: "once"})
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000
      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)

      event = Enum.find(Local.published(), &(&1.subject == "sms.msg.accepted"))
      assert Pipeline.Sender.handle_event(event) == :ok
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 300
      assert length(edr("edr.attempt")) == 1
    end
  end

  describe "translation and routing outcomes (§6.3, §6.4, D3)" do
    test "an ingress translation that adds parts: accepted, never sent, a REJECTD receipt (D3)" do
      %{client: client, conns: [conn]} =
        start_all(
          config: [
            translation_rules: [%{id: 7, msg_template: String.duplicate("x", 200) <> " {text}"}],
            translation_targets: [PipelineConfig.target(7, "customer", 1)]
          ]
        )

      fields = %{
        source_addr: "FakeBank",
        destination_addr: @dest,
        short_message: "grow",
        registered_delivery: 1
      }

      Client.send_pdu(client, Pdu.new(:submit_sm, fields, sequence: 2))
      {_, resp, dlr} = resp_and_receipt(client)
      assert resp.status == 0
      assert dlr.fields.short_message =~ "stat:REJECTD err:001"
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 200

      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)

      assert [%{"attempt_no" => 0, "command_status" => 0x45, "c_msg_status" => "REJECTD"}] =
               edr("edr.attempt")
    end

    test "a vendor whose egress translation adds parts is skipped; the next vendor gets the message as sent" do
      config =
        two_vendors(
          translation_rules: [%{id: 8, msg_template: String.duplicate("y", 200) <> " {text}"}],
          translation_targets: [PipelineConfig.target(8, "vendor", 1)]
        )

      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)
      {_, %{status: 0}} = submit(client, %{short_message: "short"})
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.short_message == "short"
      refute_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 200
    end

    test "a vendor whose egress translation blocks is passed over for the next (§6.4)" do
      config =
        two_vendors(
          translation_rules: [%{id: 9, action: "block"}],
          translation_targets: [PipelineConfig.target(9, "vendor", 1)]
        )

      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)
      {_, %{status: 0}} = submit(client, %{short_message: "not via 1"})
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000
      refute_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 200
    end

    test "egress blocked on the only vendor, or a blocking rule: refused 0x45 (Q15)" do
      %{client: client} =
        start_all(
          config: [
            translation_rules: [%{id: 9, action: "block"}],
            translation_targets: [PipelineConfig.target(9, "vendor", 1)]
          ]
        )

      {_, resp} = submit(client, %{short_message: "nowhere"})
      assert resp.status == 0x45
    end

    test "a block route rule refuses the message 0x45 (§6.3)" do
      %{client: client, conns: [conn]} =
        start_all(config: [route_rules: [%{id: 1, route_type: "block"}]])

      {_, resp} = submit(client, %{short_message: "blocked"})
      assert resp.status == 0x45
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 200
    end

    test "an ingress translation that blocks refuses the message 0x45 (§6.4)" do
      %{client: client, conns: [conn]} =
        start_all(
          config: [
            translation_rules: [%{id: 5, action: "block"}],
            translation_targets: [PipelineConfig.target(5, "customer", 1)]
          ]
        )

      {_, resp} = submit(client, %{short_message: "blocked"})
      assert resp.status == 0x45
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 200
    end
  end

  describe "intake checks (S-2.8, S-2.10, S-3.6, D10)" do
    test "each malformed submit is refused with its status and recorded" do
      %{client: client} = start_all()

      cases = [
        {"empty message (D10)", %{short_message: ""}, [], 0x01},
        {"short_message and message_payload (S-2.8)", %{short_message: "a"},
         [raw: <<0x0424::16, 1::16, "b">>], 0xC4},
        {"invalid UDH (S-3.6)", %{esm_class: 0x40, short_message: <<5, 0, 3, 1>>}, [], 0x01},
        {"incomplete SAR (S-3.6)", %{short_message: "a"}, [sar_msg_ref_num: 1], 0xC3},
        {"receiver not a number (S-2.10)", %{short_message: "a", destination_addr: "12ab"}, [],
         0x0B},
        {"no sender (S-2.10)", %{short_message: "a", source_addr: ""}, [], 0x0A},
        {"alphanumeric sender over 11 (S-2.10)",
         %{short_message: "a", source_addr: "ABCDEFGHIJKL", source_addr_ton: 5}, [], 0x0A},
        {"no customer rate for the destination (S-6.2)",
         %{short_message: "a", destination_addr: "4917012345678"}, [], 0x0B}
      ]

      cases
      |> Enum.with_index(2)
      |> Enum.reduce(client, fn {{name, fields, tlvs, status}, seq}, client ->
        {client, resp} = submit_pdu(client, :submit_sm, fields, tlvs, seq)
        assert {name, resp.status} == {name, status}
        client
      end)

      assert_eventually(fn -> length(edr("edr.attempt")) == length(cases) end)

      assert Enum.all?(
               edr("edr.attempt"),
               &(&1["attempt_no"] == 0 and &1["c_msg_status"] == "REJECTD")
             )
    end

    test "SAR parts share the first part's decision and keep their SAR TLVs to the vendor (S-3.3, S-3.8)" do
      %{client: client, conns: [conn]} = start_all()

      {client, r1} =
        submit_pdu(client, :submit_sm, %{short_message: "part one "}, sar(7, 2, 1), 2)

      {_, r2} = submit_pdu(client, :submit_sm, %{short_message: "part two"}, sar(7, 2, 2), 3)
      assert {r1.status, r2.status} == {0, 0}
      assert r1.fields.message_id != r2.fields.message_id

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = p1}, 2_000
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = p2}, 2_000
      assert {p1.fields.short_message, p2.fields.short_message} == {"part one ", "part two"}
      assert {:sar_segment_seqnum, 1} in p1.tlvs
      assert {:sar_segment_seqnum, 2} in p2.tlvs
      assert {:sar_msg_ref_num, 7} in p2.tlvs

      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      assert Enum.all?(edr("edr.attempt"), &(&1["route_rule_id"] == 1 and &1["v_trunk_id"] == 1))
    end

    test "data_sm is accepted and goes to the vendor as submit_sm" do
      %{client: client, conns: [conn]} = start_all()

      {_, resp} =
        submit_pdu(client, :data_sm, %{source_addr_ton: 5}, [message_payload: "data sm text"], 2)

      assert %Pdu{command: :data_sm_resp, status: 0} = resp
      assert resp.fields.message_id =~ ~r/\A[0-9a-f]{20}\z/
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.short_message == "data sm text"
    end
  end

  defp sar(ref, total, n),
    do: [sar_msg_ref_num: ref, sar_total_segments: total, sar_segment_seqnum: n]

  describe "receipts from vendors (S-5.5–S-5.12, Q7)" do
    test "an MO message, a receipt without an id and one for an unknown message are all answered OK" do
      %{client: client, conns: [conn]} = start_all()

      FakeSmsc.send_pdu(
        conn,
        Pdu.new(:deliver_sm, %{esm_class: 0, short_message: "MO"}, sequence: 901)
      )

      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, sequence: 901, status: 0}},
                     2_000

      FakeSmsc.send_pdu(
        conn,
        Pdu.new(:deliver_sm, %{esm_class: 0x04, short_message: "stat:DELIVRD"}, sequence: 902)
      )

      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, sequence: 902, status: 0}},
                     2_000

      receipt(conn, "no-such-id", "DELIVRD")

      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, sequence: 900, status: 0}},
                     2_000

      assert {:error, :timeout} = Client.recv(client, 300)
      assert edr("edr.receipt") == []
    end

    test "a receipt for a message that is no longer stored is answered OK (S-5.12)" do
      start_all()

      assert Pipeline.Receipts.apply_receipt("00000000000000000000", 1, %{status: "DELIVRD"}) ==
               :ok
    end

    test "intermediate statuses are forwarded when the customer asked for them (registered_delivery 0x11)" do
      %{client: client, conns: [conn]} = start_all()
      {client, _} = submit(client, %{short_message: "steps", registered_delivery: 0x11})
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000

      receipt(conn, "1", "ENROUTE")
      {client, enroute} = customer_receipt(client)
      assert enroute.fields.short_message =~ "stat:ENROUTE"
      assert {:message_state, 1} in enroute.tlvs

      receipt(conn, "1", "DELIVRD")
      {_, final} = customer_receipt(client)
      assert final.fields.short_message =~ "stat:DELIVRD"

      assert_eventually(fn -> Enum.count(edr("edr.receipt"), &(&1["kind"] == "vendor")) == 2 end)
    end
  end

  describe "held receipts (§13.1)" do
    test "a held receipt whose hold hours ran out is given up on the next sweep and recorded unsent" do
      %{conns: [conn], client: tx} = start_all(bind: :bind_transmitter)
      {_tx, _} = submit(tx, %{short_message: "too late", registered_delivery: 1})
      receipt(conn, "1", "DELIVRD")
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, status: 0}}, 2_000
      assert_eventually(fn -> Pipeline.Store.held_trunks() == {:ok, [1]} end)

      # The hold hours run out.
      {:ok, [{member, entry}]} = Pipeline.Store.held(1, 10)
      :ok = Pipeline.Store.release(1, member)
      expired = %{entry | until: System.os_time(:millisecond) - 1}
      :ok = Pipeline.Store.hold(1, expired, entry.held_at)

      send(Pipeline.Held, :sweep)
      assert_eventually(fn -> Pipeline.Store.held_trunks() == {:ok, []} end)
      assert_eventually(fn -> Enum.any?(edr("edr.receipt"), &(&1["kind"] == "customer")) end)
      row = Enum.find(edr("edr.receipt"), &(&1["kind"] == "customer"))
      assert row["receipt_session_id"] == ""
      assert row["c_msg_status"] == "DELIVRD"
      assert row["receipt_held_ms"] >= 0
    end

    test "a bind event without a trunk id is ignored" do
      assert OnBind.handle_event(Event.new("sms.session.customer.bound", "t", %{})) == :ok
    end
  end
end
