defmodule Sms.Switch.Test.PipelineConfig do
  @moduledoc """
  The pipeline's configuration for tests, as the rows `Sms.Switch.Pipeline.Config.Loader` reads from PostgreSQL
  (fake data): `put/1` stores them and this module serves them as the `:loader` of `Config.Server`, through the same
  builders as the real loader.

  Defaults: destination 26201 (Germany, prefixes 4915/4916) and 262 (All networks, prefix 49), customer trunk 1 with
  rate table 100 (0.05 EUR), vendor trunk 1 with rate table 200 (0.02 EUR), one active static rule for every trunk and
  destination to vendor trunk 1.
  """
  alias Sms.Switch.Pipeline.Config.Loader

  @key {__MODULE__, :data}

  @doc "Stores the configuration; options replace the defaults' datasets (`:customer_trunks`, `:route_rules`…)."
  def put(opts \\ []) do
    data = Map.merge(defaults(), Map.new(opts))
    :persistent_term.put(@key, Map.put(data, :version, System.unique_integer([:positive])))
  end

  defp data, do: :persistent_term.get(@key)

  # ---------------------------------------------------------------- loader

  def fingerprint, do: {:ok, "fp-#{data().version}"}

  def rate_fingerprints do
    {:ok, data().rates |> Enum.map(&hd/1) |> Enum.uniq() |> Map.new(&{&1, "r-#{data().version}"})}
  end

  def load_rates(table_ids) do
    rows = Enum.filter(data().rates, &(hd(&1) in table_ids))
    {:ok, Loader.build_rates(table_ids, rows)}
  end

  def load_snapshot(platform_currency) do
    d = data()

    rows = %{
      destinations: {[], d.destinations},
      customer_trunks: maps(d.customer_trunks),
      vendor_trunks: maps(d.vendor_trunks),
      route_rules: maps(Enum.map(d.route_rules, &route_rule/1)),
      route_vendors: maps(d.route_vendors),
      route_whitelists: maps([]),
      lcr_profiles: maps([]),
      translation_rules: maps(Enum.map(d.translation_rules, &translation_rule/1)),
      translation_targets: maps(d.translation_targets),
      translation_settings: maps([]),
      list_entries: {[], d.list_entries},
      hlr_providers: maps(Enum.map(d.hlr_providers, &hlr_provider/1)),
      hlr_rates: maps(d.hlr_rates),
      hlr_rules: maps(d.hlr_rules),
      hlr_targets: maps(d.hlr_targets),
      hlr_settings: maps([]),
      hlr_policies: maps(d.hlr_policies),
      quality: {[], []},
      fx: {[], [["EUR", Decimal.new(1)], ["USD", Decimal.new("1.1")]]}
    }

    {:ok, Loader.build_snapshot(rows, platform_currency)}
  end

  # The loader turns `{columns, rows}` into maps for these datasets.
  defp maps([]), do: {[:id], []}

  defp maps([first | _] = list) do
    keys = first |> Map.keys() |> Enum.sort()
    {keys, Enum.map(list, fn m -> Enum.map(keys, &Map.get(m, &1)) end)}
  end

  # ---------------------------------------------------------------- rows

  defp defaults do
    %{
      destinations: [
        ["4915", 1, "26201", "262", "01", "Fake Mobile", false, "DE", "Germany"],
        ["4916", 1, "26201", "262", "01", "Fake Mobile", false, "DE", "Germany"],
        ["49", 2, "262", "262", "", nil, true, "DE", "Germany"]
      ],
      customer_trunks: [customer_trunk()],
      vendor_trunks: [vendor_trunk()],
      rates: [
        rate(100, 1, "26201", "0.05"),
        rate(200, 2, "26201", "0.02")
      ],
      route_rules: [%{id: 1}],
      route_vendors: [route_vendor(1, 1)],
      translation_rules: [],
      translation_targets: [],
      # [list_id, value, content | nil]
      list_entries: [],
      hlr_providers: [],
      hlr_rates: [],
      hlr_rules: [],
      hlr_targets: [],
      hlr_policies: []
    }
  end

  @doc "A customer trunk's fields (see the loader's query)."
  def customer_trunk(fields \\ []) do
    Map.merge(
      %{
        id: 1,
        name: "FAKE_CUSTOMER",
        enterprise_id: 11,
        business_company_id: 1,
        base_currency: "EUR",
        product_category_id: 1,
        billing_type: "submit",
        active: true,
        account_manager_id: 5,
        default_coding: 0,
        dlr_session_affinity: "strict",
        dlr_hold_hours: 72,
        delayed_submit: false,
        loop_detection: false,
        reassembly_timeout_s: 120,
        duplicate_window_s: 0,
        allow_empty_messages: false,
        rate_table_ids: [100]
      },
      Map.new(fields)
    )
  end

  @doc "An HLR provider's fields (§6.5; see the loader's query)."
  def hlr_provider(fields \\ []) do
    Map.merge(
      %{
        id: 1,
        name: "Fake HLR",
        url: "http://127.0.0.1:1/lookup?msisdn={DNID}",
        username: nil,
        password: nil,
        extra_headers: nil,
        post_data: nil,
        currency: "EUR",
        default_rate: Decimal.new("0.001"),
        cache_days: 0,
        timeout_ms: 500,
        daily_budget: nil,
        response_mapping: %{
          "mccmnc" => "mccmnc",
          "ported" => "ported",
          "errorCode" => "error.code",
          "successCodes" => "0"
        },
        success_pct: nil,
        live_status: "up"
      },
      Map.new(fields)
    )
  end

  @doc "An HLR rule on every customer trunk: provider and DNID pattern (`hlr_rules` + `hlr_targets` rows)."
  def hlr_rule(id, provider_id, pattern) do
    {%{id: id, hlr_provider_id: provider_id, dnid_pattern: pattern, status: "active"},
     %{hlr_rule_id: id, target_type: "all", target_id: nil, insert_at: "bottom"}}
  end

  @doc "A vendor trunk's fields."
  def vendor_trunk(fields \\ []) do
    Map.merge(
      %{
        id: 1,
        name: "FAKE_VENDOR",
        enterprise_id: 21,
        product_category_id: 1,
        billing_type: "submit",
        active: true,
        account_manager_id: 6,
        tier: 1,
        dlr_timeout_s: 3_600,
        dlr_timeout_stat: "UNKNOWN",
        reroute_on: [],
        tps: 1_000,
        max_connections: 1,
        support_multipart: true,
        max_msg_len: nil,
        multipart_format: "udh8",
        overflow_buffer: 0,
        rate_table_ids: [200]
      },
      Map.new(fields)
    )
  end

  @doc "A rate line row: table, line id, MCCMNC, rate (EUR unless given), current since an hour ago."
  def rate(table, id, mccmnc, rate, currency \\ "EUR", sender \\ nil) do
    from = DateTime.add(DateTime.utc_now(), -3_600)
    [table, id, mccmnc, Decimal.new(rate), currency, from, nil, false, sender]
  end

  @doc "A route rule vendor row."
  def route_vendor(rule_id, vendor_trunk_id, level \\ 1),
    do: %{
      route_rule_id: rule_id,
      level: level,
      vendor_trunk_id: vendor_trunk_id,
      share_pct: nil,
      is_backup: false,
      warmup_count: nil,
      backup_for_vendor_trunk_id: nil
    }

  # A route_rules row: an active static rule for everything unless the fields say otherwise.
  defp route_rule(fields) do
    Map.merge(
      %{
        id: 1,
        name: "Rule",
        priority: 100,
        status: "active",
        starts_at: nil,
        stops_at: nil,
        continue_routing: "yes",
        match_mode: "all",
        category_mode: "all",
        category_ids: [],
        customer_trunk_mode: "all",
        customer_trunk_ids: [],
        mccmnc_mode: "all",
        mccmncs: [],
        mccmnc_pattern: nil,
        sender_pattern: nil,
        sender_pattern_negate: false,
        sender_match_case: true,
        receiver_pattern: nil,
        receiver_pattern_negate: false,
        content_pattern: nil,
        content_pattern_negate: false,
        sender_list_id: nil,
        sender_list_negate: false,
        receiver_list_id: nil,
        receiver_list_negate: false,
        tps_condition: nil,
        revenue_condition: nil,
        hlr_ported: nil,
        hlr_action: nil,
        route_type: "static",
        hunt_policy: "top_down",
        margin: nil,
        margin_type: "amount",
        qbr_weights: nil,
        percentage_per_customer_trunk: true,
        vendor_trunk_mode: "all",
        vendor_trunk_ids: [],
        vendor_category_mode: "all",
        vendor_category_ids: [],
        lcr_profile_id: nil,
        skip_vendor_at_tps_pct: nil
      },
      fields
    )
  end

  # A translation_rules row: an active allow rule with no condition and no change unless the fields say otherwise.
  defp translation_rule(fields) do
    Map.merge(
      %{
        id: 1,
        name: "Translation",
        action: "allow",
        status: "active",
        continue_after: true,
        sender_pattern: nil,
        sender_pattern_negate: false,
        sender_match_case: true,
        receiver_pattern: nil,
        receiver_pattern_negate: false,
        mccmncs: [],
        mccmnc_negate: false,
        mccmnc_pattern: nil,
        content_pattern: nil,
        content_pattern_negate: false,
        sender_list_id: nil,
        sender_list_negate: false,
        receiver_list_id: nil,
        receiver_list_negate: false,
        sender_conversion: nil,
        sender_conversion_value: nil,
        sender_conversion_replacement: nil,
        sender_conversion_list_id: nil,
        receiver_conversion: nil,
        receiver_conversion_value: nil,
        receiver_conversion_replacement: nil,
        sender_ton: nil,
        sender_npi: nil,
        dest_ton: nil,
        dest_npi: nil,
        billing_type: nil,
        registered_delivery: nil,
        dlr_status_map: [],
        content_regex: nil,
        content_regex_index: nil,
        content_replacement: nil,
        msg_template: nil,
        content_words: [],
        sender_min_len: 0,
        sender_max_len: 20,
        receiver_min_len: 0,
        receiver_max_len: 20,
        starts_at: nil,
        stops_at: nil
      },
      fields
    )
  end

  @doc ~s[A translation target row: rule `rule_id` on trunk `trunk_id` of `kind` ("customer" / "vendor").]
  def target(rule_id, kind, trunk_id),
    do: %{
      translation_rule_id: rule_id,
      target_type: "trunk",
      trunk_kind: kind,
      target_id: trunk_id,
      insert_at: "bottom"
    }
end
