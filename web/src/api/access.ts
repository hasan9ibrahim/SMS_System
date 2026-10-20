// What the signed-in user may open (§11, team trial round 2): the GUI access group plus the user's own
// overrides, as /me sends them. "*" = everything, "action" = that action on every page, "page:action" =
// one page, "!page" = no access to the page whatever else applies. hiddenTabs lists "page.tab" keys.
// The real backend enforces the same rules on the API; the mock only hides things in the GUI.
import { useMe } from "./hooks";
import { can } from "./accessCore";

export { can };

export function useCan(page: string, action = "view"): boolean {
  const { data: me } = useMe();
  return can(me?.permissions, page, action);
}

/** Predicate over page keys, for filtering menus. */
export function useCanView(): (page: string) => boolean {
  const { data: me } = useMe();
  return (page) => can(me?.permissions, page);
}

/** Predicate: is tab or form section "page.tab" shown to this user? */
export function useTabShown(): (key: string) => boolean {
  const { data: me } = useMe();
  const hidden = new Set(me?.hiddenTabs ?? []);
  return (key) => !hidden.has(key);
}
