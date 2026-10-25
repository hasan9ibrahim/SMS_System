// Jump-to search for Ctrl K (§15.1): records by name, alias, username or ID.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SearchHit, SearchResults } from "@sms/contract";
import { withDb } from "../db.js";
import { searchPattern } from "../lists/engine.js";
import { currentViewer } from "../visibility/context.js";
import { viewer as pageViewer } from "../auth/access.js";
import { byEnterprise, enterpriseLabel, lit, maskName, resolveSql, vis } from "../visibility/sql.js";

// Masked names (§13.17) are what the viewer searches: another AM's enterprise is found as "Customer #12".
const E_NAME = vis(maskName("e.name", "e.id", byEnterprise("e.id"), enterpriseLabel("e.type")));
const E_ALIAS = vis(maskName("e.alias", "e.id", byEnterprise("e.id"), enterpriseLabel("e.type")));
const CT_NAME = vis(maskName("t.name", "t.id", byEnterprise("t.enterprise_id"), lit("Customer trunk")));
const VT_NAME = vis(maskName("t.name", "t.id", byEnterprise("t.enterprise_id"), lit("Vendor trunk")));
const USERNAME = (label: string) => vis(maskName("t.username", "t.id", byEnterprise("t.enterprise_id"), lit(label)));
const RT_NAME = vis(
  maskName(
    "r.name",
    "r.id",
    `(CASE WHEN r.kind = 'vendor'
       THEN (SELECT ovt.enterprise_id FROM vendor_trunks ovt WHERE ovt.id = r.vendor_trunk_id) = ANY($OWN)
       ELSE EXISTS (SELECT 1 FROM customer_trunk_rate_tables ox JOIN customer_trunks oct ON oct.id = ox.customer_trunk_id
                     WHERE ox.rate_table_id = r.id AND oct.enterprise_id = ANY($OWN)) END)`,
    lit("Rate table"),
  ),
);

export function search(request: FastifyRequest, reply: FastifyReply) {
  const { q, limit = 20 } = request.query as { q: string; limit?: number };
  const text = q.trim();
  return withDb(reply, async (pool): Promise<SearchResults> => {
    const viewer = await currentViewer();
    // Only records of pages the user may open (backend step 10): a page not given is not reached from the search.
    const { canView } = await pageViewer();
    // $1 pattern, $2 raw text (exact ID and prefix ranking), $3 per-kind limit.
    const parts: [string, string][] = [
      [
        "enterprises",
        `SELECT 'enterprise' AS kind, e.id, ${E_NAME} || ' – ' || ${E_ALIAS} || ' (' || e.id || ')' AS label,
                 initcap(e.type) || ' · Tier ' || right(e.tier, 1) AS detail, ${E_NAME} AS sort_name
            FROM enterprises e
           WHERE e.deleted_at IS NULL AND (${E_NAME} ILIKE $1 OR ${E_ALIAS} ILIKE $1 OR e.id::text = $2) LIMIT $3`,
      ],
      [
        "customer-trunks",
        `SELECT 'customer_trunk' AS kind, t.id, ${CT_NAME} AS label, 'Customer trunk · ' || ${E_NAME} AS detail,
                 ${CT_NAME} AS sort_name
            FROM customer_trunks t JOIN enterprises e ON e.id = t.enterprise_id
           WHERE t.deleted_at IS NULL AND (${CT_NAME} ILIKE $1 OR ${USERNAME("Customer trunk")} ILIKE $1 OR t.id::text = $2) LIMIT $3`,
      ],
      [
        "vendor-trunks",
        `SELECT 'vendor_trunk' AS kind, t.id, ${VT_NAME} AS label, 'Vendor trunk · ' || ${E_NAME} AS detail,
                 ${VT_NAME} AS sort_name
            FROM vendor_trunks t JOIN enterprises e ON e.id = t.enterprise_id
           WHERE t.deleted_at IS NULL AND (${VT_NAME} ILIKE $1 OR ${USERNAME("Vendor trunk")} ILIKE $1 OR t.id::text = $2) LIMIT $3`,
      ],
      [
        "rate-manager",
        `SELECT 'rate_table' AS kind, r.id, ${RT_NAME} AS label, initcap(r.kind) || ' rate table · ' || r.currency AS detail,
                 ${RT_NAME} AS sort_name
            FROM rate_tables r WHERE r.deleted_at IS NULL AND (${RT_NAME} ILIKE $1 OR r.id::text = $2) LIMIT $3`,
      ],
      [
        "route-rules",
        `SELECT 'route_rule' AS kind, r.id, r.name AS label,
                 'Route rule · priority ' || r.priority || ' · ' || r.route_type AS detail, r.name AS sort_name
            FROM route_rules r WHERE r.deleted_at IS NULL AND (r.name ILIKE $1 OR r.id::text = $2) LIMIT $3`,
      ],
      [
        "users",
        `SELECT 'user' AS kind, u.id, u.first_name || ' ' || u.last_name AS label, 'User · ' || u.username AS detail,
                 u.username AS sort_name
            FROM users u
           WHERE u.deleted_at IS NULL
             AND (u.username ILIKE $1 OR (u.first_name || ' ' || u.last_name) ILIKE $1 OR u.id::text = $2) LIMIT $3`,
      ],
    ];
    const allowed = parts.filter(([page]) => canView(page)).map(([, sql]) => `(${sql})`);
    if (!allowed.length) return { hits: [] };
    const { rows } = await pool.query(
      resolveSql(
        `SELECT kind, id, label, detail FROM (
         ${allowed.join("\n         UNION ALL\n         ")}
       ) hits
       ORDER BY (id::text = $2) DESC, (sort_name ILIKE $2 || '%') DESC, length(sort_name), sort_name
       LIMIT $3`,
        viewer,
      ),
      [searchPattern(text), text, limit],
    );
    return { hits: rows as SearchHit[] };
  });
}
