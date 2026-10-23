// GUI Access Group catalogue (§11): every page of the menu with the buttons it has. Keys match the
// web page registry (web/src/nav/registry.ts); a test keeps the two in step.
import type { AccessCatalog } from "@sms/contract";

export const ACTIONS: AccessCatalog["actions"] = [
  { key: "view", label: "View", description: "Open the page and read its records" },
  { key: "add", label: "Add", description: "Create records" },
  { key: "edit", label: "Edit", description: "Change records" },
  { key: "delete", label: "Delete", description: "Archive records (§13.29)" },
  { key: "export", label: "Export", description: "Download lists and files" },
  { key: "import", label: "Import", description: "Upload files that change records" },
  { key: "send", label: "Send", description: "E-mail partners (rates, invoices, statements)" },
  { key: "approve", label: "Approve", description: "Approve or reject requests (maker-checker)" },
  { key: "start_stop", label: "Start / stop", description: "Start or stop binds and jobs" },
  { key: "change_password", label: "Change passwords", description: "Set other users' temporary passwords" },
  { key: "undo_others", label: "Undo others", description: "Undo changes made by other users (§13.10)" },
  { key: "export_credentials", label: "Export credentials", description: "Sensitive exports, 2FA required (§13.22)" },
];

export const SECTIONS: AccessCatalog["sections"] = [
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
];

const CRUD = ["view", "add", "edit", "delete", "export"];
const READ = ["view", "export"];
const m = (key: string, label: string, section: string, actions: string[], tabs?: [string, string][]) => ({
  key,
  label,
  section,
  actions,
  ...(tabs ? { tabs: tabs.map(([k, l]) => ({ key: `${key}.${k}`, label: l })) } : {}),
});

export const MODULES: AccessCatalog["modules"] = [
  m("dashboard", "Dashboard", "dashboard", ["view"]),
  m("live-analytics", "Live analytics", "live", ["view"]),
  // Tabs and form sections that a group or user can be kept from seeing (team trial round 2).
  m(
    "enterprises",
    "Enterprises",
    "enterprises",
    [...CRUD, "import"],
    [
      ["docs", "Docs tab"],
      ["billing", "Billing tab"],
      ["customer-trunks", "Customer trunks tab"],
      ["vendor-trunks", "Vendor trunks tab"],
      ["account-managers", "Account managers tab"],
      ["history", "History tab"],
    ],
  ),
  m(
    "customer-trunks",
    "Customer trunks",
    "enterprises",
    [...CRUD, "send"],
    [
      ["connection", "Connection section"],
      ["receipts", "Delivery receipts section"],
      ["routing", "Routing section"],
      ["capacity", "Capacity and limits section"],
      ["pricing", "Pricing section"],
      ["rules", "Rules tab"],
      ["history", "History tab"],
    ],
  ),
  m(
    "vendor-trunks",
    "Vendor trunks",
    "enterprises",
    [...CRUD, "start_stop"],
    [
      ["connection", "Connection section"],
      ["http", "HTTP API section"],
      ["smpp", "SMPP session section"],
      ["messages", "Messages section"],
      ["capacity", "Capacity and limits section"],
      ["rates", "Rates tab"],
      ["rules", "Rules tab"],
      ["history", "History tab"],
    ],
  ),
  m("transactions", "Transactions", "finance", CRUD),
  m("invoices", "Invoices", "finance", [...CRUD, "send", "approve"]),
  m("vendor-invoices", "Vendor invoices", "finance", [...CRUD, "send"]),
  m("soa", "SOA", "finance", ["view", "add", "edit", "export", "send"]),
  m("soa-report", "SOA report", "finance", [...CRUD, "send"]),
  m("balances", "Enterprise balance", "finance", READ),
  m("charges", "Charges calculator", "finance", ["view"]),
  m("currencies", "Currencies", "finance", CRUD),
  m("billing-cycles", "Billing cycles", "finance", CRUD),
  m("rate-manager", "Rate manager", "rates", [...CRUD, "import", "send"]),
  m("incoming-rns", "Incoming RNs", "rates", ["view", "edit", "import", "approve"]),
  m("market-moves", "Market moves", "rates", READ),
  m("bulk", "Bulk workspace", "rates", ["view", "edit", "import"]),
  m("categories", "Product categories", "rates", CRUD),
  m("route-rules", "Route rules", "routing", [...CRUD, "import"]),
  m("route-map", "Route map", "routing", READ),
  m("lcr", "LCR", "routing", ["view", "add", "export"]),
  m("re-rating", "Re-rating", "rates", ["view", "add", "approve", "export"]),
  m("rate-lookup", "Rate lookup", "rates", READ),
  m("margin-calculator", "Margin calculator", "rates", CRUD),
  m("simulator", "Simulator", "routing", ["view"]),
  // Reference data sits under Routing (team trial round 3).
  m("countries", "Countries", "routing", CRUD),
  m("mccmnc", "MCCMNC codes", "routing", [...CRUD, "import"]),
  m("master-table", "Master table", "routing", [...CRUD, "import"]),
  m("mo-book", "MO reference book", "routing", [...CRUD, "import"]),
  m("translation-rules", "Translation rules", "switch", CRUD),
  m("hlr", "HLR", "switch", CRUD),
  m("number-lists", "Number lists", "switch", [...CRUD, "import"]),
  m("qbr-stats", "QBR stats", "switch", ["view", "edit", "export"]),
  m("notifications", "Notifications", "switch", CRUD),
  m("email-logs", "Email logs", "switch", ["view", "export", "send"]),
  m("firewall", "Firewall", "switch", CRUD),
  m("sms-to-voice", "SMS to voice", "switch", CRUD),
  m("traffic-alerts", "Traffic alerts", "switch", CRUD),
  m("broadcast", "Broadcast", "switch", ["view", "send"]),
  m("alert-rules", "Alert rules", "monitoring", CRUD),
  m("incidents", "Incidents", "monitoring", ["view", "edit", "export"]),
  m("edr-search", "EDR search", "monitoring", [...READ, "send"]),
  m("edr-download", "EDR download", "monitoring", ["view", "add", "export"]),
  m("edr-templates", "EDR templates", "monitoring", CRUD),
  m("network-status", "Network status", "monitoring", ["view", "start_stop"]),
  m("signaling", "Signaling deck", "monitoring", ["view", "add", "export"]),
  m("pcap-trace", "PCAP trace", "monitoring", ["view", "add", "export"]),
  m("failed-edr", "Failed EDRs", "monitoring", READ),
  m("diagnosis", "Network diagnosis", "monitoring", ["view"]),
  m("repush", "Repush requests", "monitoring", ["view", "add", "approve"]),
  m("master-report", "Master report", "reports", READ),
  m("enterprise-report", "Enterprise report", "reports", READ),
  m("sales-report", "Sales report", "reports", READ),
  m("billing-report", "Billing report", "reports", READ),
  m("noc-report", "NOC report", "reports", READ),
  m("team-report", "Team", "reports", READ),
  m("scheduled", "Scheduled reports", "reports", CRUD),
  m("daily-traffic", "Daily traffic alerts", "reports", [...CRUD, "send"]),
  m("change-history", "Change history", "admin", ["view", "undo_others"]),
  m("users", "Users", "admin", [...CRUD, "change_password"]),
  m("access-groups", "GUI access groups", "admin", CRUD),
  m("visibility", "Visibility policies", "admin", ["view", "edit"]),
  m("departments", "Departments", "admin", CRUD),
  m("business-companies", "Business companies", "admin", CRUD),
  m("logged-in", "Logged-in users", "admin", ["view", "edit"]),
  m("audit", "Audit trail", "admin", READ),
  m("email-templates", "Email templates", "admin", CRUD),
  m("security", "Security settings", "admin", ["view", "edit"]),
  m("cleanup", "Cleanup center", "admin", ["view", "edit"]),
  m("migration", "Migration center", "admin", ["view", "import", "export", "export_credentials"]),
  m("customer-portal", "Customer portal", "admin", [...CRUD, "change_password"]),
];

const MODULE_BY_KEY = new Map(MODULES.map((x) => [x.key, x]));
const ACTION_KEYS = new Set(ACTIONS.map((a) => a.key));

/** Field errors for a permission matrix: unknown pages, or actions a page does not have. */
export function checkPermissions(perms: Record<string, string[]>): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  for (const [key, actions] of Object.entries(perms)) {
    const mod = MODULE_BY_KEY.get(key);
    if (key !== "*" && !mod) {
      errors.push({ path: `/permissions/${key}`, message: "unknown page" });
      continue;
    }
    for (const a of actions) {
      if (key === "*" ? !ACTION_KEYS.has(a) : !mod!.actions.includes(a))
        errors.push({ path: `/permissions/${key}`, message: `“${a}” is not an action of this page` });
    }
    if (actions.length && !actions.includes("view"))
      errors.push({ path: `/permissions/${key}`, message: "every other action needs View" });
  }
  return errors;
}

const TAB_KEYS = new Set(MODULES.flatMap((x) => (x.tabs ?? []).map((t) => t.key)));

/** Field errors for hidden tabs: keys must come from the catalogue. */
export function checkTabs(keys: Iterable<string>, path: string): { path: string; message: string }[] {
  return [...keys].filter((k) => !TAB_KEYS.has(k)).map((k) => ({ path: `${path}/${k}`, message: "unknown tab" }));
}

/**
 * What a user may do: the group's permissions with the user's own page overrides on top ([] = no access), and
 * the hidden tabs (the group's, plus the user's false, minus the user's true) (team trial round 2).
 */
export function effectiveAccess(
  group: Record<string, string[]>,
  groupHidden: string[],
  overrides: Record<string, string[]>,
  tabOverrides: Record<string, boolean>,
): { permissions: Record<string, string[]>; denied: string[]; hiddenTabs: string[] } {
  const permissions: Record<string, string[]> = { ...group };
  // "No access" on a page also beats the group's Every page.
  const denied: string[] = [];
  for (const [page, actions] of Object.entries(overrides)) {
    if (actions.length) permissions[page] = actions;
    else {
      delete permissions[page];
      denied.push(page);
    }
  }
  const hidden = new Set(groupHidden);
  for (const [tab, show] of Object.entries(tabOverrides)) {
    if (show) hidden.delete(tab);
    else hidden.add(tab);
  }
  return { permissions, denied, hiddenTabs: [...hidden].sort() };
}

/** Drops pages with no actions and sorts actions in catalogue order. */
export function normalisePermissions(perms: Record<string, string[]>): Record<string, string[]> {
  const order = ACTIONS.map((a) => a.key);
  const out: Record<string, string[]> = {};
  for (const [key, actions] of Object.entries(perms)) {
    const list = [...new Set(actions)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    if (list.length) out[key] = list;
  }
  return out;
}
