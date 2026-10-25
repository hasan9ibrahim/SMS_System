defmodule Sms.Switch.Pipeline.HlrTest do
  # Which providers a lookup uses and in what order (§13.24): trunk rules and their order, policies per destination,
  # "auto" by price and success, skipped providers, the daily budget and the cache (fake data).
  use ExUnit.Case, async: false
  import Sms.Switch.Test.CustomerCase, only: [assert_eventually: 1]
  alias Sms.Switch.Pipeline.{Config, Hlr, Store}
  alias Sms.Switch.Test.{FakeHlr, PipelineConfig}

  @de %{mccmnc: "26201", mcc: "262"}

  setup do
    start_supervised!(Store)
    :ok
  end

  defp load(opts) do
    PipelineConfig.put(opts)
    start_supervised!({Config.Server, loader: PipelineConfig})
    assert_eventually(&Config.ready?/0)
  end

  defp policy(entries),
    do: [
      hlr_policies: [%{id: 1, entries: entries}],
      route_rules: [%{id: 1, hlr_action: %{"policy_id" => 1, "customer_trunk_ids" => [1]}}]
    ]

  defp entry(fields),
    do:
      Map.merge(
        %{
          "code" => nil,
          "mode" => "ordered",
          "providerIds" => [1, 2, 3],
          "minSuccessPct" => nil,
          "cacheHoursPorted" => 2,
          "cacheHoursNotPorted" => nil
        },
        fields
      )

  defp providers,
    do: [
      PipelineConfig.hlr_provider(
        id: 1,
        default_rate: Decimal.new("0.003"),
        success_pct: Decimal.new("99")
      ),
      PipelineConfig.hlr_provider(
        id: 2,
        default_rate: Decimal.new("0.001"),
        success_pct: Decimal.new("60")
      ),
      PipelineConfig.hlr_provider(
        id: 3,
        default_rate: Decimal.new("0.002"),
        success_pct: Decimal.new("95")
      )
    ]

  test "the trunk's first rule whose DNID pattern matches names the provider; the route rule's action wins" do
    {r1, t1} = PipelineConfig.hlr_rule(1, 2, "^4916")
    {r2, t2} = PipelineConfig.hlr_rule(2, 3, "^49")
    load(hlr_providers: providers(), hlr_rules: [r1, r2], hlr_targets: [t1, t2])

    assert %{providers: [%{id: 3}]} = Hlr.plan(1, "4915111", @de, nil)
    assert %{providers: [%{id: 2}]} = Hlr.plan(1, "4916111", @de, nil)
    assert Hlr.plan(1, "331111", @de, nil) == nil
    refute Hlr.actions_for?(1)
  end

  test "a route rule's HLR action wins for the trunks it names; other trunks keep their own rules" do
    {r1, t1} = PipelineConfig.hlr_rule(1, 2, "^4916")
    {r2, t2} = PipelineConfig.hlr_rule(2, 3, "^49")

    load(
      [
        customer_trunks: [PipelineConfig.customer_trunk(), PipelineConfig.customer_trunk(id: 2)],
        hlr_providers: providers(),
        hlr_rules: [r1, r2],
        hlr_targets: [t1, t2]
      ] ++ policy([entry(%{})])
    )

    assert Hlr.actions_for?(1)
    refute Hlr.actions_for?(2)
    assert %{providers: [%{id: 1}, %{id: 2}, %{id: 3}]} = Hlr.plan(1, "4915111", @de, 1)
    # Another trunk is not among the action's: its own rules.
    assert %{providers: [%{id: 3}]} = Hlr.plan(2, "4915111", @de, 1)
  end

  test "policy entries: the network's own, else the country's, else the catch-all; auto by success then price" do
    entries = [
      entry(%{"code" => "26201", "providerIds" => [3]}),
      entry(%{"code" => "208", "providerIds" => [2]}),
      entry(%{"mode" => "auto", "minSuccessPct" => 90})
    ]

    load(
      [
        hlr_providers: providers(),
        hlr_rates: [
          %{
            hlr_provider_id: 1,
            mccmnc: "23415",
            mcc: "234",
            is_all_networks: false,
            rate: Decimal.new("0.0005")
          }
        ]
      ] ++ policy(entries)
    )

    assert %{providers: [%{id: 3}]} = Hlr.plan(1, "49", @de, 1)
    assert %{providers: [%{id: 2}]} = Hlr.plan(1, "33", %{mccmnc: "20801", mcc: "208"}, 1)
    # Auto: 3 (95 %, 0.002) and 1 (99 %, 0.003) meet 90 %, cheapest first; 2 (60 %) last.
    assert %{providers: [%{id: 3}, %{id: 1}, %{id: 2}]} =
             Hlr.plan(1, "1", %{mccmnc: "31000", mcc: "310"}, 1)

    # Provider 1's own price for 23415 makes it the cheapest there.
    assert %{providers: [%{id: 1}, %{id: 3}, %{id: 2}]} =
             Hlr.plan(1, "44", %{mccmnc: "23415", mcc: "234"}, 1)
  end

  test "down or inactive providers and those over their daily budget are skipped; a found answer is cached" do
    ps = [
      PipelineConfig.hlr_provider(id: 1, live_status: "down"),
      PipelineConfig.hlr_provider(id: 2, live_status: "inactive"),
      PipelineConfig.hlr_provider(
        id: 3,
        daily_budget: Decimal.new("0.0015"),
        default_rate: Decimal.new("0.001")
      ),
      PipelineConfig.hlr_provider(id: 4, cache_days: 1)
    ]

    load(
      [hlr_providers: ps] ++
        policy([entry(%{"providerIds" => [1, 2, 3, 4], "cacheHoursPorted" => nil})])
    )

    FakeHlr.script(%{3 => FakeHlr.found("26202"), 4 => FakeHlr.found("26203", true)})
    plan = Hlr.plan(1, "4915", @de, 1)

    # Provider 3 has room for one lookup today; the policy keeps no cache time, so not cached.
    assert %{provider_id: 3, mccmnc: "26202", fetch_type: "live"} =
             Hlr.lookup(plan, "4915000001", @de)

    assert_received {:hlr_request, 3, _}
    refute_received {:hlr_request, 1, _}
    assert %{provider_id: 4, mccmnc: "26203", ported: true} = Hlr.lookup(plan, "4915000001", @de)
    refute_received {:hlr_request, 3, _}
    assert_received {:hlr_request, 4, _}

    # Provider 4's day of cache: the same number is answered from it, free.
    assert %{provider_id: 4, fetch_type: "cached", cost_sys: +0.0} =
             Hlr.lookup(plan, "4915000001", @de)

    refute_received {:hlr_request, _, _}
  end

  test "every provider failing or not answering: the last failure, or nil when none could be asked" do
    load([hlr_providers: providers()] ++ policy([entry(%{"providerIds" => [1, 2]})]))

    FakeHlr.script(%{
      1 => {:ok, %{accomplished: false, mccmnc: nil, ported: nil, error_code: 5}},
      2 => {:error, :closed}
    })

    plan = Hlr.plan(1, "4915", @de, 1)
    assert %{provider_id: 2, accomplished: false} = Hlr.lookup(plan, "4915000002", @de)
    assert Hlr.lookup(%{plan | providers: []}, "4915000003", @de) == nil
  end
end
