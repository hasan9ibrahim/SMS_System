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
  /** The sender after the customer trunk's own translation rules. */
  sender: string;
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
const simulate = async (
  customerTrunkId: number,
  mccmnc: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<Sim> => {
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
      ...extra,
    },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as Sim;
};
const LONG = "a".repeat(400); // three GSM parts

/**
 * Customer trunks (TON / NPI as sent) and a destination each has a rate for: the first network of its first rate
 * table. One index walk per trunk, stopping at `limit` trunks; joining every rate line of every trunk first (1.4 M
 * lines in the full seed) ran past the 15 s statement timeout on CI.
 */
async function pairs(limit: number) {
  const { rows } = await db().query(
    `SELECT t.id, l.mccmnc FROM customer_trunks t
       CROSS JOIN LATERAL (
         SELECT l.mccmnc FROM customer_trunk_rate_tables x
           JOIN rate_lines l ON l.rate_table_id = x.rate_table_id AND l.sender_id IS NULL AND NOT l.is_blocked
                AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now()) AND length(l.mccmnc) = 5
          WHERE x.customer_trunk_id = t.id
          ORDER BY x.rate_table_id, l.mccmnc LIMIT 1) l
      WHERE t.deleted_at IS NULL AND t.status = 'active' AND t.ton_npi_mode = 'as_sent'
      ORDER BY t.id LIMIT $1`,
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

  test("TON / NPI as the vendor takes them: the one equivalent, auto, Refuse invalid senders (S-4.7)", async () => {
    const CODE = "Your code is 1234";
    const LONG_SENDER = "ABCDEFGHIJKLMN";
    const setVendor = (id: number, sql: string, params: unknown[] = []) =>
      db().query(`UPDATE vendor_trunks SET ${sql} WHERE id = $1`, [id, ...params]);
    let equivalents = false;
    let senders = false;
    // CI's seed has translation rules, on customer and on vendor trunks, that put a random 12-digit number in the
    // sender for some destinations only (sent as TON 5), which a vendor refusing invalid senders passes over whatever
    // the step checks. The TON / NPI steps run with that refusal off; the sender step takes only a vendor whose
    // refusal names the test's own sender.
    for (const p of await pairs(60)) {
      if (equivalents && senders) return;
      const first = await simulate(p.trunk, p.mccmnc, CODE);
      const v = first.route.decision?.outcome === "route" ? first.route.decision.vendor!.vendorTrunkId : null;
      if (v === null) continue;
      const ruleId = first.route.decision!.ruleId;
      // The vendor's notes (it can be listed more than once, e.g. also as a backup).
      const notes = (sim: Sim) =>
        (sim.route.decision?.candidates ?? []).filter((c) => c.vendorTrunkId === v).map((c) => c.note ?? "");
      // A backup vendor's skip has no note of its own; take a vendor routed in its own right.
      if (notes(first).includes("backup route")) continue;
      // The vendor's own values come back after.
      const { rows } = await db().query(
        `SELECT allowed_dst_ton, allowed_dst_npi, ton_npi_mode, refuse_invalid_senders FROM vendor_trunks WHERE id = $1`,
        [v],
      );
      const before = rows[0];
      try {
        // National destinations only: an international number has no equivalent it takes.
        await setVendor(
          v,
          "allowed_dst_ton = '{2}', allowed_dst_npi = NULL, ton_npi_mode = 'as_sent', refuse_invalid_senders = false",
        );
        const national = await simulate(p.trunk, p.mccmnc, CODE, { destTon: 0, destNpi: 0 });
        const d = national.route.decision;
        if (d?.ruleId !== ruleId) continue; // another rule took over
        equivalents = true;
        assert.notEqual(d.vendor?.vendorTrunkId, v, "no equivalent: passed over");
        assert.ok(
          notes(national).some((n) =>
            /^cannot take the message: destination TON 0 is not allowed \(it takes 2\)/.test(n),
          ),
          JSON.stringify(notes(national)),
        );

        // International numbers only: 0 / 0 goes as the equivalent 1 / 1, auto or not.
        await setVendor(v, "allowed_dst_ton = '{1}', allowed_dst_npi = '{1}'");
        const equivalent = await simulate(p.trunk, p.mccmnc, CODE, { destTon: 0, destNpi: 0 });
        assert.equal(equivalent.route.decision?.vendor?.vendorTrunkId, v, "the equivalent 1 / 1 is taken");
        await setVendor(v, "ton_npi_mode = 'auto'");
        const auto = await simulate(p.trunk, p.mccmnc, CODE, { destTon: 0, destNpi: 0 });
        assert.equal(auto.route.decision?.vendor?.vendorTrunkId, v, "auto sends the international number as 1 / 1");

        // A sender a handset cannot show: passed over while the vendor refuses invalid senders (the default), taken
        // with that off; auto cannot fix a length. Only where both trunks' rules leave the sender as it is: the
        // customer's as the simulation reports it, the vendor's as its refusal names it.
        {
          const extra = { senderId: LONG_SENDER, sourceTon: 1 };
          await setVendor(v, "refuse_invalid_senders = true");
          const refused = await simulate(p.trunk, p.mccmnc, CODE, extra);
          await setVendor(v, "refuse_invalid_senders = false");
          const taken = await simulate(p.trunk, p.mccmnc, CODE, extra);
          const same = (sim: Sim) => sim.route.decision?.ruleId === ruleId && sim.sender === LONG_SENDER;
          const namesIt = notes(refused).some((n) => n.includes(JSON.stringify(LONG_SENDER)));
          if (same(refused) && same(taken) && namesIt) {
            assert.notEqual(refused.route.decision?.vendor?.vendorTrunkId, v);
            assert.ok(
              notes(refused).some((n) =>
                /^cannot take the message: the sender "ABCDEFGHIJKLMN" is longer than 11 characters/.test(n),
              ),
              JSON.stringify(notes(refused)),
            );
            assert.equal(taken.route.decision?.vendor?.vendorTrunkId, v, "Refuse invalid senders off: taken");
            senders = true;
          }
        }
      } finally {
        await setVendor(
          v,
          "allowed_dst_ton = $2, allowed_dst_npi = $3, ton_npi_mode = $4, refuse_invalid_senders = $5",
          [before.allowed_dst_ton, before.allowed_dst_npi, before.ton_npi_mode, before.refuse_invalid_senders],
        );
      }
    }
    assert.ok(equivalents, "no routed vendor found in the seeded data");
    assert.ok(senders, "no routed vendor that keeps the sender found in the seeded data");
  });
});
