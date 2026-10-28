// Search or jump to (Ctrl K) order by role (team trial round 6, §15.1): with an empty search box the pages a role
// uses most come first, in this order; the rest follow alphabetically. The role is the user's access group name,
// matched by the first keyword it contains, so renamed groups ("NOC Engineer – night") still match.
const BY_ROLE: { match: RegExp; pages: string[] }[] = [
  {
    match: /noc/i,
    pages: [
      "dashboard",
      "live-analytics",
      "edr-search",
      "incidents",
      "network-status",
      "route-rules",
      "simulator",
      "customer-trunks",
      "vendor-trunks",
      "diagnosis",
      "failed-edr",
      "repush",
      "noc-report",
      "alert-rules",
    ],
  },
  {
    match: /rate/i,
    pages: [
      "rate-manager",
      "incoming-rns",
      "rn-report",
      "rate-lookup",
      "bulk",
      "market-moves",
      "route-rules",
      "lcr",
      "margin-calculator",
      "live-analytics",
      "enterprises",
      "re-rating",
      "dashboard",
    ],
  },
  {
    match: /financ|billing|account(ing|ant)/i,
    pages: [
      "invoices",
      "transactions",
      "balances",
      "soa",
      "vendor-invoices",
      "billing-report",
      "soa-report",
      "charges",
      "currencies",
      "enterprises",
      "billing-cycles",
      "master-report",
    ],
  },
  {
    match: /account manager|sales|\bam\b/i,
    pages: [
      "enterprise-report",
      "enterprises",
      "live-analytics",
      "rate-lookup",
      "sales-report",
      "customer-trunks",
      "dashboard",
      "incoming-rns",
      "rn-report",
      "margin-calculator",
      "edr-search",
    ],
  },
  {
    match: /admin|manager|director|head/i,
    pages: [
      "dashboard",
      "live-analytics",
      "enterprises",
      "route-rules",
      "rate-manager",
      "edr-search",
      "master-report",
      "team-report",
      "invoices",
      "users",
      "change-history",
      "incidents",
    ],
  },
];

const DEFAULT = ["dashboard", "live-analytics", "enterprises", "route-rules", "rate-manager", "edr-search"];

/** The page keys a role uses most, most important first. */
export function rolePages(role: string | undefined): string[] {
  return BY_ROLE.find((r) => role && r.match.test(role))?.pages ?? DEFAULT;
}
