defmodule Sms.Core.HealthTest do
  use ExUnit.Case, async: false
  alias Sms.Core.Health

  test "nothing to check is healthy" do
    assert Health.check([]) == %{overall: :ok, services: %{}}
    # The configured services by default; the test config checks none.
    assert Health.check() == %{overall: :ok, services: %{}}
  end

  test "a running bus is ok; a store that is not started is reported, not raised" do
    start_supervised!(Sms.Core.Bus)

    assert %{overall: :degraded, services: %{bus: :ok, redis: {:error, _}}} =
             Health.check([:bus, :redis])
  end
end
