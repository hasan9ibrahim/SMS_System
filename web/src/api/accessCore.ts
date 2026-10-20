// What the signed-in user may open (§11, team trial round 2): the GUI access group plus the user's own
// overrides, as /me sends them. "*" = everything, "action" = that action on every page, "page:action" =
// one page, "!page" = no access to the page whatever else applies. hiddenTabs lists "page.tab" keys.
// The real backend enforces the same rules on the API; the mock only hides things in the GUI.
/** Pages everyone may open: Home and the Help center. */
const OPEN = new Set(["home", "help"]);

export function can(permissions: readonly string[] | undefined, page: string, action = "view"): boolean {
  if (OPEN.has(page) && action === "view") return true;
  // Until /me arrives nothing is hidden, so the shell doesn't flash.
  if (!permissions) return true;
  if (permissions.includes("*")) return true;
  if (permissions.includes(`!${page}`)) return false;
  return permissions.includes(action) || permissions.includes(`${page}:${action}`);
}
