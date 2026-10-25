defmodule Sms.Switch.Pipeline.Revenue do
  @moduledoc """
  Accumulated revenue for route rules (spec §13.9): the revenue already earned per scope (customer trunk `ct:`,
  enterprise `ce:`, destination `d:`, sender ID `s:`, the rule that routed it `r:`), in the platform currency, over the
  last 15 or 60 minutes, today, this week, this month or this billing cycle.

  Revenue is earned when a message becomes billable to the customer (`Sms.Switch.Pipeline.Billing`): it is counted
  with the customer's charge, through the same event and applied once (`Sms.Switch.Pipeline.Ledger.apply_charge/1`),
  into 15-minute buckets in Redis (`rv:<scope>`, kept 40 days). Today, week and month start at midnight in the
  customer's billing time zone, the billing cycle at the end of its last invoice (both from
  `Sms.Switch.Pipeline.Ledger.Sync`); the windows count whole buckets. A rule reads a total cached for 5 s on each
  server, so routing never waits for more than one Redis call per scope and period every few seconds.
  """
  alias Sms.Switch.Pipeline.{Ledger, Store}

  @cache :sms_revenue_cache
  @cache_ms 5_000
  @keep_s 40 * 86_400

  @doc "The scope keys a message's revenue counts under (§13.9 Measured on)."
  @spec keys(map(), integer() | nil) :: [String.t()]
  def keys(msg, rule_id) do
    base = [
      "ct:#{msg.trunk.id}",
      "ce:#{msg.trunk.enterprise_id}",
      "d:#{(msg.destination || %{})[:mccmnc]}",
      "s:#{msg.ingress[:sender] || msg.fields[:source_addr]}"
    ]

    if rule_id, do: base ++ ["r:#{rule_id}"], else: base
  end

  @doc "A rate × parts in micro-units of the platform currency (the rate's `platform` value)."
  @spec platform_micro(map() | nil, non_neg_integer()) :: integer()
  def platform_micro(nil, _parts), do: 0
  def platform_micro(sell, parts), do: round((sell[:platform] || 0) * parts * 1_000_000)

  @doc "The commands that add `micro` (platform currency) to each scope's current bucket, for the charge's transaction."
  @spec commands([String.t()], integer(), integer()) :: [list()]
  def commands(keys, bucket, micro) do
    Enum.flat_map(keys, fn key ->
      [
        ["HINCRBY", "rv:#{key}", Integer.to_string(bucket), micro],
        ["EXPIRE", "rv:#{key}", @keep_s]
      ]
    end)
  end

  @doc """
  The accumulated revenue of a scope over a period (platform currency units), for the customer enterprise
  `enterprise_id` (its time zone and billing cycle); nil when it cannot be read.
  """
  @spec value(String.t(), String.t() | nil, integer()) :: float() | nil
  def value(key, period, enterprise_id) do
    from = from_bucket(period, enterprise_id)
    now = System.monotonic_time(:millisecond)
    cache_key = {key, from}

    case cached(cache_key, now) do
      {:ok, value} -> value
      :miss -> read(cache_key, now)
    end
  end

  defp cached(cache_key, now) do
    with true <- :ets.whereis(@cache) != :undefined,
         [{_, value, at}] when now - at < @cache_ms <- :ets.lookup(@cache, cache_key) do
      {:ok, value}
    else
      _ -> :miss
    end
  end

  defp read({key, from} = cache_key, now) do
    case Store.sum_from("rv:#{key}", from) do
      {:ok, micro} ->
        value = micro / 1_000_000
        if :ets.whereis(@cache) != :undefined, do: :ets.insert(@cache, {cache_key, value, now})
        value

      {:error, _} ->
        nil
    end
  end

  @doc false
  # The first bucket of a period.
  @spec from_bucket(String.t() | nil, integer()) :: integer()
  def from_bucket(period, enterprise_id) do
    now = System.os_time(:second)

    start =
      case period do
        "15m" ->
          now - 900

        "60m" ->
          now - 3_600

        p when p in ["today", "week", "month", "billing_cycle"] ->
          period_start(p, enterprise_id, now)

        # Unknown or missing: today.
        _ ->
          period_start("today", enterprise_id, now)
      end

    Ledger.bucket(start)
  end

  defp period_start(period, enterprise_id, now) do
    case Ledger.account(Ledger.key(:customer, enterprise_id)) do
      %{periods: %{^period => start}} when is_integer(start) ->
        start

      # No billing set up: UTC calendar periods.
      _ ->
        utc_start(period, now)
    end
  end

  defp utc_start(period, now) do
    today = div(now, 86_400) * 86_400
    date = today |> DateTime.from_unix!() |> DateTime.to_date()

    case period do
      "week" -> today - (Date.day_of_week(date) - 1) * 86_400
      p when p in ["month", "billing_cycle"] -> today - (date.day - 1) * 86_400
      _ -> today
    end
  end

  @doc false
  def start_cache do
    _ =
      if :ets.whereis(@cache) == :undefined,
        do: :ets.new(@cache, [:named_table, :public, :set, read_concurrency: true])

    :ok
  end
end
