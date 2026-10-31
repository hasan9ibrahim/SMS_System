defmodule Sms.Switch.Voice.CallsTest do
  # §8 SMS to voice (docs/SMS_TO_VOICE.md, S-6.9) through the whole switch on fake data: a customer submits, the
  # message becomes a call through a fake Asterisk (AMI), and the outcome comes back as a receipt, billing and EDRs.
  use Sms.Switch.Test.VendorCase, async: false
  @moduletag capture_log: true

  import ExUnit.CaptureLog
  alias Sms.Core.Bus
  alias Sms.Switch.Pipeline
  alias Sms.Switch.Pipeline.{Config, Store}
  alias Sms.Switch.Pipeline.Ledger.Sync
  alias Sms.Switch.Test.{Client, CustomerCase, FakeAmi, LedgerSource, PipelineConfig}
  alias Sms.Switch.Throttle
  alias Sms.Switch.Voice
  alias Sms.Switch.Voice.{Calls, Prompts}

  @dest "4915112345678"
  @code_text "Your code is 482913"
  @tmp "tmp/voice_calls_test"

  setup do
    start_supervised!(Sms.Core.Bus)
    start_supervised!(Pipeline.Store)
    start_supervised!(Pipeline.Delayed)
    start_supervised!(Pipeline.LiveTps)
    start_supervised!(Throttle)
    Voice.reset_warnings()

    dir = Path.expand(Path.join(@tmp, "#{System.unique_integer([:positive])}"))
    File.mkdir_p!(dir)
    sounds = Path.join(dir, "sounds")

    previous = Application.get_env(:sms_switch, Voice)
    Application.put_env(:sms_switch, Voice, ami_host: "127.0.0.1", sounds_dir: sounds)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:sms_switch, Voice, previous),
        else: Application.delete_env(:sms_switch, Voice)

      Voice.reset_warnings()
      File.rm_rf!(dir)
    end)

    ami = FakeAmi.start()
    on_exit(fn -> if Process.alive?(ami), do: FakeAmi.stop(ami) end)
    %{ami: ami, dir: dir, sounds: sounds}
  end

  # The configuration (by default rule 1 for receivers starting 4915 through gateway 1, retry at once), the receipt
  # path, voice (unless `voice: false`), the vendor leg when `sender: true`, and a bound customer.
  defp start_all(ctx, opts \\ []) do
    config =
      Keyword.merge(
        [
          voice_rules: [PipelineConfig.voice_rule(id: 1, prefix: "4915")],
          voice_gateways: [PipelineConfig.voice_gateway(id: 1, retry_delay_s: 0)]
        ],
        Keyword.get(opts, :config, [])
      )

    PipelineConfig.put(config)
    start_supervised!({Pipeline.Config.Server, loader: PipelineConfig})
    CustomerCase.assert_eventually(&Config.ready?/0)
    start_supervised!(Pipeline.Forwarder)
    start_supervised!({Pipeline.Held, sweep_ms: 60_000})
    start_supervised!(Pipeline.Held.OnBind)

    conn = if Keyword.get(opts, :sender, false), do: start_sender()

    if Keyword.get(opts, :voice, true) do
      start_supervised!(
        {Voice.Supervisor,
         ami: Keyword.get_lazy(opts, :ami, fn -> FakeAmi.client_opts(ctx.ami) end),
         files: [
           pjsip_file: Path.join(ctx.dir, "pjsip_sms_voice.conf"),
           sounds_dir: ctx.sounds,
           loader: PipelineConfig,
           sync_ms: 3_600_000
         ],
         calls: [retry_ms: 50, discover_ms: 100]}
      )
    end

    %{port: port} =
      CustomerCase.start_customer(trunks: [CustomerCase.trunk()], intake: Pipeline.Intake)

    {client, resp} =
      Client.bind(port, :bind_transceiver, %{system_id: "acme", password: "secret"})

    assert resp.status == 0
    %{client: client, conn: conn}
  end

  defp start_sender do
    start_supervised!(Pipeline.Sender)
    smsc = start_smsc()
    start_vendor([trunk(FakeSmsc.port(smsc), id: 1, name: "V1")], receipts: Pipeline.Receipts)
    await_bound(1, 1)
    [conn] = FakeSmsc.connections(smsc)
    conn
  end

  defp ledger(base) do
    LedgerSource.put([[enterprise_id: 11, prepaid: true, base: base]])
    start_supervised!({Sync, source: LedgerSource, interval_ms: 3_600_000})
    start_supervised!(Pipeline.Ledger.Charges)
    :ok = Sync.sync()
  end

  defp exposure(key) do
    {:ok, used} = Pipeline.Ledger.used(key)
    {used, Pipeline.Ledger.held(key)}
  end

  defp submit(client, fields, seq \\ 2) do
    fields =
      Map.merge(
        %{
          source_addr: "FakeBank",
          source_addr_ton: 5,
          destination_addr: @dest,
          dest_addr_ton: 1,
          dest_addr_npi: 1,
          short_message: @code_text,
          registered_delivery: 1
        },
        fields
      )

    Client.send_pdu(client, Pdu.new(:submit_sm, fields, sequence: seq))

    assert {client, %Pdu{command: :submit_sm_resp, sequence: ^seq} = resp} =
             Client.recv(client, 5_000)

    {client, resp}
  end

  defp receipt(client, timeout \\ 5_000) do
    assert {client, %Pdu{command: :deliver_sm} = pdu} = Client.recv(client, timeout)
    Client.send_pdu(client, Pdu.response(pdu, :esme_rok, %{message_id: ""}))
    {client, pdu}
  end

  defp rows, do: for(e <- Local.published(), e.type == "edr.attempt", do: e.data)

  defp voice_columns(row),
    do:
      Map.take(row, [
        "voice_gateway_id",
        "voice_answered",
        "voice_hangup_cause",
        "voice_duration_ms"
      ])

  describe "a matching message with a code is a call" do
    test "answered: a DELIVRD receipt, billed one unit at the customer's rate, a voice EDR row",
         ctx do
      ledger("1")
      %{client: client} = start_all(ctx)
      FakeAmi.calls(ctx.ami, [{:answer, 30, "16"}])

      {client, resp} = submit(client, %{})
      assert resp.status == 0
      id = resp.fields.message_id

      assert_receive {:ami, "originate", sent}, 3_000

      assert %{
               "actionid" => action_id,
               "channel" => "PJSIP/4915112345678@smsvoice-gw1",
               "context" => "sms-voice",
               "exten" => "s",
               "priority" => "1",
               # FakeBank is no number: the gateway's fixed caller ID.
               "callerid" => "4930000000",
               "timeout" => "30000",
               "async" => "true",
               "variable" => "CODE=482913,REPEAT=2,PROMPT="
             } = sent

      assert action_id == "#{id}:1"

      {_client, dlr} = receipt(client)
      assert dlr.fields.short_message =~ "id:#{id} sub:001 dlvrd:001"
      assert dlr.fields.short_message =~ "stat:DELIVRD err:000"

      assert_eventually(fn -> match?([_], rows()) end)
      [row] = rows()

      assert %{
               "c_message_id" => ^id,
               "route_type" => "voice",
               "v_trunk_id" => 0,
               "attempt_no" => 1,
               "is_final_attempt" => 1,
               "is_submit_success" => 1,
               "msg_status" => "DELIVRD",
               "c_msg_status" => "DELIVRD",
               "delivery_error" => "000",
               "msg_count" => 1,
               "is_customer_billable" => 1,
               "is_vendor_billable" => 0,
               "revenue" => "0.05",
               "cost" => "0",
               "cost_sys" => "0",
               "c_rate" => "0.05",
               "routed_dst_addr" => @dest,
               "v_src_addr" => "4930000000",
               "voice_gateway_id" => 1,
               "voice_answered" => 1,
               "voice_hangup_cause" => "NORMAL_CLEARING"
             } = row

      assert row["voice_duration_ms"] >= 20
      assert is_binary(row["delivery_time"])
      # The code read out is never in the call's columns.
      refute row |> voice_columns() |> inspect() =~ "482913"

      # Charged once, the charge replacing the credit held.
      assert_eventually(fn -> exposure("c11") == {50_000, 0} end)
    end

    test "a long message in two parts is one call, billed as one unit; a number sender is the caller ID",
         ctx do
      ledger("1")
      %{client: client} = start_all(ctx)

      fields = %{
        source_addr: "+4930123456",
        source_addr_ton: 1,
        destination_addr: @dest,
        dest_addr_ton: 1,
        dest_addr_npi: 1,
        short_message: ""
      }

      text = "Your code is 4711. " <> String.duplicate("x", 180)

      Client.send_pdu(
        client,
        Pdu.new(:submit_sm, fields, tlvs: [message_payload: text], sequence: 3)
      )

      assert {_client, %Pdu{command: :submit_sm_resp, status: 0}} = Client.recv(client, 5_000)

      assert_receive {:ami, "originate",
                      %{"callerid" => "+4930123456", "variable" => "CODE=4711" <> _}},
                     3_000

      assert_eventually(fn -> length(rows()) == 1 end, 3_000)
      assert [%{"msg_count" => 1, "revenue" => "0.05", "is_customer_billable" => 1}] = rows()
      assert_eventually(fn -> exposure("c11") == {50_000, 0} end)
    end
  end

  describe "not answered (§8: one retry, then UNDELIV 001, not charged)" do
    test "tried once more after the gateway's retry delay; still not answered: UNDELIV 001, credit released",
         ctx do
      ledger("1")

      %{client: client} =
        start_all(ctx,
          config: [voice_gateways: [PipelineConfig.voice_gateway(id: 1, retry_delay_s: 1)]]
        )

      FakeAmi.calls(ctx.ami, [{:fail, "3"}, {:fail, "5"}])
      {client, resp} = submit(client, %{})
      id = resp.fields.message_id

      assert_receive {:ami, "originate", %{"actionid" => first}}, 3_000
      first_at = System.monotonic_time(:millisecond)
      assert first == "#{id}:1"
      # Held for its retry meanwhile.
      assert_eventually(fn -> exposure("c11") == {0, 50_000} end)

      assert_receive {:ami, "originate", %{"actionid" => second}}, 5_000
      assert second == "#{id}:2"
      assert System.monotonic_time(:millisecond) - first_at >= 900

      {_client, dlr} = receipt(client)
      assert dlr.fields.short_message =~ "stat:UNDELIV err:001"

      assert_eventually(fn -> length(rows()) == 2 end)
      [one, two] = Enum.sort_by(rows(), & &1["attempt_no"])

      assert %{
               "attempt_no" => 1,
               "is_final_attempt" => 0,
               "msg_status" => "",
               "c_msg_status" => ""
             } = one

      assert %{
               "voice_answered" => 0,
               "voice_hangup_cause" => "NO_ANSWER",
               "voice_duration_ms" => 0
             } = one

      assert %{"is_customer_billable" => 0, "route_type" => "voice"} = one

      assert %{
               "attempt_no" => 2,
               "is_final_attempt" => 1,
               "msg_status" => "UNDELIV",
               "c_msg_status" => "UNDELIV"
             } =
               two

      assert %{
               "delivery_error" => "001",
               "voice_hangup_cause" => "USER_BUSY",
               "is_customer_billable" => 0
             } = two

      assert %{"revenue" => "0", "is_submit_success" => 0, "delivery_time" => nil} = two

      # Not charged; the credit hold released.
      assert_eventually(fn -> exposure("c11") == {0, 0} end)
    end

    test "not answered, then answered on the retry: DELIVRD and billed", ctx do
      ledger("1")
      %{client: client} = start_all(ctx)
      FakeAmi.calls(ctx.ami, [{:fail, "1"}, {:answer, 10, "16"}])

      {client, _resp} = submit(client, %{})
      {_client, dlr} = receipt(client)
      assert dlr.fields.short_message =~ "stat:DELIVRD"
      assert_eventually(fn -> length(rows()) == 2 end)

      assert Enum.map(Enum.sort_by(rows(), & &1["attempt_no"]), & &1["voice_hangup_cause"]) == [
               "CALL_REJECTED",
               "NORMAL_CLEARING"
             ]

      assert_eventually(fn -> exposure("c11") == {50_000, 0} end)
    end

    test "a gateway no longer active when its message comes up: UNDELIV at once, not called",
         ctx do
      port = FakeAmi.port(ctx.ami)
      FakeAmi.stop(ctx.ami)

      %{client: client} =
        start_all(ctx,
          ami: [host: "127.0.0.1", port: port, user: "x", secret: "y", backoff_ms: 50]
        )

      {client, _resp} = submit(client, %{})

      PipelineConfig.put(
        voice_rules: [PipelineConfig.voice_rule(id: 1, prefix: "4915")],
        voice_gateways: []
      )

      :ok = Config.Server.refresh()

      {_client, dlr} = receipt(client)
      assert dlr.fields.short_message =~ "stat:UNDELIV err:001"
      assert_eventually(fn -> match?([%{"voice_hangup_cause" => "GATEWAY_INACTIVE"}], rows()) end)
    end
  end

  describe "limits and waiting" do
    test "max_calls: no more calls at once than the gateway allows; the next goes as one ends",
         ctx do
      %{client: client} =
        start_all(ctx,
          config: [voice_gateways: [PipelineConfig.voice_gateway(id: 1, max_calls: 1)]]
        )

      FakeAmi.calls(ctx.ami, [{:answer, 400, "16"}])
      # No receipts asked: nothing for the client to answer meanwhile.
      {client, _} = submit(client, %{registered_delivery: 0}, 2)
      {_client, _} = submit(client, %{short_message: "Code 5566", registered_delivery: 0}, 3)

      assert_receive {:ami, "originate", %{"variable" => "CODE=482913" <> _}}, 3_000
      assert Throttle.leases(Calls.lease_key(1)) == 1
      refute_receive {:ami, "originate", _}, 250

      assert_receive {:ami, "originate", %{"variable" => "CODE=5566" <> _}}, 3_000
    end

    test "every line of the gateway busy on the other server: the call waits for one", ctx do
      %{client: client} =
        start_all(ctx,
          config: [voice_gateways: [PipelineConfig.voice_gateway(id: 1, max_calls: 1)]]
        )

      # The other server's call holds the gateway's only place.
      true = Throttle.lease_take(Calls.lease_key(1), "other-server-call", 1, 60_000)
      {_client, _} = submit(client, %{registered_delivery: 0})
      refute_receive {:ami, "originate", _}, 400

      :ok = Throttle.lease_release(Calls.lease_key(1), "other-server-call")
      assert_receive {:ami, "originate", _}, 3_000
    end

    test "a queue entry that cannot be read is logged and the drain carries on", ctx do
      %{client: client} = start_all(ctx)

      log =
        capture_log(fn ->
          {:ok, _} =
            Bus.put(Calls.queue(1), "voice.call", %{"id" => "bad", "m" => "not base64!"},
              id: "bad"
            )

          Calls.kick(Calls.queue(1))
          Process.sleep(300)
          {_client, _} = submit(client, %{registered_delivery: 0})
          assert_receive {:ami, "originate", _}, 3_000
        end)

      assert log =~ "call on vg.1 crashed"
    end

    test "Asterisk not connected: accepted and queued, called once it is back", ctx do
      port = FakeAmi.port(ctx.ami)
      FakeAmi.stop(ctx.ami)

      %{client: client} =
        start_all(ctx,
          ami: [
            host: "127.0.0.1",
            port: port,
            user: "fake-ami",
            secret: "fake-ami-secret",
            backoff_ms: 50
          ]
        )

      {client, resp} = submit(client, %{})
      assert resp.status == 0
      refute_receive {:ami, "originate", _}, 300

      ami = FakeAmi.start(port: port)
      on_exit(fn -> if Process.alive?(ami), do: FakeAmi.stop(ami) end)
      assert_receive {:ami, "originate", _}, 5_000
      {_client, dlr} = receipt(client)
      assert dlr.fields.short_message =~ "stat:DELIVRD"
    end

    test "a message whose validity period ends while it waits: EXPIRED, not called, not billed",
         ctx do
      ledger("1")
      port = FakeAmi.port(ctx.ami)
      FakeAmi.stop(ctx.ami)

      %{client: client} =
        start_all(ctx,
          ami: [
            host: "127.0.0.1",
            port: port,
            user: "fake-ami",
            secret: "fake-ami-secret",
            backoff_ms: 50
          ]
        )

      {client, _resp} = submit(client, %{validity_period: "000000000001000R"})
      assert exposure("c11") == {0, 50_000}
      Process.sleep(1_100)

      ami = FakeAmi.start(port: port)
      on_exit(fn -> if Process.alive?(ami), do: FakeAmi.stop(ami) end)
      {_client, dlr} = receipt(client)
      assert dlr.fields.short_message =~ "stat:EXPIRED"
      refute_received {:ami, "originate", _}

      assert_eventually(fn -> match?([_], rows()) end)

      assert [
               %{
                 "attempt_no" => 0,
                 "c_msg_status" => "EXPIRED",
                 "route_type" => "voice",
                 "voice_gateway_id" => 1
               }
             ] =
               rows()

      assert_eventually(fn -> exposure("c11") == {0, 0} end)
    end

    test "cancelled by the customer while queued: not called, DELETED, nothing billed", ctx do
      port = FakeAmi.port(ctx.ami)
      FakeAmi.stop(ctx.ami)

      %{client: client} =
        start_all(ctx,
          ami: [
            host: "127.0.0.1",
            port: port,
            user: "fake-ami",
            secret: "fake-ami-secret",
            backoff_ms: 50
          ]
        )

      {client, resp} = submit(client, %{})
      id = resp.fields.message_id

      Client.send_pdu(
        client,
        Pdu.new(:cancel_sm, %{message_id: id, source_addr: "FakeBank"}, sequence: 3)
      )

      assert {_client, %Pdu{command: :cancel_sm_resp, status: 0}} = Client.recv(client, 3_000)

      ami = FakeAmi.start(port: port)
      on_exit(fn -> if Process.alive?(ami), do: FakeAmi.stop(ami) end)
      assert_eventually(fn -> match?([%{"c_msg_status" => "DELETED"}], rows()) end, 5_000)
      refute_received {:ami, "originate", _}
    end
  end

  describe "what goes as an SMS" do
    test "voice off on this server: a matching message goes as an SMS, the warning logged once",
         ctx do
      Application.put_env(:sms_switch, Voice, ami_host: "")

      log =
        capture_log(fn ->
          %{client: client, conn: conn} = start_all(ctx, voice: false, sender: true)
          {client, %{status: 0}} = submit(client, %{}, 2)
          assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 3_000
          {_client, %{status: 0}} = submit(client, %{}, 3)
          assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 3_000
        end)

      assert length(String.split(log, "voice is off on this server")) == 2
      refute_received {:ami, _, _}
    end

    test "no code in the text, or no rule matching the receiver: a normal SMS", ctx do
      %{client: client, conn: conn} = start_all(ctx, sender: true)
      {client, %{status: 0}} = submit(client, %{short_message: "Hello, no code here"}, 2)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 3_000
      {_client, %{status: 0}} = submit(client, %{destination_addr: "4916000000001"}, 3)
      assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 3_000
      refute_receive {:ami, "originate", _}, 200
    end

    test "no active gateway: a matching message goes as an SMS, logged once", ctx do
      log =
        capture_log(fn ->
          %{client: client, conn: conn} =
            start_all(ctx, sender: true, config: [voice_gateways: []])

          {_client, %{status: 0}} = submit(client, %{}, 2)
          assert_receive {:smsc, ^conn, %Pdu{command: :submit_sm}}, 3_000
        end)

      assert log =~ "no voice gateway is active"
    end
  end

  describe "the call as placed" do
    test "the rule's own recording once its file is on this server; a rule's gateway and repeat",
         ctx do
      wav = "RIFF fake recording"
      sha = Base.encode16(:crypto.hash(:sha256, wav), case: :lower)

      %{client: client} =
        start_all(ctx,
          config: [
            voice_rules: [
              PipelineConfig.voice_rule(
                id: 1,
                prefix: "4915",
                gateway_id: 2,
                repeat_count: 4,
                prompt_wav_sha256: sha
              )
            ],
            voice_gateways: [
              PipelineConfig.voice_gateway(id: 1, priority: 1),
              PipelineConfig.voice_gateway(
                id: 2,
                priority: 9,
                dial_prefix: "77",
                caller_id_mode: "fixed"
              )
            ],
            prompt_wavs: %{sha => wav}
          ]
        )

      :ok = Voice.Files.sync()
      assert File.read!(Prompts.path(ctx.sounds, sha)) == wav

      {_client, _resp} = submit(client, %{source_addr: "4930999", source_addr_ton: 1})
      assert_receive {:ami, "originate", sent}, 3_000
      assert sent["channel"] == "PJSIP/774915112345678@smsvoice-gw2"
      assert sent["callerid"] == "4930000000"
      assert sent["variable"] == "CODE=482913,REPEAT=4,PROMPT=custom/sms-voice-rule-#{sha}"
    end

    test "a Delayed Submit trunk gets its resp once the call is queued; the outcome comes as a receipt",
         ctx do
      %{client: client} =
        start_all(ctx,
          config: [customer_trunks: [PipelineConfig.customer_trunk(delayed_submit: true)]]
        )

      FakeAmi.calls(ctx.ami, [{:answer, 300, "16"}])
      {client, resp} = submit(client, %{})
      assert resp.status == 0
      {_client, dlr} = receipt(client)
      assert dlr.fields.short_message =~ "stat:DELIVRD"
    end

    test "a scheduled message becomes a call at its time", ctx do
      %{client: client} = start_all(ctx, sender: true)
      before = System.os_time(:millisecond)

      {client, resp} = submit(client, %{schedule_delivery_time: "000000000500000R"})
      assert resp.status == 0
      refute_receive {:ami, "originate", _}, 200

      :ok = Pipeline.Scheduled.release_due(before + 5 * 60_000 + 1_000)
      assert_receive {:ami, "originate", %{"variable" => "CODE=482913" <> _}}, 3_000
      {_client, dlr} = receipt(client)
      assert dlr.fields.short_message =~ "stat:DELIVRD"
    end
  end

  describe "a queue entry" do
    defp data(msg, try),
      do: %{"id" => msg.id, "m" => Base.encode64(:erlang.term_to_binary({msg, try}))}

    test "handed out again never calls twice", ctx do
      start_all(ctx, voice: false)
      msg = build_msg()
      true = Store.claim_voice_call("#{msg.id}:2", 60)
      assert Calls.run(data(msg, 2)) == :ok
      refute_received {:ami, _, _}
      assert rows() == []
    end

    test "Asterisk gone before the call was placed: back on the queue, its claim given back",
         ctx do
      start_all(ctx, voice: false)
      msg = build_msg()

      assert Calls.run(data(msg, 2)) == :ok
      assert {:ok, event, handle} = Bus.take(Calls.queue(1))
      :ok = Bus.ack(handle)
      assert event.type == "voice.call"
      assert Store.claim_voice_call("#{msg.id}:2", 60)
      assert rows() == []
    end
  end

  # A message as the intake leaves it once it became a call.
  defp build_msg do
    %{
      id: "fakemsg#{System.unique_integer([:positive])}",
      received_at: System.os_time(:millisecond),
      trunk: PipelineConfig.customer_trunk(),
      voice: %{
        rule_id: 1,
        gateway_id: 1,
        code: "1234",
        repeat: 1,
        dial: @dest,
        caller_id: nil,
        prompt: nil
      }
    }
  end
end
