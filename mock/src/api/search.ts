// Jump-to search for Ctrl K (§15.1): records by name, alias, username or ID.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SearchHit, SearchResults } from "@sms/contract";
import { withDb } from "../db.js";
import { searchPattern } from "../lists/engine.js";

export function search(request: FastifyRequest, reply: FastifyReply) {
  const { q, limit = 20 } = request.query as { q: string; limit?: number };
  const text = q.trim();
  return withDb(reply, async (pool): Promise<SearchResults> => {
    // $1 pattern, $2 raw text (exact ID and prefix ranking), $3 per-kind limit.
    const { rows } = await pool.query(
      `SELECT kind, id, label, detail FROM (
         (SELECT 'enterprise' AS kind, e.id, e.name || ' – ' || e.alias || ' (' || e.id || ')' AS label,
                 initcap(e.type) || ' · Tier ' || right(e.tier, 1) AS detail, e.name AS sort_name
            FROM enterprises e
           WHERE e.deleted_at IS NULL AND (e.name ILIKE $1 OR e.alias ILIKE $1 OR e.id::text = $2) LIMIT $3)
         UNION ALL
         (SELECT 'customer_trunk', t.id, t.name, 'Customer trunk · ' || e.name, t.name
            FROM customer_trunks t JOIN enterprises e ON e.id = t.enterprise_id
           WHERE t.deleted_at IS NULL AND (t.name ILIKE $1 OR t.username ILIKE $1 OR t.id::text = $2) LIMIT $3)
         UNION ALL
         (SELECT 'vendor_trunk', t.id, t.name, 'Vendor trunk · ' || e.name, t.name
            FROM vendor_trunks t JOIN enterprises e ON e.id = t.enterprise_id
           WHERE t.deleted_at IS NULL AND (t.name ILIKE $1 OR t.username ILIKE $1 OR t.id::text = $2) LIMIT $3)
         UNION ALL
         (SELECT 'rate_table', r.id, r.name, initcap(r.kind) || ' rate table · ' || r.currency, r.name
            FROM rate_tables r WHERE r.deleted_at IS NULL AND (r.name ILIKE $1 OR r.id::text = $2) LIMIT $3)
         UNION ALL
         (SELECT 'route_rule', r.id, r.name, 'Route rule · priority ' || r.priority || ' · ' || r.route_type, r.name
            FROM route_rules r WHERE r.deleted_at IS NULL AND (r.name ILIKE $1 OR r.id::text = $2) LIMIT $3)
         UNION ALL
         (SELECT 'user', u.id, u.first_name || ' ' || u.last_name, 'User · ' || u.username, u.username
            FROM users u
           WHERE u.deleted_at IS NULL
             AND (u.username ILIKE $1 OR (u.first_name || ' ' || u.last_name) ILIKE $1 OR u.id::text = $2) LIMIT $3)
       ) hits
       ORDER BY (id::text = $2) DESC, (sort_name ILIKE $2 || '%') DESC, length(sort_name), sort_name
       LIMIT $3`,
      [searchPattern(text), text, limit],
    );
    return { hits: rows as SearchHit[] };
  });
}
