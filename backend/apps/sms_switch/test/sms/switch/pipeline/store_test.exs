defmodule Sms.Switch.Pipeline.StoreTest do
  # The message store (§13.1, S-5.5–S-5.9): the same behaviour in memory and in Redis (INTEGRATION=1).
  use ExUnit.Case, async: false
  alias Sms.Switch.Pipeline.Store

  for backend <- [:local, :redis] do
    describe "#{backend} backend" do
      if backend == :redis, do: @describetag(:integration)

      setup do
        use_backend(unquote(backend))
        start_supervised!(Store)
        # Keys unique to this test, so a shared Redis keeps no state between tests.
        %{
          id: "t#{System.unique_integer([:positive])}",
          vt: 900_000 + System.unique_integer([:positive])
        }
      end

      test "queued marks: cancel while queued, the sender's take, query (S-2.15, D8)", %{
        id: id,
        vt: ent
      } do
        other = "#{id}-b"
        assert :ok = Store.mark_queued(ent, [id, other], 60)
        assert {:ok, :queued} = Store.queued(ent, id)
        # Another enterprise never sees it.
        assert {:ok, :none} = Store.queued(ent + 1, id)
        assert :not_queued = Store.cancel_queued(ent + 1, id, 60)

        assert :ok = Store.cancel_queued(ent, other, 60)
        assert :ok = Store.cancel_queued(ent, other, 60)
        assert {:ok, :cancelled} = Store.queued(ent, other)
        # One part cancelled cancels the message; the marks stay for query_sm.
        assert :cancelled = Store.take_queued(ent, [id, other], 60)
        assert {:ok, :cancelled} = Store.queued(ent, id)

        third = "#{id}-c"
        assert :ok = Store.mark_queued(ent, [third], 60)
        assert :send = Store.take_queued(ent, [third], 60)
        assert {:ok, :none} = Store.queued(ent, third)
        assert :not_queued = Store.cancel_queued(ent, third, 60)
        # A mark gone (a redelivery) sends.
        assert :send = Store.take_queued(ent, [third], 60)

        assert :ok = Store.mark_queued(ent, [third], 60)
        assert :ok = Store.drop_queued(ent, [third])
        assert {:ok, :none} = Store.queued(ent, third)
      end

      test "a sent message is found from each part's vendor id, with its data", %{id: id, vt: vt} do
        refute Store.sent?(id)

        assert :ok =
                 Store.record_sent(
                   id,
                   %{parts: 2, text: "hi"},
                   [{1, vt, "a1"}, {2, vt, "a2"}],
                   60
                 )

        assert Store.sent?(id)
        assert {:ok, {^id, 2}} = Store.find_vendor_id(vt, ["nope", "a2"])
        assert :none = Store.find_vendor_id(vt, ["nope"])

        assert {:ok, %{data: %{parts: 2, text: "hi"}, finals: finals, forwarded: false}} =
                 Store.message(id)

        assert finals == %{}
        assert :none = Store.message("#{id}-unknown")
      end

      test "the first final receipt of a part wins; the customer's receipt is claimed once", %{
        id: id,
        vt: vt
      } do
        :ok = Store.record_sent(id, %{parts: 1}, [{1, vt, "b1"}], 60)
        assert {:ok, true} = Store.put_final(id, 1, %{status: "DELIVRD"})
        assert {:ok, false} = Store.put_final(id, 1, %{status: "UNDELIV"})
        assert {:ok, %{finals: %{1 => %{status: "DELIVRD"}}}} = Store.message(id)
        assert {:ok, true} = Store.claim_forward(id)
        assert {:ok, false} = Store.claim_forward(id)
        assert {:ok, %{forwarded: true, finals: finals}} = Store.message(id)
        assert map_size(finals) == 1
      end

      test "a finished message is forgotten with its vendor ids; a claim can be given back", %{
        id: id,
        vt: vt
      } do
        :ok = Store.record_sent(id, %{parts: 2}, [{1, vt, "d1"}, {2, vt, "d2"}], 60)
        assert {:ok, true} = Store.claim_forward(id)
        assert :ok = Store.unclaim_forward(id)
        assert {:ok, %{forwarded: false, vendor_ids: %{1 => "d1", 2 => "d2"}}} = Store.message(id)
        assert {:ok, true} = Store.claim_forward(id)

        assert :ok = Store.forget(id, vt, ["d1", "d2"])
        assert :none = Store.message(id)
        assert :none = Store.find_vendor_id(vt, ["d1", "d2"])
        refute Store.sent?(id)
      end

      test "an early receipt is taken once", %{vt: vt} do
        assert :ok = Store.put_orphan(vt, "c1", %{status: "DELIVRD"})
        assert {:ok, %{status: "DELIVRD"}} = Store.take_orphan(vt, "c1")
        assert :none = Store.take_orphan(vt, "c1")
      end

      test "multipart parts: held once each, the group claimed once, then dropped", %{id: key} do
        far = System.os_time(:millisecond) + 60_000
        assert {:ok, 1} = Store.add_part(key, 2, "id2", %{n: 2}, 60, far)
        assert {:duplicate, "id2"} = Store.add_part(key, 2, "id2b", %{n: 2}, 60, far)
        assert {:ok, 2} = Store.add_part(key, 1, "id1", %{n: 1}, 60, far)
        assert {:ok, %{1 => %{n: 1}, 2 => %{n: 2}}} = Store.group_parts(key)

        assert Store.claim_group(key)
        refute Store.claim_group(key)
        assert :ok = Store.unclaim_group(key)
        assert :ok = Store.drop_part(key, 2)
        assert {:ok, 2} = Store.add_part(key, 2, "id2c", %{n: 2}, 60, far)

        assert {:ok, due} = Store.due_groups(far, 100)
        assert key in due
        assert Store.claim_group_timeout(key)
        refute Store.claim_group_timeout(key)
        assert :ok = Store.drop_group(key)
        assert {:ok, parts} = Store.group_parts(key)
        assert parts == %{}
      end

      test "held receipts: oldest first, one sender at a time, the trunk leaves the set when empty",
           %{vt: trunk} do
        assert :ok = Store.hold(trunk, %{n: 2}, 2_000)
        assert :ok = Store.hold(trunk, %{n: 1}, 1_000)
        assert {:ok, trunks} = Store.held_trunks()
        assert trunk in trunks

        assert {:ok, [{m1, %{n: 1}}, {m2, %{n: 2}}]} = Store.held(trunk, 10)
        assert {:ok, [{^m1, _}]} = Store.held(trunk, 1)

        assert Store.lock_held(trunk, 30)
        refute Store.lock_held(trunk, 30)
        assert :ok = Store.unlock_held(trunk)
        assert Store.lock_held(trunk, 30)
        Store.unlock_held(trunk)

        assert :ok = Store.release(trunk, m1)
        assert {:ok, trunks} = Store.held_trunks()
        assert trunk in trunks
        assert :ok = Store.release(trunk, m2)
        assert {:ok, []} = Store.held(trunk, 10)
        assert {:ok, trunks} = Store.held_trunks()
        refute trunk in trunks
      end
    end
  end

  defp use_backend(backend) do
    previous = Application.get_env(:sms_switch, Store)
    Application.put_env(:sms_switch, Store, backend: backend)
    on_exit(fn -> Application.put_env(:sms_switch, Store, previous) end)
    if backend == :redis, do: start_supervised!(Sms.Core.Redis)
  end
end
