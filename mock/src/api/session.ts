// The signed-in user, UI preferences and open tabs (§3, §13.5, §15.2).
// Sign-in arrives with §13.28; until then the mock acts as one seeded user.
import { effectiveAccess } from "../admin/catalog.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { AlertSoundPrefs, CurrentUser, DashboardSettings, PreferencesUpdate, Workspace } from "@sms/contract";
import { db, withDb } from "../db.js";

/** Alert sounds (§13.6): one per severity, Critical repeats until acknowledged. */
export const DEFAULT_ALERT_SOUNDS: AlertSoundPrefs = { mute: false, info: "ping", warning: "chime", critical: "siren" };

/** Live dashboard defaults (§13.3): 15-minute window, ±30 %, 15-minute chart, live refresh, every panel. */
export const DEFAULT_DASHBOARD: DashboardSettings = {
  windowMinutes: 15,
  thresholdPct: 30,
  chartMinutes: 15,
  refreshSeconds: 1,
  hiddenPanels: [],
};

/** The fake user the mock signs in as (user 1 is a seeded administrator). */
export const CURRENT_USER_ID = Number(process.env.MOCK_USER_ID ?? 1);

// Used when the database is not running, so the shell still renders (CLAUDE.md rule 1: fake).
export const demoUser: CurrentUser = {
  id: CURRENT_USER_ID,
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
  },
  permissions: ["*"],
  hiddenTabs: [],
};

export async function loadUser(pool: pg.Pool, id: number): Promise<CurrentUser | null> {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.first_name, u.last_name, u.is_admin, u.theme, u.open_in_new_tab, u.animations, u.dashboard_settings, u.alert_sounds,
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
      dashboard: { ...DEFAULT_DASHBOARD, ...(r.dashboard_settings ?? {}) },
      alertSounds: { ...DEFAULT_ALERT_SOUNDS, ...(r.alert_sounds ?? {}) },
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
  try {
    return (await loadUser(db(), CURRENT_USER_ID)) ?? demoUser;
  } catch {
    return demoUser;
  }
}

export function updatePreferences(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as PreferencesUpdate;
  return withDb(reply, async (pool) => {
    await pool.query(
      `UPDATE users SET theme = COALESCE($2, theme), open_in_new_tab = COALESCE($3, open_in_new_tab),
              animations = COALESCE($4, animations), dashboard_settings = COALESCE($5, dashboard_settings),
              alert_sounds = COALESCE($6, alert_sounds), updated_at = now() WHERE id = $1`,
      [
        CURRENT_USER_ID,
        body.theme ?? null,
        body.openInNewTab ?? null,
        body.animations ?? null,
        body.dashboard ? JSON.stringify(body.dashboard) : null,
        body.alertSounds ? JSON.stringify(body.alertSounds) : null,
      ],
    );
    return (await loadUser(pool, CURRENT_USER_ID)) ?? demoUser;
  });
}

export function getWorkspace(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool): Promise<Workspace> => {
    const { rows } = await pool.query("SELECT tabs, active_tab_id FROM user_workspaces WHERE user_id = $1", [
      CURRENT_USER_ID,
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
      [CURRENT_USER_ID, JSON.stringify(ws.tabs), ws.activeTabId],
    );
    return ws;
  });
}
