// Number lists and Translation rules (build step 5.3, §6.4, §13.2): the translation engine on
// its own, then the API against the seeded database. Every response is checked against the
// contract; each test undoes its own changes (§13.10).
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { Change, TranslationRuleInput } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import {
  formatNumber,
  convert,
  entryMatches,
  fillContentTemplate,
  rewriteText,
  runRules,
  type EngineContext,
  type EngineRule,
} from "../src/routing/translate.js";
import { entryProblem } from "../src/api/numberLists.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
after(async () => {
  await app.close();
  await closeDb();
});

function check(operationId: string, res: LightMyRequestResponse) {
  const op = operations.find((o) => o.operationId === operationId)!;
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `${operationId} answered ${status}, which the contract does not list: ${res.body}`);
  const validate = op.responses[status];
  if (validate && /json/.test(String(res.headers["content-type"])))
    assert.ok(validate(res.json()), `${operationId} ${status}: ${JSON.stringify(validate.errors)}`);
}

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function ok(operationId: string, res: Promise<LightMyRequestResponse>, status = 200) {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return /json/.test(String(r.headers["content-type"])) ? r.json() : r.body;
}

const undo = (change: Change | null) =>
  change ? ok("undoChange", call("POST", `/changes/${change.id}/undo`, {})) : Promise.resolve(null);
const run = Date.now().toString(36).slice(-5);

const BLANK: Omit<TranslationRuleInput, "name" | "targets"> = {
  direction: null,
  action: "allow",
  status: "active",
  continueAfter: true,
  senderPattern: null,
  senderPatternNegate: false,
  receiverPattern: null,
  receiverPatternNegate: false,
  mccmncs: [],
  mccmncNegate: false,
  contentPattern: null,
  contentPatternNegate: false,
  senderListId: null,
  senderListNegate: false,
  receiverListId: null,
  receiverListNegate: false,
  senderConversion: null,
  senderConversionValue: null,
  senderConversionReplacement: null,
  senderConversionListId: null,
  receiverConversion: null,
  receiverConversionValue: null,
  receiverConversionReplacement: null,
  senderTon: null,
  senderNpi: null,
  destTon: null,
  destNpi: null,
  billingType: null,
  registeredDelivery: null,
  dlrMap: [],
  contentRegex: null,
  contentRegexIndex: null,
  contentReplacement: null,
  msgTemplate: null,
  senderMinLength: 0,
  senderMaxLength: 20,
  receiverMinLength: 0,
  receiverMaxLength: 20,
  startsAt: null,
  stopsAt: null,
  insertAt: "bottom",
  contentWords: [],
};
const rule = (id: number, over: Partial<EngineRule>): EngineRule =>
  ({ id, name: `R${id}`, ...BLANK, contentWords: BLANK.contentWords ?? [], ...over }) as EngineRule;
const ctx: EngineContext = {
  lists: new Map([
    [1, ["4479001"]],
    [2, ["BRAND{n}{n}"]],
  ]),
  mccmncOf: (r) => (r.startsWith("44") ? "23415" : null),
  now: new Date("2026-10-17T12:00:00Z"),
  rand: () => 0.5,
};
const msg = { sender: "4479001", receiver: "0044712345678", text: "Your code is 1234" };

describe("translation engine (§6.4)", () => {
  test("conversions: strip, prepend, append, translation, regex replace", () => {
    assert.equal(convert("left_strip", "2", "0044"), "44");
    assert.equal(convert("right_strip", "1", "12345"), "1234");
    assert.equal(convert("prepend", "+", "44"), "+44");
    assert.equal(convert("append", "X", "AB"), "ABX");
    assert.equal(convert("translation", "00=+", "0044"), "+44");
    assert.equal(convert("translation", "00=+", "44"), "44", "no prefix, no change");
    assert.equal(
      convert("translation", "BRAND", "INFO"),
      "BRAND",
      "the new value replaces what the conditions matched",
    );
    assert.equal(
      fillContentTemplate("[OurBrand] code {code}", "Your PIN: 482913, valid 5 min"),
      "[OurBrand] code 482913",
    );
    assert.equal(fillContentTemplate("{text}", "hi"), "hi");
    // Regex Replace next to the prefix swap (decided 2026-10-17)
    assert.equal(convert("regex_replace", "^0(\\d+)", "07123456", "44$1"), "447123456");
    assert.equal(convert("regex_replace", "^(\\d{3})\\d{4}", "4471234567", "$1XXXX"), "447XXXX567");
    assert.equal(convert("regex_replace", "[^0-9]", "+44 7123", ""), "447123", "empty replacement removes");
  });

  test("content rewrite: regex group, whole match, template", () => {
    const r = rule(1, { contentRegex: "code is ([0-9]+)", contentRegexIndex: 1, contentReplacement: "****" });
    assert.equal(rewriteText(r, msg.text), "Your code is ****");
    assert.equal(rewriteText({ ...r, contentRegexIndex: null }, msg.text), "Your ****");
    // Message Text reuses the pattern's groups (team trial round 2): extract the code into a new text.
    const pin = rule(2, {
      contentRegex: "^.*?([0-9]{4,8}).*$",
      contentRegexIndex: null,
      contentReplacement: "PIN $1 for you",
    });
    assert.equal(rewriteText(pin, "Your code is 482913. FREE gift at bit.ly/x"), "PIN 482913 for you");
    const tpl = { ...pin, contentReplacement: "$1", msgTemplate: "PIN {text} for you" };
    assert.equal(rewriteText(tpl, "Your code is 482913. FREE gift at bit.ly/x"), "PIN 482913 for you");
    assert.equal(rewriteText(rule(2, { msgTemplate: "[ACME] {text}" }), "hi"), "[ACME] hi");
  });

  test("number format in content: any length, short numbers untouched (team trial round 6)", () => {
    const r = rule(3, { contentNumberFormat: "### ### ###", contentNumberMinDigits: 6 });
    assert.equal(rewriteText(r, "Call 210271019 or code 1234"), "Call 210 271 019 or code 1234");
    assert.equal(rewriteText(r, "Ref 210271019123"), "Ref 210 271 019 123", "a longer number repeats the last group");
    assert.equal(rewriteText(r, "Ref 21027101"), "Ref 210 271 01");
    assert.equal(formatNumber("2102710190", "(###) ###-####"), "(210) 271-0190");
    assert.equal(rewriteText(rule(4, { contentNumberFormat: null }), "210271019"), "210271019", "off");
  });

  test("rules run in order, Not Match, lists, network, Stop and block", () => {
    const res = runRules(
      [
        { rule: rule(1, { receiverPattern: "^00", receiverConversion: "left_strip", receiverConversionValue: "2" }) },
        { rule: rule(2, { mccmncs: ["234", "23415"], senderListId: 1, destTon: 1, destNpi: 1 }) },
        { rule: rule(3, { senderPattern: "^44", senderPatternNegate: true, action: "block" }) },
        {
          rule: rule(4, { senderConversion: "sender_id_template", senderConversionListId: 2 }),
          continueAfter: false,
        },
        { rule: rule(5, { action: "block" }) },
      ],
      { ...msg, dlrStatus: "UNKNOWN" },
      ctx,
    );
    assert.equal(res.after.receiver, "44712345678");
    assert.equal(res.after.mccmnc, "23415", "the network follows the converted receiver");
    assert.equal(res.after.destTon, 1);
    assert.equal(res.steps[2]!.matched, false, "Not Match on a matching sender");
    assert.equal(res.after.sender, "BRAND55");
    assert.equal(res.steps.length, 4, "rule 4 matched with Stop, so rule 5 never ran");
    assert.equal(res.blocked, false);
  });

  test("a Stop rule that only maps receipts does not stop a message; it stops a receipt (team trial round 12)", () => {
    const rules = [
      {
        rule: rule(1, { dlrMap: [{ fromStatus: "unknown", fromError: null, toStatus: "UNDELIV", toError: "001" }] }),
        continueAfter: false,
      },
      { rule: rule(2, { contentWords: [{ find: "code", replace: "PIN", wholeWord: true, matchCase: false }] }) },
    ];
    const sms = runRules(rules, msg, ctx);
    assert.equal(sms.after.text, "Your PIN is 1234", "the content rule after it ran");
    const receipt = runRules(rules, { ...msg, dlrStatus: "UNKNOWN", dlrError: "000" }, ctx);
    assert.equal(receipt.steps.length, 1, "on a receipt the DLR rule applies and stops the run");
  });

  test("block, length guards, time window and DLR conversion", () => {
    const blocked = runRules([{ rule: rule(1, { action: "block", contentPattern: "code" }) }], msg, ctx);
    assert.equal(blocked.blocked, true);
    const short = runRules([{ rule: rule(1, { action: "block", senderMinLength: 10 }) }], msg, ctx);
    assert.equal(short.blocked, false, "the guard fails, so the rule does not match");
    const later = runRules([{ rule: rule(1, { action: "block", startsAt: "2027-01-01T00:00:00Z" }) }], msg, ctx);
    assert.equal(later.blocked, false);
    const dlr = runRules(
      [
        {
          rule: rule(1, { dlrMap: [{ fromStatus: "unknown", fromError: null, toStatus: "UNDELIV", toError: "001" }] }),
        },
      ],
      { ...msg, dlrStatus: "UNKNOWN", dlrError: "000" },
      ctx,
    );
    assert.deepEqual([dlr.after.dlrStatus, dlr.after.dlrError], ["UNDELIV", "001"]);
  });

  test("match lists of any type; a template entry's {n} matches one digit", () => {
    assert.ok(entryMatches("4479001", "4479001"));
    assert.ok(entryMatches("SHOP{n}{n}", "SHOP42"));
    assert.ok(!entryMatches("SHOP{n}{n}", "SHOP4"));
    assert.ok(!entryMatches("A.B{n}", "AXB1"), "other characters are literal");
    const res = runRules([{ rule: rule(1, { senderListId: 2, action: "block" }) }], { ...msg, sender: "BRAND07" }, ctx);
    assert.equal(res.blocked, true);
  });

  test("value rows, each with its own match and case (team trial round 8)", () => {
    const blocked = (over: Partial<EngineRule>, sender: string) =>
      runRules([{ rule: rule(1, { action: "block", ...over }) }], { ...msg, sender }, ctx).blocked;
    const rows = [
      { value: "BANK", match: "is" as const, matchCase: true },
      { value: "promo", match: "contains" as const, matchCase: false },
    ];
    assert.equal(blocked({ senderValues: rows }, "BANK"), true);
    assert.equal(blocked({ senderValues: rows }, "bank"), false);
    assert.equal(blocked({ senderValues: rows }, "BIG-PROMO"), true);
    assert.equal(blocked({ senderValues: rows, senderPatternNegate: true }, "BIG-PROMO"), false);
    assert.equal(blocked({ receiverValues: [{ value: "0044", match: "starts", matchCase: false }] }, "x"), true);
  });

  test("Match case for the Sender ID conditions: exact capitals when on, any case when off (team trial round 1)", () => {
    const lists: EngineContext = { ...ctx, lists: new Map([[3, ["BANK", "SHOP{n}"]]]) };
    const blocked = (over: Partial<EngineRule>, sender: string) =>
      runRules([{ rule: rule(1, { action: "block", ...over }) }], { ...msg, sender }, lists).blocked;
    // Pattern
    assert.equal(blocked({ senderPattern: "^BANK$" }, "BANK"), true);
    assert.equal(blocked({ senderPattern: "^BANK$" }, "Bank"), false, "on by default");
    assert.equal(blocked({ senderPattern: "^BANK$", senderMatchCase: true }, "Bank"), false);
    assert.equal(blocked({ senderPattern: "^BANK$", senderMatchCase: false }, "Bank"), true);
    assert.equal(
      blocked({ senderPattern: "^BANK$", senderPatternNegate: true, senderMatchCase: false }, "bank"),
      false,
    );
    // List, plain and template entries
    assert.equal(blocked({ senderListId: 3 }, "bank"), false);
    assert.equal(blocked({ senderListId: 3, senderMatchCase: false }, "bank"), true);
    assert.equal(blocked({ senderListId: 3 }, "shop1"), false);
    assert.equal(blocked({ senderListId: 3, senderMatchCase: false }, "shop1"), true);
    assert.ok(entryMatches("BANK", "Bank", false) && !entryMatches("BANK", "Bank"));
    // Receiver and content patterns keep their behaviour (exact case).
    assert.equal(
      runRules(
        [{ rule: rule(1, { action: "block", senderMatchCase: false, contentPattern: "CODE" }) }],
        { ...msg, sender: "x" },
        lists,
      ).blocked,
      false,
    );
    const steps = runRules(
      [{ rule: rule(1, { senderPattern: "^BANK$", senderMatchCase: false }) }],
      { ...msg, sender: "bank" },
      lists,
    ).steps;
    assert.match(steps[0]!.checks[0]!.detail, /any case/);
  });

  test("number list values by type", () => {
    assert.equal(entryProblem("random", "447900123"), null);
    assert.ok(entryProblem("random", "44A"));
    assert.equal(entryProblem("sender_id_template", "SHOP{n}{n}"), null);
    assert.ok(entryProblem("sender_id_template", "MUCH_TOO_LONG_NAME"));
    assert.equal(entryProblem("tag", "VIP sender"), null);
  });
});

describe("number lists API", { skip }, () => {
  test("add, entries, import dry run and replace, export, delete blocked while used, undo", async () => {
    const created = await ok(
      "createNumberList",
      call("POST", "/number-lists", { name: `Test list ${run}`, listType: "random" }),
      201,
    );
    const id = created.record.id as number;
    const added = await ok(
      "addNumberListEntries",
      call("POST", `/number-lists/${id}/entries`, { values: ["447900000001", "447900000002", "447900000001"] }),
    );
    assert.equal(added.added, 2);
    assert.equal(added.skipped, 1);
    const bad = await ok("addNumberListEntries", call("POST", `/number-lists/${id}/entries`, { values: ["ABC"] }));
    assert.equal(bad.added, 0);
    assert.equal(bad.errors.length, 1);
    const entries = await ok(
      "queryNumberListEntries",
      call("POST", "/number-list-entries/query", {
        limit: 10,
        filter: { logic: "and", conditions: [{ field: "numberListId", op: "eq", value: id }] },
      }),
    );
    assert.equal(entries.total, 2);
    const noList = await call("POST", "/number-list-entries/query", { limit: 10 });
    assert.equal(noList.statusCode, 400, "the list id is required");

    const csv = "value\n447900000002\n447900000003\n";
    const dry = await ok(
      "importNumberListEntries",
      call("POST", `/number-lists/${id}/import`, { csv, mode: "replace", dryRun: true }),
    );
    assert.deepEqual([dry.applied, dry.added, dry.unchanged, dry.archived], [false, 1, 1, 1]);
    const done = await ok(
      "importNumberListEntries",
      call("POST", `/number-lists/${id}/import`, { csv: "447900000002\n447900000003", mode: "replace", dryRun: false }),
    );
    assert.equal(done.applied, true);
    const file = await call("GET", `/number-lists/${id}/export`);
    assert.equal(file.body.trim().split(/\r?\n/).join(","), "value,447900000002,447900000003");

    // The type cannot change to one the entries do not fit.
    const retype = await call("PUT", `/number-lists/${id}`, {
      name: `Test list ${run}`,
      listType: "sender_id_template",
    });
    assert.equal(retype.statusCode, 400);

    // Used by a rule: delete is blocked.
    const r = await ok(
      "createTranslationRule",
      call("POST", "/translation-rules", {
        ...BLANK,
        name: `Uses list ${run}`,
        status: "inactive",
        senderConversion: "random_number",
        senderConversionListId: id,
        targets: [],
      }),
      201,
    );
    const deps = await ok("getNumberListDependencies", call("GET", `/number-lists/${id}/dependencies`));
    assert.equal(deps.blocked, true);
    const blocked = await call("POST", `/number-lists/${id}/archive`, {});
    assert.equal(blocked.statusCode, 409);
    check("archiveNumberList", blocked);
    await undo(r.change);
    const gone = await ok("archiveNumberList", call("POST", `/number-lists/${id}/archive`, {}));
    assert.ok(gone.record.archivedAt);
    await undo(gone.change);
    await undo(done.change);
    await undo(added.change);
    const back = await ok(
      "queryNumberListEntries",
      call("POST", "/number-list-entries/query", {
        limit: 10,
        filter: { logic: "and", conditions: [{ field: "numberListId", op: "eq", value: id }] },
      }),
    );
    assert.equal(back.total, 0, "undoing the add archives its entries");
    await undo(created.change);
  });

  test("number lists page at full volume", async () => {
    const page = await ok("queryNumberLists", call("POST", "/number-lists/query", { limit: 50 }));
    assert.ok(page.rows.length > 0);
    // Hover lists (team trial round 1): the first entries and the rules using the list.
    for (const r of page.rows as { entries: number; entryValues: string[]; usedBy: number; usedByNames: string[] }[]) {
      assert.equal(r.entryValues.length, Math.min(100, r.entries));
      assert.equal(r.usedByNames.length, Math.min(100, r.usedBy));
    }
    const dupes = await db().query(
      `SELECT number_list_id, value FROM number_list_entries WHERE deleted_at IS NULL
        GROUP BY 1, 2 HAVING count(*) > 1 LIMIT 1`,
    );
    assert.equal(dupes.rows.length, 0, "values are unique per list");
  });
});

describe("translation rules API", { skip }, () => {
  test("create with targets, edit, used by, validation, test, undo field by field", async () => {
    const { rows } = await db().query("SELECT id FROM customer_trunks WHERE deleted_at IS NULL ORDER BY id LIMIT 2");
    const [t1, t2] = rows.map((r) => Number(r.id));
    const input: TranslationRuleInput = {
      ...BLANK,
      name: `Strip 00 ${run}`,
      receiverPattern: "^00",
      receiverConversion: "left_strip",
      receiverConversionValue: "2",
      targets: [{ type: "trunk", trunkKind: "customer", id: t1! }],
      // First on the trunk, so a seeded rule that stops processing cannot keep it from running.
      insertAt: "top",
    };
    const created = await ok("createTranslationRule", call("POST", "/translation-rules", input), 201);
    const id = created.record.id as number;
    assert.equal(created.record.usedBy, 1);
    assert.equal(created.record.senderMatchCase, true, "missing in the input = Match case on");
    assert.deepEqual(created.record.senderValues, [], "missing in the input = no value rows");
    const usedBy = await ok("getTranslationRuleUsedBy", call("GET", `/translation-rules/${id}/used-by`));
    assert.equal(usedBy.trunks[0].id, t1);

    const invalid = await call("PUT", `/translation-rules/${id}`, {
      ...input,
      senderPattern: "([",
      senderConversion: "random_number",
    });
    assert.equal(invalid.statusCode, 400);
    const paths = invalid.json().errors.map((e: { path: string }) => e.path);
    assert.ok(paths.includes("/senderPattern") && paths.includes("/senderConversionListId"), paths.join());

    const edited = await ok(
      "updateTranslationRule",
      call("PUT", `/translation-rules/${id}`, {
        ...input,
        continueAfter: false,
        targets: [...input.targets, { type: "trunk", trunkKind: "customer", id: t2! }],
      }),
    );
    assert.deepEqual(edited.change.diff.map((d: { field: string }) => d.field).sort(), ["continueAfter", "targets"]);
    assert.equal(edited.record.usedBy, 2);

    const regex = await ok(
      "testTranslationRule",
      call("POST", `/translation-rules/${id}/test`, {
        message: { sender: "ACME", receiver: "07123456", text: "hi" },
        rule: {
          ...input,
          receiverPattern: null,
          receiverConversion: "regex_replace",
          receiverConversionValue: "^0(\\d+)",
          receiverConversionReplacement: "44$1",
        },
      }),
    );
    assert.equal(regex.after.receiver, "447123456");
    const badRegex = await call("POST", `/translation-rules/${id}/test`, {
      message: { sender: "A", receiver: "1", text: "" },
      rule: { ...input, receiverConversion: "regex_replace", receiverConversionValue: "([" },
    });
    assert.equal(badRegex.statusCode, 400);
    const tested = await ok(
      "testTranslationRule",
      call("POST", `/translation-rules/${id}/test`, {
        message: { sender: "ACME", receiver: "0044712345678", text: "hi" },
        rule: { ...input, receiverConversionValue: "1" },
      }),
    );
    assert.equal(tested.after.receiver, "044712345678", "the unsaved form is tested");
    const trunk = await ok(
      "testCustomerTrunkRules",
      call("POST", `/customer-trunks/${t1}/rules/test`, {
        message: { sender: "ACME", receiver: "0044712345678", text: "hi" },
      }),
    );
    assert.ok(
      trunk.steps.some((s: { ruleId: number }) => s.ruleId === id),
      "the new rule runs on the trunk",
    );

    await undo(edited.change);
    const restored = await ok("getTranslationRule", call("GET", `/translation-rules/${id}`));
    assert.equal(restored.continueAfter, true);
    assert.equal(restored.targets.length, 1);
    await undo(created.change);
    const archived = await ok("getTranslationRule", call("GET", `/translation-rules/${id}`));
    assert.ok(archived.archivedAt, "undoing the create archives the rule");
  });

  test("Sender ID Match case: saved, tested, undone (team trial round 1)", async () => {
    const input: TranslationRuleInput = {
      ...BLANK,
      name: `Block BANK ${run}`,
      action: "block",
      senderPattern: "^BANK$",
      targets: [],
    };
    const created = await ok("createTranslationRule", call("POST", "/translation-rules", input), 201);
    const id = created.record.id as number;
    const test = (sender: string) =>
      ok(
        "testTranslationRule",
        call("POST", `/translation-rules/${id}/test`, { message: { sender, receiver: "447123456", text: "hi" } }),
      );
    assert.equal((await test("Bank")).blocked, false, "exact capitals by default");
    const edited = await ok(
      "updateTranslationRule",
      call("PUT", `/translation-rules/${id}`, { ...input, senderMatchCase: false }),
    );
    assert.deepEqual(
      edited.change.diff.map((d: { field: string }) => d.field),
      ["senderMatchCase"],
    );
    assert.equal(edited.record.senderMatchCase, false);
    assert.equal((await test("Bank")).blocked, true, "any case");
    await undo(edited.change);
    const restored = await ok("getTranslationRule", call("GET", `/translation-rules/${id}`));
    assert.equal(restored.senderMatchCase, true);
    await undo(created.change);
  });

  test("Sender ID value rows: saved trimmed, kept when left out, tested, undone (team trial round 8)", async () => {
    const input: TranslationRuleInput = { ...BLANK, name: `Block rows ${run}`, action: "block", targets: [] };
    const created = await ok("createTranslationRule", call("POST", "/translation-rules", input), 201);
    const id = created.record.id as number;
    assert.deepEqual(created.record.senderValues, [], "missing in the input = no rows");
    const edited = await ok(
      "updateTranslationRule",
      call("PUT", `/translation-rules/${id}`, {
        ...input,
        senderValues: [{ value: " BANK ", match: "is", matchCase: false }],
      }),
    );
    assert.deepEqual(edited.record.senderValues, [{ value: "BANK", match: "is", matchCase: false }]);
    const kept = await ok("updateTranslationRule", call("PUT", `/translation-rules/${id}`, input));
    assert.equal(kept.change, null, "rows left out of an edit are kept");
    const test = (sender: string) =>
      ok(
        "testTranslationRule",
        call("POST", `/translation-rules/${id}/test`, { message: { sender, receiver: "447123456", text: "hi" } }),
      );
    assert.equal((await test("bank")).blocked, true, "the row ignores case");
    assert.equal((await test("BANKS")).blocked, false, "is = the whole value");
    const found = await ok(
      "queryTranslationRules",
      call("POST", "/translation-rules/query", {
        limit: 50,
        filter: { logic: "and", conditions: [{ field: "senderPattern", op: "like", value: "BANK" }] },
      }),
    );
    assert.ok(found.rows.some((r: { id: number }) => r.id === id), "the Sender ID filter finds row values");
    await undo(edited.change);
    assert.deepEqual((await ok("getTranslationRule", call("GET", `/translation-rules/${id}`))).senderValues, []);
    await undo(created.change);
  });

  test("rows carry names for the hover lists; MCCMNC filters by name or code", async () => {
    const page = await ok("queryTranslationRules", call("POST", "/translation-rules/query", { limit: 500 }));
    for (const r of page.rows as {
      mccmncs: string[];
      mccmncNames: string[];
      appliesTo: string;
      appliesToNames: string[];
      appliesToCount: number;
    }[]) {
      assert.ok(r.mccmncNames.length <= Math.min(100, r.mccmncs.length));
      assert.equal(r.appliesToNames.length, Math.min(100, r.appliesToCount));
      if (r.appliesTo === "Not assigned") assert.equal(r.appliesToCount, 0);
    }
    const withCodes = (page.rows as { mccmncs: string[]; mccmncNames: string[] }[]).find((r) => r.mccmncNames.length);
    assert.ok(withCodes, "some rule lists destinations");
    const country = withCodes!.mccmncNames[0]!.split(" · ")[0]!;
    const like = (value: string) =>
      ok(
        "queryTranslationRules",
        call("POST", "/translation-rules/query", {
          limit: 500,
          filter: { logic: "and", conditions: [{ field: "mccmncs", op: "like", value }] },
        }),
      );
    const byName = await like(`${country}%`);
    assert.ok(byName.rows.some((r: { id: number }) => r.id === (withCodes as unknown as { id: number }).id));
    const byCode = await like(`${withCodes!.mccmncs[0]}%`);
    assert.ok(byCode.total > 0);
  });

  test("duplicate to trunk replaces the original on that trunk only", async () => {
    const page = await ok(
      "queryTranslationRules",
      call("POST", "/translation-rules/query", {
        limit: 1,
        sort: [{ field: "usedBy", dir: "desc" }],
        filter: { logic: "and", conditions: [{ field: "status", op: "eq", value: "active" }] },
      }),
    );
    const src = page.rows[0];
    const usedBy = await ok("getTranslationRuleUsedBy", call("GET", `/translation-rules/${src.id}/used-by`));
    const trunk = usedBy.trunks[0];
    const copy = await ok(
      "cloneTranslationRule",
      call("POST", `/translation-rules/${src.id}/clone`, { targetTrunk: { kind: trunk.kind, id: trunk.id } }),
      201,
    );
    assert.equal(copy.record.status, "active");
    assert.equal(copy.record.usedBy, 1);
    const onTrunk = async () => {
      const r = await ok(
        trunk.kind === "customer" ? "getCustomerTrunkRules" : "getVendorTrunkRules",
        call("GET", `/${trunk.kind}-trunks/${trunk.id}/rules`),
      );
      const find = (rid: number) => r.translation.find((x: { ruleId: number }) => x.ruleId === rid);
      return { original: find(src.id), copy: find(copy.record.id) };
    };
    const now = await onTrunk();
    assert.equal(now.original.enabled, false, "the original is off on that trunk");
    assert.equal(now.copy.enabled, true);
    const plain = await ok("cloneTranslationRule", call("POST", `/translation-rules/${src.id}/clone`, {}), 201);
    assert.equal(plain.record.status, "inactive", "a plain clone waits for review");
    assert.equal(plain.record.targets.length, 0);
    await undo(plain.change);
    await undo(copy.change);
    const after = await onTrunk();
    assert.equal(after.original.enabled, trunk.enabled, "undo switches the original back");
  });

  test("archive and restore, list filters at full volume", async () => {
    const page = await ok(
      "queryTranslationRules",
      call("POST", "/translation-rules/query", {
        limit: 20,
        filter: {
          logic: "and",
          conditions: [
            { field: "senderConversion", op: "in", values: ["random_number", "sender_id_template"] },
            { field: "appliesTo", op: "like", value: "%customer%" },
          ],
        },
      }),
    );
    for (const r of page.rows) assert.ok(r.senderConversionValue, "the list name stands in for the value");
    // A rule assigned to a live trunk or enterprise cannot be deleted (team trial round 3).
    const { rows: assigned } = await db().query(
      `SELECT tg.translation_rule_id AS id FROM translation_rule_targets tg JOIN translation_rules r ON r.id = tg.translation_rule_id
        WHERE r.deleted_at IS NULL AND tg.target_type = 'trunk' AND tg.trunk_kind = 'customer'
          AND EXISTS (SELECT 1 FROM customer_trunks t WHERE t.id = tg.target_id AND t.deleted_at IS NULL) LIMIT 1`,
    );
    if (assigned[0]) {
      const deps = await ok(
        "getTranslationRuleDependencies",
        call("GET", `/translation-rules/${assigned[0].id}/dependencies`),
      );
      assert.ok(deps.blocked);
      const refused = await call("POST", `/translation-rules/${assigned[0].id}/archive`, {
        override: true,
        reason: "x",
      });
      assert.equal(refused.statusCode, 409);
    }
    const { rows: free } = await db().query(
      `SELECT r.id FROM translation_rules r WHERE r.deleted_at IS NULL AND NOT EXISTS (
         SELECT 1 FROM translation_rule_targets tg WHERE tg.translation_rule_id = r.id AND tg.target_type IN ('trunk', 'enterprise'))
        LIMIT 1`,
    );
    const id = free[0]?.id ?? page.rows[0]?.id ?? 1;
    const gone = await ok("archiveTranslationRule", call("POST", `/translation-rules/${id}/archive`, {}));
    assert.ok(gone.record.archivedAt);
    const back = await ok("restoreTranslationRule", call("POST", `/translation-rules/${id}/restore`));
    assert.equal(back.record.archivedAt, null);
    await undo(back.change);
    await undo(gone.change);
  });
});

test("content words: replace or remove words as typed (team trial round 1)", async () => {
  const { replaceWords } = await import("../src/routing/translate.js");
  assert.equal(
    replaceWords("Your code is 1234. Call now!", [{ find: "now", replace: "" }]),
    "Your code is 1234. Call!",
  );
  assert.equal(replaceWords("Bitcoin bit BIT", [{ find: "bit", replace: "piece" }]), "Bitcoin piece BIT");
  assert.equal(
    replaceWords("Bitcoin bit BIT", [{ find: "bit", replace: "piece", matchCase: false }]),
    "Bitcoin piece piece",
  );
  assert.equal(
    replaceWords("Bitcoin bit", [{ find: "bit", replace: "x", wholeWord: false, matchCase: false }]),
    "xcoin x",
  );
  assert.equal(replaceWords("Bit bit", [{ find: "bit", replace: "x", matchCase: true }]), "Bit x");
  assert.equal(
    replaceWords("Visit www.a.com (a.com)", [{ find: "a.com", replace: "b.org" }]),
    "Visit www.b.org (b.org)",
  );
  assert.equal(replaceWords("رمزك 1234 الآن", [{ find: "الآن", replace: "" }]), "رمزك 1234");
});
