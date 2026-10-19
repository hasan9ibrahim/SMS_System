// Account manager visibility (§13.17): policies, presets, and a user's effective policy with the
// enterprises that count as their own (managed, team, shared or temporarily granted, and for cost the
// vendors that carried their clients' traffic).
import type pg from "pg";
import type {
  EffectiveVisibility,
  VisibilityGrant,
  VisibilityItems,
  VisibilityPolicyFields,
  VisibilityPolicyRow,
  VisibilityPreset,
} from "@sms/contract";

export type VisItem = keyof VisibilityItems;
export const ITEMS: VisItem[] = ["margin", "revenue", "cost", "sellRates", "balances", "contacts", "traffic"];
export const ITEM_LABELS: Record<VisItem, string> = {
  margin: "margin",
  revenue: "revenue",
  cost: "cost",
  sellRates: "sell rates",
  balances: "balances",
  contacts: "contacts",
  traffic: "traffic",
};

const items = (others: Partial<Record<VisItem, string>>, own: Partial<Record<VisItem, string>> = {}) =>
  Object.fromEntries(ITEMS.map((k) => [k, { others: others[k] ?? "show", own: own[k] ?? "show" }])) as VisibilityItems;

/** Ready presets (§13.17); the same three are seeded by migration 029. */
export const PRESETS: VisibilityPreset[] = [
  {
    key: "strict_am",
    fields: {
      name: "Strict AM",
      description: "Others masked, all money hidden",
      status: "active",
      maskOthers: true,
      includeTeam: false,
      items: items(
        { margin: "hide", revenue: "hide", cost: "hide", sellRates: "hide", balances: "hide", contacts: "hide" },
        { margin: "hide", revenue: "hide", cost: "hide", balances: "hide" },
      ),
      thresholds: { marginLowPct: 5, marginHighPct: 20, revenueHideAbove: null, costTrafficDays: null },
    },
  },
  {
    key: "standard_am",
    fields: {
      name: "Standard AM",
      description: "Others masked, own money shown",
      status: "active",
      maskOthers: true,
      includeTeam: false,
      items: items({
        margin: "hide",
        revenue: "hide",
        cost: "hide",
        sellRates: "hide",
        balances: "hide",
        contacts: "hide",
      }),
      thresholds: { marginLowPct: 5, marginHighPct: 20, revenueHideAbove: null, costTrafficDays: 30 },
    },
  },
  {
    key: "team_lead",
    fields: {
      name: "Team lead",
      description: "Team shown, others masked",
      status: "active",
      maskOthers: true,
      includeTeam: true,
      items: items({
        margin: "band",
        revenue: "hide",
        cost: "hide",
        sellRates: "hide",
        balances: "hide",
        contacts: "hide",
      }),
      thresholds: { marginLowPct: 5, marginHighPct: 20, revenueHideAbove: null, costTrafficDays: 30 },
    },
  },
];

/** One line for the list: "Others masked · hides margin, revenue · margin of others as bands". */
export function policySummary(p: Pick<VisibilityPolicyFields, "maskOthers" | "includeTeam" | "items">): string {
  const hidden = ITEMS.filter((k) => p.items[k].others === "hide" || p.items[k].own === "hide");
  const banded = ITEMS.filter((k) => p.items[k].others === "band" || p.items[k].own === "band");
  return [
    p.maskOthers ? "Others masked" : "Names shown",
    p.includeTeam ? "team counts as own" : null,
    hidden.length ? `hides ${hidden.map((k) => ITEM_LABELS[k]).join(", ")}` : "hides nothing",
    banded.length ? `${banded.map((k) => ITEM_LABELS[k]).join(", ")} as bands` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export const POLICY_SELECT = `p.id, p.name, p.description, p.status, p.mask_others, p.include_team, p.items, p.thresholds,
  ub.username AS updated_by, p.updated_at, p.deleted_at,
  (SELECT count(*)::int FROM visibility_assignments a WHERE a.policy_id = p.id) AS assignments`;
export const POLICY_FROM = "visibility_policies p LEFT JOIN users ub ON ub.id = p.updated_by_id";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

export function mapPolicy(r: Record<string, unknown>): VisibilityPolicyRow {
  const items = r.items as VisibilityItems;
  const p = {
    id: Number(r.id),
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    status: r.status as VisibilityPolicyRow["status"],
    maskOthers: r.mask_others as boolean,
    includeTeam: r.include_team as boolean,
    items,
    thresholds: r.thresholds as VisibilityPolicyRow["thresholds"],
    assignments: Number(r.assignments ?? 0),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
  return { ...p, summary: policySummary(p) };
}

export const GRANT_SELECT = `g.id, g.user_id, (u.first_name || ' ' || u.last_name) AS user_name, g.enterprise_id,
  e.name AS enterprise_name, g.expires_at, g.reason, gb.username AS granted_by, g.inserted_at, g.revoked_at,
  CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked' WHEN g.expires_at IS NOT NULL AND g.expires_at <= now() THEN 'expired'
       ELSE 'active' END AS state`;
export const GRANT_FROM = `visibility_grants g JOIN users u ON u.id = g.user_id JOIN enterprises e ON e.id = g.enterprise_id
  LEFT JOIN users gb ON gb.id = g.granted_by_id`;

export function mapGrant(r: Record<string, unknown>): VisibilityGrant {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    userName: r.user_name as string,
    enterpriseId: Number(r.enterprise_id),
    enterpriseName: r.enterprise_name as string,
    kind: r.expires_at == null ? "share" : "temporary",
    expiresAt: iso(r.expires_at),
    reason: r.reason as string,
    state: r.state as VisibilityGrant["state"],
    grantedBy: (r.granted_by as string | null) ?? null,
    createdAt: iso(r.inserted_at)!,
    revokedAt: iso(r.revoked_at),
  };
}

/** A user's effective visibility, with the enterprise IDs the SQL rules test against. */
export interface Viewer extends EffectiveVisibility {
  /** Own enterprises: managed, team (when the policy includes it) and granted. */
  own: number[];
  /** Own for cost and buy rates: own plus the vendors that carried own clients' traffic. */
  costOwn: number[];
}

/** True when the viewer's policy masks or hides anything. */
export const restricts = (v: Viewer | null | undefined): v is Viewer & { policy: VisibilityPolicyRow } =>
  !!v && !v.exempt && !!v.policy;

const ids = (rows: { id: unknown }[]) => rows.map((r) => Number(r.id));

export async function loadViewer(pool: pg.Pool, userId: number, viewAs = false): Promise<Viewer | null> {
  const { rows: u } = await pool.query(
    `SELECT id, first_name || ' ' || last_name AS name, is_admin, is_account_manager, department_id
       FROM users WHERE id = $1`,
    [userId],
  );
  const user = u[0];
  if (!user) return null;
  const base = {
    userId,
    userName: user.name as string,
    viewAs,
    ownEnterprises: 0,
    teamEnterprises: 0,
    grantedEnterprises: 0,
    costVendors: 0,
    grants: [] as VisibilityGrant[],
    own: [] as number[],
    costOwn: [] as number[],
  };
  const { rows: g } = await pool.query(
    `SELECT ${GRANT_SELECT} FROM ${GRANT_FROM} WHERE g.user_id = $1 AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > now()) ORDER BY g.id`,
    [userId],
  );
  base.grants = g.map(mapGrant);
  if (user.is_admin)
    return { ...base, exempt: true, exemptReason: "Administrator", policy: null, source: null, sourceName: null };
  const { rows: a } = await pool.query(
    `SELECT ${POLICY_SELECT}, a.target_type, d.name AS department
       FROM visibility_assignments a JOIN ${POLICY_FROM} ON p.id = a.policy_id
       LEFT JOIN departments d ON a.target_type = 'department' AND d.id = a.target_id
      WHERE p.deleted_at IS NULL AND p.status = 'active'
        AND ((a.target_type = 'user' AND a.target_id = $1) OR (a.target_type = 'department' AND a.target_id = $2)
             OR (a.target_type = 'all_ams' AND $3))
      ORDER BY CASE a.target_type WHEN 'user' THEN 0 WHEN 'department' THEN 1 ELSE 2 END LIMIT 1`,
    [userId, user.department_id, user.is_account_manager],
  );
  const hit = a[0];
  if (!hit)
    return { ...base, exempt: true, exemptReason: "No policy assigned", policy: null, source: null, sourceName: null };
  const policy = mapPolicy(hit);
  const source = hit.target_type as "user" | "department" | "all_ams";
  const sourceName =
    source === "user"
      ? "Assigned to the user"
      : source === "department"
        ? `Department ${hit.department}`
        : "All account managers";

  const own = ids(
    (await pool.query("SELECT id FROM enterprises WHERE account_manager_id = $1 AND deleted_at IS NULL", [userId]))
      .rows,
  );
  const team = policy.includeTeam
    ? ids(
        (
          await pool.query(
            `WITH RECURSIVE team AS (SELECT id FROM users WHERE manager_id = $1 AND id <> $1
               UNION SELECT u.id FROM users u JOIN team t ON u.manager_id = t.id)
             SELECT e.id FROM enterprises e JOIN team t ON t.id = e.account_manager_id WHERE e.deleted_at IS NULL`,
            [userId],
          )
        ).rows,
      )
    : [];
  const granted = base.grants.map((x) => x.enterpriseId);
  const all = [...new Set([...own, ...team, ...granted])].sort((x, y) => x - y);
  let costExtra: number[] = [];
  const days = policy.thresholds.costTrafficDays;
  if (days && all.length) {
    // Imported here: edr.ts sits in an import cycle with the list definitions.
    const { chRows } = await import("../edr.js");
    const rows = await chRows<{ id: number }>(
      `SELECT DISTINCT v_enterprise_id AS id FROM edr_hourly
        WHERE hour >= now() - INTERVAL ${Math.floor(days)} DAY AND c_enterprise_id IN (${all.join(",")}) AND v_enterprise_id > 0`,
      5000,
    );
    costExtra = (rows ?? []).map((r) => Number(r.id)).filter((id) => !all.includes(id));
  }
  return {
    ...base,
    exempt: false,
    exemptReason: null,
    policy,
    source,
    sourceName,
    ownEnterprises: own.length,
    teamEnterprises: team.filter((id) => !own.includes(id)).length,
    grantedEnterprises: granted.filter((id) => !own.includes(id) && !team.includes(id)).length,
    costVendors: costExtra.length,
    own: all,
    costOwn: [...all, ...costExtra].sort((x, y) => x - y),
  };
}

/** The contract shape (without the internal ID lists). */
export function effective(v: Viewer): EffectiveVisibility {
  const { own: _own, costOwn: _cost, ...rest } = v;
  return rest;
}

// Viewers are cached briefly; any visibility write clears the cache.
const cache = new Map<string, { at: number; v: Promise<Viewer | null> }>();
const TTL_MS = 30_000;
export function cachedViewer(pool: pg.Pool, userId: number, viewAs: boolean): Promise<Viewer | null> {
  const key = `${userId}:${viewAs}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const v = loadViewer(pool, userId, viewAs).catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { at: Date.now(), v });
  return v;
}
export function clearVisibilityCache(): void {
  cache.clear();
}
