defmodule Sms.Switch.Pipeline.ScheduledTest do
  # S-2.12, S-2.4: scheduled messages are released at their customer trunk's TPS, as the session holds live traffic to
  # it: within it at once, over it into the trunk's overflow buffer while that has room, else held for a later sweep.
  # Never lost, never sent twice, roughly in their order (fake messages; the whole path is in pipeline_test.exs).
  use ExUnit.Case, async: false
  @moduletag capture_log: true

  alias Sms.Core.Bus.Local
  alias Sms.Switch.Customer.TrunkStore
  alias Sms.Switch.Pipeline.{Buffers, Intake, MessageId, Scheduled, Store}
  alias Sms.Switch.Test.CustomerCase
  alias Sms.Switch.Throttle

  @ent 11

  setup do
    start_supervised!(Sms.Core.Bus)
    start_supervised!(Store)
    start_supervised!(Throttle)
    :ok
  end

  # The customer trunks as the customer side loads them (one connection, so the trunk's TPS is `tps`).
  defp trunks(fields_list) do
    trunks =
      for fields <- fields_list do
        id = Keyword.fetch!(fields, :id)
        CustomerCase.trunk(Keyword.merge([username: "fake#{id}", max_connections: 1], fields))
      end

    start_supervised!({TrunkStore, loader: fn -> {:ok, trunks} end, refresh_ms: 3_600_000})
    CustomerCase.assert_eventually(&TrunkStore.ready?/0)
  end

  # `n` messages of a trunk held for `at` (one ms apart, so their order is known); their ids in that order.
  defp hold(trunk_id, n, at) do
    for i <- 1..n do
      id = MessageId.new()

      :ok =
        Scheduled.hold(%{
          id: id,
          trunk: %{id: trunk_id, enterprise_id: @ent},
          scheduled_at: at + i,
          scheduled: true,
          buffered: false,
          text: "fake scheduled #{i}"
        })

      id
    end
  end

  # Handed to the sender (at once, or by a buffer's drain), in that order.
  defp released, do: for(e <- Local.published(), e.type == "msg.accepted", do: e.data["id"])
  # Put in a customer trunk's overflow buffer.
  defp buffered, do: for(e <- Local.published(), e.type == "msg.buffered", do: e)

  # Just after a second starts, so a sweep counts in one TPS second.
  defp second_start, do: Process.sleep(1_000 - rem(System.os_time(:millisecond), 1_000) + 5)

  # Since the start of second `s0`, at most `tps` a second were handed to the sender (counted before the clock is read,
  # so a message counted in a second is never seen in an earlier one).
  defp assert_tps(s0, tps) do
    n = length(released())
    assert n <= tps * (System.os_time(:second) - s0 + 1)
    n
  end

  defp now, do: System.os_time(:millisecond)

  test "a burst for a trunk without a buffer goes at its TPS: the rest is held and goes on later sweeps, in order, once each" do
    trunks([[id: 1, tps: 5]])
    ids = hold(1, 12, now() - 60_000)

    second_start()
    :ok = Scheduled.release_due()
    assert released() == Enum.take(ids, 5)
    # Again in the same second: the trunk's TPS is used up.
    :ok = Scheduled.release_due()
    assert released() == Enum.take(ids, 5)
    # The others are still held: query_sm answers ENROUTE, cancel_sm could take them out.
    assert Enum.all?(Enum.drop(ids, 5), &(Scheduled.held?(@ent, &1) == {:ok, true}))
    assert {:ok, [1]} = Store.waiting_trunks()

    second_start()
    :ok = Scheduled.release_due()
    assert released() == Enum.take(ids, 10)

    second_start()
    :ok = Scheduled.release_due()
    assert released() == ids

    # Nothing left anywhere, nothing sent twice.
    second_start()
    :ok = Scheduled.release_due()
    assert released() == ids
    assert {:ok, []} = Store.waiting_trunks()
    assert {:ok, []} = Store.due_scheduled(:leased, now() + 3_600_000, 1_000)
    assert Enum.all?(ids, &(Scheduled.held?(@ent, &1) == {:ok, false}))
    assert Enum.all?(ids, &(Store.queued(@ent, &1) == {:ok, :queued}))
  end

  test "over the TPS into the trunk's overflow buffer while it has room; the rest waits for room; all go at the TPS" do
    start_supervised!({Buffers, discover_ms: 3_600_000})
    trunks([[id: 1, tps: 2, overflow_buffer: 3]])
    ids = hold(1, 10, now() - 60_000)

    second_start()
    s0 = System.os_time(:second)
    :ok = Scheduled.release_due()
    assert Enum.take(released(), 2) == Enum.take(ids, 2)

    # Each holds a place in the buffer, as a live message over the TPS does, and waits there for the TPS.
    in_buffer = buffered()
    assert Enum.map(in_buffer, & &1.data["id"]) == Enum.slice(ids, 2, 3)

    for e <- in_buffer,
        do:
          assert(%{release: true, buffered: true, tps_counters: [_ | _]} = Intake.decode(e.data))

    refute Throttle.buffer_take("ct:1", 3)
    assert {:ok, [1]} = Store.waiting_trunks()

    # Sweeps once a second, the buffer's drain meanwhile: never over the TPS, each message once.
    Enum.reduce_while(1..10, nil, fn _, _ ->
      second_start()
      :ok = Scheduled.release_due()
      if assert_tps(s0, 2) == 10, do: {:halt, nil}, else: {:cont, nil}
    end)

    assert Enum.sort(released()) == Enum.sort(ids)
    assert length(released()) == 10
    assert {:ok, []} = Store.waiting_trunks()
  end

  test "a trunk's newly due message waits behind its held ones; another trunk is not held back" do
    trunks([[id: 1, tps: 1], [id: 2, tps: 1]])
    t0 = now()
    first = hold(1, 3, t0 - 60_000)

    second_start()
    :ok = Scheduled.release_due(t0)
    assert released() == Enum.take(first, 1)

    [later] = hold(1, 1, t0 + 10_000)
    [other] = hold(2, 1, t0 + 10_000)

    second_start()
    :ok = Scheduled.release_due(t0 + 20_000)
    assert released() == Enum.take(first, 2) ++ [other]

    second_start()
    :ok = Scheduled.release_due(t0 + 20_000)
    assert released() == Enum.take(first, 2) ++ [other, Enum.at(first, 2)]

    second_start()
    :ok = Scheduled.release_due(t0 + 20_000)
    assert released() == Enum.take(first, 2) ++ [other, Enum.at(first, 2), later]
  end

  test "two sweeps at once (both servers): the TPS is shared and no message goes twice" do
    trunks([[id: 1, tps: 5]])
    ids = hold(1, 15, now() - 60_000)

    for k <- 1..3 do
      second_start()

      [fn -> Scheduled.release_due() end, fn -> Scheduled.release_due() end]
      |> Enum.map(&Task.async/1)
      |> Task.await_many(5_000)

      # A message taken twice would use a second place of the TPS: fewer different ones would go.
      assert length(released()) == 5 * k
    end

    assert Enum.sort(released()) == Enum.sort(ids)
    assert {:ok, []} = Store.due_scheduled(:leased, now() + 3_600_000, 1_000)
  end

  test "held until the customer trunks are loaded; a trunk no longer there goes at once (the sender decides)" do
    [id] = hold(7, 1, now() - 60_000)
    :ok = Scheduled.release_due()
    assert released() == []
    assert {:ok, true} = Scheduled.held?(@ent, id)

    trunks([[id: 1, tps: 1]])
    :ok = Scheduled.release_due()
    assert released() == [id]
  end
end
