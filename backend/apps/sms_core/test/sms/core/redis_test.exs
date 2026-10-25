defmodule Sms.Core.RedisTest do
  # Where the connections go: one host, or the primary the sentinels name (backend step 8).
  use ExUnit.Case, async: true
  alias Sms.Core.Redis

  test "without sentinels: the host and port" do
    assert Redis.target(host: "h", port: 6380, sentinels: []) == [host: "h", port: 6380]
    assert Redis.target(host: "h", port: 6380) == [host: "h", port: 6380]
  end

  test "with sentinels: the group's primary, with the sentinels' password when set" do
    sentinels = [[host: "a", port: 26_379], [host: "b", port: 26_379]]

    assert Redis.target(host: "h", port: 1, sentinels: sentinels) ==
             [sentinel: [sentinels: sentinels, group: "sms"]]

    assert Redis.target(sentinels: sentinels, sentinel_group: "g", sentinel_password: "pw") ==
             [sentinel: [sentinels: sentinels, group: "g", password: "pw"]]
  end
end
