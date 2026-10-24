defmodule Sms.Switch.Pipeline.MessageIdTest do
  # The message_id given to customers (S-2.5): unique, time-ordered, 20 lower-case hex characters.
  use ExUnit.Case, async: true
  alias Sms.Switch.Pipeline.MessageId

  test "ids are 20 lower-case hex characters, unique and in time order (S-2.5)" do
    before = System.os_time(:millisecond)
    ids = for _ <- 1..1_000, do: MessageId.new()

    assert Enum.all?(ids, &Regex.match?(~r/\A[0-9a-f]{20}\z/, &1))
    assert length(Enum.uniq(ids)) == 1_000
    assert Enum.sort(ids) == ids

    assert {:ok, %{ms: ms, node_id: 0}} = MessageId.decode(hd(ids))
    assert ms >= before and ms <= System.os_time(:millisecond)
  end

  test "setup is safe to run again: the counter keeps counting" do
    a = MessageId.new()
    assert MessageId.setup() == :ok
    assert MessageId.new() > a
  end

  test "anything that is not one of our ids does not decode" do
    assert MessageId.decode("not-an-id") == :error
    assert MessageId.decode(String.duplicate("z", 20)) == :error
    assert MessageId.decode(String.duplicate("A", 20)) == :error
    assert MessageId.decode("") == :error
  end
end
