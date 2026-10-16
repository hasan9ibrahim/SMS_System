/**
 * Number lists, route rules (spec §6.3, §13.8, §13.9, §13.24, §13.27), translation
 * rules and HLR rules attached directly to trunks without groups (spec §13.2).
 * Includes the dirty data the Cleanup Center must find (§13.19): unattached rules,
 * expired and inactive rules, identical copies and references to deleted vendors.
 */
import { WeightedPicker, type Rng } from "./rng.js";
import { json, type TableSink } from "./sink.js";
import { syllableWord } from "./names.js";
import { usersOf } from "./admin.js";
import { DAY, type Country, type Mccmnc, type RouteRule, type RouteVendor, type World } from "./world.js";
import type { Profile } from "./profiles.js";

export async function generateRules(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  await generateNumberLists(world, rng, sink, profile);
  await generateRouteRules(world, rng, sink, profile);
  await generateTranslationRules(world, rng, sink, profile);
  await generateHlr(world, rng, sink, profile);
}

async function generateNumberLists(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const noc = usersOf(world, "NOC");
  let entryId = 1;
  for (let i = 0; i < profile.numberLists; i++) {
    const type = rng.weighted(["tag", "random", "sender_id_template"], [60, 25, 15]);
    const c = rng.pick(world.countries.filter((x) => x.weight > 3));
    const name =
      type === "tag"
        ? `${rng.pick(["VIP", "Test", "Blacklist", "Whitelist", "Fraud", "Staff"])} numbers ${c.iso} ${i + 1}`
        : type === "random"
          ? `Random senders ${c.iso} ${i + 1}`
          : `Sender template ${syllableWord(rng)}`;
    const n = rng.int(20, 500);
    const entries: string[] = [];
    for (let k = 0; k < n; k++) {
      entries.push(
        type === "sender_id_template"
          ? `${syllableWord(rng).toUpperCase().slice(0, 8)}{n}`
          : `${c.dialCode}555${rng.digits(6)}`,
      );
    }
    const id = i + 1;
    world.numberLists.push({ id, name, type, entries });
    const user = rng.pick(noc).id;
    await sink.insert("number_lists", {
      id,
      name,
      list_type: type,
      updated_by_id: user,
      inserted_at: new Date(world.anchor - rng.int(10, 500) * DAY),
      updated_at: new Date(world.anchor - rng.int(0, 10) * DAY),
      deleted_at: null,
    });
    for (const value of entries) {
      await sink.insert("number_list_entries", { id: entryId++, number_list_id: id, value, created_by_id: user });
    }
  }
}

/** Vendor trunks that have an open rate for a destination code at the anchor time. */
export function buildCoverage(world: World): Map<string, number[]> {
  const cover = new Map<string, number[]>();
  for (const v of world.vendorTrunks) {
    const table = world.rateTableById.get(v.rateTableId);
    if (!table) continue;
    for (const [code, versions] of table.lines) {
      const last = versions[versions.length - 1]!;
      if (!Number.isFinite(last.to) || last.to > world.anchor) {
        const list = cover.get(code);
        if (list) list.push(v.id);
        else cover.set(code, [v.id]);
      }
    }
  }
  return cover;
}

const SHARE_SPLITS: number[][] = [[100], [60, 40], [70, 30], [50, 50], [50, 30, 20], [40, 40, 20]];

async function generateRouteRules(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const editors = usersOf(world, "NOC", "Rates");
  const coverage = buildCoverage(world);
  const catName = (id: number) => world.categories.find((c) => c.id === id)!.name;
  const usedCats = new Map<number, number>();
  for (const t of world.customerTrunks) usedCats.set(t.categoryId, (usedCats.get(t.categoryId) ?? 0) + 1);
  const catPicker = new WeightedPicker([...usedCats.keys()], [...usedCats.values()]);
  const trunksByCat = new Map<number, number[]>();
  for (const t of world.customerTrunks) {
    if (t.deletedAt) continue;
    const l = trunksByCat.get(t.categoryId) ?? [];
    l.push(t.id);
    trunksByCat.set(t.categoryId, l);
  }
  const countryPicker = new WeightedPicker(
    world.countries,
    world.countries.map((c) => c.weight),
  );
  const networkPickers = new Map<number, WeightedPicker<Mccmnc>>();
  const networkOf = (c: Country) => {
    let p = networkPickers.get(c.id);
    if (!p) {
      const nets = c.mccmncIds.map((id) => world.mccmncById.get(id)!);
      p = new WeightedPicker(
        nets,
        nets.map((m) => m.weight),
      );
      networkPickers.set(c.id, p);
    }
    return p.pick(rng);
  };
  const whsCats = world.categories.filter((c) => ["WHS", "HQ", "SIM"].includes(c.name)).map((c) => c.id);

  // Groups (optional since §13.2, kept for chaining and migration).
  const groupNames = [
    "Default",
    "Europe",
    "GCC",
    "Africa",
    "Asia",
    "Americas",
    "OTP premium",
    "Promo",
    "Overflow",
    "Backup",
    "Night routing",
    "Campaigns",
    "Direct operators",
    "Wholesale",
    "Quality",
    "Testing",
    "Key accounts",
    "Low value",
    "HLR first",
    "Legacy",
  ];
  for (let i = 0; i < groupNames.length; i++) {
    await sink.insert("route_rule_groups", {
      id: i + 1,
      name: groupNames[i],
      updated_by_id: rng.pick(editors).id,
      deleted_at: null,
    });
  }

  const tagLists = world.numberLists.filter((l) => l.type === "tag");
  let ruleId = 1;
  let rvId = 1;
  let wlId = 1;
  const rules: RouteRule[] = [];

  const pickVendors = (candidates: number[], n: number): number[] => {
    // Prefer active vendors; ~5% of picks may hit inactive/deleted ones (broken references, §13.19).
    const active = candidates.filter((id) => {
      const v = world.vendorTrunkById.get(id)!;
      return v.status === "active" && !v.deletedAt;
    });
    const pool = active.length && !rng.chance(0.05) ? active : candidates;
    return rng.sample(pool, n);
  };

  const emit = async (r: RouteRule, extra: Record<string, unknown> = {}) => {
    rules.push(r);
    const user = rng.pick(editors).id;
    const insertedAt = Math.min(r.startsAt, world.anchor - rng.int(0, 30) * DAY);
    await sink.insert("route_rules", {
      id: r.id,
      name: r.name,
      priority: r.priority,
      status: r.status,
      starts_at: new Date(r.startsAt),
      stops_at: new Date(r.stopsAt),
      route_rule_group_id: r.groupId,
      next_route_rule_group_id: extra.next_group ?? null,
      continue_routing: extra.next_group
        ? "next"
        : r.routeType === "block"
          ? "stop"
          : rng.weighted(["stop", "yes"], [90, 10]),
      match_mode: "all",
      category_mode: r.categoryIds.length ? "inclusive" : "all",
      category_ids: r.categoryIds,
      customer_trunk_mode: r.customerTrunkMode,
      customer_trunk_ids: r.customerTrunkIds,
      mccmnc_mode: r.mccmncs.length ? "inclusive" : "all",
      mccmncs: r.mccmncs,
      mccmnc_pattern: null,
      sender_pattern: r.senderPattern,
      sender_pattern_negate: r.senderPatternNegate,
      receiver_pattern: null,
      receiver_pattern_negate: false,
      content_pattern: extra.content_pattern ?? null,
      content_pattern_negate: false,
      sender_list_id: null,
      receiver_list_id: null,
      tps_condition: r.tpsCondition
        ? json({
            ...r.tpsCondition,
            tolerance_pct: 5,
            scope: "customer_trunk",
            window_s: 5,
            hold_s: 10,
            release_pct: 10,
          })
        : null,
      revenue_condition: extra.revenue_condition ?? null,
      route_type: r.routeType,
      hunt_policy: r.huntPolicy,
      enable_backup_routes: r.vendors.some((v) => v.isBackup),
      vendor_category_mode: r.vendorCategoryIds.length ? "inclusive" : "all",
      vendor_category_ids: r.vendorCategoryIds,
      vendor_trunk_mode: "all",
      vendor_trunk_ids: [],
      max_route_level: Math.max(1, ...r.vendors.map((v) => v.level)),
      margin: r.margin,
      qbr_formula: r.routeType === "qbr" ? "ASR*0.4 + DLR*0.5 - ADD*0.1" : null,
      skip_vendor_at_tps_pct: rng.chance(0.1) ? rng.pick([80, 90, 100]) : null,
      hlr_action: r.hlrPolicy ? json({ policy: "default", customer_trunk_ids: r.customerTrunkIds.slice(0, 2) }) : null,
      hlr_ported: r.hlrPolicy ? rng.chance(0.5) : null,
      deny_multipart: rng.chance(0.03),
      threshold: extra.threshold ?? null,
      threshold_interval: extra.threshold ? "day" : null,
      comment: rng.chance(0.15)
        ? rng.pick(["Agreed with vendor", "Temporary until DLR recovers", "Client request", "Test route"])
        : null,
      created_by_id: user,
      updated_by_id: rng.pick(editors).id,
      inserted_at: new Date(insertedAt),
      updated_at: new Date(Math.min(world.anchor, insertedAt + rng.int(0, 120) * DAY)),
      deleted_at: r.deletedAt ? new Date(r.deletedAt) : null,
      deleted_by_id: r.deletedAt ? user : null,
    });
    for (const v of r.vendors) {
      await sink.insert("route_rule_vendors", {
        id: rvId++,
        route_rule_id: r.id,
        level: v.level,
        vendor_trunk_id: v.vendorTrunkId,
        share_pct: v.sharePct,
        is_backup: v.isBackup,
        warmup_count: v.warmupCount,
        warmup_reset: v.warmupCount ? rng.pick(["hour", "day", "week"]) : null,
        warmup_per: v.warmupCount ? rng.pick(["rule", "customer_trunk"]) : null,
      });
    }
    if (r.whitelist) {
      const list = tagLists.find((l) => l.entries[0] && r.whitelist!.numbers.has(l.entries[0]));
      await sink.insert("route_rule_whitelists", {
        id: wlId++,
        route_rule_id: r.id,
        vendor_trunk_id: r.whitelist.vendorTrunkId,
        number_list_id: list?.id ?? null,
        numbers: list ? [] : [...r.whitelist.numbers],
      });
    }
  };

  const base = (name: string, priority: number, routeType: RouteRule["routeType"]): RouteRule => {
    const r: RouteRule = {
      id: ruleId++,
      name,
      priority,
      status: "active",
      startsAt: world.historyStart + rng.int(0, 200) * DAY,
      stopsAt: world.anchor + 10 * 365 * DAY,
      deletedAt: null,
      groupId: rng.chance(0.35) ? rng.int(1, groupNames.length) : null,
      categoryIds: [],
      customerTrunkMode: "all",
      customerTrunkIds: [],
      mccmncs: [],
      senderPattern: null,
      senderPatternNegate: false,
      routeType,
      huntPolicy: "top_down",
      vendors: [],
      vendorCategoryIds: [],
      margin: 0,
      whitelist: null,
      tpsCondition: null,
      hlrPolicy: false,
    };
    const roll = rng.next();
    if (roll < 0.08) r.status = "inactive";
    else if (roll < 0.11)
      r.stopsAt = world.anchor - rng.int(10, 150) * DAY; // expired
    else if (roll < 0.13) r.deletedAt = world.anchor - rng.int(1, 120) * DAY;
    else if (roll < 0.14) r.startsAt = world.anchor + rng.int(1, 14) * DAY; // scheduled
    return r;
  };

  const vendorsFor = (r: RouteRule, candidates: number[]) => {
    const n = Math.min(candidates.length, rng.weighted([1, 2, 3], [35, 45, 20]));
    const chosen = pickVendors(candidates, n);
    if (chosen.length > 1 && rng.chance(0.55)) {
      r.huntPolicy = "percentage";
      const split = rng.pick(SHARE_SPLITS.filter((s) => s.length === chosen.length));
      r.vendors = chosen.map((id, i) => ({
        level: 1,
        vendorTrunkId: id,
        sharePct: split[i] ?? null,
        isBackup: false,
        warmupCount: null,
      }));
      const backup = candidates.find((id) => !chosen.includes(id));
      if (backup && rng.chance(0.3))
        r.vendors.push({ level: 2, vendorTrunkId: backup, sharePct: null, isBackup: true, warmupCount: null });
    } else {
      r.huntPolicy = "top_down";
      r.vendors = chosen.map(
        (id, i): RouteVendor => ({
          level: i + 1,
          vendorTrunkId: id,
          sharePct: null,
          isBackup: i > 0,
          warmupCount: null,
        }),
      );
    }
    if (r.vendors[0] && rng.chance(0.04)) r.vendors[0].warmupCount = rng.pick([100, 500, 1000, 5000]); // §13.27
    if (r.vendors.length > 1 && rng.chance(0.02) && tagLists.length) {
      const list = rng.pick(tagLists);
      r.whitelist = { vendorTrunkId: r.vendors[r.vendors.length - 1]!.vendorTrunkId, numbers: new Set(list.entries) };
    }
  };

  const restrictTrunks = (r: RouteRule, catId: number) => {
    const pool = trunksByCat.get(catId) ?? [];
    const roll = rng.next();
    if (pool.length && roll < 0.3) {
      r.customerTrunkMode = "inclusive";
      r.customerTrunkIds = rng.sample(pool, rng.int(1, Math.min(4, pool.length)));
    } else if (pool.length && roll < 0.35) {
      r.customerTrunkMode = "exclusive";
      r.customerTrunkIds = rng.sample(pool, 1);
    }
  };

  // 1. Catch-all least-cost rule per category in use.
  for (const catId of usedCats.keys()) {
    const r = base(`LCR_${catName(catId)}_default`, 100, "dynamic");
    r.status = "active";
    r.deletedAt = null;
    r.stopsAt = world.anchor + 10 * 365 * DAY;
    r.startsAt = world.historyStart;
    r.categoryIds = [catId];
    r.vendorCategoryIds = [...new Set([catId, ...whsCats])];
    r.margin = 0.0002;
    await emit(r);
  }

  // 2. Block rules.
  const nBlock = Math.max(3, Math.round(profile.routeRules * 0.03));
  for (let i = 0; i < nBlock; i++) {
    const kind = rng.next();
    if (kind < 0.4) {
      const r = base(`BLOCK_test_senders_${i + 1}`, rng.int(1, 5), "block");
      r.senderPattern = "^(TEST|DEMO)";
      await emit(r);
    } else {
      const c = countryPicker.pick(rng);
      const m = networkOf(c);
      const catId = catPicker.pick(rng);
      const r = base(`BLOCK_${c.iso}_${m.mnc}_${catName(catId)}`, rng.int(1, 5), "block");
      r.categoryIds = [catId];
      r.mccmncs = [m.code];
      restrictTrunks(r, catId);
      await emit(r, kind > 0.85 ? { content_pattern: "(bit\\.ly|tinyurl)" } : {});
    }
  }

  // 3. Country and network rules.
  const target = profile.routeRules;
  let guard = 0;
  while (ruleId <= target && guard++ < target * 10) {
    if (ruleId > 50 && rng.chance(0.01)) {
      // Identical copy with a different name (§13.19 "Identical").
      const src = rng.pick(rules.filter((x) => x.routeType !== "block" && x.mccmncs.length));
      if (src) {
        const copy: RouteRule = {
          ...src,
          id: ruleId++,
          name: `${src.name}_copy`,
          vendors: src.vendors.map((v) => ({ ...v })),
        };
        await emit(copy);
        continue;
      }
    }
    const catId = catPicker.pick(rng);
    const country = countryPicker.pick(rng);
    const isCountry = country.allNetworksId > 0 && rng.chance(0.3);
    let code: string;
    let candidates: number[];
    if (isCountry) {
      code = world.mccmncById.get(country.allNetworksId)!.mcc;
      const counts = new Map<number, number>();
      for (const id of country.mccmncIds)
        for (const v of coverage.get(world.mccmncById.get(id)!.code) ?? []) counts.set(v, (counts.get(v) ?? 0) + 1);
      candidates = [...counts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([v]) => v);
    } else {
      const m = networkOf(country);
      code = m.code;
      candidates = coverage.get(code) ?? [];
    }
    if (candidates.length === 0) continue;
    const routeType = rng.weighted(["static", "qbr", "dynamic"] as const, [70, 15, 15]);
    const label = isCountry
      ? `${country.iso}_all`
      : `${country.iso}_${world.mccmncByCode
          .get(code)!
          .network.replace(/[^A-Za-z0-9]+/g, "")
          .slice(0, 12)}`;
    const r = base(
      `${label}_${catName(catId).replace(/[^A-Za-z0-9]/g, "")}_${routeType}`,
      isCountry ? rng.int(30, 70) : rng.int(10, 40),
      routeType,
    );
    r.categoryIds = [catId];
    r.mccmncs = [code];
    restrictTrunks(r, catId);
    if (routeType === "dynamic") {
      r.vendorCategoryIds = rng.chance(0.5) ? [catId] : [];
      r.margin = Number(rng.float(0, 0.002).toFixed(6));
    } else {
      vendorsFor(r, candidates);
      r.margin = Number(rng.float(0, 0.001).toFixed(6));
    }
    if (rng.chance(0.02))
      r.tpsCondition = { op: rng.pick([">", ">=", "<", "<="]), value: rng.pick([5, 20, 50, 100, 200]) }; // §13.8
    if (rng.chance(0.02)) r.hlrPolicy = true; // §13.24
    const extra: Record<string, unknown> = {};
    if (rng.chance(0.015)) {
      extra.revenue_condition = json(
        rng.chance(0.5)
          ? { type: "per_message", op: ">=", value: Number(rng.float(0.02, 0.06).toFixed(3)) }
          : {
              type: "accumulated",
              op: ">=",
              value: rng.pick([100, 500, 1000]),
              scope: "customer_enterprise",
              period: "today",
            },
      );
    }
    if (rng.chance(0.03)) extra.threshold = rng.pick([1000, 10000, 50000]);
    if (r.groupId && rng.chance(0.05)) extra.next_group = rng.int(1, groupNames.length);
    await emit(r, extra);
  }
  world.routeRules = rules;
}

async function generateTranslationRules(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const editors = usersOf(world, "NOC");
  const templates: { name: string; direction: "ingress" | "egress"; row: Record<string, unknown> }[] = [
    {
      name: "Strip 00 from receiver",
      direction: "ingress",
      row: { receiver_pattern: "^00", receiver_conversion: "left_strip", receiver_conversion_value: "2" },
    },
    {
      name: "Strip + from receiver",
      direction: "ingress",
      row: { receiver_pattern: "^\\+", receiver_conversion: "left_strip", receiver_conversion_value: "1" },
    },
    { name: "Block test senders", direction: "ingress", row: { action: "block", sender_pattern: "^(TEST|DEMO)" } },
    {
      name: "Block URL shorteners",
      direction: "ingress",
      row: { action: "block", content_pattern: "(bit\\.ly|tinyurl|goo\\.gl)" },
    },
    { name: "Force registered delivery", direction: "ingress", row: { registered_delivery: 1 } },
    {
      name: "Numeric sender to international",
      direction: "egress",
      row: { sender_pattern: "^[0-9]{10,15}$", sender_ton: 1, sender_npi: 1 },
    },
    {
      name: "Alphanumeric sender TON 5",
      direction: "egress",
      row: { sender_pattern: "[A-Za-z]", sender_ton: 5, sender_npi: 0 },
    },
    { name: "Random numeric sender", direction: "egress", row: { sender_conversion: "random_number" } },
    { name: "Prepend country code", direction: "egress", row: { receiver_conversion: "prepend" } },
    { name: "Map UNKNOWN DLR to UNDELIV", direction: "ingress", row: { dlr_status_map: json({ UNKNOWN: "UNDELIV" }) } },
    { name: "Sender ID template", direction: "egress", row: { sender_conversion: "sender_id_template" } },
  ];
  const position = new Map<string, number>();
  let attId = 1;
  for (let i = 0; i < profile.translationRules; i++) {
    const tpl = rng.pick(templates);
    const id = i + 1;
    const c = rng.pick(world.countries.filter((x) => x.weight > 3));
    const row: Record<string, unknown> = {
      id,
      name: `${tpl.name} ${c.iso} #${id}`,
      direction: rng.chance(0.2) ? tpl.direction : null,
      action: "allow",
      status: rng.chance(0.07) ? "inactive" : "active",
      sender_pattern: null,
      sender_pattern_negate: false,
      receiver_pattern: null,
      receiver_pattern_negate: false,
      mccmncs: c.allNetworksId && rng.chance(0.3) ? [world.mccmncById.get(c.allNetworksId)!.mcc] : [],
      content_pattern: null,
      sender_list_id: null,
      receiver_list_id: null,
      sender_conversion: null,
      sender_conversion_value: null,
      receiver_conversion: null,
      receiver_conversion_value: null,
      sender_ton: null,
      sender_npi: null,
      dest_ton: null,
      dest_npi: null,
      billing_type: null,
      registered_delivery: null,
      dlr_status_map: null,
      sender_min_len: 0,
      sender_max_len: 20,
      receiver_min_len: 0,
      receiver_max_len: 20,
      starts_at: null,
      stops_at: null,
      created_by_id: rng.pick(editors).id,
      updated_by_id: rng.pick(editors).id,
      inserted_at: new Date(world.anchor - rng.int(5, 500) * DAY),
      updated_at: new Date(world.anchor - rng.int(0, 5) * DAY),
      deleted_at: null,
      deleted_by_id: null,
      ...tpl.row,
    };
    if (row.receiver_conversion === "prepend") row.receiver_conversion_value = c.dialCode;
    if (row.sender_conversion === "random_number" || row.sender_conversion === "sender_id_template") {
      const lists = world.numberLists.filter(
        (l) => l.type === (row.sender_conversion === "random_number" ? "random" : "sender_id_template"),
      );
      if (lists.length) row.sender_list_id = rng.pick(lists).id;
    }
    await sink.insert("translation_rules", row);

    // Attach directly to trunks (§13.2); ~15% stay unattached (§13.19).
    if (rng.chance(0.15)) continue;
    const kind = tpl.direction === "ingress" ? "customer" : "vendor";
    const pool: { id: number; translationRuleIds: number[] }[] =
      kind === "customer" ? world.customerTrunks : world.vendorTrunks;
    for (const t of rng.sample(pool, rng.weighted([1, 2, 3, 6], [55, 25, 12, 8]))) {
      const key = `${kind}:${t.id}`;
      const pos = (position.get(key) ?? 0) + 1;
      position.set(key, pos);
      const enabled = rng.chance(0.95);
      if (enabled && row.status === "active") t.translationRuleIds.push(id);
      await sink.insert("translation_rule_attachments", {
        id: attId++,
        translation_rule_id: id,
        trunk_kind: kind,
        trunk_id: t.id,
        position: pos,
        continue_after: rng.chance(0.85),
        enabled,
      });
    }
  }
}

async function generateHlr(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const editors = usersOf(world, "NOC");
  const providers = ["Lookupia HLR", "Numvera MNP", "Portacheck", "Reachly HLR", "Validex Number Check", "Hlrion"];
  for (const [i, name] of providers.entries()) {
    const type = name.includes("MNP") ? "mnp" : name.includes("Check") ? "number_check" : "hlr";
    const rateUsd = Number(rng.float(0.0004, 0.003).toFixed(5));
    world.hlrProviders.push({ id: i + 1, name, rateUsd });
    await sink.insert("hlr_providers", {
      id: i + 1,
      name,
      provider_type: type,
      url: `https://api.${name.split(" ")[0]!.toLowerCase()}.example/lookup?msisdn={DNID}`,
      username: `user${rng.digits(4)}`,
      password: `fake-${rng.hex(10)}`,
      currency: "USD",
      default_rate: rateUsd,
      cache_days: rng.int(0, 7),
      timeout_ms: rng.pick([800, 1500, 3000]),
      daily_budget: rng.chance(0.5) ? rng.pick([100, 250, 500]) : null,
      status: i === providers.length - 1 ? "inactive" : "active",
      deleted_at: null,
    });
  }
  const hlrRules: { id: number; providerId: number }[] = [];
  for (let i = 0; i < profile.hlrRules; i++) {
    const c = rng.pick(world.countries);
    const providerId = rng.int(1, providers.length);
    hlrRules.push({ id: i + 1, providerId });
    await sink.insert("hlr_rules", {
      id: i + 1,
      name: `HLR ${c.name} via ${providers[providerId - 1]}`,
      hlr_provider_id: providerId,
      dnid_pattern: `^${c.dialCode}`,
      status: rng.chance(0.06) ? "inactive" : "active",
      updated_by_id: rng.pick(editors).id,
      deleted_at: null,
    });
  }
  let attId = 1;
  for (const t of world.customerTrunks) {
    if (!rng.chance(0.25)) continue;
    const picked = rng.sample(hlrRules, rng.int(1, 4));
    for (const [pos, rule] of picked.entries()) {
      t.hlrProviderIds.push(rule.providerId);
      await sink.insert("hlr_rule_attachments", {
        id: attId++,
        hlr_rule_id: rule.id,
        customer_trunk_id: t.id,
        position: pos + 1,
        enabled: true,
      });
    }
  }
}
