// Backend step 12 (§13.6): an alert rule on a country, MCCMNC, sender ID or product category watches that traffic
// only (from the EDR store), with its normal levels from the same hour yesterday and a week ago. Rows use a made-up
// country code and enterprise IDs no other test reads, and are removed after.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AlertRuleRow } from "@sms/contract";
import { closeDb, dbReady } from "../src/db.js";
import { chQuery, chRows } from "../src/edr.js";
import { dimensionEntity } from "../src/alerts/engine.js";

const ready = await dbReady();
const store = ready && (await chRows<{ n: string }>("SELECT count() FROM edr_all LIMIT 1")) !== null;
const skip = store ? false : "seeded database and EDR store not available";
const ent = 5_000_000 + Math.floor(Math.random() * 900_000);
const ISO = "XQ";

after(async () => {
  if (store) await chQuery(`ALTER TABLE edr DELETE WHERE c_enterprise_id = ${ent} SETTINGS mutations_sync = 1`);
  await closeDb();
});

const rule = (scope: AlertRuleRow["scope"]) => ({ id: 1, scope }) as unknown as AlertRuleRow;

async function insert(minutesAgo: number, ok: boolean, country = ISO, sender = "BRANDX") {
  const t = `now() - INTERVAL ${minutesAgo} MINUTE`;
  await chQuery(
    `INSERT INTO edr (edr_id, start_time, submit_time, msg_type, business_company_id, c_enterprise_id, c_trunk_id,
                      c_country_iso, c_mccmnc, src_addr, product_category_id, attempt_no, is_final_attempt,
                      is_submit_success, msg_count, c_msg_status)
     SELECT '${randomUUID()}', ${t}, ${t}, 'MT', 1, ${ent}, 901, '${country}', '99901', '${sender.replace(/'/g, "\\'")}', 0, 1, 1,
            ${ok ? 1 : 0}, 1, 'ACCEPTD'`,
  );
}

describe("alert rules on a traffic dimension (§13.6)", { skip }, () => {
  test("a country rule counts that country's traffic only, minute by minute", async () => {
    await insert(2, true);
    await insert(2, false);
    await insert(3, true);
    await insert(2, true, "XR");
    const e = await dimensionEntity(rule({ kind: "country", ids: [], values: [ISO] }));
    assert.ok(e, "an entity");
    const s = e.series[0]!;
    assert.equal(Math.round(s.minutes.reduce((a, b) => a + b, 0) * 60), 3, "three messages, not the XR one");
    assert.equal(e.name, `country ${ISO}`);
    assert.equal(s.normalTps, 0, "nothing at this hour yesterday or last week");
  });

  test("a sender ID with a quote cannot break out of the query", async () => {
    await insert(1, true, ISO, "O'BRIEN");
    const e = await dimensionEntity(rule({ kind: "sender_id", ids: [], values: ["O'BRIEN"] }));
    assert.ok(e);
    assert.equal(Math.round(e.series[0]!.minutes.reduce((a, b) => a + b, 0) * 60), 1);
  });

  test("trunk and enterprise scopes, and dimension rules without values, are left to the live series", async () => {
    assert.equal(await dimensionEntity(rule({ kind: "customer", ids: [], values: [] })), undefined);
    assert.equal(await dimensionEntity(rule({ kind: "country", ids: [], values: [] })), undefined);
  });
});
