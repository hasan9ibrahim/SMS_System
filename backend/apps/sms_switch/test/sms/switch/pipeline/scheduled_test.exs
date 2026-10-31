defmodule Sms.Switch.Pipeline.ScheduledTest do
  # S-2.12, S-2.4: scheduled messages are released at their customer trunk's TPS, as the session holds live traffic to
  # it: within it at once, over it into the trunk's overflow buffer while that has room, else held for a later sweep.
  # Never lost, never sent twice, roughly in their order (fake messages; the whole path is in pipeline_test.exs).
  use ExUnit.Case, async: false
  @moduletag capture_log: true

  alias Sms.Core.Bus.Local
  alias Sms.Switch.Customer.{Trunk, TrunkStore}
  alias Sms.Switch.Pipeline.{Buffers, Intake, MessageId, Scheduled, Store, Timeouts}
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
    # The buffer's drain runs (and ignores what is not for it).
    send(GenServer.whereis(Buffers.via("ct.1")), :unexpected)

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

  # Messages held for `at` (one ms apart), each sent by the customer in `parts` submits (one customer id per part, as
  # reassembly leaves them); their message ids in that order.
  defp hold_parts(trunk_id, parts_list, at) do
    for {parts, i} <- Enum.with_index(parts_list, 1) do
      id = MessageId.new()
      ids = [id | for(_ <- 2..parts//1, do: MessageId.new())]

      :ok =
        Scheduled.hold(%{
          id: id,
          ids: ids,
          trunk: %{id: trunk_id, enterprise_id: @ent},
          scheduled_at: at + i,
          scheduled: true,
          buffered: false,
          text: "fake scheduled #{i}"
        })

      id
    end
  end

  defp counters(trunk_id) do
    {:ok, trunk} = TrunkStore.get(trunk_id)
    Trunk.tps_counters(trunk)
  end

  test "a multipart message takes one TPS place per part the customer sent; a long one sent in one submit takes one" do
    trunks([[id: 1, tps: 5]])
    [a, b, c] = hold_parts(1, [3, 2, 1], now() - 60_000)
    assert Scheduled.submits(%{id: "x"}) == 1
    assert Scheduled.submits(%{id: "x", ids: ["x", "y", "z"]}) == 3

    second_start()
    :ok = Scheduled.release_due()
    # 3 + 2 places: the second is full, the third waits.
    assert released() == [a, b]

    second_start()
    :ok = Scheduled.release_due()
    assert released() == [a, b, c]
  end

  test "off the waiting set: the rest of its places are taken after it is read, or it waits again with none kept" do
    trunks([[id: 1, tps: 3]])
    [a, b, c] = hold_parts(1, [1, 3, 1], now() - 60_000)

    second_start()
    :ok = Scheduled.release_due()
    # One place left of three: the 3-part one waits, and the next behind it.
    assert released() == [a]

    # Live traffic took one place of the next second before the sweep: the 3-part one gets its first place, not the
    # other two, and waits again with that place given back.
    second_start()
    second = System.os_time(:second)
    :ok = Throttle.acquire(counters(1), second)
    :ok = Scheduled.release_due()
    assert released() == [a]
    assert Scheduled.held?(@ent, b) == {:ok, true}
    assert Throttle.acquire_many(counters(1), 2, second) == :ok

    second_start()
    :ok = Scheduled.release_due()
    assert released() == [a, b]

    second_start()
    :ok = Scheduled.release_due()
    assert released() == [a, b, c]
  end

  test "a message in more parts than the trunk's TPS still goes, in a second of its own" do
    trunks([[id: 1, tps: 2]])
    [a, b] = hold_parts(1, [4, 1], now() - 60_000)
    assert Throttle.places(counters(1), 4) == 2

    second_start()
    :ok = Scheduled.release_due()
    assert released() == [a]

    second_start()
    :ok = Scheduled.release_due()
    assert released() == [a, b]
    assert Throttle.places([], 0) == 1
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

  test "a message whose data is gone is forgotten, not sent; the TPS place it took goes to the next one" do
    trunks([[id: 1, tps: 1]])
    [gone, first, lost, last] = hold(1, 4, now() - 60_000)
    {:ok, _} = Store.command(["DEL", "sch:#{gone}"])

    second_start()
    :ok = Scheduled.release_due()
    assert released() == [first]
    assert {:ok, []} = Store.due_scheduled(:waiting, now(), 1_000)

    # Waiting for the TPS when its data went: its place goes to the next one in the same second.
    {:ok, _} = Store.command(["DEL", "sch:#{lost}"])
    second_start()
    :ok = Scheduled.release_due()
    assert released() == [first, last]
    assert {:ok, []} = Store.waiting_trunks()
    assert {:ok, []} = Store.due_scheduled(:leased, now() + 3_600_000, 1_000)
  end

  test "a buffer place taken for a message whose data is gone is given back" do
    # No drain here: the buffer's place stays taken until given back.
    trunks([[id: 1, tps: 1, overflow_buffer: 1]])
    [first, in_buffer, lost] = hold(1, 3, now() - 60_000)

    second_start()
    :ok = Scheduled.release_due()
    assert released() == [first]
    assert Enum.map(buffered(), & &1.data["id"]) == [in_buffer]

    # The buffer's message left it (as its drain does); the waiting one takes the place, but its data is gone.
    :ok = Throttle.buffer_release("ct:1")
    {:ok, _} = Store.command(["DEL", "sch:#{lost}"])
    :ok = Scheduled.release_due()
    assert Enum.map(buffered(), & &1.data["id"]) == [in_buffer]
    assert Throttle.buffer_take("ct:1", 1)
    assert {:ok, []} = Store.due_scheduled(:leased, now() + 3_600_000, 1_000)
  end

  test "the bus down at its release: kept and its TPS place given back; sent once the bus is back" do
    trunks([[id: 1, tps: 1]])
    [known] = hold(1, 1, now() - 60_000)
    # A trunk no longer there takes no TPS place.
    [unknown] = hold(7, 1, now() - 60_000)
    stop_supervised!(Sms.Core.Bus)

    second_start()
    t0 = now()
    :ok = Scheduled.release_due(t0)
    # Leased, so not taken again before its lease runs out.
    assert {:ok, leased} = Store.due_scheduled(:leased, t0 + 3_600_000, 1_000)
    assert Enum.sort(leased) == Enum.sort([known, unknown])
    assert Enum.all?([known, unknown], &(Scheduled.held?(@ent, &1) == {:ok, true}))
    assert Enum.all?([known, unknown], &(Store.queued(@ent, &1) == {:ok, :none}))

    # Its lease ran out: the next sweep sends both, the trunk's one in the same TPS second it was given back.
    start_supervised!(Sms.Core.Bus)
    :ok = Scheduled.release_due(t0 + 61_000)
    assert Enum.sort(released()) == Enum.sort([known, unknown])
    assert {:ok, []} = Store.due_scheduled(:leased, t0 + 3_600_000, 1_000)
  end

  test "a buffered one the bus cannot take from the buffer's drain stays there and goes once the bus is back" do
    start_supervised!({Buffers, discover_ms: 3_600_000})
    trunks([[id: 1, tps: 1, overflow_buffer: 1]])
    [first, in_buffer] = hold(1, 2, now() - 60_000)

    second_start()
    :ok = Scheduled.release_due()
    assert released() == [first]
    # The drain holds it, waiting for the next TPS second; the bus goes down meanwhile.
    drain = GenServer.whereis(Buffers.via("ct.1"))
    CustomerCase.assert_eventually(fn -> match?({_, _}, :sys.get_state(drain).held) end)
    stop_supervised!(Sms.Core.Bus)

    # Its hand-off failed at least once (next second), then the bus is back.
    second_start()
    Process.sleep(100)
    assert Process.alive?(drain)
    assert match?({%{id: ^in_buffer}, _}, :sys.get_state(drain).held)
    start_supervised!(Sms.Core.Bus)
    CustomerCase.assert_eventually(fn -> released() == [in_buffer] end, 3_000)
    CustomerCase.assert_eventually(fn -> :sys.get_state(drain).held == nil end)
  end

  test "cancel_sm of a message a server is releasing: not held any more (it goes)" do
    trunks([[id: 1, tps: 1]])
    [id] = hold(1, 1, now() - 60_000)
    assert Store.claim_scheduled(:waiting, id, now(), now() + 60_000)
    assert :not_held = Scheduled.cancel(@ent, id)
    assert {:ok, true} = Scheduled.held?(@ent, id)
  end

  test "Redis unavailable: holding is refused, nothing is released or lost, query and cancel answer the error" do
    trunks([[id: 1, tps: 1]])
    previous = Application.get_env(:sms_switch, Store)
    Application.put_env(:sms_switch, Store, backend: :redis)
    on_exit(fn -> Application.put_env(:sms_switch, Store, previous) end)
    id = MessageId.new()

    msg = %{
      id: id,
      trunk: %{id: 1, enterprise_id: @ent},
      scheduled_at: now() + 60_000,
      scheduled: true,
      buffered: false
    }

    assert {:error, _} = Scheduled.hold(msg)
    assert :ok = Scheduled.release_due()
    assert released() == []
    assert {:error, _} = Scheduled.held?(@ent, id)
    assert {:error, _} = Scheduled.cancel(@ent, id)

    # The waiting sets' own steps say so too.
    assert {:error, _} = Store.defer_scheduled(id, 1, now(), now() + 60_000, @ent, [id], 600)
    assert {:error, _} = Store.waiting_scheduled(1, 10)
    refute Store.claim_waiting(1, id, now() + 60_000)
    assert {:error, _} = Store.forget_waiting(1)
    assert {:error, _} = Store.take_scheduled(id)
    assert {:error, _} = Store.scheduled(id)
    # And the queued marks query_sm and cancel_sm read once it is released.
    assert {:error, _} = Store.queued(@ent, id)
    assert {:error, _} = Store.cancel_queued(@ent, id, 60)

    # The timeouts' tick carries on.
    assert :ok = Timeouts.sweep()
  end

  test "the release runs in a process of its own, one at a time: a slow one never holds the tick back" do
    trunks([[id: 1, tps: 100]])
    [id] = hold(1, 1, now() - 60_000)
    # The first tick's release waits on the bus.
    bus = Process.whereis(Local)
    :sys.suspend(bus)
    start_supervised!({Timeouts, sweep_ms: 50})
    CustomerCase.assert_eventually(fn -> :sys.get_state(Timeouts).release != nil end)
    release = :sys.get_state(Timeouts).release

    # The ticks go on, and start no second release meanwhile.
    Process.sleep(300)
    assert :sys.get_state(Timeouts).release == release
    send(Timeouts, :unexpected)

    :sys.resume(bus)
    CustomerCase.assert_eventually(fn -> released() == [id] end)
    CustomerCase.assert_eventually(fn -> :sys.get_state(Timeouts).release != release end)
    assert released() == [id]
  end
end
