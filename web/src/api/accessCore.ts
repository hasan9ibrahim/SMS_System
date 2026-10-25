// What the signed-in user may open (§11, team trial round 2): the GUI access group plus the user's own
// overrides, as /me sends them. "*" = everything, "action" = that action on every page, "page:action" =
// one page, "!page" = no access to the page whatever else applies. hiddenTabs lists "page.tab" keys.
// The Elixir API enforces the same rules on every call (backend step 10); here they hide what the user may not open.
/** Pages everyone may open: Home and the Help center. */
const OPEN = new Set(["home", "help"]);
/**
 * Admin pages (contract/access.json admin): administrators only, unless the access group names the page itself; an
 * every-page action ("view") never covers them (product owner 2026-10-25, backend step 10).
 */
export const ADMIN_PAGES: ReadonlySet<string> = new Set([
  "change-history",
  "users",
  "access-groups",
  "visibility",
  "departments",
  "business-companies",
  "logged-in",
  "audit",
  "email-templates",
  "security",
  "cleanup",
  "migration",
  "customer-portal",
]);

export function can(permissions: readonly string[] | undefined, page: string, action = "view"): boolean {
  if (OPEN.has(page) && action === "view") return true;
  // Until /me arrives nothing is hidden, so the shell doesn't flash.
  if (!permissions) return true;
  if (permissions.includes("*")) return true;
  if (permissions.includes(`!${page}`)) return false;
  return (!ADMIN_PAGES.has(page) && permissions.includes(action)) || permissions.includes(`${page}:${action}`);
}
