defmodule Sms.Core.Bus.EventTest do
  use ExUnit.Case, async: true
  use ExUnitProperties
  alias Sms.Core.Bus.Event

  property "encode then decode gives the same event" do
    check all(
            type <- StreamData.string(:alphanumeric, min_length: 1),
            version <- StreamData.positive_integer(),
            data <-
              StreamData.map_of(
                StreamData.string(:alphanumeric),
                StreamData.one_of([
                  StreamData.integer(),
                  StreamData.string(:printable),
                  StreamData.boolean()
                ])
              )
          ) do
      event = Event.new("sms.test.x", type, data, version: version)
      assert {:ok, decoded} = Event.decode(Event.encode(event))
      assert decoded == event
    end
  end

  property "any binary decodes to an event or an error, never a crash" do
    check all(bin <- StreamData.binary()) do
      assert match?({:ok, %Event{}}, Event.decode(bin)) or match?({:error, _}, Event.decode(bin))
    end
  end

  test "malformed envelopes are named" do
    good = Jason.decode!(Event.encode(Event.new("sms.a", "t", %{})))
    assert Event.decode("[1]") == {:error, :not_an_object}
    assert Event.decode("{") == {:error, :invalid_json}
    assert Event.decode(Jason.encode!(Map.delete(good, "id"))) == {:error, {:invalid_field, "id"}}

    assert Event.decode(Jason.encode!(%{good | "version" => 0})) ==
             {:error, {:invalid_field, "version"}}

    assert Event.decode(Jason.encode!(%{good | "data" => [1]})) ==
             {:error, {:invalid_field, "data"}}

    assert {:error, _} = Event.decode(Jason.encode!(%{good | "occurred_at" => "yesterday"}))
  end
end
