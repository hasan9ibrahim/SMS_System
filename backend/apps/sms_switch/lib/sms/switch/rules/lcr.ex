defmodule Sms.Switch.Rules.Lcr do
  @moduledoc """
  LCR ranking (spec §13.23), a port of `mock/src/lcr/rank.ts`: an LCR profile's filters (vendors, tiers, minimum ASR /
  DLR, maximum delay and rate, TPS limit), the order (cost, or the quality-weighted score), the tie-breaker, and which
  vendors it uses with their shares. Used by route rules of type Least cost.

  A candidate is a map with `vendor_trunk_id`, `cost` (platform currency), `asr`, `dlr`, `delay_s` (nil when
  unknown), `tier` and `at_limit`.
  """

  @default_weights %{cost: 60, asr: 10, dlr: 25, delay: 5}

  @type profile :: %{
          vendor_trunk_mode: :all | :inclusive | :exclusive,
          vendor_trunk_ids: MapSet.t() | [integer()],
          tiers: [String.t()],
          min_asr: number() | nil,
          min_dlr: number() | nil,
          max_delay_s: number() | nil,
          max_rate: number() | nil,
          vendor_count: non_neg_integer() | nil,
          split: :top_down | :percentage,
          shares: [number()],
          tie_breaker: :quality | :cost,
          exclude_at_tps_limit: boolean(),
          quality_weighted: boolean(),
          weights: map() | nil
        }

  @type ranked :: %{
          c: map(),
          rank: pos_integer() | nil,
          score: float() | nil,
          excluded: String.t() | nil,
          pick: boolean(),
          share: number() | nil
        }

  @doc "The default quality weights."
  def default_weights, do: @default_weights

  # The first filter of the profile the candidate fails, in this order, or nil.
  defp exclusion(c, p) do
    Enum.find_value(
      [&vendor_exclusion/2, &tier_exclusion/2, &quality_exclusion/2, &tps_exclusion/2],
      fn check -> check.(c, p) end
    )
  end

  defp vendor_exclusion(c, p) do
    listed = c.vendor_trunk_id in p.vendor_trunk_ids

    cond do
      p.vendor_trunk_mode == :inclusive and not listed -> "not in the profile's vendors"
      p.vendor_trunk_mode == :exclusive and listed -> "excluded by the profile"
      true -> nil
    end
  end

  defp tier_exclusion(c, p) do
    if p.tiers != [] and (c.tier || "") not in p.tiers, do: "#{c.tier || "no tier"} not allowed"
  end

  defp quality_exclusion(c, p) do
    cond do
      p.max_rate != nil and c.cost > p.max_rate ->
        "cost above #{num(p.max_rate)}"

      # Unknown quality is not held against a vendor (no traffic yet).
      below?(c.asr, p.min_asr) ->
        "ASR below #{num(p.min_asr)} %"

      below?(c.dlr, p.min_dlr) ->
        "DLR below #{num(p.min_dlr)} %"

      below?(p.max_delay_s, c.delay_s) ->
        "delay above #{num(p.max_delay_s)} s"

      true ->
        nil
    end
  end

  # Both known and the first below the second.
  defp below?(nil, _limit), do: false
  defp below?(_value, nil), do: false
  defp below?(value, limit), do: value < limit

  defp tps_exclusion(c, p), do: if(p.exclude_at_tps_limit and c.at_limit, do: "at its TPS limit")

  @doc false
  # A number as JavaScript prints it in a template string: 80 not 80.0.
  def num(n) when is_integer(n), do: Integer.to_string(n)

  def num(n) when is_float(n) do
    if n == Float.round(n) and abs(n) < 1.0e15,
      do: n |> trunc() |> Integer.to_string(),
      else: js_float(n)
  end

  defp js_float(n), do: :erlang.float_to_binary(n, [:short])

  @doc "0–100 per factor within the set (cost and delay: lower is better; unknown quality counts as middling)."
  @spec scores([map()], map()) :: %{optional(map()) => float()}
  def scores(list, w) do
    costs = range(Enum.map(list, & &1.cost))
    delays = list |> Enum.map(& &1.delay_s) |> Enum.reject(&is_nil/1)
    d_range = if delays == [], do: {0, 0}, else: range(delays)
    total = w.cost + w.asr + w.dlr + w.delay
    total = if total == 0, do: 1, else: total

    Map.new(list, fn c ->
      s =
        w.cost * low(c.cost, costs) + w.asr * (c.asr || 50) + w.dlr * (c.dlr || 50) +
          w.delay * if(is_nil(c.delay_s), do: 50, else: low(c.delay_s, d_range))

      {c, js_round(s / total * 10) / 10}
    end)
  end

  defp range(xs), do: {Enum.min(xs), Enum.max(xs)}
  defp low(v, {a, b}) when b > a, do: (b - v) / (b - a) * 100
  defp low(_v, _range), do: 100

  @doc "JavaScript's Math.round: half up towards +∞."
  @spec js_round(number()) :: integer()
  def js_round(x), do: x |> Kernel.+(0.5) |> Float.floor() |> trunc()

  @doc """
  Ranks candidates with an optional profile. Options: `:quality_weighted`, `:weights` (override the profile's).
  Eligible candidates come first in rank order, then the excluded ones by cost.
  """
  @spec rank([map()], profile() | nil, keyword()) :: [ranked()]
  def rank(list, profile, opts \\ []) do
    {weighted, weights, tie} = rank_options(profile, opts)
    {eligible, out} = partition(list, profile)
    sc = if weighted and eligible != [], do: scores(eligible, weights)

    sorted = Enum.sort(eligible, fn a, b -> compare(a, b, sc, tie) <= 0 end)
    count = (profile && profile.vendor_count) || length(sorted)
    split = profile != nil and profile.split == :percentage

    ranked =
      sorted
      |> Enum.with_index()
      |> Enum.map(fn {c, i} ->
        %{
          c: c,
          rank: i + 1,
          score: sc && Map.fetch!(sc, c),
          excluded: nil,
          pick: i < count,
          share: share(split and i < count, profile, i)
        }
      end)

    ranked ++ Enum.sort(out, fn a, b -> a.c.cost <= b.c.cost end)
  end

  defp rank_options(profile, opts) do
    weighted = Keyword.get(opts, :quality_weighted, profile && profile.quality_weighted) || false
    weights = Keyword.get(opts, :weights) || (profile && profile.weights) || @default_weights
    tie = (profile && profile.tie_breaker) || :quality
    {weighted, weights, tie}
  end

  # Eligible candidates and the excluded ones (already ranked), each in the given order.
  defp partition(list, profile) do
    {eligible, out} =
      Enum.reduce(list, {[], []}, fn c, {elig, out} ->
        case profile && exclusion(c, profile) do
          why when why in [nil, false] ->
            {[c | elig], out}

          why ->
            {elig, [%{c: c, rank: nil, score: nil, excluded: why, pick: false, share: nil} | out]}
        end
      end)

    {Enum.reverse(eligible), Enum.reverse(out)}
  end

  defp share(true, profile, i), do: Enum.at(profile.shares, i) || 0
  defp share(false, _profile, _i), do: nil

  # The JavaScript comparator: negative = a first.
  defp compare(a, b, sc, tie) do
    main = if sc, do: Map.fetch!(sc, b) - Map.fetch!(sc, a), else: a.cost - b.cost

    if main != 0 do
      main
    else
      t =
        if tie == :quality,
          do: nonzero((b.dlr || -1) - (a.dlr || -1), a.cost - b.cost),
          else: nonzero(a.cost - b.cost, (b.dlr || -1) - (a.dlr || -1))

      nonzero(t, a.vendor_trunk_id - b.vendor_trunk_id)
    end
  end

  defp nonzero(x, y) when x == 0, do: y
  defp nonzero(x, _y), do: x

  @doc "The picks with the one a percentage split sends this message to (bucket 0–99) first, else as they are."
  @spec split_pick([ranked()], 0..99) :: [ranked()]
  def split_pick([], _bucket), do: []
  def split_pick([%{share: nil} | _] = picks, _bucket), do: picks

  def split_pick([first | _] = picks, bucket) do
    hit =
      picks
      |> Enum.reduce_while(0, fn p, acc ->
        acc = acc + (p.share || 0)
        if acc > bucket, do: {:halt, {:hit, p}}, else: {:cont, acc}
      end)
      |> case do
        {:hit, p} -> p
        _ -> first
      end

    [hit | List.delete(picks, hit)]
  end
end
