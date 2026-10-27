defmodule Sms.Switch.Pipeline.Warmup do
  @moduledoc """
  Warm-up counts for route rule vendors (spec §13.27): the first N messages of a rule go to a vendor before the normal
  split. Each vendor with a threshold counts the parts it took through warm-up, per customer trunk or for the whole
  rule (`warmup_per`), in Redis (`wu:…`, shared by both servers).

  The count starts again on its own each period (`warmup_reset`: hour, day, week, or every `warmup_reset_hours`
  hours, in UTC), and when someone presses Reset on the vendor (`warmup_reset_at`, team trial round 6). The period and
  the reset time are part of the counter's key, so saving or editing the rule never restarts a count: only the period
  turning over or Reset does.

  When Redis cannot be read the vendor counts as warmed up, so traffic takes the normal split instead of piling onto
  the warm-up vendor.
  """
  alias Sms.Switch.Pipeline.Store

  @doc "Parts already sent through warm-up to the rule's vendor `v` for the message's customer trunk; nil when unknown."
  @spec sent(integer(), map(), integer(), integer()) :: non_neg_integer() | nil
  def sent(rule_id, v, customer_trunk_id, now_ms) do
    case Store.counter(key(rule_id, v, customer_trunk_id, now_ms)) do
      {:ok, n} -> n
      {:error, _} -> nil
    end
  end

  @doc "Counts `parts` sent through warm-up to the rule's vendor `v`."
  @spec count(integer(), map(), integer(), integer(), pos_integer()) :: :ok | {:error, term()}
  def count(rule_id, v, customer_trunk_id, now_ms, parts) do
    Store.add(key(rule_id, v, customer_trunk_id, now_ms), parts, ttl(v))
  end

  @doc false
  # The counter of the rule's vendor in the period that holds `now_ms`.
  @spec key(integer(), map(), integer(), integer()) :: String.t()
  def key(rule_id, v, customer_trunk_id, now_ms) do
    scope = if v[:warmup_per] == "rule", do: "all", else: "ct#{customer_trunk_id}"
    since = v[:warmup_reset_at] || 0
    "wu:#{rule_id}:#{v.vendor_trunk_id}:#{scope}:#{period_start(v, div(now_ms, 1000))}:#{since}"
  end

  @doc false
  # The start (unix seconds, UTC) of the period that holds `now`.
  @spec period_start(map(), integer()) :: integer()
  def period_start(v, now) do
    case v[:warmup_reset] do
      "hour" ->
        div(now, 3_600) * 3_600

      "week" ->
        today = div(now, 86_400) * 86_400
        date = today |> DateTime.from_unix!() |> DateTime.to_date()
        today - (Date.day_of_week(date) - 1) * 86_400

      "custom" ->
        len = max(v[:warmup_reset_hours] || 24, 1) * 3_600
        div(now, len) * len

      # day, and the default for a threshold with no period set
      _ ->
        div(now, 86_400) * 86_400
    end
  end

  # Kept one period longer than it counts.
  defp ttl(v) do
    case v[:warmup_reset] do
      "hour" -> 2 * 3_600
      "week" -> 8 * 86_400
      "custom" -> (max(v[:warmup_reset_hours] || 24, 1) + 1) * 3_600
      _ -> 2 * 86_400
    end
  end
end
