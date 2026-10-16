// Multi-value pickers for route rule conditions: customer and vendor trunks, and the
// destination picker (§13.21: a 3-digit code is the whole country, "505 · all").
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Destination, FilterCondition, ListId, TrunkListRow } from "@sms/contract";
import { fetchListPage } from "../../api/hooks";
import { Icon } from "../../ui/Icon";

export interface Picked<K extends string | number> {
  key: K;
  label: string;
}

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
  const results = useQuery({
    queryKey: ["picker", list, q, fixed],
    queryFn: () =>
      fetchListPage<Row>(list, {
        ...(q.trim() ? { search: q.trim() } : {}),
        ...(fixed?.length ? { filter: { logic: "and", conditions: fixed } } : {}),
        limit: 30,
        withTotal: false,
      }),
    staleTime: 30_000,
  });
  const has = (k: K) => value.some((v) => v.key === k);
  const toggle = (p: Picked<K>) => onChange(has(p.key) ? value.filter((v) => v.key !== p.key) : [...value, p]);
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
      <input placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} aria-label={placeholder} />
      <div className="pick-list">
        {results.data?.rows.map((r) => {
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
      </div>
    </div>
  );
}

export function TrunkPick({
  kind,
  value,
  onChange,
}: {
  kind: "customer" | "vendor";
  value: Picked<number>[];
  onChange: (next: Picked<number>[]) => void;
}) {
  return (
    <MultiPick<TrunkListRow, number>
      list={kind === "customer" ? "customer_trunks" : "vendor_trunks"}
      value={value}
      onChange={onChange}
      toPicked={(r) => ({ key: r.id, label: r.name })}
      detailOf={(r) => `${r.enterpriseName}${r.category ? ` · ${r.category}` : ""}`}
      placeholder={`Search ${kind} trunks…`}
    />
  );
}

/** MCCMNC codes; a whole-country row picks the 3-digit MCC (§13.21). */
export function DestinationPick({ value, onChange }: { value: string[]; onChange: (codes: string[]) => void }) {
  return (
    <MultiPick<Destination, string>
      list="destinations"
      value={value.map((c) => ({ key: c, label: c.length === 3 ? `${c} · all` : c }))}
      onChange={(next) => onChange(next.map((p) => p.key))}
      toPicked={(d) =>
        d.allNetworks || d.mccmnc.length === 3
          ? { key: d.mcc, label: `${d.mcc} · all` }
          : { key: d.mccmnc, label: d.mccmnc }
      }
      detailOf={(d) => `${d.country} · ${d.allNetworks ? "all networks" : d.network}`}
      placeholder="Country, network or MCCMNC…"
    />
  );
}
