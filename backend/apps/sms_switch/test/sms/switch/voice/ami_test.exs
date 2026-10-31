defmodule Sms.Switch.Voice.AmiTest do
  # §8 SMS to voice: Asterisk's manager interface wire format, as the client sends and reads it.
  use ExUnit.Case, async: true
  alias Sms.Switch.Voice.Ami

  test "an action is Key: Value lines closed by an empty line; a value never spans lines" do
    frame =
      [{"Action", "Originate"}, {"Timeout", 30_000}, {"CallerID", "49301\r\nAction: Command"}]
      |> Ami.encode()
      |> IO.iodata_to_binary()

    assert frame ==
             "Action: Originate\r\nTimeout: 30000\r\nCallerID: 49301Action: Command\r\n\r\n"
  end

  test "the greeting is one line, read once it has fully arrived" do
    assert Ami.banner("Asterisk Call") == :more

    assert Ami.banner("Asterisk Call Manager/9.0.0\r\nResponse: Su") ==
             {:ok, "Asterisk Call Manager/9.0.0", "Response: Su"}
  end

  test "messages are split at empty lines, keys read in lower case, the rest kept for the next read" do
    buffer =
      "Response: Success\r\nActionID: login\r\nMessage: Authentication accepted\r\n\r\n" <>
        "Event: Hangup\r\nUniqueid: 1.2\r\nCause-txt: Normal Clearing\r\nEmpty:\r\n\r\nEvent: Orig"

    assert {[login, hangup], "Event: Orig"} = Ami.decode(buffer)

    assert login == %{
             "response" => "Success",
             "actionid" => "login",
             "message" => "Authentication accepted"
           }

    assert hangup == %{
             "event" => "Hangup",
             "uniqueid" => "1.2",
             "cause-txt" => "Normal Clearing",
             "empty" => ""
           }

    assert Ami.decode("") == {[], ""}
  end

  test "a key given twice keeps every line; a line that is not a field is skipped" do
    buffer =
      "Response: Follows\r\nOutput: line 1\r\nOutput: line 2\r\nraw text\r\n--END COMMAND--\r\n\r\n"

    assert {[f], ""} = Ami.decode(buffer)
    assert f == %{"response" => "Follows", "output" => "line 1\nline 2"}
  end

  test "why a call was not answered, from OriginateResponse's Reason" do
    assert Ami.reason_cause("0") == "FAILURE"
    assert Ami.reason_cause("1") == "CALL_REJECTED"
    assert Ami.reason_cause("3") == "NO_ANSWER"
    assert Ami.reason_cause("5") == "USER_BUSY"
    assert Ami.reason_cause("8") == "CONGESTION"
    assert Ami.reason_cause("7") == "UNKNOWN"
    assert Ami.reason_cause(nil) == "UNKNOWN"
  end

  test "a call's end by its Q.850 cause as Asterisk names it, else its text" do
    assert Ami.hangup_cause(%{"cause" => "16", "cause-txt" => "Normal Clearing"}) ==
             "NORMAL_CLEARING"

    assert Ami.hangup_cause(%{"cause" => "17"}) == "USER_BUSY"
    assert Ami.hangup_cause(%{"cause" => "19"}) == "NO_ANSWER"

    assert Ami.hangup_cause(%{"cause" => "99", "cause-txt" => "Fake odd end-point"}) ==
             "FAKE_ODD_END_POINT"

    assert Ami.hangup_cause(%{"cause" => "99", "cause-txt" => " "}) == "UNKNOWN"
    assert Ami.hangup_cause(%{}) == "UNKNOWN"
  end
end
