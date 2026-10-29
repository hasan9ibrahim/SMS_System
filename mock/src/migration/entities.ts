// Migration Center (§13.22): what can be imported (in dependency order, with the template's fields,
// allowed values and sensitivity) and what a full export package contains. No I/O.
import type { MigrationEntityInfo, MigrationField, MigrationImportEntity, MigrationSensitivity } from "@sms/contract";

const f = (
  field: string,
  label: string,
  description: string,
  opts: { required?: boolean; allowed?: string[]; credential?: boolean } = {},
): MigrationField => ({
  field,
  label,
  description,
  required: !!opts.required,
  allowed: opts.allowed ?? [],
  credential: !!opts.credential,
});
const EXT = f(
  "externalId",
  "External ID",
  "The record's ID in the old platform; kept so EDRs and reports can be linked.",
);

export const IMPORT_ENTITIES: MigrationEntityInfo[] = [
  {
    entity: "users",
    label: "Users",
    sensitivity: "business",
    importable: true,
    order: 1,
    dependsOn: [],
    matchBy: "external ID, else username",
    fields: [
      EXT,
      f("username", "Username", "Login name; unique.", { required: true }),
      f("firstName", "First name", "", { required: true }),
      f("lastName", "Last name", "", { required: true }),
      f("email", "E-mail", "", { required: true }),
      f("department", "Department", "Name of an existing department."),
      f("accessGroup", "GUI access group", "Name of an existing access group."),
      f("isAccountManager", "Account manager", "yes / no", { allowed: ["yes", "no"] }),
      f("status", "Status", "", { allowed: ["active", "inactive"] }),
    ],
  },
  {
    entity: "enterprises",
    label: "Enterprises and contacts",
    sensitivity: "business",
    importable: true,
    order: 2,
    dependsOn: ["users"],
    matchBy: "external ID, else name",
    fields: [
      EXT,
      f("name", "Name", "", { required: true }),
      f("alias", "Alias", "Short name; made from the name when empty."),
      f("type", "Type", "", { required: true, allowed: ["customer", "vendor", "reciprocal"] }),
      f("tier", "Tier", "", { allowed: ["tier1", "tier2", "tier3"] }),
      f("status", "Status", "", { allowed: ["active", "inactive"] }),
      f("businessCompany", "Business company", "Name of an existing business company.", { required: true }),
      f("accountManager", "Account manager", "Username (existing or in the users file)."),
      f("country", "Country", "ISO code, e.g. AE."),
      f("vatNumber", "VAT number", ""),
      f("address", "Address", "First address line."),
      f("emails", "Commercial e-mails", "Separated by , or ;"),
      f("technicalEmails", "Technical / NOC e-mails", "Separated by , or ;"),
      f("ratesEmails", "Rates e-mails", "Separated by , or ; (rate notifications)"),
      f("financeEmails", "Finance / billing e-mails", "Separated by , or ; (invoices, SOA)"),
    ],
  },
  {
    entity: "customer_trunks",
    label: "Customer trunks",
    sensitivity: "credentials",
    importable: true,
    order: 3,
    dependsOn: ["enterprises"],
    matchBy: "external ID, else name",
    fields: [
      EXT,
      f("enterprise", "Enterprise", "Name or external ID of the enterprise.", { required: true }),
      f("name", "Trunk name", "", { required: true }),
      f("username", "System ID", "SMPP username; unique.", { credential: true }),
      f("password", "Password", "SMPP password.", { credential: true }),
      f("hostIps", "Allowed IPs", "Separated by , or ;", { credential: true }),
      // No port: customers bind on 2775 (no TLS) or 2776 (TLS), set by the SSL type (product owner, 2026-10-24).
      f("sslType", "SSL", "Connection type; the port follows: none → 2775, TLS → 2776. Default none.", {
        allowed: ["none", "tls1.0", "tls1.2", "tls1.3"],
      }),
      f("protocol", "Protocol", "", { allowed: ["smpp", "http"] }),
      f("tps", "TPS", "Messages per second.", { required: true }),
      f("category", "Product category", "Name of an existing category."),
      f("billingType", "Billing type", "", { allowed: ["attempt", "submit", "reported", "delivery"] }),
    ],
  },
  {
    entity: "vendor_trunks",
    label: "Vendor trunks",
    sensitivity: "credentials",
    importable: true,
    order: 4,
    dependsOn: ["enterprises"],
    matchBy: "external ID, else name",
    fields: [
      EXT,
      f("enterprise", "Enterprise", "Name or external ID of the enterprise.", { required: true }),
      f("name", "Trunk name", "", { required: true }),
      f("host", "Host", "Vendor SMSC address.", { credential: true }),
      f("port", "Port", "", { credential: true }),
      f("username", "System ID", "", { credential: true }),
      f("password", "Password", "", { credential: true }),
      f("protocol", "Protocol", "", { allowed: ["smpp", "http"] }),
      f("tps", "TPS", "", { required: true }),
      f("category", "Product category", "Name of an existing category.", { required: true }),
      f("billingType", "Billing type", "", { allowed: ["attempt", "submit", "reported", "delivery"] }),
    ],
  },
  {
    entity: "rate_tables",
    label: "Rate tables",
    sensitivity: "business",
    importable: true,
    order: 5,
    dependsOn: ["customer_trunks", "vendor_trunks"],
    matchBy: "external ID, else name and kind",
    fields: [
      EXT,
      f("name", "Name", "", { required: true }),
      f("kind", "Kind", "", { required: true, allowed: ["customer", "vendor"] }),
      f("currency", "Currency", "ISO code of an existing currency.", { required: true }),
      f("category", "Product category", "", { required: true }),
      f("vendorTrunk", "Vendor trunk", "For a vendor table: the trunk it belongs to."),
      f("customerTrunks", "Customer trunks", "For a customer table: trunks selling from it, separated by ;"),
    ],
  },
  {
    entity: "rate_lines",
    label: "Rates",
    sensitivity: "business",
    importable: true,
    order: 6,
    dependsOn: ["rate_tables"],
    matchBy: "lines go into rate tables created by the same import",
    fields: [
      f("rateTable", "Rate table", "Name or external ID.", { required: true }),
      f("mccmnc", "MCCMNC", "A code of the MCCMNC master (3 digits = the whole country).", { required: true }),
      f("senderId", "Sender ID", ""),
      f("rate", "Rate", "In the table's currency.", { required: true }),
      f("validFrom", "Valid from", "Date or date-time (UTC); today when empty."),
      f("blocked", "Blocked", "yes / no", { allowed: ["yes", "no"] }),
    ],
  },
  {
    entity: "route_rules",
    label: "Route rules",
    sensitivity: "business",
    importable: true,
    order: 7,
    dependsOn: ["customer_trunks", "vendor_trunks"],
    matchBy: "external ID, else name",
    fields: [
      EXT,
      f("name", "Name", "", { required: true }),
      f("priority", "Priority", "1 (first) to 100.", { required: true }),
      f("status", "Status", "", { allowed: ["active", "inactive"] }),
      f("customerTrunks", "Customer trunks", "Separated by , or ; — empty = all trunks."),
      f("destinations", "Destinations", "MCCMNC codes separated by , or ; — empty = all."),
      f("vendors", "Vendors", "trunk:share separated by , or ; e.g. VENDOR_A:60,VENDOR_B:40", { required: true }),
    ],
  },
  {
    entity: "opening_balances",
    label: "Opening balances",
    sensitivity: "financial",
    importable: true,
    order: 8,
    dependsOn: ["enterprises"],
    matchBy: "always added",
    fields: [
      f("enterprise", "Enterprise", "Name or external ID.", { required: true }),
      f("side", "Side", "", { required: true, allowed: ["customer", "vendor"] }),
      f("amount", "Amount", "Positive = the partner's credit, negative = owed (§7).", { required: true }),
      f("currency", "Currency", "", { required: true }),
      f("date", "Date", "YYYY-MM-DD", { required: true }),
    ],
  },
];
export const ENTITY = new Map(IMPORT_ENTITIES.map((e) => [e.entity as MigrationImportEntity, e]));

/** Ready column mappings for the reference platform described in the spec (its grid column names). */
export const REFERENCE_PLATFORM = "Reference platform";
export const BUILT_IN_MAPPINGS: { entity: MigrationImportEntity; columns: Record<string, string> }[] = [
  {
    entity: "users",
    columns: {
      externalId: "User ID",
      username: "User Name",
      firstName: "First Name",
      lastName: "Last Name",
      email: "Email",
      department: "Department",
      accessGroup: "GUI Access Group",
      isAccountManager: "Account Manager",
      status: "Status",
    },
  },
  {
    entity: "enterprises",
    columns: {
      externalId: "Enterprise ID",
      name: "Enterprise Name",
      alias: "Alias",
      type: "Enterprise Type",
      tier: "Tier",
      status: "Status",
      businessCompany: "Business Company",
      accountManager: "Account Manager",
      country: "Country",
      vatNumber: "VAT No",
      address: "Address 1",
      emails: "Commercial Email",
      technicalEmails: "Technical Email",
      ratesEmails: "Rates Email",
      financeEmails: "Billing Email",
    },
  },
  {
    entity: "customer_trunks",
    columns: {
      externalId: "Customer Trunk ID",
      enterprise: "Enterprise Name",
      name: "Customer Trunk Name",
      username: "System ID",
      password: "Password",
      hostIps: "Host IP",
      protocol: "Protocol",
      tps: "TPS",
      category: "Product Category",
      billingType: "Billing Type",
    },
  },
  {
    entity: "vendor_trunks",
    columns: {
      externalId: "Vendor Trunk ID",
      enterprise: "Enterprise Name",
      name: "Vendor Trunk Name",
      host: "Host",
      port: "Port",
      username: "System ID",
      password: "Password",
      protocol: "Protocol",
      tps: "TPS",
      category: "Product Category",
      billingType: "Billing Type",
    },
  },
  {
    entity: "rate_tables",
    columns: {
      externalId: "Rate Table ID",
      name: "Rate Table Name",
      kind: "Type",
      currency: "Currency",
      category: "Product Category",
      vendorTrunk: "Vendor Trunk",
      customerTrunks: "Customer Trunks",
    },
  },
  {
    entity: "rate_lines",
    columns: {
      rateTable: "Rate Table Name",
      mccmnc: "MCCMNC",
      senderId: "Sender ID",
      rate: "Rate",
      validFrom: "Effective Date",
      blocked: "Blocked",
    },
  },
  {
    entity: "route_rules",
    columns: {
      externalId: "Rule ID",
      name: "Rule Name",
      priority: "Priority",
      status: "Status",
      customerTrunks: "Customer Trunks",
      destinations: "MCCMNC",
      vendors: "Vendor Trunks",
    },
  },
  {
    entity: "opening_balances",
    columns: {
      enterprise: "Enterprise Name",
      side: "Account Type",
      amount: "Balance",
      currency: "Currency",
      date: "Balance Date",
    },
  },
];

/**
 * Other column names each template field is known by (team trial round 11: "User name" and "Username" are the same
 * column). Headers are compared loosely — case, spaces, dashes, underscores, dots and brackets ignored — after the
 * chosen mapping, the field key and its label, and the reference platform's names.
 */
export const HEADER_ALIASES: Record<MigrationImportEntity, Record<string, string[]>> = {
  users: {
    externalId: ["ID", "User ID", "Old ID", "Source ID"],
    username: ["User name", "Login", "Login name", "User"],
    firstName: ["First", "Given name", "Forename"],
    lastName: ["Last", "Surname", "Family name"],
    email: ["Email address", "Mail"],
    department: ["Dept", "Department name"],
    accessGroup: ["Access group", "GUI access group", "Group", "Role", "User group"],
    isAccountManager: ["Account manager", "Is account manager", "AM", "Is AM"],
    status: ["State", "User status"],
  },
  enterprises: {
    externalId: ["ID", "Enterprise ID", "Partner ID", "Old ID"],
    name: ["Enterprise", "Enterprise name", "Partner", "Partner name"],
    alias: ["Short name", "Code"],
    type: ["Enterprise type", "Partner type"],
    tier: ["Enterprise tier"],
    status: ["State"],
    businessCompany: ["Company", "Business company name"],
    accountManager: ["AM", "Account manager username"],
    country: ["Country code", "Country ISO"],
    vatNumber: ["VAT", "VAT no", "Tax number", "TRN"],
    address: ["Address 1", "Address line 1", "Street"],
    emails: ["Email", "Emails", "Commercial email"],
    technicalEmails: ["Technical email", "NOC email", "Support email"],
    ratesEmails: ["Rates email", "Rate email", "Rate notification email"],
    financeEmails: ["Finance email", "Billing email", "Invoice email", "Accounts email"],
  },
  customer_trunks: {
    externalId: ["ID", "Trunk ID", "Customer trunk ID"],
    enterprise: ["Enterprise name", "Customer", "Partner"],
    name: ["Trunk", "Customer trunk", "Customer trunk name", "Account name"],
    username: ["SMPP username", "SMPP user", "Username", "User name", "Login"],
    password: ["SMPP password", "Pass"],
    hostIps: ["Allowed IP", "Host IP", "Host IPs", "IP", "IPs", "IP whitelist", "Whitelist"],
    sslType: ["SSL type", "TLS", "Encryption"],
    protocol: ["Bind protocol"],
    tps: ["Throughput", "Max TPS"],
    category: ["Product", "Category"],
    billingType: ["Billed on", "Charge on"],
  },
  vendor_trunks: {
    externalId: ["ID", "Trunk ID", "Vendor trunk ID"],
    enterprise: ["Enterprise name", "Vendor", "Partner"],
    name: ["Trunk", "Vendor trunk", "Vendor trunk name", "Account name"],
    host: ["SMSC", "Server", "Host IP", "IP", "Address"],
    port: ["SMPP port"],
    username: ["SMPP username", "SMPP user", "Username", "User name", "Login"],
    password: ["SMPP password", "Pass"],
    protocol: ["Bind protocol"],
    tps: ["Throughput", "Max TPS"],
    category: ["Product", "Category"],
    billingType: ["Billed on", "Charge on"],
  },
  rate_tables: {
    externalId: ["ID", "Table ID", "Rate table ID"],
    name: ["Table", "Table name", "Rate table", "Rate table name"],
    kind: ["Type", "Side"],
    currency: ["CCY"],
    category: ["Product", "Category"],
    vendorTrunk: ["Vendor trunk name"],
    customerTrunks: ["Customer trunk", "Trunks"],
  },
  rate_lines: {
    rateTable: ["Rate table name", "Table", "Table name"],
    mccmnc: ["MCC MNC", "MCC/MNC", "Code"],
    senderId: ["Sender"],
    rate: ["Price", "Sell rate", "Buy rate"],
    validFrom: ["From date", "From date (UTC)", "Effective date", "Effective from", "Valid from date"],
    blocked: ["Block", "Is blocked"],
  },
  route_rules: {
    externalId: ["ID", "Rule ID", "Route rule ID"],
    name: ["Rule", "Rule name", "Route rule"],
    priority: ["Prio", "Order"],
    status: ["State"],
    customerTrunks: ["Customer trunk", "Customers"],
    destinations: ["Destination", "MCCMNC", "MCCMNCs"],
    vendors: ["Vendor", "Vendor trunks"],
  },
  opening_balances: {
    enterprise: ["Enterprise name", "Partner"],
    side: ["Account type", "Kind", "Type"],
    amount: ["Balance", "Opening balance"],
    currency: ["CCY"],
    date: ["As of", "As of date", "Balance date"],
  },
};

/**
 * Other ways a file writes a choice (team trial round 11: "Active" for active failed Apply). Values are compared
 * loosely like headers ("Tier 1" = tier1, "TLS 1.2" = tls1.2); these are the other words for them.
 */
export const CHOICE_SYNONYMS: Record<string, string[]> = {
  active: ["Enabled", "Enable", "On", "Live"],
  inactive: ["Disabled", "Disable", "Off", "Suspended"],
  customer: ["Client", "Sell", "Customers"],
  vendor: ["Supplier", "Provider", "Buy", "Vendors"],
  reciprocal: ["Bilateral", "Both", "Customer and vendor", "Customer & vendor", "Customer/Vendor"],
  tier1: ["1", "T1"],
  tier2: ["2", "T2"],
  tier3: ["3", "T3"],
  yes: ["Y", "True", "1", "X"],
  no: ["N", "False", "0"],
  none: ["No", "Off", "Plain", "No TLS", "No SSL"],
  attempt: ["Attempts", "Attempted"],
  submit: ["Submitted", "Submit SM"],
  reported: ["Report", "Reports"],
  delivery: ["Delivered", "DLR"],
};

/** Tables of a full export package, with sensitivity. Columns matching CREDENTIAL go only with credentials. */
export interface ExportTable {
  entity: string;
  sensitivity: MigrationSensitivity;
  from: string;
  /** Only live records (no archived ones). */
  live?: boolean;
  /** Only rows whose parent record is exported too (column -> parent table). */
  parents?: Record<string, string>;
}
export const EXPORT_TABLES: ExportTable[] = [
  { entity: "countries", sensitivity: "general", from: "countries", live: true },
  { entity: "mccmnc", sensitivity: "general", from: "mccmnc", live: true },
  { entity: "product_categories", sensitivity: "general", from: "product_categories", live: true },
  { entity: "number_lists", sensitivity: "general", from: "number_lists", live: true },
  {
    entity: "number_list_entries",
    sensitivity: "general",
    from: "number_list_entries",
    live: true,
    parents: { number_list_id: "number_lists" },
  },
  { entity: "business_companies", sensitivity: "business", from: "business_companies" },
  { entity: "departments", sensitivity: "business", from: "departments", live: true },
  { entity: "access_groups", sensitivity: "business", from: "access_groups", live: true },
  { entity: "users", sensitivity: "business", from: "users", live: true },
  { entity: "enterprises", sensitivity: "business", from: "enterprises", live: true },
  {
    entity: "enterprise_contacts",
    sensitivity: "business",
    from: "enterprise_contacts",
    parents: { enterprise_id: "enterprises" },
  },
  {
    entity: "customer_trunks",
    sensitivity: "business",
    from: "customer_trunks",
    live: true,
    parents: { enterprise_id: "enterprises" },
  },
  {
    entity: "vendor_trunks",
    sensitivity: "business",
    from: "vendor_trunks",
    live: true,
    parents: { enterprise_id: "enterprises" },
  },
  { entity: "rate_tables", sensitivity: "business", from: "rate_tables", live: true },
  {
    entity: "customer_trunk_rate_tables",
    sensitivity: "business",
    from: "customer_trunk_rate_tables",
    parents: { customer_trunk_id: "customer_trunks", rate_table_id: "rate_tables" },
  },
  { entity: "rate_lines", sensitivity: "business", from: "rate_lines", parents: { rate_table_id: "rate_tables" } },
  { entity: "translation_rules", sensitivity: "business", from: "translation_rules", live: true },
  {
    entity: "translation_rule_targets",
    sensitivity: "business",
    from: "translation_rule_targets",
    parents: { translation_rule_id: "translation_rules" },
  },
  { entity: "hlr_providers", sensitivity: "business", from: "hlr_providers", live: true },
  { entity: "hlr_rules", sensitivity: "business", from: "hlr_rules", live: true },
  { entity: "route_rules", sensitivity: "business", from: "route_rules", live: true },
  {
    entity: "route_rule_vendors",
    sensitivity: "business",
    from: "route_rule_vendors",
    parents: { route_rule_id: "route_rules", vendor_trunk_id: "vendor_trunks" },
  },
  {
    entity: "enterprise_billing",
    sensitivity: "financial",
    from: "enterprise_billing",
    parents: { enterprise_id: "enterprises" },
  },
  {
    entity: "transactions",
    sensitivity: "financial",
    from: "transactions",
    live: true,
    parents: { enterprise_id: "enterprises" },
  },
];
/** Connection details (§13.22 credentials level): only with "include credentials". */
export const CREDENTIAL = /^(username|host|host_ips|port|source_host|http_url|smtp_|imap_|api_|login|endpoint|url)/;
/** Passwords and keys: only with credentials and "with passwords". */
export const SECRET = /(password|secret|api_key|token)/;
/** Never exported: login secrets of our own users (§13.28: not kept in any file). */
export const NEVER = /^(password_hash|totp_secret|totp_pending_secret|temp_password.*)$/;
