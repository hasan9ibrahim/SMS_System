// Every page of the app: the top menu (§15.1), the Ctrl K page search, tab titles and routes.
// `spec` and `step` keep the spec section and build step for traceability (CLAUDE.md "Build
// order"); they are never shown to users.
import type { IconName } from "../ui/Icon";

export interface PageDef {
  key: string;
  label: string;
  path: string;
  section: SectionKey;
  icon: IconName;
  spec: string;
  /** Build-order step that delivered the screen; "3" = built in the app shell step. Not shown. */
  step: string;
  /** One-line purpose, shown on placeholders and in Ctrl K. */
  summary: string;
  /**
   * The Admin › Access Groups page whose permissions open this one, when it has none of its own
   * (contract/access.json: Voice gateways open with SMS to voice). Default: the page's own key.
   */
  access?: string;
}

/** The access-group page that decides whether the user may open the page (§11). */
export const accessOf = (pg: PageDef): string => pg.access ?? pg.key;

export type SectionKey =
  | "dashboard"
  | "live"
  | "enterprises"
  | "finance"
  | "rates"
  | "routing"
  | "switch"
  | "monitoring"
  | "reports"
  | "admin"
  | "help";

export interface SectionDef {
  key: SectionKey;
  label: string;
}

/** Top menu order (§15.1). Sections with one page open it directly; others drop down. */
export const SECTIONS: SectionDef[] = [
  { key: "dashboard", label: "Dashboard" },
  { key: "live", label: "Live" },
  { key: "enterprises", label: "Enterprises" },
  { key: "finance", label: "Finance" },
  { key: "rates", label: "Rates" },
  { key: "routing", label: "Routing" },
  { key: "switch", label: "Switch" },
  { key: "monitoring", label: "Monitoring" },
  { key: "reports", label: "Reports" },
  { key: "admin", label: "Admin" },
  { key: "help", label: "Help" },
];

const p = (
  section: SectionKey,
  key: string,
  label: string,
  path: string,
  icon: IconName,
  spec: string,
  step: string,
  summary: string,
): PageDef => ({ section, key, label, path, icon, spec, step, summary });

export const PAGES: PageDef[] = [
  p(
    "dashboard",
    "dashboard",
    "Dashboard",
    "/dashboard",
    "dashboard",
    "§4, §13.3",
    "4.6",
    "Live NOC view: today's volume, money, movers, TPS and top lists",
  ),
  p(
    "live",
    "live-analytics",
    "Live analytics",
    "/live/analytics",
    "activity",
    "§13.4",
    "5.12",
    "Analytics report with figures streaming in place",
  ),

  p(
    "enterprises",
    "enterprises",
    "Enterprises",
    "/enterprises",
    "building",
    "§5",
    "4.1",
    "Partners: general info, docs, billing, customer and vendor trunks",
  ),
  p(
    "enterprises",
    "customer-trunks",
    "Customer trunks",
    "/enterprises/customer-trunks",
    "network",
    "§5.4, §13.1",
    "4.1",
    "Client connections: binds, IPs, TPS, receipts and rate tables",
  ),
  p(
    "enterprises",
    "vendor-trunks",
    "Vendor trunks",
    "/enterprises/vendor-trunks",
    "send",
    "§5.5",
    "4.1",
    "Vendor connections: SMPP or HTTP, capacity and message rules",
  ),

  p(
    "finance",
    "transactions",
    "Transactions",
    "/finance/transactions",
    "wallet",
    "§7, §13.33",
    "5.5",
    "Payments, credit notes and adjustments",
  ),
  p(
    "finance",
    "invoices",
    "Invoices",
    "/finance/invoices",
    "file",
    "§7, §12.3",
    "5.6",
    "Customer invoices, generation requests and sending",
  ),
  p(
    "finance",
    "vendor-invoices",
    "Vendor invoices",
    "/finance/vendor-invoices",
    "file",
    "§7, §13.31",
    "5.6",
    "Partner invoices with automatic reconciliation",
  ),
  p(
    "finance",
    "soa",
    "SOA",
    "/finance/soa",
    "file",
    "§7, §13.31, §13.33",
    "5.7",
    "Statements of account: preview, manual lines, send and export",
  ),
  p(
    "finance",
    "soa-report",
    "SOA report",
    "/finance/soa-report",
    "file",
    "§7",
    "5.7",
    "SOA exports and sent statements with download",
  ),
  p(
    "finance",
    "balances",
    "Enterprise balance",
    "/finance/balances",
    "scale",
    "§7",
    "5.5",
    "Customer, vendor and net balances",
  ),
  p(
    "finance",
    "charges",
    "Charges calculator",
    "/finance/charges",
    "calculator",
    "§7",
    "5.5",
    "Usage charges for a period",
  ),
  p(
    "finance",
    "currencies",
    "Currencies",
    "/finance/currencies",
    "coins",
    "§7",
    "5.5",
    "Currencies and exchange rates",
  ),
  p(
    "finance",
    "billing-cycles",
    "Billing cycles",
    "/finance/billing-cycles",
    "calendar",
    "§7",
    "5.5",
    "Named billing cycles (e.g. Monthly – Net 7)",
  ),

  p(
    "rates",
    "rate-manager",
    "Rate manager",
    "/rates/manager",
    "tag",
    "§13.12",
    "4.2",
    "All customer and vendor rate tables in one workspace",
  ),
  p(
    "rates",
    "incoming-rns",
    "Incoming RNs",
    "/rates/incoming",
    "inbox",
    "§13.13, §13.32",
    "5.14",
    "Vendor rate notifications: live-traffic check, accept or reject",
  ),
  p(
    "rates",
    "rn-report",
    "RN report",
    "/rates/rn-report",
    "mail",
    "§8, §13.10",
    "R7",
    "Every rate notification sent: who got it and who did not",
  ),
  p(
    "rates",
    "market-moves",
    "Market moves",
    "/rates/market-moves",
    "trending",
    "§13.14",
    "5.15",
    "Destinations where leading vendors moved their rates",
  ),
  p(
    "rates",
    "bulk",
    "Bulk rating",
    "/rates/bulk",
    "layers",
    "§13.11",
    "5.13",
    "Re-price several clients and destinations at once, with review and impact preview",
  ),
  p(
    "rates",
    "rate-lookup",
    "Rate lookup",
    "/rates/rate-lookup",
    "search",
    "§13.16",
    "4.4",
    "Vendor costs and client rates for a destination in seconds",
  ),
  p(
    "rates",
    "re-rating",
    "Re-rating",
    "/rates/re-rating",
    "refresh",
    "§6.3, §12.2",
    "5.2",
    "Recompute past charges after a rate correction",
  ),
  p(
    "rates",
    "categories",
    "Product categories",
    "/rates/categories",
    "folder",
    "§6.1",
    "5.1",
    "Traffic classes (DIRECT, HQ, OTP, …)",
  ),
  p(
    "rates",
    "margin-calculator",
    "Margin calculator",
    "/rates/margin-calculator",
    "calculator",
    "§13.12",
    "5.22",
    "Swap deals: margin both ways and who pays whom",
  ),

  p(
    "routing",
    "route-rules",
    "Route rules",
    "/routing/rules",
    "route",
    "§6.3, §13.8–13.11, §15.4",
    "4.3",
    "Match conditions to vendors, with live traffic per rule",
  ),
  p("routing", "route-map", "Route map", "/routing/map", "map", "§6.3", "5.2", "Which rule routes each destination"),
  p(
    "routing",
    "lcr",
    "LCR",
    "/routing/lcr",
    "sort",
    "§13.23",
    "5.16",
    "Vendors ranked by cost and quality per destination",
  ),
  p(
    "routing",
    "simulator",
    "Simulator",
    "/routing/simulator",
    "play",
    "§9.2",
    "5.9",
    "Which rule and vendor a message would get",
  ),
  // Reference data sits with routing (team trial round 3); the addresses stay the same.
  p("routing", "countries", "Countries", "/rates/countries", "globe", "§6.1", "5.1", "Countries and dial codes"),
  p("routing", "mccmnc", "MCCMNC codes", "/rates/mccmnc", "grid", "§6.1, §13.21", "5.1", "The destination master list"),
  p(
    "routing",
    "master-table",
    "Master table",
    "/rates/master-table",
    "grid",
    "§6.1",
    "5.1",
    "Dial-code prefixes to MCCMNC",
  ),
  p("routing", "mo-book", "MO reference book", "/rates/mo-book", "book", "§6.1", "5.1", "Two-way and MO billing numbers"),

  p(
    "switch",
    "translation-rules",
    "Translation rules",
    "/switch/translation-rules",
    "shuffle",
    "§6.4, §13.2",
    "5.3",
    "Rewrite or block messages, applied straight to trunks",
  ),
  p("switch", "hlr", "HLR", "/switch/hlr", "radar", "§6.5, §13.24", "5.4", "HLR providers, rules and policies"),
  p(
    "switch",
    "number-lists",
    "Number lists",
    "/switch/number-lists",
    "list",
    "§6.4",
    "5.3",
    "Lists used by rules and whitelists",
  ),
  p(
    "switch",
    "qbr-stats",
    "QBR stats",
    "/switch/qbr-stats",
    "gauge",
    "§6.3",
    "5.2",
    "Quality feed for quality-based routing",
  ),
  p(
    "switch",
    "notifications",
    "Notifications",
    "/switch/notifications",
    "mail",
    "§8",
    "5.8",
    "Send rate sheets and connection details",
  ),
  p("switch", "email-logs", "Email logs", "/switch/email-logs", "mail", "§8", "5.8", "Every email the platform sent"),
  p("switch", "firewall", "Firewall", "/switch/firewall", "shield", "§8", "5.8", "Banned and trusted IPs"),
  p(
    "switch",
    "sms-to-voice",
    "SMS to voice",
    "/switch/sms-to-voice",
    "phone",
    "§8",
    "5.8",
    "Turn matching SMS into voice calls",
  ),
  // The voice switches SMS-to-voice calls go to (§8, decided 2026-10-31); opened with SMS to voice's access.
  {
    ...p(
      "switch",
      "voice-gateways",
      "Voice gateways",
      "/switch/voice-gateways",
      "phone",
      "§8",
      "5.8",
      "Voice switches the SMS to voice calls go to",
    ),
    access: "sms-to-voice",
  },
  p(
    "switch",
    "traffic-alerts",
    "Traffic alerts",
    "/switch/traffic-alerts",
    "bell",
    "§8",
    "5.8",
    "E-mail when a trunk's traffic, ASR or DLR falls out of range",
  ),
  p("switch", "broadcast", "Broadcast", "/switch/broadcast", "megaphone", "§8", "5.8", "Email all partners"),

  p(
    "monitoring",
    "alert-rules",
    "Alert rules",
    "/monitoring/alert-rules",
    "bell",
    "§13.6, §13.7",
    "5.12",
    "Sound, pop-up and email alerts on traffic statistics",
  ),
  p(
    "monitoring",
    "incidents",
    "Incidents",
    "/monitoring/incidents",
    "alert",
    "§13.6",
    "5.12",
    "Every alert with duration, peak and who acknowledged",
  ),
  p(
    "monitoring",
    "edr-search",
    "EDR search",
    "/monitoring/edr",
    "search",
    "§9.1",
    "5.9",
    "Per-message records with both legs",
  ),
  p(
    "monitoring",
    "edr-download",
    "EDR download",
    "/monitoring/edr-download",
    "download",
    "§9.2",
    "5.9",
    "Background EDR exports",
  ),
  p(
    "monitoring",
    "edr-templates",
    "EDR templates",
    "/monitoring/edr-templates",
    "columns",
    "§9.2",
    "5.9",
    "Saved EDR column sets",
  ),
  p(
    "monitoring",
    "network-status",
    "Network status",
    "/monitoring/network-status",
    "network",
    "§9.2, §13.1",
    "5.9",
    "Binds and sessions per trunk",
  ),
  p("monitoring", "signaling", "Signaling deck", "/monitoring/signaling", "wave", "§9.2", "5.9", "Live SMPP captures"),
  p(
    "monitoring",
    "pcap-trace",
    "PCAP trace",
    "/monitoring/pcap-trace",
    "wave",
    "§9.2",
    "5.9",
    "Recording of all SMPP traffic, kept 120 days",
  ),
  p(
    "monitoring",
    "failed-edr",
    "Failed EDRs",
    "/monitoring/failed-edr",
    "alert",
    "§9.2",
    "5.9",
    "Messages rejected before routing",
  ),
  p(
    "monitoring",
    "diagnosis",
    "Network diagnosis",
    "/monitoring/diagnosis",
    "terminal",
    "§9.2",
    "5.9",
    "Ping, trace route, MTR, telnet from the switch",
  ),
  p(
    "monitoring",
    "repush",
    "Repush requests",
    "/monitoring/repush",
    "send",
    "§9.2",
    "5.9",
    "EDRs re-sent to another vendor",
  ),

  p(
    "reports",
    "master-report",
    "Master report",
    "/reports/master",
    "chart",
    "§13.15",
    "5.10",
    "Every metric, grouped and filtered by anything",
  ),
  p(
    "reports",
    "enterprise-report",
    "Enterprise report",
    "/reports/enterprise",
    "chart",
    "§10, §13.31",
    "4.5",
    "Billing team report, also used for invoice reconciliation",
  ),
  p(
    "reports",
    "sales-report",
    "Sales report",
    "/reports/sales",
    "chart",
    "§13.15",
    "5.10",
    "Clients and destinations growing or declining",
  ),
  p(
    "reports",
    "billing-report",
    "Billing report",
    "/reports/billing",
    "chart",
    "§13.15",
    "5.10",
    "Billed, invoiced, paid and disputed",
  ),
  p("reports", "noc-report", "NOC report", "/reports/noc", "chart", "§13.15", "5.10", "Where traffic has problems"),
  p("reports", "team-report", "Team", "/reports/team", "users", "§13.18", "5.18", "Team members' results and activity"),
  p(
    "reports",
    "scheduled",
    "Scheduled reports",
    "/reports/scheduled",
    "clock",
    "§10",
    "5.10",
    "Reports emailed on a schedule",
  ),
  p(
    "reports",
    "daily-traffic",
    "Daily traffic alerts",
    "/reports/daily-traffic",
    "mail",
    "§10",
    "5.10",
    "Yesterday's traffic e-mailed to partners",
  ),

  p(
    "admin",
    "change-history",
    "Change history",
    "/admin/changes",
    "history",
    "§13.10",
    "3",
    "Every save, with per-user undo",
  ),
  p("admin", "users", "Users", "/admin/users", "users", "§11, §13.28", "5.11", "Staff users, passwords and 2FA"),
  p(
    "admin",
    "access-groups",
    "GUI access groups",
    "/admin/access-groups",
    "key",
    "§11",
    "5.11",
    "Which pages and buttons each role sees",
  ),
  p(
    "admin",
    "visibility",
    "Visibility policies",
    "/admin/visibility",
    "eye",
    "§13.17",
    "5.17",
    "Account manager masking and hiding",
  ),
  p("admin", "departments", "Departments", "/admin/departments", "folder", "§11", "5.11", "Departments and managers"),
  p(
    "admin",
    "business-companies",
    "Business companies",
    "/admin/business-companies",
    "building",
    "§11",
    "5.11",
    "Selling entities, formats and mailboxes",
  ),
  p("admin", "logged-in", "Logged-in users", "/admin/logged-in", "monitor", "§11, §13.18", "5.11", "Who is online now"),
  p("admin", "audit", "Audit trail", "/admin/audit", "file", "§11", "5.11", "Every action, by user"),
  p(
    "admin",
    "email-templates",
    "Email templates",
    "/admin/email-templates",
    "mail",
    "§11",
    "5.11",
    "Templates with placeholders",
  ),
  p(
    "admin",
    "security",
    "Security settings",
    "/admin/security",
    "lock",
    "§13.28",
    "5.21",
    "Password lifetime and 2FA rules",
  ),
  p(
    "admin",
    "cleanup",
    "Cleanup center",
    "/admin/cleanup",
    "sparkles",
    "§13.19, §13.20",
    "5.19",
    "Unused, duplicate and broken records, reviewed before change",
  ),
  p(
    "admin",
    "migration",
    "Migration center",
    "/admin/migration",
    "upload",
    "§13.22",
    "5.20",
    "Full import and export with dry run",
  ),
  p(
    "admin",
    "customer-portal",
    "Customer portal",
    "/admin/customer-portal",
    "users",
    "§11",
    "5.11",
    "Customer self-service logins",
  ),

  p(
    "help",
    "help",
    "Help center",
    "/help",
    "help",
    "§15.1",
    "6",
    "How every page works, what each field means, with search",
  ),
];

export const HOME: PageDef = p("dashboard", "home", "Home", "/", "home", "§15.1", "3", "Start page");

export function pagesOf(section: SectionKey): PageDef[] {
  return PAGES.filter((pg) => pg.section === section);
}

/** The page a path belongs to (longest matching prefix), for titles and sibling links. */
export function pageForPath(path: string): PageDef | undefined {
  const pathname = path.split("?")[0]!;
  if (pathname === "/") return HOME;
  let best: PageDef | undefined;
  for (const pg of PAGES) {
    if (pathname === pg.path || pathname.startsWith(`${pg.path}/`)) {
      if (!best || pg.path.length > best.path.length) best = pg;
    }
  }
  return best;
}
