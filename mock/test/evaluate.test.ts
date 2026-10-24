// Route rule evaluation (§6.3, §13.8, §13.9, §13.27): conditions, all/any, and the vendor
// decision order whitelist → warm-up → split / LCR / QBR, with the margin rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  byQbr,
  qbrScore,
  bucket,
  compare,
  conditionChecks,
  decide,
  destinationHit,
  keywordPattern,
  matches,
  quickMatch,
  rulesForDestination,
  type MessageContext,
  type VendorOption,
} from "../src/routing/evaluate.js";

const rule = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    status: "active",
    startsAt: "2020-01-01T00:00:00Z",
    stopsAt: "2099-01-01T00:00:00Z",
    matchMode: "all",
    categoryMode: "all",
    categoryIds: [],
    customerTrunkMode: "inclusive",
    customerTrunkIds: [7],
    mccmncMode: "inclusive",
    mccmncs: ["505", "50501"],
    mccmncPattern: null,
    senderPattern: "^(TEST|DEMO)",
    senderPatternNegate: true,
    senderMatchCase: true,
    receiverPattern: null,
    receiverPatternNegate: false,
    contentPattern: null,
    contentPatternNegate: false,
    senderListId: null,
    receiverListId: null,
    tps: null,
    revenue: null,
    hlrPorted: null,
    routeType: "static",
    huntPolicy: "percentage",
    margin: 0,
    percentagePerCustomerTrunk: false,
    vendors: [
      {
        level: 1,
        vendorTrunkId: 10,
        sharePct: 60,
        isBackup: false,
        warmupCount: null,
        warmupReset: null,
        warmupPer: null,
      },
      {
        level: 1,
        vendorTrunkId: 11,
        sharePct: 40,
        isBackup: false,
        warmupCount: null,
        warmupReset: null,
        warmupPer: null,
      },
    ],
    whitelists: [],
    vendorTrunkMode: "all",
    vendorTrunkIds: [],
    vendorCategoryMode: "all",
    vendorCategoryIds: [],
    ...over,
  }) as never;

const msg = (over: Partial<MessageContext> = {}): MessageContext => ({
  now: Date.parse("2026-10-16T12:00:00Z"),
  customerTrunkId: 7,
  categoryId: 1,
  receiver: "61412345678",
  sender: "BANK",
  content: "code 1234",
  mccmnc: "50501",
  destination: "Australia · Telstra",
  tps: null,
  sellRate: 0.05,
  accumulatedRevenue: null,
  hlrPorted: null,
  warmupSent: 0,
  listHas: () => false,
  ...over,
});

const options = new Map<number, VendorOption>([
  [10, { vendorTrunkId: 10, name: "Kite_DIR", cost: 0.03, dlr: 95, categoryId: 1 }],
  [11, { vendorTrunkId: 11, name: "Orbit_DIR", cost: 0.032, dlr: 97, categoryId: 1 }],
  [12, { vendorTrunkId: 12, name: "Vega_HQ", cost: 0.025, dlr: 80, categoryId: 1 }],
]);

test("comparisons, tolerance for = and a 3-digit code meaning only All networks", () => {
  assert.ok(compare(">", 51, 50, null));
  assert.ok(compare("=", 52, 50, null, 5), "within ±5 %");
  assert.ok(!compare("=", 53, 50, null, 5));
  assert.ok(compare("between", 75, 50, 100));
  // A 3-digit code is the country's All networks entry, not the whole country (team trial round 1).
  assert.ok(!destinationHit(["505"], "50501"));
  assert.ok(destinationHit(["505"], "505"));
  assert.ok(destinationHit(["505", "50501"], "50501"));
  assert.ok(!destinationHit(["50502"], "50501"));
});

test("all conditions must match; a failing one is reported", () => {
  const ok = decide(rule(), msg(), options);
  assert.equal(ok.outcome, "route");
  const test = decide(rule(), msg({ sender: "TEST1" }), options);
  assert.equal(test.outcome, "not_matched");
  assert.equal(test.checks.find((c) => !c.ok)?.condition, "Sender");
  const anyMode = decide(rule({ matchMode: "any" }), msg({ sender: "TEST1" }), options);
  assert.equal(anyMode.matched, true, "any: the trunk and destination still match");
  const off = decide(rule({ status: "inactive", matchMode: "any" }), msg(), options);
  assert.equal(off.matched, false, "status and time always apply");
});

test("percentage split is stable per number; whitelist and warm-up come first (§13.27)", () => {
  const a = decide(rule(), msg(), options);
  assert.equal(decide(rule(), msg(), options).vendor?.vendorTrunkId, a.vendor?.vendorTrunkId);
  assert.equal(a.vendor?.vendorTrunkId, bucket("61412345678") < 60 ? 10 : 11);
  const wl = decide(
    rule({ whitelists: [{ vendorTrunkId: 11, numberListId: null, numbers: ["61412345678"] }] }),
    msg(),
    options,
  );
  assert.deepEqual([wl.vendor?.vendorTrunkId, wl.vendor?.decidedBy], [11, "whitelist"]);
  const warm = rule({
    vendors: [
      {
        level: 1,
        vendorTrunkId: 10,
        sharePct: 60,
        isBackup: false,
        warmupCount: null,
        warmupReset: null,
        warmupPer: null,
      },
      {
        level: 1,
        vendorTrunkId: 11,
        sharePct: 40,
        isBackup: false,
        warmupCount: 500,
        warmupReset: "day",
        warmupPer: "rule",
      },
    ],
  });
  assert.equal(decide(warm, msg({ warmupSent: 10 }), options).vendor?.decidedBy, "warmup");
  assert.notEqual(decide(warm, msg({ warmupSent: 500 }), options).vendor?.decidedBy, "warmup");
});

test("least cost skips vendors below the margin; QBR orders by delivery; block blocks", () => {
  const lcr = decide(rule({ routeType: "dynamic", vendors: [] }), msg(), options);
  assert.deepEqual([lcr.vendor?.vendorTrunkId, lcr.vendor?.decidedBy], [12, "lcr"]);
  const tight = decide(rule({ routeType: "dynamic", vendors: [], margin: 0.019 }), msg(), options);
  assert.equal(tight.vendor?.vendorTrunkId, 12, "the cheapest still leaves enough margin");
  assert.match(tight.candidates.find((c) => c.vendorTrunkId === 11)!.note ?? "", /margin below/, "Orbit leaves 0.018");
  const none = decide(rule({ routeType: "dynamic", vendors: [], margin: 0.04 }), msg(), options);
  assert.equal(none.outcome, "no_vendor");
  const qbr = decide(rule({ routeType: "qbr", vendors: [] }), msg(), options);
  assert.equal(qbr.vendor?.vendorTrunkId, 11);
  assert.equal(decide(rule({ routeType: "block" }), msg(), options).outcome, "block");
});

test("TPS and revenue conditions (§13.8, §13.9)", () => {
  const tps = rule({ tps: { op: ">", value: 50, scope: "customer_trunk" } });
  assert.equal(decide(tps, msg({ tps: 80 }), options).matched, true);
  assert.equal(decide(tps, msg({ tps: 20 }), options).matched, false);
  const rev = rule({ revenue: { type: "per_message", op: ">=", value: 0.04 } });
  assert.equal(decide(rev, msg({ sellRate: 0.05 }), options).matched, true);
  assert.equal(decide(rev, msg({ sellRate: 0.03 }), options).matched, false);
});

test("the fast match agrees with the full checks; destination pre-filter keeps the order", () => {
  // Every combination of a few rule shapes and messages (Rate Lookup routes in bulk, §13.16).
  const rules = [
    rule(),
    rule({ matchMode: "any" }),
    rule({ customerTrunkMode: "exclusive", mccmncs: ["50501", "26201"] }),
    rule({ categoryMode: "inclusive", categoryIds: [2], customerTrunkMode: "all", mccmncMode: "all" }),
    rule({ mccmncMode: "all", mccmncPattern: "^505", senderPattern: null, matchMode: "any" }),
    rule({ revenue: { type: "per_message", op: ">=", value: 0.04 }, tps: { op: ">", value: 50, scope: "rule" } }),
    rule({ hlrPorted: true, contentPattern: "code", contentPatternNegate: false }),
    rule({ status: "inactive" }),
    rule({ stopsAt: "2021-01-01T00:00:00Z" }),
    rule({ customerTrunkMode: "all", mccmncMode: "all", senderPattern: null }),
  ];
  const msgs = [
    msg(),
    msg({ sender: "TEST1" }),
    msg({ customerTrunkId: 8, categoryId: 2 }),
    msg({ mccmnc: "26201", sellRate: 0.03, tps: 60 }),
    msg({ hlrPorted: true, content: "no" }),
    msg({ mccmnc: null }),
  ];
  for (const [i, r] of rules.entries())
    for (const [j, m] of msgs.entries())
      assert.equal(
        quickMatch(r, m),
        matches(conditionChecks(r, m), (r as { matchMode: "all" | "any" }).matchMode),
        `rule ${i} × message ${j}`,
      );
  const numbered = rules.map((r, i) => ({ ...(r as object), id: i + 1 })) as never[];
  const kept = rulesForDestination(numbered, "50501", msg().now) as { id: number }[];
  assert.deepEqual(
    kept.map((r) => r.id),
    [1, 2, 3, 4, 5, 6, 7, 10],
  );
});

test("QBR score: ASR and DLR weigh most, then delay, then cost (decided 2026-10-18)", () => {
  const good = { asr: 95, dlr: 90, delayS: 5, cost: 0.02 };
  const cheapButPoor = { asr: 70, dlr: 55, delayS: 5, cost: 0.01 };
  const slow = { asr: 95, dlr: 90, delayS: 50, cost: 0.02 };
  assert.deepEqual(byQbr([cheapButPoor, slow, good]), [good, slow, cheapButPoor]);
  assert.ok(Math.abs(qbrScore({ asr: 100, dlr: 100, delayS: 0, cost: 0.01 }, 0.01) - 1) < 1e-9);
  assert.ok(Math.abs(qbrScore({ asr: null, dlr: null, delayS: null, cost: null }, null) - 0.5) < 1e-9);
});

test("QBR weights per rule: cost-only weights pick the cheapest (team trial round 1)", () => {
  const good = { asr: 95, dlr: 90, delayS: 5, cost: 0.02 };
  const cheap = { asr: 70, dlr: 55, delayS: 5, cost: 0.01 };
  assert.deepEqual(byQbr([good, cheap], { asr: 0, dlr: 0, delay: 0, cost: 100 }), [cheap, good]);
  assert.deepEqual(byQbr([cheap, good], null), [good, cheap]);
});

test("split per customer trunk: each trunk's traffic follows the shares on its own (team trial round 1)", () => {
  const pick = (over: Record<string, unknown>, trunk: number, receiver: string) =>
    decide(rule({ customerTrunkMode: "all", ...over }), msg({ customerTrunkId: trunk, receiver }), options).vendor
      ?.vendorTrunkId;
  const receivers = Array.from({ length: 200 }, (_, i) => `4477009${String(i).padStart(5, "0")}`);
  // Off: the customer trunk makes no difference.
  assert.ok(receivers.every((r) => pick({}, 1, r) !== undefined && pick({}, 1, r) === pick({}, 2, r)));
  // On: the same number can go another way for another trunk, and each trunk still keeps about 60 / 40.
  const on = { percentagePerCustomerTrunk: true };
  assert.ok(receivers.some((r) => pick(on, 1, r) !== pick(on, 2, r)));
  const share = receivers.filter((r) => pick(on, 2, r) === 10).length / receivers.length;
  assert.ok(share > 0.45 && share < 0.75, `about 60 %, got ${share}`);
});

test("margin as an amount or a percentage of the sell rate, negative allowed (team trial round 1)", () => {
  // Sell 0.05; Vega leaves 0.025 (50 %), Kite 0.02 (40 %), Orbit 0.018 (36 %).
  const dyn = (over: Record<string, unknown>) =>
    decide(rule({ routeType: "dynamic", vendors: [], ...over }), msg(), options);
  assert.equal(dyn({ margin: 45, marginType: "percent" }).vendor?.vendorTrunkId, 12, "Vega leaves 50 %");
  assert.equal(dyn({ margin: 55, marginType: "percent" }).outcome, "no_vendor");
  assert.match(dyn({ margin: 55, marginType: "percent" }).candidates[0]!.note ?? "", /margin below 55 %/);
  const loss = new Map(options);
  loss.set(12, { vendorTrunkId: 12, name: "Vega_HQ", cost: 0.06, dlr: 80, categoryId: 1 });
  loss.set(10, { vendorTrunkId: 10, name: "Kite_DIR", cost: 0.07, dlr: 95, categoryId: 1 });
  loss.set(11, { vendorTrunkId: 11, name: "Orbit_DIR", cost: 0.08, dlr: 97, categoryId: 1 });
  const lossy = (over: Record<string, unknown>) =>
    decide(rule({ routeType: "dynamic", vendors: [], ...over }), msg(), loss).vendor?.vendorTrunkId;
  assert.equal(lossy({ margin: -0.015 }), 12, "an amount may be negative: −0.01 is allowed");
  assert.equal(lossy({ margin: -0.005 }), undefined);
  assert.equal(lossy({ margin: -25, marginType: "percent" }), 12, "−20 % is within −25 %");
});

test("a vendor whose own egress rules block the message is skipped for the next one (decided 2026-10-18)", () => {
  const first = decide(rule(), msg(), options).vendor!.vendorTrunkId;
  const other = first === 10 ? 11 : 10;
  const next = decide(rule(), msg({ egressBlocked: new Set([first]) }), options);
  assert.equal(next.outcome, "route");
  assert.equal(next.vendor?.vendorTrunkId, other);
  assert.match(next.candidates.find((c) => c.vendorTrunkId === first)!.note ?? "", /vendor translation/);
  const none = decide(rule(), msg({ egressBlocked: new Set([10, 11]) }), options);
  assert.equal(none.outcome, "no_vendor");
});

test("Match case for every Sender condition: exact capitals when on, any case when off (team trial round 1)", () => {
  const on = (over: Record<string, unknown>, m: Partial<MessageContext>) => {
    const r = rule({ senderPatternNegate: false, ...over });
    const got = decide(r, msg(m), options).matched;
    assert.equal(quickMatch(r, msg(m)), got, "quickMatch agrees with the checks");
    return got;
  };
  // Pattern (also the "is one of" / "starts with" / "contains" values built into it).
  assert.equal(on({ senderPattern: "^(?:BANK)$" }, { sender: "BANK" }), true);
  assert.equal(on({ senderPattern: "^(?:BANK)$" }, { sender: "Bank" }), false, "on by default: capitals count");
  assert.equal(on({ senderPattern: "^(?:BANK)$", senderMatchCase: false }, { sender: "Bank" }), true);
  assert.equal(on({ senderPattern: "^(?:BANK)$", senderMatchCase: undefined }, { sender: "Bank" }), false);
  assert.equal(on({ senderPattern: "(?:otp)", senderMatchCase: false }, { sender: "MyOTP" }), true);
  assert.equal(on({ senderPattern: "(?:otp)" }, { sender: "MyOTP" }), false);
  // Not Match with any case: "bank" is still BANK.
  assert.equal(
    on({ senderPattern: "^BANK$", senderPatternNegate: true, senderMatchCase: false }, { sender: "bank" }),
    false,
  );
  // Sender list: entries compared exactly, or lower-cased with Match case off.
  const entries = new Set(["BANK"]);
  const listHas = (_id: number, v: string, ignoreCase?: boolean) =>
    ignoreCase ? [...entries].some((e) => e.toLowerCase() === v.toLowerCase()) : entries.has(v);
  const list = { senderPattern: null, senderListId: 5 };
  assert.equal(on(list, { sender: "BANK", listHas }), true);
  assert.equal(on(list, { sender: "Bank", listHas }), false);
  assert.equal(on({ ...list, senderMatchCase: false }, { sender: "Bank", listHas }), true);
  const checks = conditionChecks(rule({ ...list, senderMatchCase: false }), msg({ sender: "Bank", listHas }));
  assert.match(checks.find((c) => c.condition === "Sender list")!.detail, /any case/);
  // Receiver and content conditions keep ignoring case.
  assert.equal(on({ senderPattern: null, contentPattern: "CODE" }, { content: "code 1234" }), true);
});

test("Sender ID keywords: \\Numeric and \\Alpha (team trial round 2)", () => {
  assert.equal(keywordPattern("\\Numeric"), "^\\+?[0-9]+$");
  assert.equal(keywordPattern(" \\numeric "), "^\\+?[0-9]+$");
  assert.equal(keywordPattern("^TEST"), null);
  const base = { customerTrunkMode: "all", mccmncMode: "all", senderPatternNegate: false };
  const r = rule({ ...base, senderPattern: "\\Numeric" });
  const hit = (x: unknown, sender: string) => {
    const m = msg({ sender });
    return quickMatch(x as never, m) && matches(conditionChecks(x as never, m), "all");
  };
  assert.ok(hit(r, "447700900123"));
  assert.ok(hit(r, "+447700900123"));
  assert.ok(!hit(r, "BANK1"));
  const alpha = rule({ ...base, senderPattern: "\\Alpha" });
  assert.ok(hit(alpha, "BANK1"));
  assert.ok(!hit(alpha, "12345"));
});

test("destination list and pattern: whichever is set; with both only the list counts (decided 2026-10-24, R1)", () => {
  const hit = (over: Record<string, unknown>, mccmnc: string) => {
    const r = rule({ customerTrunkMode: "all", senderPattern: null, ...over });
    const m = msg({ mccmnc });
    const full = matches(conditionChecks(r, m), "all");
    assert.equal(quickMatch(r, m), full, `quick vs full for ${JSON.stringify(over)} ${mccmnc}`);
    const kept = rulesForDestination([{ ...(r as object), id: 1 }] as never[], mccmnc, m.now).length > 0;
    assert.equal(kept, full, `pre-filter vs full for ${JSON.stringify(over)} ${mccmnc}`);
    return full;
  };
  // Only the list.
  assert.equal(hit({ mccmncs: ["50501"] }, "50501"), true);
  assert.equal(hit({ mccmncs: ["50501"] }, "26201"), false);
  // Only the pattern (no list).
  assert.equal(hit({ mccmncMode: "all", mccmncs: [], mccmncPattern: "^262" }, "26201"), true);
  assert.equal(hit({ mccmncMode: "all", mccmncs: [], mccmncPattern: "^262" }, "50501"), false);
  // Both: the list decides, the pattern is not checked.
  assert.equal(hit({ mccmncs: ["50501"], mccmncPattern: "^262" }, "50501"), true);
  assert.equal(hit({ mccmncs: ["50501"], mccmncPattern: "^262" }, "26201"), false);
  assert.equal(hit({ mccmncMode: "exclusive", mccmncs: ["50501"], mccmncPattern: "^505" }, "50502"), true);
  const checks = conditionChecks(
    rule({ customerTrunkMode: "all", senderPattern: null, mccmncs: ["50501"], mccmncPattern: "^262" }),
    msg(),
  );
  assert.match(checks.find((c) => c.condition === "Destination")!.detail, /list wins/);
});

test("sender and receiver lists can be negated - Not match (decided 2026-10-24, R2)", () => {
  const entries = new Set(["BANK", "61412345678"]);
  const listHas = (_id: number, v: string) => entries.has(v);
  const on = (over: Record<string, unknown>, m: Partial<MessageContext>) => {
    const r = rule({ customerTrunkMode: "all", mccmncMode: "all", mccmncs: [], senderPattern: null, ...over });
    const mm = msg({ listHas, ...m });
    const full = matches(conditionChecks(r, mm), "all");
    assert.equal(quickMatch(r, mm), full);
    return full;
  };
  assert.equal(on({ senderListId: 5 }, { sender: "BANK" }), true);
  assert.equal(on({ senderListId: 5, senderListNegate: true }, { sender: "BANK" }), false);
  assert.equal(on({ senderListId: 5, senderListNegate: true }, { sender: "SHOP" }), true);
  assert.equal(on({ receiverListId: 6 }, { receiver: "61412345678" }), true);
  assert.equal(on({ receiverListId: 6, receiverListNegate: true }, { receiver: "61412345678" }), false);
  assert.equal(on({ receiverListId: 6, receiverListNegate: true }, { receiver: "61400000000" }), true);
  const checks = conditionChecks(
    rule({ customerTrunkMode: "all", mccmncMode: "all", senderPattern: null, senderListId: 5, senderListNegate: true }),
    msg({ listHas, sender: "BANK" }),
  );
  assert.match(checks.find((c) => c.condition === "Sender list")!.detail, /must not be/);
});
