import { test } from "node:test";
import assert from "node:assert/strict";
import type { RouteRuleDetail } from "@sms/contract";
import {
  buildPattern,
  categoryFilter,
  formatMargin,
  parseMargin,
  parsePattern,
  rowsFromPattern,
  valuesSummary,
  vendorSwitches,
  backupProblems,
  clearCondition,
  compact,
  conditionChips,
  missingConditions,
  shareProblems,
  timeText,
  toInput,
} from "./ruleModel";

const NOW = Date.parse("2026-10-16T12:00:00Z");

const rule = (over: Partial<RouteRuleDetail> = {}): RouteRuleDetail => ({
  id: 17945,
  name: "AU OTP Premium",
  priority: 10,
  status: "active",
  startsAt: "2026-01-01T00:00:00Z",
  stopsAt: "2036-01-01T00:00:00Z",
  continueRouting: "stop",
  matchMode: "all",
  comment: null,
  categoryMode: "all",
  categoryIds: [],
  customerTrunkMode: "inclusive",
  customerTrunkIds: [1, 2],
  mccmncMode: "inclusive",
  mccmncs: ["50501", "50502"],
  mccmncPattern: null,
  senderPattern: "^(TEST|DEMO)",
  senderPatternNegate: true,
  senderMatchCase: true,
  receiverPattern: null,
  receiverPatternNegate: false,
  senderValues: [],
  receiverValues: [],
  contentPattern: null,
  contentPatternNegate: false,
  senderListId: null,
  senderListNegate: false,
  receiverListId: null,
  receiverListNegate: false,
  tps: { op: ">", value: 50, scope: "customer_trunk", windowS: 5, releasePct: 10, holdS: 30 },
  revenue: { type: "per_message", op: ">=", value: 0.04 },
  hlrPorted: null,
  routeType: "qbr",
  huntPolicy: "percentage",
  enableBackupRoutes: false,
  vendorCategoryMode: "all",
  vendorCategoryIds: [],
  vendorTrunkMode: "all",
  vendorTrunkIds: [],
  maxRouteLevel: 1,
  margin: 0,
  qbrFormula: null,
  skipVendorAtTpsPct: null,
  lcrProfileId: null,
  dlrTargetPct: null,
  hlrAction: null,
  denyMultipart: false,
  threshold: null,
  thresholdInterval: null,
  vendors: [],
  whitelists: [],
  archived: null,
  labels: {
    customerTrunks: [
      { id: 1, name: "Lumen_OTP" },
      { id: 2, name: "Lumen_OTP2" },
    ],
    categories: [],
    vendorTrunks: [],
    numberLists: [],
    hlrPolicies: [{ id: 1, name: "Default" }],
  },
  updatedBy: "Test User",
  updatedAt: "2026-10-16T10:00:00Z",
  ...over,
});

test("condition chips read as in the screenshot (§15.4)", () => {
  const chips = conditionChips(rule(), NOW).map((c) => [c.field, c.op, c.value].filter(Boolean).join(" "));
  assert.deepEqual(chips, [
    "Trunk inclusive Lumen_OTP, Lumen_OTP2",
    "Destination inclusive 50501, 50502",
    "Sender not ^(TEST|DEMO)",
    "TPS 5s > 50 · release 45",
    "Revenue/msg ≥ 0.040",
    "Time always",
  ]);
});

test("a sender condition with Match case off reads 'any case' (team trial round 1)", () => {
  const sender = (over: Partial<RouteRuleDetail>) => conditionChips(rule(over), NOW).find((c) => c.key === "sender")!;
  assert.equal(sender({}).value, "^(TEST|DEMO)");
  assert.equal(sender({ senderMatchCase: false }).value, "^(TEST|DEMO) · any case");
  assert.equal(clearCondition("sender", rule({ senderMatchCase: false })).senderMatchCase, true);
  assert.equal(toInput(rule({ senderMatchCase: false })).senderMatchCase, false);
});

test("destinations by name, exclusive lists, accumulated revenue and HLR action", () => {
  const chips = conditionChips(
    rule({
      customerTrunkMode: "exclusive",
      mccmncs: ["505"],
      revenue: { type: "accumulated", op: "between", value: 10, value2: 20, period: "today", scope: "rule" },
      hlrAction: { policyId: 1, customerTrunkIds: [] },
      tps: null,
    }),
    NOW,
    (codes) => codes.map((c) => (c === "505" ? "Australia · All networks (505)" : c)).join(", "),
  );
  const text = chips.map((c) => `${c.field}|${c.op}|${c.value}`);
  assert.ok(text.includes("Trunk|exclusive|Lumen_OTP, Lumen_OTP2"));
  assert.ok(text.includes("Destination|inclusive|Australia · All networks (505)"), "names first (team trial round 1)");
  assert.ok(text.includes("Revenue today|between|10.000 – 20.000 per rule"));
  assert.ok(text.includes("HLR action||Default · all trunks"), "the policy is shown by name");
});

test("time reads always, from, until or a range", () => {
  assert.equal(timeText("2026-01-01T00:00:00Z", "2036-01-01T00:00:00Z", NOW), "always");
  assert.equal(timeText("2026-11-01T08:00:00Z", "2036-01-01T00:00:00Z", NOW), "from 2026-11-01 08:00");
  assert.equal(timeText("2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z", NOW), "until 2026-12-31 00:00");
});

test("clearing a condition and the conditions still to add", () => {
  assert.deepEqual(clearCondition("trunk", rule()), { customerTrunkMode: "all", customerTrunkIds: [] });
  assert.deepEqual(clearCondition("tps", rule()), { tps: null });
  const missing = missingConditions(rule());
  // Category, trunk and destination are under Configuration, not "+ Add condition" (team trial round 2).
  assert.ok(missing.includes("hlrAction") && !missing.includes("category") && !missing.includes("destination"));
  assert.ok(!missing.includes("trunk") && !missing.includes("time"));
});

test("the edit input carries every rule field and nothing else", () => {
  const input = toInput(rule(), { matchMode: "any" });
  assert.equal(input.matchMode, "any");
  assert.equal(input.name, "AU OTP Premium");
  for (const k of ["id", "labels", "archived", "updatedBy", "updatedAt"]) assert.ok(!(k in input), k);
});

test("percentage shares must add up to 100 per level; counts read compact", () => {
  const v = (level: number, sharePct: number, isBackup = false) => ({ level, vendorTrunkId: 1, sharePct, isBackup });
  assert.deepEqual(shareProblems([v(1, 60), v(1, 40), v(2, 100)], "percentage"), []);
  assert.deepEqual(shareProblems([v(1, 60), v(1, 30), v(1, 50, true)], "percentage"), [
    "Level 1 shares add up to 90%, not 100%.",
  ]);
  assert.deepEqual(shareProblems([v(1, 10)], "top_down"), []);
  assert.equal(compact(28_200), "28.2k");
  assert.equal(compact(812), "812");
  assert.equal(compact(null), "—");
});

test("a vendor's own backups: all chosen, shares add up to 100 when several (team trial round 1)", () => {
  const b = (id: number, share: number) => ({
    level: 1,
    vendorTrunkId: id,
    sharePct: share,
    isBackup: true,
    backupForVendorTrunkId: 7,
  });
  const name = (id: number) => `#${id}`;
  assert.deepEqual(backupProblems([b(3, 100)], name), []);
  assert.deepEqual(backupProblems([b(3, 70), b(4, 30)], name), []);
  assert.deepEqual(backupProblems([b(3, 70), b(0, 20)], name), [
    "Choose every backup of #7.",
    "Backups of #7 add up to 90%, not 100%.",
  ]);
});

test("vendor switches: the main vendor per bucket, listed when it changes (team trial round 1)", () => {
  const b = (at: string, ...v: [number, number][]) => ({
    at,
    messages: v.reduce((n, [, m]) => n + m, 0),
    vendors: v.map(([vendorTrunkId, messages]) => ({ vendorTrunkId, messages })),
  });
  const s = vendorSwitches([
    b("10:00", [1, 90], [2, 10]),
    b("11:00", [1, 80], [2, 20]),
    { at: "12:00", messages: 0, vendors: [] },
    b("13:00", [2, 70], [1, 30]),
    b("14:00", [1, 100]),
  ]);
  assert.deepEqual(
    s.map((x) => [x.at, x.vendorTrunkId, x.sharePct, x.untilAt]),
    [
      ["10:00", 1, 90, "13:00"],
      ["13:00", 2, 70, "14:00"],
      ["14:00", 1, 100, null],
    ],
  );
});

test("value lists become patterns and back; other regex stays regex (team trial round 1)", () => {
  assert.equal(buildPattern("is", ["BANK", "OTP", " "]), "^(?:BANK|OTP)$");
  assert.equal(buildPattern("starts", ["4479"]), "^(?:4479)");
  assert.equal(buildPattern("contains", ["your code", "a.b (x)"]), "(?:your code|a\\.b \\(x\\))");
  assert.equal(buildPattern("is", []), null);
  assert.deepEqual(parsePattern("^(?:BANK|OTP)$"), { kind: "is", values: ["BANK", "OTP"] });
  assert.deepEqual(parsePattern("(?:your code|a\\.b \\(x\\))"), { kind: "contains", values: ["your code", "a.b (x)"] });
  assert.deepEqual(parsePattern("^(?:4479)"), { kind: "starts", values: ["4479"] });
  assert.equal(parsePattern("^(TEST|DEMO)").kind, "regex");
  assert.equal(parsePattern("^(?:A.*)$").kind, "regex", "a regex inside the shape stays regex");
  for (const [kind, vals] of [
    ["is", ["Brand+1", "x|y"]],
    ["contains", ["50% off", "[promo]"]],
  ] as const) {
    const p = buildPattern(kind, vals)!;
    assert.deepEqual(parsePattern(p), { kind, values: vals });
    assert.ok(vals.every((v) => new RegExp(p, "i").test(kind === "is" ? v : `x ${v} y`)));
  }
});

test("trunk pickers follow the rule's categories (team trial round 1)", () => {
  assert.deepEqual(categoryFilter("all", [1]), []);
  assert.deepEqual(categoryFilter("inclusive", []), []);
  assert.deepEqual(categoryFilter("inclusive", [2, 5]), [{ field: "categoryId", op: "in", values: ["2", "5"] }]);
  assert.deepEqual(categoryFilter("exclusive", [2]), [{ field: "categoryId", op: "not_in", values: ["2"] }]);
});

test("margin as typed: amount, percent, negative (team trial round 1)", () => {
  assert.deepEqual(parseMargin("0.002"), { value: 0.002, type: "amount" });
  assert.deepEqual(parseMargin("5%"), { value: 5, type: "percent" });
  assert.deepEqual(parseMargin(" -3.5 % "), { value: -3.5, type: "percent" });
  assert.deepEqual(parseMargin("-0,001"), { value: -0.001, type: "amount" });
  assert.deepEqual(parseMargin(""), { value: 0, type: "amount" });
  assert.equal(parseMargin("abc"), null);
  assert.equal(parseMargin("5%%"), null);
  assert.equal(formatMargin(-2, "percent"), "-2%");
  assert.equal(formatMargin(0.003, "amount"), "0.003");
});

test("value rows: an older value-list pattern opens as rows; summary groups by match and case (team trial round 8)", () => {
  assert.deepEqual(rowsFromPattern("^(?:BANK|OTP)$", true), [
    { value: "BANK", match: "is", matchCase: true },
    { value: "OTP", match: "is", matchCase: true },
  ]);
  assert.deepEqual(rowsFromPattern("^(?:44)", false), [{ value: "44", match: "starts", matchCase: false }]);
  assert.equal(rowsFromPattern("^(TEST|DEMO)", true), null, "a free regex stays a regex");
  assert.equal(rowsFromPattern(null, true), null);
  const rows = [
    { value: "BANK", match: "is" as const, matchCase: true },
    { value: "SHOP", match: "is" as const, matchCase: true },
    { value: "otp", match: "starts" as const, matchCase: false },
  ];
  assert.equal(valuesSummary(rows, true), "is BANK, SHOP · starts with otp (any case)");
  assert.equal(valuesSummary(rows, false), "is BANK, SHOP · starts with otp");
});
