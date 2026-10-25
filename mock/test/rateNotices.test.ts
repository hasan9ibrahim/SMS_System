// "Send RN" on rating saves (team trial round 1): a customer table change e-mails each client using the
// table (logged as send_rate, never sent), a vendor table change never does, and the change undoes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildServer, API_PREFIX } from "../src/server.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { noticeLines, noticeText } from "../src/api/rateNotices.js";
import { platformDateTime } from "../src/platform.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
after(async () => {
  await app.close();
  await closeDb();
});

test("notice lines: new rates, blocks and closes, without the closed old version", () => {
  const base = { tableId: 1, mccmnc: "50501", senderId: null, currency: "USD", blocked: false };
  const lines = noticeLines([
    {
      entity_id: 1,
      field: "line",
      before: { ...base, rate: 0.01, from: "2026-01-01T00:00:00Z", to: null },
      after: { ...base, rate: 0.01, from: "2026-01-01T00:00:00Z", to: "2026-11-01T00:00:00Z" },
    },
    {
      entity_id: 2,
      field: "line",
      before: null,
      after: { ...base, rate: 0.02, from: "2026-11-01T00:00:00Z", to: null },
    },
    {
      entity_id: 3,
      field: "line",
      before: { ...base, mccmnc: "50502", rate: 0.03, from: "2026-01-01T00:00:00Z", to: null },
      after: { ...base, mccmnc: "50502", rate: 0.03, from: "2026-01-01T00:00:00Z", to: null, blocked: true },
    },
  ]);
  // Dates in the platform time zone, 24-hour (team trial round 2).
  const from = platformDateTime("2026-11-01T00:00:00Z");
  assert.deepEqual(
    lines.get(1)?.map((l) => noticeText(l, null)),
    [`50501: 0.02 USD from ${from}`, "50502: blocked"],
  );
  // The client's "all networks" code for a country rate.
  assert.equal(noticeText({ mccmnc: "505", senderId: null, text: "blocked" }, "mcc00"), "50500: blocked");
  assert.equal(noticeText({ mccmnc: "505", senderId: null, text: "blocked" }, "mccStar"), "505*: blocked");
});

test(
  "a customer table save with sendNotification logs one e-mail per client; undo restores the rate",
  { skip: ready ? false : "seeded database not available" },
  async () => {
    const { rows } = await db().query(
      `SELECT l.id, l.rate, rt.id AS table_id FROM rate_lines l
       JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'customer' AND rt.deleted_at IS NULL
      WHERE l.valid_to IS NULL AND l.valid_from <= now() AND l.sender_id IS NULL AND NOT l.is_blocked
        AND EXISTS (SELECT 1 FROM customer_trunk_rate_tables ctr JOIN customer_trunks ct ON ct.id = ctr.customer_trunk_id
                     WHERE ctr.rate_table_id = rt.id AND ct.deleted_at IS NULL AND ct.status = 'active')
      ORDER BY rt.id, l.id LIMIT 1`,
    );
    const line = rows[0];
    // Only this save's e-mails: other test files log rate e-mails at the same time.
    const note = `Trial note: new prices from Monday (${Date.now()}).`;
    const mark = Number((await db().query("SELECT coalesce(max(id), 0) AS m FROM email_logs")).rows[0].m);
    const res = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/rate-tables/${line.table_id}/lines/changes`,
      payload: {
        items: [{ action: "set", lineId: Number(line.id), rate: Number(line.rate) * 0.9 }],
        sendNotification: true,
        notificationNote: note,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.ok(body.notificationsSent >= 1, "at least one client notified");
    const { rows: mail } = await db().query(
      "SELECT body FROM email_logs WHERE email_type = 'send_rate' AND id > $1 AND position($2 IN body) > 0",
      [mark, note],
    );
    assert.equal(mail.length, body.notificationsSent);
    // The readable change log shows the save as a decrease of that destination (team trial round 2).
    const log = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/rate-tables/${line.table_id}/change-log?limit=1`,
    });
    assert.equal(log.statusCode, 200, log.body);
    const entry = log.json().rows[0];
    assert.equal(entry.changeId, body.change.id);
    assert.equal(entry.items[0].kind, "decrease");
    assert.ok(Math.abs(entry.items[0].changePct + 10) < 0.01);
    const undo = await app.inject({ method: "POST", url: `${API_PREFIX}/changes/${body.change.id}/undo`, payload: {} });
    assert.equal(undo.statusCode, 200, undo.body);
  },
);
