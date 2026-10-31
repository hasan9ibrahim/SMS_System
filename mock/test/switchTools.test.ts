// Switch utilities (build step 5.8, §8): e-mail logs (including the senders that write them),
// notifications, firewall, traffic alerts, SMS to voice and broadcast, against the seeded database
// and EDR store. Responses are checked against the contract; rows the tests add are removed.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { Change } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { likeMatch, sanitiseHtml, spokenPhrase } from "../src/api/switchTools.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const started = new Date();
const run = Date.now().toString(36).slice(-5);
after(async () => {
  if (ready) {
    await db().query("DELETE FROM email_logs WHERE inserted_at >= $1", [started]);
    await db().query("DELETE FROM broadcasts WHERE inserted_at >= $1", [started]);
    await db().query("DELETE FROM firewall_rules WHERE inserted_at >= $1", [started]);
    await db().query("DELETE FROM firewall_filters WHERE inserted_at >= $1", [started]);
    await db().query("DELETE FROM traffic_alerts WHERE inserted_at >= $1", [started]);
    await db().query("DELETE FROM sms_voice_rules WHERE inserted_at >= $1", [started]);
  }
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
const logsSince = async (type: string) =>
  (await db().query("SELECT * FROM email_logs WHERE inserted_at >= $1 AND email_type = $2", [started, type])).rows;

describe("§8 helpers", () => {
  test("wildcards, spoken codes, safe HTML", () => {
    assert.ok(likeMatch("%otp%", "MyOTPService"));
    assert.ok(likeMatch("BANK_", "BANK1"));
    assert.ok(!likeMatch("BANK_", "BANK12"));
    assert.ok(likeMatch("a.b", "a.b") && !likeMatch("a.b", "axb"), "dots are literal");
    assert.equal(spokenPhrase("4821", 2), "Your verification code is 4, 8, 2, 1. (2 times)");
    const html = sanitiseHtml('<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:evil()">x</a>');
    assert.ok(!/script|onclick|javascript/i.test(html), html);
    assert.ok(html.includes("<p>Hi</p>"));
  });
});

describe("Email logs and the senders that write them (§8)", { skip }, () => {
  test("list, detail, and a payment confirmation is logged", async () => {
    const page = await ok(
      "queryEmailLogs",
      call("POST", "/email-logs/query", {
        limit: 5,
        filter: { logic: "and", conditions: [{ field: "status", op: "in", values: ["failed"] }] },
      }),
    );
    assert.ok(page.rows.length > 0 && page.rows.every((r: { error: string | null }) => r.error));
    const one = await ok("getEmailLog", call("GET", `/email-logs/${page.rows[0].id}`));
    assert.equal(typeof one.body, "string");

    const { rows } = await db().query(
      `SELECT e.id, b.currency FROM enterprises e JOIN enterprise_billing b ON b.enterprise_id = e.id AND b.side = 'customer'
        WHERE e.deleted_at IS NULL AND EXISTS (SELECT 1 FROM enterprise_contacts c WHERE c.enterprise_id = e.id
              AND c.contact_type = 'finance') LIMIT 1`,
    );
    const tx = await ok(
      "createTransaction",
      call("POST", "/transactions", {
        side: "customer",
        enterpriseId: Number(rows[0].id),
        invoiceId: null,
        paymentMode: "bank_transfer",
        transactionType: "receipt",
        paymentType: "credit",
        paymentDate: "2026-10-15",
        amount: 12.34,
        currency: String(rows[0].currency).trim(),
        description: `Email log test ${run}`,
        sendConfirmation: true,
        includeInSoa: true,
        excludeReason: null,
      }),
      201,
    );
    const logs = await logsSince("payment_confirmation");
    assert.ok(logs.some((l) => l.subject.includes(`TX-${tx.record.id}`) && l.status === "sent"));
    await undo(tx.change);
  });
});

describe("Notification: Send Rate, Send Tech Info, View Rate (§8)", { skip }, () => {
  test("rate sheet, preview, sends logged, failures listed", async () => {
    const { rows } = await db().query(
      `SELECT t.id FROM customer_trunks t WHERE t.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM customer_trunk_rate_tables x WHERE x.customer_trunk_id = t.id) LIMIT 1`,
    );
    const { rows: none } = await db().query(
      `SELECT t.id FROM customer_trunks t WHERE t.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM customer_trunk_rate_tables x WHERE x.customer_trunk_id = t.id) LIMIT 1`,
    );
    const id = Number(rows[0].id);
    const csv = await call("GET", `/customer-trunks/${id}/rate-sheet?fileType=csv`);
    assert.equal(csv.statusCode, 200);
    assert.ok(csv.body.startsWith("Country,Network,MCCMNC,Dial Code,Rate,Currency,Effective Date,Change"));
    assert.ok(csv.body.split("\n").length > 10);
    // Named by the business company's Customer Rate File Name, variables filled (team trial round 12).
    const { rows: tn } = await db().query("SELECT name FROM customer_trunks WHERE id = $1", [id]);
    const disposition = String(csv.headers["content-disposition"]);
    assert.match(disposition, /filename="[^"]+\.csv"/);
    assert.ok(disposition.includes(String(tn[0].name)), disposition);
    assert.doesNotMatch(disposition.split("filename*")[0]!, /[[{]/, "no variable left unfilled");
    const preview = await ok(
      "previewNotification",
      call("POST", "/notifications/preview", { trunkId: id, kind: "send_rate" }),
    );
    assert.ok(preview.recipients.length > 0 && !/\{\w+\}/.test(preview.subject + preview.body));
    const ids = none[0] ? [id, Number(none[0].id)] : [id];
    const sent = await ok(
      "sendRateNotifications",
      call("POST", "/notifications/send-rate", { trunkIds: ids, fileType: "excel", sendEmail: true }),
    );
    assert.equal(sent.sent, 1);
    if (none[0]) assert.equal(sent.failed[0].reason, "no rate table");
    const logs = await logsSince("send_rate");
    assert.ok(logs.some((l) => Number(l.customer_trunk_id) === id && l.file_name.endsWith(".xls") && l.rate_date));
    const tech = await ok(
      "sendTechInfoNotifications",
      call("POST", "/notifications/send-tech-info", { trunkIds: [id] }),
    );
    assert.equal(tech.sent, 1);
    const techLog = (await logsSince("send_tech_info")).at(-1)!;
    // The SMPP password goes in the e-mail in plain text (decided 2026-10-18, team trial round 1).
    assert.ok(/Password: \S+/.test(techLog.body), "the password is in the e-mail");
  });

  test("Send Tech Info from the enterprise: one e-mail with every trunk (team trial round 3)", async () => {
    const { rows } = await db().query(
      `SELECT array_agg(t.id ORDER BY t.id) AS ids, array_agg(t.name ORDER BY t.id) AS names FROM customer_trunks t
        JOIN enterprise_contacts c ON c.enterprise_id = t.enterprise_id AND c.contact_type IN ('technical', 'commercial')
             AND cardinality(c.emails) > 0
        WHERE t.deleted_at IS NULL GROUP BY t.enterprise_id HAVING count(DISTINCT t.id) >= 2 LIMIT 1`,
    );
    assert.ok(rows[0], "an enterprise with two trunks and a contact");
    const ids = [...new Set(rows[0].ids as number[])].map(Number);
    const names = [...new Set(rows[0].names as string[])];
    const sent = await ok(
      "sendTechInfoNotifications",
      call("POST", "/notifications/send-tech-info", { trunkIds: ids, oneEmailPerEnterprise: true }),
    );
    assert.equal(sent.sent, ids.length);
    const { rows: last } = await db().query(
      "SELECT body FROM email_logs WHERE email_type = 'send_tech_info' ORDER BY id DESC LIMIT 1",
    );
    const log = last[0] as { body: string };
    for (const n of names) assert.ok(log.body.includes(n), `${n} is in the e-mail`);
  });
});

describe("Firewall (§8)", { skip }, () => {
  test("ban, clash, check, remove, undo; filters", async () => {
    const ip = `2001:db8:${(Date.now() % 0xffff).toString(16)}::7`;
    const bad = await call("POST", "/firewall-rules", {
      list: "banned",
      ip: "198.51.100.5/24",
      filterId: 1,
      reason: null,
    });
    assert.equal(bad.statusCode, 400, "host bits set");
    const notIp = await call("POST", "/firewall-rules", { list: "banned", ip: "999.1.1.1", filterId: 1, reason: null });
    assert.equal(notIp.statusCode, 400);
    const banned = await ok(
      "createFirewallRule",
      call("POST", "/firewall-rules", { list: "banned", ip, filterId: 1, reason: "Test ban" }),
      201,
    );
    assert.equal(banned.record.ip, `${ip}`);
    const again = await call("POST", "/firewall-rules", { list: "trusted", ip, filterId: 1, reason: null });
    assert.equal(again.statusCode, 409);
    const decision = await ok("checkFirewallIp", call("POST", "/firewall/check", { ip }));
    assert.equal(decision.decision, "banned");
    const removed = await ok("archiveFirewallRule", call("POST", `/firewall-rules/${banned.record.id}/archive`, {}));
    assert.ok(removed.record.archivedAt);
    assert.equal((await ok("checkFirewallIp", call("POST", "/firewall/check", { ip }))).decision, "allowed");
    await undo(removed.change);
    assert.equal((await ok("checkFirewallIp", call("POST", "/firewall/check", { ip }))).decision, "banned");
    await undo(banned.change);

    const f = await ok(
      "createFirewallFilter",
      call("POST", "/firewall-filters", {
        name: `Test filter ${run}`,
        listener: "http",
        status: "active",
        failedAttempts: 3,
        windowSeconds: 30,
        banMinutes: 10,
      }),
      201,
    );
    const dup = await call("POST", "/firewall-filters", {
      name: `test filter ${run}`,
      listener: "smpp",
      status: "active",
      failedAttempts: 5,
      windowSeconds: 60,
      banMinutes: 60,
    });
    assert.equal(dup.statusCode, 409, "names are unique, ignoring case");
    const edited = await ok(
      "updateFirewallFilter",
      call("PUT", `/firewall-filters/${f.record.id}`, {
        name: `Test filter ${run}`,
        listener: "http",
        status: "inactive",
        failedAttempts: 3,
        windowSeconds: 30,
        banMinutes: 10,
      }),
    );
    assert.equal(edited.record.status, "inactive");
    await undo(edited.change);
    const list = await ok(
      "queryFirewallRules",
      call("POST", "/firewall-rules/query", {
        limit: 5,
        filter: { logic: "and", conditions: [{ field: "list", op: "eq", value: "trusted" }] },
      }),
    );
    assert.ok(list.rows.every((r: { list: string }) => r.list === "trusted"));
  });
});

describe("Traffic alerts (§8)", { skip }, () => {
  test("add, edit, clone, check against EDRs, delete, undo", async () => {
    const { rows } = await db().query("SELECT customer_trunk_id FROM traffic_alerts ORDER BY id LIMIT 1");
    const input = {
      name: `Test alert ${run}`,
      sampleCount: 1,
      sampleMinutes: 60,
      asrThreshold: 100,
      dlrThreshold: 0,
      marginThreshold: -100,
      customerTrunkId: Number(rows[0].customer_trunk_id),
      vendorTrunkId: null,
      senderId: null,
      mccmnc: null,
      delayThreshold: null,
      notificationEmails: ["noc@example.test"],
      contactEmail: "none",
      templateId: 5,
      status: "active",
    };
    const noOne = await call("POST", "/traffic-alerts", { ...input, notificationEmails: [] });
    assert.equal(noOne.statusCode, 400);
    const wrongTemplate = await call("POST", "/traffic-alerts", { ...input, templateId: 1 });
    assert.equal(wrongTemplate.statusCode, 400);
    const created = await ok("createTrafficAlert", call("POST", "/traffic-alerts", input), 201);
    const id = created.record.id;
    const checked = await ok("checkTrafficAlert", call("POST", `/traffic-alerts/${id}/check`));
    assert.equal(checked.state, "firing", "ASR is always ≤ 100 %");
    assert.deepEqual(checked.emailed, ["noc@example.test"]);
    assert.ok((await logsSince("traffic_alert")).some((l) => l.subject.includes(`Test alert ${run}`)));
    const again = await ok("checkTrafficAlert", call("POST", `/traffic-alerts/${id}/check`));
    assert.deepEqual(again.emailed, [], "no second e-mail while it keeps firing");
    const edited = await ok("updateTrafficAlert", call("PUT", `/traffic-alerts/${id}`, { ...input, asrThreshold: 0 }));
    assert.equal(edited.record.asrThreshold, 0);
    await undo(edited.change);
    const copy = await ok("cloneTrafficAlert", call("POST", `/traffic-alerts/${id}/clone`), 201);
    assert.equal(copy.record.status, "inactive");
    const gone = await ok("archiveTrafficAlert", call("POST", `/traffic-alerts/${id}/archive`, {}));
    assert.ok(gone.record.archivedAt);
    await undo(gone.change);
    await undo(copy.change);
    await undo(created.change);
  });
});

describe("SMS to voice (§8)", { skip }, () => {
  test("add, test, edit, delete", async () => {
    const empty = await call("POST", "/sms-voice-rules", {
      senderId: null,
      receiverId: null,
      prefix: null,
      repeat: 2,
      mccmnc: null,
      gatewayId: null,
      status: "active",
    });
    assert.equal(empty.statusCode, 400);
    const created = await ok(
      "createSmsVoiceRule",
      call("POST", "/sms-voice-rules", {
        senderId: `T${run}%`,
        receiverId: null,
        prefix: "999",
        repeat: 3,
        mccmnc: null,
        gatewayId: null,
        status: "active",
      }),
      201,
    );
    const hit = await ok(
      "testSmsVoiceRules",
      call("POST", "/sms-voice-rules/test", { senderId: `T${run}X`, receiver: "+99912345", text: "PIN 12" }),
    );
    assert.equal(hit.matched, true);
    assert.equal(hit.rule.id, created.record.id);
    // "PIN 12" has no 4 to 8 digit code: the rule matches but the message stays an SMS (§8).
    assert.equal(hit.outcome, "sms");
    assert.equal(hit.smsReason, "no_code");
    const miss = await ok(
      "testSmsVoiceRules",
      call("POST", "/sms-voice-rules/test", { senderId: "OTHER", receiver: "+99912345", text: "PIN 12" }),
    );
    assert.equal(miss.matched, false);
    const edited = await ok(
      "updateSmsVoiceRule",
      call("PUT", `/sms-voice-rules/${created.record.id}`, {
        senderId: `T${run}%`,
        receiverId: null,
        prefix: "998",
        repeat: 3,
        mccmnc: null,
        gatewayId: null,
        status: "active",
      }),
    );
    assert.equal(edited.record.prefix, "998");
    await undo(edited.change);
    await undo(created.change);
  });
});

describe("Broadcast (§8)", { skip }, () => {
  test("audience, mailboxes, send logs one e-mail per enterprise", async () => {
    const boxes = await ok("listCompanyMailboxes", call("GET", "/business-companies/1/mailboxes"));
    const sender = boxes.mailboxes[0].email;
    const audience = { businessCompanyId: 1, contactTypes: ["technical"], enterpriseTypes: ["vendor"] };
    const preview = await ok("previewBroadcast", call("POST", "/broadcasts/preview", audience));
    assert.ok(preview.enterprises > 0);
    const wrongSender = await call("POST", "/broadcasts", {
      ...audience,
      sender: "someone@elsewhere.test",
      subject: "x",
      bodyHtml: "<p>x</p>",
      attachment: null,
    });
    assert.equal(wrongSender.statusCode, 400);
    const sent = await ok(
      "sendBroadcast",
      call("POST", "/broadcasts", {
        ...audience,
        sender,
        subject: `Test broadcast ${run}`,
        bodyHtml: "<p>Hello <b>partners</b></p><script>alert(1)</script>",
        attachment: { name: "notice.txt", contentBase64: Buffer.from("notice").toString("base64") },
      }),
      201,
    );
    assert.equal(sent.enterprises, preview.enterprises);
    const logs = (await logsSince("broadcast")).filter((l) => l.subject === `Test broadcast ${run}`);
    assert.equal(logs.length, preview.enterprises);
    assert.ok(logs.every((l) => !l.body.includes("alert(1)") && l.file_name === "notice.txt"));
    const list = await ok("queryBroadcasts", call("POST", "/broadcasts/query", { limit: 3 }));
    assert.equal(list.rows[0].subject, `Test broadcast ${run}`);
  });
});
