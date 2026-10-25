defmodule Sms.Switch.Pipeline.StarterTest do
  # The pipeline's consumers start only once the routing configuration is loaded (backend step 7).
  use ExUnit.Case, async: false
  alias Sms.Switch.Pipeline.Starter

  test "waits for the configuration, then starts the consumers; they stop with it" do
    ready = :counters.new(1, [])

    child = %{
      id: :consumer,
      start: {Agent, :start_link, [fn -> :running end, [name: :starter_test_consumer]]}
    }

    pid =
      start_supervised!(
        {Starter, children: [child], ready?: fn -> :counters.get(ready, 1) == 1 end}
      )

    Process.sleep(300)
    refute Starter.started?()
    refute Process.whereis(:starter_test_consumer)

    :counters.put(ready, 1, 1)
    Process.sleep(300)
    assert Starter.started?()
    consumer = Process.whereis(:starter_test_consumer)
    assert is_pid(consumer)

    ref = Process.monitor(consumer)
    :ok = stop_supervised(Starter)
    assert_receive {:DOWN, ^ref, :process, _, _}
    refute Process.alive?(pid)
  end

  test "the consumers' supervisor giving up stops the starter, so it is started again" do
    child = %{
      id: :consumer,
      start: {Agent, :start_link, [fn -> :running end, [name: :starter_test_consumer2]]}
    }

    pid = start_supervised!({Starter, children: [child], ready?: fn -> true end})
    Process.sleep(300)
    ref = Process.monitor(pid)
    sup = :sys.get_state(pid).sup
    Process.exit(sup, :kill)
    assert_receive {:DOWN, ^ref, :process, _, :killed}
  end
end
