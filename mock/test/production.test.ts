// The production service (backend step 11): the live feed's counting, bind status from session events, credit alert
// e-mails, the e-mail job (outbox, retries, attachments), exchange-rate sources, Auto Invoicing cycles, the IMAP
// intake's sheets and the start-up checks. Parts that need the database run against the seeded one; their rows are
// removed afterwards.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { closeDb, db, dbReady } from "../src/db.js";
import { countEvent, type Pending } from "../src/live/feed.js";
import { applySessionEvent } from "../src/jobs/binds.js";
import { sendCreditAlert } from "../src/jobs/creditAlerts.js";
import { deliver, platformMailbox, transportOptions } from "../src/jobs/mailer.js";
import { parseQuotes, perEur, sourceRequest, type FxSource } from "../src/api/fxFetch.js";
import { endedCycle } from "../src/jobs/autoInvoices.js";
import { sheetsOf } from "../src/jobs/imap.js";
import { productionProblems } from "../src/mode.js";
import { edrNowSql } from "../src/edr.js";

const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const cleanup: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => undefined);
  await closeDb();
});

test("the live feed counts messages, vendor attempts, acceptance, deliveries and money", () => {
  const p: Pending = { customer: new Map(), vendor: new Map(), dest: new Map(), sent: 0 };
  const base = { business_company_id: 999_999, c_trunk_id: 5, c_mccmnc: "20601" };
  // First attempt refused by vendor 7, retried on vendor 8 and accepted; then delivered.
  countEvent("edr.attempt", { ...base, v_trunk_id: 7, attempt_no: 1, is_submit_success: 0, is_final_attempt: 0 }, p);
  countEvent(
    "edr.attempt",
    { ...base, v_trunk_id: 8, attempt_no: 2, is_submit_success: 1, is_final_attempt: 1, revenue_sys: "0.02", cost_sys: "0.01" },
    p,
  );
  countEvent("edr.receipt", { ...base, v_trunk_id: 8, kind: "vendor", msg_status: "DELIVRD" }, p);
  countEvent("edr.receipt", { ...base, v_trunk_id: 8, kind: "outcome", msg_status: "DELIVRD", delivery_delay_ms: 4000 }, p);
  const c = p.customer.get(5)!;
  assert.equal(c.n, 1, "one message (the retry is not a new one)");
  assert.equal(c.ok, 1);
  assert.equal(c.dl, 1, "the outcome row counts the delivery once, the raw receipt not");
  assert.equal(c.delay, 4);
  assert.ok(Math.abs(c.revenue - 0.02) < 1e-9 && Math.abs(c.cost - 0.01) < 1e-9);
  assert.equal(p.sent, 2);
  assert.equal(p.vendor.get(7)!.n, 1);
  assert.equal(p.vendor.get(7)!.ok, 0);
  assert.equal(p.vendor.get(8)!.dl, 1);
  assert.equal(p.dest.get("20601")!.n, 1);
});

test("exchange-rate sources: requests and answers turned into units per EUR", () => {
  const src = (x: Partial<FxSource>): FxSource => ({
    provider: "fixer",
    apiUrl: "https://data.fixer.io/api/latest",
    authType: "query",
    authParam: "access_key",
    accountId: null,
    ratesPath: "rates",
    baseCurrency: "EUR",
    apiKey: "k1",
    ...x,
  });
  assert.equal(sourceRequest(src({})).url, "https://data.fixer.io/api/latest?access_key=k1");
  const path = sourceRequest(src({ apiUrl: "https://v6.example/v6/{key}/latest/{base}", authType: "path" }));
  assert.equal(path.url, "https://v6.example/v6/k1/latest/EUR");
  const basic = sourceRequest(src({ authType: "basic", accountId: "acc" }));
  assert.equal(basic.headers.authorization, `Basic ${Buffer.from("acc:k1").toString("base64")}`);
  assert.throws(() => sourceRequest(src({ apiKey: null })), /API key/);
  // ECB XML against EUR.
  const ecb = parseQuotes(src({ provider: "ecb" }), `<Cube currency="USD" rate="1.0800"/><Cube currency='GBP' rate='0.86'/>`);
  assert.equal(ecb.get("USD"), 1.08);
  // A USD-based source: converted to per EUR.
  const usd = perEur("USD", parseQuotes(src({}), JSON.stringify({ rates: { EUR: 0.9, GBP: 0.8 } })));
  assert.equal(usd.get("EUR"), 1);
  assert.equal(usd.get("USD"), Number((1 / 0.9).toFixed(8)));
  assert.equal(usd.get("GBP"), Number((0.8 / 0.9).toFixed(8)));
  // XE: a list of quotes.
  const xe = parseQuotes(src({ provider: "xe", ratesPath: "to" }), JSON.stringify({ to: [{ quotecurrency: "USD", mid: 1.1 }] }));
  assert.equal(xe.get("USD"), 1.1);
  assert.throws(() => parseQuotes(src({}), "{}"), /No rates found/);
});

test("Auto Invoicing: the cycle that ended, on the cycle's first day only", () => {
  const c = (billingType: "daily" | "weekly" | "fortnightly" | "monthly" | "custom", weekDay: string | null = null, usageDays = 7) =>
    ({ billingType, weekDay, usageDays });
  assert.deepEqual(endedCycle(c("daily"), "2026-11-03"), { from: "2026-11-02", to: "2026-11-02" });
  assert.deepEqual(endedCycle(c("monthly"), "2026-11-01"), { from: "2026-10-01", to: "2026-10-31" });
  assert.equal(endedCycle(c("monthly"), "2026-11-02"), null);
  // 2026-11-02 is a Monday.
  assert.deepEqual(endedCycle(c("weekly", "MON"), "2026-11-02"), { from: "2026-10-26", to: "2026-11-01" });
  assert.equal(endedCycle(c("weekly", "MON"), "2026-11-03"), null);
  const fortnight = [endedCycle(c("fortnightly", "MON"), "2026-11-02"), endedCycle(c("fortnightly", "MON"), "2026-11-09")];
  assert.equal(fortnight.filter(Boolean).length, 1, "every other week");
  assert.deepEqual(endedCycle(c("custom", null, 10), "2026-01-11"), { from: "2026-01-01", to: "2026-01-10" });
});

test("the IMAP intake takes rate sheets only; Excel as base64", () => {
  const sheets = sheetsOf([
    { filename: "rates.xlsx", content: Buffer.from([1, 2, 3]) },
    { filename: "rates.csv", content: Buffer.from("MCCMNC,Rate\n20601,0.01") },
    { filename: "logo.png", content: Buffer.from([1]) },
    { filename: "empty.csv", content: Buffer.alloc(0) },
  ]);
  assert.deepEqual(
    sheets.map((s) => [s.fileName, s.encoding]),
    [
      ["rates.xlsx", "base64"],
      ["rates.csv", "text"],
    ],
  );
  assert.equal(sheets[0]!.content, Buffer.from([1, 2, 3]).toString("base64"));
});

test("production refuses to start without its secrets; the platform mailbox from SMTP_URL", () => {
  const ok = {
    MOCK_PROXY_SECRET: "s",
    MOCK_SECRET_KEY: "real-key",
    NATS_URL: "nats://n:4222",
    PUBLIC_URL: "https://sms.example",
  };
  assert.deepEqual(productionProblems(ok), []);
  assert.equal(productionProblems({ ...ok, MOCK_SECRET_KEY: "dev-only-not-a-real-key" }).length, 1);
  assert.equal(productionProblems({ ...ok, MOCK_USER_ID: "1" }).length, 1);
  assert.equal(productionProblems({}).length, 4);
  const m = platformMailbox({ SMTP_URL: "smtps://user%40x.example:p%40ss@mail.example", SMTP_FROM: "noreply@x.example" })!;
  assert.deepEqual([m.host, m.port, m.secure, m.username, m.password, m.email], [
    "mail.example",
    465,
    "ssl",
    "user@x.example",
    "p@ss",
    "noreply@x.example",
  ]);
  assert.equal(transportOptions({ ...m, secure: "starttls", port: 587 }).requireTLS, true);
  assert.equal(platformMailbox({}), null);
  // Outside production the EDR windows end at the fake data's latest EDR.
  assert.match(edrNowSql(), /max\(submit_time\)/);
});

describe("with the database (backend step 11)", { skip }, () => {
  test("session events keep the bind status; a stopped trunk stays stopped", async () => {
    const pool = db();
    const { rows } = await pool.query("SELECT id FROM vendor_trunks WHERE deleted_at IS NULL ORDER BY id LIMIT 1");
    const trunk = Number(rows[0].id);
    const before = await pool.query("SELECT * FROM trunk_binds WHERE side = 'vendor' AND trunk_id = $1", [trunk]);
    const sessions = await pool.query("SELECT * FROM bind_sessions WHERE side = 'vendor' AND trunk_id = $1", [trunk]);
    await pool.query("DELETE FROM bind_sessions WHERE side = 'vendor' AND trunk_id = $1", [trunk]);
    cleanup.push(async () => {
      await pool.query("DELETE FROM bind_sessions WHERE side = 'vendor' AND trunk_id = $1", [trunk]);
      for (const s of sessions.rows)
        await pool.query(
          `INSERT INTO bind_sessions (session_id, side, trunk_id, ip, port, bind_type, since, submitted, receipts_pending)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [s.session_id, s.side, s.trunk_id, s.ip, s.port, s.bind_type, s.since, s.submitted, s.receipts_pending],
        );
      const b = before.rows[0];
      if (b)
        await pool.query(
          "UPDATE trunk_binds SET status = $3, connections = $4, since = $5, changed_by_id = $6 WHERE side = $1 AND trunk_id = $2",
          ["vendor", trunk, b.status, b.connections, b.since, b.changed_by_id],
        );
    });
    await pool.query("UPDATE trunk_binds SET status = 'offline' WHERE side = 'vendor' AND trunk_id = $1", [trunk]);
    const ev = (id: string) => ({ session_id: id, trunk_id: trunk, host: "smpp.example", port: 2775, bind: "TR" });
    await applySessionEvent(pool, "session.vendor.bound", ev("t-a"));
    await applySessionEvent(pool, "session.vendor.bound", ev("t-b"));
    let b = (await pool.query("SELECT * FROM trunk_binds WHERE side = 'vendor' AND trunk_id = $1", [trunk])).rows[0];
    assert.deepEqual([b.status, b.connections], ["online", 2]);
    await applySessionEvent(pool, "session.vendor.closed", ev("t-a"));
    await applySessionEvent(pool, "session.vendor.closed", ev("t-b"));
    b = (await pool.query("SELECT * FROM trunk_binds WHERE side = 'vendor' AND trunk_id = $1", [trunk])).rows[0];
    assert.deepEqual([b.status, b.connections], ["offline", 0]);
    await pool.query("UPDATE trunk_binds SET status = 'stopped' WHERE side = 'vendor' AND trunk_id = $1", [trunk]);
    await applySessionEvent(pool, "session.vendor.bound", ev("t-c"));
    b = (await pool.query("SELECT * FROM trunk_binds WHERE side = 'vendor' AND trunk_id = $1", [trunk])).rows[0];
    assert.deepEqual([b.status, b.connections], ["stopped", 1]);
  });

  test("credit alerts: the customer's finance contacts; a vendor's to our own billing mailbox", async () => {
    const pool = db();
    const { rows } = await pool.query(
      `SELECT e.id FROM enterprises e WHERE e.deleted_at IS NULL AND e.credit_alert
          AND EXISTS (SELECT 1 FROM enterprise_contacts c WHERE c.enterprise_id = e.id AND c.contact_type = 'finance')
        ORDER BY e.id LIMIT 1`,
    );
    if (!rows[0]) return;
    const id = Number(rows[0].id);
    const mark = (await pool.query("SELECT coalesce(max(id), 0) AS m FROM email_logs")).rows[0].m;
    cleanup.push(() => pool.query("DELETE FROM email_logs WHERE id > $1 AND enterprise_id = $2", [mark, id]));
    assert.equal(
      await sendCreditAlert(pool, { enterprise_id: id, side: "customer", level: "warning", balance: "-700", credit_limit: "1000", currency: "EUR" }),
      "sent",
    );
    await sendCreditAlert(pool, { enterprise_id: id, side: "vendor", level: "used_up", balance: "0", credit_limit: "0", currency: "EUR" });
    const logs = (
      await pool.query("SELECT email_type, to_addresses, sender, subject FROM email_logs WHERE id > $1 AND enterprise_id = $2 ORDER BY id", [mark, id])
    ).rows;
    assert.deepEqual(
      logs.map((l) => l.email_type),
      ["credit_alert", "balance_alert"],
    );
    assert.ok(logs[0].to_addresses.length > 0);
    // The vendor alert never goes to the vendor's own contacts.
    const contacts = (await pool.query("SELECT unnest(emails) AS e FROM enterprise_contacts WHERE enterprise_id = $1", [id])).rows.map((r) => r.e);
    for (const a of logs[1].to_addresses as string[]) assert.ok(!contacts.includes(a), a);
  });

  test("the e-mail job sends a queued e-mail with its attachments, retries a 4xx and fails a 5xx", async () => {
    const pool = db();
    const { rows: mb } = await pool.query("SELECT smtp_email FROM business_company_mailboxes ORDER BY id LIMIT 1");
    const sender = String(mb[0].smtp_email);
    const queue = async () => {
      const { rows } = await pool.query(
        `INSERT INTO email_logs (email_type, status, to_addresses, subject, body, body_html, sender, next_try_at)
         VALUES ('template_test', 'queued', ARRAY['a@example.test'], 'Test', 'plain', '<p>hi</p>', $1, now()) RETURNING *`,
        [sender],
      );
      cleanup.push(() => pool.query("DELETE FROM email_logs WHERE id = $1", [rows[0].id]));
      await pool.query("INSERT INTO email_attachments (email_log_id, file_name, content_type, content) VALUES ($1, 'a.csv', 'text/csv', $2)", [
        rows[0].id,
        Buffer.from("x,y"),
      ]);
      return rows[0];
    };
    const row = await queue();
    let sentMessage: { attachments?: unknown[]; from?: unknown } | null = null;
    assert.equal(
      await deliver(pool, row, async (_m, message) => {
        sentMessage = message;
        return { messageId: "<1@test>" };
      }),
      "sent",
    );
    assert.equal(sentMessage!.attachments!.length, 1);
    const sent = (await pool.query("SELECT status, message_id, tries FROM email_logs WHERE id = $1", [row.id])).rows[0];
    assert.deepEqual([sent.status, sent.message_id, sent.tries], ["sent", "<1@test>", 1]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM email_attachments WHERE email_log_id = $1", [row.id])).rows[0].n, 0);

    const busy = await queue();
    const err = (code: number) => Object.assign(new Error(`${code} try later`), { responseCode: code, response: `${code} try later` });
    assert.equal(await deliver(pool, busy, async () => Promise.reject(err(451))), "queued");
    const retried = (await pool.query("SELECT status, tries, next_try_at > now() AS later, error FROM email_logs WHERE id = $1", [busy.id])).rows[0];
    assert.deepEqual([retried.status, retried.tries, retried.later], ["queued", 1, true]);
    assert.match(retried.error, /451/);

    const refused = await queue();
    assert.equal(await deliver(pool, refused, async () => Promise.reject(err(550))), "failed");
    assert.equal((await pool.query("SELECT status FROM email_logs WHERE id = $1", [refused.id])).rows[0].status, "failed");

    // No mailbox sends as this address and no platform mailbox: failed with the reason.
    const orphan = { ...(await queue()), sender: "nobody@unknown.example" };
    const saved = process.env.SMTP_URL;
    delete process.env.SMTP_URL;
    assert.equal(await deliver(pool, orphan, async () => ({})), "failed");
    if (saved) process.env.SMTP_URL = saved;
  });

  test("the platform's own plain-text e-mails go out with the Xpert logo; company e-mails keep theirs (round 11)", async () => {
    const pool = db();
    const saved = process.env.SMTP_URL;
    process.env.SMTP_URL = "smtp://platform%40example.test:pw@127.0.0.1:2525";
    try {
      const { rows } = await pool.query(
        `INSERT INTO email_logs (email_type, status, to_addresses, subject, body, sender, next_try_at)
         VALUES ('otp', 'queued', ARRAY['a@example.test'], 'Your sign-in code', $1, NULL, now()) RETURNING *`,
        ["Hello Testa,\n\nYour sign-in code is 123456.\n\nOpen https://xpert.example.test to sign in."],
      );
      cleanup.push(() => pool.query("DELETE FROM email_logs WHERE id = $1", [rows[0].id]));
      let message: { html?: unknown; text?: unknown; attachments?: { cid?: string; contentType?: string }[] } = {};
      assert.equal(
        await deliver(pool, rows[0], async (_m, m) => {
          message = m as typeof message;
          return { messageId: "<2@test>" };
        }),
        "sent",
      );
      assert.match(String(message.text), /123456/);
      assert.match(String(message.html), /cid:xpert-logo@xpert/);
      assert.match(String(message.html), /123456/);
      assert.match(String(message.html), /<a href="https:\/\/xpert\.example\.test"/);
      assert.ok(message.attachments!.some((a) => a.cid === "xpert-logo@xpert" && a.contentType === "image/png"));
    } finally {
      if (saved) process.env.SMTP_URL = saved;
      else delete process.env.SMTP_URL;
    }
  });
});
