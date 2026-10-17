/**
 * Finance documents (spec §7, §13.31, §13.33): monthly customer invoices with a
 * running balance, payments and other transactions, and partner (vendor)
 * invoices with reconciliation status. Amounts follow each enterprise's traffic
 * size; they are synthetic and not summed from the generated EDRs.
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
        const opening = balance;
        const closing = money(opening + usage);
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
        await sink.insert("invoices", {
          id,
          invoice_number: number,
          enterprise_id: e.id,
          invoice_type: rng.chance(0.9) ? "auto" : "manual",
          billing_type: e.customerBillingType ?? "postpaid",
          currency: ccy,
          invoice_date: ymd(m),
          usage_start: ymd(usageStart),
          usage_end: ymd(usageEnd),
          due_date: ymd(new Date(m.getTime() + net * DAY)),
          opening_balance: opening,
          usage_charges: usage,
          closing_balance: closing,
          due_amount: closing > 0 ? closing : 0,
          message_count: msgs,
          status,
          payment_status: paid ? "paid" : partial ? "partial" : "unpaid",
          email_status: status === "completed" && rng.chance(0.95) ? "sent" : "unsent",
          remarks: null,
          created_by_id: rng.pick(billing).id,
          inserted_at: m,
          updated_at: m,
          deleted_at: null,
        });
        balance = closing;
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
        const recon = match
          ? latest && rng.chance(0.5)
            ? "match"
            : "accepted"
          : latest
            ? rng.pick(["mismatch", "pending"])
            : rng.pick(["accepted", "rejected", "pending"]);
        const invDate = new Date(m.getTime() + rng.int(1, 6) * DAY);
        if (invDate.getTime() > world.anchor) continue;
        await sink.insert("vendor_invoices", {
          id: viId++,
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
          timezone: "UTC",
          recon_status: recon,
          remarks: match ? null : `Difference ${(off * 100).toFixed(1)}%`,
          created_by_id: rng.pick(billing).id,
          inserted_at: invDate,
          updated_at: invDate,
          deleted_at: null,
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
