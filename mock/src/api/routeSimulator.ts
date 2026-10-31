// Route Simulator (§9.2): a message through a customer trunk as the switch would handle it - the
// trunk's translation rules and HLR rule (§13.2), the destination, the customer rate, the route rules
// in order (§6.3) and the chosen vendor with its cost and the margin. A vendor trunk can be tested
// directly (team trial round 1): the route rules are shown but the message goes to that vendor at its
// own buy rate. Test SMS answers with a simulated outcome; no EDR is written and nothing is sent, except in production,
// where the switch sends it (backend step 11c).
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouteSimulatorInput, RouteSimulatorResult } from "@sms/contract";
import { PLATFORM_CURRENCY } from "../currency.js";
import { withDb } from "../db.js";
import { messageEncoding } from "../smpp.js";
import { listIdsOf, loadRulesInOrder, messageContext, routeThrough, vendorOptions } from "./routeRules.js";
import { skipEgressBlocked, vendorView } from "./egress.js";
import { natural, type MessageForm } from "../routing/coding.js";
import { customerPrice, priced, vendorPrice } from "./linePrice.js";
import { badInput } from "./switchTools.js";
import { runTrunkTranslation } from "./translationRules.js";
import { withTonNpiMode } from "../routing/tonNpi.js";
import { production } from "../mode.js";
import { switchTestSms } from "../switch/operations.js";

export function runRouteSimulator(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as RouteSimulatorInput;
  return withDb(reply, async (pool): Promise<RouteSimulatorResult | FastifyReply> => {
    const { rows: tr } = await pool.query(
      `SELECT t.id, t.name, t.default_coding, t.ton_npi_mode, e.name AS enterprise FROM customer_trunks t
         JOIN enterprises e ON e.id = t.enterprise_id
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
    const ingress = (await runTrunkTranslation(pool, "customer", b.customerTrunkId, {
      sender: b.senderId ?? "",
      receiver: receiverIn,
      text: b.text ?? "",
      senderTon: b.sourceTon,
      senderNpi: b.sourceNpi,
    }))!;
    const translation = ingress.result;
    // S-4.7: a customer trunk set to auto fixes TON / NPI after its ingress translation, as the switch's intake does;
    // routing and every vendor see the fixed sender and values. A field an ingress rule set stays as the rule left it.
    const sent = withTonNpiMode(
      tr[0].ton_npi_mode,
      {
        sender: translation.after.sender,
        receiver: translation.after.receiver,
        senderTon: translation.after.senderTon ?? b.sourceTon ?? null,
        senderNpi: translation.after.senderNpi ?? b.sourceNpi ?? null,
        destTon: translation.after.destTon ?? b.destTon ?? null,
        destNpi: translation.after.destNpi ?? b.destNpi ?? null,
      },
      ingress.pinned,
    );
    const sender = sent.sender;
    const receiver = sent.receiver.replace(/\D/g, "") || receiverIn;
    // What the vendors' egress translation starts from (the message after ingress, S-4.8).
    const afterIngress = {
      sender,
      receiver,
      text: translation.after.text,
      senderTon: sent.senderTon,
      senderNpi: sent.senderNpi,
    };
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
      // Customer Sender ID rates match the sender as the customer sent it, before ingress translation (§6.2).
      b.senderId ?? "",
    );
    const options = await vendorOptions(pool, m.mccmnc, null);
    // The message as the customer sent it: Deny Multipart counts its parts, and a vendor that cannot take it as it
    // would get it (TON / NPI, coding, multipart, Max Msg Len) is passed over (§6.3, §5.5, S-3.9, S-4.4).
    const form: MessageForm = {
      text: b.text ?? "",
      dataCoding: b.dataCoding,
      defaultCoding: Number(tr[0].default_coding ?? 0),
    };
    m.parts = natural(form)?.parts || 1;
    // A vendor whose own egress rules block the message is skipped and the next vendor tried
    // (decided 2026-10-18); a block on the customer trunk rejects the message before routing.
    const {
      result: route,
      skipped: egressSkipped,
      senderOnly,
    } =
      !translation.blocked && !b.vendorTrunkId
        ? await skipEgressBlocked(
            pool,
            m,
            afterIngress,
            (mm) => routeThrough(rules, mm, options),
            (r) => r.decision?.vendor,
            {
              form,
              senderTon: sent.senderTon,
              senderNpi: sent.senderNpi,
              destTon: sent.destTon,
              destNpi: sent.destNpi,
              pinned: ingress.pinned,
            },
          )
        : { result: routeThrough(rules, m, options), skipped: [], senderOnly: false };

    // The customer's rate as the switch prices it (linePrice.ts): the sender's own line first; a blocked line that
    // applies refuses the message (blocked means blocked, decided 2026-10-30).
    const customerPriced = m.mccmnc ? await customerPrice(pool, b.customerTrunkId, m.mccmnc, b.senderId ?? null) : null;
    const customerBlocked = customerPriced === "blocked";
    const cp = priced(customerPriced);
    const customerRate: RouteSimulatorResult["customerRate"] = cp
      ? {
          rate: cp.rate,
          currency: cp.currency,
          platformRate: cp.platformRate,
          rateTableId: cp.rateTableId,
          rateTable: cp.rateTable,
        }
      : null;
    // No rate now: say when one starts, if it is only scheduled (team trial round 6: a new or raised customer rate
    // waits for its notice period, so the simulator saw "no rate" with no hint why).
    let upcomingRate: string | null = null;
    if (m.mccmnc && !customerRate && !customerBlocked) {
      const { rows } = await pool.query(
        `SELECT l.rate, l.currency, l.valid_from FROM customer_trunk_rate_tables x
           JOIN rate_lines l ON l.rate_table_id = x.rate_table_id
          WHERE x.customer_trunk_id = $1 AND l.mccmnc = ANY($2) AND l.sender_id IS NULL AND NOT l.is_blocked
            AND l.valid_from > now()
          ORDER BY l.valid_from, x.position, length(l.mccmnc) DESC LIMIT 1`,
        [b.customerTrunkId, [m.mccmnc, m.mccmnc.slice(0, 3)]],
      );
      if (rows[0])
        upcomingRate = `${Number(rows[0].rate)} ${String(rows[0].currency).trim()} from ${new Date(rows[0].valid_from)
          .toISOString()
          .slice(0, 16)
          .replace("T", " ")} UTC`;
    }
    // Straight to one vendor: priced below, once its egress translation gives the sender it receives.
    let forcedVendor: RouteSimulatorResult["forcedVendor"] = null;
    if (b.vendorTrunkId) {
      const { rows: vt } = await pool.query("SELECT id, name FROM vendor_trunks WHERE id = $1 AND deleted_at IS NULL", [
        b.vendorTrunkId,
      ]);
      if (!vt[0]) return badInput(reply, [{ path: "/vendorTrunkId", message: "unknown vendor trunk" }]);
      forcedVendor = { vendorTrunkId: Number(vt[0].id), name: vt[0].name, rate: null, currency: null, platformRate: null };
    }
    const d = route.decision;
    // Egress translation (§6.4, §13.2): the chosen vendor trunk's rules run after routing, on the
    // message as ingress translation left it; shows what the vendor would receive.
    const egressId = forcedVendor ? forcedVendor.vendorTrunkId : (d?.vendor?.vendorTrunkId ?? null);
    const egressName = forcedVendor ? forcedVendor.name : (d?.vendor?.name ?? "");
    const view =
      egressId !== null && !translation.blocked
        ? await vendorView(pool, egressId, afterIngress, sent, ingress.pinned)
        : null;
    const egress = view?.egress ?? null;
    const vendorTranslation: RouteSimulatorResult["vendorTranslation"] =
      egress && egressId !== null ? { vendorTrunkId: egressId, vendorTrunk: egressName, result: egress } : null;
    // The vendor's cost as the switch prices it: its Sender ID lines match the sender it receives after its egress
    // translation (§6.2, decided 2026-10-30) and its auto TON / NPI (S-4.7); a blocked line means it takes no traffic
    // there.
    const vendorPriced =
      egressId !== null && m.mccmnc && !egress?.blocked
        ? await vendorPrice(pool, egressId, m.mccmnc, view?.got.sender ?? sender)
        : null;
    const vp = priced(vendorPriced);
    if (forcedVendor && vp)
      forcedVendor = { ...forcedVendor, rate: vp.rate, currency: vp.currency, platformRate: vp.platformRate };
    const cost = vp?.platformRate ?? null;
    const vendorCost = cost === null ? null : { rate: cost, currency: PLATFORM_CURRENCY };
    const sell = customerRate?.platformRate ?? null;
    const marginPct = sell && cost !== null ? Math.round(((sell - cost) / sell) * 1000) / 10 : null;
    const blocked = translation.blocked
      ? "Blocked by a translation rule on the trunk"
      : !m.mccmnc
        ? "Unknown destination: no dial code matches the number"
        : customerBlocked
          ? "The customer's rate for the destination is blocked (ESME_RINVDSTADR)"
          : !customerRate
            ? upcomingRate
              ? `No customer rate yet: ${upcomingRate} (scheduled; ESME_RINVDSTADR until then)`
              : "No customer rate for the destination (ESME_RINVDSTADR)"
            : forcedVendor
              ? vendorPriced === "blocked"
                ? `${forcedVendor.name}'s rate for the destination is blocked`
                : forcedVendor.rate === null
                  ? `${forcedVendor.name} has no rate for the destination`
                  : null
              : senderOnly && (!d || d.outcome === "no_vendor")
                ? "Every vendor that could take the message refuses its sender (Refuse invalid senders); the switch refuses it at once (0x0A)"
                : !d
                ? "No route rule matches"
                : d.outcome === "block"
                  ? `Blocked by route rule ${d.ruleId}`
                  : d.outcome === "no_vendor"
                    ? `Route rule ${d.ruleId} matched but no vendor can take the message; the switch refuses it at once (0x45)`
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
