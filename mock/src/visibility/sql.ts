// SQL for masking and hiding (§13.17). A rule says how a value is withheld from a viewer who does not
// own the row: names become neutral IDs ("Customer #2481"), hidden values become NULL with a text
// (Hidden, Low / Normal / High, Above limit). Rules are resolved per viewer, so filters, sorting and
// quick search run on what the viewer sees: a masked name cannot be found by searching for it.
import type { Viewer } from "./policy.js";
import { restricts, type VisItem } from "./policy.js";

/** `owned` is SQL true when the row belongs to the viewer; `$OWN` stands for their enterprise IDs. */
export interface MaskRule {
  kind: "mask";
  sql: string;
  /** SQL of the ID shown instead. */
  id: string;
  owned: string;
  /** SQL text expression, e.g. `'Customer'`. */
  label: string;
}
export interface HideRule {
  kind: "hide";
  sql: string;
  item: VisItem;
  owned: string;
  /** Only rows where this SQL is true; other rows use `else` (or show the value). */
  when?: string;
  else?: HideRule;
  /** Margin % behind a band (defaults to the value itself). */
  pct?: string;
}
export type VisRule = MaskRule | HideRule;

export const lit = (text: string) => `'${text.replaceAll("'", "''")}'`;
/** `owned` for a row whose enterprise ID is `col`. */
export const byEnterprise = (col: string) => `(${col}) = ANY($OWN)`;
/** Label by enterprise type: Customer, Vendor, or Enterprise for reciprocal ones. */
export const enterpriseLabel = (typeCol: string) =>
  `(CASE ${typeCol} WHEN 'customer' THEN 'Customer' WHEN 'vendor' THEN 'Vendor' ELSE 'Enterprise' END)`;

export const maskName = (sql: string, id: string, owned: string, label: string): MaskRule => ({
  kind: "mask",
  sql,
  id,
  owned,
  label,
});
export const hide = (item: VisItem, sql: string, owned: string, extra: Partial<HideRule> = {}): HideRule => ({
  kind: "hide",
  item,
  sql,
  owned,
  ...extra,
});

const array = (ids: number[]) => `'{${ids.join(",")}}'::bigint[]`;
const ownedSql = (owned: string, ids: number[]) => owned.replaceAll("$OWN", array(ids));

/** SQL text of what the viewer sees instead of the value ('show' = the value). Null = always the value. */
export function modeSql(rule: HideRule, v: Viewer | null): string | null {
  if (!restricts(v)) return null;
  const setting = v.policy.items[rule.item];
  const th = v.policy.thresholds;
  const limit = rule.item === "revenue" && th.revenueHideAbove !== null;
  const pct = rule.pct ?? rule.sql;
  const one = (mode: string) =>
    mode === "hide"
      ? "'Hidden'"
      : mode === "band"
        ? `(CASE WHEN (${pct}) IS NULL THEN 'Hidden' WHEN (${pct}) < ${Number(th.marginLowPct)} THEN 'Low'
            WHEN (${pct}) > ${Number(th.marginHighPct)} THEN 'High' ELSE 'Normal' END)`
        : limit
          ? `(CASE WHEN (${rule.sql}) > ${Number(th.revenueHideAbove)} THEN 'Above limit' ELSE 'show' END)`
          : "'show'";
  let expr: string | null;
  if (setting.own === "show" && setting.others === "show" && !limit) expr = null;
  else if (setting.own === setting.others) expr = one(setting.own);
  else {
    const ids = rule.item === "cost" ? v.costOwn : v.own;
    expr = `(CASE WHEN ${ownedSql(rule.owned, ids)} THEN ${one(setting.own)} ELSE ${one(setting.others)} END)`;
  }
  if (!rule.when) return expr;
  const other = rule.else ? modeSql(rule.else, v) : null;
  if (expr === null && other === null) return null;
  return `(CASE WHEN ${rule.when} THEN ${expr ?? "'show'"} ELSE ${other ?? "'show'"} END)`;
}

/** The value as the viewer sees it, in SQL. */
export function valueSql(rule: VisRule, v: Viewer | null): string {
  if (rule.kind === "mask") {
    if (!restricts(v) || !v.policy.maskOthers) return rule.sql;
    return `(CASE WHEN ${ownedSql(rule.owned, v.own)} THEN ${rule.sql} ELSE ${rule.label} || ' #' || (${rule.id})::text END)`;
  }
  const mode = modeSql(rule, v);
  if (mode === null) return rule.sql;
  const sql = rule.else && rule.when ? `(CASE WHEN ${rule.when} THEN ${rule.sql} ELSE ${rule.else.sql} END)` : rule.sql;
  return `(CASE WHEN ${mode} = 'show' THEN ${sql} END)`;
}

// Rules embedded in SQL text (aggregates, raw queries such as the jump-to search) as tokens.
const registry: VisRule[] = [];
const TOKEN = /⟦v(\d+)⟧/g;
/** A placeholder for the rule's value; resolveSql replaces it for the viewer. */
export function vis(rule: VisRule): string {
  registry.push(rule);
  return `⟦v${registry.length - 1}⟧`;
}
export function resolveSql(sql: string, v: Viewer | null): string {
  let out = sql;
  for (let i = 0; i < 4 && out.includes("⟦v"); i++)
    out = out.replace(TOKEN, (_, n) => valueSql(registry[Number(n)]!, v));
  return out;
}

/** A list column (lists/engine.ts ColumnSql) withheld by the rule. */
export const visCol = (rule: VisRule, rowKey?: string) => ({ sql: rule.sql, vis: rule, ...(rowKey ? { rowKey } : {}) });
