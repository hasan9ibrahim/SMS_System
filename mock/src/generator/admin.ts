/**
 * Admin data: business companies, departments, access groups, users and account
 * managers (spec §11, §12.5), with password age and 2FA state (spec §13.28).
 */
import type { Rng } from "./rng.js";
import { companyName, domainOf, fakeSecret, personName, phone, street, city } from "./names.js";
import { json, type TableSink } from "./sink.js";
import { DAY, type User, type World } from "./world.js";
import type { Profile } from "./profiles.js";
import { encryptSecret, hashPassword } from "../admin/passwords.js";

/** Every seeded staff and portal user signs in with this fake password (CLAUDE.md rule 1). */
export const SEED_PASSWORD = "demo-password-2026";
/** The demo admin's fake TOTP secret, so 2FA can be tried with any authenticator app. */
export const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

// NOC and Support are one department (team trial round 1, 2026-10-18).
export const DEPARTMENTS = ["Management", "Sales", "NOC", "Rates", "Billing", "Admin"];

// Permission keys are page keys of the menu (admin/catalog.ts, §11).
export const ACCESS_GROUPS: { name: string; description: string; permissions: Record<string, string[]> }[] = [
  {
    name: "Administrator",
    description: "Every page and button",
    permissions: {
      "*": [
        "view",
        "add",
        "edit",
        "delete",
        "export",
        "import",
        "send",
        "approve",
        "start_stop",
        "change_password",
        "undo_others",
        "export_credentials",
      ],
    },
  },
  {
    name: "Department Manager",
    description: "Every page except credential exports; can undo the team's changes",
    permissions: { "*": ["view", "add", "edit", "export", "send", "approve", "undo_others"] },
  },
  {
    name: "Account Manager",
    description: "Own enterprises, rates and reports (§13.17 masking applies)",
    permissions: {
      dashboard: ["view"],
      enterprises: ["view", "edit"],
      "customer-trunks": ["view", "send"],
      "rate-manager": ["view", "edit", "export", "send"],
      "market-moves": ["view", "export"],
      "rate-lookup": ["view", "export"],
      "margin-calculator": ["view", "add", "edit", "delete", "export"],
      "master-report": ["view", "export"],
      "enterprise-report": ["view", "export"],
      "sales-report": ["view", "export"],
    },
  },
  {
    name: "NOC Engineer",
    description: "Routing, switch rules, monitoring",
    permissions: {
      dashboard: ["view"],
      "live-analytics": ["view"],
      "route-rules": ["view", "add", "edit"],
      "translation-rules": ["view", "add", "edit"],
      hlr: ["view", "add", "edit"],
      "edr-search": ["view", "export", "send"],
      "network-status": ["view", "start_stop"],
      signaling: ["view", "add", "export"],
      "noc-report": ["view", "export"],
      "traffic-alerts": ["view", "add", "edit"],
    },
  },
  {
    name: "Rates Analyst",
    description: "Rate tables, LCR, route rules",
    permissions: {
      "rate-manager": ["view", "add", "edit", "export", "import", "send"],
      "incoming-rns": ["view", "edit", "import"],
      "route-rules": ["view", "edit"],
      lcr: ["view", "add", "export"],
      mccmnc: ["view", "export"],
    },
  },
  {
    name: "Finance",
    description: "Transactions, invoices, statements",
    permissions: {
      transactions: ["view", "add", "edit", "export"],
      invoices: ["view", "add", "export", "send"],
      "vendor-invoices": ["view", "add", "edit", "export", "send"],
      soa: ["view", "export", "send"],
      balances: ["view", "export"],
      "billing-report": ["view", "export"],
    },
  },
  { name: "Read Only", description: "View every page", permissions: { "*": ["view"] } },
];

const DEPT_GROUP: Record<string, string> = {
  Management: "Department Manager",
  Sales: "Account Manager",
  NOC: "NOC Engineer",
  Rates: "Rates Analyst",
  Billing: "Finance",
  Admin: "Administrator",
};

export async function generateAdmin(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  // Rows are kept until the end: the §11 / §13.28 columns added in step 5.11 draw from their own stream
  // after every original draw, so the original values are unchanged for the same seed.
  const companies: Record<string, unknown>[] = [];
  const userRows: Record<string, unknown>[] = [];
  const baseCurrencies = ["USD", "EUR", "USD"];
  for (let i = 0; i < profile.businessCompanies; i++) {
    const name = companyName(rng).replace(/ (Ltd|LLC|FZE|GmbH|SA|Pte Ltd|BV|Inc|SRL|AB|Oy|DMCC)$/, "") + " Group";
    const bc = { id: i + 1, name, baseCurrency: baseCurrencies[i % baseCurrencies.length]! };
    world.businessCompanies.push(bc);
    companies.push({
      id: bc.id,
      name: bc.name,
      description: `Fake business company ${i + 1} for the frontend phase`,
      base_currency: bc.baseCurrency,
      tps_limit: rng.pick([2000, 5000, 10000]),
      website: `https://www.${domainOf(name)}`,
      smpp_host: `smpp.${domainOf(name)}`,
      smpp_port: 2775,
      invoice_number_start: 1000 * (i + 1),
      address_line1: street(rng),
      city: city(rng),
      country_iso: rng.pick(["AE", "GB", "CY", "NL", "SG"]),
    });
  }

  for (const [i, g] of ACCESS_GROUPS.entries()) {
    await sink.insert("access_groups", {
      id: i + 1,
      name: g.name,
      status: "active",
      permissions: json(g.permissions),
      description: g.description,
    });
  }

  // Department sizes: Sales holds the account managers.
  const plan: string[] = [];
  plan.push("Admin", "Admin", "Admin");
  for (let i = 0; i < 4; i++) plan.push("Management"); // one manager per department
  // The slot of the former Support manager (NOC and Support merged) stays, as NOC staff, so the random
  // draws, and with them every generated name (user 1 is the demo admin Daniel Khoury), stay the same.
  plan.push("NOC");
  for (let i = 0; i < profile.accountManagers; i++) plan.push("Sales");
  const rest = ["NOC", "NOC", "NOC", "NOC", "Rates", "Rates", "Billing", "Billing", "Sales"];
  while (plan.length < profile.users) plan.push(rng.pick(rest));

  const usernames = new Set<string>();
  const managers = new Map<string, number>(); // department -> manager user id
  let amCount = 0;
  for (const [i, dept] of plan.entries()) {
    const deptId = DEPARTMENTS.indexOf(dept) + 1;
    const { first, last } = personName(rng);
    let username = `${first}.${last}`.toLowerCase();
    for (let n = 2; usernames.has(username); n++) username = `${first}.${last}${n}`.toLowerCase();
    usernames.add(username);
    const id = i + 1;
    const bc = world.businessCompanies[i % world.businessCompanies.length]!;
    const isAdmin = dept === "Admin";
    const isAm = dept === "Sales" && amCount < profile.accountManagers;
    if (isAm) amCount++;
    let managerId: number | null = null;
    let managedDept: string | null = null;
    if (dept === "Management") {
      managedDept = ["Sales", "NOC", "Rates", "Billing"][managers.size]!;
      managers.set(managedDept, id);
    } else {
      managerId = managers.get(dept) ?? null;
    }
    // Password age: most changed within 30 days; a few expired or expiring (§13.28).
    const ageDays = rng.chance(0.08) ? rng.int(31, 45) : rng.int(0, 29);
    const user: User = {
      id,
      username,
      first,
      last,
      departmentId: deptId,
      department: dept,
      businessCompanyId: bc.id,
      isAccountManager: isAm,
      isAdmin,
    };
    world.users.push(user);
    if (isAm) world.accountManagers.push(user);
    const deleted = !isAm && !isAdmin && rng.chance(0.03);
    userRows.push({
      id,
      username,
      first_name: first,
      last_name: last,
      email: `${username}@${domainOf(world.businessCompanies[0]!.name)}`,
      phone: phone(rng, "971"),
      department_id: managedDept ? DEPARTMENTS.indexOf("Management") + 1 : deptId,
      access_group_id:
        ACCESS_GROUPS.findIndex((g) => g.name === (managedDept ? "Department Manager" : DEPT_GROUP[dept])) + 1,
      business_company_id: bc.id,
      manager_id: managerId,
      user_type: rng.chance(0.03) ? "api" : "wholesale",
      is_account_manager: isAm,
      is_team_lead: isAm && amCount % 8 === 1,
      is_admin: isAdmin,
      status: deleted || rng.chance(0.04) ? "inactive" : "active",
      allow_multiple_login: rng.chance(0.2),
      password_hash: `$fake$${fakeSecret(rng, 32)}`,
      password_changed_at: new Date(world.anchor - ageDays * DAY - rng.int(0, DAY)),
      must_change_password: ageDays > 30,
      totp_enabled: rng.chance(0.85),
      theme: rng.chance(0.35) ? "dark" : "light",
      last_login_at: deleted ? null : new Date(world.anchor - rng.int(0, 10 * DAY)),
      deleted_at: deleted ? new Date(world.anchor - rng.int(5, 200) * DAY) : null,
      deleted_by_id: deleted ? 1 : null,
    });
  }
  await adminColumns(world, rng.fork("admin 5.11"), sink, companies, userRows, managers);
}

const COUNTRIES = ["AE", "GB", "CY", "NL", "SG"];

async function adminColumns(
  world: World,
  rng: Rng,
  sink: TableSink,
  companies: Record<string, unknown>[],
  userRows: Record<string, unknown>[],
  managers: Map<string, number>,
) {
  for (const [i, c] of companies.entries()) {
    const cc = c.country_iso as string;
    await sink.insert("business_companies", {
      ...c,
      address_line2: rng.chance(0.4) ? `Floor ${rng.int(2, 30)}` : null,
      state: rng.chance(0.5) ? city(rng) : null,
      zip: rng.digits(5),
      company_ip: `198.51.100.${10 + i}`, // TEST-NET-2, never routable
      customer_rate_file_name: "{company}_{trunk}_rates_{date}",
      bank_beneficiary_name: `${c.name as string} (fake)`,
      bank_beneficiary_address: `${c.address_line1 as string}, ${c.city as string}`,
      bank_name: `Fake ${companyName(rng).split(" ")[0]} Bank`,
      bank_address: `${street(rng)}, ${city(rng)}`,
      bank_currency: c.base_currency,
      bank_account_number: `FAKE${rng.digits(10)}`,
      bank_iban: `${cc}00FAKE${rng.digits(14)}`,
      bank_swift: `FAKE${cc}00`,
      default_templates: json({ invoice: 4, customerRate: 6, customerTechInfo: 7, soaStatement: 1 }),
      updated_by_id: 1,
    });
  }
  const managerOf: Record<string, number | null> = {
    Management: userRows.find((u) => u.department_id === DEPARTMENTS.indexOf("Management") + 1)?.id as number,
    Admin: 1,
  };
  for (const [i, name] of DEPARTMENTS.entries()) {
    await sink.insert("departments", {
      id: i + 1,
      name,
      status: "active",
      manager_id: managerOf[name] ?? managers.get(name) ?? null,
      description: `${name} department (fake)`,
      updated_by_id: 1,
    });
  }
  const salt = () => Buffer.from(rng.hex(32), "hex");
  for (const u of userRows) {
    const id = u.id as number;
    const temp = id > 3 && !u.deleted_at && rng.chance(0.03);
    const changed = u.password_changed_at as Date;
    await sink.insert("users", {
      ...u,
      password_hash: hashPassword(SEED_PASSWORD, salt()),
      must_change_password: (u.must_change_password as boolean) || temp,
      totp_enabled: id === 1 ? true : u.totp_enabled,
      otp_method: u.totp_enabled || id === 1 ? "authenticator" : rng.chance(0.05) ? "off" : "email",
      language: "en",
      address1: street(rng),
      address2: rng.chance(0.3) ? `Office ${rng.int(100, 999)}` : null,
      country_iso: rng.pick(COUNTRIES),
      state: null,
      city: city(rng),
      zip: rng.chance(0.6) ? rng.digits(5) : null,
      temp_password_expires_at: temp ? new Date(world.anchor + rng.int(1, 23) * 3600_000) : null,
      // Stored encrypted like the platform stores them (backend step 12); the IV follows the user so seeds repeat.
      totp_secret:
        id === 1 || u.totp_enabled
          ? encryptSecret(id === 1 ? DEMO_TOTP_SECRET : base32Fake(rng), Buffer.alloc(12, id % 256))
          : null,
      totp_pending_secret: null,
      updated_by_id: 1,
      password_changed_at: temp ? new Date(world.anchor - rng.int(1, 20) * 3600_000) : changed,
    });
  }
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Fake(rng: Rng): string {
  let s = "";
  for (let i = 0; i < 32; i++) s += B32[rng.int(0, 31)];
  return s;
}

/** Users of a department, for created_by / updated_by columns. */
export function usersOf(world: World, ...departments: string[]): User[] {
  const list = world.users.filter((u) => departments.includes(u.department));
  return list.length ? list : world.users;
}
