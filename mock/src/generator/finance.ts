/**
 * Finance documents (spec §7, §13.31, §13.33): monthly customer invoices with a
 * running balance, payments and other transactions, and partner (vendor)
 * invoices with reconciliation status and history. Amounts follow each enterprise's
 * traffic size; they are synthetic and not summed from the generated EDRs. Balances
 * use the §7 sign: positive = the partner's credit, negative = owed.
 */
import type { Rng } from "./rng.js";
import type { TableSink } from "./sink.js";
import { usersOf } from "./admin.js";
import { fxPerUsd, DAY, toBase, type World } from "./world.js";
import type { Profile } from "./profiles.js";

/** Monthly revenue in USD of the biggest client; others scale by Zipf size. */
const TOP_MONTHLY_USD = 250_000;
const AVG_RATE_USD = 0.02;
const NET_DAYS: Record<number, number> = {
  1: 0,
  2: 0,
  3: 7,
  4: 0,
  5: 15,
  6: 0,
  7: 5,
  8: 7,
  9: 10,
  10: 15,
  11: 20,
  12: 30,
};

function monthStart(t: number, offset = 0): Date {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const money = (x: number) => Math.round(x * 100) / 100;

export async function generateFinance(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const billing = usersOf(world, "Billing");
  const seq = new Map<number, number>(world.businessCompanies.map((b) => [b.id, 1000 * b.id]));
  let invoiceId = 1;
  let txId = 1;
  let viId = 1;
  let eventId = 1;
  let ruleId = 2; // 1 = the default rule from migration 017
  const firstMonth = monthStart(world.anchor, -profile.historyMonths);
  const currentMonth = monthStart(world.anchor);
  const modes = [
    "bank_transfer",
    "wire_transfer",
    "bank_transfer",
    "paypal",
    "credit_card",
    "crypto",
    "cheque",
    "cash",
  ];

  for (const e of world.enterprises) {
    const start = monthStart(Math.max(e.insertedAt, firstMonth.getTime()), 1);
    const end = e.deletedAt ? monthStart(e.deletedAt, 1) : currentMonth;

    // ----- customer side: invoices and receipts -----
    if (e.customerCurrency) {
      const ccy = e.customerCurrency;
      const cycle = rng.pick([6, 7, 8, 9, 10, 12]);
      const net = NET_DAYS[cycle] ?? 0;
      let balance = money(rng.float(-1000, 1000));
      for (let m = new Date(start); m < end; m = monthStart(m.getTime(), 1)) {
        const usageStart = monthStart(m.getTime(), -1);
        const usageEnd = new Date(m.getTime() - DAY);
        const fx = fxPerUsd(world, ccy, m.getTime());
        const usd = TOP_MONTHLY_USD * e.size * rng.float(0.7, 1.3);
        const usage = money(usd * fx);
        const msgs = Math.round(usd / AVG_RATE_USD);
        // `balance` runs as the owed amount; invoices store it with the §7 sign.
        const opening = money(-balance);
        const closing = money(opening - usage);
        const ageMonths = (currentMonth.getTime() - m.getTime()) / (30 * DAY);
        const latest = ageMonths < 1;
        const failed = rng.chance(0.01);
        const status = failed ? "failed" : latest && rng.chance(0.03) ? "pending" : "completed";
        const paid = !latest && ageMonths >= 2 ? !rng.chance(0.05) : !latest && rng.chance(0.6);
        const partial = !paid && !latest && rng.chance(0.3);
        const bc = e.businessCompanyId;
        const number = `INV-${bc}-${seq.get(bc)!}`;
        seq.set(bc, seq.get(bc)! + 1);
        const id = invoiceId++;
        const invoiceType = rng.chance(0.9) ? "auto" : "manual";
        const emailStatus = status === "completed" && rng.chance(0.95) ? "sent" : "unsent";
        const creator = rng.pick(billing).id;
        await sink.insert("invoices", {
          id,
          invoice_number: number,
          enterprise_id: e.id,
          invoice_type: invoiceType,
          billing_type: e.customerBillingType ?? "postpaid",
          currency: ccy,
          invoice_date: ymd(m),
          usage_start: ymd(usageStart),
          usage_end: ymd(usageEnd),
          due_date: ymd(new Date(m.getTime() + net * DAY)),
          opening_balance: opening,
          usage_charges: usage,
          closing_balance: closing,
          due_amount: closing < 0 ? -closing : 0,
          message_count: msgs,
          status,
          payment_status: paid ? "paid" : partial ? "partial" : "unpaid",
          email_status: emailStatus,
          remarks: null,
          created_by_id: creator,
          inserted_at: m,
          updated_at: m,
          deleted_at: null,
          kind: "traffic",
          timezone: e.billingTimezone,
          email_sent_at: emailStatus === "sent" ? new Date(m.getTime() + 5 * 60_000) : null,
          email_recipients: emailStatus === "sent" ? [`billing@${e.domain}`] : [],
          updated_by_id: null,
        });
        // The request behind it (§12.3): auto runs start at about 00:01.
        await sink.insert("invoice_requests", {
          id,
          kind: "traffic",
          invoice_type: invoiceType,
          regenerate: false,
          enterprise_id: e.id,
          timezone: e.billingTimezone,
          usage_start: ymd(usageStart),
          usage_end: ymd(usageEnd),
          due_date_type: "auto",
          due_date: null,
          invoice_number: null,
          amount: null,
          volume: null,
          currency: null,
          invoice_date: ymd(m),
          remarks: null,
          status: status === "pending" ? "pending" : status,
          error: failed ? "Invoice format file could not be read" : null,
          invoice_id: id,
          started_at: status === "pending" ? null : new Date(m.getTime() + 60_000),
          finished_at: status === "pending" ? null : new Date(m.getTime() + 120_000),
          created_by_id: invoiceType === "manual" ? creator : null,
          inserted_at: new Date(m.getTime() + 60_000),
        });
        balance = -closing;
        if (paid || partial) {
          const amount = money(paid ? usage : usage * rng.float(0.3, 0.8));
          const payDate = new Date(m.getTime() + rng.int(Math.max(0, net - 5), net + 10) * DAY);
          if (payDate.getTime() <= world.anchor) {
            const confirm = rng.chance(0.4);
            await sink.insert("transactions", {
              id: txId++,
              enterprise_id: e.id,
              side: "customer",
              payment_mode: rng.pick(modes),
              payment_type: "credit",
              transaction_type: "receipt",
              amount,
              currency: ccy,
              ...toBase(world, e.id, amount, ccy, payDate.getTime()),
              payment_date: ymd(payDate),
              invoice_id: id,
              description: `Payment for ${number}`,
              send_confirmation: confirm,
              confirmation_status: confirm ? (rng.chance(0.97) ? "sent" : "failed") : "not_sent",
              include_in_soa: true,
              exclude_reason: null,
              created_by_id: rng.pick(billing).id,
              updated_by_id: rng.pick(billing).id,
              inserted_at: payDate,
              updated_at: payDate,
              deleted_at: null,
            });
            balance = money(balance - amount);
            if (rng.chance(0.25)) {
              // Bank charges: left off the SOA but still counted in the balance (§13.33).
              const fee = money(rng.float(5, 40));
              await sink.insert("transactions", {
                id: txId++,
                enterprise_id: e.id,
                side: "customer",
                payment_mode: "bank_transfer",
                payment_type: "debit",
                transaction_type: "bank_charges",
                amount: fee,
                currency: ccy,
                ...toBase(world, e.id, fee, ccy, payDate.getTime()),
                payment_date: ymd(payDate),
                invoice_id: id,
                description: "Incoming transfer fee",
                send_confirmation: false,
                confirmation_status: "not_sent",
                include_in_soa: false,
                exclude_reason: "Bank charges, internal only",
                created_by_id: rng.pick(billing).id,
                updated_by_id: rng.pick(billing).id,
                inserted_at: payDate,
                updated_at: payDate,
                deleted_at: null,
              });
              balance = money(balance + fee);
            }
          }
        }
        if (rng.chance(0.04)) {
          const amount = money(usage * rng.float(0.01, 0.05));
          const at = new Date(m.getTime() + rng.int(1, 25) * DAY);
          if (at.getTime() <= world.anchor) {
            await sink.insert("transactions", {
              id: txId++,
              enterprise_id: e.id,
              side: "customer",
              payment_mode: "bank_transfer",
              payment_type: "credit",
              transaction_type: rng.pick(["credit_note", "adjustment", "dispute"]),
              amount,
              currency: ccy,
              ...toBase(world, e.id, amount, ccy, at.getTime()),
              payment_date: ymd(at),
              invoice_id: id,
              description: "Agreed after dispute",
              send_confirmation: false,
              confirmation_status: "not_sent",
              include_in_soa: true,
              exclude_reason: null,
              created_by_id: rng.pick(billing).id,
              updated_by_id: rng.pick(billing).id,
              inserted_at: at,
              updated_at: at,
              deleted_at: null,
            });
            balance = money(balance - amount);
          }
        }
      }
    }

    // ----- vendor side: partner invoices and payments -----
    if (e.vendorCurrency) {
      const ccy = e.vendorCurrency;
      if (rng.chance(0.12)) {
        // Partners with their own reconciliation rule (§13.31); the rest use the default.
        const strict = rng.chance(0.5);
        await sink.insert("recon_rules", {
          id: ruleId++,
          enterprise_id: e.id,
          amount_pct: strict ? 0.5 : rng.pick([1, 2, 3]),
          amount_fixed: strict ? rng.pick([10, 25, 50]) : null,
          amount_combine: strict ? "stricter" : "looser",
          count_pct: rng.pick([0.5, 1, 2]),
          count_fixed: rng.chance(0.5) ? rng.pick([500, 1000, 5000]) : null,
          count_combine: "looser",
          destination_pct: rng.chance(0.4) ? rng.pick([5, 10, 20]) : null,
          auto_send: rng.chance(0.3) ? "confirm" : "auto",
          disputed_in_soa: rng.chance(0.3) ? "exclude" : "separate_block",
          updated_by_id: rng.pick(billing).id,
          inserted_at: new Date(e.insertedAt),
          updated_at: new Date(e.insertedAt),
          deleted_at: null,
        });
      }
      for (let m = new Date(start); m < end; m = monthStart(m.getTime(), 1)) {
        const fx = fxPerUsd(world, ccy, m.getTime());
        const usd = TOP_MONTHLY_USD * 0.8 * e.size * rng.float(0.7, 1.3);
        const our = money(usd * fx);
        const ourVol = Math.round(usd / (AVG_RATE_USD * 0.85));
        const off = rng.chance(0.85) ? rng.float(-0.005, 0.005) : rng.float(0.02, 0.1) * (rng.chance(0.8) ? 1 : -1);
        const theirs = money(our * (1 + off));
        const theirVol = Math.round(ourVol * (1 + off * rng.float(0.5, 1)));
        const match = Math.abs(off) <= 0.01;
        const latest = currentMonth.getTime() - m.getTime() < 30 * DAY;
        // §13.31: a match is accepted; a mismatch is disputed until rejected or accepted later.
        const recon = match ? "accepted" : latest ? "disputed" : rng.pick(["accepted", "rejected", "disputed"]);
        const waiting = match && latest && rng.chance(0.5); // "confirm before sending"
        const emailStatus = recon === "disputed" ? "none" : waiting ? "waiting" : "sent";
        const fromEmail = rng.chance(0.75);
        const invDate = new Date(m.getTime() + rng.int(1, 6) * DAY);
        if (invDate.getTime() > world.anchor) continue;
        const vid = viId++;
        const checkedAt = new Date(invDate.getTime() + 3 * 60_000);
        const diff = money(theirs - our);
        const reason = `Amount ${match ? "within" : "outside"} tolerance: ${diff.toFixed(2)} ${ccy}`;
        const decider = rng.pick(billing).id;
        await sink.insert("vendor_invoices", {
          id: vid,
          enterprise_id: e.id,
          invoice_number: `${e.alias.slice(0, 3)}-${m.getUTCFullYear()}${String(m.getUTCMonth() + 1).padStart(2, "0")}-${rng.digits(3)}`,
          currency: ccy,
          charge_volume: theirVol,
          charge_amount: theirs,
          our_volume: ourVol,
          our_amount: our,
          invoice_date: ymd(invDate),
          due_date: ymd(new Date(invDate.getTime() + 15 * DAY)),
          period_from: ymd(monthStart(m.getTime(), -1)),
          period_to: ymd(new Date(m.getTime() - DAY)),
          timezone: e.billingTimezone,
          recon_status: recon,
          remarks: match ? null : `Difference ${(off * 100).toFixed(1)}%`,
          created_by_id: decider,
          inserted_at: invDate,
          updated_at: invDate,
          deleted_at: null,
          comparison: match ? "match" : "mismatch",
          email_status: emailStatus,
          email_sent_at: emailStatus === "sent" ? new Date(invDate.getTime() + 2 * DAY + 10 * 60_000) : null,
          source: fromEmail ? "email" : "manual",
          checked_at: checkedAt,
          check_reasons: [reason],
          rule_snapshot: null,
          updated_by_id: null,
        });
        // History (§13.31): received or added, checked, decided, e-mailed.
        const event = (kind: string, at: Date, f: Record<string, unknown>) =>
          sink.insert("vendor_invoice_events", {
            id: eventId++,
            vendor_invoice_id: vid,
            kind,
            status_from: null,
            status_to: null,
            note: null,
            email_to: [],
            user_id: null,
            inserted_at: at,
            ...f,
          });
        await event("created", invDate, {
          note: fromEmail ? "Received at the billing mailbox" : "Added by hand",
          user_id: fromEmail ? null : decider,
        });
        await event("checked", checkedAt, { status_to: match ? "accepted" : "disputed", note: reason });
        if (!match && recon !== "disputed")
          await event("status", new Date(invDate.getTime() + 2 * DAY), {
            status_from: "disputed",
            status_to: recon,
            note:
              recon === "accepted" ? "Agreed after discussion" : "Difference above tolerance, our EDR summary attached",
            user_id: decider,
          });
        if (emailStatus === "sent")
          await event("email", new Date(invDate.getTime() + 2 * DAY + 10 * 60_000), {
            note: recon === "rejected" ? "Rejection sent" : "Acceptance sent",
            email_to: [`billing@${e.domain}`],
          });
        const payDate = new Date(invDate.getTime() + rng.int(10, 30) * DAY);
        if (recon === "accepted" && payDate.getTime() <= world.anchor) {
          await sink.insert("transactions", {
            id: txId++,
            enterprise_id: e.id,
            side: "vendor",
            payment_mode: rng.pick(modes),
            payment_type: "debit",
            transaction_type: "bill_payment",
            amount: theirs,
            currency: ccy,
            ...toBase(world, e.id, theirs, ccy, payDate.getTime()),
            payment_date: ymd(payDate),
            invoice_id: null,
            description: "Vendor invoice payment",
            send_confirmation: false,
            confirmation_status: "not_sent",
            include_in_soa: true,
            exclude_reason: null,
            created_by_id: rng.pick(billing).id,
            updated_by_id: rng.pick(billing).id,
            inserted_at: payDate,
            updated_at: payDate,
            deleted_at: null,
          });
        }
      }
    }
  }
}
