// Route Simulator (§9.2): a message through a customer trunk as the switch would handle it - the
// trunk's translation rules and HLR rule (§13.2), the destination, the customer rate, the route rules
// in order (§6.3) and the chosen vendor with its cost and the margin. A vendor trunk can be tested
// directly (team trial round 1): the route rules are shown but the message goes to that vendor at its
// own buy rate. Test SMS answers with a simulated outcome; no EDR is written and nothing is sent, except in production,
// where the switch sends it (backend step 11c).
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouteSimulatorInput, RouteSimulatorResult } from "@sms/contract";
import { PLATFORM_CURRENCY, toPlatformSql } from "../currency.js";
import { withDb } from "../db.js";
import { messageEncoding } from "../smpp.js";
import { listIdsOf, loadRulesInOrder, messageContext, routeThrough, vendorOptions } from "./routeRules.js";
import { skipEgressBlocked } from "./egress.js";
import { badInput } from "./switchTools.js";
import { runTrunkRules } from "./translationRules.js";
import { production } from "../mode.js";
import { switchTestSms } from "../switch/operations.js";

export function runRouteSimulator(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as RouteSimulatorInput;
  return withDb(reply, async (pool): Promise<RouteSimulatorResult | FastifyReply> => {
    const { rows: tr } = await pool.query(
      `SELECT t.id, t.name, e.name AS enterprise FROM customer_trunks t JOIN enterprises e ON e.id = t.enterprise_id
        WHERE t.id = $1 AND t.deleted_at IS NULL`,
      [b.customerTrunkId],
    );
    if (!tr[0]) return badInput(reply, [{ path: "/customerTrunkId", message: "unknown customer trunk" }]);
    // Only a destination picked: a test number from the network's longest dial code (team trial round 1).
    let receiverIn = b.receiver ?? "";
    if (!receiverIn) {
      if (!b.mccmnc) return badInput(reply, [{ path: "/receiver", message: "give a receiver or a destination" }]);
      const { rows: dc } = await pool.query(
        `SELECT d.prefix FROM dial_codes d JOIN mccmnc m ON m.id = d.mccmnc_id
          WHERE m.mccmnc = $1 AND d.deleted_at IS NULL AND d.profile = 'All' ORDER BY length(d.prefix) DESC LIMIT 1`,
        [b.mccmnc],
      );
      if (!dc[0]) return badInput(reply, [{ path: "/mccmnc", message: "no dial code for this destination" }]);
      const prefix = String(dc[0].prefix);
      receiverIn = prefix + "1234567890123".slice(0, Math.max(4, 12 - prefix.length));
    }
    const translation = (await runTrunkRules(pool, "customer", b.customerTrunkId, {
      sender: b.senderId ?? "",
      receiver: receiverIn,
      text: b.text ?? "",
      senderTon: b.sourceTon,
      senderNpi: b.sourceNpi,
    }))!;
    const sender = translation.after.sender;
    const receiver = translation.after.receiver.replace(/\D/g, "") || receiverIn;
    const rules = await loadRulesInOrder(pool);
    const m = await messageContext(
      pool,
      {
        customerTrunkId: b.customerTrunkId,
        receiver,
        sender,
        content: translation.after.text,
        mccmnc: b.mccmnc ?? undefined,
      },
      listIdsOf(rules),
    );
    const options = await vendorOptions(pool, m.mccmnc, null);
    // A vendor whose own egress rules block the message is skipped and the next vendor tried
    // (decided 2026-10-18); a block on the customer trunk rejects the message before routing.
    const { result: route, skipped: egressSkipped } =
      !translation.blocked && !b.vendorTrunkId
        ? await skipEgressBlocked(
            pool,
            m,
            {
              sender,
              receiver,
              text: translation.after.text,
              senderTon: translation.after.senderTon,
              senderNpi: translation.after.senderNpi,
            },
            (mm) => routeThrough(rules, mm, options),
            (r) => r.decision?.vendor,
          )
        : { result: routeThrough(rules, m, options), skipped: [] };

    let customerRate: RouteSimulatorResult["customerRate"] = null;
    if (m.mccmnc) {
      const { rows } = await pool.query(
        `SELECT l.rate, l.currency, rt.id AS rate_table_id, rt.name AS rate_table, ${toPlatformSql("l.rate")} AS conv
           FROM customer_trunk_rate_tables x
           JOIN rate_tables rt ON rt.id = x.rate_table_id
           JOIN rate_lines l ON l.rate_table_id = x.rate_table_id
           JOIN currency_latest cl ON cl.iso = l.currency
          WHERE x.customer_trunk_id = $1 AND l.mccmnc = ANY($2) AND l.sender_id IS NULL AND NOT l.is_blocked
            AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
          ORDER BY x.position, length(l.mccmnc) DESC LIMIT 1`,
        [b.customerTrunkId, [m.mccmnc, m.mccmnc.slice(0, 3)]],
      );
      if (rows[0])
        customerRate = {
          rate: Number(rows[0].rate),
          currency: String(rows[0].currency).trim(),
          platformRate: Math.round(Number(rows[0].conv) * 1e6) / 1e6,
          rateTableId: Number(rows[0].rate_table_id),
          rateTable: rows[0].rate_table,
        };
    }
    // Straight to one vendor: its own line for the network, else for the country.
    let forcedVendor: RouteSimulatorResult["forcedVendor"] = null;
    if (b.vendorTrunkId) {
      const { rows: vt } = await pool.query("SELECT id, name FROM vendor_trunks WHERE id = $1 AND deleted_at IS NULL", [
        b.vendorTrunkId,
      ]);
      if (!vt[0]) return badInput(reply, [{ path: "/vendorTrunkId", message: "unknown vendor trunk" }]);
      const { rows } = m.mccmnc
        ? await pool.query(
            `SELECT l.rate, l.currency, ${toPlatformSql("l.rate")} AS conv
               FROM rate_tables rt JOIN rate_lines l ON l.rate_table_id = rt.id
               JOIN currency_latest cl ON cl.iso = l.currency
              WHERE rt.vendor_trunk_id = $1 AND rt.deleted_at IS NULL AND l.mccmnc = ANY($2) AND l.sender_id IS NULL
                AND NOT l.is_blocked AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
              ORDER BY length(l.mccmnc) DESC LIMIT 1`,
            [b.vendorTrunkId, [m.mccmnc, m.mccmnc.slice(0, 3)]],
          )
        : { rows: [] };
      forcedVendor = {
        vendorTrunkId: Number(vt[0].id),
        name: vt[0].name,
        rate: rows[0] ? Number(rows[0].rate) : null,
        currency: rows[0] ? String(rows[0].currency).trim() : null,
        platformRate: rows[0] ? Math.round(Number(rows[0].conv) * 1e6) / 1e6 : null,
      };
    }
    const d = route.decision;
    const chosen = d?.vendor ? d.candidates.find((c) => c.vendorTrunkId === d.vendor!.vendorTrunkId) : undefined;
    const cost = forcedVendor ? forcedVendor.platformRate : (chosen?.cost ?? null);
    const vendorCost = cost === null ? null : { rate: cost, currency: PLATFORM_CURRENCY };
    const sell = customerRate?.platformRate ?? null;
    const marginPct = sell && cost !== null ? Math.round(((sell - cost) / sell) * 1000) / 10 : null;
    // Egress translation (§6.4, §13.2): the chosen vendor trunk's rules run after routing, on the
    // message as ingress translation left it; shows what the vendor would receive.
    const egressId = forcedVendor ? forcedVendor.vendorTrunkId : (d?.vendor?.vendorTrunkId ?? null);
    const egressName = forcedVendor ? forcedVendor.name : (d?.vendor?.name ?? "");
    const egress =
      egressId !== null && !translation.blocked
        ? await runTrunkRules(pool, "vendor", egressId, {
            sender,
            receiver,
            text: translation.after.text,
            senderTon: translation.after.senderTon,
            senderNpi: translation.after.senderNpi,
          })
        : null;
    const vendorTranslation: RouteSimulatorResult["vendorTranslation"] =
      egress && egressId !== null ? { vendorTrunkId: egressId, vendorTrunk: egressName, result: egress } : null;
    const blocked = translation.blocked
      ? "Blocked by a translation rule on the trunk"
      : !m.mccmnc
        ? "Unknown destination: no dial code matches the number"
        : !customerRate
          ? "No customer rate for the destination (ESME_RINVDSTADR)"
          : forcedVendor
            ? forcedVendor.rate === null
              ? `${forcedVendor.name} has no rate for the destination`
              : null
            : !d
              ? "No route rule matches"
              : d.outcome === "block"
                ? `Blocked by route rule ${d.ruleId}`
                : d.outcome === "no_vendor"
                  ? `Route rule ${d.ruleId} matched but no vendor qualifies`
                  : egress?.blocked
                    ? `Blocked by a translation rule on vendor trunk ${egressName}`
                    : null;
    let testSms: RouteSimulatorResult["testSms"] = null;
    // Production (backend step 11c): the switch sends it, through its own rules (or straight to the chosen vendor).
    if (b.testSms && production)
      testSms = blocked
        ? { messageId: "", status: "REJECTD", detail: blocked }
        : await switchTestSms({
            customerTrunkId: b.customerTrunkId,
            receiver: receiverIn,
            sender: b.senderId,
            text: b.text,
            dataCoding: b.dataCoding,
            sourceTon: b.sourceTon,
            sourceNpi: b.sourceNpi,
            vendorTrunkId: b.vendorTrunkId,
          });
    else if (b.testSms) {
      const messageId = Math.floor(Math.random() * 2 ** 48)
        .toString(16)
        .padStart(12, "0");
      if (blocked) testSms = { messageId, status: "REJECTD", detail: blocked };
      else {
        const roll = Math.random();
        const status = roll < 0.85 ? "DELIVRD" : roll < 0.95 ? "UNDELIV" : "EXPIRED";
        testSms = {
          messageId,
          status,
          detail: `Sent to ${forcedVendor ? forcedVendor.name : d!.vendor!.name}; receipt ${status} after ${(1 + Math.random() * 6).toFixed(1)} s (simulated)`,
        };
      }
    }
    return {
      trunk: { id: Number(tr[0].id), name: tr[0].name, enterprise: tr[0].enterprise },
      translation,
      sender,
      receiver,
      mccmnc: m.mccmnc,
      destination: m.destination,
      encoding: messageEncoding(translation.after.text, b.dataCoding),
      customerRate,
      route: { ...route, egressSkipped },
      vendorCost,
      marginPct,
      blocked,
      testSms,
      forcedVendor,
      vendorTranslation,
      egressSkipped,
    };
  });
}
