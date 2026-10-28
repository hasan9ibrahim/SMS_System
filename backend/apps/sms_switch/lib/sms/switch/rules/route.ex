defmodule Sms.Switch.Rules.Route do
  @moduledoc """
  Route rule evaluation (spec §6.3, §13.8, §13.9, §13.24, §13.27), a port of the mock's
  `mock/src/routing/evaluate.ts` and its `routeThrough` (`mock/src/api/routeRules.ts`), with the mock's tests, so the
  rule Test, the Route Simulator, Route Map and Rate Lookup on the screens give the same answer as the switch.

  Rules run in their order (highest priority first, then id). The first rule whose conditions match decides, unless
  it finds no usable vendor and says Continue routing YES (R3); a matched rule with a working vendor always wins.

  Inside a matched rule the vendor is chosen in this order: the number whitelist (§13.27), the warm-up threshold, then
  the route type: Least cost (with its LCR profile, §13.23) or Quality over every vendor in scope with a rate, or the
  rule's own levels (static or quality-ordered), split inside a level by percentage, top-down or round-robin, with
  backups. A vendor leaving less than the rule's margin, or whose own egress translation rules block the message
  (decided 2026-10-18), is skipped for the next one.

  Pure: the caller loads rules (`Rule.new/1` compiles their patterns), the message context and the vendor options.
  """
  import Bitwise
  alias Sms.Switch.Rules.{Lcr, Pattern, Values}

  @qbr_weights %{asr: 35, dlr: 35, delay: 20, cost: 10}

  defmodule Conditions do
    @moduledoc "The conditions of a route rule (§6.3), with its patterns compiled and its id lists as sets."

    defstruct category_mode: :all,
              category_ids: MapSet.new(),
              customer_trunk_mode: :all,
              customer_trunk_ids: MapSet.new(),
              mccmnc_mode: :all,
              mccmncs: MapSet.new(),
              mccmnc_pattern: nil,
              sender_pattern: nil,
              sender_pattern_negate: false,
              sender_match_case: true,
              receiver_pattern: nil,
              receiver_pattern_negate: false,
              sender_values: [],
              receiver_values: [],
              content_pattern: nil,
              content_pattern_negate: false,
              sender_list_id: nil,
              sender_list_negate: false,
              receiver_list_id: nil,
              receiver_list_negate: false,
              tps: nil,
              revenue: nil,
              hlr_ported: nil,
              compiled: %{}

    @type t :: %__MODULE__{}

    @doc false
    @spec new(Enumerable.t()) :: t()
    def new(fields) do
      c = struct!(__MODULE__, fields)

      %{
        c
        | category_ids: MapSet.new(c.category_ids),
          customer_trunk_ids: MapSet.new(c.customer_trunk_ids),
          mccmncs: MapSet.new(c.mccmncs),
          compiled: %{
            mccmnc: c.mccmnc_pattern && Pattern.compile(c.mccmnc_pattern),
            sender:
              c.sender_pattern &&
                Pattern.compile(c.sender_pattern, match_case: c.sender_match_case != false),
            # Receiver and content conditions ignore case.
            receiver:
              c.receiver_pattern && Pattern.compile(c.receiver_pattern, match_case: false),
            content: c.content_pattern && Pattern.compile(c.content_pattern, match_case: false)
          }
      }
    end
  end

  defmodule Rule do
    @moduledoc "One route rule: its conditions (`Conditions`) and how it picks a vendor, id lists as sets."

    defstruct [
      :id,
      :name,
      priority: 0,
      status: :active,
      starts_at: nil,
      stops_at: nil,
      continue_routing: :stop,
      match_mode: :all,
      conditions: %Conditions{},
      route_type: :static,
      hunt_policy: :top_down,
      margin: 0,
      margin_type: :amount,
      vendors: [],
      whitelists: [],
      qbr_weights: nil,
      percentage_per_customer_trunk: true,
      vendor_trunk_mode: :all,
      vendor_trunk_ids: MapSet.new(),
      vendor_category_mode: :all,
      vendor_category_ids: MapSet.new(),
      lcr_profile: nil,
      skip_vendor_at_tps_pct: nil
    ]

    @condition_keys %Conditions{} |> Map.from_struct() |> Map.keys()

    @type t :: %__MODULE__{}

    @doc """
    A rule from its fields, the condition fields among them. `starts_at` / `stops_at` are DateTimes (or unix ms); id
    lists become sets; vendors keep their saved order (level, backups last, share descending).
    """
    @spec new(map() | keyword()) :: t()
    def new(fields) do
      {conditions, fields} = Enum.split_with(fields, fn {k, _} -> k in @condition_keys end)
      r = struct!(__MODULE__, fields)

      %{
        r
        | starts_at: ms(r.starts_at, 0),
          stops_at: ms(r.stops_at, 253_402_300_799_000),
          conditions: conditions |> Conditions.new() |> tag_tps(r.id),
          vendor_trunk_ids: MapSet.new(r.vendor_trunk_ids),
          vendor_category_ids: MapSet.new(r.vendor_category_ids),
          whitelists: Enum.map(r.whitelists, &%{&1 | numbers: MapSet.new(&1.numbers)}),
          lcr_profile:
            r.lcr_profile && Map.update!(r.lcr_profile, :vendor_trunk_ids, &MapSet.new/1)
      }
    end

    # A live TPS condition keeps its hysteresis per rule (§13.8).
    defp tag_tps(c, id) do
      c = if c.tps, do: %{c | tps: Map.put(c.tps, :rule_id, id)}, else: c
      # Accumulated revenue may be measured on the rule's own traffic (§13.9).
      if c.revenue, do: %{c | revenue: Map.put(c.revenue, :rule_id, id)}, else: c
    end

    defp ms(nil, default), do: default
    defp ms(%DateTime{} = at, _), do: DateTime.to_unix(at, :millisecond)
    defp ms(at, _) when is_integer(at), do: at
  end

  @type context :: %{
          required(:now) => integer(),
          required(:customer_trunk_id) => integer() | nil,
          required(:category_id) => integer() | nil,
          required(:receiver) => String.t(),
          required(:sender) => String.t(),
          required(:content) => String.t(),
          required(:mccmnc) => String.t() | nil,
          required(:list_has?) => (integer(), String.t(), boolean() -> boolean()),
          optional(atom()) => term()
        }

  @type option :: %{
          required(:vendor_trunk_id) => integer(),
          required(:name) => String.t(),
          required(:cost) => float() | nil,
          optional(atom()) => term()
        }

  @type candidate :: %{
          vendor_trunk_id: integer(),
          name: String.t(),
          level: integer(),
          cost: float() | nil,
          margin: float() | nil,
          note: String.t() | nil
        }

  @type decision :: %{
          rule_id: integer(),
          route_type: atom(),
          matched: boolean(),
          checks: [map()],
          mccmnc: String.t() | nil,
          destination: String.t() | nil,
          sell_rate: float() | nil,
          outcome: :not_matched | :block | :route | :no_vendor,
          vendor: map() | nil,
          candidates: [candidate()]
        }

  # ---------------------------------------------------------------- small helpers

  @doc "Compares a measured value with a condition's operator; `=` allows ±`tolerance_pct` %."
  @spec compare(String.t(), number(), number(), number() | nil, number()) :: boolean()
  def compare(op, actual, value, value2, tolerance_pct \\ 5) do
    case op do
      ">" -> actual > value
      ">=" -> actual >= value
      "<" -> actual < value
      "<=" -> actual <= value
      "=" -> abs(actual - value) <= abs(value) * tolerance_pct / 100
      "between" -> between?(actual, value, value2 || value)
      _ -> false
    end
  end

  defp between?(actual, low, high), do: actual >= low and actual <= high

  defp in_mode(:all, _hit), do: true
  defp in_mode(:inclusive, hit), do: hit
  defp in_mode(_exclusive, hit), do: not hit

  @doc "Whether the rule's destination condition is a code list (R1: with both set, only the list counts)."
  @spec destination_list?(Rule.t()) :: boolean()
  def destination_list?(%Rule{conditions: c}), do: code_list?(c)

  defp code_list?(c), do: c.mccmnc_mode != :all and MapSet.size(c.mccmncs) > 0

  defp destination_set?(c), do: code_list?(c) or c.mccmnc_pattern != nil

  # The destination condition alone; true when the rule sets none.
  defp destination_ok?(c, mccmnc) do
    cond do
      not destination_set?(c) -> true
      is_nil(mccmnc) -> false
      code_list?(c) -> in_mode(c.mccmnc_mode, destination_hit?(c.mccmncs, mccmnc))
      true -> Pattern.match?(c.compiled.mccmnc, mccmnc)
    end
  end

  @doc "Exact codes only: a 3-digit code is the country's All networks entry, not the whole country."
  @spec destination_hit?(MapSet.t() | [String.t()], String.t()) :: boolean()
  def destination_hit?(codes, mccmnc), do: mccmnc in codes

  defp sender_case(c), do: c.sender_match_case != false

  defp live?(r, now), do: r.starts_at <= now and now < r.stops_at

  @doc """
  The stable bucket (0–99) of a percentage split: the same number always lands on the same vendor. JavaScript's
  `charCodeAt(0)` of each code point (the high surrogate outside the BMP), as the mock.
  """
  @spec bucket(String.t()) :: 0..99
  def bucket(text) do
    text
    |> String.to_charlist()
    |> Enum.reduce(0, fn cp, h -> rem(h * 31 + unit(cp), 1_000_003) end)
    |> rem(100)
  end

  defp unit(cp) when cp > 0xFFFF, do: 0xD800 + ((cp - 0x10000) >>> 10)
  defp unit(cp), do: cp

  # ---------------------------------------------------------------- conditions

  @doc """
  Whether a rule matches, without the check details: the same answer as `matches?(condition_checks(rule, m),
  rule.match_mode)`, for routing at speed. "all" stops at the first failed condition, "any" at the first passed one.
  """
  @spec quick_match?(Rule.t(), context()) :: boolean()
  def quick_match?(%Rule{status: status}, _m) when status != :active, do: false

  def quick_match?(%Rule{} = r, m) do
    if live?(r, m.now), do: quick_conditions(r, m), else: false
  end

  defp quick_conditions(%Rule{conditions: c} = r, m) do
    all = r.match_mode == :all

    result =
      Enum.reduce_while(conditions(c), false, fn cond, _set ->
        ok = condition_ok?(cond, c, m)
        if all != ok, do: {:halt, {:decided, ok}}, else: {:cont, true}
      end)

    case result do
      {:decided, ok} -> ok
      set -> all or not set
    end
  end

  @doc """
  Whether a rule's conditions other than its TPS condition let the message through (status, time and the rest, by
  the rule's match mode). The switch counts such a message against the rule's own TPS scope ("all traffic matching
  this rule", §13.8), whether or not this rule routes it.
  """
  @spec others_match?(Rule.t(), context()) :: boolean()
  def others_match?(%Rule{status: status}, _m) when status != :active, do: false

  def others_match?(%Rule{conditions: c} = r, m) do
    others = conditions(c) -- [:tps]

    live?(r, m.now) and
      case others do
        [] -> true
        _ when r.match_mode == :all -> Enum.all?(others, &condition_ok?(&1, c, m))
        _ -> Enum.any?(others, &condition_ok?(&1, c, m))
      end
  end

  # The conditions a rule sets, in the mock's order.
  defp conditions(c) do
    set = [
      category: c.category_mode != :all,
      trunk: c.customer_trunk_mode != :all,
      destination: destination_set?(c),
      sender: c.sender_pattern,
      receiver: c.receiver_pattern,
      sender_values: c.sender_values != [],
      receiver_values: c.receiver_values != [],
      content: c.content_pattern,
      sender_list: c.sender_list_id,
      receiver_list: c.receiver_list_id,
      tps: c.tps,
      revenue: c.revenue,
      hlr: c.hlr_ported != nil
    ]

    for {condition, value} <- set, value, do: condition
  end

  defp condition_ok?(:category, c, m),
    do: in_mode(c.category_mode, m.category_id != nil and m.category_id in c.category_ids)

  defp condition_ok?(:trunk, c, m),
    do:
      in_mode(
        c.customer_trunk_mode,
        m.customer_trunk_id != nil and m.customer_trunk_id in c.customer_trunk_ids
      )

  defp condition_ok?(:destination, c, m), do: destination_ok?(c, m.mccmnc)

  defp condition_ok?(:sender, c, m),
    do: Pattern.match?(c.compiled.sender, m.sender) != c.sender_pattern_negate

  defp condition_ok?(:receiver, c, m),
    do: Pattern.match?(c.compiled.receiver, m.receiver) != c.receiver_pattern_negate

  defp condition_ok?(:content, c, m),
    do: Pattern.match?(c.compiled.content, m.content) != c.content_pattern_negate

  # Value rows, each with its own match and case (team trial round 8); Negate as for the pattern.
  defp condition_ok?(:sender_values, c, m),
    do: Values.hit?(c.sender_values, m.sender) != c.sender_pattern_negate

  defp condition_ok?(:receiver_values, c, m),
    do: Values.hit?(c.receiver_values, m.receiver) != c.receiver_pattern_negate

  # Number lists match or, negated, must not match (R2, §6.3).
  defp condition_ok?(:sender_list, c, m),
    do: m.list_has?.(c.sender_list_id, m.sender, not sender_case(c)) != c.sender_list_negate

  defp condition_ok?(:receiver_list, c, m),
    do: m.list_has?.(c.receiver_list_id, m.receiver, false) != c.receiver_list_negate

  # The switch passes a function (its live counters with hysteresis, §13.8); the Route Simulator a number.
  defp condition_ok?(:tps, %{tps: t}, m), do: t |> tps_check(m) |> elem(0)

  defp condition_ok?(:revenue, %{revenue: rev}, m) do
    actual = revenue_of(rev, m)
    actual != nil and compare(rev.op, actual, rev.value, rev[:value2])
  end

  defp condition_ok?(:hlr, c, m), do: m[:hlr_ported] == c.hlr_ported

  # The switch passes a function for accumulated revenue (its live counters, §13.9); the Route Simulator a number.
  defp revenue_of(%{type: :per_message}, m), do: m[:sell_rate]

  defp revenue_of(rev, m) do
    case m[:accumulated_revenue] do
      f when is_function(f, 2) -> f.(rev[:rule_id], rev)
      value -> value
    end
  end

  # {matches?, measured TPS or nil}
  defp tps_check(t, m) do
    case m[:tps] do
      nil -> {false, nil}
      f when is_function(f, 2) -> f.(t[:rule_id], t)
      tps -> {compare(t.op, tps, t.value, t[:value2], t[:tolerance_pct] || 5), tps}
    end
  end

  @doc "Every condition check with its detail; `set` = the rule uses it, `gate` = status and time (always apply)."
  @spec condition_checks(Rule.t(), context()) :: [map()]
  def condition_checks(%Rule{} = r, m) do
    live = live?(r, m.now)

    gates = [
      check(
        "Status",
        r.status == :active,
        if(r.status == :active, do: "active", else: "the rule is off"),
        true
      ),
      check(
        "Time",
        live,
        if(live,
          do: "within start and stop time",
          else: "outside the rule's start and stop time"
        ),
        true
      )
    ]

    gates ++ Enum.map(conditions(r.conditions), &detailed(&1, r.conditions, m))
  end

  defp check(condition, ok, detail, gate \\ false),
    do: %{condition: condition, set: true, ok: ok, detail: detail, gate: gate}

  defp detailed(:category, c, m) do
    hit = m.category_id != nil and m.category_id in c.category_ids

    check(
      "Category",
      in_mode(c.category_mode, hit),
      if(is_nil(m.category_id),
        do: "no customer trunk given",
        else: "#{c.category_mode} list #{if hit, do: "has", else: "lacks"} the trunk's category"
      )
    )
  end

  defp detailed(:trunk, c, m) do
    hit = m.customer_trunk_id != nil and m.customer_trunk_id in c.customer_trunk_ids

    check(
      "Trunk",
      in_mode(c.customer_trunk_mode, hit),
      if(is_nil(m.customer_trunk_id),
        do: "no customer trunk given",
        else: "#{c.customer_trunk_mode} list #{if hit, do: "has", else: "lacks"} the trunk"
      )
    )
  end

  defp detailed(:destination, c, m) do
    cond do
      is_nil(m.mccmnc) ->
        check("Destination", false, "destination unknown")

      code_list?(c) ->
        hit = destination_hit?(c.mccmncs, m.mccmnc)

        detail =
          "destination #{m.mccmnc} #{if hit, do: "is", else: "isn't"} in the #{c.mccmnc_mode} list" <>
            if(c.mccmnc_pattern, do: " (the list wins over the pattern)", else: "")

        check("Destination", in_mode(c.mccmnc_mode, hit), detail)

      true ->
        ok = Pattern.match?(c.compiled.mccmnc, m.mccmnc)

        check(
          "Destination",
          ok,
          "destination #{m.mccmnc} #{if ok, do: "matches", else: "doesn't match"} the pattern"
        )
    end
  end

  defp detailed(:sender, c, m) do
    note = if sender_case(c), do: "", else: " (any case)"

    pattern_check(
      "Sender",
      c.sender_pattern,
      c.compiled.sender,
      c.sender_pattern_negate,
      m.sender,
      note
    )
  end

  defp detailed(:receiver, c, m),
    do:
      pattern_check(
        "Receiver",
        c.receiver_pattern,
        c.compiled.receiver,
        c.receiver_pattern_negate,
        m.receiver,
        ""
      )

  defp detailed(:sender_values, c, m),
    do: values_check("Sender", c.sender_values, c.sender_pattern_negate, m.sender)

  defp detailed(:receiver_values, c, m),
    do: values_check("Receiver", c.receiver_values, c.receiver_pattern_negate, m.receiver)

  defp detailed(:content, c, m),
    do:
      pattern_check(
        "Content",
        c.content_pattern,
        c.compiled.content,
        c.content_pattern_negate,
        m.content,
        ""
      )

  defp detailed(:sender_list, c, m) do
    hit = m.list_has?.(c.sender_list_id, m.sender, not sender_case(c))
    neg = c.sender_list_negate

    check(
      "Sender list",
      hit != neg,
      "#{if hit, do: "sender is in the list", else: "sender isn't in the list"}#{if neg, do: " (must not be)", else: ""}" <>
        if(sender_case(c), do: "", else: " (any case)")
    )
  end

  defp detailed(:receiver_list, c, m) do
    hit = m.list_has?.(c.receiver_list_id, m.receiver, false)
    neg = c.receiver_list_negate

    check(
      "Receiver list",
      hit != neg,
      "#{if hit, do: "number is in the list", else: "number isn't in the list"}#{if neg, do: " (must not be)", else: ""}"
    )
  end

  defp detailed(:tps, %{tps: t}, m) do
    {ok, tps} = tps_check(t, m)

    detail =
      if tps == nil,
        do: "no simulated TPS",
        else:
          "#{Lcr.num(tps)} #{t.op} #{Lcr.num(t.value)}#{if t.op == "between", do: "–#{Lcr.num(t[:value2])}", else: ""}" <>
            " (#{t[:scope]}, #{t[:window_s] || 5}s)"

    check("TPS", ok, detail)
  end

  defp detailed(:revenue, %{revenue: rev} = c, m) do
    actual = revenue_of(rev, m)

    detail =
      cond do
        actual == nil and rev.type == :per_message ->
          "no customer rate for this destination"

        actual == nil ->
          "no simulated accumulated revenue"

        rev.type == :per_message ->
          "per message #{Lcr.num(actual)} #{rev.op} #{Lcr.num(rev.value)}"

        true ->
          "accumulated #{rev[:period] || ""} #{Lcr.num(actual)} #{rev.op} #{Lcr.num(rev.value)}"
      end

    check("Revenue", condition_ok?(:revenue, c, m), detail)
  end

  defp detailed(:hlr, c, m) do
    detail =
      case m[:hlr_ported] do
        nil -> "no HLR result"
        true -> "number is ported"
        false -> "number is not ported"
      end

    check("HLR ported", condition_ok?(:hlr, c, m), detail)
  end

  defp values_check(name, rows, negate, value) do
    hit = Values.hit?(rows, value)

    check(
      name,
      if(negate, do: not hit, else: hit),
      "\"#{value}\" #{if hit, do: "matches", else: "doesn't match"} #{if negate, do: "not ", else: ""}#{Values.text(rows)}"
    )
  end

  defp pattern_check(name, pattern, re, negate, value, note) do
    hit = Pattern.match?(re, value)

    check(
      name,
      if(negate, do: not hit, else: hit),
      "\"#{value}\" #{if hit, do: "matches", else: "doesn't match"} #{if negate, do: "not ", else: ""}#{pattern}#{note}"
    )
  end

  @doc "Whether the checks pass: every gate, then all (or any) of the set conditions; none set always matches."
  @spec matches?([map()], :all | :any) :: boolean()
  def matches?(checks, mode) do
    if Enum.any?(checks, &(&1.gate and not &1.ok)) do
      false
    else
      case Enum.filter(checks, &(not &1.gate and &1.set)) do
        [] -> true
        conds when mode == :all -> Enum.all?(conds, & &1.ok)
        conds -> Enum.any?(conds, & &1.ok)
      end
    end
  end

  # ---------------------------------------------------------------- quality order

  @doc """
  Quality score of a vendor for a Quality (QBR) rule, 0–1 (decided 2026-10-18): ASR and DLR 35 % each, delay 20 %, cost
  10 % unless the rule sets its own weights. Delay scores 1 at 0 s down to 0 at 60 s; cost scores the cheapest of the
  pool as 1; a missing figure counts as neutral (0.5).
  """
  @spec qbr_score(map(), number() | nil, map() | nil) :: float()
  def qbr_score(o, cheapest, weights \\ nil) do
    w = weights || @qbr_weights
    sum = w.asr + w.dlr + w.delay + w.cost
    sum = if sum == 0, do: 1, else: sum
    pct = fn v -> if is_nil(v), do: 0.5, else: min(1, max(0, v / 100)) end
    delay = if is_nil(o[:delay_s]), do: 0.5, else: 1 - min(60, max(0, o.delay_s)) / 60
    cost = if is_nil(o[:cost]) or cheapest in [nil, 0], do: 0.5, else: min(1, cheapest / o.cost)
    (w.asr * pct.(o[:asr]) + w.dlr * pct.(o[:dlr]) + w.delay * delay + w.cost * cost) / sum
  end

  @doc "Best quality first, cheaper first on a tie."
  @spec by_qbr([map()], map() | nil) :: [map()]
  def by_qbr(xs, weights \\ nil) do
    costs = for x <- xs, is_number(x[:cost]) and x[:cost] > 0, do: x.cost
    cheapest = if costs == [], do: nil, else: Enum.min(costs)

    xs
    |> Enum.map(&{&1, qbr_score(&1, cheapest, weights)})
    |> Enum.sort(fn {a, sa}, {b, sb} ->
      if sa != sb, do: sa > sb, else: cost_or_inf(a) <= cost_or_inf(b)
    end)
    |> Enum.map(&elem(&1, 0))
  end

  defp cost_or_inf(x), do: x[:cost] || :infinity

  # ---------------------------------------------------------------- decision

  @doc "The decision of one rule for a message, with the checks and the candidates tried."
  @spec decide(Rule.t(), context(), %{integer() => option()}) :: decision()
  def decide(%Rule{} = rule, m, options) do
    checks = condition_checks(rule, m)
    matched = matches?(checks, rule.match_mode)

    base = %{
      rule_id: rule.id,
      route_type: rule.route_type,
      matched: matched,
      checks: Enum.map(checks, &Map.take(&1, [:condition, :ok, :detail])),
      mccmnc: m.mccmnc,
      destination: m[:destination],
      sell_rate: m[:sell_rate],
      outcome: :not_matched,
      vendor: nil,
      candidates: []
    }

    cond do
      not matched -> base
      rule.route_type == :block -> %{base | outcome: :block}
      true -> choose(rule, m, options, base)
    end
  end

  defp choose(rule, m, options, base) do
    ctx = %{rule: rule, m: m, options: options}

    with :none <- whitelist(ctx),
         :none <- warmup(ctx) do
      if rule.route_type == :dynamic or (rule.route_type == :qbr and rule.vendors == []),
        do: pool(ctx, base),
        else: levels(ctx, base)
    else
      {:route, c, decided_by} ->
        %{base | outcome: :route, vendor: vendor(c, decided_by), candidates: [c]}
    end
  end

  defp vendor(c, decided_by),
    do: %{
      vendor_trunk_id: c.vendor_trunk_id,
      name: c.name,
      level: c.level,
      decided_by: decided_by
    }

  defp candidate(ctx, id, level, note) do
    o = Map.get(ctx.options, id)
    cost = o && o.cost

    %{
      vendor_trunk_id: id,
      name: (o && o.name) || "Trunk #{id}",
      level: level,
      cost: cost,
      margin: margin_of(cost, ctx.m[:sell_rate]),
      note: note
    }
  end

  defp margin_of(nil, _sell), do: nil
  defp margin_of(_cost, nil), do: nil
  defp margin_of(cost, sell), do: Lcr.js_round((sell - cost) * 1.0e6) / 1.0e6

  # Vendors leaving less than the rule's margin are skipped: an amount per message, or a % of the sell rate; either
  # may be negative (team trial round 1).
  defp margin_ok?(%{margin: nil}, _ctx), do: true

  defp margin_ok?(c, %{rule: %{margin_type: :percent} = rule, m: m}) do
    sell = m[:sell_rate]
    is_nil(sell) or sell <= 0 or c.margin / sell * 100 >= rule.margin
  end

  defp margin_ok?(c, %{rule: rule}), do: c.margin >= rule.margin

  defp usable?(c, ctx),
    do: not egress_blocked?(c, ctx) and margin_ok?(c, ctx) and not tps_full?(c, ctx)

  # §13.8 vendor capacity option: a vendor at the rule's % of its TPS limit is skipped, so the next level takes it.
  defp tps_full?(c, %{rule: %{skip_vendor_at_tps_pct: pct}, m: m}) when is_integer(pct),
    do: vendor_tps_pct(m, c.vendor_trunk_id) >= pct

  defp tps_full?(_c, _ctx), do: false

  defp vendor_tps_pct(m, id) do
    case m[:vendor_tps_pct] do
      f when is_function(f, 1) -> f.(id)
      _ -> 0
    end
  end

  defp egress_blocked?(c, ctx), do: c.vendor_trunk_id in (ctx.m[:egress_blocked] || MapSet.new())

  defp skip_why(c, ctx) do
    cond do
      egress_blocked?(c, ctx) ->
        "blocked by its vendor translation rule"

      tps_full?(c, ctx) ->
        "at #{ctx.rule.skip_vendor_at_tps_pct} % of its TPS limit"

      true ->
        "margin below #{Lcr.num(ctx.rule.margin)}#{if ctx.rule.margin_type == :percent, do: " %", else: ""}"
    end
  end

  # 1. Number whitelist pinned to a vendor (§13.27).
  defp whitelist(%{rule: rule, m: m} = ctx) do
    case Enum.find(rule.whitelists, fn w ->
           m.receiver in w.numbers or
             (w.number_list_id != nil and m.list_has?.(w.number_list_id, m.receiver, false))
         end) do
      nil -> :none
      w -> {:route, candidate(ctx, w.vendor_trunk_id, 1, "number whitelist"), :whitelist}
    end
  end

  # 2. Warm-up threshold: the first N messages go to that vendor. `warmup_sent` is a number (the Route Simulator) or a
  # function of the rule and the vendor giving that vendor's own count, nil when unknown (the switch,
  # `Sms.Switch.Pipeline.Warmup`); an unknown count is treated as warmed up.
  defp warmup(%{rule: rule, m: m} = ctx) do
    sent_of = fn v ->
      case m[:warmup_sent] do
        f when is_function(f, 2) -> f.(rule, v)
        n -> n || 0
      end
    end

    warm =
      rule.vendors
      |> Enum.sort_by(& &1.level)
      |> Enum.find_value(fn v ->
        with n when n not in [nil, 0] <- v[:warmup_count],
             sent when is_integer(sent) and sent < n <- sent_of.(v) do
          {v, sent}
        else
          _ -> nil
        end
      end)

    case warm do
      nil ->
        :none

      {v, sent} ->
        {:route, candidate(ctx, v.vendor_trunk_id, v.level, "warm-up #{sent}/#{v.warmup_count}"),
         :warmup}
    end
  end

  # 3. Least cost and quality: every vendor in scope with a rate for the destination.
  defp pool(%{rule: rule, options: options} = ctx, base) do
    listed = MapSet.new(rule.vendors, & &1.vendor_trunk_id)

    pool =
      options
      |> Map.values()
      |> Enum.sort_by(& &1.vendor_trunk_id)
      |> Enum.filter(&(&1.cost != nil and in_scope?(rule, listed, &1)))

    pool =
      if rule.route_type == :qbr,
        do: by_qbr(pool, rule.qbr_weights),
        else: Enum.sort(pool, &(&1.cost <= &2.cost))

    candidates =
      if rule.route_type == :dynamic and rule.lcr_profile,
        do: lcr_candidates(ctx, pool),
        else: pool_candidates(ctx, pool)

    candidates =
      Enum.map(candidates, fn c ->
        if usable?(c, ctx), do: c, else: %{c | note: skip_why(c, ctx)}
      end)

    case Enum.find(candidates, &usable?(&1, ctx)) do
      nil ->
        %{base | outcome: :no_vendor, candidates: candidates}

      pick ->
        decided_by = if rule.route_type == :qbr, do: :qbr, else: :lcr
        %{base | outcome: :route, vendor: vendor(pick, decided_by), candidates: candidates}
    end
  end

  defp in_scope?(rule, listed, o) do
    trunk_ok =
      if MapSet.size(listed) > 0,
        do: o.vendor_trunk_id in listed,
        else: in_mode(rule.vendor_trunk_mode, o.vendor_trunk_id in rule.vendor_trunk_ids)

    trunk_ok and
      in_mode(
        rule.vendor_category_mode,
        o[:category_id] != nil and o.category_id in rule.vendor_category_ids
      )
  end

  # An LCR profile filters, orders and splits the vendors (§13.23).
  defp lcr_candidates(%{rule: rule, m: m} = ctx, pool) do
    pool
    |> Enum.map(&lcr_candidate(&1, m))
    |> Lcr.rank(rule.lcr_profile)
    |> Enum.filter(& &1.pick)
    |> Lcr.split_pick(bucket(m.receiver))
    |> Enum.with_index(1)
    |> Enum.map(fn {r, i} -> candidate(ctx, r.c.vendor_trunk_id, i, share_note(r.share)) end)
  end

  defp share_note(nil), do: nil
  defp share_note(share), do: "#{Lcr.num(share)}%"

  defp pool_candidates(ctx, pool) do
    pool
    |> Enum.take(10)
    |> Enum.with_index(1)
    |> Enum.map(fn {o, i} -> candidate(ctx, o.vendor_trunk_id, i, nil) end)
  end

  defp lcr_candidate(o, m) do
    %{
      vendor_trunk_id: o.vendor_trunk_id,
      cost: o.cost,
      asr: o[:asr],
      dlr: o[:dlr],
      delay_s: o[:delay_s],
      tier: o[:tier],
      at_limit: o[:at_limit] || vendor_tps_pct(m, o.vendor_trunk_id) >= 100
    }
  end

  # 4. Static (and QBR with listed vendors): levels in order, the split inside a level, then backups.
  defp levels(%{rule: rule} = ctx, base) do
    levels =
      rule.vendors
      |> Enum.reject(& &1.is_backup)
      |> Enum.map(& &1.level)
      |> Enum.uniq()
      |> Enum.sort()

    {result, candidates} =
      Enum.reduce_while(levels, {nil, []}, fn level, {_, acc} ->
        case try_level(ctx, level, acc) do
          {:route, c, decided_by, acc} -> {:halt, {{c, decided_by}, acc}}
          {:none, acc} -> {:cont, {nil, acc}}
        end
      end)

    {result, candidates} = if result, do: {result, candidates}, else: last_resort(ctx, candidates)

    case result do
      nil ->
        %{base | outcome: :no_vendor, candidates: Enum.reverse(candidates)}

      {c, decided_by} ->
        %{
          base
          | outcome: :route,
            vendor: vendor(c, decided_by),
            candidates: Enum.reverse(candidates)
        }
    end
  end

  defp try_level(%{rule: rule} = ctx, level, acc) do
    at = Enum.filter(rule.vendors, &(&1.level == level and not &1.is_backup))
    {ordered, decided_by} = level_order(ctx, at)

    Enum.reduce_while(ordered, {:none, acc}, fn v, {:none, acc} ->
      try_vendor(ctx, v, level, decided_by, acc)
    end)
  end

  # The vendors of a level in the order they are tried, and what decided it.
  defp level_order(%{rule: %{route_type: :qbr} = rule, options: options}, at) do
    none = %{asr: nil, dlr: nil, delay_s: nil, cost: nil}

    ordered =
      at
      |> Enum.map(fn v ->
        {v,
         Map.merge(
           none,
           Map.take(Map.get(options, v.vendor_trunk_id, %{}), [:asr, :dlr, :delay_s, :cost])
         )}
      end)
      |> Enum.map(fn {v, q} -> Map.put(q, :__vendor, v) end)
      |> by_qbr(rule.qbr_weights)
      |> Enum.map(& &1.__vendor)

    {ordered, :qbr}
  end

  defp level_order(%{rule: %{hunt_policy: :percentage} = rule, m: m}, at) do
    # Each customer trunk's own traffic follows the shares unless switched off (team trial round 1).
    key =
      if rule.percentage_per_customer_trunk == false,
        do: m.receiver,
        else: "#{m.customer_trunk_id || 0}:#{m.receiver}"

    {first_over(at, & &1[:share_pct], bucket(key)), :percentage}
  end

  defp level_order(%{rule: %{hunt_policy: :round_robin}, m: m}, at) do
    start = if at == [], do: 0, else: rem(bucket(m.receiver), length(at))
    {Enum.drop(at, start) ++ Enum.take(at, start), :round_robin}
  end

  defp level_order(_ctx, at), do: {at, :top_down}

  defp try_vendor(ctx, v, level, decided_by, acc) do
    c = candidate(ctx, v.vendor_trunk_id, level, share_note(v[:share_pct]))

    if usable?(c, ctx) do
      {:halt, {:route, c, decided_by, [c | acc]}}
    else
      c = %{c | note: skip_why(c, ctx)}

      case try_backups(ctx, v, c, level, [c | acc]) do
        {:route, bc, acc} -> {:halt, {:route, bc, decided_by, acc}}
        {:none, acc} -> {:cont, {:none, acc}}
      end
    end
  end

  # Backups of one vendor stand in for it first (team trial round 1).
  defp try_backups(ctx, v, c, level, acc) do
    ctx
    |> backups_of(v.vendor_trunk_id)
    |> Enum.reduce_while({:none, acc}, fn bv, {:none, acc} ->
      try_backup(ctx, bv, c, level, acc)
    end)
  end

  defp try_backup(ctx, bv, c, level, acc) do
    extra = if bv[:share_pct] in [nil, 0], do: "", else: " (#{Lcr.num(bv.share_pct)}%)"
    bc = candidate(ctx, bv.vendor_trunk_id, level, "backup for #{c.name}#{extra}")

    if usable?(bc, ctx),
      do: {:halt, {:route, bc, [bc | acc]}},
      else: {:cont, {:none, [%{bc | note: "#{bc.note}; #{skip_why(bc, ctx)}"} | acc]}}
  end

  defp backups_of(%{rule: rule, m: m}, id) do
    bs = Enum.filter(rule.vendors, &(&1.is_backup and &1[:backup_for_vendor_trunk_id] == id))

    if length(bs) < 2, do: bs, else: split_backups(bs, m)
  end

  # Split the vendor's traffic between its backups by their share %.
  defp split_backups(bs, m) do
    b = bucket("#{m.receiver}:b")
    total = bs |> Enum.map(&(&1[:share_pct] || 0)) |> Enum.sum()
    total = if total == 0, do: length(bs), else: total
    equal = total == length(bs)
    weight = fn v -> (v[:share_pct] || if(equal, do: 1, else: 0)) * 100 / total end
    first_over(bs, weight, b)
  end

  # The first entry whose running total passes the bucket goes first; else the first entry.
  defp first_over([], _weight, _b), do: []

  defp first_over([head | _] = list, weight, b) do
    hit =
      list
      |> Enum.reduce_while(0, fn v, acc ->
        acc = acc + (weight.(v) || 0)
        if acc > b, do: {:halt, {:hit, v}}, else: {:cont, acc}
      end)
      |> case do
        {:hit, v} -> v
        _ -> head
      end

    [hit | List.delete(list, hit)]
  end

  # Backups for no vendor in particular: the rule's last resort, top-down.
  defp last_resort(%{rule: rule} = ctx, acc) do
    rule.vendors
    |> Enum.filter(&(&1.is_backup and is_nil(&1[:backup_for_vendor_trunk_id])))
    |> Enum.reduce_while({nil, acc}, fn v, {nil, acc} ->
      c = candidate(ctx, v.vendor_trunk_id, v.level, "backup route")

      if usable?(c, ctx),
        do: {:halt, {{c, :top_down}, [c | acc]}},
        else: {:cont, {nil, [c | acc]}}
    end)
  end

  # ---------------------------------------------------------------- through every rule

  @doc """
  Runs a message through the rules in order, as the switch does: the first matching rule decides, unless it finds no
  vendor and says Continue routing YES (R3). `keep` limits how many tried rules are listed (0: none, fastest).
  """
  @spec route_through([Rule.t()], context(), %{integer() => option()}, non_neg_integer()) ::
          %{tried: [map()], decision: decision() | nil}
  def route_through(rules, m, options, keep \\ 100) do
    result =
      Enum.reduce_while(rules, [], fn rule, tried ->
        if keep == 0 and not quick_match?(rule, m),
          do: {:cont, tried},
          else: route_step(rule, m, options, keep, tried)
      end)

    case result do
      {:decided, tried, d} -> %{tried: tried |> Enum.reverse() |> Enum.take(-keep), decision: d}
      tried -> %{tried: tried |> Enum.reverse() |> Enum.take(-keep), decision: nil}
    end
  end

  defp route_step(rule, m, options, keep, tried) do
    d = decide(rule, m, options)

    tried =
      if keep > 0 and (d.matched or length(tried) < keep),
        do: [tried_entry(rule, d) | tried],
        else: tried

    cond do
      not d.matched -> {:cont, tried}
      d.outcome == :no_vendor and rule.continue_routing == :yes -> {:cont, tried}
      true -> {:halt, {:decided, tried, d}}
    end
  end

  defp tried_entry(rule, d) do
    failed = Enum.find(d.checks, &(not &1.ok))

    reason =
      cond do
        not d.matched ->
          "#{(failed && failed.condition) || "condition"}: #{(failed && failed.detail) || "no match"}"

        d.outcome == :route ->
          "routes to #{d.vendor.name} (#{d.vendor.decided_by})"

        d.outcome == :block ->
          "blocks the message"

        true ->
          "no vendor qualifies"
      end

    %{
      rule_id: rule.id,
      name: rule.name,
      priority: rule.priority,
      matched: d.matched,
      reason: reason
    }
  end

  # ---------------------------------------------------------------- destination index

  @doc """
  Indexes rules by destination code once per configuration load: an "all must match" rule with an inclusive code
  list is looked up by code, every other rule is checked for every destination. Positions keep the evaluation order.
  """
  @spec index([Rule.t()]) :: %{
          rules: tuple(),
          general: [non_neg_integer()],
          by_code: %{String.t() => [non_neg_integer()]}
        }
  def index(rules) do
    {general, by_code} =
      rules
      |> Enum.with_index()
      |> Enum.reduce({[], %{}}, fn {r, i}, {general, by_code} ->
        if by_code?(r),
          do: {general, add_codes(by_code, r.conditions.mccmncs, i)},
          else: {[i | general], by_code}
      end)

    %{
      rules: List.to_tuple(rules),
      general: Enum.reverse(general),
      by_code: Map.new(by_code, fn {c, is} -> {c, Enum.reverse(is)} end)
    }
  end

  defp by_code?(r),
    do: r.match_mode == :all and r.conditions.mccmnc_mode == :inclusive and destination_list?(r)

  defp add_codes(by_code, codes, i),
    do: Enum.reduce(codes, by_code, fn c, acc -> Map.update(acc, c, [i], &[i | &1]) end)

  @doc """
  The rules that can still match a message to this destination at `now`, in order: on, live, and (for "all must
  match" rules) with a destination condition that passes. Routing through them gives the same answer as through all.
  """
  @spec rules_for_destination(map(), String.t() | nil, integer()) :: [Rule.t()]
  def rules_for_destination(%{rules: rules, general: general, by_code: by_code}, mccmnc, now) do
    (general ++ Map.get(by_code, mccmnc || "", []))
    |> Enum.sort()
    |> Enum.dedup()
    |> Enum.map(&elem(rules, &1))
    |> Enum.filter(fn r ->
      r.status == :active and live?(r, now) and
        (r.match_mode != :all or destination_ok?(r.conditions, mccmnc))
    end)
  end
end
