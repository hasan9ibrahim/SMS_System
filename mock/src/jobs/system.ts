// The user the background jobs act as (backend step 11): the "system" user created at go-live (deploy bootstrap, step
// 14), so changes made by jobs (an e-mailed RN taken in, an automatic rate) show as the system's in the change history
// and the audit trail, not as a person's. Before that user exists, the first administrator.
import type pg from "pg";

let cached: number | null = null;

export async function systemUserId(c: pg.Pool | pg.PoolClient): Promise<number> {
  if (cached !== null) return cached;
  const { rows } = await c.query(
    `SELECT id FROM users WHERE username = 'system'
     UNION ALL (SELECT id FROM users WHERE is_admin ORDER BY id LIMIT 1)
     UNION ALL (SELECT id FROM users ORDER BY id LIMIT 1) LIMIT 1`,
  );
  const id = Number(rows[0]?.id);
  if (rows[0]?.id != null) cached = id;
  return id;
}
