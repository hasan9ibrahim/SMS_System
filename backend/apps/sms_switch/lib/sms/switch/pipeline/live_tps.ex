defmodule Sms.Switch.Pipeline.LiveTps do
  @moduledoc """
  Live TPS for routing (spec §13.8, §13.23): TPS conditions on route rules, the rule option "skip a vendor at N % of its
  TPS limit", and LCR's "at its TPS limit".

  Each message is counted in memory on the server that takes it, per second and per scope: customer trunk (`ct:`),
  customer enterprise (`ce:`), destination MCCMNC (`d:`), sender ID (`s:`), the rule that routed it (`r:`), and each
  vendor trunk it is sent to (`vt:`), in parts (submits), as TPS limits count. Once a second each server adds its
  counts of the last second to Redis (`lt:<second>`, one hash) and reads back the cluster's total of the second
  before, so both servers see the same TPS with no lookup per message: a window's TPS is its average over the last
  1, 5, 10 or 60 whole seconds, about two seconds behind. Without Redis (or with `backend: :local`) a server
  counts its own traffic only.

  A TPS condition holds its state per rule and scope (hysteresis, §13.8): a change must last `hold_s` seconds before
  the rule switches, and with `release_pct` a condition that is on stays on until the TPS is back past its value by
  that %.

  Scope "rule" counts every message the rule's other conditions let through, whichever rule routes it
  (`Sms.Switch.Pipeline.Router`; decided 2026-10-25 as the spec words it: "all traffic matching this rule").
  """
  use GenServer
  require Logger
  alias Sms.Core.Redis
  alias Sms.Switch.Rules.Route

  @local :sms_live_tps_local
  @cluster :sms_live_tps_cluster
  @state :sms_live_tps_state
  @keep_s 70
  @tick_ms 1_000
  @timeout 500

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Counts `n` submits against each scope key, in this second (or `second`, for tests)."
  @spec count([String.t()], pos_integer(), integer()) :: :ok
  def count(keys, n \\ 1, second \\ System.os_time(:second)) do
    if ready?() do
      Enum.each(keys, &:ets.update_counter(@local, {&1, second}, n, {{&1, second}, 0}))
    end

    :ok
  end

  @doc "The scope keys of a customer message (§13.8 Measured on)."
  @spec message_keys(map()) :: [String.t()]
  def message_keys(msg) do
    [
      "ct:#{msg.trunk.id}",
      "ce:#{msg.trunk.enterprise_id}",
      "d:#{msg.destination.mccmnc}",
      "s:#{msg.ingress.sender}"
    ]
  end

  @doc "The scope key of a TPS condition for a message."
  @spec scope_key(String.t() | nil, integer(), map()) :: String.t()
  def scope_key("customer_enterprise", _rule_id, input),
    do: "ce:#{input.customer_trunk.enterprise_id}"

  def scope_key("destination", _rule_id, input), do: "d:#{input.destination.mccmnc}"
  def scope_key("sender_id", _rule_id, input), do: "s:#{input.sender}"
  def scope_key("rule", rule_id, _input), do: "r:#{rule_id}"
  def scope_key(_customer_trunk, _rule_id, input), do: "ct:#{input.customer_trunk.id}"

  @doc "The TPS of a scope key: its average over the last `window_s` whole seconds."
  @spec rate(String.t(), pos_integer()) :: float()
  def rate(key, window_s) do
    if ready?() do
      {table, last} =
        if redis?(),
          do: {@cluster, System.os_time(:second) - 2},
          else: {@local, System.os_time(:second) - 1}

      sum(table, key, (last - window_s + 1)..last//1) / window_s
    else
      0.0
    end
  end

  defp sum(table, key, seconds) do
    Enum.reduce(seconds, 0, fn s, acc ->
      case :ets.lookup(table, {key, s}) do
        [{_, n}] -> acc + n
        [] -> acc
      end
    end)
  end

  @doc "A vendor trunk's TPS (last second) as a % of its limit; 0 with no limit."
  @spec vendor_pct(integer(), number() | nil) :: float()
  def vendor_pct(_id, limit) when limit in [nil, 0], do: 0.0
  def vendor_pct(id, limit), do: rate("vt:#{id}", 1) * 100 / limit

  @doc """
  Checks a rule's TPS condition `t` on scope `key` with its hysteresis: `{matches?, measured tps}`.
  """
  @spec check(integer(), String.t(), map(), integer()) :: {boolean(), float()}
  def check(rule_id, key, t, now_ms \\ System.os_time(:millisecond)) do
    tps = rate(key, t[:window_s] || 5)
    raw = Route.compare(t.op, tps, t.value, t[:value2], t[:tolerance_pct] || 5)

    if ready?() do
      {check_state(rule_id, key, t, tps, raw, now_ms), tps}
    else
      {raw, tps}
    end
  end

  defp check_state(rule_id, key, t, tps, raw, now) do
    state_key = {rule_id, key}

    {on, since} =
      case :ets.lookup(@state, state_key) do
        [{_, on, since, _at}] -> {on, since}
        # First seen: no hold.
        [] -> {raw, nil}
      end

    want = if on and not released?(t, tps), do: true, else: raw
    {on, since} = next_state(on, since, want, (t[:hold_s] || 0) * 1_000, now)
    :ets.insert(@state, {state_key, on, since, now})
    on
  end

  # A change of the wanted state takes effect once it has lasted the hold time.
  defp next_state(on, _since, on, _hold_ms, _now), do: {on, nil}
  defp next_state(_on, _since, want, 0, _now), do: {want, nil}
  defp next_state(on, nil, _want, _hold_ms, now), do: {on, now}
  defp next_state(_on, since, want, hold_ms, now) when now - since >= hold_ms, do: {want, nil}
  defp next_state(on, since, _want, _hold_ms, _now), do: {on, since}

  # With release_pct, a condition that is on stays on until the TPS is back past the value by that % (§13.8).
  defp released?(%{release_pct: pct} = t, tps) when is_number(pct) and pct > 0 do
    case t.op do
      op when op in [">", ">="] -> tps < t.value * (1 - pct / 100)
      op when op in ["<", "<="] -> tps > t.value * (1 + pct / 100)
      _ -> true
    end
  end

  defp released?(_t, _tps), do: true

  defp ready?, do: :ets.whereis(@local) != :undefined

  defp redis?,
    do: config(:backend, :redis) == :redis and :persistent_term.get({__MODULE__, :redis_ok}, true)

  defp config(key, default),
    do:
      :sms_switch
      |> Application.get_env(Sms.Switch.Pipeline.Store, [])
      |> Keyword.get(key, default)

  @impl true
  def init(opts) do
    Enum.each([@local, @cluster, @state], &new_table/1)
    {:ok, _} = :timer.send_interval(Keyword.get(opts, :tick_ms, @tick_ms), :tick)
    {:ok, nil}
  end

  defp new_table(name) do
    ^name =
      :ets.new(name, [
        :named_table,
        :public,
        :set,
        write_concurrency: true,
        read_concurrency: true
      ])

    :ok
  end

  @impl true
  def handle_info(:tick, state) do
    now = System.os_time(:second)
    _ = if config(:backend, :redis) == :redis, do: share(now)
    _ = sweep(now)
    {:noreply, state}
  end

  # Adds this server's counts of the last second to the cluster's, and reads back the total of the second before.
  defp share(now) do
    last = now - 1
    counts = :ets.match_object(@local, {{:_, last}, :_})

    adds =
      for {{key, _}, n} <- counts, do: ["HINCRBY", "lt:#{last}", key, n]

    commands = adds ++ [["EXPIRE", "lt:#{last}", 120], ["HGETALL", "lt:#{now - 2}"]]

    case Redis.transaction(commands, @timeout) do
      {:ok, replies} ->
        :persistent_term.put({__MODULE__, :redis_ok}, true)

        replies
        |> List.last()
        |> Enum.chunk_every(2)
        |> Enum.each(fn [k, v] -> put_cluster(k, now - 2, v) end)

      {:error, reason} ->
        if :persistent_term.get({__MODULE__, :redis_ok}, true),
          do:
            Logger.warning("live TPS counted per server (Redis unavailable: #{inspect(reason)})")

        :persistent_term.put({__MODULE__, :redis_ok}, false)
    end
  end

  defp put_cluster(key, second, n) do
    n = if is_binary(n), do: String.to_integer(n), else: n
    :ets.insert(@cluster, {{key, second}, n})
  end

  defp sweep(now) do
    old = now - @keep_s

    _ =
      for t <- [@local, @cluster],
          do: :ets.select_delete(t, [{{{:_, :"$1"}, :_}, [{:<, :"$1", old}], [true]}])

    # Hysteresis states not used for ten minutes.
    :ets.select_delete(@state, [{{:_, :_, :_, :"$1"}, [{:<, :"$1", (now - 600) * 1_000}], [true]}])
  end
end
