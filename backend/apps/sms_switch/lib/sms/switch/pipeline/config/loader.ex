defmodule Sms.Switch.Pipeline.Config.Loader do
  @moduledoc """
  Reads the pipeline's configuration from PostgreSQL (the rows the screens edit) and builds the in-memory snapshot of
  `Sms.Switch.Pipeline.Config`. The queries follow the mock's (`mock/src/api/routeRules.ts`, `translationRules.ts`,
  `trunks.ts`), so the switch sees the same rules, order and rates as the rule Test and the Route Simulator.

  A row the switch cannot read (an unknown enum value) is left out and logged, never stopping the rest from loading.
  """
  require Logger
  alias Sms.Core.Repo
  alias Sms.Switch.Rules.{Pattern, Route, Translation}

  @timeout 30_000

  # ---------------------------------------------------------------- change detection

  # One cheap query whose result changes whenever anything the snapshot holds changes. Tables with updated_at use
  # count + latest change; the others are small and hashed whole.
  @fingerprint """
  SELECT concat_ws('|',
    (SELECT md5(coalesce(string_agg(r::text, ',' ORDER BY r.id), '')) FROM route_rules r),
    (SELECT md5(coalesce(string_agg(v::text, ',' ORDER BY v.id), '')) FROM route_rule_vendors v),
    (SELECT md5(coalesce(string_agg(w::text, ',' ORDER BY w.id), '')) FROM route_rule_whitelists w),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM translation_rules t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM translation_rule_targets t),
    (SELECT md5(coalesce(string_agg(s::text, ',' ORDER BY s.id), '')) FROM translation_rule_trunk_settings s),
    (SELECT md5(coalesce(string_agg(l::text, ',' ORDER BY l.id), '')) FROM lcr_profiles l),
    (SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x.customer_trunk_id, x.position), '')) FROM customer_trunk_rate_tables x),
    (SELECT md5(coalesce(string_agg(c::text, ',' ORDER BY c.iso), '')) FROM currency_latest c),
    (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') FROM number_lists),
    (SELECT count(*) || ':' || coalesce(sum(id), 0) || ':' || coalesce(max(inserted_at)::text, '') || ':' ||
            coalesce(max(deleted_at)::text, '') FROM number_list_entries),
    (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') FROM customer_trunks),
    (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') FROM vendor_trunks),
    (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') FROM enterprises),
    (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') FROM business_companies),
    (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') FROM rate_tables),
    (SELECT count(*) || ':' || coalesce(sum(id), 0) || ':' || coalesce(max(updated_at)::text, '') FROM dial_codes),
    (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') FROM mccmnc),
    (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') FROM countries),
    (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') || ':' || coalesce(max(refreshed_at)::text, '')
       FROM qbr_stats))
  """

  @doc "A value that changes whenever anything in the snapshot changes."
  @spec fingerprint() :: {:ok, String.t()} | {:error, term()}
  def fingerprint do
    with {:ok, %{rows: [[fp]]}} <- query(@fingerprint, []), do: {:ok, fp}
  end

  # Per rate table: lines still current or scheduled. A change, a new line, a deletion or a line expiring changes it.
  @rate_fingerprints """
  SELECT rate_table_id, count(*) || ':' || sum(id) || ':' || max(updated_at)::text
    FROM rate_lines
   WHERE (valid_to IS NULL OR valid_to > now()) AND sender_id IS NULL
   GROUP BY rate_table_id
  """

  @doc "Each rate table's fingerprint (tables without current or scheduled lines are absent)."
  @spec rate_fingerprints() :: {:ok, %{integer() => String.t()}} | {:error, term()}
  def rate_fingerprints do
    with {:ok, %{rows: rows}} <- query(@rate_fingerprints, []),
         do: {:ok, Map.new(rows, &List.to_tuple/1)}
  end

  # ---------------------------------------------------------------- rate lines

  @rate_lines """
  SELECT rate_table_id, id, mccmnc, rate, trim(currency), valid_from, valid_to, is_blocked
    FROM rate_lines
   WHERE rate_table_id = ANY($1) AND (valid_to IS NULL OR valid_to > now()) AND sender_id IS NULL
  """

  @doc """
  The current and scheduled generic lines (no Sender ID) of these rate tables: `%{table => %{mccmnc => [line]}}`, each
  list newest first. Tables without such lines map to `%{}`.
  """
  @spec load_rates([integer()]) ::
          {:ok, %{integer() => %{String.t() => [map()]}}} | {:error, term()}
  def load_rates(table_ids) do
    with {:ok, %{rows: rows}} <- query(@rate_lines, [table_ids]) do
      {:ok, build_rates(table_ids, rows)}
    end
  end

  @doc false
  # A line is a compact tuple {from_ms, to_ms | nil, line_id, micro_rate, currency, blocked} (half a million of them are
  # held in memory): the rate in millionths is exact for numeric(12,6).
  def build_rates(table_ids, rows) do
    empty = Map.new(table_ids, &{&1, %{}})

    rows
    |> Enum.reduce(empty, fn [table, id, mccmnc, rate, currency, from, to, blocked], acc ->
      line = {ms(from), to && ms(to), id, micro(rate), :binary.copy(currency), blocked}

      Map.update(acc, table, %{mccmnc => [line]}, fn by_code ->
        Map.update(by_code, mccmnc, [line], &[line | &1])
      end)
    end)
    |> Map.new(fn {table, by_code} ->
      {table,
       Map.new(by_code, fn {code, lines} ->
         {code, Enum.sort_by(lines, &{elem(&1, 0), elem(&1, 2)}, :desc)}
       end)}
    end)
  end

  defp micro(%Decimal{} = d),
    do: d |> Decimal.mult(1_000_000) |> Decimal.round(0) |> Decimal.to_integer()

  defp ms(%DateTime{} = at), do: DateTime.to_unix(at, :millisecond)

  # ---------------------------------------------------------------- snapshot

  @doc "Every dataset of the snapshot, read in one repeatable-read transaction so they agree with each other."
  @spec load_snapshot(String.t()) :: {:ok, map()} | {:error, term()}
  def load_snapshot(platform_currency) do
    result =
      Repo.transaction(
        fn ->
          {:ok, _} =
            Repo.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY", [],
              log: false
            )

          rows = Map.new(queries(), fn {name, sql} -> {name, rows!(sql)} end)
          build_snapshot(rows, platform_currency)
        end,
        timeout: @timeout
      )

    case result do
      {:ok, snapshot} -> {:ok, snapshot}
      {:error, reason} -> {:error, reason}
    end
  rescue
    e -> {:error, Exception.message(e)}
  end

  defp queries do
    [
      destinations: """
      SELECT d.prefix, m.id, m.mccmnc, trim(m.mcc), m.mnc, m.network, m.is_all_networks, trim(co.iso), co.name
        FROM dial_codes d JOIN mccmnc m ON m.id = d.mccmnc_id JOIN countries co ON co.id = m.country_id
       WHERE d.profile = 'All' AND d.deleted_at IS NULL AND m.deleted_at IS NULL
      """,
      customer_trunks: """
      SELECT t.id, t.name, t.enterprise_id, e.business_company_id, trim(bc.base_currency) AS base_currency,
             t.product_category_id, t.billing_type, t.status = 'active' AND e.status = 'active' AS active,
             e.account_manager_id, t.default_coding, t.dlr_session_affinity, t.dlr_hold_hours, t.delayed_submit,
             t.loop_detection, t.reassembly_timeout_s, t.duplicate_window_s, t.allow_empty_messages,
             coalesce((SELECT array_agg(x.rate_table_id ORDER BY x.position, x.rate_table_id)
                         FROM customer_trunk_rate_tables x JOIN rate_tables rt ON rt.id = x.rate_table_id
                        WHERE x.customer_trunk_id = t.id AND rt.deleted_at IS NULL), '{}') AS rate_table_ids
        FROM customer_trunks t JOIN enterprises e ON e.id = t.enterprise_id
        JOIN business_companies bc ON bc.id = e.business_company_id
       WHERE t.deleted_at IS NULL AND e.deleted_at IS NULL
      """,
      vendor_trunks: """
      SELECT t.id, t.name, t.enterprise_id, t.product_category_id, t.billing_type,
             t.status = 'active' AND e.status = 'active' AS active, e.account_manager_id, e.tier, t.dlr_timeout_s,
             t.dlr_timeout_stat, t.reroute_on, t.tps, t.max_connections, t.support_multipart, t.max_msg_len,
             t.multipart_format,
             coalesce((SELECT array_agg(rt.id ORDER BY rt.id) FROM rate_tables rt
                        WHERE rt.vendor_trunk_id = t.id AND rt.deleted_at IS NULL), '{}') AS rate_table_ids
        FROM vendor_trunks t JOIN enterprises e ON e.id = t.enterprise_id
       WHERE t.deleted_at IS NULL AND e.deleted_at IS NULL
      """,
      route_rules:
        "SELECT * FROM route_rules WHERE deleted_at IS NULL ORDER BY priority DESC, id",
      route_vendors: """
      SELECT route_rule_id, level, vendor_trunk_id, share_pct, is_backup, warmup_count, backup_for_vendor_trunk_id
        FROM route_rule_vendors ORDER BY route_rule_id, level, is_backup, share_pct DESC NULLS LAST, id
      """,
      route_whitelists:
        "SELECT route_rule_id, vendor_trunk_id, number_list_id, numbers FROM route_rule_whitelists ORDER BY id",
      lcr_profiles: "SELECT * FROM lcr_profiles WHERE deleted_at IS NULL AND status = 'active'",
      translation_rules: "SELECT * FROM translation_rules WHERE deleted_at IS NULL",
      translation_targets: """
      SELECT translation_rule_id, target_type, trunk_kind, target_id, insert_at FROM translation_rule_targets
      """,
      translation_settings: """
      SELECT translation_rule_id, trunk_kind, trunk_id, position, continue_after, enabled
        FROM translation_rule_trunk_settings
      """,
      list_entries: """
      SELECT e.number_list_id, e.value, e.content FROM number_list_entries e
        JOIN number_lists l ON l.id = e.number_list_id
       WHERE e.deleted_at IS NULL AND l.deleted_at IS NULL ORDER BY e.number_list_id, e.id
      """,
      quality: """
      SELECT m.mccmnc, q.trunk_id,
             CASE WHEN q.overridden THEN coalesce(q.override_asr, q.asr) ELSE q.asr END,
             CASE WHEN q.overridden THEN coalesce(q.override_dlr, q.dlr) ELSE q.dlr END,
             CASE WHEN q.overridden THEN coalesce(q.override_add_s, q.add_s) ELSE q.add_s END
        FROM qbr_stats q JOIN mccmnc m ON m.id = q.mccmnc_id WHERE q.side = 'vendor'
      """,
      fx: "SELECT trim(iso), rate_per_eur FROM currency_latest"
    ]
  end

  defp rows!(sql) do
    %{columns: columns, rows: rows} = Repo.query!(sql, [], timeout: @timeout, log: false)
    keys = Enum.map(columns, &String.to_atom/1)
    {keys, rows}
  end

  @doc false
  # Builds the snapshot from `%{dataset => {columns, rows}}` (pure, for tests).
  def build_snapshot(rows, platform_currency) do
    customer_trunks = customer_trunks(rows.customer_trunks)
    vendor_trunks = vendor_trunks(rows.vendor_trunks)
    lcr = lcr_profiles(rows.lcr_profiles)
    rules = route_rules(rows.route_rules, rows.route_vendors, rows.route_whitelists, lcr)
    {quality, quality_dlr} = quality(rows.quality)

    %{
      platform_currency: platform_currency,
      destinations: destinations(rows.destinations),
      customer_trunks: customer_trunks,
      vendor_trunks: vendor_trunks,
      route_index: Route.index(rules),
      translation:
        translation(
          rows.translation_rules,
          rows.translation_targets,
          rows.translation_settings,
          %{
            customer: customer_trunks,
            vendor: vendor_trunks
          }
        ),
      lists: lists(rows.list_entries),
      quality: quality,
      quality_dlr: quality_dlr,
      fx: Map.new(elem(rows.fx, 1), fn [iso, rate] -> {iso, Decimal.to_float(rate)} end)
    }
  end

  defp maps({keys, rows}), do: Enum.map(rows, &(keys |> Enum.zip(&1) |> Map.new()))

  # Each row through `fun`; a row that raises is logged and left out.
  defp each_row(rows, what, fun) do
    Enum.flat_map(rows, fn row ->
      try do
        [fun.(row)]
      rescue
        e ->
          Logger.error("#{what} #{inspect(row[:id])} not loaded: #{Exception.message(e)}")
          []
      end
    end)
  end

  # ---------------------------------------------------------------- destinations and trunks

  defp destinations({_keys, rows}) do
    {prefixes, by_id} =
      Enum.reduce(rows, {%{}, %{}}, fn [prefix, id, mccmnc, mcc, mnc, network, all, iso, country],
                                       {p, m} ->
        dest = %{
          mccmnc_id: id,
          mccmnc: mccmnc,
          mcc: mcc,
          mnc: mnc,
          network: network,
          all_networks: all,
          country_iso: iso,
          country: country
        }

        {Map.put(p, prefix, id), Map.put(m, id, dest)}
      end)

    longest = prefixes |> Map.keys() |> Enum.map(&byte_size/1) |> Enum.max(fn -> 0 end)
    %{prefixes: prefixes, mccmnc: by_id, longest: longest}
  end

  @affinities %{"strict" => :strict, "same_ip" => :same_ip, "same_trunk" => :same_trunk}

  defp customer_trunks(rows) do
    for t <- maps(rows), into: %{} do
      {t.id, %{t | dlr_session_affinity: enum!(t.dlr_session_affinity, @affinities)}}
    end
  end

  @multipart_formats %{"udh8" => :udh8, "udh16" => :udh16, "sar" => :sar, "payload" => :payload}

  # A vendor trunk's TPS is per connection: the trunk's limit is tps × max_connections (migration 034).
  defp vendor_trunks(rows) do
    for t <- maps(rows), into: %{} do
      {t.id,
       t
       |> Map.put(:multipart_format, enum!(t.multipart_format, @multipart_formats))
       |> Map.put(:tps_limit, t.tps * t.max_connections)}
    end
  end

  # ---------------------------------------------------------------- route rules

  @modes %{"all" => :all, "inclusive" => :inclusive, "exclusive" => :exclusive}

  defp route_rules(rule_rows, vendor_rows, whitelist_rows, lcr) do
    vendors =
      vendor_rows
      |> maps()
      |> Enum.group_by(& &1.route_rule_id, fn v ->
        %{
          level: v.level,
          vendor_trunk_id: v.vendor_trunk_id,
          share_pct: v.share_pct,
          is_backup: v.is_backup,
          warmup_count: v.warmup_count,
          backup_for_vendor_trunk_id: v.backup_for_vendor_trunk_id
        }
      end)

    whitelists =
      whitelist_rows
      |> maps()
      |> Enum.group_by(& &1.route_rule_id, fn w ->
        %{
          vendor_trunk_id: w.vendor_trunk_id,
          number_list_id: w.number_list_id,
          numbers: w.numbers || []
        }
      end)

    rule_rows
    |> maps()
    |> each_row("route rule", &route_rule(&1, vendors, whitelists, lcr))
  end

  defp route_rule(r, vendors, whitelists, lcr) do
    Route.Rule.new(
      [
        id: r.id,
        name: r.name,
        priority: r.priority,
        status: enum!(r.status, %{"active" => :active, "inactive" => :inactive}),
        starts_at: r.starts_at,
        stops_at: r.stops_at,
        continue_routing: enum!(r.continue_routing, %{"yes" => :yes, "stop" => :stop}),
        match_mode: enum!(r.match_mode, %{"all" => :all, "any" => :any})
      ] ++ route_conditions(r) ++ route_vendors(r, vendors, whitelists, lcr)
    )
  end

  defp route_conditions(r) do
    [
      category_mode: enum!(r.category_mode, @modes),
      category_ids: r.category_ids || [],
      customer_trunk_mode: enum!(r.customer_trunk_mode, @modes),
      customer_trunk_ids: r.customer_trunk_ids || [],
      mccmnc_mode: enum!(r.mccmnc_mode, @modes),
      mccmncs: r.mccmncs || [],
      mccmnc_pattern: r.mccmnc_pattern,
      sender_pattern: r.sender_pattern,
      sender_pattern_negate: r.sender_pattern_negate,
      sender_match_case: r.sender_match_case,
      receiver_pattern: r.receiver_pattern,
      receiver_pattern_negate: r.receiver_pattern_negate,
      content_pattern: r.content_pattern,
      content_pattern_negate: r.content_pattern_negate,
      sender_list_id: r.sender_list_id,
      sender_list_negate: r.sender_list_negate || false,
      receiver_list_id: r.receiver_list_id,
      receiver_list_negate: r.receiver_list_negate || false,
      tps: tps(r.tps_condition),
      revenue: revenue(r.revenue_condition),
      hlr_ported: r.hlr_ported
    ]
  end

  defp route_vendors(r, vendors, whitelists, lcr) do
    [
      route_type:
        enum!(r.route_type, %{
          "static" => :static,
          "dynamic" => :dynamic,
          "qbr" => :qbr,
          "block" => :block
        }),
      hunt_policy:
        enum!(r.hunt_policy, %{
          "percentage" => :percentage,
          "top_down" => :top_down,
          "round_robin" => :round_robin
        }),
      margin: num(r.margin) || 0,
      margin_type:
        enum!(r.margin_type || "amount", %{"amount" => :amount, "percent" => :percent}),
      vendors: Map.get(vendors, r.id, []),
      whitelists: Map.get(whitelists, r.id, []),
      qbr_weights: weights(r.qbr_weights),
      percentage_per_customer_trunk: r.percentage_per_customer_trunk != false,
      vendor_trunk_mode: enum!(r.vendor_trunk_mode, @modes),
      vendor_trunk_ids: r.vendor_trunk_ids || [],
      vendor_category_mode: enum!(r.vendor_category_mode, @modes),
      vendor_category_ids: r.vendor_category_ids || [],
      lcr_profile: r.lcr_profile_id && Map.get(lcr, r.lcr_profile_id),
      skip_vendor_at_tps_pct: r.skip_vendor_at_tps_pct
    ]
  end

  # The stored jsonb keys are snake_case (§13.8).
  defp tps(nil), do: nil

  defp tps(c) do
    %{
      op: Map.fetch!(c, "op"),
      value: num(c["value"]),
      value2: num(c["value2"]),
      tolerance_pct: num(c["tolerance_pct"]) || 5,
      scope: c["scope"],
      window_s: c["window_s"],
      hold_s: c["hold_s"],
      release_pct: num(c["release_pct"])
    }
  end

  defp revenue(nil), do: nil

  defp revenue(c) do
    %{
      type:
        enum!(Map.fetch!(c, "type"), %{
          "per_message" => :per_message,
          "accumulated" => :accumulated
        }),
      op: Map.fetch!(c, "op"),
      value: num(c["value"]),
      value2: num(c["value2"]),
      period: c["period"],
      scope: c["scope"]
    }
  end

  defp weights(nil), do: nil

  defp weights(w),
    do: %{
      asr: num(w["asr"]) || 0,
      dlr: num(w["dlr"]) || 0,
      delay: num(w["delay"]) || 0,
      cost: num(w["cost"]) || 0
    }

  defp lcr_profiles(rows) do
    rows
    |> maps()
    |> each_row("LCR profile", fn r ->
      {r.id,
       %{
         vendor_trunk_mode: enum!(r.vendor_trunk_mode, @modes),
         vendor_trunk_ids: r.vendor_trunk_ids || [],
         tiers: r.tiers || [],
         min_asr: num(r.min_asr),
         min_dlr: num(r.min_dlr),
         max_delay_s: num(r.max_delay_s),
         max_rate: num(r.max_rate),
         vendor_count: r.vendor_count,
         split: enum!(r.split, %{"top_down" => :top_down, "percentage" => :percentage}),
         shares: Enum.map(r.shares || [], &num/1),
         tie_breaker: enum!(r.tie_breaker, %{"quality" => :quality, "cost" => :cost}),
         exclude_at_tps_limit: r.exclude_at_tps_limit,
         quality_weighted: r.quality_weighted,
         weights: weights(r.weights)
       }}
    end)
    |> Map.new()
  end

  # ---------------------------------------------------------------- translation rules

  @conversions %{
    "left_strip" => :left_strip,
    "right_strip" => :right_strip,
    "prepend" => :prepend,
    "append" => :append,
    "translation" => :translation,
    "regex_replace" => :regex_replace,
    "random_number" => :random_number,
    "sender_id_template" => :sender_id_template
  }

  defp translation(rule_rows, target_rows, setting_rows, trunks) do
    rules =
      rule_rows
      |> maps()
      |> each_row("translation rule", &translation_rule/1)
      |> Map.new(&{&1.id, &1})

    settings =
      Map.new(maps(setting_rows), &{{&1.trunk_kind, &1.trunk_id, &1.translation_rule_id}, &1})

    targets = target_rows |> maps() |> Enum.filter(&Map.has_key?(rules, &1.translation_rule_id))

    order =
      for {kind, by_id} <- trunks, {id, trunk} <- by_id, into: %{} do
        {{kind, id}, rules_for_trunk(Atom.to_string(kind), id, trunk, targets, rules, settings)}
      end

    # Each rule is held once; trunks keep ids (a copy into persistent_term would repeat a shared rule per trunk).
    %{rules: rules, order: order}
  end

  # The rules reaching a trunk through any target, in run order (mock `reachingRules`): rules with a position on this
  # trunk by position, unpositioned rules targeted "top" before them and the rest after, ties by rule id. Only rules
  # enabled on the trunk and active run.
  defp rules_for_trunk(kind, id, trunk, targets, rules, settings) do
    targets
    |> Enum.filter(&(&1.trunk_kind == kind and reaches?(&1, id, trunk)))
    |> Enum.group_by(& &1.translation_rule_id)
    |> Enum.map(fn {rule_id, ts} ->
      trunk_rule(rule_id, ts, Map.fetch!(rules, rule_id), Map.get(settings, {kind, id, rule_id}))
    end)
    |> Enum.sort_by(fn {rank, rule_id, _, _, _} -> {rank, rule_id} end)
    |> Enum.filter(fn {_, _, _, _, running} -> running end)
    |> Enum.map(fn {_, rule_id, _, continue_after, _} -> {rule_id, continue_after} end)
  end

  # A rule as it runs on one trunk: its rank, and its continue-after and enabled with the trunk's setting `s` applied.
  defp trunk_rule(rule_id, ts, rule, s) do
    top = Enum.any?(ts, &(&1.insert_at == "top"))
    position = s && s.position
    rank = if position, do: {1, position}, else: {if(top, do: 0, else: 2), 0}
    continue_after = setting(s, :continue_after, rule.continue_after)
    enabled = setting(s, :enabled, true)
    {rank, rule_id, rule, continue_after, enabled and rule.status == :active}
  end

  defp setting(nil, _key, default), do: default

  defp setting(s, key, default) do
    case Map.fetch!(s, key) do
      nil -> default
      value -> value
    end
  end

  defp reaches?(%{target_type: "all"}, _id, _trunk), do: true
  defp reaches?(%{target_type: "trunk", target_id: target}, id, _trunk), do: target == id

  defp reaches?(%{target_type: "enterprise", target_id: target}, _id, trunk),
    do: target == trunk.enterprise_id

  defp reaches?(%{target_type: "category", target_id: target}, _id, trunk),
    do: target == trunk.product_category_id

  defp reaches?(_target, _id, _trunk), do: false

  defp translation_rule(r) do
    Translation.Rule.new(
      id: r.id,
      name: r.name,
      action: enum!(r.action, %{"allow" => :allow, "block" => :block}),
      status: enum!(r.status, %{"active" => :active, "inactive" => :inactive}),
      continue_after: r.continue_after,
      sender_pattern: r.sender_pattern,
      sender_pattern_negate: r.sender_pattern_negate,
      sender_match_case: r.sender_match_case,
      receiver_pattern: r.receiver_pattern,
      receiver_pattern_negate: r.receiver_pattern_negate,
      mccmncs: r.mccmncs || [],
      mccmnc_negate: r.mccmnc_negate,
      mccmnc_pattern: r.mccmnc_pattern,
      content_pattern: r.content_pattern,
      content_pattern_negate: r.content_pattern_negate,
      sender_list_id: r.sender_list_id,
      sender_list_negate: r.sender_list_negate,
      receiver_list_id: r.receiver_list_id,
      receiver_list_negate: r.receiver_list_negate,
      sender_conversion: r.sender_conversion && enum!(r.sender_conversion, @conversions),
      sender_conversion_value: r.sender_conversion_value,
      sender_conversion_replacement: r.sender_conversion_replacement,
      sender_conversion_list_id: r.sender_conversion_list_id,
      receiver_conversion: r.receiver_conversion && enum!(r.receiver_conversion, @conversions),
      receiver_conversion_value: r.receiver_conversion_value,
      receiver_conversion_replacement: r.receiver_conversion_replacement,
      sender_ton: r.sender_ton,
      sender_npi: r.sender_npi,
      dest_ton: r.dest_ton,
      dest_npi: r.dest_npi,
      billing_type: r.billing_type,
      registered_delivery: r.registered_delivery,
      # jsonb as the screens save it (camelCase keys).
      dlr_map:
        Enum.map(r.dlr_status_map || [], fn m ->
          %{
            from_status: Map.fetch!(m, "fromStatus"),
            from_error: m["fromError"],
            to_status: Map.fetch!(m, "toStatus"),
            to_error: m["toError"]
          }
        end),
      content_regex: r.content_regex,
      content_regex_index: r.content_regex_index,
      content_replacement: r.content_replacement,
      msg_template: r.msg_template,
      content_words:
        Enum.map(r.content_words || [], fn w ->
          %{
            find: w["find"],
            replace: w["replace"] || "",
            whole_word: w["wholeWord"],
            match_case: w["matchCase"]
          }
        end),
      sender_min_length: r.sender_min_len,
      sender_max_length: r.sender_max_len,
      receiver_min_length: r.receiver_min_len,
      receiver_max_length: r.receiver_max_len,
      starts_at: r.starts_at,
      stops_at: r.stops_at
    )
  end

  # ---------------------------------------------------------------- number lists, quality

  defp lists({_keys, rows}) do
    rows
    |> Enum.group_by(&hd/1, &tl/1)
    |> Map.new(fn {id, entries} ->
      values = entries |> Enum.map(&hd/1) |> Enum.uniq()
      templates = for v <- values, String.contains?(v, "{n}"), do: template_regexes(v)

      contents =
        for [value, content] <- entries, content != nil, reduce: %{} do
          acc -> Map.update(acc, value, [content], &(&1 ++ [content]))
        end

      {id,
       %{
         entries: values,
         exact: MapSet.new(values),
         lower: MapSet.new(values, &String.downcase/1),
         templates: templates,
         contents: contents
       }}
    end)
  end

  # A Sender ID template entry: each {n} is one digit; case-sensitive and any-case versions.
  defp template_regexes(entry) do
    source =
      "^" <> (entry |> String.split("{n}") |> Enum.map_join("[0-9]", &Regex.escape/1)) <> "$"

    {Pattern.compile(source), Pattern.compile(source, match_case: false)}
  end

  defp quality({_keys, rows}) do
    Enum.reduce(rows, {%{}, %{}}, fn [code, trunk, asr, dlr, delay], {q, d} ->
      entry = %{asr: num(asr), dlr: num(dlr), delay_s: num(delay)}
      q = Map.update(q, code, %{trunk => entry}, &Map.put(&1, trunk, entry))

      d =
        if dlr == nil,
          do: d,
          else: Map.update(d, code, %{trunk => num(dlr)}, &Map.put(&1, trunk, num(dlr)))

      {q, d}
    end)
  end

  # ---------------------------------------------------------------- helpers

  defp enum!(value, map),
    do: Map.get(map, value) || raise(ArgumentError, "unknown value #{inspect(value)}")

  defp num(nil), do: nil
  defp num(%Decimal{} = d), do: d |> Decimal.to_float() |> integral()
  defp num(n) when is_number(n), do: n

  # 80.0 stays 80 so messages and comparisons read as on the screens.
  defp integral(f), do: if(f == Float.round(f) and abs(f) < 1.0e15, do: trunc(f), else: f)

  defp query(sql, params) do
    Repo.query(sql, params, timeout: @timeout, log: false)
  rescue
    e -> {:error, Exception.message(e)}
  end
end
