defmodule Sms.Core.BusTest do
  # The bus contract, on the in-memory adapter (the NATS adapter passes the same checks in nats_test.exs).
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog
  alias Sms.Core.Bus
  alias Sms.Core.Bus.{Consumer, Event, Local}
  alias Sms.Core.Test.{AllConsumer, MsgConsumer, Recorder}

  setup do
    start_supervised!(Bus)
    start_supervised!({Recorder, self()})
    start_supervised!(AllConsumer)
    start_supervised!(MsgConsumer)
    :ok
  end

  test "publish validates the subject, the type and the data" do
    assert Bus.publish("other.x", "t", %{}) == {:error, {:invalid_subject, "other.x"}}
    assert Bus.publish("sms.x", "", %{}) == {:error, {:invalid_type, ""}}
    assert Bus.publish("sms.x", "t", [1]) == {:error, :data_must_be_a_map}

    capture_log(fn ->
      assert {:error, {:not_encodable, _}} = Bus.publish("sms.x", "t", %{"pid" => self()})
    end)

    assert Local.published() == []
  end

  test "a published event reaches every consumer whose filter matches, once" do
    assert {:ok, %Event{id: id} = event} =
             Bus.publish("sms.msg.accepted", "msg.accepted", %{"n" => 1})

    assert event.version == 1
    assert_received {:delivered, :all, %Event{id: ^id, data: %{"n" => 1}}, 1}
    assert_received {:delivered, :msg, %Event{id: ^id}, 1}

    assert {:ok, %Event{id: id2}} = Bus.publish("sms.rate.changed", "rate.changed", %{})
    assert_received {:delivered, :all, %Event{id: ^id2}, 1}
    refute_received {:delivered, :msg, %Event{id: ^id2}, _}
  end

  test "publishing the same id again stores and delivers it once" do
    {:ok, e} = Bus.publish("sms.msg.accepted", "msg.accepted", %{}, id: "fixed-id")
    assert {:ok, _} = Bus.publish("sms.msg.accepted", "msg.accepted", %{}, id: "fixed-id")
    assert [%Event{id: "fixed-id"}] = Local.published()
    assert_received {:delivered, :all, ^e, 1}
    refute_received {:delivered, :all, _, _}
  end

  test "a failed delivery is retried up to max_deliver; a discard is not" do
    capture_log(fn ->
      {:ok, _} = Bus.publish("sms.msg.a", "t", %{"fail_times" => 2})
      for n <- 1..3, do: assert_received({:delivered, :msg, _, ^n})
      refute_received {:delivered, :msg, _, 4}

      {:ok, _} = Bus.publish("sms.msg.b", "t", %{"fail_times" => 9})
      for n <- 1..3, do: assert_received({:delivered, :msg, _, ^n})
      refute_received {:delivered, :msg, _, 4}

      {:ok, _} = Bus.publish("sms.msg.c", "t", %{"discard" => true})
      assert_received {:delivered, :msg, _, 1}
      refute_received {:delivered, :msg, _, 2}

      {:ok, _} = Bus.publish("sms.msg.d", "t", %{"raise" => true})
      for n <- 1..3, do: assert_received({:delivered, :msg, _, ^n})
    end)
  end

  test "a stopped consumer gets nothing more" do
    :ok = stop_supervised(MsgConsumer)
    {:ok, _} = Bus.publish("sms.msg.x", "t", %{})
    assert_received {:delivered, :all, _, 1}
    refute_received {:delivered, :msg, _, _}
  end

  test "the bus reports healthy, and an error once it is down" do
    assert Bus.health() == :ok
    :ok = stop_supervised(Bus)
    assert Bus.health() == {:error, :not_running}

    assert capture_log(fn ->
             assert Bus.publish("sms.x", "t", %{}) == {:error, :not_connected}
           end) =~ "not published"
  end

  test "consumer options are checked when the module compiles" do
    assert_raise ArgumentError, ~r/name/, fn ->
      Consumer.validate!(name: "Bad Name", filter: "sms.>")
    end

    assert_raise ArgumentError, ~r/filter/, fn ->
      Consumer.validate!(name: "ok", filter: "other.>")
    end

    assert AllConsumer.consumer_options()[:max_deliver] == 3
  end

  test "a bad handler return counts as an error" do
    defmodule Odd do
      @moduledoc false
      def handle_event(_), do: :weird
    end

    assert Consumer.run(Odd, Event.new("sms.x", "t", %{})) ==
             {:error, {:bad_return, :weird}}
  end
end
