defmodule Sms.Switch.Rules.RouteTest do
  # Route rule evaluation (§6.3, §13.8, §13.9, §13.27) and LCR ranking (§13.23): the mock's tests
  # (mock/test/evaluate.test.ts, the ranking part of mock/test/lcr.test.ts) ported one for one.
  use ExUnit.Case, async: true
  alias Sms.Switch.Rules.{Lcr, Route}
  alias Sms.Switch.Rules.Route.Rule

  @vendors [
    %{level: 1, vendor_trunk_id: 10, share_pct: 60, is_backup: false, warmup_count: nil},
    %{level: 1, vendor_trunk_id: 11, share_pct: 40, is_backup: false, warmup_count: nil}
  ]

  defp rule(over \\ []) do
    Rule.new(
      Keyword.merge(
        [
          id: 1,
          name: "R1",
          starts_at: ~U[2020-01-01 00:00:00Z],
          stops_at: ~U[2099-01-01 00:00:00Z],
          customer_trunk_mode: :inclusive,
          customer_trunk_ids: [7],
          mccmnc_mode: :inclusive,
          mccmncs: ["505", "50501"],
          sender_pattern: "^(TEST|DEMO)",
          sender_pattern_negate: true,
          route_type: :static,
          hunt_policy: :percentage,
          margin: 0,
          percentage_per_customer_trunk: false,
          vendors: @vendors
        ],
        over
      )
    )
  end

  defp msg(over \\ %{}) do
    Map.merge(
      %{
        now: DateTime.to_unix(~U[2026-10-16 12:00:00Z], :millisecond),
        customer_trunk_id: 7,
        category_id: 1,
        receiver: "61412345678",
        sender: "BANK",
        content: "code 1234",
        mccmnc: "50501",
        destination: "Australia · Telstra",
        tps: nil,
        sell_rate: 0.05,
        accumulated_revenue: nil,
        hlr_ported: nil,
        warmup_sent: 0,
        list_has?: fn _, _, _ -> false end
      },
      Map.new(over)
    )
  end

  @options %{
    10 => %{vendor_trunk_id: 10, name: "Kite_DIR", cost: 0.03, dlr: 95, category_id: 1},
    11 => %{vendor_trunk_id: 11, name: "Orbit_DIR", cost: 0.032, dlr: 97, category_id: 1},
    12 => %{vendor_trunk_id: 12, name: "Vega_HQ", cost: 0.025, dlr: 80, category_id: 1}
  }

  defp decide(r, m, options \\ @options), do: Route.decide(r, m, options)
  defp vendor_id(d), do: d.vendor && d.vendor.vendor_trunk_id

  test "comparisons, tolerance for = and a 3-digit code meaning only All networks" do
    assert Route.compare(">", 51, 50, nil)
    assert Route.compare("=", 52, 50, nil, 5)
    refute Route.compare("=", 53, 50, nil, 5)
    assert Route.compare("between", 75, 50, 100)
    refute Route.destination_hit?(MapSet.new(["505"]), "50501")
    assert Route.destination_hit?(MapSet.new(["505"]), "505")
    assert Route.destination_hit?(MapSet.new(["505", "50501"]), "50501")
    refute Route.destination_hit?(MapSet.new(["50502"]), "50501")
  end

  test "all conditions must match; a failing one is reported" do
    assert decide(rule(), msg()).outcome == :route
    t = decide(rule(), msg(sender: "TEST1"))
    assert t.outcome == :not_matched
    assert Enum.find(t.checks, &(not &1.ok)).condition == "Sender"
    # any: the trunk and destination still match.
    assert decide(rule(match_mode: :any), msg(sender: "TEST1")).matched
    # Status and time always apply.
    refute decide(rule(status: :inactive, match_mode: :any), msg()).matched
  end

  test "percentage split is stable per number; whitelist and warm-up come first (§13.27)" do
    a = decide(rule(), msg())
    assert vendor_id(decide(rule(), msg())) == vendor_id(a)
    assert vendor_id(a) == if(Route.bucket("61412345678") < 60, do: 10, else: 11)

    wl =
      decide(
        rule(whitelists: [%{vendor_trunk_id: 11, number_list_id: nil, numbers: ["61412345678"]}]),
        msg()
      )

    assert {vendor_id(wl), wl.vendor.decided_by} == {11, :whitelist}

    warm =
      rule(
        vendors: [
          %{level: 1, vendor_trunk_id: 10, share_pct: 60, is_backup: false, warmup_count: nil},
          %{level: 1, vendor_trunk_id: 11, share_pct: 40, is_backup: false, warmup_count: 500}
        ]
      )

    assert decide(warm, msg(warmup_sent: 10)).vendor.decided_by == :warmup
    refute decide(warm, msg(warmup_sent: 500)).vendor.decided_by == :warmup
  end

  test "least cost skips vendors below the margin; QBR orders by delivery; block blocks" do
    lcr = decide(rule(route_type: :dynamic, vendors: []), msg())
    assert {vendor_id(lcr), lcr.vendor.decided_by} == {12, :lcr}
    tight = decide(rule(route_type: :dynamic, vendors: [], margin: 0.019), msg())
    # The cheapest still leaves enough margin; Orbit leaves 0.018.
    assert vendor_id(tight) == 12
    assert Enum.find(tight.candidates, &(&1.vendor_trunk_id == 11)).note =~ "margin below"

    assert decide(rule(route_type: :dynamic, vendors: [], margin: 0.04), msg()).outcome ==
             :no_vendor

    assert vendor_id(decide(rule(route_type: :qbr, vendors: []), msg())) == 11
    assert decide(rule(route_type: :block), msg()).outcome == :block
  end

  test "TPS and revenue conditions (§13.8, §13.9)" do
    tps = rule(tps: %{op: ">", value: 50, scope: "customer_trunk"})
    assert decide(tps, msg(tps: 80)).matched
    refute decide(tps, msg(tps: 20)).matched
    rev = rule(revenue: %{type: :per_message, op: ">=", value: 0.04})
    assert decide(rev, msg(sell_rate: 0.05)).matched
    refute decide(rev, msg(sell_rate: 0.03)).matched
  end

  test "a message the rule's other conditions let through counts for its own TPS scope (§13.8)" do
    over = rule(tps: %{op: ">", value: 50, scope: "rule"})
    # TPS 0 on the rule: it does not match, but the message still counts for it.
    assert Route.others_match?(over, msg(tps: 0))
    refute decide(over, msg(tps: 0)).matched
    refute Route.others_match?(over, msg(sender: "BANK", customer_trunk_id: 8))
    refute Route.others_match?(rule(status: :inactive, tps: over.conditions.tps), msg())
    refute Route.others_match?(rule(stops_at: ~U[2021-01-01 00:00:00Z]), msg())

    # "Any" mode: one other condition is enough; a rule with only the TPS condition counts everything.
    assert Route.others_match?(rule(match_mode: :any, tps: over.conditions.tps), msg(sender: "x"))

    only =
      rule(
        customer_trunk_mode: :all,
        mccmnc_mode: :all,
        sender_pattern: nil,
        tps: over.conditions.tps
      )

    assert Route.others_match?(only, msg(customer_trunk_id: 99))
  end

  test "the fast match agrees with the full checks; destination pre-filter keeps the order" do
    rules = [
      rule(),
      rule(match_mode: :any),
      rule(customer_trunk_mode: :exclusive, mccmncs: ["50501", "26201"]),
      rule(
        category_mode: :inclusive,
        category_ids: [2],
        customer_trunk_mode: :all,
        mccmnc_mode: :all
      ),
      rule(mccmnc_mode: :all, mccmnc_pattern: "^505", sender_pattern: nil, match_mode: :any),
      rule(
        revenue: %{type: :per_message, op: ">=", value: 0.04},
        tps: %{op: ">", value: 50, scope: "rule"}
      ),
      rule(hlr_ported: true, content_pattern: "code", content_pattern_negate: false),
      rule(status: :inactive),
      rule(stops_at: ~U[2021-01-01 00:00:00Z]),
      rule(customer_trunk_mode: :all, mccmnc_mode: :all, sender_pattern: nil)
    ]

    msgs = [
      msg(),
      msg(sender: "TEST1"),
      msg(customer_trunk_id: 8, category_id: 2),
      msg(mccmnc: "26201", sell_rate: 0.03, tps: 60),
      msg(hlr_ported: true, content: "no"),
      msg(mccmnc: nil)
    ]

    for {r, i} <- Enum.with_index(rules), {m, j} <- Enum.with_index(msgs) do
      assert Route.quick_match?(r, m) ==
               Route.matches?(Route.condition_checks(r, m), r.match_mode),
             "rule #{i} × message #{j}"
    end

    numbered = rules |> Enum.with_index(1) |> Enum.map(fn {r, i} -> %{r | id: i} end)
    kept = Route.rules_for_destination(Route.index(numbered), "50501", msg().now)
    assert Enum.map(kept, & &1.id) == [1, 2, 3, 4, 5, 6, 7, 10]
  end

  test "QBR score: ASR and DLR weigh most, then delay, then cost (decided 2026-10-18)" do
    good = %{asr: 95, dlr: 90, delay_s: 5, cost: 0.02}
    cheap_but_poor = %{asr: 70, dlr: 55, delay_s: 5, cost: 0.01}
    slow = %{asr: 95, dlr: 90, delay_s: 50, cost: 0.02}
    assert Route.by_qbr([cheap_but_poor, slow, good]) == [good, slow, cheap_but_poor]
    assert abs(Route.qbr_score(%{asr: 100, dlr: 100, delay_s: 0, cost: 0.01}, 0.01) - 1) < 1.0e-9

    assert abs(Route.qbr_score(%{asr: nil, dlr: nil, delay_s: nil, cost: nil}, nil) - 0.5) <
             1.0e-9
  end

  test "QBR weights per rule: cost-only weights pick the cheapest (team trial round 1)" do
    good = %{asr: 95, dlr: 90, delay_s: 5, cost: 0.02}
    cheap = %{asr: 70, dlr: 55, delay_s: 5, cost: 0.01}
    assert Route.by_qbr([good, cheap], %{asr: 0, dlr: 0, delay: 0, cost: 100}) == [cheap, good]
    assert Route.by_qbr([cheap, good], nil) == [good, cheap]
  end

  test "split per customer trunk: each trunk's traffic follows the shares on its own (team trial round 1)" do
    pick = fn over, trunk, receiver ->
      vendor_id(
        decide(
          rule([customer_trunk_mode: :all] ++ over),
          msg(customer_trunk_id: trunk, receiver: receiver)
        )
      )
    end

    receivers = for i <- 0..199, do: "4477009" <> String.pad_leading("#{i}", 5, "0")

    assert Enum.all?(
             receivers,
             &(pick.([], 1, &1) != nil and pick.([], 1, &1) == pick.([], 2, &1))
           )

    on = [percentage_per_customer_trunk: true]
    assert Enum.any?(receivers, &(pick.(on, 1, &1) != pick.(on, 2, &1)))
    share = Enum.count(receivers, &(pick.(on, 2, &1) == 10)) / length(receivers)
    assert share > 0.45 and share < 0.75
  end

  test "margin as an amount or a percentage of the sell rate, negative allowed (team trial round 1)" do
    dyn = fn over -> decide(rule([route_type: :dynamic, vendors: []] ++ over), msg()) end
    assert vendor_id(dyn.(margin: 45, margin_type: :percent)) == 12
    assert dyn.(margin: 55, margin_type: :percent).outcome == :no_vendor
    assert hd(dyn.(margin: 55, margin_type: :percent).candidates).note =~ "margin below 55 %"

    loss = %{
      12 => %{vendor_trunk_id: 12, name: "Vega_HQ", cost: 0.06, dlr: 80, category_id: 1},
      10 => %{vendor_trunk_id: 10, name: "Kite_DIR", cost: 0.07, dlr: 95, category_id: 1},
      11 => %{vendor_trunk_id: 11, name: "Orbit_DIR", cost: 0.08, dlr: 97, category_id: 1}
    }

    lossy = fn over ->
      vendor_id(decide(rule([route_type: :dynamic, vendors: []] ++ over), msg(), loss))
    end

    assert lossy.(margin: -0.015) == 12
    assert lossy.(margin: -0.005) == nil
    assert lossy.(margin: -25, margin_type: :percent) == 12
  end

  test "a vendor whose own egress rules block the message is skipped for the next one (decided 2026-10-18)" do
    first = vendor_id(decide(rule(), msg()))
    other = if first == 10, do: 11, else: 10
    next = decide(rule(), msg(egress_blocked: MapSet.new([first])))
    assert next.outcome == :route
    assert vendor_id(next) == other
    assert Enum.find(next.candidates, &(&1.vendor_trunk_id == first)).note =~ "vendor translation"
    assert decide(rule(), msg(egress_blocked: MapSet.new([10, 11]))).outcome == :no_vendor
  end

  test "Match case for every Sender condition: exact capitals when on, any case when off (team trial round 1)" do
    on = fn over, m ->
      r = rule([sender_pattern_negate: false] ++ over)
      got = decide(r, msg(m)).matched
      assert Route.quick_match?(r, msg(m)) == got
      got
    end

    assert on.([sender_pattern: "^(?:BANK)$"], sender: "BANK")
    refute on.([sender_pattern: "^(?:BANK)$"], sender: "Bank")
    assert on.([sender_pattern: "^(?:BANK)$", sender_match_case: false], sender: "Bank")
    refute on.([sender_pattern: "^(?:BANK)$", sender_match_case: nil], sender: "Bank")
    assert on.([sender_pattern: "(?:otp)", sender_match_case: false], sender: "MyOTP")
    refute on.([sender_pattern: "(?:otp)"], sender: "MyOTP")

    refute on.([sender_pattern: "^BANK$", sender_pattern_negate: true, sender_match_case: false],
             sender: "bank"
           )

    entries = ["BANK"]

    list_has? = fn _id, v, ignore_case ->
      if ignore_case,
        do: Enum.any?(entries, &(String.downcase(&1) == String.downcase(v))),
        else: v in entries
    end

    list = [sender_pattern: nil, sender_list_id: 5]
    assert on.(list, sender: "BANK", list_has?: list_has?)
    refute on.(list, sender: "Bank", list_has?: list_has?)
    assert on.(list ++ [sender_match_case: false], sender: "Bank", list_has?: list_has?)

    checks =
      Route.condition_checks(
        rule(list ++ [sender_match_case: false]),
        msg(sender: "Bank", list_has?: list_has?)
      )

    assert Enum.find(checks, &(&1.condition == "Sender list")).detail =~ "any case"
    # Receiver and content conditions keep ignoring case.
    assert on.([sender_pattern: nil, content_pattern: "CODE"], content: "code 1234")
  end

  test "Sender ID keywords: \\Numeric and \\Alpha (team trial round 2)" do
    base = [customer_trunk_mode: :all, mccmnc_mode: :all, sender_pattern_negate: false]

    hit = fn r, sender ->
      m = msg(sender: sender)
      Route.quick_match?(r, m) and Route.matches?(Route.condition_checks(r, m), :all)
    end

    numeric = rule(base ++ [sender_pattern: "\\Numeric"])
    assert hit.(numeric, "447700900123")
    assert hit.(numeric, "+447700900123")
    refute hit.(numeric, "BANK1")
    alpha = rule(base ++ [sender_pattern: "\\Alpha"])
    assert hit.(alpha, "BANK1")
    refute hit.(alpha, "12345")
  end

  test "destination list and pattern: whichever is set; with both only the list counts (decided 2026-10-24, R1)" do
    hit = fn over, mccmnc ->
      r = rule([customer_trunk_mode: :all, sender_pattern: nil] ++ over)
      m = msg(mccmnc: mccmnc)
      full = Route.matches?(Route.condition_checks(r, m), :all)
      assert Route.quick_match?(r, m) == full
      assert Route.rules_for_destination(Route.index([r]), mccmnc, m.now) != [] == full
      full
    end

    assert hit.([mccmncs: ["50501"]], "50501")
    refute hit.([mccmncs: ["50501"]], "26201")
    assert hit.([mccmnc_mode: :all, mccmncs: [], mccmnc_pattern: "^262"], "26201")
    refute hit.([mccmnc_mode: :all, mccmncs: [], mccmnc_pattern: "^262"], "50501")
    assert hit.([mccmncs: ["50501"], mccmnc_pattern: "^262"], "50501")
    refute hit.([mccmncs: ["50501"], mccmnc_pattern: "^262"], "26201")
    assert hit.([mccmnc_mode: :exclusive, mccmncs: ["50501"], mccmnc_pattern: "^505"], "50502")

    checks =
      Route.condition_checks(
        rule(
          customer_trunk_mode: :all,
          sender_pattern: nil,
          mccmncs: ["50501"],
          mccmnc_pattern: "^262"
        ),
        msg()
      )

    assert Enum.find(checks, &(&1.condition == "Destination")).detail =~ "list wins"
  end

  test "sender and receiver lists can be negated - Not match (decided 2026-10-24, R2)" do
    entries = ["BANK", "61412345678"]
    list_has? = fn _id, v, _ -> v in entries end

    on = fn over, m ->
      r =
        rule(
          [customer_trunk_mode: :all, mccmnc_mode: :all, mccmncs: [], sender_pattern: nil] ++ over
        )

      mm = msg(Map.merge(%{list_has?: list_has?}, Map.new(m)))
      full = Route.matches?(Route.condition_checks(r, mm), :all)
      assert Route.quick_match?(r, mm) == full
      full
    end

    assert on.([sender_list_id: 5], sender: "BANK")
    refute on.([sender_list_id: 5, sender_list_negate: true], sender: "BANK")
    assert on.([sender_list_id: 5, sender_list_negate: true], sender: "SHOP")
    assert on.([receiver_list_id: 6], receiver: "61412345678")
    refute on.([receiver_list_id: 6, receiver_list_negate: true], receiver: "61412345678")
    assert on.([receiver_list_id: 6, receiver_list_negate: true], receiver: "61400000000")

    checks =
      Route.condition_checks(
        rule(
          customer_trunk_mode: :all,
          mccmnc_mode: :all,
          sender_pattern: nil,
          sender_list_id: 5,
          sender_list_negate: true
        ),
        msg(list_has?: list_has?, sender: "BANK")
      )

    assert Enum.find(checks, &(&1.condition == "Sender list")).detail =~ "must not be"
  end

  describe "beyond the mock's tests" do
    test "levels in order, backups of a vendor, the rule's last resort" do
      vendors = [
        %{level: 1, vendor_trunk_id: 10, share_pct: nil, is_backup: false},
        %{
          level: 1,
          vendor_trunk_id: 12,
          share_pct: nil,
          is_backup: true,
          backup_for_vendor_trunk_id: 10
        },
        %{level: 2, vendor_trunk_id: 11, share_pct: nil, is_backup: false},
        %{level: 2, vendor_trunk_id: 13, share_pct: nil, is_backup: true}
      ]

      options =
        Map.put(@options, 13, %{
          vendor_trunk_id: 13,
          name: "Last",
          cost: 0.01,
          dlr: nil,
          category_id: 1
        })

      r = rule(hunt_policy: :top_down, vendors: vendors)
      assert vendor_id(decide(r, msg(), options)) == 10
      # 10 blocked: its own backup stands in before level 2.
      d = decide(r, msg(egress_blocked: MapSet.new([10])), options)
      assert vendor_id(d) == 12
      assert Enum.find(d.candidates, &(&1.vendor_trunk_id == 12)).note == "backup for Kite_DIR"
      d = decide(r, msg(egress_blocked: MapSet.new([10, 12])), options)
      assert {vendor_id(d), d.vendor.level} == {11, 2}
      d = decide(r, msg(egress_blocked: MapSet.new([10, 11, 12])), options)
      assert {vendor_id(d), d.vendor.decided_by} == {13, :top_down}

      assert decide(r, msg(egress_blocked: MapSet.new([10, 11, 12, 13])), options).outcome ==
               :no_vendor
    end

    test "round robin starts at the number's bucket; a vendor without options is Trunk N with no cost" do
      r = rule(hunt_policy: :round_robin)
      start = rem(Route.bucket("61412345678"), 2)
      assert vendor_id(decide(r, msg())) == Enum.at([10, 11], start)

      d =
        decide(
          rule(vendors: [%{level: 1, vendor_trunk_id: 99, share_pct: 100, is_backup: false}]),
          msg()
        )

      assert d.vendor == %{
               vendor_trunk_id: 99,
               name: "Trunk 99",
               level: 1,
               decided_by: :percentage
             }

      assert hd(d.candidates).cost == nil and hd(d.candidates).margin == nil
    end

    test "Continue routing YES moves on when a matched rule has no usable vendor (R3)" do
      none = rule(id: 1, route_type: :dynamic, vendors: [], margin: 1, continue_routing: :yes)
      stop = rule(id: 1, route_type: :dynamic, vendors: [], margin: 1, continue_routing: :stop)
      next = rule(id: 2)
      %{decision: d, tried: tried} = Route.route_through([none, next], msg(), @options)
      assert d.rule_id == 2 and d.outcome == :route
      assert Enum.map(tried, & &1.reason) |> hd() =~ "no vendor qualifies"
      assert Route.route_through([stop, next], msg(), @options).decision.outcome == :no_vendor
      # A blocking rule decides.
      assert Route.route_through([rule(route_type: :block), next], msg(), @options, 0).decision.outcome ==
               :block

      assert Route.route_through([], msg(), @options).decision == nil
    end

    test "a Least cost rule with an LCR profile: filters, picks and percentage split" do
      profile = %{
        vendor_trunk_mode: :all,
        vendor_trunk_ids: [],
        tiers: [],
        min_asr: nil,
        min_dlr: 90,
        max_delay_s: nil,
        max_rate: nil,
        vendor_count: 2,
        split: :percentage,
        shares: [70, 30],
        tie_breaker: :quality,
        exclude_at_tps_limit: true,
        quality_weighted: false,
        weights: nil
      }

      r = rule(route_type: :dynamic, vendors: [], lcr_profile: profile)
      d = decide(r, msg())
      # Vega (DLR 80) is filtered out; Kite and Orbit share 70 / 30.
      assert Enum.map(d.candidates, & &1.vendor_trunk_id) |> Enum.sort() == [10, 11]
      expected = if Route.bucket("61412345678") < 70, do: 10, else: 11
      assert vendor_id(d) == expected
    end
  end

  describe "LCR ranking (§13.23)" do
    defp cand(id, cost, dlr, over \\ %{}),
      do:
        Map.merge(
          %{
            vendor_trunk_id: id,
            cost: cost,
            asr: 90,
            dlr: dlr,
            delay_s: 5,
            tier: "tier1",
            at_limit: false
          },
          over
        )

    defp profile(over) do
      Map.merge(
        %{
          vendor_trunk_mode: :all,
          vendor_trunk_ids: MapSet.new(),
          tiers: [],
          min_asr: nil,
          min_dlr: nil,
          max_delay_s: nil,
          max_rate: nil,
          vendor_count: 2,
          split: :top_down,
          shares: [],
          tie_breaker: :quality,
          exclude_at_tps_limit: true,
          quality_weighted: false,
          weights: %{cost: 60, asr: 10, dlr: 25, delay: 5}
        },
        over
      )
    end

    setup do
      %{
        list: [
          cand(1, 0.05, 70),
          cand(2, 0.04, 95),
          cand(3, 0.04, 99),
          cand(4, 0.03, 40, %{tier: "tier3"})
        ]
      }
    end

    test "by cost, quality as tie-breaker, profile filters and picks", %{list: list} do
      assert Enum.map(Lcr.rank(list, nil), & &1.c.vendor_trunk_id) == [4, 3, 2, 1]
      r = Lcr.rank(list, profile(%{tiers: ["tier1"], min_dlr: 80, vendor_count: 1}))
      assert r |> Enum.filter(& &1.rank) |> Enum.map(& &1.c.vendor_trunk_id) == [3, 2]
      assert Enum.find(r, &(&1.c.vendor_trunk_id == 4)).excluded == "tier3 not allowed"
      assert Enum.find(r, &(&1.c.vendor_trunk_id == 1)).excluded == "DLR below 80 %"
      assert r |> Enum.filter(& &1.pick) |> Enum.map(& &1.c.vendor_trunk_id) == [3]
    end

    test "quality-weighted score lets a dearer, much better vendor rank first", %{list: list} do
      s = Lcr.scores(list, %{cost: 30, asr: 0, dlr: 70, delay: 0})
      assert s[Enum.at(list, 2)] > s[Enum.at(list, 3)]
      w = %{cost: 30, asr: 0, dlr: 70, delay: 0}
      assert hd(Lcr.rank(list, nil, quality_weighted: true, weights: w)).c.vendor_trunk_id == 3
    end

    test "percentage split", %{list: list} do
      picks =
        list
        |> Lcr.rank(profile(%{vendor_count: 2, split: :percentage, shares: [70, 30]}))
        |> Enum.filter(& &1.pick)

      assert hd(Lcr.split_pick(picks, 10)).c.vendor_trunk_id == 4
      assert hd(Lcr.split_pick(picks, 85)).c.vendor_trunk_id == 3
    end

    test "other exclusions and JavaScript rounding" do
      p =
        profile(%{
          vendor_trunk_mode: :inclusive,
          vendor_trunk_ids: MapSet.new([2]),
          max_rate: 0.045
        })

      r =
        Lcr.rank([cand(1, 0.05, 70), cand(2, 0.04, 95), cand(5, 0.01, 95, %{at_limit: true})], p)

      assert Enum.map(r, &{&1.c.vendor_trunk_id, &1.excluded}) ==
               [
                 {2, nil},
                 {5, "not in the profile's vendors"},
                 {1, "not in the profile's vendors"}
               ]

      assert Lcr.js_round(2.5) == 3
      assert Lcr.js_round(-2.5) == -2
      assert Lcr.num(80.0) == "80" and Lcr.num(0.019) == "0.019"
    end
  end
end
