defmodule Sms.Switch.Pipeline.Config do
  @moduledoc """
  What the message pipeline reads on every message, in memory (S-7.2: routing keeps working from memory while
  PostgreSQL is down; S-6.6: a saved change is live within seconds):

    * destinations: the dial codes of the "All" profile (longest prefix wins) and their MCCMNC (§6.1);
    * customer and vendor trunks with the fields routing, rating and EDRs need;
    * route rules in evaluation order with their destination index (§6.3), translation rules per trunk in run order
      (§6.4, §13.2), number lists, LCR profiles (§13.23), vendor QBR quality (§6.3), exchange rates (§7);
    * rate lines of every rate table, current and scheduled (§6.2), looked up at the moment of the message.

  Everything but the rate lines is one snapshot in `:persistent_term` (read without copying, replaced as a whole so a
  change is never half applied, S-6.6). Rate lines live in an ETS table, replaced table by table, so a lookup never
  misses a line that exists before and after a reload. `Sms.Switch.Pipeline.Config.Server` keeps both up to date.
  """
  alias Sms.Switch.Rules.{Lcr, Route, Translation}

  @snapshot {__MODULE__, :snapshot}
  @rates __MODULE__.Rates
  @options __MODULE__.Options
  # Vendor options for a destination are recomputed at most this often (a scheduled rate becoming current, §6.2).
  @options_ttl_ms 5_000

  @type destination :: %{
          mccmnc_id: integer(),
          mccmnc: String.t(),
          mcc: String.t(),
          mnc: String.t(),
          network: String.t() | nil,
          all_networks: boolean(),
          country_iso: String.t(),
          country: String.t()
        }

  @type rate :: %{
          rate_table_id: integer(),
          line_id: integer(),
          mccmnc: String.t(),
          rate: Decimal.t(),
          currency: String.t(),
          platform: float()
        }

  # A rate line in memory: {from_ms, to_ms | nil, line_id, rate in millionths, currency, blocked}.

  # ---------------------------------------------------------------- snapshot

  @doc false
  @spec put_snapshot(map()) :: :ok
  def put_snapshot(snapshot) do
    :persistent_term.put(@snapshot, snapshot)
    clear_options()
  end

  @doc "Whether the configuration has been loaded at least once (until then, submits are refused with 0x08)."
  @spec ready?() :: boolean()
  def ready? do
    :persistent_term.get(@snapshot, nil) != nil and :ets.member(@rates, :ready)
  rescue
    ArgumentError -> false
  end

  defp snapshot, do: :persistent_term.get(@snapshot)

  @doc "The platform currency (EUR unless configured, decided 2026-10-16)."
  @spec platform_currency() :: String.t()
  def platform_currency, do: snapshot().platform_currency

  @doc "The destination of a number: the longest dial-code prefix of the All profile, or nil (§6.1)."
  @spec destination(String.t()) :: destination() | nil
  def destination(number) do
    %{destinations: d} = snapshot()
    digits = String.replace_prefix(number, "+", "")

    Enum.find_value(min(d.longest, byte_size(digits))..1//-1, fn n ->
      case Map.get(d.prefixes, binary_part(digits, 0, n)) do
        nil -> nil
        id -> Map.fetch!(d.mccmnc, id)
      end
    end)
  end

  @doc "The destination of an MCCMNC code (an HLR/MNP result, §13.24): the network, else its country's entry, or nil."
  @spec destination_of_mccmnc(String.t() | nil) :: map() | nil
  def destination_of_mccmnc(nil), do: nil
  def destination_of_mccmnc(code), do: Map.get(snapshot().destinations[:by_code] || %{}, code)

  @doc "The HLR configuration (§6.5, §13.24): providers, prices, rules per customer trunk, policies, route rule actions."
  @spec hlr() :: map()
  def hlr,
    do:
      Map.get(snapshot(), :hlr, %{
        providers: %{},
        rates: %{},
        rules: %{},
        trunk_rules: %{},
        policies: %{},
        actions: %{}
      })

  @doc "The MCCMNC code of a number (for translation conditions), or nil."
  @spec mccmnc_of(String.t()) :: String.t() | nil
  def mccmnc_of(number) do
    case destination(number) do
      nil -> nil
      d -> d.mccmnc
    end
  end

  @doc "A customer trunk's routing and billing fields, or nil."
  @spec customer_trunk(integer()) :: map() | nil
  def customer_trunk(id), do: Map.get(snapshot().customer_trunks, id)

  @doc "A vendor trunk's routing and billing fields, or nil."
  @spec vendor_trunk(integer()) :: map() | nil
  def vendor_trunk(id), do: Map.get(snapshot().vendor_trunks, id)

  @doc "The route rules' destination index (`Sms.Switch.Rules.Route.index/1`)."
  @spec route_index() :: map()
  def route_index, do: snapshot().route_index

  @doc "The rules that can match a message to `mccmnc` now, in evaluation order."
  @spec route_rules(String.t() | nil, integer()) :: [Route.Rule.t()]
  def route_rules(mccmnc, now_ms),
    do: Route.rules_for_destination(snapshot().route_index, mccmnc, now_ms)

  @doc "A trunk's running translation rules in order, each with the trunk's Continue / Stop."
  @spec translation_rules(:customer | :vendor, integer()) :: [{Translation.Rule.t(), boolean()}]
  def translation_rules(kind, trunk_id) do
    %{rules: rules, order: order} = snapshot().translation

    for {id, continue_after} <- Map.get(order, {kind, trunk_id}, []),
        do: {Map.fetch!(rules, id), continue_after}
  end

  @doc """
  Whether number list `id` holds `value` exactly, or, with `ignore_case`, in any case (route rules, §6.3).
  """
  @spec list_has?(integer(), String.t(), boolean()) :: boolean()
  def list_has?(id, value, ignore_case) do
    case Map.get(snapshot().lists, id) do
      nil -> false
      list when ignore_case -> String.downcase(value) in list.lower
      list -> value in list.exact
    end
  end

  @doc """
  Whether an entry of list `id` matches `value` as translation rules compare (§6.4): exactly or in any case, and a
  Sender ID template entry's `{n}` standing for one digit.
  """
  @spec list_matches?(integer(), String.t(), boolean()) :: boolean()
  def list_matches?(id, value, match_case) do
    case Map.get(snapshot().lists, id) do
      nil ->
        false

      list ->
        exact = if match_case, do: value in list.exact, else: String.downcase(value) in list.lower
        exact or Enum.any?(list.templates, &template_matches?(&1, value, match_case))
    end
  end

  defp template_matches?({cs, ci}, value, match_case),
    do: Regex.match?(if(match_case, do: cs, else: ci), value)

  @doc "The entries of list `id`, in a stable order (Random Number and Sender ID Template pick from them)."
  @spec list_entries(integer()) :: [String.t()]
  def list_entries(id) do
    case Map.get(snapshot().lists, id) do
      nil -> []
      list -> list.entries
    end
  end

  @doc "The content templates of a Sender ID Template entry."
  @spec templates(integer(), String.t()) :: [String.t()]
  def templates(id, value) do
    case Map.get(snapshot().lists, id) do
      nil -> []
      list -> Map.get(list.contents, value, [])
    end
  end

  @doc "Units of `currency` per 1 EUR (the base of the exchange rates), or nil."
  @spec per_eur(String.t()) :: float() | nil
  def per_eur(currency), do: Map.get(snapshot().fx, currency)

  @doc "An amount in `currency` converted to the platform currency at the latest exchange rate, or nil."
  @spec to_platform(number() | Decimal.t(), String.t()) :: float() | nil
  def to_platform(amount, currency) do
    s = snapshot()

    with from when is_number(from) and from > 0 <- Map.get(s.fx, currency),
         to when is_number(to) <- Map.get(s.fx, s.platform_currency) do
      round6(to_float(amount) / from * to)
    else
      _ -> nil
    end
  end

  defp to_float(%Decimal{} = d), do: Decimal.to_float(d)
  defp to_float(n) when is_integer(n), do: n * 1.0
  defp to_float(n), do: n

  # The mock rounds converted rates to 6 decimals (Math.round(x * 1e6) / 1e6).
  defp round6(x), do: Lcr.js_round(x * 1.0e6) / 1.0e6

  # ---------------------------------------------------------------- rates

  @doc false
  def rates_table, do: @rates

  @doc """
  The customer's rate for a destination (§5.4): the first of the trunk's rate tables, in order, with a current,
  unblocked line for the network, else for its country's All networks code.
  """
  @spec sell_rate(integer(), String.t(), integer()) :: rate() | nil
  def sell_rate(customer_trunk_id, mccmnc, now_ms) do
    case customer_trunk(customer_trunk_id) do
      nil ->
        nil

      trunk ->
        codes = codes(mccmnc)

        Enum.find_value(trunk.rate_table_ids, fn table ->
          Enum.find_value(codes, &line(table, &1, now_ms))
        end)
    end
  end

  @doc """
  A vendor trunk's buy rate for a destination: a current, unblocked line for the network in any of its rate tables,
  else for the country's All networks code.
  """
  @spec vendor_rate(integer(), String.t(), integer()) :: rate() | nil
  def vendor_rate(vendor_trunk_id, mccmnc, now_ms) do
    case vendor_trunk(vendor_trunk_id) do
      nil ->
        nil

      trunk ->
        Enum.find_value(codes(mccmnc), fn code ->
          Enum.find_value(trunk.rate_table_ids, &line(&1, code, now_ms))
        end)
    end
  end

  defp codes(<<mcc::binary-size(3), _::binary>> = mccmnc) when byte_size(mccmnc) > 3,
    do: [mccmnc, mcc]

  defp codes(mccmnc), do: [mccmnc]

  defp line(table, code, now) do
    case :ets.lookup(@rates, {table, code}) do
      [{_, lines}] -> lines |> Enum.find(&current?(&1, now)) |> rate_of(table, code)
      [] -> nil
    end
  end

  defp current?({from, to, _id, _micro, _currency, blocked}, now),
    do: not blocked and from <= now and (is_nil(to) or now < to)

  defp rate_of(nil, _table, _code), do: nil

  defp rate_of({_from, _to, id, micro, currency, _blocked}, table, code) do
    rate = Decimal.div(Decimal.new(micro), 1_000_000)

    case to_platform(micro / 1_000_000, currency) do
      nil ->
        nil

      platform ->
        %{
          rate_table_id: table,
          line_id: id,
          mccmnc: code,
          rate: rate,
          currency: currency,
          platform: platform
        }
    end
  end

  @doc """
  Every active vendor trunk with its buy rate for the destination in the platform currency (nil without one), its
  QBR quality there and its tier, for the route evaluator. Computed at most every few seconds per destination.
  """
  @spec vendor_options(String.t() | nil, integer()) :: %{integer() => Route.option()}
  def vendor_options(nil, _now_ms), do: %{}

  def vendor_options(mccmnc, now_ms) do
    case :ets.lookup(@options, mccmnc) do
      [{_, at, options}] when now_ms - at < @options_ttl_ms and now_ms >= at ->
        options

      _ ->
        options = build_options(mccmnc, now_ms)
        :ets.insert(@options, {mccmnc, now_ms, options})
        options
    end
  end

  defp build_options(mccmnc, now_ms) do
    s = snapshot()
    mcc = binary_part(mccmnc, 0, min(3, byte_size(mccmnc)))

    # QBR uses the destination's effective vendor DLR, falling back to its country's (QBR stats, §6.3).
    dest_dlr = s.quality_dlr[mccmnc] || s.quality_dlr[mcc] || %{}
    dest_q = s.quality[mccmnc] || s.quality[mcc] || %{}

    for {id, t} <- s.vendor_trunks, t.active, into: %{} do
      cost = vendor_rate(id, mccmnc, now_ms)
      q = Map.get(dest_q, id, %{})

      {id,
       %{
         vendor_trunk_id: id,
         name: t.name,
         cost: cost && cost.platform,
         dlr: Map.get(dest_dlr, id),
         category_id: t.product_category_id,
         asr: q[:asr],
         delay_s: q[:delay_s],
         tier: t.tier,
         # Live TPS against the limit comes with the live counters (§13.23); until then no vendor is at its limit.
         at_limit: false
       }}
    end
  end

  @doc false
  def options_table, do: @options

  @doc false
  def clear_options do
    if :ets.whereis(@options) != :undefined, do: :ets.delete_all_objects(@options)
    :ok
  end
end
