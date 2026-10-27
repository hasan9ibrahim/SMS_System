// The signed-in user, UI preferences and open tabs (§3, §13.5, §15.2).
// Sign-in arrives with §13.28; until then the mock acts as one seeded user.
import { effectiveAccess } from "../admin/catalog.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { AlertSoundPrefs, CurrentUser, DashboardSettings, PreferencesUpdate, Workspace } from "@sms/contract";
import { db, withDb } from "../db.js";

/** Alert sounds (§13.6): one per severity, Critical repeats until acknowledged. */
export const DEFAULT_ALERT_SOUNDS: AlertSoundPrefs = { mute: false, info: "ping", warning: "chime", critical: "siren" };

/**
 * Live dashboard defaults (§13.3): 15-minute window, movers from 100 messages per card (team trial round 2),
 * 15-minute chart, live refresh, every panel in the default layout.
 */
export const DEFAULT_DASHBOARD: DashboardSettings = {
  windowMinutes: 15,
  customerMinMessages: 100,
  vendorMinMessages: 100,
  chartMinutes: 15,
  refreshSeconds: 1,
  hiddenPanels: [],
  layout: [],
};

/** Saved settings on today's defaults: keys from older versions (the ± threshold) are dropped. */
export function dashboardSettings(saved: Record<string, unknown> | null): DashboardSettings {
  const out: Record<string, unknown> = { ...DEFAULT_DASHBOARD };
  for (const k of Object.keys(DEFAULT_DASHBOARD)) if (saved && saved[k] !== undefined) out[k] = saved[k];
  return out as unknown as DashboardSettings;
}

/** The user of the current request (src/auth/user.ts). */
export { currentUserId } from "../auth/user.js";
import { currentUserId, DEFAULT_USER_ID } from "../auth/user.js";
import { production } from "../mode.js";

// Used when the database is not running, so the shell still renders (CLAUDE.md rule 1: fake).
export const demoUser: CurrentUser = {
  id: DEFAULT_USER_ID,
  username: "demo.admin",
  displayName: "Demo Admin",
  initials: "DA",
  role: "Administrator",
  businessCompany: "Demo Carrier Ltd (fake)",
  preferences: {
    theme: "light",
    openInNewTab: true,
    animations: true,
    dashboard: DEFAULT_DASHBOARD,
    alertSounds: DEFAULT_ALERT_SOUNDS,
    liveAnalytics: { columns: [] },
    favouritePages: [],
  },
  permissions: ["*"],
  hiddenTabs: [],
};

export async function loadUser(pool: pg.Pool, id: number): Promise<CurrentUser | null> {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.first_name, u.last_name, u.is_admin, u.theme, u.open_in_new_tab, u.animations, u.dashboard_settings, u.alert_sounds, u.analytics_settings, u.favourite_pages,
            g.name AS access_group, g.permissions, g.hidden_tabs, u.permission_overrides, u.tab_overrides,
            bc.name AS business_company
       FROM users u
       LEFT JOIN access_groups g ON g.id = u.access_group_id
       LEFT JOIN business_companies bc ON bc.id = u.business_company_id
      WHERE u.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const access = effectiveAccess(
    (r.permissions as Record<string, string[]> | null) ?? {},
    (r.hidden_tabs as string[] | null) ?? [],
    (r.permission_overrides as Record<string, string[]> | null) ?? {},
    (r.tab_overrides as Record<string, boolean> | null) ?? {},
  );
  return {
    id: r.id,
    username: r.username,
    displayName: `${r.first_name} ${r.last_name}`,
    initials: `${r.first_name[0] ?? ""}${r.last_name[0] ?? ""}`.toUpperCase(),
    role: r.access_group ?? (r.is_admin ? "Administrator" : "User"),
    businessCompany: r.business_company ?? "",
    preferences: {
      theme: r.theme,
      openInNewTab: r.open_in_new_tab,
      animations: r.animations,
      dashboard: dashboardSettings(r.dashboard_settings),
      alertSounds: { ...DEFAULT_ALERT_SOUNDS, ...(r.alert_sounds ?? {}) },
      // Live analytics columns (team trial round 3, §13.4); empty = the default set.
      liveAnalytics: { columns: Array.isArray(r.analytics_settings?.columns) ? r.analytics_settings.columns : [] },
      // Ctrl K favourites (team trial round 6, §15.1).
      favouritePages: r.favourite_pages ?? [],
    },
    // GUI Access Group keys "page:action"; "*" = everything (§1). The user's own overrides apply on top;
    // "!page" = no access to that page whatever the group gives (team trial round 2).
    permissions: r.is_admin
      ? ["*"]
      : [
          ...Object.entries(access.permissions).flatMap(([page, actions]) =>
            actions.map((a) => (page === "*" ? a : `${page}:${a}`)),
          ),
          ...access.denied.map((page) => `!${page}`),
        ],
    hiddenTabs: r.is_admin ? [] : access.hiddenTabs,
  };
}

export function canUndoOthers(user: CurrentUser): boolean {
  return user.permissions.includes("*") || user.permissions.includes("undo_others");
}

export async function getCurrentUser(): Promise<CurrentUser> {
  // Production (backend step 11): never the demo administrator. A user that is not (or no longer) in the database
  // may do nothing, and a database error fails the request.
  if (production) return (await loadUser(db(), currentUserId())) ?? noAccessUser(currentUserId());
  try {
    return (await loadUser(db(), currentUserId())) ?? demoUser;
  } catch {
    return demoUser;
  }
}

const noAccessUser = (id: number): CurrentUser => ({
  ...demoUser,
  id,
  username: "unknown",
  displayName: "Unknown user",
  initials: "?",
  role: "User",
  businessCompany: "",
  permissions: [],
  hiddenTabs: [],
});

export function updatePreferences(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as PreferencesUpdate;
  return withDb(reply, async (pool) => {
    await pool.query(
      `UPDATE users SET theme = COALESCE($2, theme), open_in_new_tab = COALESCE($3, open_in_new_tab),
              animations = COALESCE($4, animations), dashboard_settings = COALESCE($5, dashboard_settings),
              alert_sounds = COALESCE($6, alert_sounds), analytics_settings = COALESCE($7, analytics_settings),
              favourite_pages = COALESCE($8, favourite_pages), updated_at = now() WHERE id = $1`,
      [
        currentUserId(),
        body.theme ?? null,
        body.openInNewTab ?? null,
        body.animations ?? null,
        body.dashboard ? JSON.stringify(body.dashboard) : null,
        body.alertSounds ? JSON.stringify(body.alertSounds) : null,
        body.liveAnalytics ? JSON.stringify(body.liveAnalytics) : null,
        body.favouritePages ?? null,
      ],
    );
    return (await loadUser(pool, currentUserId())) ?? demoUser;
  });
}

export function getWorkspace(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool): Promise<Workspace> => {
    const { rows } = await pool.query("SELECT tabs, active_tab_id FROM user_workspaces WHERE user_id = $1", [
      currentUserId(),
    ]);
    return rows[0] ? { tabs: rows[0].tabs, activeTabId: rows[0].active_tab_id } : { tabs: [], activeTabId: null };
  });
}

export function saveWorkspace(request: FastifyRequest, reply: FastifyReply) {
  const ws = request.body as Workspace;
  return withDb(reply, async (pool): Promise<Workspace> => {
    await pool.query(
      `INSERT INTO user_workspaces (user_id, tabs, active_tab_id, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET tabs = EXCLUDED.tabs, active_tab_id = EXCLUDED.active_tab_id, updated_at = now()`,
      [currentUserId(), JSON.stringify(ws.tabs), ws.activeTabId],
    );
    return ws;
  });
}
