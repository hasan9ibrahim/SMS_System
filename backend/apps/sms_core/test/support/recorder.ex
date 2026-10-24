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
