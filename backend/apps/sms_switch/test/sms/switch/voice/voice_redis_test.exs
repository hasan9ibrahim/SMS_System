defmodule Sms.Switch.Voice.RedisTest do
  # §8 SMS to voice on real Redis (INTEGRATION=1): a gateway's places shared by both servers (leases that end by
  # themselves), and the call claims and retries the shared store holds.
  use ExUnit.Case, async: false
  @moduletag :integration

  alias Sms.Switch.Pipeline.Store
  alias Sms.Switch.Test.CustomerCase
  alias Sms.Switch.Throttle

  setup do
    previous =
      {Application.get_env(:sms_switch, Store), Application.get_env(:sms_switch, Throttle)}

    Application.put_env(:sms_switch, Store, backend: :redis)

    Application.put_env(:sms_switch, Throttle,
      backend: :redis,
      cluster_size: 2,
      redis_timeout_ms: 500
    )

    on_exit(fn ->
      {store, throttle} = previous
      Application.put_env(:sms_switch, Store, store)
      Application.put_env(:sms_switch, Throttle, throttle)
    end)

    start_supervised!(Sms.Core.Redis)
    start_supervised!(Store)
    start_supervised!(Throttle)
    CustomerCase.assert_eventually(fn -> Store.command(["PING"]) == {:ok, "PONG"} end)
    %{key: "vg:test#{System.unique_integer([:positive])}"}
  end

  test "places up to the limit, renewed by the same lease, given back; a lost lease ends by itself",
       %{key: key} do
    assert Throttle.lease_take(key, "a", 2, 60_000)
    assert Throttle.lease_take(key, "b", 2, 60_000)
    refute Throttle.lease_take(key, "c", 2, 60_000)
    assert Throttle.lease_take(key, "a", 2, 60_000)
    assert Throttle.leases(key) == 2

    :ok = Throttle.lease_release(key, "a")
    assert Throttle.lease_take(key, "short", 2, 100)
    refute Throttle.lease_take(key, "c", 2, 60_000)
    Process.sleep(150)
    assert Throttle.leases(key) == 1
    assert Throttle.lease_take(key, "c", 2, 60_000)

    # The key expires with its last lease.
    {:ok, ttl} = Store.command(["PTTL", "lease:#{key}"])
    assert ttl > 50_000 and ttl <= 60_000
    :ok = Throttle.lease_release(key, "b")
    :ok = Throttle.lease_release(key, "c")
    assert Throttle.leases(key) == 0
  end

  test "a call try claimed once; retries held, taken by one server, forgotten" do
    id = "fakevoice#{System.unique_integer([:positive])}"
    assert Store.claim_voice_call("#{id}:1", 60)
    refute Store.claim_voice_call("#{id}:1", 60)
    :ok = Store.unclaim_voice_call("#{id}:1")
    assert Store.claim_voice_call("#{id}:1", 60)

    now = System.os_time(:millisecond)
    :ok = Store.hold_voice_retry(id, :erlang.term_to_binary({%{id: id}, 2}), now - 5, 60)
    assert {:ok, due} = Store.due_voice_retries(:waiting, now, 1_000)
    assert id in due
    assert Store.claim_voice_retry(:waiting, id, now, now + 1_000)
    refute Store.claim_voice_retry(:waiting, id, now, now + 1_000)
    assert {:ok, blob} = Store.voice_retry(id)
    assert :erlang.binary_to_term(blob) == {%{id: id}, 2}
    assert {:ok, leased} = Store.due_voice_retries(:leased, now + 2_000, 1_000)
    assert id in leased
    :ok = Store.finish_voice_retry(id)
    assert Store.voice_retry(id) == {:ok, nil}
    {:ok, _} = Store.command(["DEL", "vp:#{id}:1"])
  end
end
