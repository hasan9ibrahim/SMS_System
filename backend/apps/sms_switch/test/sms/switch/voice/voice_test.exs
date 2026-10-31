defmodule Sms.Switch.VoiceTest do
  # §8 SMS to voice: whether a message becomes a call on this server, and the retries held in the shared store.
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog
  import Sms.Switch.Test.CustomerCase, only: [assert_eventually: 1]
  alias Sms.Switch.Pipeline.{Config, Store}
  alias Sms.Switch.Test.PipelineConfig
  alias Sms.Switch.Voice
  alias Sms.Switch.Voice.Calls

  setup do
    previous = Application.get_env(:sms_switch, Voice)
    Voice.reset_warnings()

    on_exit(fn ->
      if previous,
        do: Application.put_env(:sms_switch, Voice, previous),
        else: Application.delete_env(:sms_switch, Voice)

      Voice.reset_warnings()
    end)

    PipelineConfig.put(
      voice_rules: [PipelineConfig.voice_rule(id: 1, prefix: "4915")],
      voice_gateways: [PipelineConfig.voice_gateway(id: 1)]
    )

    start_supervised!({Config.Server, loader: PipelineConfig})
    assert_eventually(&Config.ready?/0)
    :ok
  end

  defp msg(fields \\ %{}) do
    Map.merge(
      %{
        id: "m1",
        ingress: %{sender: "FakeBank", route_receiver: "4915112345678", text: "Code 123456"},
        destination: %{mccmnc: "26201"}
      },
      fields
    )
  end

  test "on where an Asterisk host is set; its sounds directory, Asterisk's default otherwise" do
    Application.put_env(:sms_switch, Voice, ami_host: "")
    refute Voice.enabled?()
    assert Voice.sounds_dir() == "/usr/share/asterisk/sounds"

    Application.put_env(:sms_switch, Voice, ami_host: "127.0.0.1", sounds_dir: "/srv/fake/sounds")
    assert Voice.enabled?()
    assert Voice.sounds_dir() == "/srv/fake/sounds"
  end

  test "a matching message is a call; a Test SMS or Repush never is" do
    Application.put_env(:sms_switch, Voice, ami_host: "127.0.0.1")
    assert {:call, %{code: "123456", gateway_id: 1, dial: "4915112345678"}} = Voice.plan(msg())
    assert Voice.plan(msg(%{internal: %{kind: "test"}})) == :sms

    assert Voice.plan(
             msg(%{ingress: %{sender: "x", route_receiver: "4916000", text: "Code 1234"}})
           ) == :sms
  end

  test "voice off: an SMS, the warning logged once per server" do
    Application.put_env(:sms_switch, Voice, ami_host: nil)

    log =
      capture_log(fn ->
        assert Voice.plan(msg()) == :sms
        assert Voice.plan(msg(%{id: "m2"})) == :sms
      end)

    assert log =~ "message m1 matches SMS-to-voice rule 1 but voice is off on this server"
    refute log =~ "message m2"
  end

  test "no rule: every message goes as an SMS" do
    Application.put_env(:sms_switch, Voice, ami_host: "127.0.0.1")
    PipelineConfig.put(voice_rules: [], voice_gateways: [PipelineConfig.voice_gateway(id: 1)])
    :ok = Config.Server.refresh()
    assert Voice.plan(msg()) == :sms
  end

  test "as a call: one unit, the call kept with it" do
    call = %{rule_id: 1}
    assert %{parts: 1, voice: ^call} = Voice.as_call(%{parts: 3}, call)
  end

  describe "retries in the shared store (local backend)" do
    setup do
      start_supervised!(Store)
      :ok
    end

    test "held until due, taken by one server (leased), read, then forgotten" do
      now = System.os_time(:millisecond)
      :ok = Store.hold_voice_retry("r1", "blob-1", now + 60_000, 60)
      :ok = Store.hold_voice_retry("r2", "blob-2", now - 1, 60)

      assert Store.due_voice_retries(:waiting, now, 10) == {:ok, ["r2"]}
      assert Store.claim_voice_retry(:waiting, "r2", now, now + 1_000)
      refute Store.claim_voice_retry(:waiting, "r2", now, now + 1_000)
      assert Store.voice_retry("r2") == {:ok, "blob-2"}

      # Its lease ran out (the server moving it stopped): due again from the leased set.
      assert Store.due_voice_retries(:leased, now + 2_000, 10) == {:ok, ["r2"]}
      assert Store.claim_voice_retry(:leased, "r2", now + 2_000, now + 3_000)

      :ok = Store.finish_voice_retry("r2")
      assert Store.voice_retry("r2") == {:ok, nil}
      assert Store.due_voice_retries(:leased, now + 10_000, 10) == {:ok, []}
    end

    test "a due retry whose data is gone is forgotten" do
      now = System.os_time(:millisecond)
      :ok = Store.hold_voice_retry("gone", "blob", now - 1, 60)
      {:ok, 1} = Store.command(["DEL", "vr:gone"])
      :ok = Calls.release_retries()
      assert Store.due_voice_retries(:waiting, now + 120_000, 10) == {:ok, []}
      assert Store.due_voice_retries(:leased, now + 120_000, 10) == {:ok, []}
    end

    test "a call try is claimed once; a claim given back can be taken again" do
      assert Store.claim_voice_call("m1:1", 60)
      refute Store.claim_voice_call("m1:1", 60)
      :ok = Store.unclaim_voice_call("m1:1")
      assert Store.claim_voice_call("m1:1", 60)
    end
  end
end
