// Incoming vendor rate notifications (build step 5.14, §13.13 A, §13.32): sheet reading, trunk
// matching, intake (failed, unmatched, split by username), the check (changes, notice, back-dated),
// accept by line (no back-dating, one undoable change), reject with reason, replies, auto-accept and
// settings. Every response is checked against the contract. Needs the seeded database.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { bestBuySettled } from "../src/api/bestbuy.js";
import { fieldOf, matchTrunk, parseDate, readSheet, splitRows } from "../src/rn/parse.js";
import { workbookOf } from "./xlsxFixture.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";

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

describe("reading vendor sheets (§13.13 A)", () => {
  test("delimiters, headers, dates, closed lines and errors", () => {
    assert.deepEqual(splitRows('a;b;"c;d"\n1;2;3'), [
      ["a", "b", "c;d"],
      ["1", "2", "3"],
    ]);
    assert.deepEqual(splitRows("a\tb\n1\t2")[1], ["1", "2"]);
    assert.equal(fieldOf("MCC-MNC"), "mccmnc");
    assert.equal(fieldOf("Rate (EUR)"), "rate");
    assert.equal(fieldOf("Old rate"), null);
    assert.equal(fieldOf("Operator"), "network");
    assert.equal(fieldOf("Preis", { preis: "rate" }), "rate", "remembered mapping wins");
    assert.equal(parseDate("20/10/2026"), "2026-10-20T00:00:00.000Z");
    assert.equal(parseDate("2026-10-20 08:30"), "2026-10-20T08:30:00.000Z");
    assert.equal(parseDate("5-Nov-2026"), "2026-11-05T00:00:00.000Z");
    assert.equal(parseDate("31/02/2026"), null);
    const s = readSheet(
      [
        "Price list October",
        "",
        "MCC,MNC,Operator,Rate,Effective date,Remarks",
        "262,01,Net A,0.051,20/10/2026,",
        "262,02,Net B,,20/10/2026,Closed",
        "262,03,Net C,abc,20/10/2026,",
        "262,07,Net D,0.04,99/99/2026,",
      ].join("\n"),
    );
    assert.equal(s.fatal, false);
    assert.equal(s.rows.length, 2);
    assert.deepEqual(
      s.rows.map((r) => [r.mccmnc, r.rate, r.closed]),
      [
        ["26201", 0.051, false],
        ["26202", null, true],
      ],
    );
    assert.deepEqual(
      s.errors.map((e) => e.line),
      [6, 7],
    );
    assert.equal(readSheet("Country,Network\nDE,x").fatal, true);
  });
  test("trunk matching: username, name, sender's only trunk", () => {
    const trunks = [
      { id: 1, name: "ALPHA_OTP", username: "wiialpha", enterpriseId: 10 },
      { id: 2, name: "ALPHA_PROMO", username: "wiialpha2", enterpriseId: 10 },
      { id: 3, name: "BETA_OTP", username: "wiibeta", enterpriseId: 20 },
    ];
    assert.equal(matchTrunk(trunks, { subject: "Rate update – account wiialpha2" }, [])?.trunk.id, 2);
    assert.equal(matchTrunk(trunks, { fileName: "beta_otp_rates.csv" }, [])?.trunk.id, undefined);
    assert.equal(matchTrunk(trunks, { body: "for BETA_OTP" }, [])?.trunk.id, 3);
    assert.equal(
      matchTrunk(trunks, { subject: "New rates" }, [20])?.reason,
      "the only live trunk of the sender's enterprise",
    );
    assert.equal(matchTrunk(trunks, { subject: "New rates" }, [10]), null, "two trunks: not guessed");
  });
});

interface Trunk {
  id: number;
  username: string;
  enterpriseId: number;
  tableId: number;
  codes: { mccmnc: string; rate: number }[];
}
let picked: Promise<Trunk> | null = null;
/** A live vendor trunk with a rate table of at least eight current generic lines. */
const trunk = () =>
  (picked ??= (async () => {
    const { rows } = await db().query(
      `SELECT vt.id, vt.username, vt.enterprise_id, rt.id AS table_id FROM vendor_trunks vt
         JOIN rate_tables rt ON rt.vendor_trunk_id = vt.id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
        WHERE vt.deleted_at IS NULL AND length(vt.username) >= 6
          AND (SELECT count(*) FROM rate_lines l WHERE l.rate_table_id = rt.id AND l.sender_id IS NULL
                AND l.valid_from <= now() AND l.valid_to IS NULL) >= 8
        ORDER BY vt.id DESC LIMIT 1`,
    );
    const r = rows[0];
    const { rows: ls } = await db().query(
      `SELECT mccmnc, rate FROM rate_lines WHERE rate_table_id = $1 AND sender_id IS NULL AND valid_from <= now()
          AND valid_to IS NULL AND length(mccmnc) >= 5 ORDER BY mccmnc LIMIT 8`,
      [r.table_id],
    );
    return {
      id: r.id,
      username: r.username,
      enterpriseId: r.enterprise_id,
      tableId: r.table_id,
      codes: ls.map((l) => ({ mccmnc: l.mccmnc, rate: Number(l.rate) })),
    };
  })());

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const lines = (rnId: number, extra: object[] = []) =>
  ok(
    "queryRateNotificationLines",
    call("POST", "/rate-notification-lines/query", {
      filter: { logic: "and", conditions: [{ field: "rnId", op: "eq", value: rnId }, ...extra] },
      limit: 100,
    }),
  );

const saved: { notice?: number; settings?: unknown } = {};
after(async () => {
  if (ready) {
    const t = await trunk();
    if (saved.settings !== undefined) await call("PUT", `/enterprises/${t.enterpriseId}/rn-settings`, saved.settings);
  }
  await bestBuySettled();
  await app.close();
  await closeDb();
});

describe("incoming RNs (§13.32)", { skip }, () => {
  test("settings: global and per vendor", async () => {
    const t = await trunk();
    const g = await ok("getRnSettings", call("GET", "/rate-notifications/settings"));
    assert.ok(["1h", "24h", "7d"].includes(g.liveWindow));
    const back = await ok("updateRnSettings", call("PUT", "/rate-notifications/settings", { ...g, reminderDays: 3 }));
    assert.equal(back.reminderDays, 3);
    await ok("updateRnSettings", call("PUT", "/rate-notifications/settings", g));
    const v = await ok("getVendorRnSettings", call("GET", `/enterprises/${t.enterpriseId}/rn-settings`));
    saved.settings = v;
    const set = await ok(
      "updateVendorRnSettings",
      call("PUT", `/enterprises/${t.enterpriseId}/rn-settings`, {
        ...v,
        autoAccept: false,
        noticeDays: 7,
        replyModes: { successful: "confirm", failed: "auto", rejected: "confirm" },
      }),
    );
    assert.equal(set.noticeDays, 7);
    assert.equal(set.replyModes.successful, "confirm");
  });

  test("intake: trunk by username, changes, notice and back-dated lines", async () => {
    const t = await trunk();
    const [a, b, c, d, e] = t.codes;
    const csv = [
      "MCCMNC;Network;Rate;Effective Date;Remarks",
      `${a!.mccmnc};x;${(a!.rate * 1.1).toFixed(6)};${day(2)};`, // increase, inside 7 days' notice
      `${b!.mccmnc};x;${(b!.rate * 0.9).toFixed(6)};${day(10)};`, // decrease
      `${c!.mccmnc};x;${(c!.rate * 1.2).toFixed(6)};${day(-4)};`, // back-dated increase
      `${d!.mccmnc};x;;${day(10)};Closed`,
      `${e!.mccmnc};x;${e!.rate};${day(10)};`, // unchanged
      `99999;x;0.01;${day(10)};`, // unknown destination
    ].join("\n");
    const res = await ok(
      "intakeRateNotification",
      call("POST", "/rate-notifications/intake", {
        source: "email",
        fromAddress: "Rates Desk <rates@vendor.example>",
        subject: `Rate update – account ${t.username}`,
        attachments: [{ fileName: "rates.csv", content: csv }],
      }),
      201,
    );
    assert.equal(res.created.length, 1);
    const rn = res.created[0];
    assert.equal(rn.vendorTrunkId, t.id);
    assert.equal(rn.status, "pending");
    assert.deepEqual([rn.lines, rn.increases, rn.decreases, rn.closed, rn.unchanged, rn.errors], [5, 2, 1, 1, 1, 1]);
    assert.equal(rn.noticeBreaches, 2, "both increases start sooner than 7 days");
    assert.equal(rn.backdated, 1);
    const detail = await ok("getRateNotification", call("GET", `/rate-notifications/${rn.id}`));
    assert.match(detail.matchReason, /username/);
    assert.equal(detail.fileErrors[0].line, 7);
    const ls = await lines(rn.id);
    const backLine = ls.rows.find((l: { mccmnc: string }) => l.mccmnc === c!.mccmnc);
    assert.equal(backLine.backdated, true);
    // Counts as affecting live traffic only with messages sent since the stated date (team trial round 2).
    assert.equal(rn.backdatedLive, backLine.sentBetween >= 1 ? 1 : 0);
    assert.ok(Date.parse(backLine.appliedFrom) >= Date.parse(rn.receivedAt) - 1000, "never before receipt");
    const bad = await call("POST", "/rate-notification-lines/query", { limit: 5 });
    assert.equal(bad.statusCode, 400);

    // The back-dated line affected traffic already sent (set here so the test does not depend on the seed's traffic).
    await db().query("UPDATE rate_notification_lines SET sent_between = greatest(sent_between, 5) WHERE id = $1", [
      backLine.id,
    ]);
    // Accept two lines: one change, rates loaded from max(stated, now).
    const pick = ls.rows.filter((l: { mccmnc: string }) => [b!.mccmnc, c!.mccmnc].includes(l.mccmnc));
    const acc = await ok(
      "acceptRateNotification",
      call("POST", `/rate-notifications/${rn.id}/accept`, {
        lineIds: pick.map((l: { id: number }) => l.id),
        rerate: true,
      }),
    );
    assert.equal(acc.applied, 2);
    // Re-rating is opt-in: a request for the back-dated period, approved by another user (team trial round 2).
    assert.ok(acc.reratingRequestId);
    const { rows: rr } = await db().query(
      "SELECT side, rate_table_id, mccmncs, request_status FROM rerating_requests WHERE id = $1",
      [acc.reratingRequestId],
    );
    assert.equal(rr[0].side, "vendor");
    assert.equal(Number(rr[0].rate_table_id), t.tableId);
    assert.deepEqual(rr[0].mccmncs, [c!.mccmnc]);
    await db().query("DELETE FROM rerating_requests WHERE id = $1", [acc.reratingRequestId]);
    const { rows: stated } = await db().query(
      `SELECT stated_valid_from FROM rate_lines WHERE rate_table_id = $1 AND mccmnc = $2 AND sender_id IS NULL
          AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
      [t.tableId, c!.mccmnc],
    );
    assert.ok(stated[0].stated_valid_from, "the stated date stays on the line");
    assert.equal(acc.record.status, "pending", "other lines still pending");
    assert.deepEqual(acc.change.entityIds, [t.tableId]);
    const { rows: now } = await db().query(
      `SELECT rate FROM rate_lines WHERE rate_table_id = $1 AND mccmnc = $2 AND sender_id IS NULL
          AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
      [t.tableId, c!.mccmnc],
    );
    assert.equal(Number(now[0].rate), Number((c!.rate * 1.2).toFixed(6)), "back-dated line applies from now");
    const { rows: later } = await db().query(
      `SELECT valid_from FROM rate_lines WHERE rate_table_id = $1 AND mccmnc = $2 AND valid_from > now()`,
      [t.tableId, b!.mccmnc],
    );
    assert.equal(later[0].valid_from.toISOString().slice(0, 10), day(10));

    // Reject the rest: a reason is required; the Rejected reply waits for confirmation.
    const noReason = await call("POST", `/rate-notifications/${rn.id}/reject`, {});
    assert.equal(noReason.statusCode, 400);
    const rej = await ok(
      "rejectRateNotification",
      call("POST", `/rate-notifications/${rn.id}/reject`, { reason: "Short notice" }),
    );
    assert.equal(rej.record.status, "partly_accepted");
    const draft = rej.record.replies.find((r: { kind: string }) => r.kind === "rejected");
    assert.equal(draft.status, "draft");
    assert.deepEqual(draft.to, ["rates@vendor.example"]);
    assert.match(draft.body, /Short notice/);
    const sent = await ok(
      "sendRnReply",
      call("POST", `/rate-notifications/${rn.id}/replies/${draft.id}/send`, { subject: "Rates partly rejected" }),
    );
    assert.equal(sent.replies.find((r: { id: number }) => r.id === draft.id).status, "sent");
    assert.equal((await call("POST", `/rate-notifications/${rn.id}/replies/${draft.id}/send`, {})).statusCode, 409);
    assert.equal((await call("POST", `/rate-notifications/${rn.id}/accept`, {})).statusCode, 409, "nothing left");
    // The accepted lines undo as one change.
    await ok("undoChange", call("POST", `/changes/${acc.change.id}/undo`, {}));
    const { rows: undone } = await db().query(
      `SELECT rate FROM rate_lines WHERE rate_table_id = $1 AND mccmnc = $2 AND sender_id IS NULL
          AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
      [t.tableId, c!.mccmnc],
    );
    assert.equal(Number(undone[0].rate), c!.rate);
  });

  test("failed and unmatched files; split by username; assign", async () => {
    const t = await trunk();
    const failed = await ok(
      "intakeRateNotification",
      call("POST", "/rate-notifications/intake", {
        source: "email",
        fromAddress: "rates@vendor.example",
        subject: `Rates ${t.username}`,
        attachments: [{ fileName: "broken.csv", content: "Country,Network\nDE,x" }],
      }),
      201,
    );
    assert.equal(failed.failed, 1);
    const fd = await ok("getRateNotification", call("GET", `/rate-notifications/${failed.created[0].id}`));
    assert.equal(fd.replies[0].kind, "failed");
    assert.equal(fd.replies[0].status, "sent");

    const [a, b] = t.codes;
    const split = await ok(
      "intakeRateNotification",
      call("POST", "/rate-notifications/intake", {
        source: "upload",
        attachments: [
          {
            fileName: "multi.csv",
            content: `Username,MCCMNC,Rate,Effective date\n${t.username},${a!.mccmnc},${a!.rate},${day(9)}\nnobody-here,${b!.mccmnc},0.01,${day(9)}`,
          },
        ],
      }),
      201,
    );
    assert.equal(split.created.length, 2);
    assert.equal(split.unmatched, 1);
    const lost = split.created.find((r: { status: string }) => r.status === "unmatched");
    const assigned = await ok(
      "assignRateNotification",
      call("POST", `/rate-notifications/${lost.id}/assign`, { vendorTrunkId: t.id }),
    );
    assert.equal(assigned.status, "pending");
    assert.equal(assigned.vendorTrunkId, t.id);
    await ok("rejectRateNotification", call("POST", `/rate-notifications/${lost.id}/reject`, { reason: "test" }));
    const other = split.created.find((r: { status: string }) => r.status === "pending");
    await ok("rejectRateNotification", call("POST", `/rate-notifications/${other.id}/reject`, { reason: "test" }));
  });

  test("auto-accept: no flagged line, vendor setting on", async () => {
    const t = await trunk();
    const v = await ok("getVendorRnSettings", call("GET", `/enterprises/${t.enterpriseId}/rn-settings`));
    await ok(
      "updateVendorRnSettings",
      call("PUT", `/enterprises/${t.enterpriseId}/rn-settings`, {
        ...v,
        autoAccept: true,
        replyModes: { successful: "auto", failed: "auto", rejected: "confirm" },
      }),
    );
    const f = t.codes[5]!;
    const res = await ok(
      "intakeRateNotification",
      call("POST", "/rate-notifications/intake", {
        source: "upload",
        vendorTrunkId: t.id,
        attachments: [
          {
            fileName: "down.csv",
            content: `MCCMNC,Rate,Effective Date\n${f.mccmnc},${(f.rate * 0.95).toFixed(6)},${day(12)}`,
          },
        ],
      }),
      201,
    );
    assert.equal(res.autoAccepted, 1);
    const rn = await ok("getRateNotification", call("GET", `/rate-notifications/${res.created[0].id}`));
    assert.equal(rn.status, "accepted");
    assert.equal(rn.autoAccepted, true);
    assert.equal(rn.replies[0].kind, "successful");
    assert.equal(rn.replies[0].status, "sent");
    if (rn.changeId) await call("POST", `/changes/${rn.changeId}/undo`, {});
  });

  test("auto-accept: an increase with notice is accepted, a back-dated rate waits (go-live 2026-10-26)", async () => {
    const t = await trunk();
    const [g, h] = [t.codes[6]!, t.codes[7]!];
    const upload = (name: string, row: string) =>
      ok(
        "intakeRateNotification",
        call("POST", "/rate-notifications/intake", {
          source: "upload",
          vendorTrunkId: t.id,
          attachments: [{ fileName: name, content: `MCCMNC,Rate,Effective Date\n${row}` }],
        }),
        201,
      );
    // Notice is 7 days (set above): an increase starting in 12 days needs no one, live traffic or not.
    const up = await upload("up.csv", `${g.mccmnc},${(g.rate * 1.2).toFixed(6)},${day(12)}`);
    assert.equal(up.autoAccepted, 1);
    const upRn = await ok("getRateNotification", call("GET", `/rate-notifications/${up.created[0].id}`));
    assert.equal(upRn.status, "accepted");
    if (upRn.changeId) await call("POST", `/changes/${upRn.changeId}/undo`, {});
    // A back-dated rate waits for a person.
    const back = await upload("back.csv", `${h.mccmnc},${(h.rate * 0.9).toFixed(6)},${day(-3)}`);
    assert.equal(back.autoAccepted, 0);
    const backRn = await ok("getRateNotification", call("GET", `/rate-notifications/${back.created[0].id}`));
    assert.equal(backRn.status, "pending");
    await ok("rejectRateNotification", call("POST", `/rate-notifications/${backRn.id}/reject`, { reason: "test" }));
  });

  test("Excel upload: protected sheet, given header row, original file kept (team trial round 2)", async () => {
    const t = await trunk();
    const [a] = t.codes;
    const book = workbookOf([
      ["Rates – locked sheet"],
      ["Account", t.username],
      ["MCCMNC", "Network", "Rate"],
      [a!.mccmnc, "x", (a!.rate * 0.95).toFixed(6)],
    ]);
    const res = await ok(
      "intakeRateNotification",
      call("POST", "/rate-notifications/intake", {
        source: "upload",
        vendorTrunkId: t.id,
        attachments: [{ fileName: "rates.xlsx", content: book.toString("base64"), encoding: "base64", headerRow: 3 }],
      }),
      201,
    );
    const rn = res.created[0];
    assert.equal(rn.lines, 1);
    const detail = await ok("getRateNotification", call("GET", `/rate-notifications/${rn.id}`));
    assert.equal(detail.headerRow, 3);
    assert.deepEqual(
      detail.columns.map((c: { field: string | null }) => c.field),
      ["mccmnc", "network", "rate"],
    );
    const file = await call("GET", `/rate-notifications/${rn.id}/file`);
    assert.match(String(file.headers["content-type"]), /spreadsheetml/);
    assert.equal(file.rawPayload.length, book.length);
    await call("POST", `/rate-notifications/${rn.id}/reject`, { reason: "test upload" });

    const locked = await ok(
      "intakeRateNotification",
      call("POST", "/rate-notifications/intake", {
        source: "upload",
        vendorTrunkId: t.id,
        attachments: [
          {
            fileName: "locked.xlsx",
            content: Buffer.from("d0cf11e0a1b11ae1", "hex").toString("base64"),
            encoding: "base64",
          },
        ],
      }),
      201,
    );
    assert.equal(locked.created[0].status, "failed");
    const ld = await ok("getRateNotification", call("GET", `/rate-notifications/${locked.created[0].id}`));
    assert.match(ld.fileErrors[0].message, /password/);
  });

  test("RN list at volume, filters and sort", async () => {
    const page = await ok(
      "queryRateNotifications",
      call("POST", "/rate-notifications/query", {
        filter: { logic: "and", conditions: [{ field: "status", op: "in", values: ["accepted", "pending"] }] },
        sort: [{ field: "flagged", dir: "desc" }],
        limit: 50,
      }),
    );
    assert.ok(page.total > 0);
    assert.ok(page.rows[0].flagged >= (page.rows.at(-1)?.flagged ?? 0));
    const flagged = await lines(page.rows[0].id, [{ field: "flagged", op: "eq", value: true }]);
    assert.ok(flagged.rows.every((l: { flagged: boolean }) => l.flagged));
  });
});
