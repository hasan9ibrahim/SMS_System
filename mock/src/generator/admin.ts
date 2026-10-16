/**
 * Admin data: business companies, departments, access groups, users and account
 * managers (spec §11, §12.5), with password age and 2FA state (spec §13.28).
 */
import type { Rng } from "./rng.js";
import { companyName, domainOf, fakeSecret, personName, phone, street, city } from "./names.js";
import { json, type TableSink } from "./sink.js";
import { DAY, type User, type World } from "./world.js";
import type { Profile } from "./profiles.js";

export const DEPARTMENTS = ["Management", "Sales", "NOC", "Rates", "Billing", "Admin", "Support"];

const ACCESS_GROUPS: { name: string; permissions: Record<string, string[]> }[] = [
  {
    name: "Administrator",
    permissions: { "*": ["view", "add", "edit", "delete", "export", "import", "undo_others", "export_credentials"] },
  },
  {
    name: "Department Manager",
    permissions: { "*": ["view", "add", "edit", "export", "undo_others"], team: ["view"] },
  },
  {
    name: "Account Manager",
    permissions: {
      enterprise: ["view", "edit"],
      ratetable: ["view", "edit", "export"],
      report: ["view", "export"],
      ratelookup: ["view"],
    },
  },
  {
    name: "NOC Engineer",
    permissions: {
      routerule: ["view", "add", "edit"],
      digitrule: ["view", "add", "edit"],
      edrdeck: ["view", "export"],
      providerstatus: ["view", "start_stop"],
    },
  },
  {
    name: "Rates Analyst",
    permissions: {
      ratetable: ["view", "add", "edit", "import", "export"],
      routerule: ["view", "edit"],
      lcr: ["view", "request"],
    },
  },
  {
    name: "Finance",
    permissions: {
      transaction: ["view", "add", "edit", "export"],
      invoices: ["view", "add", "export"],
      soa: ["view", "send"],
    },
  },
  { name: "Read Only", permissions: { "*": ["view"] } },
];

const DEPT_GROUP: Record<string, string> = {
  Management: "Department Manager",
  Sales: "Account Manager",
  NOC: "NOC Engineer",
  Rates: "Rates Analyst",
  Billing: "Finance",
  Admin: "Administrator",
  Support: "Read Only",
};

export async function generateAdmin(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const baseCurrencies = ["USD", "EUR", "USD"];
  for (let i = 0; i < profile.businessCompanies; i++) {
    const name = companyName(rng).replace(/ (Ltd|LLC|FZE|GmbH|SA|Pte Ltd|BV|Inc|SRL|AB|Oy|DMCC)$/, "") + " Group";
    const bc = { id: i + 1, name, baseCurrency: baseCurrencies[i % baseCurrencies.length]! };
    world.businessCompanies.push(bc);
    await sink.insert("business_companies", {
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

  for (const [i, name] of DEPARTMENTS.entries()) {
    await sink.insert("departments", { id: i + 1, name, status: "active" });
  }
  for (const [i, g] of ACCESS_GROUPS.entries()) {
    await sink.insert("access_groups", { id: i + 1, name: g.name, status: "active", permissions: json(g.permissions) });
  }

  // Department sizes: Sales holds the account managers.
  const plan: string[] = [];
  plan.push("Admin", "Admin", "Admin");
  for (let i = 0; i < 5; i++) plan.push("Management"); // one manager per department
  for (let i = 0; i < profile.accountManagers; i++) plan.push("Sales");
  const rest = ["NOC", "NOC", "NOC", "Rates", "Rates", "Billing", "Billing", "Support", "Sales"];
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
      managedDept = ["Sales", "NOC", "Rates", "Billing", "Support"][managers.size]!;
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
    await sink.insert("users", {
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
}

/** Users of a department, for created_by / updated_by columns. */
export function usersOf(world: World, ...departments: string[]): User[] {
  const list = world.users.filter((u) => departments.includes(u.department));
  return list.length ? list : world.users;
}
