defmodule Sms.Switch.ThrottleTest do
  # The overflow buffer count in memory (S-2.4); on Redis in customer/integration_test.exs.
  use ExUnit.Case, async: false
  alias Sms.Switch.Throttle

  setup do
    start_supervised!(Throttle)
    %{key: "ct:#{System.unique_integer([:positive])}"}
  end

  test "places are taken up to the buffer size and given back", %{key: key} do
    assert Enum.map(1..3, fn _ -> Throttle.buffer_take(key, 2) end) == [true, true, false]
    assert :ok = Throttle.buffer_release(key)
    assert Throttle.buffer_take(key, 2)
    refute Throttle.buffer_take(key, 2)
  end

  test "no buffer: never a place", %{key: key} do
    refute Throttle.buffer_take(key, 0)
  end

  test "giving back more than was taken never makes room beyond the size", %{key: key} do
    for _ <- 1..3, do: Throttle.buffer_release(key)
    assert Enum.map(1..3, fn _ -> Throttle.buffer_take(key, 2) end) == [true, true, false]
  end
end
