defmodule Sms.Api.SessionsTest do
  # How Logged In Users (§11) names a session's device, as the mock does.
  use ExUnit.Case, async: true
  alias Sms.Api.Sessions

  test "device, operating system and browser" do
    assert Sessions.device(
             "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari/604.1"
           ) ==
             %{device: "mobile", os: "iOS", browser: "Safari"}

    assert Sessions.device("Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36") ==
             %{device: "mobile", os: "Android", browser: "Chrome"}

    assert Sessions.device("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Firefox/131.0") ==
             %{device: "desktop", os: "macOS", browser: "Firefox"}

    assert Sessions.device("Mozilla/5.0 (X11; Linux x86_64) Edg/130.0") == %{
             device: "desktop",
             os: "Linux",
             browser: "Edge"
           }

    assert Sessions.device("curl/8.0") == %{device: "desktop", os: "Other", browser: "Other"}
  end

  test "no token: no session, and closing nothing is fine" do
    assert Sessions.lookup(nil) == nil
    assert Sessions.lookup("") == nil
    assert Sessions.close(nil) == :ok
    assert Sessions.max_age() == 24 * 3600
  end
end
