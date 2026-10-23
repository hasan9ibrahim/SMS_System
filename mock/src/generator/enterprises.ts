/**
 * Enterprises with contacts, billing, beneficiaries and AM history (spec §5.1–5.3,
 * §13.30), then vendor and customer trunks (spec §5.4, §5.5, §13.1, §13.26).
 */
import { CATEGORIES } from "./reference.js";
import { WeightedPicker, type Rng } from "./rng.js";
import {
  aliasOf,
  city,
  companyName,
  domainOf,
  fakeSecret,
  personName,
  phone,
  privateIp,
  senderId,
  street,
  syllableWord,
  testNetIp,
} from "./names.js";
import type { TableSink } from "./sink.js";
import {
  DAY,
  type CustomerTrunk,
  type Enterprise,
  type EnterpriseType,
  type VendorTrunk,
  type World,
} from "./world.js";
import type { Profile } from "./profiles.js";
import { usersOf } from "./admin.js";

const TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "America/New_York",
  "Africa/Lagos",
  "Europe/Istanbul",
  "America/Sao_Paulo",
];
const DIRECT_CATEGORIES = ["DIRECT", "LOCAL"];
const WHOLESALE_CATEGORIES = ["HQ", "WHS", "SIM", "SS7", "PROMO", "OTP", "H-CR"];

export async function generateEnterprises(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const am = world.accountManagers;
  const editors = usersOf(world, "Sales", "Billing", "Admin");
  const countryPicker = new WeightedPicker(
    world.countries,
    world.countries.map((c) => c.weight),
  );
  const names = new Set<string>();
  const ranks = rng.shuffle(Array.from({ length: profile.enterprises }, (_, i) => i + 1));

  let contactId = 1;
  let amHistId = 1;
  let billingId = 1;
  for (let i = 0; i < profile.enterprises; i++) {
    const id = i + 1;
    let name = companyName(rng);
    while (names.has(name.split(" ")[0]!)) name = companyName(rng);
    names.add(name.split(" ")[0]!);
    const type: EnterpriseType = rng.weighted(["customer", "vendor", "reciprocal"] as const, [55, 25, 20]);
    const tier = rng.weighted(["tier1", "tier2", "tier3"] as const, [15, 45, 40]);
    const country = countryPicker.pick(rng);
    const size = 1 / Math.pow(ranks[i]!, 1.1);
    const insertedAt = world.anchor - rng.int(20, 3 * 365) * DAY - rng.int(0, DAY);
    const deletedAt = rng.chance(0.03) ? world.anchor - rng.int(1, 60) * DAY : null;
    const status = deletedAt || rng.chance(0.05) ? "inactive" : "active";

    // AM history: most keep one AM; some were handed over, a few have a scheduled handover.
    const amHistory: Enterprise["amHistory"] = [];
    let start = insertedAt;
    let current = rng.pick(am).id;
    const handovers = rng.weighted([0, 1, 2], [70, 22, 8]);
    const from = Math.max(insertedAt, world.historyStart);
    const cuts = Array.from({ length: handovers }, () => rng.int(from + DAY, world.anchor - 5 * DAY))
      .filter((t) => t > start)
      .sort((a, b) => a - b);
    if (rng.chance(0.02)) cuts.push(world.anchor + rng.int(3, 20) * DAY); // scheduled (§13.30)
    for (const cut of cuts) {
      const at = Math.floor(cut / DAY) * DAY; // handovers start at midnight UTC
      if (at <= start) continue;
      amHistory.push({ userId: current, start, end: at });
      start = at;
      let next = rng.pick(am).id;
      while (am.length > 1 && next === current) next = rng.pick(am).id;
      current = next;
    }
    amHistory.push({ userId: current, start, end: Infinity });

    const isCustomer = type !== "vendor";
    const isVendor = type !== "customer";
    const ccy = () => rng.weighted(["USD", "EUR", "GBP", "AED", "INR"], [65, 25, 5, 3, 2]);
    const customerCurrency = isCustomer ? ccy() : null;
    const vendorCurrency = isVendor ? (customerCurrency && rng.chance(0.8) ? customerCurrency : ccy()) : null;
    const e: Enterprise = {
      id,
      businessCompanyId: rng.weighted(
        world.businessCompanies.map((b) => b.id),
        world.businessCompanies.map((_, k) => (k === 0 ? 3 : 1)),
      ),
      name,
      alias: aliasOf(name),
      domain: domainOf(name),
      type,
      tier,
      status,
      countryId: country.id,
      insertedAt,
      deletedAt,
      amHistory,
      size,
      customerCurrency,
      vendorCurrency,
      customerBillingType: isCustomer ? (rng.chance(0.25) ? "prepaid" : "postpaid") : null,
      billingTimezone: "UTC",
    };
    world.enterprises.push(e);
    world.enterpriseById.set(id, e);

    const currentAm = amHistory.find((p) => p.start <= world.anchor && world.anchor < p.end)!.userId;
    const editor = rng.pick(editors).id;
    await sink.insert("enterprises", {
      id,
      business_company_id: e.businessCompanyId,
      name,
      alias: e.alias,
      type,
      tier,
      status,
      account_manager_id: currentAm,
      bind_alert: rng.chance(0.8),
      credit_alert: rng.chance(0.7),
      credit_alert_notice: 50,
      credit_alert_warning: 70,
      credit_alert_critical: 90,
      address_line1: street(rng),
      address_line2: rng.chance(0.3) ? `Floor ${rng.int(1, 30)}` : null,
      city: city(rng),
      state: null,
      country_id: country.id,
      zip: rng.digits(5),
      website: `https://www.${e.domain}`,
      registration_number: `REG-${rng.digits(8)}`,
      vat_number: rng.chance(0.7) ? `${country.iso}${rng.digits(9)}` : null,
      // Our account number for clients (team trial round 4); from the id, so the random sequence stays the same.
      account_number: type === "vendor" || id % 5 === 0 ? null : `ACC-${String(100000 + id)}`,
      billing_timezone: (e.billingTimezone = rng.pick(TIMEZONES)),
      rate_notice_days: rng.pick([0, 3, 7, 7, 7, 14, 30]),
      created_by_id: editor,
      updated_by_id: rng.pick(editors).id,
      inserted_at: new Date(insertedAt),
      updated_at: new Date(Math.min(world.anchor, insertedAt + rng.int(0, 400) * DAY)),
      deleted_at: deletedAt ? new Date(deletedAt) : null,
      deleted_by_id: deletedAt ? editor : null,
    });

    for (const ct of ["commercial", "technical", "rates", "finance"]) {
      const p = personName(rng);
      const emails = [`${ct}@${e.domain}`];
      if (rng.chance(0.3)) emails.push(`${p.first.toLowerCase()}.${p.last.toLowerCase()}@${e.domain}`);
      await sink.insert("enterprise_contacts", {
        id: contactId++,
        enterprise_id: id,
        contact_type: ct,
        name: `${p.first} ${p.last}`,
        phone: phone(rng, country.dialCode),
        emails,
      });
    }

    for (const p of amHistory) {
      await sink.insert("enterprise_am_history", {
        id: amHistId++,
        enterprise_id: id,
        user_id: p.userId,
        starts_at: new Date(p.start),
        ends_at: Number.isFinite(p.end) ? new Date(p.end) : null,
        note:
          p.start === insertedAt ? "Initial assignment" : p.start > world.anchor ? "Scheduled handover" : "Handover",
        created_by_id: editor,
      });
    }

    for (const side of ["customer", "vendor"] as const) {
      const currency = side === "customer" ? customerCurrency : vendorCurrency;
      if (!currency) continue;
      const prepaid = side === "customer" && e.customerBillingType === "prepaid";
      await sink.insert("enterprise_billing", {
        id: billingId++,
        enterprise_id: id,
        side,
        currency,
        billing_cycle_id: prepaid
          ? rng.pick([1, 2])
          : rng.weighted([3, 5, 6, 7, 8, 9, 10, 12], [10, 6, 15, 10, 20, 10, 6, 5]),
        timezone: rng.pick(TIMEZONES),
        billing_type: side === "customer" ? e.customerBillingType : null,
        credit_limit: side === "customer" && !prepaid ? Math.round(rng.logNormal(5000, 1) / 100) * 100 : null,
        // Balance sign (decided 2026-10-17): positive = the partner's credit.
        opening_balance: -Math.round(rng.float(-2000, 2000) * 100) / 100,
        auto_invoicing: side === "customer" && rng.chance(0.7),
        send_payment_confirmation: rng.chance(0.4),
        description: null,
        updated_by_id: rng.pick(editors).id,
      });
    }

    await sink.insert("enterprise_beneficiaries", {
      id,
      enterprise_id: id,
      beneficiary_name: name,
      address: street(rng),
      bank: `${syllableWord(rng)} Bank`,
      bank_address: city(rng),
      currency: customerCurrency ?? vendorCurrency,
      account_number: rng.digits(12),
      iban: `${country.iso}00TEST${rng.digits(14)}`,
      swift: `TEST${country.iso}${rng.digits(2)}`,
      wallet_address: rng.chance(0.05) ? `0xFAKE${rng.hex(36)}` : null,
    });
  }

  await generateTrunks(world, rng, sink);
}

async function generateTrunks(world: World, rng: Rng, sink: TableSink): Promise<void> {
  const noc = usersOf(world, "NOC");
  const catId = (name: string) => world.categories.find((c) => c.name === name)!.id;
  const usable = CATEGORIES.filter((c) => c.weight > 0);
  const categoryPicker = new WeightedPicker(
    usable.map((c) => c.name),
    usable.map((c) => c.weight),
  );
  const countryPicker = new WeightedPicker(
    world.countries,
    world.countries.map((c) => c.weight),
  );
  const usernames = new Set<string>();
  const trunkNames = new Set<string>();
  const uniqueName = (base: string) => {
    let n = base;
    for (let k = 2; trunkNames.has(n); k++) n = `${base}_${k}`;
    trunkNames.add(n);
    return n;
  };
  const uniqueUser = (base: string) => {
    let u = base.slice(0, 14);
    for (let k = 2; usernames.has(u); k++) u = `${base.slice(0, 12)}${k}`;
    usernames.add(u);
    return u;
  };

  // Vendor trunks first: customer trunks may pin an express vendor.
  let vtId = 1;
  for (const e of world.enterprises) {
    if (e.type === "customer") continue;
    const n = rng.weighted([1, 2, 3], [55, 30, 15]);
    for (let k = 0; k < n; k++) {
      const isDirect = rng.chance(0.35);
      const cat = isDirect ? rng.pick(DIRECT_CATEGORIES) : rng.pick(WHOLESALE_CATEGORIES);
      const tierBoost = e.tier === "tier1" ? 0.04 : e.tier === "tier3" ? -0.05 : 0;
      const quality = isDirect
        ? {
            asr: rng.float(0.97, 0.995),
            dlr: Math.min(0.99, rng.float(0.86, 0.97) + tierBoost),
            delayMedianS: rng.float(1.5, 5),
          }
        : {
            asr: rng.float(0.9, 0.99),
            dlr: Math.min(0.97, Math.max(0.35, rng.float(0.55, 0.93) + tierBoost)),
            delayMedianS: rng.float(3, 20),
          };
      const deletedAt = e.deletedAt ?? (rng.chance(0.03) ? world.anchor - rng.int(1, 90) * DAY : null);
      const insertedAt = e.insertedAt + rng.int(0, 60) * DAY;
      const v: VendorTrunk = {
        id: vtId++,
        enterpriseId: e.id,
        name: uniqueName(`${e.alias}_${cat}`),
        categoryId: catId(cat),
        billingType: rng.weighted(["submit", "delivery", "attempt", "reported"] as const, [55, 30, 5, 10]),
        host: testNetIp(rng),
        port: rng.pick([2775, 2775, 2776, 2779, 8775]),
        tps: Math.max(10, Math.round(rng.logNormal(isDirect ? 100 : 300, 0.8) / 10) * 10),
        msgIdType: rng.weighted(["default", "decimal", "hexadecimal"] as const, [60, 20, 20]),
        rerouteOn: rng.chance(0.6)
          ? rng.sample(["EXPIRED", "DELETED", "UNDELIV", "UNKNOWN", "REJECTD"], rng.int(1, 4))
          : [],
        status: deletedAt || e.status === "inactive" || rng.chance(0.05) ? "inactive" : "active",
        insertedAt: Math.min(insertedAt, world.anchor - DAY),
        deletedAt,
        rateTableId: 0,
        quality,
        isDirect,
        translationRuleIds: [],
      };
      world.vendorTrunks.push(v);
      world.vendorTrunkById.set(v.id, v);
      const editor = rng.pick(noc).id;
      const costLimit = rng.chance(0.1) ? Math.round(rng.logNormal(2000, 0.7)) : null;
      const protocol = rng.chance(0.9) ? "smpp" : "http";
      // HTTP adapter settings (§5.5) on a reserved .example domain; derived from the id
      // so the random sequence (and the rest of the data) stays the same.
      const http = protocol === "http";
      await sink.insert("vendor_trunks", {
        id: v.id,
        enterprise_id: e.id,
        name: v.name,
        protocol,
        product_category_id: v.categoryId,
        billing_type: v.billingType,
        status: v.status,
        bind_type: rng.weighted(["TR", "TX", "RX"], [80, 15, 5]),
        username: uniqueUser(`wii${e.alias.toLowerCase()}`),
        password: fakeSecret(rng, 8),
        host: v.host,
        port: v.port,
        source_host: privateIp(rng),
        max_connections: rng.int(1, 6),
        system_type: rng.chance(0.3) ? "SMPP" : null,
        service_type: null,
        ssl_type: rng.weighted(["none", "tls1.2", "tls1.3"], [70, 25, 5]),
        submit_interval_ms: rng.pick([0, 0, 0, 10, 50]),
        submit_timeout_s: rng.pick([15, 30, 60]),
        enquire_link_timeout_s: rng.pick([15, 30, 60]),
        msg_id_type: v.msgIdType,
        http_url: http ? `https://api.${e.alias.toLowerCase()}.example/sms/send` : null,
        http_receiver_port: http ? 8080 + (v.id % 20) : null,
        http_success_regex: http ? '"status"\\s*:\\s*"(ok|accepted)"' : null,
        http_message_id_regex: http ? '"message_id"\\s*:\\s*"([^"]+)"' : null,
        http_callback_url: http ? `https://dlr.${e.alias.toLowerCase()}.example/status` : null,
        http_callback_interval_s: http ? 60 : null,
        http_dlr_status_regex: http ? "status=([A-Z]+)" : null,
        http_dlr_mid_regex: http ? "id=([0-9a-f-]+)" : null,
        http_dlr_success_stats: http ? "DELIVRD,DELIVERED" : null,
        http_dlr_fail_stats: http ? "UNDELIV,REJECTD,EXPIRED,FAILED" : null,
        http_extra_headers: http ? "Content-Type: application/json" : null,
        http_post_data: http ? '{"to":"{dst}","from":"{src}","text":"{text}"}' : null,
        http_callback_extra_headers: null,
        http_callback_post_data: null,
        tps: v.tps,
        overflow_buffer: rng.pick([0, 1000, 5000, 10000]),
        window_size: rng.pick([1, 5, 10, 20, 50]),
        // null = Any (the default for a new trunk); some vendors keep a restricted list (§5.5). Same number of
        // random draws as before, so the rest of the seeded world does not shift.
        allowed_data_codings: rng.chance(0.8) ? null : [0, 3, 8],
        reroute_on: v.rerouteOn,
        allowed_src_ton: v.id % 5 === 0 ? [0, 1, 2, 5] : null,
        allowed_dst_ton: [1],
        allowed_src_npi: v.id % 5 === 0 ? [0, 1] : null,
        allowed_dst_npi: [1],
        max_msg_len: rng.pick([null, null, 160, 153]),
        support_multipart: rng.chance(0.9),
        dlr_timeout_s: rng.pick([3600, 86400, 172800]),
        dlr_timeout_stat: rng.weighted(["UNKNOWN", "EXPIRED", "DELIVRD"], [70, 25, 5]),
        bind_addr_ton: 0,
        bind_addr_npi: 0,
        bind_addr_range: null,
        cost_limit: costLimit,
        cost_limit_period: costLimit ? rng.pick(["day", "week", "month"]) : null,
        created_by_id: editor,
        updated_by_id: rng.pick(noc).id,
        inserted_at: new Date(v.insertedAt),
        updated_at: new Date(Math.min(world.anchor, v.insertedAt + rng.int(0, 300) * DAY)),
        deleted_at: deletedAt ? new Date(deletedAt) : null,
        deleted_by_id: deletedAt ? editor : null,
      });
    }
  }

  let ctId = 1;
  for (const e of world.enterprises) {
    if (e.type === "vendor") continue;
    const n = rng.weighted([1, 2, 3, 4], [50, 30, 13, 7]);
    const homeCountry = world.countryById.get(e.countryId)!;
    for (let k = 0; k < n; k++) {
      const cat = categoryPicker.pick(rng);
      const deletedAt = e.deletedAt ?? (rng.chance(0.03) ? world.anchor - rng.int(1, 90) * DAY : null);
      const insertedAt = Math.min(e.insertedAt + rng.int(0, 120) * DAY, world.anchor - DAY);
      const focus = new Set<number>([homeCountry.id]);
      const nFocus = rng.int(3, 15);
      while (focus.size < nFocus) focus.add(countryPicker.pick(rng).id);
      const t: CustomerTrunk = {
        id: ctId++,
        enterpriseId: e.id,
        name: uniqueName(`${e.alias}_${cat}`.replace(/[^A-Za-z0-9_-]/g, "")),
        username: uniqueUser(e.alias.toLowerCase() + (k ? String(k + 1) : "")),
        categoryId: catId(cat),
        protocol: rng.chance(0.9) ? "smpp" : "http",
        billingType: rng.weighted(["submit", "delivery", "attempt", "reported"] as const, [45, 30, 15, 10]),
        bindType: rng.weighted(["TR", "TX", "AUTO"] as const, [60, 10, 30]),
        hostIps: Array.from({ length: rng.weighted([1, 2, 3], [60, 30, 10]) }, () =>
          rng.chance(0.6) ? testNetIp(rng) : privateIp(rng),
        ),
        port: rng.pick([2775, 2775, 2776, 3700]),
        tps: Math.min(3000, Math.max(5, Math.round(rng.logNormal(50, 1) / 5) * 5)),
        status: deletedAt || e.status === "inactive" || rng.chance(0.06) ? "inactive" : "active",
        insertedAt,
        deletedAt,
        rateTableIds: [],
        senders: Array.from({ length: rng.int(3, 25) }, () => senderId(rng, homeCountry.dialCode)),
        share: rng.float(0.2, 1),
        focusCountryIds: [...focus],
        hlrRules: [],
        translationRuleIds: [],
        otp: cat === "OTP" || rng.chance(0.4),
      };
      t.hostIps = [...new Set(t.hostIps)];
      world.customerTrunks.push(t);
      world.customerTrunkById.set(t.id, t);
      const editor = rng.pick(noc).id;
      const express = rng.chance(0.03) ? rng.pick(world.vendorTrunks) : null;
      const revLimit = rng.chance(0.12);
      await sink.insert("customer_trunks", {
        id: t.id,
        enterprise_id: e.id,
        name: t.name,
        protocol: t.protocol,
        product_category_id: t.categoryId,
        billing_type: t.billingType,
        status: t.status,
        bind_type: t.bindType,
        consider_hlr_rate: rng.chance(0.15),
        service_type_routing: rng.chance(0.05),
        part_wise_routing: rng.chance(0.05),
        host_ips: t.hostIps,
        username: t.username,
        password: fakeSecret(rng, 8),
        max_connections: rng.int(1, 6),
        system_type: rng.chance(0.2) ? "SMPP" : null,
        port: t.port,
        ssl_type: rng.weighted(["none", "tls1.2", "tls1.3"], [70, 25, 5]),
        dlr_push_url: t.protocol === "http" ? `https://api.${e.domain}/dlr` : null,
        mo_push_url: t.protocol === "http" && rng.chance(0.3) ? `https://api.${e.domain}/mo` : null,
        delayed_submit: rng.chance(0.1),
        send_bind: rng.chance(0.2),
        dlr_session_affinity: rng.weighted(["strict", "same_ip", "same_trunk"], [60, 25, 15]),
        dlr_hold_hours: rng.pick([24, 48, 72, 72]),
        tps: t.tps,
        overflow_buffer: rng.pick([0, 1000, 5000, 10000]),
        loop_detection: rng.chance(0.9),
        default_coding: rng.chance(0.85) ? 0 : 3,
        express_vendor_trunk_id: express?.id ?? null,
        express_margin: express ? Number(rng.float(0.0005, 0.005).toFixed(6)) : null,
        revenue_limit: revLimit ? Math.round(rng.logNormal(3000, 0.8)) : null,
        revenue_limit_period: revLimit ? rng.pick(["day", "week", "month"]) : null,
        created_by_id: editor,
        updated_by_id: rng.pick(noc).id,
        inserted_at: new Date(insertedAt),
        updated_at: new Date(Math.min(world.anchor, insertedAt + rng.int(0, 300) * DAY)),
        deleted_at: deletedAt ? new Date(deletedAt) : null,
        deleted_by_id: deletedAt ? editor : null,
      });
    }
  }
}
