defmodule Sms.Switch.Voice.AmiClientTest do
  # §8 SMS to voice: the connection to the server's Asterisk against a fake AMI server (no Asterisk in CI): login,
  # reconnecting, calls followed by ActionID and Uniqueid, commands.
  use ExUnit.Case, async: false
  @moduletag capture_log: true

  import Sms.Switch.Test.CustomerCase, only: [assert_eventually: 1]
  alias Sms.Switch.Test.FakeAmi
  alias Sms.Switch.Voice.AmiClient

  setup do
    ami = FakeAmi.start()
    on_exit(fn -> if Process.alive?(ami), do: FakeAmi.stop(ami) end)
    %{ami: ami}
  end

  defp start_client(ami, opts \\ []) do
    start_supervised!({AmiClient, Keyword.merge(FakeAmi.client_opts(ami), opts)})
    assert_receive {:ami, "login", login}, 2_000
    assert_eventually(&AmiClient.ready?/0)
    login
  end

  defp call(fields \\ %{}) do
    Map.merge(
      %{
        action_id: "msg-1:1",
        channel: "PJSIP/4915112345678@smsvoice-gw1",
        caller_id: "4930000000",
        timeout_ms: 30_000,
        variables: [{"CODE", "482913"}, {"REPEAT", "2"}, {"PROMPT", ""}]
      },
      fields
    )
  end

  test "logs in with its user and secret, for call events only", %{ami: ami} do
    login = start_client(ami)
    assert %{"username" => "fake-ami", "secret" => "fake-ami-secret", "events" => "call"} = login
  end

  test "a greeting it does not know is logged; it logs in all the same" do
    ami = FakeAmi.start(banner: "Fake PBX manager 1.0")
    on_exit(fn -> if Process.alive?(ami), do: FakeAmi.stop(ami) end)

    log = ExUnit.CaptureLog.capture_log(fn -> start_client(ami) end)
    assert log =~ "AMI greeting not recognised"
  end

  test "stopping it says calls cannot be placed now", %{ami: ami} do
    start_client(ami)
    :ok = stop_supervised!(AmiClient)
    refute AmiClient.ready?()

    assert AmiClient.originate(%{action_id: "x:1", channel: "PJSIP/1@g", timeout_ms: 1}) ==
             {:error, :not_connected}
  end

  test "places a call as docs/SMS_TO_VOICE.md says and follows it to its hangup", %{ami: ami} do
    start_client(ami)
    FakeAmi.calls(ami, [{:answer, 80, "16"}])

    assert {:ok, result} = AmiClient.originate(call())
    assert_receive {:ami, "originate", sent}

    assert sent == %{
             "action" => "Originate",
             "actionid" => "msg-1:1",
             "channel" => "PJSIP/4915112345678@smsvoice-gw1",
             "context" => "sms-voice",
             "exten" => "s",
             "priority" => "1",
             "callerid" => "4930000000",
             "timeout" => "30000",
             "async" => "true",
             "variable" => "CODE=482913,REPEAT=2,PROMPT="
           }

    assert %{answered: true, cause: "NORMAL_CLEARING"} = result
    assert result.duration_ms >= 70
    assert result.answered_at >= result.placed_at
    assert result.ended_at >= result.answered_at
  end

  test "a call not answered, busy or refused ends with its cause; no caller ID is sent when there is none",
       %{ami: ami} do
    start_client(ami)
    FakeAmi.calls(ami, [{:fail, "3"}, {:fail, "5"}, :refuse])

    assert {:ok, %{answered: false, cause: "NO_ANSWER", duration_ms: 0, answered_at: nil}} =
             AmiClient.originate(call(%{caller_id: nil, variables: []}))

    assert_receive {:ami, "originate", sent}
    refute Map.has_key?(sent, "callerid")
    refute Map.has_key?(sent, "variable")

    assert {:ok, %{answered: false, cause: "USER_BUSY"}} =
             AmiClient.originate(call(%{action_id: "msg-2:1"}))

    assert {:ok, %{answered: false, cause: "FAILURE"}} =
             AmiClient.originate(call(%{action_id: "msg-3:1"}))
  end

  test "no answer from Asterisk within the ring timeout and a margin: not answered", %{ami: ami} do
    start_client(ami, response_timeout_ms: 50)
    FakeAmi.calls(ami, [:silent])

    assert {:ok, %{answered: false, cause: "NO_RESPONSE"}} =
             AmiClient.originate(call(%{timeout_ms: 50}))
  end

  test "an answered call followed no longer than the longest call: ended, cause unknown", %{
    ami: ami
  } do
    start_client(ami, max_call_ms: 60)
    FakeAmi.calls(ami, [{:answer, 5_000, "16"}])
    assert {:ok, %{answered: true, cause: "UNKNOWN"} = result} = AmiClient.originate(call())
    assert result.duration_ms >= 50
  end

  test "calls run side by side, each matched by its ActionID", %{ami: ami} do
    start_client(ami)
    FakeAmi.calls(ami, [{:answer, 150, "16"}, {:fail, "5"}])

    first = Task.async(fn -> AmiClient.originate(call(%{action_id: "a:1"})) end)
    assert_receive {:ami, "originate", %{"actionid" => "a:1"}}
    second = Task.async(fn -> AmiClient.originate(call(%{action_id: "b:1"})) end)

    assert {:ok, %{answered: false, cause: "USER_BUSY"}} = Task.await(second)
    assert {:ok, %{answered: true, cause: "NORMAL_CLEARING"}} = Task.await(first)
  end

  test "without Asterisk no call is placed; it connects again with a growing pause and calls go then",
       %{ami: ami} do
    port = FakeAmi.port(ami)
    FakeAmi.stop(ami)

    start_supervised!(
      {AmiClient,
       host: "127.0.0.1", port: port, user: "fake-ami", secret: "fake-ami-secret", backoff_ms: 20}
    )

    refute AmiClient.ready?()
    assert AmiClient.originate(call()) == {:error, :not_connected}
    assert AmiClient.command("core show version") == {:error, :not_connected}

    Process.sleep(100)
    ami = FakeAmi.start(port: port)
    on_exit(fn -> if Process.alive?(ami), do: FakeAmi.stop(ami) end)
    assert_receive {:ami, "login", _}, 3_000
    assert_eventually(&AmiClient.ready?/0)
    assert {:ok, %{answered: true}} = AmiClient.originate(call())
  end

  test "a refused login is not ready and is tried again", %{ami: ami} do
    start_supervised!({AmiClient, Keyword.merge(FakeAmi.client_opts(ami), secret: "fake-wrong")})
    assert_receive {:ami, "login", _}, 2_000
    assert_receive {:ami, "login", _}, 2_000
    refute AmiClient.ready?()
  end

  test "a connection lost mid-call: a call not answered yet counts as not answered, an answered one as ended",
       %{ami: ami} do
    start_client(ami)
    FakeAmi.calls(ami, [:silent, {:answer, 10_000, "16"}])

    waiting = Task.async(fn -> AmiClient.originate(call(%{action_id: "w:1"})) end)
    assert_receive {:ami, "originate", %{"actionid" => "w:1"}}
    talking = Task.async(fn -> AmiClient.originate(call(%{action_id: "t:1"})) end)
    assert_receive {:ami, "originate", %{"actionid" => "t:1"}}
    Process.sleep(50)

    :ok = FakeAmi.drop(ami)
    assert {:ok, %{answered: false, cause: "AMI_DISCONNECTED"}} = Task.await(waiting)
    assert {:ok, %{answered: true, cause: "UNKNOWN"}} = Task.await(talking)

    # And it is back.
    assert_receive {:ami, "login", _}, 3_000
    assert_eventually(&AmiClient.ready?/0)
  end

  test "commands: the output, or the error", %{ami: ami} do
    start_client(ami)

    assert {:ok, "Module 'res_pjsip.so' reloaded successfully."} =
             AmiClient.command("module reload res_pjsip.so")

    assert_receive {:ami, "command", %{"command" => "module reload res_pjsip.so"}}

    FakeAmi.set(ami, :command, {:error, "Fake permission denied"})
    assert AmiClient.command("module reload res_pjsip.so") == {:error, "Fake permission denied"}
  end

  test "a command not answered in time times out, the connection stays", %{ami: ami} do
    start_client(ami, response_timeout_ms: 50, ping_ms: 60_000)
    FakeAmi.set(ami, :command, :silent)
    assert AmiClient.command("core show version") == {:error, :timeout}
    assert AmiClient.ready?()
  end

  test "a command whose connection drops before its answer is told so", %{ami: ami} do
    start_client(ami, ping_ms: 60_000)
    FakeAmi.set(ami, :command, :silent)
    task = Task.async(fn -> AmiClient.command("core show version") end)
    assert_receive {:ami, "command", _}
    :ok = FakeAmi.drop(ami)
    assert Task.await(task) == {:error, :not_connected}
  end

  test "pings keep the connection checked; one not answered reconnects", %{ami: ami} do
    start_client(ami, ping_ms: 30, response_timeout_ms: 50)
    assert_receive {:ami, "ping", _}, 1_000
    assert_receive {:ami, "ping", _}, 1_000

    FakeAmi.set(ami, :ping, :silent)
    assert_receive {:ami, "login", _}, 2_000
  end
end
