defmodule Sms.Core.BusTest do
  # The bus contract, on the in-memory adapter (the NATS adapter passes the same checks in nats_test.exs).
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog
  alias Sms.Core.Bus
  alias Sms.Core.Bus.{Consumer, Event, Local}
  alias Sms.Core.Test.{AllConsumer, BatchConsumer, ForeverConsumer, MsgConsumer, Recorder}

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

  test "a batch consumer gets each event in a batch; a failed batch comes back, then is given up after max_deliver" do
    start_supervised!(BatchConsumer)

    log =
      capture_log(fn ->
        {:ok, %Event{id: ok}} = Bus.publish("sms.batch.ok", "t", %{})
        assert_received {:batch, :batch, [%Event{id: ^ok}], 1}
        refute_received {:batch, :batch, _, 2}

        {:ok, %Event{id: twice}} = Bus.publish("sms.batch.retry", "t", %{"fail_batch_times" => 2})
        for n <- 1..3, do: assert_received({:batch, :batch, [%Event{id: ^twice}], ^n})
        refute_received {:batch, :batch, _, 4}

        {:ok, %Event{id: never}} =
          Bus.publish("sms.batch.never", "t", %{"fail_batch_times" => 99})

        for n <- 1..4, do: assert_received({:batch, :batch, [%Event{id: ^never}], ^n})
        refute_received {:batch, :batch, _, 5}

        {:ok, %Event{id: raised}} = Bus.publish("sms.batch.raise", "t", %{"raise" => true})
        for n <- 1..4, do: assert_received({:batch, :batch, [%Event{id: ^raised}], ^n})
      end)

    assert log =~ "batch failed on every delivery, given up"
    # Batch consumers never see handle_event; the event-by-event consumers still get the event.
    assert_received {:delivered, :all, _, 1}
  end

  test "a consumer with max_deliver :infinity keeps retrying past the default limit" do
    start_supervised!(ForeverConsumer)

    log =
      capture_log(fn ->
        {:ok, %Event{id: id}} = Bus.publish("sms.forever.a", "t", %{"fail_times" => 15})
        for n <- 1..16, do: assert_received({:delivered, :forever, %Event{id: ^id}, ^n})
        refute_received {:delivered, :forever, _, 17}

        # In memory the retries are bounded (25), so a broken handler cannot hang a test.
        {:ok, %Event{id: stuck}} = Bus.publish("sms.forever.b", "t", %{"fail_times" => 999})
        assert_received {:delivered, :forever, %Event{id: ^stuck}, 25}
        refute_received {:delivered, :forever, %Event{id: ^stuck}, 26}
      end)

    assert log =~ "given up"
    assert ForeverConsumer.consumer_options()[:max_deliver] == :infinity
  end

  test "consumer options get their defaults; bad numbers are refused" do
    assert Consumer.validate!(name: "ok", filter: "sms.>") == [
             name: "ok",
             filter: "sms.>",
             max_deliver: 10,
             ack_wait_ms: 30_000,
             concurrency: 1,
             batch_size: nil,
             batch_wait_ms: 200
           ]

    assert BatchConsumer.consumer_options()[:batch_size] == 3

    for {key, value} <- [max_deliver: 0, max_deliver: :forever, concurrency: 0, batch_size: -1] do
      assert_raise ArgumentError, ~r/#{key}/, fn ->
        Consumer.validate!([{key, value}, name: "ok", filter: "sms.>"])
      end
    end
  end

  test "a batch handler that raises or returns something odd fails the whole batch" do
    defmodule OddBatch do
      @moduledoc false
      def handle_batch([%Event{data: %{"raise" => true}} | _]), do: raise("boom")
      def handle_batch(_), do: :weird
    end

    assert Consumer.run_batch(OddBatch, [Event.new("sms.x", "t", %{})]) ==
             {:error, {:bad_return, :weird}}

    assert Consumer.run_batch(OddBatch, [Event.new("sms.x", "t", %{"raise" => true})]) ==
             {:error, {:raised, "boom"}}

    assert Consumer.given_up?(:infinity, 1_000_000) == false
    assert Consumer.given_up?(3, 2) == false
    assert Consumer.given_up?(3, 3) == true
  end

  test "reset forgets stored events, so the same id is stored and delivered again" do
    {:ok, _} = Bus.publish("sms.msg.r", "t", %{}, id: "again")
    assert :ok = Local.reset()
    assert Local.published() == []
    {:ok, _} = Bus.publish("sms.msg.r", "t", %{}, id: "again")
    assert [%Event{id: "again"}] = Local.published()
    assert_received {:delivered, :msg, %Event{id: "again"}, 1}
    assert_received {:delivered, :msg, %Event{id: "again"}, 2}
  end
end
