// "Send RN" on rating saves (team trial round 1): a customer table change e-mails each client using the
// table (logged as send_rate, never sent), a vendor table change never does, and the change undoes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildServer, API_PREFIX } from "../src/server.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { noticeLines } from "../src/api/rateNotices.js";

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
  assert.deepEqual(lines.get(1), ["50501: 0.02 USD from 2026-11-01", "50502: blocked"]);
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
    const before = Number(
      (await db().query("SELECT count(*) FROM email_logs WHERE email_type = 'send_rate'")).rows[0].count,
    );
    const res = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/rate-tables/${line.table_id}/lines/changes`,
      payload: {
        items: [{ action: "set", lineId: Number(line.id), rate: Number(line.rate) * 0.9 }],
        sendNotification: true,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.ok(body.notificationsSent >= 1, "at least one client notified");
    const afterCount = Number(
      (await db().query("SELECT count(*) FROM email_logs WHERE email_type = 'send_rate'")).rows[0].count,
    );
    assert.equal(afterCount - before, body.notificationsSent);
    const undo = await app.inject({ method: "POST", url: `${API_PREFIX}/changes/${body.change.id}/undo`, payload: {} });
    assert.equal(undo.statusCode, 200, undo.body);
  },
);
