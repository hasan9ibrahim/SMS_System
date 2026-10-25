defmodule Sms.Switch.Pipeline.InjectTest do
  # Messages the platform sends itself (backend step 11c, §9.1, §9.2): Test SMS from the Route Simulator and EDR Repush,
  # through the whole path to a fake vendor SMSC. Never billed to the customer, no receipt to it, a chosen vendor is
  # never swapped for another.
  use Sms.Switch.Test.VendorCase, async: false
  @moduletag capture_log: true

  alias Sms.Core.Bus.Local
  alias Sms.Core.ClickHouse
  alias Sms.Switch.Commands
  alias Sms.Switch.Commands.Inject
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

  # Two vendors; the route rule sends to vendor 1. The customer's client is bound, to see that no receipt reaches it.
  defp start_all(config \\ []) do
    PipelineConfig.put(
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
          ]
        ],
        config
      )
    )

    start_supervised!({Pipeline.Config.Server, loader: PipelineConfig})
    CustomerCase.assert_eventually(&Pipeline.Config.ready?/0)
    start_supervised!(Pipeline.Sender)
    start_supervised!(Pipeline.Forwarder)
    start_supervised!({Pipeline.Held, sweep_ms: 60_000})
    start_supervised!(Pipeline.Held.OnBind)
    start_supervised!({Pipeline.Buffers, discover_ms: 3_600_000})

    smscs = for _ <- 1..2, do: start_smsc()

    vendors =
      smscs
      |> Enum.with_index(1)
      |> Enum.map(fn {s, id} -> trunk(FakeSmsc.port(s), id: id, name: "V#{id}") end)

    start_vendor(vendors, receipts: Pipeline.Receipts)
    for v <- vendors, do: await_bound(v.id, 1)
    conns = for s <- smscs, do: hd(FakeSmsc.connections(s))

    %{port: port} =
      CustomerCase.start_customer(trunks: [CustomerCase.trunk()], intake: Pipeline.Intake)

    {client, %{status: 0}} =
      Client.bind(port, :bind_transceiver, %{system_id: "acme", password: "secret"})

    %{client: client, conns: conns, smscs: smscs}
  end

  defp attempts, do: for(e <- Local.published(), e.type == "edr.attempt", do: e.data)

  defp receipt(conn, vendor_id, stat) do
    text =
      "id:#{vendor_id} sub:001 dlvrd:001 submit date:2610241200 done date:2610241201 stat:#{stat} err:000 text:"

    FakeSmsc.send_pdu(
      conn,
      Pdu.new(:deliver_sm, %{esm_class: 0x04, short_message: text}, sequence: 900)
    )
  end

  describe "Test SMS" do
    test "routed by the rules: sent, vendor billed, customer neither billed nor sent a receipt" do
      %{client: client, conns: [c1, _c2]} = start_all()

      assert {:ok, %{status: "ACCEPTD", message_id: id}} =
               Inject.test_sms(%{
                 "customer_trunk_id" => 1,
                 "receiver" => @dest,
                 "sender" => "Tester",
                 "text" => "Hi"
               })

      assert is_binary(id)
      assert_receive {:smsc, ^c1, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.short_message == "Hi" and sent.fields.source_addr == "Tester"
      # The switch still asks the vendor for its receipt.
      assert sent.fields.registered_delivery == 1

      assert_eventually(fn -> match?([_], attempts()) end)
      [row] = attempts()
      assert row["is_customer_billable"] == 0 and row["revenue"] == "0"
      assert row["is_vendor_billable"] == 1
      assert row["repush_request_id"] == 0
      refute row["route_decided_by"] == "manual"

      receipt(c1, "1", "DELIVRD")
      assert {:error, :timeout} = Client.recv(client, 500)
    end

    test "to a chosen vendor: that vendor, decided manually, and no other vendor when it refuses" do
      %{conns: [c1, c2], smscs: [_s1, s2]} = start_all()

      assert {:ok, %{status: "ACCEPTD"}} =
               Inject.test_sms(%{
                 "customer_trunk_id" => 1,
                 "receiver" => @dest,
                 "vendor_trunk_id" => 2
               })

      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.short_message == "Test" and sent.fields.source_addr == "Test"
      refute_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 200
      assert_eventually(fn -> match?([_], attempts()) end)

      assert [%{"route_decided_by" => "manual", "route_type" => "manual", "v_trunk_id" => 2}] =
               attempts()

      # The vendor refuses the next one: it fails there, nothing goes to vendor 1.
      FakeSmsc.set(s2, :submit, {:status, 0x45})

      {:ok, _} =
        Inject.test_sms(%{"customer_trunk_id" => 1, "receiver" => @dest, "vendor_trunk_id" => 2})

      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm}}, 2_000
      refute_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 500
      assert_eventually(fn -> length(attempts()) == 2 end)
      assert %{"is_submit_success" => 0, "v_trunk_id" => 2} = List.last(attempts())
    end

    test "refusals come back as REJECTD with the reason" do
      start_all(
        vendor_trunks: [
          PipelineConfig.vendor_trunk(id: 1),
          PipelineConfig.vendor_trunk(id: 2, active: false)
        ]
      )

      assert {:ok, %{status: "REJECTD", message_id: nil, detail: detail}} =
               Inject.test_sms(%{
                 "customer_trunk_id" => 1,
                 "receiver" => @dest,
                 "vendor_trunk_id" => 2
               })

      assert detail =~ "inactive or stopped"

      assert {:ok, %{status: "REJECTD", detail: "Refused: unknown vendor trunk" <> _}} =
               Inject.test_sms(%{
                 "customer_trunk_id" => 1,
                 "receiver" => @dest,
                 "vendor_trunk_id" => 99
               })

      assert {:ok, %{status: "REJECTD", detail: "Refused: unknown customer trunk"}} =
               Inject.test_sms(%{"customer_trunk_id" => 99, "receiver" => @dest})

      assert {:ok, %{status: "REJECTD", detail: "Refused: unknown destination" <> _}} =
               Inject.test_sms(%{"customer_trunk_id" => 1, "receiver" => "33612345678"})
    end

    test "checks its input" do
      assert {:error, {:bad_input, "customer_trunk_id" <> _}} =
               Inject.test_sms(%{"receiver" => @dest})

      assert {:error, {:bad_input, "receiver" <> _}} =
               Inject.test_sms(%{"customer_trunk_id" => 1})

      assert {:error, {:bad_input, "vendor_trunk_id" <> _}} =
               Inject.test_sms(%{
                 "customer_trunk_id" => 1,
                 "receiver" => @dest,
                 "vendor_trunk_id" => "x"
               })

      assert %{ok: false, error: "receiver must be" <> _} =
               Commands.answer("test_sms", Jason.encode!(%{"customer_trunk_id" => 1}))
    end
  end

  describe "the message built" do
    test "GSM when it fits, else UCS-2; a long text in message_payload; binary from hex" do
      base = %{source: "S", destination: @dest, source_ton: nil, source_npi: nil}

      assert {:ok, %Pdu{fields: %{data_coding: 0, short_message: "Hello"}}} =
               Inject.pdu(Map.merge(base, %{text: "Hello", data_coding: nil}))

      assert {:ok, %Pdu{fields: %{data_coding: 8, short_message: <<0x04, 0x1F>>}}} =
               Inject.pdu(Map.merge(base, %{text: "П", data_coding: nil}))

      assert {:ok, %Pdu{tlvs: [{:message_payload, long}], fields: fields}} =
               Inject.pdu(Map.merge(base, %{text: String.duplicate("a", 300), data_coding: 0}))

      assert byte_size(long) == 300 and not Map.has_key?(fields, :short_message)

      assert {:ok, %Pdu{fields: %{data_coding: 4, short_message: <<0xCA, 0xFE>>}}} =
               Inject.pdu(Map.merge(base, %{text: "CAFE", data_coding: 4}))

      assert {:error, {:bad_input, _}} =
               Inject.pdu(Map.merge(base, %{text: "zz", data_coding: 4}))

      # A text the coding cannot carry goes as UCS-2.
      assert {:ok, %Pdu{fields: %{data_coding: 8}}} =
               Inject.pdu(Map.merge(base, %{text: "€uro ✓", data_coding: 1}))
    end

    test "repush checks its input before reading any EDR" do
      assert {:error, {:bad_input, "request_id" <> _}} = Inject.repush(%{})

      assert {:error, {:bad_input, "edr_ids must list" <> _}} =
               Inject.repush(%{"request_id" => 1, "vendor_trunk_id" => 2, "edr_ids" => []})

      assert {:error, {:bad_input, "edr_ids must be" <> _}} =
               Inject.repush(%{"request_id" => 1, "vendor_trunk_id" => 2, "edr_ids" => ["nope"]})
    end
  end

  describe "EDR Repush on the EDR store" do
    @describetag :integration

    test "sends each final attempt again on the chosen vendor with the request id" do
      start_supervised!(ClickHouse)
      %{client: client, conns: [c1, c2]} = start_all()
      id = Ecto.UUID.generate()
      other = Ecto.UUID.generate()

      {:ok, _} =
        ClickHouse.query(
          """
          INSERT INTO edr (edr_id, start_time, submit_time, msg_type, c_trunk_id, src_addr, dst_addr, message_text,
                           c_coding, c_src_ton, c_src_npi, attempt_no, is_final_attempt, msg_status)
          VALUES ({id:UUID}, now64(3), now64(3), 'MT', 1, 'Bank', {dest:String}, 'Your code 42', 0, 5, 0, 1, 1, 'UNDELIV')
          """,
          %{"id" => id, "dest" => @dest}
        )

      assert {:ok, result} =
               Inject.repush(%{
                 "request_id" => 77,
                 "vendor_trunk_id" => 2,
                 "edr_ids" => [id, other]
               })

      assert result == %{sent: 1, refused: 0, not_found: 1, reasons: []}
      assert_receive {:smsc, ^c2, %Pdu{command: :submit_sm} = sent}, 2_000
      assert sent.fields.short_message == "Your code 42" and sent.fields.source_addr == "Bank"
      refute_receive {:smsc, ^c1, %Pdu{command: :submit_sm}}, 200

      assert_eventually(fn -> match?([_], attempts()) end)

      assert [%{"repush_request_id" => 77, "v_trunk_id" => 2, "is_customer_billable" => 0}] =
               attempts()

      receipt(c2, "1", "DELIVRD")
      assert {:error, :timeout} = Client.recv(client, 500)
    after
      ClickHouse.query("ALTER TABLE edr DELETE WHERE c_trunk_id = 1 AND src_addr = 'Bank'", %{})
    end
  end
end
