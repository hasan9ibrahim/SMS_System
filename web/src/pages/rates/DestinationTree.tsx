// Destination tree for rating (team trial round 1): countries with a checkbox each (all its networks),
// opening into their networks with checkboxes; a search over country, ISO, MCC, network and MCCMNC;
// "Selected X of Y" and Select all / Clear acting on what the search shows. The MCCMNC master comes
// from the lookup options (one cached call), and the list scrolls with virtualisation.
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { LookupSideOptions } from "@sms/contract";
import { api, unwrap } from "../../api/client";
import { applyToShown, matcher } from "../../ui/CheckList";
import { Icon } from "../../ui/Icon";
import { Button, Modal } from "../../ui/primitives";

export interface TreeCountry {
  mcc: string;
  name: string;
  iso: string;
  codes: { mccmnc: string; network: string; allNetworks: boolean }[];
}

/** Countries with their codes, in master order (the country-level code first). */
export function treeOf(o: LookupSideOptions | undefined): TreeCountry[] {
  if (!o) return [];
  const by = new Map<string, TreeCountry>(o.countries.map((c) => [c.mcc, { ...c, codes: [] }]));
  for (const c of o.codes) by.get(c.mcc)?.codes.push(c);
  return [...by.values()].filter((c) => c.codes.length);
}

export type TreeRow =
  | { kind: "country"; country: TreeCountry; shown: string[]; open: boolean }
  | { kind: "code"; country: TreeCountry; mccmnc: string; network: string; allNetworks: boolean };

/** Rows on screen: a search shows the matching networks of each country (all of them when the country matches). */
export function treeRows(
  tree: TreeCountry[],
  q: string,
  open: ReadonlySet<string>,
): { rows: TreeRow[]; shown: string[] } {
  const m = matcher(q);
  const searching = !!q.trim();
  const rows: TreeRow[] = [];
  const shown: string[] = [];
  for (const c of tree) {
    const countryHit = m(`${c.name} ${c.iso} ${c.mcc}`);
    const codes = countryHit ? c.codes : c.codes.filter((x) => m(`${x.network} ${x.mccmnc} ${c.name}`));
    if (!codes.length) continue;
    const ids = codes.map((x) => x.mccmnc);
    shown.push(...ids);
    const isOpen = open.has(c.mcc) || (searching && !countryHit);
    rows.push({ kind: "country", country: c, shown: ids, open: isOpen });
    if (isOpen) for (const x of codes) rows.push({ kind: "code", country: c, ...x });
  }
  return { rows, shown };
}

/** Whole countries become country codes (ISO, every network), the rest stay MCCMNC codes. */
export function splitByCountry(
  tree: TreeCountry[],
  selected: readonly string[],
): { countries: string[]; mccmncs: string[] } {
  const sel = new Set(selected);
  const countries: string[] = [];
  const mccmncs: string[] = [];
  for (const c of tree) {
    const picked = c.codes.filter((x) => sel.has(x.mccmnc));
    if (!picked.length) continue;
    if (picked.length === c.codes.length) countries.push(c.iso);
    else mccmncs.push(...picked.map((x) => x.mccmnc));
  }
  return { countries, mccmncs };
}

/**
 * Rule MCCMNC lists keep the exact codes ticked. A 3-digit code is the country's "All networks" default
 * entry only, never the whole country; a whole country is all its codes (team trial round 1).
 */
export function toRuleCodes(tree: TreeCountry[], selected: readonly string[]): string[] {
  const known = new Set(tree.flatMap((c) => c.codes.map((x) => x.mccmnc)));
  return [...new Set(selected)].filter((c) => known.has(c) || !tree.length);
}

/** The other way: codes stay as they are (an MCC is just the All networks row). */
export function fromRuleCodes(_tree: TreeCountry[], codes: readonly string[]): string[] {
  return [...new Set(codes)];
}

/** "Afghanistan · AWCC (41201)"; the country-level code reads "Afghanistan · All networks (412)" (§13.21). */
export const destLabel = (country: string, network: string, allNetworks: boolean, code: string) =>
  `${country} · ${allNetworks ? "All networks" : network} (${code})`;

export interface CodeChip {
  key: string;
  label: string;
  /** The codes the chip stands for (all of a country when the whole country is picked). */
  codes: string[];
}

/** Picked codes as chips by name, in the order picked; a country with every code picked is one chip. */
export function codeChips(tree: TreeCountry[], codes: readonly string[]): CodeChip[] {
  const byCode = new Map<string, { country: TreeCountry; code: TreeCountry["codes"][number] }>();
  for (const c of tree) for (const x of c.codes) byCode.set(x.mccmnc, { country: c, code: x });
  const sel = new Set(codes);
  const done = new Set<string>();
  const out: CodeChip[] = [];
  for (const code of codes) {
    const hit = byCode.get(code);
    if (!hit) {
      out.push({ key: code, label: code, codes: [code] });
      continue;
    }
    const c = hit.country;
    if (done.has(c.mcc)) continue;
    if (c.codes.length > 1 && c.codes.every((x) => sel.has(x.mccmnc))) {
      done.add(c.mcc);
      out.push({ key: `country:${c.mcc}`, label: `${c.name} (whole country)`, codes: c.codes.map((x) => x.mccmnc) });
    } else
      out.push({ key: code, label: destLabel(c.name, hit.code.network, hit.code.allNetworks, code), codes: [code] });
  }
  return out;
}

/** Chips as one line: the first `max` by name, then "+N". */
export function codesText(tree: TreeCountry[], codes: readonly string[], max = 3): string {
  const chips = codeChips(tree, codes);
  return (
    chips
      .slice(0, max)
      .map((c) => c.label)
      .join(", ") + (chips.length > max ? ` +${chips.length - max}` : "")
  );
}

export function useDestinationTree() {
  const q = useQuery({
    queryKey: ["lookup-side-options", "customer"],
    queryFn: () => unwrap(api.GET("/rate-lookup/side/options", { params: { query: { side: "customer" } } })),
    staleTime: 5 * 60_000,
  });
  return { tree: useMemo(() => treeOf(q.data), [q.data]), loading: q.isPending, error: q.isError };
}

export function DestinationTree({
  selected,
  onChange,
  height = 300,
}: {
  selected: readonly string[];
  onChange: (codes: string[]) => void;
  height?: number;
}) {
  const { tree, loading, error } = useDestinationTree();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { rows, shown } = useMemo(() => treeRows(tree, q, open), [tree, q, open]);
  const total = useMemo(() => tree.reduce((n, c) => n + c.codes.length, 0), [tree]);
  const sel = useMemo(() => new Set(selected), [selected]);
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 28,
    overscan: 12,
  });
  const toggleOpen = (mcc: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(mcc)) n.delete(mcc);
      else n.add(mcc);
      return n;
    });
  const searching = !!q.trim();
  return (
    <div className="dtree">
      {/* Count and Check all / Uncheck all above the search, the search joined to the tree (team trial round 12). */}
      <div className="checklist-bar">
        <span className="muted">
          Selected {selected.length.toLocaleString("en-US")} of {total.toLocaleString("en-US")} networks
          {searching ? ` · ${shown.length.toLocaleString("en-US")} shown` : ""}
        </span>
        <span className="checklist-actions">
          <button type="button" className="link" onClick={() => onChange(applyToShown(selected, shown, true))}>
            {searching ? "Check shown" : "Check all"}
          </button>
          <button type="button" className="link" onClick={() => onChange(applyToShown(selected, shown, false))}>
            {searching ? "Uncheck shown" : "Uncheck all"}
          </button>
        </span>
      </div>
      <div className="checklist-box">
        <div className="checklist-search">
          <Icon name="search" size={13} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Country, network or MCCMNC (% _ wildcards)"
            aria-label="Search destinations"
          />
        </div>
        <div className="checklist-items" ref={scroll} style={{ height }} role="tree" aria-multiselectable>
          {loading ? (
            <div className="muted checklist-empty">Loading destinations…</div>
          ) : error ? (
            <div className="tone-error checklist-empty">Could not load the destinations</div>
          ) : rows.length === 0 ? (
            <div className="muted checklist-empty">Nothing matches</div>
          ) : (
            <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
              {virtual.getVirtualItems().map((vi) => {
                const r = rows[vi.index]!;
                const style = { transform: `translateY(${vi.start}px)`, height: vi.size };
                if (r.kind === "country") {
                  const n = r.shown.filter((c) => sel.has(c)).length;
                  return (
                    <div
                      key={`c${r.country.mcc}`}
                      className="checklist-item dtree-country"
                      style={style}
                      role="treeitem"
                    >
                      <button
                        type="button"
                        className="icon-btn dtree-toggle"
                        aria-label={r.open ? `Close ${r.country.name}` : `Open ${r.country.name}`}
                        aria-expanded={r.open}
                        onClick={() => toggleOpen(r.country.mcc)}
                      >
                        <Icon name={r.open ? "chevronDown" : "chevronRight"} size={12} />
                      </button>
                      <label className="dtree-label">
                        <input
                          type="checkbox"
                          checked={n > 0 && n === r.shown.length}
                          ref={(el) => {
                            if (el) el.indeterminate = n > 0 && n < r.shown.length;
                          }}
                          onChange={() => onChange(applyToShown(selected, r.shown, n < r.shown.length))}
                          aria-label={`${r.country.name}: all ${r.shown.length} networks`}
                        />
                        <span className="strong">{r.country.name}</span>
                        <span className="muted">({r.country.iso})</span>
                      </label>
                      <span className="checklist-detail">
                        {n ? `${n} of ` : ""}
                        {r.shown.length} network{r.shown.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  );
                }
                return (
                  <label key={r.mccmnc} className="checklist-item dtree-code" style={style} role="treeitem">
                    <input
                      type="checkbox"
                      checked={sel.has(r.mccmnc)}
                      onChange={() =>
                        onChange(sel.has(r.mccmnc) ? selected.filter((c) => c !== r.mccmnc) : [...selected, r.mccmnc])
                      }
                    />
                    <span className={`checklist-label${r.allNetworks ? " muted" : ""}`}>{r.network}</span>
                    <span className="checklist-detail">{r.mccmnc}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Bulk rating scope: tick countries and networks; whole countries go in as countries (every network). */
export function DestinationPickDialog({
  done,
}: {
  done: (v: { mccmncs: string[]; countries: string[] } | null) => void;
}) {
  const { tree } = useDestinationTree();
  const [picked, setPicked] = useState<string[]>([]);
  const split = useMemo(() => splitByCountry(tree, picked), [tree, picked]);
  return (
    <Modal
      title="Pick countries and networks"
      width={620}
      onClose={() => done(null)}
      footer={
        <>
          <span className="muted small fb-spacer">
            {split.countries.length} whole countr{split.countries.length === 1 ? "y" : "ies"} + {split.mccmncs.length}{" "}
            network{split.mccmncs.length === 1 ? "" : "s"}
          </span>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" disabled={!picked.length} onClick={() => done(split)}>
            Add to scope
          </Button>
        </>
      }
    >
      <DestinationTree selected={picked} onChange={setPicked} height={380} />
    </Modal>
  );
}

/** Pick a rule's MCCMNC list in the tree, with select all on the filtered ones (team trial round 1). */
export function RuleCodesDialog({ initial, done }: { initial: string[]; done: (codes: string[] | null) => void }) {
  const { tree } = useDestinationTree();
  const [picked, setPicked] = useState<string[] | null>(null);
  const current = picked ?? (tree.length ? fromRuleCodes(tree, initial) : []);
  const codes = useMemo(() => toRuleCodes(tree, current), [tree, current]);
  return (
    <Modal
      title="Pick countries and networks"
      width={620}
      onClose={() => done(null)}
      footer={
        <>
          <span className="muted small fb-spacer">
            {codes.length} code{codes.length === 1 ? "" : "s"}
          </span>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" disabled={!tree.length} onClick={() => done(codes)}>
            Use these
          </Button>
        </>
      }
    >
      <DestinationTree selected={current} onChange={setPicked} height={380} />
    </Modal>
  );
}
