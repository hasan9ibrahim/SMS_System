// Which pages the current user may open (§1, §11), for answers that mix records of several pages: the global search,
// a record's change history and the name-only lookups (backend step 10). The Elixir API checks every call by its
// page (contract/generated/operations.json); this applies the same rules inside such answers.
//
// Product owner 2026-10-25: a page the user may not open is not reached from another page either; Admin pages are
// for administrators only, unless the access group names the page itself (the group's Every page grant never
// covers them).
import { readFileSync } from "node:fs";
import type { CurrentUser } from "@sms/contract";
import { getCurrentUser } from "../api/session.js";

const access = JSON.parse(readFileSync(new URL("../../../contract/access.json", import.meta.url), "utf8")) as {
  admin: string[];
  lookups?: Record<string, string[]>;
};

/** The Admin section's pages (contract/access.json admin). */
export const ADMIN_PAGES: ReadonlySet<string> = new Set(access.admin);

/** Whether permissions as /me sends them allow the action on the page (web/src/api/accessCore.ts can). */
export function allows(permissions: readonly string[], page: string, action = "view"): boolean {
  if (permissions.includes("*")) return true;
  if (permissions.includes(`!${page}`)) return false;
  return (!ADMIN_PAGES.has(page) && permissions.includes(action)) || permissions.includes(`${page}:${action}`);
}

/**
 * The page of each change-history entity type: a change is listed and undone only by users who may open (and, to
 * undo, edit) that page. A type not named here is shown to administrators only.
 */
export const ENTITY_PAGES: Readonly<Record<string, string>> = {
  access_group: "access-groups",
  alert_rule: "alert-rules",
  billing_cycle: "billing-cycles",
  business_company: "business-companies",
  business_company_file: "business-companies",
  cleanup: "cleanup",
  country: "countries",
  currency: "currencies",
  customer_trunk: "customer-trunks",
  vendor_trunk: "vendor-trunks",
  daily_traffic_alert: "daily-traffic",
  department: "departments",
  destination: "mccmnc",
  dial_code: "master-table",
  dial_code_profile: "master-table",
  edr_template: "edr-templates",
  email_template: "email-templates",
  enterprise: "enterprises",
  enterprise_doc: "enterprises",
  firewall_filter: "firewall",
  firewall_rule: "firewall",
  hlr_policy: "hlr",
  hlr_provider: "hlr",
  hlr_provider_rate: "hlr",
  hlr_rule: "hlr",
  invoice: "invoices",
  lcr_profile: "lcr",
  migration: "migration",
  mo_number: "mo-book",
  number_list: "number-lists",
  number_list_entry: "number-lists",
  portal_user: "customer-portal",
  portal_user_password: "customer-portal",
  product_category: "categories",
  qbr_stat: "qbr-stats",
  rate_table: "rate-manager",
  recon_rule: "vendor-invoices",
  rerating_request: "re-rating",
  route_rule: "route-rules",
  scheduled_report: "scheduled",
  security_settings: "security",
  sms_voice_rule: "sms-to-voice",
  soa_adjustment: "soa",
  traffic_alert: "traffic-alerts",
  transaction: "transactions",
  translation_rule: "translation-rules",
  user: "users",
  user_password: "users",
  user_totp: "users",
  vendor_invoice: "vendor-invoices",
  visibility_policy: "visibility",
};

/** The current user's View check, for one request. */
export async function viewer(): Promise<{
  user: CurrentUser;
  canView: (page: string) => boolean;
  can: (page: string, action: string) => boolean;
}> {
  const user = await getCurrentUser();
  return {
    user,
    canView: (page) => allows(user.permissions, page),
    can: (page, action) => allows(user.permissions, page, action),
  };
}

/** The change-history entity types the user may see (null: every type, for administrators). */
export function visibleEntityTypes(user: CurrentUser): string[] | null {
  if (user.permissions.includes("*")) return null;
  return Object.entries(ENTITY_PAGES)
    .filter(([, page]) => allows(user.permissions, page))
    .map(([type]) => type);
}

/** The pages that may use a lookup kind (contract/access.json lookups). */
export const lookupPages = (kind: string): string[] => access.lookups?.[kind] ?? [];
