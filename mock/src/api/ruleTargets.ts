// Safe delete of translation and HLR rules (§13.29, team trial round 3): a rule assigned to a live trunk or
// enterprise cannot be deleted, not even with an override; rules for all trunks or a category do not block.
import type { DependencyItem } from "@sms/contract";
import type pg from "pg";
import { dependencies } from "./records.js";

type Db = pg.Pool | pg.PoolClient;

export async function ruleTargetDependencies(
  db: Db,
  kind: "translation" | "hlr",
  id: number,
  usedBy: number,
): Promise<ReturnType<typeof dependencies>> {
  const table = kind === "translation" ? "translation_rule_targets" : "hlr_rule_targets";
  const ruleCol = kind === "translation" ? "translation_rule_id" : "hlr_rule_id";
  // HLR rules reach customer trunks only; translation targets say which side.
  const vendorSide = kind === "translation" ? "tg.trunk_kind = 'vendor'" : "false";
  const { rows } = await db.query(
    `SELECT
       count(*) FILTER (WHERE tg.target_type = 'trunk' AND (
         (NOT (${vendorSide}) AND EXISTS (SELECT 1 FROM customer_trunks t WHERE t.id = tg.target_id AND t.deleted_at IS NULL))
         OR ((${vendorSide}) AND EXISTS (SELECT 1 FROM vendor_trunks t WHERE t.id = tg.target_id AND t.deleted_at IS NULL))))::int AS trunks,
       count(*) FILTER (WHERE tg.target_type = 'enterprise'
         AND EXISTS (SELECT 1 FROM enterprises e WHERE e.id = tg.target_id AND e.deleted_at IS NULL))::int AS enterprises
       FROM ${table} tg WHERE tg.${ruleCol} = $1`,
    [id],
  );
  const r = rows[0] ?? { trunks: 0, enterprises: 0 };
  const items: DependencyItem[] = [
    {
      key: "assigned_trunks",
      label: "Trunks it is assigned to",
      count: r.trunks,
      blocking: true,
      noOverride: true,
      detail: r.trunks ? "Remove the rule from these trunks first" : null,
    },
    {
      key: "assigned_enterprises",
      label: "Enterprises it is assigned to",
      count: r.enterprises,
      blocking: true,
      noOverride: true,
      detail: r.enterprises ? "Remove the rule from these enterprises first" : null,
    },
    {
      key: "used_by",
      label: "Trunks it runs on",
      count: usedBy,
      blocking: false,
      detail: "Through all trunks or a category, it stops running there",
    },
  ];
  return dependencies(items);
}
