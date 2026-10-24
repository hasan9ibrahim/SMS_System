defmodule Sms.Switch.Pipeline.PipelineTest do
  # The whole message path on fake data (build step 4, spec §2, §6, docs/SMPP_SCENARIOS.md): a customer client binds
  # and submits, the switch routes and sends to a fake vendor SMSC, the vendor's receipt comes back to the customer.
  use Sms.Switch.Test.VendorCase, async: false
  @moduletag capture_log: true

  alias Sms.Switch.Pipeline
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

    vendors =
      smscs
      |> Enum.with_index(1)
      |> Enum.map(fn {s, id} -> trunk(FakeSmsc.port(s), id: id, name: "V#{id}") end)

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
end
