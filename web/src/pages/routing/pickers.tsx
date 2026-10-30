// Multi-value pickers for route rule conditions: customer and vendor trunks, and the
// destination picker (§13.21): names first ("Afghanistan · AWCC (41201)"), a tree to tick whole
// countries or single networks; a 3-digit code is only the country's All networks default entry,
// never the whole country (team trial round 1).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FilterCondition, ListId, ListQuery, TrunkListRow } from "@sms/contract";
import { fetchPickPage } from "../../api/hooks";
import { Icon } from "../../ui/Icon";
import { codeChips, DestinationTree, useDestinationTree } from "../rates/DestinationTree";

export interface Picked<K extends string | number> {
  key: K;
  label: string;
}

/** Most rows Check all takes from a search at once (select all filtered, team trial round 12). */
const CHECK_ALL_MAX = 1000;

export function MultiPick<Row extends { id: number }, K extends string | number>({
  list,
  value,
  onChange,
  toPicked,
  detailOf,
  placeholder,
  fixed,
}: {
  list: ListId;
  value: Picked<K>[];
  onChange: (next: Picked<K>[]) => void;
  toPicked: (row: Row) => Picked<K>;
  detailOf?: (row: Row) => string;
  placeholder: string;
  fixed?: FilterCondition[];
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const search = q.trim();
  const body = (limit: number, withTotal: boolean, withSearch = true): ListQuery => ({
    ...(withSearch && search ? { search } : {}),
    ...(fixed?.length ? { filter: { logic: "and", conditions: fixed } } : {}),
    limit,
    withTotal,
  });
  const results = useQuery({
    queryKey: ["picker", list, q, fixed],
    queryFn: () => fetchPickPage<Row>(list, body(30, true)),
    staleTime: 30_000,
  });
  // "of M": every row the picker offers, the search aside (team trial round 12).
  const offered = useQuery({
    queryKey: ["picker", list, "total", fixed],
    queryFn: () => fetchPickPage<Row>(list, body(1, true, false)),
    staleTime: 60_000,
  });
  const rows = results.data?.rows ?? [];
  const matching = results.data?.total ?? rows.length;
  const has = (k: K) => value.some((v) => v.key === k);
  const toggle = (p: Picked<K>) => onChange(has(p.key) ? value.filter((v) => v.key !== p.key) : [...value, p]);
  // Check all / Uncheck all act on what the search matches, not only the rows on screen.
  const matched = async (): Promise<Picked<K>[]> =>
    matching <= rows.length
      ? rows.map(toPicked)
      : (await fetchPickPage<Row>(list, body(Math.min(matching, CHECK_ALL_MAX), false))).rows.map(toPicked);
  const bulk = async (check: boolean) => {
    if (!check && !search) return onChange([]);
    setBusy(true);
    try {
      const picks = await matched();
      if (check) onChange([...value, ...picks.filter((p) => !has(p.key))]);
      else {
        const drop = new Set(picks.map((p) => p.key));
        onChange(value.filter((v) => !drop.has(v.key)));
      }
    } finally {
      setBusy(false);
    }
  };
  const total = offered.data?.total;
  return (
    <div className="multi-pick">
      <div className="chips">
        {value.map((v) => (
          <span key={v.key} className="chip">
            {v.label}
            <button type="button" aria-label={`Remove ${v.label}`} onClick={() => toggle(v)}>
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        {value.length === 0 && <span className="muted small">Nothing chosen yet.</span>}
      </div>
      {/* Count and Check all / Uncheck all above the search, the search joined to the list (team trial round 12). */}
      <div className="checklist-bar">
        <span className="muted">
          Selected {value.length.toLocaleString("en-US")}
          {total != null ? ` of ${total.toLocaleString("en-US")}` : ""}
          {search && results.data ? ` · ${matching.toLocaleString("en-US")} match` : ""}
        </span>
        <span className="checklist-actions">
          <button type="button" className="link" disabled={busy || !matching} onClick={() => void bulk(true)}>
            {search ? "Check shown" : "Check all"}
          </button>
          <button type="button" className="link" disabled={busy || !value.length} onClick={() => void bulk(false)}>
            {search ? "Uncheck shown" : "Uncheck all"}
          </button>
        </span>
      </div>
      <div className="checklist-box">
        <div className="checklist-search">
          <Icon name="search" size={13} />
          <input placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} aria-label={placeholder} />
        </div>
        <div className="pick-list">
          {rows.map((r) => {
            const p = toPicked(r);
            return (
              <label key={r.id} className="choice-row">
                <input type="checkbox" checked={has(p.key)} onChange={() => toggle(p)} />
                <span>{p.label}</span>
                {detailOf && <span className="muted small">{detailOf(r)}</span>}
              </label>
            );
          })}
          {results.data?.rows.length === 0 && <p className="muted small pad">No matches.</p>}
          {matching > rows.length && (
            <p className="muted small pad">
              {(matching - rows.length).toLocaleString("en-US")} more: type to narrow the list.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function TrunkPick({
  kind,
  value,
  onChange,
  fixed,
}: {
  kind: "customer" | "vendor";
  value: Picked<number>[];
  onChange: (next: Picked<number>[]) => void;
  /** e.g. only the trunks of the rule's product categories (team trial round 1). */
  fixed?: FilterCondition[];
}) {
  return (
    <MultiPick<TrunkListRow, number>
      fixed={fixed}
      list={kind === "customer" ? "customer_trunks" : "vendor_trunks"}
      value={value}
      onChange={onChange}
      toPicked={(r) => ({ key: r.id, label: r.name })}
      detailOf={(r) => `${r.enterpriseName}${r.category ? ` · ${r.category}` : ""}`}
      placeholder={`Search ${kind} trunks…`}
    />
  );
}

const CHIPS_SHOWN = 12;

/** MCCMNC codes, exact: a whole country is all its codes ticked in the tree (§13.21). */
export function DestinationPick({ value, onChange }: { value: string[]; onChange: (codes: string[]) => void }) {
  const { tree } = useDestinationTree();
  const chips = useMemo(() => codeChips(tree, value), [tree, value]);
  const [all, setAll] = useState(false);
  const shown = all ? chips : chips.slice(0, CHIPS_SHOWN);
  return (
    <div className="multi-pick dest-pick">
      <div className="chips">
        {shown.map((c) => (
          <span key={c.key} className="chip" title={c.codes.length > 1 ? c.codes.join(", ") : undefined}>
            {c.label}
            <button
              type="button"
              aria-label={`Remove ${c.label}`}
              onClick={() => onChange(value.filter((v) => !c.codes.includes(v)))}
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        {chips.length > CHIPS_SHOWN && (
          <button type="button" className="link small" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `+${chips.length - CHIPS_SHOWN} more`}
          </button>
        )}
        {value.length === 0 && <span className="muted small">Nothing chosen yet.</span>}
      </div>
      <DestinationTree selected={value} onChange={onChange} height={240} />
    </div>
  );
}

/** A multi-select over a short list already loaded (reference data), with a local search box. */
export function RefMulti<T extends string | number>({
  options,
  value,
  onChange,
  placeholder,
}: {
  options: { value: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
  placeholder: string;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = options.filter((o) => o.label.toLowerCase().includes(needle)).slice(0, 200);
  return (
    <div className="multi-pick">
      <div className="chips">
        {value.map((v) => (
          <span key={v} className="chip">
            {options.find((o) => o.value === v)?.label ?? v}
            <button type="button" aria-label="Remove" onClick={() => onChange(value.filter((x) => x !== v))}>
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
      </div>
      {/* Count and Check all / Uncheck all above the search, the search joined to the list (team trial round 12). */}
      <div className="checklist-bar">
        <span className="muted">
          Selected {value.length} of {options.length}
          {needle ? ` · ${shown.length} shown` : ""}
        </span>
        <span className="checklist-actions">
          <button
            type="button"
            className="link"
            disabled={shown.every((o) => value.includes(o.value))}
            onClick={() => onChange([...value, ...shown.map((o) => o.value).filter((v) => !value.includes(v))])}
          >
            {needle ? "Check shown" : "Check all"}
          </button>
          <button
            type="button"
            className="link"
            disabled={!value.length}
            onClick={() => onChange(needle ? value.filter((v) => !shown.some((o) => o.value === v)) : [])}
          >
            {needle ? "Uncheck shown" : "Uncheck all"}
          </button>
        </span>
      </div>
      <div className="checklist-box">
        {options.length > 8 && (
          <div className="checklist-search">
            <Icon name="search" size={13} />
            <input placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} aria-label={placeholder} />
          </div>
        )}
        <div className="pick-list short">
          {shown.map((o) => (
            <label key={o.value} className="choice-row">
              <input
                type="checkbox"
                checked={value.includes(o.value)}
                onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
