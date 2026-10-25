defmodule Sms.Api.ConfigPushTest do
  # A saved change reaches every server's switch at once (S-6.6, backend step 9): changes in a burst push once;
  # reads, the user's own settings and failed calls never push.
  use ExUnit.Case, async: false
  alias Sms.Api.ConfigPush

  def notify, do: send(:config_push_test, :nudged)

  setup do
    Process.register(self(), :config_push_test)
    previous = Application.get_env(:sms_api, ConfigPush)
    Application.put_env(:sms_api, ConfigPush, target: {__MODULE__, :notify}, delay_ms: 30)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:sms_api, ConfigPush, previous),
        else: Application.delete_env(:sms_api, ConfigPush)
    end)
  end

  test "changes in a burst push once" do
    for _ <- 1..5, do: ConfigPush.after_call("PUT", "/api/v1/route-rules/7", 200)
    assert_receive :nudged, 1_000
    refute_receive :nudged, 200
  end

  test "reads, own settings and failed calls do not push" do
    ConfigPush.after_call("GET", "/api/v1/route-rules/7", 200)
    ConfigPush.after_call("POST", "/api/v1/route-rules/query", 200)
    ConfigPush.after_call("PATCH", "/api/v1/me/preferences", 200)
    ConfigPush.after_call("PUT", "/api/v1/views/3", 200)
    ConfigPush.after_call("PUT", "/api/v1/route-rules/7", 400)
    refute_receive :nudged, 200
  end
end
