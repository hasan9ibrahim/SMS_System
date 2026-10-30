// Admin (§11, §13.28) helpers without React: the access group matrix, the business company form
// built from its record, the Password column wording and placeholder insertion.
import type {
  AccessCatalog,
  BusinessCompanyInput,
  BusinessCompanyRecord,
  EmailTemplateRow,
  MailboxInput,
  UserRow,
} from "@sms/contract";

export type Permissions = Record<string, string[]>;
type Module = AccessCatalog["modules"][number];

/** Turns one action of a page on or off. Any action needs View; turning View off clears the page. */
export function togglePermission(perms: Permissions, mod: Module, action: string, on: boolean): Permissions {
  const cur = new Set(perms[mod.key] ?? []);
  if (on) {
    cur.add(action);
    cur.add("view");
  } else if (action === "view") cur.clear();
  else cur.delete(action);
  return withPage(
    perms,
    mod.key,
    mod.actions.filter((a) => cur.has(a)),
  );
}

/** Every action of a page, or none. */
export const toggleModule = (perms: Permissions, mod: Module, on: boolean): Permissions =>
  withPage(perms, mod.key, on ? [...mod.actions] : []);

/** Every page of a menu section, or none. */
export function toggleSection(perms: Permissions, modules: Module[], on: boolean): Permissions {
  return modules.reduce((p, m) => toggleModule(p, m, on), perms);
}

function withPage(perms: Permissions, key: string, actions: string[]): Permissions {
  const next = { ...perms };
  if (actions.length) next[key] = actions;
  else delete next[key];
  return next;
}

/** What a group allows on a page, counting "*" (every page) as well. */
export function allowed(perms: Permissions, mod: Module): Set<string> {
  const all = perms["*"] ?? [];
  return new Set([...(perms[mod.key] ?? []), ...all.filter((a) => mod.actions.includes(a))]);
}

export const ALL_ACTIONS_LABEL = "Every page";

// ---------------------------------------------------------------- business company form

export const MAILBOX_DEPARTMENTS: { value: MailboxInput["department"]; label: string }[] = [
  // NOC and Support are one team, NOC Support and Technical (team trial round 12).
  { value: "noc", label: "NOC Support and Technical" },
  { value: "sales", label: "Sales" },
  { value: "rates", label: "Rates" },
  { value: "billing", label: "Billing" },
  { value: "support", label: "Support" },
];

export const TEMPLATE_SLOTS: { key: keyof BusinessCompanyInput["defaultTemplates"]; label: string; type: string }[] = [
  { key: "customerRate", label: "Customer Rate", type: "customer_rate" },
  { key: "invoice", label: "Invoice", type: "invoice" },
  { key: "lowBalance", label: "Low Balance", type: "low_balance" },
  { key: "bindDown", label: "Bind Down", type: "bind_down" },
  { key: "customerTechInfo", label: "Customer Tech Info", type: "customer_tech_info" },
  { key: "trunkChangeInfo", label: "Customer Trunk Change Info", type: "trunk_change_info" },
  { key: "soaStatement", label: "SOA Statement", type: "soa_statement" },
  { key: "rateUploadNotification", label: "Rate Upload Notification", type: "rate_upload_notification" },
  { key: "autoUploadRejected", label: "Auto Upload Report – Rejected", type: "auto_upload_rejected" },
];

/** Which department mailbox sends each kind of e-mail (Senders, §11); the default first. */
export const SENDER_SLOTS: { key: keyof BusinessCompanyInput["senders"]; label: string; hint: string }[] = [
  { key: "rateSheet", label: "Rate sheets & rate notices", hint: "Send rate, rate-change notices" },
  { key: "rnReply", label: "Replies to vendor RNs", hint: "RN accepted / rejected" },
  { key: "techInfo", label: "Tech info", hint: "Customer connection details" },
  { key: "trafficAlert", label: "Traffic & monitoring alerts", hint: "Alerts to partners" },
  { key: "troubleTicket", label: "Trouble tickets", hint: "Observation Deck message lists" },
  { key: "dailyReport", label: "Daily traffic summary", hint: "Daily traffic alerts" },
  { key: "scheduledReport", label: "Scheduled reports", hint: "Report e-mails" },
  { key: "invoice", label: "Invoices", hint: "Customer invoices" },
  { key: "soa", label: "Statements of account", hint: "SOA e-mails" },
  { key: "paymentConfirmation", label: "Payment confirmations", hint: "After a payment is booked" },
  { key: "vendorInvoiceReply", label: "Vendor invoice replies", hint: "Accept / dispute a vendor invoice" },
];
export const SENDER_DEFAULTS: BusinessCompanyInput["senders"] = {
  rateSheet: "rates",
  rnReply: "rates",
  techInfo: "noc",
  trafficAlert: "noc",
  troubleTicket: "noc",
  dailyReport: "noc",
  scheduledReport: "noc",
  invoice: "billing",
  soa: "billing",
  paymentConfirmation: "billing",
  vendorInvoiceReply: "billing",
};

/**
 * The address a kind of e-mail goes out from, as the server picks it: the chosen department's mailbox,
 * else the default department's, else department@website.
 */
export function senderAddress(
  v: Pick<BusinessCompanyInput, "senders" | "website"> & { mailboxes: { department: string; smtpEmail: string }[] },
  key: keyof BusinessCompanyInput["senders"],
): string | null {
  const dept = v.senders[key];
  const box = (d: string) => v.mailboxes.find((m) => m.department === d)?.smtpEmail?.trim() || null;
  const host = v.website?.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "");
  return box(dept) ?? box(SENDER_DEFAULTS[key]) ?? (host ? `${dept}@${host}` : null);
}

export const FILE_KINDS = [
  { kind: "logo", label: "Company Logo (PNG)", accept: ".png,image/png" },
  { kind: "invoice_format", label: "Invoice Format File (XLSX)", accept: ".xlsx,.xls,.xml" },
  { kind: "customer_rate_format", label: "Customer Rate Format File (XLSX)", accept: ".xlsx,.xls,.xml" },
  { kind: "soa_format", label: "SOA Format File (XLSX)", accept: ".xlsx,.xls,.xml" },
] as const;

const domainOf = (website: string | null) => (website ?? "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "");

export function blankMailbox(department: MailboxInput["department"], website: string | null): MailboxInput {
  const domain = domainOf(website) || "company.example";
  return {
    department,
    name: null,
    phone: null,
    smtpEmail: `${department}@${domain}`,
    smtpSecure: "starttls",
    smtpHost: `smtp.${domain}`,
    smtpPort: 587,
    smtpUsername: `${department}@${domain}`,
    extension: null,
    skypeName: null,
    oauthRedirectUris: [`https://portal.${domain}/oauth/callback`],
    clientId: "",
    smtpPassword: null,
    clientSecret: null,
    imapHost: null,
    imapPort: 993,
  };
}

/** The editable form of a saved company: secrets are never sent back, so they start empty (keep). */
export function companyInput(r: BusinessCompanyRecord): BusinessCompanyInput {
  return {
    name: r.name,
    description: r.description,
    baseCurrency: r.baseCurrency,
    tpsLimit: r.tpsLimit,
    website: r.website,
    smppHost: r.smppHost,
    smppPort: r.smppPort,
    invoiceNumberStart: r.invoiceNumberStart,
    companyIp: r.companyIp,
    customerRateFileName: r.customerRateFileName,
    address: { ...r.address },
    bank: { ...r.bank },
    defaultTemplates: { ...r.defaultTemplates },
    senders: { ...SENDER_DEFAULTS, ...r.senders },
    mailboxes: r.mailboxes.map(
      ({
        hasSmtpPassword: _p,
        hasClientSecret: _s,
        lastCheckAt: _a,
        lastCheckOk: _o,
        imapLastReadAt: _r,
        imapLastError: _e,
        ...m
      }) => ({
        ...m,
        smtpPassword: null,
        clientSecret: null,
      }),
    ),
  };
}

export function blankCompany(): BusinessCompanyInput {
  return {
    name: "",
    description: null,
    baseCurrency: "EUR",
    tpsLimit: null,
    website: null,
    smppHost: null,
    smppPort: 2775,
    invoiceNumberStart: 1,
    companyIp: null,
    customerRateFileName: "{company}_{trunk}_rates_{date}",
    address: { line1: null, line2: null, city: null, state: null, countryIso: null, zip: null },
    bank: {
      beneficiaryName: null,
      beneficiaryAddress: null,
      bankName: null,
      bankAddress: null,
      currency: null,
      accountNumber: null,
      iban: null,
      swift: null,
    },
    defaultTemplates: Object.fromEntries(
      TEMPLATE_SLOTS.map((t) => [t.key, null]),
    ) as BusinessCompanyInput["defaultTemplates"],
    senders: { ...SENDER_DEFAULTS },
    mailboxes: [],
  };
}

// ---------------------------------------------------------------- users

export const PASSWORD_TONE: Record<UserRow["passwordState"], "good" | "warning" | "error" | "neutral"> = {
  ok: "good",
  expiring: "warning",
  expired: "error",
  temporary: "neutral",
  must_change: "warning",
};

/** Password column (§13.28): last changed and days left, in words. */
export function passwordLabel(
  r: Pick<UserRow, "passwordState" | "passwordDaysLeft" | "tempPasswordExpiresAt">,
  now = Date.now(),
): string {
  if (r.passwordState === "temporary" && r.tempPasswordExpiresAt) {
    const h = Math.max(0, Math.round((Date.parse(r.tempPasswordExpiresAt) - now) / 3_600_000));
    return h > 0 ? `Temporary · ${h} h left` : "Temporary · expired";
  }
  if (r.passwordState === "must_change") return "Must change at next login";
  const d = r.passwordDaysLeft;
  if (d < 0) return `Expired ${-d} day${d === -1 ? "" : "s"} ago`;
  if (d === 0) return "Expires today";
  return `${d} day${d === 1 ? "" : "s"} left`;
}

export const USER_TYPE = { wholesale: "Wholesale", api: "Api" } as const;

/** Email Type labels (§11 Email Template). */
export const TEMPLATE_TYPE: Record<EmailTemplateRow["emailType"], string> = {
  customer_rate: "Customer Rate",
  invoice: "Invoice",
  low_balance: "Low Balance",
  bind_down: "Bind Down",
  customer_tech_info: "Customer Tech Info",
  trunk_change_info: "Trunk Change Info",
  soa_statement: "SOA Statement",
  rate_upload_notification: "Rate Upload Notification",
  traffic_alert: "Traffic Alert",
  auto_upload_rejected: "Auto Upload Report – Reject",
  trouble_ticket: "EDR – Trouble Ticket",
  send_soa: "Send SOA",
  monitoring_alert: "Monitoring Alert",
  am_handover: "Account Manager Handover",
};

/** Inserts a token at the caret (placeholder chips in the template editor). */
export function insertAt(text: string, start: number, end: number, token: string): { text: string; caret: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return { text: text.slice(0, s) + token + text.slice(e), caret: s + token.length };
}

/** Country choices by ISO code; a code shared by two countries (e.g. GE) is offered once. */
export function countryOptions(countries: { iso: string; name: string }[]): { value: string; label: string }[] {
  const seen = new Map<string, string[]>();
  for (const c of countries) seen.set(c.iso, [...(seen.get(c.iso) ?? []), c.name]);
  return [...seen].map(([iso, names]) => ({ value: iso, label: `${names.join(" / ")} (${iso})` }));
}
