// System-to-system import (§13.22): turns the tables of a Migration export package into the import
// templates, with each record's old ID as its external ID so links survive. Opening balances carry
// each partner's opening balance plus payments and adjustments; traffic charges stay in the old EDRs.
import type { MigrationFileInput, MigrationImportEntity } from "@sms/contract";
import { csvObjects, csvTable, pgArray, toCsv } from "./csv.js";
import { ENTITY } from "./entities.js";

type Row = Record<string, string>;

export function packageFiles(frames: Map<string, string>): { files: MigrationFileInput[]; warnings: string[] } {
  const table = (name: string): Row[] => {
    const text = frames.get(`${name}.csv`);
    return text ? csvObjects(text).rows : [];
  };
  const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id!, r]));
  const departments = byId(table("departments"));
  const groups = byId(table("access_groups"));
  const companies = byId(table("business_companies"));
  const categories = byId(table("product_categories"));
  const countries = byId(table("countries"));
  const users = table("users");
  const usersById = byId(users);
  const enterprises = table("enterprises");
  const contacts = table("enterprise_contacts");
  const customerTrunks = table("customer_trunks");
  const vendorTrunks = table("vendor_trunks");
  const rateTables = table("rate_tables");
  const ctrt = table("customer_trunk_rate_tables");
  const routeRules = table("route_rules");
  const rrv = table("route_rule_vendors");
  const warnings: string[] = [];
  if (customerTrunks.length && !("username" in customerTrunks[0]!))
    warnings.push("The package has no credentials: trunks get placeholder connection details");

  const name = (m: Map<string, Row>, id: string | undefined) => (id ? (m.get(id)?.name ?? "") : "");
  const out: { entity: MigrationImportEntity; rows: Row[] }[] = [];

  // Team trial round 12: departments, product categories and number lists travel too (one row per list value).
  out.push({
    entity: "departments",
    rows: [...departments.values()]
      .filter((d) => !d.deleted_at)
      .map((d) => ({
        externalId: d.id!,
        name: d.name!,
        description: d.description ?? "",
        status: d.status ?? "active",
      })),
  });
  out.push({
    entity: "product_categories",
    rows: [...categories.values()].filter((c) => !c.deleted_at).map((c) => ({ externalId: c.id!, name: c.name! })),
  });
  const lists = byId(table("number_lists").filter((l) => !l.deleted_at));
  out.push({
    entity: "number_lists",
    rows: table("number_list_entries")
      .filter((e) => !e.deleted_at && lists.has(e.number_list_id!))
      .map((e) => {
        const l = lists.get(e.number_list_id!)!;
        return { name: l.name!, type: l.list_type!, value: e.value!, content: e.content ?? "" };
      }),
  });

  out.push({
    entity: "users",
    rows: users.map((u) => ({
      externalId: u.id!,
      username: u.username!,
      firstName: u.first_name!,
      lastName: u.last_name!,
      email: u.email!,
      department: name(departments, u.department_id),
      accessGroup: name(groups, u.access_group_id),
      isAccountManager: u.is_account_manager === "t" ? "yes" : "no",
      status: u.status!,
    })),
  });
  // Every contact type (team trial round 1), keyed "type:enterprise".
  const contactMap = new Map<string, string[]>();
  for (const c of contacts) {
    const k = `${c.contact_type}:${c.enterprise_id}`;
    contactMap.set(k, [...(contactMap.get(k) ?? []), ...pgArray(c.emails ?? "")]);
  }
  const emailsOf = (type: string, id: string) => (contactMap.get(`${type}:${id}`) ?? []).join(";");
  out.push({
    entity: "enterprises",
    rows: enterprises.map((e) => ({
      externalId: e.id!,
      name: e.name!,
      alias: e.alias ?? "",
      type: e.type!,
      tier: e.tier ?? "",
      status: e.status ?? "",
      businessCompany: name(companies, e.business_company_id),
      accountManager: e.account_manager_id ? (usersById.get(e.account_manager_id)?.id ?? "") : "",
      country: e.country_id ? (countries.get(e.country_id)?.iso ?? "") : "",
      vatNumber: e.vat_number ?? "",
      address: e.address_line1 ?? "",
      emails: emailsOf("commercial", e.id!),
      technicalEmails: emailsOf("technical", e.id!),
      ratesEmails: emailsOf("rates", e.id!),
      financeEmails: emailsOf("finance", e.id!),
    })),
  });
  const trunk = (t: Row) => ({
    externalId: t.id!,
    enterprise: t.enterprise_id!,
    name: t.name!,
    username: t.username ?? "",
    password: t.password ?? "",
    protocol: t.protocol ?? "",
    tps: t.tps ?? "",
    category: name(categories, t.product_category_id),
    billingType: t.billing_type ?? "",
  });
  out.push({
    entity: "customer_trunks",
    rows: customerTrunks.map((t) => ({ ...trunk(t), hostIps: pgArray(t.host_ips ?? "").join(";") })),
  });
  // Customer trunks carry no port (it follows the SSL type, migration 070); vendor trunks keep theirs.
  out.push({
    entity: "vendor_trunks",
    rows: vendorTrunks.map((t) => ({ ...trunk(t), host: t.host ?? "", port: t.port ?? "" })),
  });
  const sellers = new Map<string, string[]>();
  for (const l of ctrt) sellers.set(l.rate_table_id!, [...(sellers.get(l.rate_table_id!) ?? []), l.customer_trunk_id!]);
  out.push({
    entity: "rate_tables",
    rows: rateTables.map((t) => ({
      externalId: t.id!,
      name: t.name!,
      kind: t.kind!,
      currency: t.currency!,
      category: name(categories, t.product_category_id),
      vendorTrunk: t.vendor_trunk_id ?? "",
      customerTrunks: (sellers.get(t.id!) ?? []).join(";"),
    })),
  });
  // Rate lines can run to millions: kept as cell arrays, not objects.
  const lines = frames.has("rate_lines.csv") ? csvTable(frames.get("rate_lines.csv")!) : null;
  let lineFile: MigrationFileInput | null = null;
  if (lines?.rows.length) {
    const [t, m, s, r, f, b] = ["rate_table_id", "mccmnc", "sender_id", "rate", "valid_from", "is_blocked"].map(
      lines.col,
    );
    const fields = ENTITY.get("rate_lines")!.fields.map((x) => x.field);
    lineFile = {
      entity: "rate_lines",
      fileName: "rate_lines.csv (package)",
      content: toCsv([
        fields,
        ...lines.rows.map((c) => [c[t!], c[m!], c[s!], c[r!], c[f!], c[b!] === "t" ? "yes" : "no"]),
      ]),
      mappingId: null,
    };
  }
  const vendorsOf = new Map<string, string[]>();
  for (const v of rrv)
    vendorsOf.set(v.route_rule_id!, [
      ...(vendorsOf.get(v.route_rule_id!) ?? []),
      v.share_pct ? `${v.vendor_trunk_id}:${v.share_pct}` : v.vendor_trunk_id!,
    ]);
  out.push({
    entity: "route_rules",
    rows: routeRules
      .filter((r) => vendorsOf.has(r.id!))
      .map((r) => ({
        externalId: r.id!,
        name: r.name!,
        priority: r.priority!,
        status: r.status!,
        customerTrunks: pgArray(r.customer_trunk_ids ?? "").join(";"),
        destinations: pgArray(r.mccmncs ?? "").join(";"),
        vendors: (vendorsOf.get(r.id!) ?? []).join(";"),
      })),
  });
  const skippedRules = routeRules.length - routeRules.filter((r) => vendorsOf.has(r.id!)).length;
  if (skippedRules)
    warnings.push(`${skippedRules} route rules without vendors (block, dynamic or QBR) are not carried over`);

  const billing = table("enterprise_billing");
  const tx = table("transactions");
  if (billing.length) {
    const sums = new Map<string, { amount: number; currency: string }>();
    for (const b of billing)
      sums.set(`${b.enterprise_id}|${b.side}`, { amount: Number(b.opening_balance || 0), currency: b.currency! });
    for (const t of tx) {
      const k = `${t.enterprise_id}|${t.side}`;
      const s = sums.get(k);
      if (!s || t.currency !== s.currency) continue;
      s.amount += (t.payment_type === "credit" ? 1 : -1) * Number(t.amount || 0);
    }
    const today = new Date().toISOString().slice(0, 10);
    out.push({
      entity: "opening_balances",
      rows: [...sums.entries()]
        .filter(([, s]) => Math.abs(s.amount) >= 0.005)
        .map(([k, s]) => {
          const [enterprise, side] = k.split("|");
          return {
            enterprise: enterprise!,
            side: side!,
            amount: s.amount.toFixed(2),
            currency: s.currency,
            date: today,
          };
        }),
    });
    warnings.push("Opening balances cover payments and adjustments; traffic charges stay in the old platform's EDRs");
  }

  const files: MigrationFileInput[] = out
    .filter((o) => o.rows.length)
    .map((o) => {
      const fields = ENTITY.get(o.entity)!.fields.map((f) => f.field);
      return {
        entity: o.entity,
        fileName: `${o.entity}.csv (package)`,
        content: toCsv([fields, ...o.rows.map((r) => fields.map((f) => r[f] ?? ""))]),
        mappingId: null,
      };
    });
  if (lineFile) files.push(lineFile);
  return { files, warnings };
}
