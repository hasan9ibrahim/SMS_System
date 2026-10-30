// AM visibility on the EDR store (§13.17): EDR Search, Failed EDR Search and EDR downloads. For a viewer whose policy
// masks or hides something, the list definition is rewritten before it is compiled: other AMs' enterprises and trunks
// show as neutral IDs and cannot be found by name, withheld values (sell rates, revenue, cost, IPs) are NULL, so no
// filter or sort can probe them, and with others' traffic hidden only messages that touch an own enterprise are
// listed. Columns opt in with `vis` and `mask` (lists/edrDefs.ts); the answer's rows carry null where withheld.
import type { VisibilityPolicyRow } from "@sms/contract";
import type { ChColumn, ChListDef } from "../lists/chEngine.js";
import { restrictingViewer } from "./context.js";
import type { Viewer, VisItem } from "./policy.js";
import { loadMaps } from "./walk.js";

type Restricted = Viewer & { policy: VisibilityPolicyRow };
type Side = "customer" | "vendor";
type Shown = "own" | "others" | "never";

const inList = (sql: string, ids: number[]) => `(${sql}) IN (${ids.length ? ids.join(",") : "-1"})`;

/** Whose IDs count as own: for buy rates and cost also the vendors carrying own clients' traffic. */
const ownIds = (v: Restricted, item: VisItem, side: Side) => (item === "cost" && side === "vendor" ? v.costOwn : v.own);

/** Shown for own rows only, others' only, never, or always (null). A band is for margins: a message's money is hidden. */
function shownFor(v: Restricted, item: VisItem): Shown | null {
  const s = v.policy.items[item];
  const own = s.own === "show";
  const others = s.others === "show";
  if (own && others) return null;
  if (!own && !others) return "never";
  return own ? "own" : "others";
}

/** The definition as this viewer sees it; unchanged for viewers whose policy restricts nothing. */
export async function viewChDef<Row>(def: ChListDef<Row>, viewer?: Restricted | null): Promise<ChListDef<Row>> {
  const v = viewer === undefined ? await restrictingViewer() : viewer;
  if (!v || !def.owners) return def;
  const owners = def.owners;
  const side = (s: Side) => (s === "vendor" ? owners.vendor : owners.customer);
  const m = v.policy.maskOthers ? await loadMaps() : null;
  const own = new Set(v.own);
  const enterpriseLabel = (id: number) =>
    `${{ customer: "Customer", vendor: "Vendor" }[m?.type.get(id) ?? ""] ?? "Enterprise"} #${id}`;

  const columns: Record<string, ChColumn> = {};
  const withheld: { field: string; item: VisItem; side: Side; shown: Shown }[] = [];
  for (const [field, col] of Object.entries(def.columns)) {
    let out = col;
    if (col.mask && m && col.names) {
      const kind = col.mask;
      const owner = (id: number) =>
        kind === "enterprise" ? id : (kind === "customerTrunk" ? m.customerTrunk : m.vendorTrunk).get(id);
      const view = {
        own: (id: number) => own.has(owner(id) ?? -1),
        label: (id: number) =>
          kind === "enterprise" ? enterpriseLabel(id) : `${kind === "customerTrunk" ? "Customer" : "Vendor"} trunk #${id}`,
      };
      out = { ...col, names: { ...col.names, view } };
    }
    const shown = col.vis ? shownFor(v, col.vis.item) : null;
    if (col.vis && shown) {
      // A list without that side (failed EDRs never reached a vendor) owns nothing there.
      const ownerSql = side(col.vis.side)?.sql;
      const owned = ownerSql ? inList(ownerSql, ownIds(v, col.vis.item, col.vis.side)) : "0";
      const when = shown === "never" ? "0" : shown === "own" ? owned : `NOT ${owned}`;
      out = { ...out, sql: `if(${when}, ${col.sql}, NULL)`, nullable: true };
      withheld.push({ field, item: col.vis.item, side: col.vis.side, shown });
    }
    columns[field] = out;
  }

  // Others' traffic hidden: only messages to or from an own enterprise.
  const traffic = shownFor(v, "traffic");
  const where = [def.baseWhere];
  if (traffic === "own" || traffic === "never") {
    const sides = [owners.customer.sql, owners.vendor?.sql].filter((x): x is string => !!x);
    where.push(`(${sides.map((x) => inList(x, v.own)).join(" OR ")})`);
  }

  const owns = (row: Record<string, unknown>, w: (typeof withheld)[number]) => {
    const key = side(w.side)?.key;
    return key !== undefined && ownIds(v, w.item, w.side).includes(Number(row[key]));
  };
  return {
    ...def,
    columns,
    baseWhere: where.filter(Boolean).join(" AND ") || undefined,
    // Money the switch adds from outcome rows joins after the SQL: withheld again on the finished row.
    mapRow: (r, names) => {
      const row = def.mapRow(r, names) as Record<string, unknown>;
      for (const w of withheld) if (w.shown === "never" || (w.shown === "own") !== owns(row, w)) row[w.field] = null;
      return row as Row;
    },
  };
}
