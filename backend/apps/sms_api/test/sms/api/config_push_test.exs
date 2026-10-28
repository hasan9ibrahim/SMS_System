defmodule Sms.Api.ConfigPushTest do
  # A saved change reaches every server's switch at once (S-6.6, backend step 9): changes in a burst push once;
  # reads, the user's own settings and failed calls never push. The test runs its own instance, so changes saved by
  # other tests at the same time (through the application's instance) never reach it.
  use ExUnit.Case, async: true
  alias Sms.Api.ConfigPush

  def notify(pid), do: send(pid, :nudged)

  setup do
    name = :"config_push_#{System.unique_integer([:positive])}"

    start_supervised!(
      {ConfigPush, name: name, target: {__MODULE__, :notify}, args: [self()], delay_ms: 30}
    )

    %{server: name}
  end

  test "changes in a burst push once", %{server: server} do
    for _ <- 1..5, do: ConfigPush.after_call("PUT", "/api/v1/route-rules/7", 200, server)
    assert_receive :nudged, 1_000
    refute_receive :nudged, 200
  end

  test "reads, own settings and failed calls do not push", %{server: server} do
    ConfigPush.after_call("GET", "/api/v1/route-rules/7", 200, server)
    ConfigPush.after_call("POST", "/api/v1/route-rules/query", 200, server)
    ConfigPush.after_call("PATCH", "/api/v1/me/preferences", 200, server)
    ConfigPush.after_call("PUT", "/api/v1/views/3", 200, server)
    ConfigPush.after_call("PUT", "/api/v1/route-rules/7", 400, server)
    refute_receive :nudged, 200
  end
end
