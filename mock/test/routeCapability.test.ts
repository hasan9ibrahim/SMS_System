// The Route Simulator routes as the switch does (QA 2026-10-31, §6.3, §5.5, S-3.9, S-4.4): a rule with Deny Multipart
// lets a multipart message go to the next rule, and a vendor that cannot take the message as it would get it (here:
// longer than its Max Msg Len) is passed over, the simulator saying why. Reads the seeded data only.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { buildServer, API_PREFIX } from "../src/server.js";
import { closeDb, db, dbReady } from "../src/db.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
after(async () => {
  await app.close();
  await closeDb();
});

interface Sim {
  blocked: string | null;
  route: {
    tried: { ruleId: number; matched: boolean; reason: string }[];
    decision: {
      ruleId: number;
      outcome: string;
      vendor: { vendorTrunkId: number } | null;
      candidates: { vendorTrunkId: number; note: string | null }[];
    } | null;
  };
}
const simulate = async (customerTrunkId: number, mccmnc: string, text: string): Promise<Sim> => {
  const r = await app.inject({
    method: "POST",
    url: `${API_PREFIX}/route-simulator`,
    payload: {
      customerTrunkId,
      mccmnc,
      senderId: "INFO",
      sourceTon: 5,
      sourceNpi: 0,
      destTon: 1,
      destNpi: 1,
      text,
      dataCoding: 0,
    },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as Sim;
};
const LONG = "a".repeat(400); // three GSM parts

/** Customer trunks and destinations they have a rate for. */
async function pairs(limit: number) {
  const { rows } = await db().query(
    `SELECT DISTINCT ON (t.id) t.id, l.mccmnc FROM customer_trunks t
       JOIN customer_trunk_rate_tables x ON x.customer_trunk_id = t.id
       JOIN rate_lines l ON l.rate_table_id = x.rate_table_id AND l.sender_id IS NULL AND NOT l.is_blocked
            AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now()) AND length(l.mccmnc) = 5
      WHERE t.deleted_at IS NULL AND t.status = 'active'
      ORDER BY t.id, l.mccmnc LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ trunk: Number(r.id), mccmnc: String(r.mccmnc) }));
}

describe("Route Simulator routes as the switch (§6.3, §5.5)", { skip }, () => {
  test("a vendor longer than its Max Msg Len is passed over, saying why", async () => {
    for (const p of await pairs(60)) {
      const short = await simulate(p.trunk, p.mccmnc, "Your code is 1234");
      const v = short.route.decision?.outcome === "route" ? short.route.decision.vendor!.vendorTrunkId : null;
      if (v === null) continue;
      const { rows } = await db().query("SELECT max_msg_len, support_multipart FROM vendor_trunks WHERE id = $1", [v]);
      if (rows[0]?.support_multipart === false) continue; // passed over for multipart before its length counts
      // The generator sets no Max Msg Len (CI's fresh seed has none): the vendor gets one just under the long message
      // for this check, and its own value back after.
      const before: number | null = rows[0]?.max_msg_len ?? null;
      if (before === null || Number(before) >= LONG.length)
        await db().query("UPDATE vendor_trunks SET max_msg_len = $2 WHERE id = $1", [v, LONG.length - 1]);
      try {
        const long = await simulate(p.trunk, p.mccmnc, LONG);
        const d = long.route.decision;
        if (d?.ruleId !== short.route.decision!.ruleId) continue; // another rule (e.g. Deny Multipart) took over
        assert.notEqual(d.vendor?.vendorTrunkId, v, "the vendor is passed over");
        const note = d.candidates.find((c) => c.vendorTrunkId === v)?.note ?? "";
        assert.match(note, /^cannot take the message: 400 characters, longer than its Max Msg Len \d+/);
        if (d.outcome === "no_vendor") assert.match(long.blocked ?? "", /0x45/);
        return;
      } finally {
        await db().query("UPDATE vendor_trunks SET max_msg_len = $2 WHERE id = $1", [v, before]);
      }
    }
    assert.fail("no routed vendor with a Max Msg Len found in the seeded data");
  });

  test("a rule with Deny Multipart leaves a multipart message to the next rule", async () => {
    const { rows: rules } = await db().query("SELECT id FROM route_rules WHERE deleted_at IS NULL AND deny_multipart");
    const deny = new Set(rules.map((r) => Number(r.id)));
    for (const p of await pairs(200)) {
      const short = await simulate(p.trunk, p.mccmnc, "Your code is 1234");
      const ruleId = short.route.decision?.ruleId;
      if (!ruleId || !deny.has(ruleId)) continue;
      const long = await simulate(p.trunk, p.mccmnc, LONG);
      assert.notEqual(long.route.decision?.ruleId, ruleId, "the rule does not take the multipart message");
      // The rule's own Test says why (the gate fails whatever the match mode).
      const t = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/route-rules/${ruleId}/test`,
        payload: {
          customerTrunkId: p.trunk,
          receiver: "447700900123",
          sender: "INFO",
          content: LONG,
          mccmnc: p.mccmnc,
        },
      });
      assert.equal(t.statusCode, 200, t.body);
      const d = t.json() as { matched: boolean; checks: { condition: string; ok: boolean; detail: string }[] };
      assert.equal(d.matched, false);
      assert.deepEqual(
        d.checks.find((c) => c.condition === "Multipart"),
        {
          condition: "Multipart",
          ok: false,
          detail: "3 parts: multipart messages denied",
        },
      );
      return;
    }
    assert.fail("no simulated message reached a rule with Deny Multipart in the seeded data");
  });
});
