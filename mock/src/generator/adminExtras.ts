/**
 * Admin (§11, §13.28) for build step 5.11: department mailboxes and format files of the business
 * companies, customer portal logins, password history, open sessions (Logged In Users) and the audit
 * trail. Runs after every other step on its own forked stream, so earlier tables are unchanged for the
 * same seed. Addresses, IPs and secrets are fake (TEST-NET ranges, .example domains).
 */
import { encryptSecret, hashPassword } from "../admin/passwords.js";
import { SEED_PASSWORD } from "./admin.js";
import { domainOf, fakeSecret, personName, phone } from "./names.js";
import type { Profile } from "./profiles.js";
import type { Rng } from "./rng.js";
import type { TableSink } from "./sink.js";
import { DAY, type World } from "./world.js";

const MAILBOXES = ["noc", "sales", "rates", "billing", "support"] as const;
const LOCATIONS = [
  "Dubai, AE",
  "London, GB",
  "Limassol, CY",
  "Amsterdam, NL",
  "Singapore, SG",
  "Lagos, NG",
  "Mumbai, IN",
];
const CLIENTS: { device: string; os: string; browser: string; w: number }[] = [
  { device: "desktop", os: "Windows 11", browser: "Chrome 129", w: 40 },
  { device: "desktop", os: "macOS 14", browser: "Safari 17", w: 15 },
  { device: "desktop", os: "macOS 14", browser: "Chrome 129", w: 12 },
  { device: "desktop", os: "Ubuntu 24.04", browser: "Firefox 131", w: 6 },
  { device: "mobile", os: "iOS 18", browser: "Safari 18", w: 10 },
  { device: "mobile", os: "Android 14", browser: "Chrome 129", w: 8 },
  { device: "tablet", os: "iPadOS 18", browser: "Safari 18", w: 4 },
  { device: "bot", os: "Linux", browser: "API client", w: 2 },
];

// Typical writes, with the contract's tag, path template, method, operation and table (§11 Audit Trail).
const AUDIT_OPS: [string, string, string, string, string | null, number][] = [
  ["routing", "/route-rules/{id}", "PUT", "updateRouteRule", "route_rules", 30],
  ["routing", "/route-rules", "POST", "createRouteRule", "route_rules", 6],
  ["rates", "/rate-tables/{id}/lines", "POST", "saveRateLines", "rate_lines", 25],
  ["rates", "/rate-tables/{id}/send", "POST", "sendRateTable", "rate_tables", 8],
  ["enterprises", "/enterprises/{id}", "PUT", "updateEnterprise", "enterprises", 10],
  ["trunks", "/customer-trunks/{id}", "PUT", "updateCustomerTrunk", "customer_trunks", 9],
  ["trunks", "/vendor-trunks/{id}", "PUT", "updateVendorTrunk", "vendor_trunks", 7],
  ["switch", "/translation-rules/{id}", "PUT", "updateTranslationRule", "translation_rules", 5],
  ["finance", "/transactions", "POST", "createTransaction", "transactions", 8],
  ["finance", "/invoices/{id}/send", "POST", "sendInvoice", "invoices", 4],
  ["observation", "/edr-downloads", "POST", "createEdrDownload", "edr_downloads", 5],
  ["observation", "/network/binds/{id}/start", "POST", "startBind", "trunk_binds", 2],
  ["views", "/views", "POST", "createSavedView", "saved_views", 6],
  ["session", "/me/preferences", "PATCH", "updatePreferences", "users", 7],
  ["history", "/changes/{id}/undo", "POST", "undoChange", "changes", 2],
  ["admin", "/users/{id}", "PUT", "updateUser", "users", 2],
  ["admin", "/users/{id}/password", "POST", "setUserPassword", "users", 1],
  ["reports", "/reports/master/export", "POST", "exportMasterReport", null, 6],
];

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360f8cfc0f01f0005000201ffa65a1d0000000049454e44ae426082",
  "hex",
);
// A tiny SpreadsheetML file standing in for an uploaded format (fake; the backend stores real XLSX).
const formatFile = (title: string, vars: string[]) =>
  Buffer.from(
    `<?xml version="1.0"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="${title}"><Table>` +
      vars.map((v) => `<Row><Cell><Data ss:Type="String">{${v}}</Data></Cell></Row>`).join("") +
      "</Table></Worksheet></Workbook>\n",
  );
const hex = (b: Buffer) => `\\x${b.toString("hex")}`;

export async function generateAdminExtras(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const full = profile.name === "full";
  const now = world.anchor;
  const salt = () => Buffer.from(rng.hex(32), "hex");

  // Department mailboxes and format files per business company.
  let mbId = 0;
  let fileId = 0;
  for (const bc of world.businessCompanies) {
    const domain = domainOf(bc.name);
    for (const dept of MAILBOXES) {
      const { first, last } = personName(rng);
      const tel = phone(rng, "971");
      const secure = rng.pick(["starttls", "starttls", "ssl"]);
      await sink.insert("business_company_mailboxes", {
        id: ++mbId,
        business_company_id: bc.id,
        department: dept,
        name: `${first} ${last}`,
        phone: tel,
        smtp_email: `${dept}@${domain}`,
        smtp_secure: secure,
        smtp_host: `smtp.${domain}`,
        smtp_port: secure === "ssl" ? 465 : 587,
        smtp_username: `${dept}@${domain}`,
        // Fake secrets, encrypted with the dev-only key like any saved one (never returned by the API).
        smtp_password_enc: encryptSecret(`fake-smtp-${fakeSecret(rng, 12)}`, Buffer.from(rng.hex(24), "hex")),
        extension: rng.chance(0.6) ? String(rng.int(100, 899)) : null,
        skype_name: rng.chance(0.3) ? `live:${dept}.${domain.split(".")[0]}` : null,
        oauth_redirect_uris: [`https://portal.${domain}/oauth/callback`],
        client_id: `fake-client-${fakeSecret(rng, 16)}`,
        client_secret_enc: encryptSecret(`fake-oauth-${fakeSecret(rng, 24)}`, Buffer.from(rng.hex(24), "hex")),
        last_check_at: rng.chance(0.7) ? new Date(now - rng.int(1, 60) * DAY) : null,
        last_check_ok: rng.chance(0.9),
      });
    }
    const files: [string, string, string, Buffer][] = [
      ["logo", "logo.png", "image/png", PNG_1X1],
      [
        "invoice_format",
        "invoice_format.xls",
        "application/vnd.ms-excel",
        formatFile("Invoice", ["invoice_no", "enterprise", "total"]),
      ],
      [
        "customer_rate_format",
        "customer_rate_format.xls",
        "application/vnd.ms-excel",
        formatFile("Rates", ["mccmnc", "country", "network", "rate", "from_date"]),
      ],
      [
        "soa_format",
        "soa_format.xls",
        "application/vnd.ms-excel",
        formatFile("SOA", ["date", "description", "debit", "credit", "balance"]),
      ],
    ];
    for (const [kind, name, type, content] of files)
      await sink.insert("business_company_files", {
        id: ++fileId,
        business_company_id: bc.id,
        kind,
        name,
        content_type: type,
        size: content.length,
        content: hex(content),
        uploaded_by_id: 1,
        uploaded_at: new Date(now - rng.int(30, 300) * DAY),
      });
  }

  // Customer portal logins for some live customers.
  const portal: { id: number; enterpriseId: number }[] = [];
  const usernames = new Set<string>();
  for (const e of world.enterprises) {
    if (e.deletedAt || e.type === "vendor" || !rng.chance(0.45)) continue;
    for (let k = rng.int(1, 3); k > 0; k--) {
      const { first, last } = personName(rng);
      let username = `${first[0]}${last}`.toLowerCase();
      for (let n = 2; usernames.has(username); n++) username = `${first[0]}${last}${n}`.toLowerCase();
      usernames.add(username);
      const id = portal.length + 1;
      portal.push({ id, enterpriseId: e.id });
      const temp = rng.chance(0.04);
      const ageDays = rng.chance(0.1) ? rng.int(31, 60) : rng.int(0, 29);
      await sink.insert("customer_portal_users", {
        id,
        enterprise_id: e.id,
        email: `${username}@${e.domain}`,
        username,
        first_name: first,
        last_name: last,
        status: rng.chance(0.92) ? "active" : "inactive",
        password_hash: hashPassword(SEED_PASSWORD, salt()),
        password_changed_at: new Date(now - (temp ? rng.int(1, 20) * 3600_000 : ageDays * DAY + rng.int(0, DAY))),
        must_change_password: temp || ageDays > 30,
        temp_password_expires_at: temp ? new Date(now + rng.int(2, 23) * 3600_000) : null,
        last_login_at: rng.chance(0.8) ? new Date(now - rng.int(0, 20 * DAY)) : null,
        updated_by_id: rng.pick(world.users).id,
        inserted_at: new Date(now - rng.int(30, 600) * DAY),
        updated_at: new Date(now - rng.int(0, 29) * DAY),
        deleted_at: null,
      });
    }
  }

  // Password history: previous passwords as hashes only (§13.28). Random fake strings.
  let phId = 0;
  for (const u of world.users) {
    for (let k = rng.int(0, full ? 6 : 3); k > 0; k--)
      await sink.insert("password_history", {
        id: ++phId,
        user_id: u.id,
        portal_user_id: null,
        password_hash: hashPassword(fakeSecret(rng, 16), salt()),
        changed_at: new Date(now - (k * 30 + rng.int(1, 29)) * DAY),
      });
  }

  // Open sessions: about a third of staff and some portal users; user 1 is "this session".
  const clientPick = () => {
    const total = CLIENTS.reduce((a, c) => a + c.w, 0);
    let x = rng.int(0, total - 1);
    for (const c of CLIENTS) if ((x -= c.w) < 0) return c;
    return CLIENTS[0]!;
  };
  let sId = 0;
  const session = async (kind: "staff" | "customer", userId: number, at: number) => {
    const c = clientPick();
    await sink.insert("user_sessions", {
      id: ++sId,
      user_kind: kind,
      user_id: kind === "staff" ? userId : null,
      portal_user_id: kind === "customer" ? userId : null,
      ip: `${rng.pick(["192.0.2", "198.51.100", "203.0.113"])}.${rng.int(1, 254)}`, // TEST-NET ranges
      location: rng.pick(LOCATIONS),
      device: c.device,
      os: c.os,
      browser: c.browser,
      logged_in_at: new Date(at),
      last_seen_at: new Date(Math.min(now, at + rng.int(0, 8 * 3600_000))),
      ended_at: null,
      ended_by_id: null,
      end_reason: null,
    });
  };
  for (const u of world.users) {
    if (u.id === 1) continue;
    if (rng.chance(0.35)) await session("staff", u.id, now - rng.int(5 * 60_000, 3 * DAY));
  }
  for (const p of portal) if (rng.chance(0.15)) await session("customer", p.id, now - rng.int(5 * 60_000, 2 * DAY));
  await session("staff", 1, now - 20 * 60_000);

  // Audit trail: realistic writes over the last 90 days (§11).
  const total = full ? 120_000 : 4_000;
  const weights = AUDIT_OPS.map((o) => o[5]);
  const sum = weights.reduce((a, b) => a + b, 0);
  const staff = world.users;
  const times = Array.from({ length: total }, () => now - rng.int(0, 90 * DAY)).sort((a, b) => a - b);
  for (const [i, at] of times.entries()) {
    let x = rng.int(0, sum - 1);
    let op = AUDIT_OPS[0]!;
    for (const o of AUDIT_OPS)
      if ((x -= o[5]) < 0) {
        op = o;
        break;
      }
    const u = rng.pick(staff);
    await sink.insert("audit_log", {
      id: i + 1,
      at: new Date(at),
      user_id: u.id,
      ip: `198.51.100.${(u.id % 250) + 1}`,
      module: op[0],
      controller: op[1],
      method: op[2],
      action: op[3],
      table_name: op[4],
      master_id: op[1].includes("{id}") ? String(rng.int(1, 3000)) : null,
      status: rng.chance(0.96) ? (op[2] === "POST" && !op[1].includes("{id}") ? 201 : 200) : rng.pick([400, 409]),
      duration_ms: rng.int(4, 400),
    });
  }
}
