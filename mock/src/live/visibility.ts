// AM visibility on the live screens (§13.17, security audit of team trial round 12): what the socket pushes is shaped
// for each viewer whose policy restricts anything, as the lists are. Other AMs' enterprises and trunks show as neutral
// IDs (every name in a live event is a PartyRef, the analytics rows have id + name + parent), withheld money is null,
// totals over everyone's traffic keep their money only when nothing is hidden, and with others' traffic hidden their
// rows are left out. The figures are computed once per tick; each restricted client gets its own copy.
import type { VisibilityPolicyRow } from "@sms/contract";
import type { Viewer, VisItem } from "../visibility/policy.js";
import type { Maps } from "../visibility/walk.js";

type Restricted = Viewer & { policy: VisibilityPolicyRow };
type Obj = Record<string, unknown>;
interface PartyRef {
  kind: string;
  id: number;
  name: string;
}

const LABEL: Record<string, string> = { customer: "Customer", vendor: "Vendor" };
const isParty = (x: unknown): x is PartyRef => {
  const o = x as Obj | null;
  return !!o && typeof o.kind === "string" && typeof o.id === "number" && typeof o.name === "string";
};

export interface LiveView {
  /** The payload as this viewer may see it (a copy; the shared one is left alone). */
  shape(topic: string, event: string, payload: object): object;
}

export function liveView(v: Restricted, m: Maps): LiveView {
  const own = new Set(v.own);
  const costOwn = new Set(v.costOwn);
  const enterpriseOf = (kind: string, id: number) =>
    kind === "customer_trunk" ? m.customerTrunk.get(id) : kind === "vendor_trunk" ? m.vendorTrunk.get(id) : id;
  const owned = (kind: string, id: number, item?: VisItem) => {
    const e = enterpriseOf(kind, id);
    return e !== undefined && (item === "cost" && kind.startsWith("vendor") ? costOwn : own).has(e);
  };
  const enterpriseLabel = (id: number) => `${LABEL[m.type.get(id) ?? ""] ?? "Enterprise"} #${id}`;
  const label = (kind: string, id: number) =>
    kind.endsWith("_trunk") ? `${kind === "customer_trunk" ? "Customer" : "Vendor"} trunk #${id}` : enterpriseLabel(id);
  /** Shown for this row (owned or not), or for a total over everyone (null: shown only when shown to all). */
  const shows = (item: VisItem, mine: boolean | null) => {
    const s = v.policy.items[item];
    if (mine === null) return s.own === "show" && s.others === "show";
    return (mine ? s.own : s.others) === "show";
  };
  const trafficHidden = v.policy.items.traffic.others !== "show";
  const mask = v.policy.maskOthers;

  /** Masks a party's name; true when the party is someone else's. */
  const party = (p: PartyRef): boolean => {
    const mine = owned(p.kind, p.id);
    if (!mine && mask) p.name = label(p.kind, p.id);
    return !mine;
  };
  const visibleRows = <T>(rows: T[], ref: (r: T) => PartyRef | null) =>
    trafficHidden ? rows.filter((r) => !ref(r) || owned(ref(r)!.kind, ref(r)!.id)) : rows;
  const money = (o: Obj, field: string, item: VisItem, mine: boolean | null) => {
    if (field in o && !shows(item, mine)) o[field] = null;
  };
  /** Totals over everyone's traffic (summary, destinations): money only when shown for own and others alike. */
  const totals = (o: Obj) => {
    money(o, "revenue", "revenue", null);
    money(o, "cost", "cost", null);
    money(o, "margin", "margin", null);
    money(o, "marginPct", "margin", null);
  };

  const shapeTops = (p: Obj) => {
    const side = (key: "clients" | "vendors", item: VisItem) => {
      const rows = visibleRows((p[key] as Obj[]) ?? [], (r) => r.party as PartyRef);
      for (const r of rows) {
        const ref = r.party as PartyRef;
        const mine = owned(ref.kind, ref.id, item);
        party(ref);
        money(r, "money", item, mine);
        money(r, "margin", "margin", owned(ref.kind, ref.id));
      }
      p[key] = rows;
    };
    side("clients", "revenue");
    side("vendors", "cost");
    for (const d of (p.destinations as Obj[]) ?? []) totals(d);
  };

  const ANALYTICS_KIND: Record<string, string> = {
    customer: "customer_enterprise",
    customer_trunk: "customer_trunk",
    vendor: "vendor_enterprise",
    vendor_trunk: "vendor_trunk",
  };
  const shapeAnalytics = (p: Obj) => {
    const kind = ANALYTICS_KIND[String(p.groupBy)];
    const rows = (p.rows as Obj[]) ?? [];
    if (kind) {
      const kept = visibleRows(rows, (r) => ({ kind, id: Number(r.id), name: "" }));
      for (const r of kept) {
        const id = Number(r.id);
        const mine = owned(kind, id);
        if (!mine && mask) {
          r.name = label(kind, id);
          if (kind.endsWith("_trunk") && r.parent != null) {
            const e = enterpriseOf(kind, id);
            r.parent = e === undefined ? null : enterpriseLabel(e);
          }
        }
        const vendor = kind.startsWith("vendor");
        // A client row's revenue is its own; a vendor row's revenue is what other clients paid (and the reverse for cost).
        money(r, "revenue", "revenue", vendor ? null : mine);
        money(r, "cost", "cost", vendor ? owned(kind, id, "cost") : null);
        money(r, "margin", "margin", mine);
        money(r, "marginPct", "margin", mine);
      }
      p.rows = kept;
    } else for (const r of rows) totals(r);
    if (p.totals) totals(p.totals as Obj);
  };

  return {
    shape(topic, event, payload) {
      const p = structuredClone(payload) as Obj;
      if (topic === "live:tps" && event === "tick")
        p.trunks = visibleRows((p.trunks as Obj[]) ?? [], (t) => t.trunk as PartyRef);
      if (topic === "live:tps" && event === "history")
        p.series = visibleRows((p.series as Obj[]) ?? [], (t) => t.trunk as PartyRef);
      if (topic === "live:dashboard" && event === "summary") totals(p);
      if (topic === "live:dashboard" && event === "tops") shapeTops(p);
      if (topic === "live:dashboard" && event === "movers")
        for (const key of ["started", "customers", "vendors", "stopped"])
          if (Array.isArray(p[key])) p[key] = visibleRows(p[key] as Obj[], (r) => r.trunk as PartyRef);
      if (topic === "live:analytics" && event === "snapshot") shapeAnalytics(p);
      if (topic.startsWith("alerts:") && event === "incident") {
        // The incident's own text names the trunk: masked with it.
        const scope = (p.scope as PartyRef[] | undefined)?.[0];
        if (scope && !owned(scope.kind, scope.id) && mask) {
          const real = scope.name;
          const neutral = label(scope.kind, scope.id);
          if (typeof p.message === "string" && real) p.message = p.message.split(real).join(neutral);
          if (p.entityName === real) p.entityName = neutral;
        }
      }
      // Every remaining name (ticks, movers, summary top destinations have none).
      const walk = (x: unknown, depth: number) => {
        if (!x || typeof x !== "object" || depth > 8) return;
        if (Array.isArray(x)) return x.forEach((y) => walk(y, depth + 1));
        if (isParty(x)) party(x);
        for (const y of Object.values(x)) walk(y, depth + 1);
      };
      walk(p, 0);
      return p;
    },
  };
}
