defmodule Sms.Core.StoresTest do
  # Store helpers when the store is not running: errors, never crashes.
  use ExUnit.Case, async: false
  alias Sms.Core.{Health, Redis}

  test "redis commands without a connection are errors" do
    assert {:error, {:not_connected, _}} = Redis.command(["PING"])
    assert {:error, {:not_connected, _}} = Redis.transaction([["PING"]])
  end

  test "health reports stores that are not started instead of raising" do
    assert %{overall: :degraded, services: services} = Health.check([:repo, :clickhouse])
    assert {:error, _} = services.repo
    assert {:error, _} = services.clickhouse
  end
end
