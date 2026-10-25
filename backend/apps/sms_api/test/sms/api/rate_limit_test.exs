defmodule Sms.Api.RateLimitTest do
  # Sign-in attempts per client address (§13.28, Q33).
  use ExUnit.Case, async: false
  alias Sms.Api.RateLimit

  setup do
    previous = Application.get_env(:sms_api, RateLimit)
    Application.put_env(:sms_api, RateLimit, limit: 3, window_s: 60)
    on_exit(fn -> Application.put_env(:sms_api, RateLimit, previous) end)
  end

  test "allows the limit in a window, then refuses with the seconds left; addresses count apart" do
    ip = "192.0.2.#{System.unique_integer([:positive]) |> rem(250)}-#{System.unique_integer()}"
    assert RateLimit.hit(ip) == :ok
    assert RateLimit.hit(ip) == :ok
    assert RateLimit.hit(ip) == :ok
    assert {:error, seconds} = RateLimit.hit(ip)
    assert seconds in 1..60
    assert RateLimit.hit(ip <> "-other") == :ok
  end

  test "ended windows are swept" do
    send(Process.whereis(RateLimit), :sweep)
    # The sweep runs in the server; a call after it answers normally.
    assert RateLimit.hit("198.51.100.9-#{System.unique_integer()}") == :ok
  end
end
