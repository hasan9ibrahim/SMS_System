defmodule Sms.Switch.Pipeline.PipelineTest do
  # The whole message path on fake data (build step 4, spec §2, §6, docs/SMPP_SCENARIOS.md): a customer client binds
  # and submits, the switch routes and sends to a fake vendor SMSC, the vendor's receipt comes back to the customer.
  use Sms.Switch.Test.VendorCase, async: false
  @moduletag capture_log: true

  alias Sms.Core.Bus.{Event, Local}
  alias Sms.Switch.Pipeline
  alias Sms.Switch.Pipeline.Held.OnBind
  alias Sms.Switch.Pipeline.Ledger.Sync
  alias Sms.Switch.Test.{Client, CustomerCase, FakeHlr, LedgerSource, PipelineConfig}

  @dest "4915112345678"

  setup do
    start_supervised!(Sms.Core.Bus)
    start_supervised!(Pipeline.Store)
    start_supervised!(Pipeline.Delayed)
    start_supervised!(Pipeline.LiveTps)
    :ok
  end

  # Configuration, both sides and the consumers; returns the bound client, the fake SMSC and its connection.
  defp start_all(opts \\ []) do
    PipelineConfig.put(Keyword.get(opts, :config, []))
    start_supervised!({Pipeline.Config.Server, loader: PipelineConfig})
    CustomerCase.assert_eventually(&Pipeline.Config.ready?/0)
    if Keyword.get(opts, :sender, true), do: start_supervised!(Pipeline.Sender)
    start_supervised!(Pipeline.Forwarder)
    start_supervised!({Pipeline.Held, sweep_ms: 60_000})
    start_supervised!(Pipeline.Held.OnBind)
    start_supervised!({Pipeline.Buffers, discover_ms: 3_600_000})

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
    customers = [customer | Keyword.get(opts, :more_customers, [])]
    %{port: port} = CustomerCase.start_customer(trunks: customers, intake: Pipeline.Intake)
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
      %{client: client, smscs: [smsc], conns: [conn]} = start_all()

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
      # The vendor connection's address; route rule groups are gone (R4); not a DLR re-route.
      assert {attempt["v_ip"], attempt["v_port"]} == {"127.0.0.1", FakeSmsc.port(smsc)}
      assert {attempt["route_rule_group_id"], attempt["dlr_reroute"]} == {0, 0}
      # §7: both sides bill on submit here, so the money is on the attempt row.
      assert attempt["is_customer_billable"] == 1
      assert attempt["is_vendor_billable"] == 1
      assert attempt["revenue"] == "0.05"
      assert attempt["cost"] == "0.02"
      assert attempt["revenue_sys"] == "0.05"

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

      assert_eventually(fn -> length(edr("edr.receipt")) == 3 end)
      rows = Map.new(edr("edr.receipt"), &{&1["kind"], &1})
      %{"vendor" => vendor_row, "customer" => customer_row, "outcome" => outcome} = rows

      # The attempt's outcome: its final status for the reports, no money (billed at submit).
      assert %{"msg_status" => "DELIVRD", "c_msg_status" => "DELIVRD", "route_rule_id" => 1} =
               outcome

      assert %{"is_customer_billable" => 0, "is_vendor_billable" => 0, "revenue" => "0"} = outcome

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

    test "a sender with its own rate lines is billed at them; another sender at the generic rates (§6.2)" do
      rates = [
        PipelineConfig.rate(100, 1, "26201", "0.05"),
        PipelineConfig.rate(200, 2, "26201", "0.02"),
        PipelineConfig.rate(100, 11, "26201", "0.07", "EUR", "FakeBank"),
        PipelineConfig.rate(200, 12, "26201", "0.03", "EUR", "FakeBank")
      ]

      %{client: client, conns: [conn]} = start_all(config: [rates: rates])

      {client, resp} = submit(client, %{short_message: "Your code is 1234"})
      assert resp.status == 0
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000
      {_client, resp} = submit(client, %{source_addr: "OtherShop", short_message: "Sale"}, 3)
      assert resp.status == 0
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000

      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      by_sender = Map.new(edr("edr.attempt"), &{&1["src_addr"], &1})

      assert %{"c_rate" => "0.07", "v_rate" => "0.03", "revenue" => "0.07"} =
               by_sender["FakeBank"]

      assert %{"c_rate" => "0.05", "v_rate" => "0.02", "revenue" => "0.05"} =
               by_sender["OtherShop"]
    end

    test "a vendor's Sender ID rates match the sender it receives after its egress translation (§6.2)" do
      config = [
        rates: [
          PipelineConfig.rate(100, 1, "26201", "0.05"),
          PipelineConfig.rate(200, 2, "26201", "0.02"),
          PipelineConfig.rate(100, 11, "26201", "0.07", "EUR", "FakeBank"),
          PipelineConfig.rate(200, 12, "26201", "0.03", "EUR", "FakeBank")
        ],
        # The vendor trunk's egress rule turns "Fake" into "FakeBank" (decided 2026-10-30).
        translation_rules: [
          %{id: 21, sender_conversion: "append", sender_conversion_value: "Bank"}
        ],
        translation_targets: [PipelineConfig.target(21, "vendor", 1)]
      ]

      %{client: client, conns: [conn]} = start_all(config: config)
      {_client, resp} = submit(client, %{source_addr: "Fake", short_message: "Your code is 1234"})
      assert resp.status == 0
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.source_addr == "FakeBank"

      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)

      # The customer pays for the sender it sent; the vendor charges for the one it got.
      assert [
               %{
                 "src_addr" => "Fake",
                 "v_src_addr" => "FakeBank",
                 "c_rate" => "0.05",
                 "v_rate" => "0.03"
               }
             ] =
               edr("edr.attempt")
    end

    test "a finished message is forgotten; a receipt repeated after is answered OK and not forwarded (S-5.8)" do
      %{client: client, conns: [conn]} = start_all()
      {client, resp} = submit(client, %{short_message: "hello", registered_delivery: 1})
      id = resp.fields.message_id
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000

      receipt(conn, "1", "DELIVRD")
      {client, _} = customer_receipt(client)
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, status: 0}}, 2_000
      assert_eventually(fn -> Pipeline.Store.message(id) == :none end)
      assert Pipeline.Store.find_vendor_id(1, ["1"]) == :none

      receipt(conn, "1", "UNDELIV")
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, status: 0}}, 2_000
      assert {:error, :timeout} = Client.recv(client, 500)
    end

    test "a server stopped between claiming a receipt and queuing it: the vendor's repeat forwards it (step 7)" do
      %{client: client, conns: [conn]} = start_all()
      {client, resp} = submit(client, %{short_message: "claimed", registered_delivery: 1})
      id = resp.fields.message_id
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000

      # The other server took the claim and died before queuing the receipt.
      assert {:ok, true} = Pipeline.Store.claim_forward(id)
      receipt(conn, "1", "DELIVRD")
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp, status: 0}}, 2_000
      assert {:error, :timeout} = Client.recv(client, 300)

      receipt(conn, "1", "DELIVRD")
      {_client, dlr} = customer_receipt(client)
      assert dlr.fields.short_message =~ "id:#{id} "
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

  describe "HLR / MNP before the resp (§13.24, S-6.5)" do
    # Germany has a second network, 26202, with its own rates; the HLR rule looks up every 4915 number.
    defp hlr_config(extra) do
      {rule, target} = PipelineConfig.hlr_rule(1, 1, "^4915")

      Keyword.merge(
        [
          destinations: [
            ["4915", 1, "26201", "262", "01", "Fake Mobile", false, "DE", "Germany"],
            ["4917", 3, "26202", "262", "02", "Other Mobile", false, "DE", "Germany"],
            ["49", 2, "262", "262", "", nil, true, "DE", "Germany"]
          ],
          rates: [
            PipelineConfig.rate(100, 1, "26201", "0.05"),
            PipelineConfig.rate(100, 3, "26202", "0.07"),
            PipelineConfig.rate(200, 2, "26201", "0.02"),
            PipelineConfig.rate(200, 4, "26202", "0.03")
          ],
          hlr_providers: [
            PipelineConfig.hlr_provider(id: 1),
            PipelineConfig.hlr_provider(id: 2, name: "Second")
          ],
          hlr_rules: [rule],
          hlr_targets: [target]
        ],
        extra
      )
    end

    defp policy_rule(cache_hours) do
      [
        hlr_rules: [],
        hlr_targets: [],
        route_rules: [%{id: 1, hlr_action: %{"policy_id" => 1, "customer_trunk_ids" => []}}],
        hlr_policies: [
          %{
            id: 1,
            entries: [
              %{
                "code" => nil,
                "mode" => "ordered",
                "providerIds" => [1, 2],
                "cacheHoursPorted" => nil,
                "cacheHoursNotPorted" => cache_hours
              }
            ]
          }
        ]
      ]
    end

    test "a ported number is rated and routed by the network the lookup names; the EDR records the lookup" do
      FakeHlr.script(%{1 => FakeHlr.found("26202", true)})
      # Only ported numbers match the rule (HLR Ported condition).
      %{client: client, conns: [conn]} =
        start_all(config: hlr_config(route_rules: [%{id: 1, hlr_ported: true}]))

      {_, resp} = submit(client, %{short_message: "ported"})
      assert resp.status == 0
      assert_receive {:hlr_request, 1, @dest}
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000

      assert_eventually(fn -> match?([_], edr("edr.attempt")) end)
      [row] = edr("edr.attempt")
      assert %{"c_mccmnc" => "26202", "c_rate" => "0.07", "v_rate" => "0.03"} = row

      assert %{
               "hlr_provider_id" => 1,
               "hlr_fetch_type" => "live",
               "hlr_is_ported" => 1,
               "hlr_is_accomplished" => 1,
               "hlr_cost_sys" => "0.001"
             } = row
    end

    test "no answer within the provider's timeout: the master table at once, no other provider asked" do
      FakeHlr.script(%{1 => {:error, :timeout}, 2 => FakeHlr.found("26202")})
      %{client: client, conns: [conn]} = start_all(config: hlr_config(policy_rule(1)))

      {_, %{status: 0}} = submit(client, %{short_message: "slow hlr"})
      assert_receive {:hlr_request, 1, _}
      refute_received {:hlr_request, 2, _}
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000

      assert_eventually(fn -> match?([_], edr("edr.attempt")) end)

      assert [%{"c_mccmnc" => "26201", "hlr_is_accomplished" => 0, "hlr_error_code" => 408}] =
               edr("edr.attempt")
    end

    test "a provider error falls back to the policy's next provider; the answer is cached and free after" do
      FakeHlr.script(%{1 => {:error, :boom}, 2 => FakeHlr.found("26202")})
      %{client: client} = start_all(config: hlr_config(policy_rule(1)))

      {client, %{status: 0}} = submit(client, %{short_message: "first"}, 2)
      assert_receive {:hlr_request, 1, _}
      assert_receive {:hlr_request, 2, _}
      {_, %{status: 0}} = submit(client, %{short_message: "second"}, 3)
      refute_receive {:hlr_request, _, _}, 200

      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      [first, second] = edr("edr.attempt")
      assert %{"c_mccmnc" => "26202", "hlr_provider_id" => 2, "hlr_fetch_type" => "live"} = first

      assert %{"c_mccmnc" => "26202", "hlr_fetch_type" => "cached", "hlr_cost_sys" => "0"} =
               second
    end

    test "traffic without HLR is not looked up; a number no rule pattern matches neither" do
      FakeHlr.script(%{1 => FakeHlr.found("26202")})
      %{client: client} = start_all(config: hlr_config(hlr_rules: [], hlr_targets: []))
      {client, %{status: 0}} = submit(client, %{short_message: "no hlr"}, 2)
      {_, %{status: 0}} = submit(client, %{destination_addr: "4917123456", short_message: "x"}, 3)
      refute_receive {:hlr_request, _, _}, 200
      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      assert Enum.all?(edr("edr.attempt"), &(&1["hlr_fetch_type"] == "none"))
    end
  end

  describe "overflow buffer (S-2.4)" do
    test "a trunk's buffer drains at its own TPS and never holds another trunk's messages back (step 7b)" do
      trunks = [
        PipelineConfig.customer_trunk(),
        PipelineConfig.customer_trunk(id: 2)
      ]

      %{client: client, port: port, conns: [conn]} =
        start_all(
          config: [customer_trunks: trunks],
          customer: CustomerCase.trunk(tps: 1, max_connections: 1, overflow_buffer: 20),
          more_customers: [CustomerCase.trunk(id: 2, username: "other", name: "OTHER")]
        )

      fields = %{source_addr: "FakeBank", destination_addr: @dest}
      Process.sleep(1_000 - rem(System.os_time(:millisecond), 1_000) + 5)

      for seq <- 2..7,
          do:
            Client.send_pdu(
              client,
              Pdu.new(:submit_sm, Map.put(fields, :short_message, "burst #{seq}"), sequence: seq)
            )

      {_, resps} =
        Enum.reduce(1..6, {client, []}, fn _, {client, acc} ->
          assert {client, %Pdu{command: :submit_sm_resp} = resp} = Client.recv(client, 5_000)
          {client, [resp.status | acc]}
        end)

      assert resps == [0, 0, 0, 0, 0, 0]

      # The other trunk's message goes at once, ahead of the five still in trunk 1's buffer.
      {other, _} = Client.bind(port, :bind_transceiver, %{system_id: "other", password: "secret"})
      {_, %{status: 0}} = submit(other, %{short_message: "not held back"})

      texts =
        for _ <- 1..3 do
          assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
          sent.fields.short_message
        end

      assert "not held back" in texts

      # Trunk 1's buffered ones follow, one a second (the session takes a burst's submits concurrently, so they enter
      # the buffer in any order).
      rest =
        for _ <- 1..4 do
          assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_500
          sent.fields.short_message
        end

      burst = Enum.filter(texts ++ rest, &String.starts_with?(&1, "burst"))
      assert Enum.sort(burst) == Enum.map(2..7, &"burst #{&1}")
    end

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

    test "a blocked customer line refuses the message 0x0B, though the country has a rate (decided 2026-10-30)" do
      rates = [
        PipelineConfig.blocked(100, 1, "26201"),
        PipelineConfig.rate(100, 5, "262", "0.04"),
        PipelineConfig.rate(200, 2, "26201", "0.02")
      ]

      %{client: client, conns: [conn]} = start_all(config: [rates: rates])
      {_, resp} = submit(client, %{short_message: "x"})
      assert resp.status == 0x0B
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 200
    end

    test "no rule routes it: refused 0x45 and nothing goes to a vendor" do
      %{client: client, conns: [conn]} =
        start_all(config: [route_rules: [%{id: 1, status: "inactive"}]])

      {_, resp} = submit(client, %{short_message: "x"})
      assert resp.status == 0x45
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 200
    end
  end

  describe "TPS conditions (§13.8)" do
    test "measured on the rule: every message its other conditions let through counts, whichever rule routes it" do
      over = %{"op" => ">", "value" => 50, "scope" => "rule"}

      %{client: client} =
        start_all(
          config: [
            route_rules: [
              %{id: 1, priority: 200, tps_condition: over},
              %{id: 2, priority: 100},
              # Its other conditions do not let the message through: not counted.
              %{id: 3, priority: 300, tps_condition: over, sender_pattern: "^NOPE$"}
            ],
            route_vendors: for(r <- 1..3, do: PipelineConfig.route_vendor(r, 1))
          ]
        )

      {_, resp} = submit(client, %{short_message: "x"})
      assert resp.status == 0
      counts = :ets.tab2list(:sms_live_tps_local)
      assert Enum.any?(counts, &match?({{"r:1", _}, 1}, &1))
      refute Enum.any?(counts, &match?({{"r:2", _}, _}, &1))
      refute Enum.any?(counts, &match?({{"r:3", _}, _}, &1))
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

      # While the message waits for its other part, a repeated final is recorded as a duplicate (S-5.8).
      receipt(conn, "1", "UNDELIV")
      assert_receive {:smsc, ^conn, %Pdu{command: :deliver_sm_resp}}, 2_000
      assert_eventually(fn -> Enum.any?(edr("edr.receipt"), &(&1["is_duplicate"] == 1)) end)

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

    test "a refused part waits for its retry in the vendor's queue, never in a sender worker (D2)" do
      %{client: client, smscs: [smsc], conns: [conn]} = start_all()
      # Part 2 refused for now (0x14), then taken: the same reference, one attempt.
      FakeSmsc.set(smsc, :submit, [:ok, {:status, 0x14}, :ok])
      {_, %{status: 0}} = submit(client, %{short_message: String.duplicate("q", 200)})

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = p1}, 2_000
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = p2}, 2_000
      refused_at = System.monotonic_time(:millisecond)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = again}, 3_000
      assert System.monotonic_time(:millisecond) - refused_at >= 400
      assert again.fields.short_message == p2.fields.short_message
      assert <<5, 0, 3, ref, 2, 1, _::binary>> = p1.fields.short_message
      assert <<5, 0, 3, ^ref, 2, 2, _::binary>> = again.fields.short_message

      # The worker handed it to the vendor's queue for the pause.
      assert Enum.any?(Local.published(), &(&1.type == "msg.vendor_buffered"))
      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)

      assert [%{"is_submit_success" => 1, "msg_count" => 2} = row] = edr("edr.attempt")
      assert [_, _] = String.split(row["v_message_id"], ",")
    end

    test "a later part refused for good: all parts via the next vendor; the accepted one stays the first attempt's (D2)" do
      %{client: client, smscs: [s1, _], conns: [c1, c2]} =
        start_all(smscs: 2, config: two_vendors())

      FakeSmsc.set(s1, :submit, [:ok, {:status, 0x45}])
      {_, %{status: 0}} = submit(client, %{short_message: String.duplicate("r", 200)})

      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm} = a1}, 2_000
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = b1}, 2_000
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000
      assert <<5, 0, 3, ref_a, 2, 1, _::binary>> = a1.fields.short_message
      assert <<5, 0, 3, ref_b, 2, 1, _::binary>> = b1.fields.short_message
      assert ref_a != ref_b

      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      [first, second] = attempts()

      # Vendor 1 bills on submit: its accepted part is its cost (0.02 × 1), with its id.
      assert %{"attempt_no" => 1, "is_submit_success" => 0, "command_status" => 0x45} = first
      assert %{"v_message_id" => "1", "msg_count" => 1, "is_vendor_billable" => 1} = first
      assert first["cost"] == "0.02"
      assert %{"attempt_no" => 2, "is_submit_success" => 1, "msg_count" => 2} = second
      assert second["is_customer_billable"] == 1
    end

    test "a vendor at its TPS limit without an overflow buffer is skipped at once for the next (S-5.1)" do
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

    test "a vendor at its TPS limit with a buffer keeps the message and sends it when it has room (S-5.1)" do
      config =
        two_vendors(
          vendor_trunks: [
            PipelineConfig.vendor_trunk(id: 1, overflow_buffer: 10),
            PipelineConfig.vendor_trunk(id: 2, rate_table_ids: [201])
          ]
        )

      %{client: client, conns: [c1, c2]} =
        start_all(smscs: 2, config: config, vendor_fields: %{1 => [tps: 1]})

      align_second()
      {client, %{status: 0}} = submit(client, %{short_message: "first"}, 2)
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000
      {_, %{status: 0}} = submit(client, %{short_message: "second"}, 3)
      # The next second, on the same vendor; nothing goes to the next one.
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.short_message == "second"
      refute_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 200

      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      assert Enum.map(attempts(), &{&1["attempt_no"], &1["v_trunk_id"]}) == [{1, 1}, {1, 1}]
    end

    test "a full vendor buffer, or one waited in past its time, sends the message to the next vendor (S-5.1)" do
      previous = Application.get_env(:sms_switch, Pipeline)

      Application.put_env(
        :sms_switch,
        Pipeline,
        Keyword.put(previous, :vendor_buffer_wait_ms, 300)
      )

      on_exit(fn -> Application.put_env(:sms_switch, Pipeline, previous) end)

      config =
        two_vendors(
          vendor_trunks: [
            PipelineConfig.vendor_trunk(id: 1, overflow_buffer: 1),
            PipelineConfig.vendor_trunk(id: 2, rate_table_ids: [201])
          ]
        )

      %{client: client, conns: [c1, c2]} =
        start_all(smscs: 2, config: config, vendor_fields: %{1 => [tps: 1]})

      align_second()
      {client, %{status: 0}} = submit(client, %{short_message: "first"}, 2)
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000
      {client, %{status: 0}} = submit(client, %{short_message: "buffered"}, 3)
      # The buffer holds one: the third goes to the next vendor at once.
      {_, %{status: 0}} = submit(client, %{short_message: "buffer full"}, 4)
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = full}, 1_000
      assert full.fields.short_message == "buffer full"

      # The buffered one waited 300 ms for vendor 1 (its next place is a second away): the next vendor.
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = waited}, 2_000
      assert waited.fields.short_message == "buffered"
      refute_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 200
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

    test "a validity period that ends before the next vendor is tried: not sent, an EXPIRED receipt (S-2.13)" do
      %{client: client, smscs: [s1, _], conns: [c1, c2]} =
        start_all(smscs: 2, config: two_vendors(), vendor_fields: %{1 => [submit_timeout_s: 1]})

      FakeSmsc.set(s1, :submit, :silent)

      # Valid for 1 s: vendor 1 does not answer within its 1 s Submit Timeout.
      fields = %{
        source_addr: "FakeBank",
        destination_addr: @dest,
        short_message: "short-lived",
        registered_delivery: 1,
        validity_period: "000000000001000R"
      }

      Client.send_pdu(client, Pdu.new(:submit_sm, fields, sequence: 2))
      {_, resp, dlr} = resp_and_receipt(client)
      assert resp.status == 0
      assert dlr.fields.short_message =~ "stat:EXPIRED"

      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm} = sent}, 2_000
      # The vendor gets the validity as an absolute time in UTC, so it does not start again there.
      assert sent.fields.validity_period =~ ~r/\A\d{12}000\+\z/
      refute_received {:smsc, ^c2, %Pdu{command: :submit_sm}}

      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      [first, last] = attempts()

      assert %{"attempt_no" => 0, "c_msg_status" => "EXPIRED", "is_customer_billable" => 0} =
               first

      assert %{"attempt_no" => 1, "command_status" => -1, "is_final_attempt" => 0} = last
    end

    test "a relative validity goes to the vendor as the same moment, absolute in UTC (S-2.13)" do
      %{client: client, conns: [conn]} = start_all()
      before = System.os_time(:second)

      {_, %{status: 0}} =
        submit(client, %{short_message: "valid 5 min", validity_period: "000000000500000R"})

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      {:ok, at} = Sms.Switch.Smpp.Time.parse(sent.fields.validity_period, 0)
      assert_in_delta div(at, 1_000), before + 300, 3
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

    test "no routed vendor connected on either server: refused at once with 0x45, nothing sent (Q15)" do
      config =
        two_vendors(
          vendor_trunks: [
            PipelineConfig.vendor_trunk(id: 1),
            PipelineConfig.vendor_trunk(id: 3, rate_table_ids: [203])
          ],
          rates: [
            PipelineConfig.rate(100, 1, "26201", "0.05"),
            PipelineConfig.rate(203, 4, "26201", "0.01")
          ],
          route_vendors: [PipelineConfig.route_vendor(1, 3, 1)]
        )

      %{client: client, conns: [conn]} = start_all(config: config)
      {_, resp} = submit(client, %{short_message: "nobody bound"})
      assert resp.status == 0x45
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 300

      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)
      assert [%{"attempt_no" => 0, "c_msg_status" => "REJECTD"}] = attempts()
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

    test "a vendor whose rate line for the destination is blocked is passed over for the next (decided 2026-10-30)" do
      config =
        two_vendors(
          rates: [
            PipelineConfig.rate(100, 1, "26201", "0.05"),
            # Vendor 1: the network blocked; its country line must not stand in for it.
            PipelineConfig.blocked(200, 2, "26201"),
            PipelineConfig.rate(200, 6, "262", "0.01"),
            PipelineConfig.rate(201, 3, "26201", "0.03")
          ]
        )

      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)
      {_, %{status: 0}} = submit(client, %{short_message: "not via 1"})
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000
      refute_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 200
      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)
      assert [%{"v_trunk_id" => 2, "v_rate" => "0.03"}] = edr("edr.attempt")
    end

    test "a vendor whose Sender ID line is blocked for the sender it would get is passed over (decided 2026-10-30)" do
      config =
        two_vendors(
          rates: [
            PipelineConfig.rate(100, 1, "26201", "0.05"),
            PipelineConfig.rate(200, 2, "26201", "0.02"),
            PipelineConfig.blocked(200, 7, "26201", "FakeBank"),
            PipelineConfig.rate(201, 3, "26201", "0.03")
          ]
        )

      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)
      {_, %{status: 0}} = submit(client, %{source_addr: "FakeBank", short_message: "code"})
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000
      refute_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 200
      # Another sender still goes to vendor 1.
      {_, %{status: 0}} = submit(client, %{source_addr: "OtherShop", short_message: "sale"}, 3)
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000
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

    test "an ingress translation leaving the sender unfit to send: refused 0x0A, nothing sent (S-4.7)" do
      config = [
        translation_rules: [
          %{id: 22, sender_conversion: "append", sender_conversion_value: "Promotions"}
        ],
        translation_targets: [PipelineConfig.target(22, "customer", 1)]
      ]

      %{client: client, conns: [conn]} = start_all(config: config)
      {_, resp} = submit(client, %{short_message: "too long a sender"})
      assert resp.status == 0x0A
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 300
      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)
      assert [%{"attempt_no" => 0, "command_status" => 0x0A}] = edr("edr.attempt")
    end

    test "a vendor whose egress translation leaves the sender unfit to send is passed over (S-4.7)" do
      config =
        two_vendors(
          translation_rules: [
            %{id: 23, sender_conversion: "append", sender_conversion_value: "Promotions"}
          ],
          translation_targets: [PipelineConfig.target(23, "vendor", 1)]
        )

      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)
      {_, %{status: 0}} = submit(client, %{short_message: "not via 1"})
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.source_addr == "FakeBank"
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
        {"alphanumeric sender over 11 whatever its TON (S-2.10)",
         %{short_message: "a", source_addr: "FakeBank Info", source_addr_ton: 0}, [], 0x0A},
        {"no customer rate for the destination (S-6.2)",
         %{short_message: "a", destination_addr: "4917012345678"}, [], 0x0B},
        # SMPP 3.4 §5.2.5–§5.2.17: values no vendor would take.
        {"source TON outside SMPP", %{short_message: "a", source_addr_ton: 7}, [], 0x48},
        {"source NPI outside SMPP", %{short_message: "a", source_addr_npi: 2}, [], 0x49},
        {"destination TON outside SMPP", %{short_message: "a", dest_addr_ton: 9}, [], 0x50},
        {"destination NPI outside SMPP", %{short_message: "a", dest_addr_npi: 5}, [], 0x51},
        {"priority_flag over 3", %{short_message: "a", priority_flag: 4}, [], 0x06},
        {"registered_delivery reserved bits", %{short_message: "a", registered_delivery: 0x21},
         [], 0x07},
        {"registered_delivery reserved receipt value 3",
         %{short_message: "a", registered_delivery: 3}, [], 0x07},
        {"esm_class message type a submit cannot have (SMSC receipt)",
         %{short_message: "a", esm_class: 0x04}, [], 0x43},
        # S-2.12, S-2.13.
        {"schedule_delivery_time that is no date (month 13)",
         %{short_message: "a", schedule_delivery_time: "261331120000000+"}, [], 0x61},
        {"validity_period that does not read",
         %{short_message: "a", validity_period: "261399120000000+"}, [], 0x62},
        {"validity ending before the scheduled time",
         %{
           short_message: "a",
           schedule_delivery_time: "000000010000000R",
           validity_period: "000000003000000R"
         }, [], 0x62}
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

    test "a data_sm numeric sender over 20 digits is refused 0x0A, not sent to fail at every vendor (S-2.10)" do
      %{client: client, conns: [conn]} = start_all()

      {_, resp} =
        submit_pdu(
          client,
          :data_sm,
          %{source_addr: String.duplicate("4", 25), source_addr_ton: 1},
          [message_payload: "hi"],
          2
        )

      assert resp.status == 0x0A
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 300
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

  defp udh(ref, total, n), do: <<5, 0, 3, ref, total, n>>

  defp udh_part(client, ref, total, n, text, seq) do
    submit_pdu(
      client,
      :submit_sm,
      %{esm_class: 0x40, short_message: udh(ref, total, n) <> text, registered_delivery: 1},
      [],
      seq
    )
  end

  describe "customer multipart messages (S-3.2–S-3.7, S-4.3, D1)" do
    test "parts are answered at once, held until all came, and go to the vendor as one message" do
      %{client: client, conns: [conn]} = start_all()
      one = String.duplicate("a", 150)
      two = String.duplicate("b", 20)

      # Out of order, and over two submits each answered with its own id.
      {client, r2} = udh_part(client, 9, 2, 2, two, 2)
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 200
      {client, r1} = udh_part(client, 9, 2, 1, one, 3)
      assert {r1.status, r2.status} == {0, 0}
      assert r1.fields.message_id != r2.fields.message_id

      # Re-split for the vendor: 153 + 17 characters with a new reference.
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = p1}, 2_000
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = p2}, 2_000
      assert <<5, 0, 3, ref, 2, 1, body1::binary>> = p1.fields.short_message
      assert <<5, 0, 3, ^ref, 2, 2, body2::binary>> = p2.fields.short_message
      assert body1 <> body2 == one <> two

      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)
      [attempt] = edr("edr.attempt")
      assert attempt["c_message_ids"] == [r1.fields.message_id, r2.fields.message_id]
      assert attempt["msg_count"] == 2

      # One receipt per customer message id (S-4.2).
      receipt(conn, "1", "DELIVRD")
      receipt(conn, "2", "DELIVRD")
      {client, d1} = customer_receipt(client)
      {_, d2} = customer_receipt(client)

      ids = for d <- [d1, d2], {:receipted_message_id, id} <- d.tlvs, do: id
      assert Enum.sort(ids) == Enum.sort([r1.fields.message_id, r2.fields.message_id])
    end

    test "translation runs once on the whole text, across the parts' boundary (S-4.3)" do
      rule = %{id: 5, content_regex: "ab", content_replacement: "XY"}

      %{client: client, conns: [conn]} =
        start_all(
          config: [
            translation_rules: [rule],
            translation_targets: [PipelineConfig.target(5, "customer", 1)]
          ]
        )

      {client, _} = udh_part(client, 3, 2, 1, "hello a", 2)
      {_, _} = udh_part(client, 3, 2, 2, "b world", 3)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.short_message == "hello XY world"
    end

    test "the same part again gets its first message id and is held once (S-3.5)" do
      %{client: client, conns: [conn]} = start_all()
      {client, first} = udh_part(client, 4, 2, 1, "one ", 2)
      {client, again} = udh_part(client, 4, 2, 1, "one ", 3)
      assert again.fields.message_id == first.fields.message_id
      {_, _} = udh_part(client, 4, 2, 2, "two", 4)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.short_message == "one two"
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 300
    end

    test "SAR parts are put together like UDH parts" do
      %{client: client, conns: [conn]} = start_all()
      {client, _} = submit_pdu(client, :submit_sm, %{short_message: "part one "}, sar(7, 2, 1), 2)
      {_, _} = submit_pdu(client, :submit_sm, %{short_message: "part two"}, sar(7, 2, 2), 3)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.short_message == "part one part two"
      assert sent.tlvs == []
    end

    test "a group still incomplete after the trunk's timeout: REJECTD receipts, nothing sent (D1)" do
      customer = PipelineConfig.customer_trunk(reassembly_timeout_s: 1)
      %{client: client, conns: [conn]} = start_all(config: [customer_trunks: [customer]])
      start_supervised!({Pipeline.Timeouts, sweep_ms: 100})

      {client, r1} = udh_part(client, 5, 3, 1, "one", 2)
      {client, r2} = udh_part(client, 5, 3, 2, "two", 3)
      {client, d1} = customer_receipt(client, 4_000)
      {_, d2} = customer_receipt(client, 4_000)

      for d <- [d1, d2], do: assert(d.fields.short_message =~ "stat:REJECTD err:099")
      ids = for d <- [d1, d2], {:receipted_message_id, id} <- d.tlvs, do: id
      assert Enum.sort(ids) == Enum.sort([r1.fields.message_id, r2.fields.message_id])
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 100

      assert_eventually(fn ->
        Enum.count(edr("edr.attempt"), &(&1["c_msg_status"] == "REJECTD")) == 2
      end)
    end

    test "a message refused once put together: its parts get REJECTD receipts" do
      %{client: client} = start_all(config: [route_rules: [%{id: 1, status: "inactive"}]])
      {client, r1} = udh_part(client, 6, 2, 1, "one", 2)

      fields = %{
        source_addr: "FakeBank",
        destination_addr: @dest,
        esm_class: 0x40,
        registered_delivery: 1
      }

      Client.send_pdu(
        client,
        Pdu.new(:submit_sm, Map.put(fields, :short_message, udh(6, 2, 2) <> "two"), sequence: 3)
      )

      # The last part's resp and the two receipts, in any order (the in-memory bus runs consumers in the intake).
      pdus = collect(client, 3)
      [resp] = for p <- pdus, p.command == :submit_sm_resp, do: p
      receipts = for p <- pdus, p.command == :deliver_sm, do: p
      assert resp.status == 0
      assert length(receipts) == 2
      assert Enum.all?(receipts, &(&1.fields.short_message =~ "stat:REJECTD err:045"))
      ids = for d <- receipts, {:receipted_message_id, id} <- d.tlvs, do: id
      assert Enum.sort(ids) == Enum.sort([r1.fields.message_id, resp.fields.message_id])
    end
  end

  # The next `n` PDUs, receipts answered.
  defp collect(client, n) do
    {_, pdus} =
      Enum.reduce(1..n, {client, []}, fn _, {client, acc} ->
        assert {client, pdu} = Client.recv(client, 5_000)

        if pdu.command == :deliver_sm,
          do: Client.send_pdu(client, Pdu.response(pdu, :esme_rok, %{message_id: ""}))

        {client, [pdu | acc]}
      end)

    Enum.reverse(pdus)
  end

  describe "vendor multipart formats and limits (S-3.9, S-3.10)" do
    @long String.duplicate("x", 200)

    # The first PDU the vendor gets for a 200-character message, with the vendor trunk's multipart format.
    defp long_to_vendor(format) do
      config = [vendor_trunks: [PipelineConfig.vendor_trunk(multipart_format: format)]]
      %{client: client, conns: [conn]} = start_all(config: config)
      fields = %{source_addr: "FakeBank", destination_addr: @dest}

      Client.send_pdu(
        client,
        Pdu.new(:submit_sm, fields, tlvs: [message_payload: @long], sequence: 2)
      )

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = first}, 2_000
      first
    end

    test "UDH with a 16-bit reference: 152 characters a part" do
      first = long_to_vendor("udh16")
      assert <<6, 8, 4, _ref::16, 2, 1, body::binary>> = first.fields.short_message
      assert byte_size(body) == 152
    end

    test "SAR: the parts in TLVs, 153 characters a part (the vendor's SMSC adds the header on air)" do
      first = long_to_vendor("sar")
      assert first.fields.esm_class == 0
      assert byte_size(first.fields.short_message) == 153
      assert {:sar_total_segments, 2} in first.tlvs and {:sar_segment_seqnum, 1} in first.tlvs
    end

    test "message_payload: the whole message in one PDU, billed per part (S-3.1)" do
      first = long_to_vendor("payload")
      assert first.fields.short_message == ""
      assert {:message_payload, @long} in first.tlvs

      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)
      assert [%{"msg_count" => 2, "cost" => "0.04", "revenue" => "0.1"}] = edr("edr.attempt")
    end

    test "references count up per handset: two messages open together never share one (S-3.10)" do
      %{client: client, conns: [conn]} = start_all()
      {client, %{status: 0}} = submit(client, %{short_message: String.duplicate("s", 200)}, 2)
      {_, %{status: 0}} = submit(client, %{short_message: String.duplicate("t", 200)}, 3)

      refs =
        for _ <- 1..4 do
          assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = p}, 2_000
          <<5, 0, 3, ref, 2, _n, _::binary>> = p.fields.short_message
          ref
        end

      [a, b] = Enum.uniq(refs)
      assert b == rem(a + 1, 256)
    end

    test "a vendor without multipart, or with a shorter maximum, is skipped for the next one" do
      %{client: client, conns: [c1, c2]} =
        start_all(
          smscs: 2,
          config: [
            vendor_trunks: [
              PipelineConfig.vendor_trunk(id: 1, support_multipart: false),
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

      Client.send_pdu(
        client,
        Pdu.new(:submit_sm, %{source_addr: "FakeBank", destination_addr: @dest},
          tlvs: [message_payload: @long],
          sequence: 2
        )
      )

      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000
      refute_received {:smsc, ^c1, %Pdu{command: :submit_sm}}
    end
  end

  describe "vendor capability filter (§5.5, S-2.11, S-4.4) and Deny Multipart (§6.3, S-3.9)" do
    test "a coding the vendor does not allow: converted when the text fits one it allows, else the next vendor" do
      config = vendors_v1(allowed_data_codings: [0])
      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)

      # Latin-1 (3) whose characters are all in GSM: to vendor 1 as GSM.
      {client, %{status: 0}} =
        submit(client, %{data_coding: 3, short_message: <<"caf", 0xE9>>}, 2)

      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm} = sent}, 2_000
      assert {sent.fields.data_coding, sent.fields.short_message} == {0, <<"caf", 0x05>>}

      # UCS-2 Cyrillic: vendor 1 cannot take it; vendor 2 gets it as sent.
      text = :unicode.characters_to_binary("Привет", :utf8, {:utf16, :big})
      {_, %{status: 0}} = submit(client, %{data_coding: 8, short_message: text}, 3)
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = sent}, 2_000
      assert {sent.fields.data_coding, sent.fields.short_message} == {8, text}
      refute_received {:smsc, ^c1, %Pdu{command: :submit_sm}}
    end

    test "a sender or destination TON / NPI the vendor does not allow passes it over" do
      config = vendors_v1(allowed_src_ton: [1, 2], allowed_dst_npi: [1])
      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)

      # An alphanumeric sender (TON 5): vendor 2.
      {client, %{status: 0}} = submit(client, %{short_message: "alpha"}, 2)
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000

      # An international one (TON 1): vendor 1.
      {_, %{status: 0}} =
        submit(client, %{source_addr: "4930123456", source_addr_ton: 1, short_message: "num"}, 3)

      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000
      refute_received {:smsc, ^c2, %Pdu{command: :submit_sm}}
    end

    test "no vendor can take it: refused at once with 0x45, nothing sent (Q15)" do
      # National numbers only: an international destination has no equivalent the vendor takes (S-4.7).
      config = [vendor_trunks: [PipelineConfig.vendor_trunk(allowed_dst_ton: [2])]]
      %{client: client, conns: [conn]} = start_all(config: config)
      {_, resp} = submit(client, %{short_message: "unknown TON", dest_addr_ton: 0})
      assert resp.status == 0x45
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 300
    end

    test "a TON / NPI the vendor does not take goes as the one equivalent it takes: destination 0 / 0 as 1 / 1" do
      config = [
        vendor_trunks: [PipelineConfig.vendor_trunk(allowed_dst_ton: [1], allowed_dst_npi: [1])]
      ]

      %{client: client, conns: [conn]} = start_all(config: config)

      {_, %{status: 0}} =
        submit(client, %{short_message: "equivalent", dest_addr_ton: 0, dest_addr_npi: 0})

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert {sent.fields.dest_addr_ton, sent.fields.dest_addr_npi} == {1, 1}
      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)

      assert [%{"c_dst_ton" => 0, "c_dst_npi" => 0, "v_dst_ton" => 1, "v_dst_npi" => 1}] =
               edr("edr.attempt")
    end

    test "a sender the vendor's TON / NPI lists do not take goes as its equivalent: alphanumeric 5 / 0, a number 1 / 1" do
      config = [
        vendor_trunks: [
          PipelineConfig.vendor_trunk(allowed_src_ton: [1, 5], allowed_src_npi: [0, 1])
        ]
      ]

      %{client: client, conns: [conn]} = start_all(config: config)

      {client, %{status: 0}} =
        submit(
          client,
          %{source_addr: "FakeBank", source_addr_ton: 2, source_addr_npi: 8, short_message: "a"},
          2
        )

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert source(sent) == {"FakeBank", 5, 0}

      {client, %{status: 0}} =
        submit(client, %{source_addr: "+4930123456", source_addr_ton: 0, short_message: "b"}, 3)

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert source(sent) == {"4930123456", 1, 1}

      # A short code has no single equivalent: TON 0 is not taken, and no vendor is left.
      {_, resp} =
        submit(client, %{source_addr: "12345", source_addr_ton: 0, short_message: "c"}, 4)

      assert resp.status == 0x45
    end

    test "a rule with Deny Multipart never matches a multipart message; the next rule routes it" do
      config =
        two_vendors(
          route_rules: [%{id: 1, priority: 200, deny_multipart: true}, %{id: 2, priority: 100}],
          route_vendors: [PipelineConfig.route_vendor(1, 1), PipelineConfig.route_vendor(2, 2)]
        )

      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)
      {client, %{status: 0}} = submit(client, %{short_message: "one part"}, 2)
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000

      {_, %{status: 0}} = submit(client, %{short_message: String.duplicate("m", 200)}, 3)
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000
      refute_received {:smsc, ^c1, %Pdu{command: :submit_sm}}

      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      assert Enum.sort(Enum.map(edr("edr.attempt"), & &1["route_rule_id"])) == [1, 2]
    end
  end

  describe "automatic TON / NPI after translation (S-4.7)" do
    test "a customer trunk on auto: an alphanumeric sender sent with TON 1 goes as TON 5 / NPI 0" do
      config = [customer_trunks: [PipelineConfig.customer_trunk(ton_npi_mode: "auto")]]
      %{client: client, conns: [conn]} = start_all(config: config)

      {_, %{status: 0}} =
        submit(client, %{
          source_addr: "FakeBank",
          source_addr_ton: 1,
          source_addr_npi: 1,
          short_message: "alpha"
        })

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert source(sent) == {"FakeBank", 5, 0}
      # The EDR keeps what the customer sent and what the vendor was sent.
      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)

      assert [%{"c_src_ton" => 1, "c_src_npi" => 1, "v_src_ton" => 5, "v_src_npi" => 0}] =
               edr("edr.attempt")
    end

    test "a customer trunk on auto: +44… sent with TON 5 goes without the + as TON 1 / NPI 1" do
      config = [customer_trunks: [PipelineConfig.customer_trunk(ton_npi_mode: "auto")]]
      %{client: client, conns: [conn]} = start_all(config: config)

      {_, %{status: 0}} =
        submit(client, %{
          source_addr: "+447700900123",
          source_addr_ton: 5,
          source_addr_npi: 0,
          short_message: "intl"
        })

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert source(sent) == {"447700900123", 1, 1}
      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)

      assert [%{"src_addr" => "+447700900123", "v_src_addr" => "447700900123", "v_src_ton" => 1}] =
               edr("edr.attempt")
    end

    test "as sent (the default): TON / NPI go as they came; +44… with TON 5 is still refused 0x0A" do
      %{client: client, conns: [conn]} = start_all()

      {client, %{status: 0}} =
        submit(client, %{
          source_addr: "FakeBank",
          source_addr_ton: 1,
          source_addr_npi: 1,
          dest_addr_ton: 0,
          short_message: "as sent"
        })

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert source(sent) == {"FakeBank", 1, 1}
      assert sent.fields.dest_addr_ton == 0

      {_, resp} =
        submit(
          client,
          %{source_addr: "+447700900123", source_addr_ton: 5, short_message: "plus"},
          3
        )

      assert resp.status == 0x0A
    end

    test "a customer trunk on auto cannot fix a length: a 14-character sender is still refused 0x0A" do
      config = [customer_trunks: [PipelineConfig.customer_trunk(ton_npi_mode: "auto")]]
      %{client: client, conns: [conn]} = start_all(config: config)

      {_, resp} =
        submit(client, %{source_addr: "ABCDEFGHIJKLMN", source_addr_ton: 1, short_message: "long"})

      assert resp.status == 0x0A
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 300
    end

    test "a customer trunk on auto: an ingress translation leaving 14 characters is refused 0x0A" do
      config = [
        customer_trunks: [PipelineConfig.customer_trunk(ton_npi_mode: "auto")],
        translation_rules: [
          %{id: 32, sender_conversion: "append", sender_conversion_value: "Promos"}
        ],
        translation_targets: [PipelineConfig.target(32, "customer", 1)]
      ]

      %{client: client, conns: [conn]} = start_all(config: config)
      {_, resp} = submit(client, %{source_addr: "FakeBank", short_message: "longer"})
      assert resp.status == 0x0A
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 300
      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)
      assert [%{"attempt_no" => 0, "command_status" => 0x0A}] = edr("edr.attempt")
    end

    test "a TON / NPI a translation rule sets wins over auto" do
      config = [
        customer_trunks: [PipelineConfig.customer_trunk(ton_npi_mode: "auto")],
        translation_rules: [%{id: 30, sender_ton: 2}],
        translation_targets: [PipelineConfig.target(30, "customer", 1)]
      ]

      %{client: client, conns: [conn]} = start_all(config: config)

      {_, %{status: 0}} =
        submit(client, %{
          source_addr: "FakeBank",
          source_addr_ton: 1,
          source_addr_npi: 1,
          short_message: "rule"
        })

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert source(sent) == {"FakeBank", 2, 0}
    end

    test "a vendor on auto gets a destination sent with TON 0 as 1 / 1, though it takes any" do
      config = [vendor_trunks: [PipelineConfig.vendor_trunk(ton_npi_mode: "auto")]]

      %{client: client, conns: [conn]} = start_all(config: config)

      {_, %{status: 0}} =
        submit(client, %{short_message: "unknown TON", dest_addr_ton: 0, dest_addr_npi: 0})

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000

      assert {sent.fields.destination_addr, sent.fields.dest_addr_ton, sent.fields.dest_addr_npi} ==
               {@dest, 1, 1}

      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)

      assert [%{"c_dst_ton" => 0, "c_dst_npi" => 0, "v_dst_ton" => 1, "v_dst_npi" => 1}] =
               edr("edr.attempt")
    end

    test "a vendor on auto gets +… without the + as TON 1 / NPI 1, after its egress translation" do
      config = [vendor_trunks: [PipelineConfig.vendor_trunk(ton_npi_mode: "auto")]]
      %{client: client, conns: [conn]} = start_all(config: config)

      # 11 characters: fit to send as the customer's alphanumeric sender (TON 5).
      {_, %{status: 0}} =
        submit(client, %{source_addr: "+4477009001", source_addr_ton: 5, short_message: "plus"})

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert source(sent) == {"4477009001", 1, 1}
    end

    test "a vendor on auto keeps a TON an ingress rule set" do
      config = [
        vendor_trunks: [PipelineConfig.vendor_trunk(ton_npi_mode: "auto")],
        translation_rules: [%{id: 33, sender_ton: 2}],
        translation_targets: [PipelineConfig.target(33, "customer", 1)]
      ]

      %{client: client, conns: [conn]} = start_all(config: config)

      {_, %{status: 0}} =
        submit(client, %{source_addr: "FakeBank", source_addr_npi: 1, short_message: "kept"})

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert source(sent) == {"FakeBank", 2, 0}
    end

    test "a vendor on auto cannot fix a length: an egress translation leaving 14 characters passes it over" do
      config =
        two_vendors(
          vendor_trunks: [
            PipelineConfig.vendor_trunk(id: 1, ton_npi_mode: "auto"),
            PipelineConfig.vendor_trunk(id: 2, rate_table_ids: [201])
          ],
          translation_rules: [
            %{id: 31, sender_conversion: "append", sender_conversion_value: "Promos"}
          ],
          translation_targets: [PipelineConfig.target(31, "vendor", 1)]
        )

      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)
      {_, %{status: 0}} = submit(client, %{short_message: "not via 1"})
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = sent}, 2_000
      assert source(sent) == {"FakeBank", 5, 0}
      refute_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 200
    end
  end

  describe "Refuse invalid senders per vendor trunk (S-2.10, S-4.7)" do
    @long_sender "ABCDEFGHIJKLMN"

    test "a 14-character sender is refused 0x0A when every vendor refuses it (the default)" do
      %{client: client} = start_all(smscs: 2, config: two_vendors())
      {_, resp} = submit(client, %{source_addr: @long_sender, short_message: "long"})
      assert resp.status == 0x0A
      refute_receive {:smsc, _conn, %Pdu{command: :submit_sm}}, 300
      assert_eventually(fn -> length(edr("edr.attempt")) == 1 end)
      assert [%{"attempt_no" => 0, "command_status" => 0x0A}] = edr("edr.attempt")
    end

    test "a vendor with the option off takes it as it is; TON / NPI outside SMPP are still refused at intake" do
      config = [vendor_trunks: [PipelineConfig.vendor_trunk(refuse_invalid_senders: false)]]
      %{client: client, conns: [conn]} = start_all(config: config)
      {client, %{status: 0}} = submit(client, %{source_addr: @long_sender, short_message: "long"})
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000
      assert source(sent) == {@long_sender, 5, 0}

      {client, resp} =
        submit(client, %{source_addr: "FakeBank", source_addr_ton: 7, short_message: "a"}, 3)

      assert resp.status == 0x48
      {_, resp} = submit(client, %{source_addr: "", short_message: "b"}, 4)
      assert resp.status == 0x0A
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 300
    end

    test "with two vendors it skips the one refusing the sender and uses the other" do
      config = vendors_v1([])

      config =
        Keyword.put(config, :vendor_trunks, [
          PipelineConfig.vendor_trunk(id: 1),
          PipelineConfig.vendor_trunk(id: 2, rate_table_ids: [201], refuse_invalid_senders: false)
        ])

      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)
      {client, %{status: 0}} = submit(client, %{source_addr: @long_sender, short_message: "long"})
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.source_addr == @long_sender
      refute_received {:smsc, ^c1, %Pdu{command: :submit_sm}}

      # A sender both take still goes to the first.
      {_, %{status: 0}} = submit(client, %{short_message: "short"}, 3)
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000
    end

    test "one vendor refusing the sender and another passed over for something else: 0x45, not 0x0A" do
      config = vendors_v1([])

      config =
        Keyword.put(config, :vendor_trunks, [
          PipelineConfig.vendor_trunk(id: 1),
          PipelineConfig.vendor_trunk(
            id: 2,
            rate_table_ids: [201],
            refuse_invalid_senders: false,
            allowed_dst_ton: [2]
          )
        ])

      %{client: client} = start_all(smscs: 2, config: config)
      {_, resp} = submit(client, %{source_addr: @long_sender, short_message: "long"})
      assert resp.status == 0x45
    end
  end

  defp source(%Pdu{fields: f}), do: {f.source_addr, f.source_addr_ton, f.source_addr_npi}

  # Two vendors at levels 1 and 2; vendor 1's trunk fields as given.
  defp vendors_v1(v1_fields) do
    [
      vendor_trunks: [
        PipelineConfig.vendor_trunk([id: 1] ++ v1_fields),
        PipelineConfig.vendor_trunk(id: 2, rate_table_ids: [201])
      ],
      rates: [
        PipelineConfig.rate(100, 1, "26201", "0.05"),
        PipelineConfig.rate(200, 2, "26201", "0.02"),
        PipelineConfig.rate(201, 3, "26201", "0.03")
      ],
      route_vendors: [PipelineConfig.route_vendor(1, 1, 1), PipelineConfig.route_vendor(1, 2, 2)]
    ]
  end

  describe "re-route on a failed receipt (S-5.11, D2)" do
    test "a delivery-billed vendor's UNDELIV sends the message to the next vendor; the customer gets one receipt" do
      config = vendors_v1(billing_type: "delivery", reroute_on: ["UNDELIV", "EXPIRED"])
      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)

      {client, resp} = submit(client, %{short_message: "reroute me", registered_delivery: 1})
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000
      receipt(c1, "1", "UNDELIV", "005")
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.short_message == "reroute me"

      receipt(c2, "1", "DELIVRD")
      {client, dlr} = customer_receipt(client)
      assert dlr.fields.short_message =~ "stat:DELIVRD"
      assert {:receipted_message_id, resp.fields.message_id} in dlr.tlvs
      assert {:error, :timeout} = Client.recv(client, 300)

      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)

      # The attempt the failed receipt caused is marked a DLR re-route.
      assert Enum.map(
               Enum.sort_by(edr("edr.attempt"), & &1["attempt_no"]),
               &{&1["v_trunk_id"], &1["dlr_reroute"]}
             ) == [{1, 0}, {2, 1}]
    end

    test "no re-route from a vendor that bills on submit: the customer gets the failure" do
      config = vendors_v1(billing_type: "submit", reroute_on: ["UNDELIV"])
      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)
      {client, _} = submit(client, %{short_message: "billed", registered_delivery: 1})
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000
      receipt(c1, "1", "UNDELIV", "005")
      {_, dlr} = customer_receipt(client)
      assert dlr.fields.short_message =~ "stat:UNDELIV err:005"
      refute_received {:smsc, ^c2, %Pdu{command: :submit_sm}}
    end

    test "no vendor left: the customer gets the failed receipt" do
      config = [
        vendor_trunks: [
          PipelineConfig.vendor_trunk(billing_type: "delivery", reroute_on: ["UNDELIV"])
        ]
      ]

      %{client: client, conns: [conn]} = start_all(config: config)
      {client, _} = submit(client, %{short_message: "last", registered_delivery: 1})
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000
      receipt(conn, "1", "UNDELIV", "005")
      {_, dlr} = customer_receipt(client)
      assert dlr.fields.short_message =~ "stat:UNDELIV err:005"
    end
  end

  describe "late vendor answer (S-5.2, D4)" do
    test "a submit that timed out is re-routed; the vendor's late OK marks it a possible duplicate" do
      %{client: client, smscs: [s1, _], conns: [c1, c2]} =
        start_all(smscs: 2, config: vendors_v1([]), vendor_fields: %{1 => [submit_timeout_s: 1]})

      start_supervised!(Pipeline.LateResponses)
      FakeSmsc.set(s1, :submit, {:delay, 1_500})
      {_, resp} = submit(client, %{short_message: "slow"})
      assert resp.status == 0
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 4_000

      assert_eventually(
        fn ->
          Enum.any?(
            edr("edr.receipt"),
            &(&1["msg_status"] == "ACCEPTD" and &1["is_duplicate"] == 1)
          )
        end,
        4_000
      )

      [timed_out] = Enum.filter(edr("edr.attempt"), &(&1["command_status"] == -1))
      flag = Enum.find(edr("edr.receipt"), &(&1["msg_status"] == "ACCEPTD"))
      assert flag["edr_id"] == timed_out["edr_id"]
      assert flag["v_trunk_id"] == 1
    end
  end

  describe "duplicate filter and loop detection (S-2.7, S-5.16, D6)" do
    test "the same message again within the window gets the first id and is not sent twice" do
      customer = PipelineConfig.customer_trunk(duplicate_window_s: 60)
      %{client: client, conns: [conn]} = start_all(config: [customer_trunks: [customer]])

      {client, first} = submit(client, %{short_message: "only once"}, 2)
      {client, again} = submit(client, %{short_message: "only once"}, 3)
      {_, other} = submit(client, %{short_message: "something else"}, 4)
      assert again.fields.message_id == first.fields.message_id
      assert other.fields.message_id != first.fields.message_id

      assert_receive {:smsc, ^conn,
                      %Pdu{command: :submit_sm, fields: %{short_message: "only once"}}},
                     2_000

      assert_receive {:smsc, ^conn,
                      %Pdu{command: :submit_sm, fields: %{short_message: "something else"}}},
                     2_000

      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 300
    end

    test "a refused message is not a duplicate: its resend is checked again" do
      customer = PipelineConfig.customer_trunk(duplicate_window_s: 60)
      %{client: client} = start_all(config: [customer_trunks: [customer]])

      {client, r1} =
        submit(client, %{destination_addr: "33612345678", short_message: "no rate"}, 2)

      {_, r2} = submit(client, %{destination_addr: "33612345678", short_message: "no rate"}, 3)
      assert {r1.status, r2.status} == {0x0B, 0x0B}
    end

    test "our message coming back on another trunk while in flight is refused (Loop Detection)" do
      trunks = [
        PipelineConfig.customer_trunk(),
        PipelineConfig.customer_trunk(id: 2, loop_detection: true)
      ]

      %{client: client, port: port, conns: [conn]} =
        start_all(
          config: [customer_trunks: trunks],
          more_customers: [CustomerCase.trunk(id: 2, username: "loop", name: "LOOPBACK")]
        )

      {_, resp} = submit(client, %{short_message: "round trip"})
      assert resp.status == 0
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm} = sent}, 2_000

      # The vendor routes it back into our trunk 2.
      {back, _} = Client.bind(port, :bind_transceiver, %{system_id: "loop", password: "secret"})

      fields = %{
        source_addr: sent.fields.source_addr,
        destination_addr: sent.fields.destination_addr
      }

      {_, looped} = submit(back, Map.put(fields, :short_message, "round trip"))
      assert looped.status == 0x45
    end
  end

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

      # Each outcome row is published after its receipt reached the customer; under a loaded CI runner that can take
      # longer than the default 2 s (as the other bus assertions here allow).
      assert_eventually(
        fn -> Enum.count(edr("edr.receipt"), &(&1["kind"] == "vendor")) == 2 end,
        5_000
      )
    end
  end

  describe "empty messages (D10)" do
    test "sent when the customer trunk allows empty messages (refused 0x01 otherwise, above)" do
      %{client: client, conns: [conn]} =
        start_all(
          config: [customer_trunks: [PipelineConfig.customer_trunk(allow_empty_messages: true)]]
        )

      {_, resp} = submit(client, %{short_message: ""})
      assert resp.status == 0

      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm, fields: %{short_message: ""}}},
                     2_000
    end
  end

  describe "service trunks (team trial round 12)" do
    test "nothing goes to the network; the customer gets the trunk's status after its delay" do
      config = [
        vendor_trunks: [
          PipelineConfig.vendor_trunk(
            protocol: "service",
            dlr_timeout_s: 0,
            dlr_timeout_stat: "UNDELIV"
          )
        ]
      ]

      %{client: client, conns: [conn]} = start_all(config: config)
      start_supervised!({Pipeline.Timeouts, sweep_ms: 100})

      {client, resp} =
        submit(client, %{short_message: "to a service trunk", registered_delivery: 1})

      assert resp.status == 0
      id = resp.fields.message_id

      {_, dlr} = customer_receipt(client, 4_000)
      assert dlr.fields.short_message =~ "id:#{id}"
      assert dlr.fields.short_message =~ "stat:UNDELIV"
      refute_received {:smsc, ^conn, %Pdu{command: :submit_sm}}

      assert_eventually(fn ->
        Enum.any?(
          edr("edr.receipt"),
          &(&1["kind"] == "customer" and &1["source"] == "switch" and
              &1["c_msg_status"] == "UNDELIV")
        )
      end)
    end
  end

  describe "DLR timeout (S-5.10, D5)" do
    test "no receipt within the vendor trunk's DLR Timeout: the customer gets its DLR Timeout Status" do
      config = [
        vendor_trunks: [
          PipelineConfig.vendor_trunk(dlr_timeout_s: 1, dlr_timeout_stat: "EXPIRED")
        ]
      ]

      %{client: client, conns: [conn]} = start_all(config: config)
      start_supervised!({Pipeline.Timeouts, sweep_ms: 100})

      {client, resp} = submit(client, %{short_message: "no receipt", registered_delivery: 1})
      id = resp.fields.message_id
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000
      assert {:ok, _} = Pipeline.Store.message(id)

      {_, dlr} = customer_receipt(client, 4_000)
      assert dlr.fields.short_message =~ "id:#{id}"
      assert dlr.fields.short_message =~ "stat:EXPIRED"
      assert {:message_state, 3} in dlr.tlvs

      # The message has left Redis; the EDR shows the answer was the switch's.
      assert_eventually(fn -> Pipeline.Store.message(id) == :none end)
      assert {:ok, []} = Pipeline.Store.due_timeouts(System.os_time(:millisecond) + 10_000, 10)

      assert_eventually(fn ->
        Enum.any?(
          edr("edr.receipt"),
          &(&1["kind"] == "vendor" and &1["source"] == "switch" and &1["msg_status"] == "EXPIRED")
        )
      end)

      row = Enum.find(edr("edr.receipt"), &(&1["kind"] == "customer"))
      assert %{"c_msg_status" => "EXPIRED", "source" => "switch"} = row
    end

    test "a final receipt in time cancels the timeout" do
      config = [
        vendor_trunks: [
          PipelineConfig.vendor_trunk(dlr_timeout_s: 1, dlr_timeout_stat: "EXPIRED")
        ]
      ]

      %{client: client, conns: [conn]} = start_all(config: config)
      start_supervised!({Pipeline.Timeouts, sweep_ms: 100})

      {client, _} = submit(client, %{short_message: "in time", registered_delivery: 1})
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000
      receipt(conn, "1", "DELIVRD")
      {client, dlr} = customer_receipt(client)
      assert dlr.fields.short_message =~ "stat:DELIVRD"

      assert_eventually(fn ->
        Pipeline.Store.due_timeouts(System.os_time(:millisecond) + 10_000, 10) == {:ok, []}
      end)

      assert {:error, :timeout} = Client.recv(client, 1_500)
    end

    test "a part already answered keeps its status; the parts still waiting get the timeout status" do
      config = [
        vendor_trunks: [
          PipelineConfig.vendor_trunk(dlr_timeout_s: 1, dlr_timeout_stat: "UNDELIV")
        ]
      ]

      %{client: client, conns: [conn]} = start_all(config: config)
      start_supervised!({Pipeline.Timeouts, sweep_ms: 100})

      fields = %{
        source_addr: "FakeBank",
        destination_addr: @dest,
        registered_delivery: 1,
        short_message: ""
      }

      Client.send_pdu(
        client,
        Pdu.new(:submit_sm, fields,
          tlvs: [message_payload: String.duplicate("t", 200)],
          sequence: 2
        )
      )

      assert {client, %Pdu{command: :submit_sm_resp, status: 0}} = Client.recv(client, 5_000)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000

      receipt(conn, "1", "DELIVRD")
      {_, dlr} = customer_receipt(client, 4_000)
      assert dlr.fields.short_message =~ "stat:UNDELIV"

      assert Enum.count(
               edr("edr.receipt"),
               &(&1["source"] == "switch" and &1["kind"] == "vendor")
             ) == 1
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

  describe "query_sm and cancel_sm (S-2.15, D8)" do
    defp query(client, id, seq \\ 3) do
      Client.send_pdu(
        client,
        Pdu.new(:query_sm, %{message_id: id, source_addr: "FakeBank"}, sequence: seq)
      )

      assert {client, %Pdu{command: :query_sm_resp, sequence: ^seq} = resp} =
               Client.recv(client, 5_000)

      {client, resp}
    end

    defp cancel(client, id, seq) do
      Client.send_pdu(
        client,
        Pdu.new(:cancel_sm, %{message_id: id, source_addr: "FakeBank"}, sequence: seq)
      )

      assert {client, %Pdu{command: :cancel_sm_resp, sequence: ^seq} = resp} =
               Client.recv(client, 5_000)

      {client, resp}
    end

    test "a message waiting for its receipt is ENROUTE; an unknown or foreign id fails 0x67" do
      %{client: client} = start_all()
      {client, resp} = submit(client, %{short_message: "where is it", registered_delivery: 1})
      id = resp.fields.message_id

      {client, q} = query(client, id)
      assert q.status == 0
      assert q.fields.message_id == id
      assert q.fields.message_state == 1
      assert q.fields.final_date == ""

      # Not an id of ours.
      {client, q} = query(client, "not-an-id", 4)
      assert q.status == 0x67

      # A well-formed id nobody has (no record, no EDR store in this test): failed or system error, never a state.
      {_client, q} = query(client, Pipeline.MessageId.new(), 5)
      assert q.status in [0x67, 0x08]
    end

    test "cancel while queued: OK, DELETED for query_sm, and the sender drops it without a vendor or receipt" do
      %{client: client, conns: [conn]} = start_all(sender: false)
      {client, resp} = submit(client, %{short_message: "cancel me", registered_delivery: 1})
      id = resp.fields.message_id

      {client, c} = cancel(client, id, 3)
      assert c.status == 0
      {client, q} = query(client, id, 4)
      assert q.fields.message_state == 4

      [event] = for e <- Local.published(), e.type == "msg.accepted", do: e
      assert :ok = Pipeline.Sender.handle_event(event)
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 300

      assert_eventually(fn -> match?([_], edr("edr.attempt")) end)
      [row] = edr("edr.attempt")
      assert row["c_msg_status"] == "DELETED"
      assert row["c_message_id"] == id
      assert {:error, :timeout} = Client.recv(client, 300)
    end

    test "cancel after the sender took it, or of an unknown id: 0x11" do
      %{client: client} = start_all()
      {client, resp} = submit(client, %{short_message: "too late"})
      {client, c} = cancel(client, resp.fields.message_id, 3)
      assert c.status == 0x11
      {_client, c} = cancel(client, "", 4)
      assert c.status == 0x11
    end

    test "replace_sm is not supported: 0x03" do
      %{client: client} = start_all()

      Client.send_pdu(
        client,
        Pdu.new(:replace_sm, %{message_id: "x", source_addr: "FakeBank", short_message: "new"},
          sequence: 3
        )
      )

      assert {_, %Pdu{sequence: 3} = resp} = Client.recv(client, 5_000)
      assert resp.status == 0x03
    end
  end

  describe "Delayed Submit (S-2.18, D11)" do
    defp delayed(opts \\ []) do
      config =
        Keyword.merge(
          [customer_trunks: [PipelineConfig.customer_trunk(delayed_submit: true)]],
          opts[:config] || []
        )

      start_all(
        Keyword.merge(opts, config: config, customer: CustomerCase.trunk(delayed_submit: true))
      )
    end

    test "the resp waits for the vendor's answer and carries our message id" do
      %{client: client, smscs: [smsc]} = delayed()
      FakeSmsc.set(smsc, :submit, {:delay, 400})
      started = System.monotonic_time(:millisecond)
      {_client, resp} = submit(client, %{short_message: "wait for it"})
      assert resp.status == 0
      assert byte_size(resp.fields.message_id) == 20
      assert System.monotonic_time(:millisecond) - started >= 400
    end

    test "a vendor refusal with no vendor left is the resp's error, and no receipt follows" do
      %{client: client, smscs: [smsc]} = delayed()
      FakeSmsc.set(smsc, :submit, {:status, 0x0B})
      {client, resp} = submit(client, %{short_message: "refused", registered_delivery: 1})
      assert resp.status == 0x0B
      assert {:error, :timeout} = Client.recv(client, 300)
    end

    test "a silent vendor: 0x45 at its Submit Timeout" do
      %{client: client, smscs: [smsc]} = delayed(vendor_fields: %{1 => [submit_timeout_s: 1]})
      FakeSmsc.set(smsc, :submit, :silent)
      {_client, resp} = submit(client, %{short_message: "nobody home"})
      assert resp.status == 0x45
    end
  end

  describe "live TPS in routing (§13.8, §13.23)" do
    defp tps_rules(condition) do
      [
        route_rules: [
          %{id: 1, priority: 10, continue_routing: "stop", tps_condition: condition},
          %{id: 2, priority: 20}
        ],
        route_vendors: [PipelineConfig.route_vendor(1, 2), PipelineConfig.route_vendor(2, 1)]
      ]
    end

    defp at_tps(trunk_id, tps) do
      now = System.os_time(:second)
      for s <- (now - 5)..(now - 1), do: Pipeline.LiveTps.count(["ct:#{trunk_id}"], tps, s)
    end

    test "a TPS condition on the customer trunk sends the excess to its rule's vendor; the EDR records the TPS" do
      condition = %{"op" => ">", "value" => 50, "scope" => "customer_trunk", "window_s" => 5}

      %{client: client, conns: [c1, c2]} =
        start_all(smscs: 2, config: vendors_v1([]) ++ tps_rules(condition))

      {client, _} = submit(client, %{short_message: "slow"})
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000

      at_tps(1, 80)
      {_client, _} = submit(client, %{short_message: "fast"}, 3)
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000

      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      assert Enum.any?(edr("edr.attempt"), &(&1["measured_tps"] >= 80))
    end

    test "a vendor at the rule's % of its TPS limit is skipped for the next level" do
      config =
        [tps: 10, max_connections: 1]
        |> vendors_v1()
        |> Keyword.put(:route_rules, [%{id: 1, skip_vendor_at_tps_pct: 80}])

      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)
      Pipeline.LiveTps.count(["vt:1"], 9, System.os_time(:second) - 1)
      {_client, _} = submit(client, %{short_message: "busy vendor"})
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000
      refute_received {:smsc, ^c1, %Pdu{command: :submit_sm}}
    end
  end

  describe "billing at send time (§7)" do
    defp billed(customer_type, vendor_fields) do
      [
        customer_trunks: [PipelineConfig.customer_trunk(billing_type: customer_type)],
        vendor_trunks: [PipelineConfig.vendor_trunk(vendor_fields)]
      ]
    end

    defp outcome_rows, do: for(r <- edr("edr.receipt"), r["kind"] == "outcome", do: r)

    test "delivery billing on both sides: nothing at submit, billed on DELIVRD by the outcome row" do
      %{client: client, conns: [conn]} =
        start_all(config: billed("delivery", billing_type: "delivery"))

      {client, _} = submit(client, %{short_message: "bill on delivery", registered_delivery: 1})
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000

      assert_eventually(fn -> match?([_], edr("edr.attempt")) end)
      [attempt] = edr("edr.attempt")

      assert %{
               "is_customer_billable" => 0,
               "is_vendor_billable" => 0,
               "revenue" => "0",
               "cost" => "0"
             } = attempt

      receipt(conn, "1", "DELIVRD")
      {_client, _} = customer_receipt(client)
      assert_eventually(fn -> match?([_], outcome_rows()) end)
      [outcome] = outcome_rows()

      assert %{
               "is_customer_billable" => 1,
               "is_vendor_billable" => 1,
               "revenue" => "0.05",
               "cost" => "0.02"
             } =
               outcome

      assert outcome["edr_id"] == attempt["edr_id"]
      assert outcome["attempt_no"] == 1
      assert outcome["c_mccmnc"] == "26201"
    end

    test "delivery billing: an undelivered message is not billed" do
      %{client: client, conns: [conn]} =
        start_all(config: billed("delivery", billing_type: "delivery"))

      {client, _} = submit(client, %{short_message: "not delivered", registered_delivery: 1})
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000
      receipt(conn, "1", "UNDELIV", "005")
      {_client, _} = customer_receipt(client)
      assert_eventually(fn -> match?([_], outcome_rows()) end)

      assert [
               %{
                 "is_customer_billable" => 0,
                 "is_vendor_billable" => 0,
                 "msg_status" => "UNDELIV"
               }
             ] = outcome_rows()
    end

    test "reported billing bills any final status; the DLR timeout's own status never bills the vendor" do
      %{client: client, conns: [conn]} =
        start_all(config: billed("reported", billing_type: "reported", dlr_timeout_s: 1))

      {client, _} = submit(client, %{short_message: "reported", registered_delivery: 1})
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000
      start_supervised!({Pipeline.Timeouts, sweep_ms: 100})
      {_client, dlr} = customer_receipt(client)
      assert dlr.fields.short_message =~ "stat:UNKNOWN"

      assert_eventually(fn -> match?([_], outcome_rows()) end)

      # The customer is told UNKNOWN (a final status): billed; the vendor never answered: not billed.
      assert [%{"is_customer_billable" => 1, "is_vendor_billable" => 0, "source" => "switch"}] =
               outcome_rows()
    end

    test "attempt billing bills the customer on a message no vendor took; a refusal is not a vendor's billable submit" do
      %{client: client, smscs: [smsc], conns: [conn]} = start_all(config: billed("attempt", []))
      FakeSmsc.set(smsc, :submit, {:status, 0x45})
      {_client, _} = submit(client, %{short_message: "tried"})
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000
      assert_eventually(fn -> match?([_], edr("edr.attempt")) end)

      assert [%{"is_customer_billable" => 1, "is_vendor_billable" => 0, "revenue" => "0.05"}] =
               edr("edr.attempt")
    end

    test "a re-route after a failed receipt does not bill the customer twice" do
      config = vendors_v1(billing_type: "delivery", reroute_on: ["UNDELIV"])
      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)
      {client, _} = submit(client, %{short_message: "once", registered_delivery: 1})
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000
      receipt(c1, "1", "UNDELIV", "005")
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000
      receipt(c2, "1", "DELIVRD")
      {_client, _} = customer_receipt(client)

      assert_eventually(fn -> length(edr("edr.attempt")) == 2 end)
      rows = Enum.sort_by(edr("edr.attempt"), & &1["attempt_no"])
      assert Enum.map(rows, & &1["is_customer_billable"]) == [1, 0]
      # The first vendor bills on delivery and did not deliver; the second bills on submit.
      assert Enum.map(rows, & &1["is_vendor_billable"]) == [0, 1]

      assert_eventually(fn -> length(outcome_rows()) == 2 end)
      assert Enum.all?(outcome_rows(), &(&1["is_customer_billable"] == 0))
    end
  end

  describe "credit check (§7, Q24)" do
    test "a prepaid customer is refused 0x45 once its balance no longer covers a message; billed messages count" do
      LedgerSource.put([[enterprise_id: 11, prepaid: true, base: "0.06"]])

      start_supervised!({Sync, source: LedgerSource, interval_ms: 3_600_000})

      start_supervised!(Pipeline.Ledger.Charges)
      :ok = Sync.sync()

      %{client: client, conns: [conn]} = start_all()
      {client, resp} = submit(client, %{short_message: "first"})
      assert resp.status == 0
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 2_000
      # Billed on submit: 0.05 of the 0.06 used.
      assert_eventually(fn -> Pipeline.Ledger.balance("c11") == 10_000 end)

      {_client, resp} = submit(client, %{short_message: "second"}, 3)
      assert resp.status == 0x45
      refute_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 300
    end
  end

  describe "accumulated revenue conditions (§13.9)" do
    test "the customer's revenue today above a value sends its traffic to the rule's vendor" do
      start_supervised!(Pipeline.Ledger.Charges)

      condition = %{
        "type" => "accumulated",
        "op" => ">",
        "value" => 0.04,
        "scope" => "customer_enterprise",
        "period" => "today"
      }

      config =
        Keyword.merge(vendors_v1([]),
          route_rules: [
            %{id: 1, priority: 10, continue_routing: "stop", revenue_condition: condition},
            %{id: 2, priority: 20}
          ],
          route_vendors: [PipelineConfig.route_vendor(1, 2), PipelineConfig.route_vendor(2, 1)]
        )

      %{client: client, conns: [c1, c2]} = start_all(smscs: 2, config: config)
      {client, _} = submit(client, %{short_message: "no revenue yet"})
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 2_000

      # Billed on submit: 0.05 earned today.
      {_client, _} = submit(client, %{short_message: "a good customer now"}, 3)
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000
    end
  end
end
