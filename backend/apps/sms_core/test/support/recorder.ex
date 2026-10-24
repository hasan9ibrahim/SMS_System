defmodule Sms.Core.Test.Recorder do
  @moduledoc false
  # Shared by the test consumers: records every delivery, tells the test process, and fails, discards or raises
  # when the event's data asks for it ("fail_times", "discard", "raise").
  use Agent

  def start_link(test_pid),
    do: Agent.start_link(fn -> %{pid: test_pid, attempts: %{}} end, name: __MODULE__)

  def handle(consumer, event) do
    attempt =
      Agent.get_and_update(__MODULE__, fn s ->
        n = Map.get(s.attempts, {consumer, event.id}, 0) + 1
        {n, put_in(s.attempts[{consumer, event.id}], n)}
      end)

    send(Agent.get(__MODULE__, & &1.pid), {:delivered, consumer, event, attempt})

    cond do
      event.data["raise"] -> raise "planned failure"
      event.data["discard"] -> {:discard, :planned}
      attempt <= Map.get(event.data, "fail_times", 0) -> {:error, :planned}
      true -> :ok
    end
  end
end

defmodule Sms.Core.Test.AllConsumer do
  @moduledoc false
  use Sms.Core.Bus.Consumer, name: "test-all", filter: "sms.>", max_deliver: 3, ack_wait_ms: 1_000
  alias Sms.Core.Test.Recorder
  @impl true
  def handle_event(event), do: Recorder.handle(:all, event)
end

defmodule Sms.Core.Test.MsgConsumer do
  @moduledoc false
  use Sms.Core.Bus.Consumer,
    name: "test-msg",
    filter: "sms.msg.*",
    max_deliver: 3,
    ack_wait_ms: 1_000

  alias Sms.Core.Test.Recorder

  @impl true
  def handle_event(event), do: Recorder.handle(:msg, event)
end

defmodule Sms.Core.Test.BatchRecorder do
  @moduledoc false
  # Batch counterpart of Recorder: tells the test process about every batch it is handed, and fails the batch while
  # any of its events still asks for it ("fail_batch_times": fail that many batches holding the event).
  def handle(consumer, events) do
    attempt =
      Agent.get_and_update(Sms.Core.Test.Recorder, fn s ->
        n =
          events
          |> Enum.map(&(Map.get(s.attempts, {consumer, &1.id}, 0) + 1))
          |> Enum.max()

        attempts = Enum.reduce(events, s.attempts, &Map.put(&2, {consumer, &1.id}, n))
        {n, %{s | attempts: attempts}}
      end)

    send(Agent.get(Sms.Core.Test.Recorder, & &1.pid), {:batch, consumer, events, attempt})

    cond do
      Enum.any?(events, & &1.data["raise"]) ->
        raise "planned batch failure"

      Enum.any?(events, &(attempt <= Map.get(&1.data, "fail_batch_times", 0))) ->
        {:error, :planned}

      true ->
        :ok
    end
  end
end

defmodule Sms.Core.Test.BatchConsumer do
  @moduledoc false
  use Sms.Core.Bus.Consumer,
    name: "test-batch",
    filter: "sms.batch.>",
    batch_size: 3,
    batch_wait_ms: 300,
    max_deliver: 4,
    ack_wait_ms: 1_000

  alias Sms.Core.Test.BatchRecorder

  @impl true
  def handle_batch(events), do: BatchRecorder.handle(:batch, events)
end

defmodule Sms.Core.Test.ConcurrentConsumer do
  @moduledoc false
  # Each delivery says which worker handled it and sleeps "sleep_ms", so a test can see several handled at once.
  use Sms.Core.Bus.Consumer, name: "test-conc", filter: "sms.conc.>", concurrency: 4
  alias Sms.Core.Test.Recorder

  @impl true
  def handle_event(event) do
    send(Agent.get(Recorder, & &1.pid), {:started, event.id, self()})
    Process.sleep(Map.get(event.data, "sleep_ms", 0))
    Recorder.handle(:conc, event)
  end
end

defmodule Sms.Core.Test.ForeverConsumer do
  @moduledoc false
  use Sms.Core.Bus.Consumer, name: "test-forever", filter: "sms.forever.>", max_deliver: :infinity
  alias Sms.Core.Test.Recorder

  @impl true
  def handle_event(event), do: Recorder.handle(:forever, event)
end
