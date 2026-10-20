// Rate Lookup easy mode (§13.16): one search box (country, network, MCCMNC, dial code or a
// phone number, optionally by live HLR lookup); results appear as you type in two panels,
// vendor costs and client rates, with quick toggles above them.
import { useEffect, useMemo, useRef, useState } from "react";
import type { LookupClientRate, LookupDestination, LookupVendorCost, RateLookupRequest } from "@sms/contract";
import { usePlatformCurrency } from "../../api/records";
import { downloadBlob, useLookupResolve, useRateLookup } from "../../api/lookup";
import { emptyState, encodeState } from "../../grid/filterModel";
import { useTabNavigate } from "../../shell/tabContext";
import { toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, StatusDot } from "../../ui/primitives";
import { QualityPct } from "../../ui/quality";
import { count, money, signed, toDelimited } from "./lookupModel";
import { VirtualTable, type VColumn } from "./VirtualTable";

export interface EasyState {
  text: string;
  mccmnc: string | null;
  live: boolean;
  mine: boolean;
  inactive: boolean;
  scheduled: boolean;
  converted: boolean;
}

const TIER: Record<string, string> = { tier1: "T1", tier2: "T2", tier3: "T3" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "29 Oct 26" (UTC). */
const day = (iso: string) => `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

const destLabel = (d: LookupDestination) => `${d.country} · ${d.network}`;

function copyRows(rows: (string | number | null)[][], what: string) {
  void navigator.clipboard
    .writeText(toDelimited(rows, "\t"))
    .then(() => toast({ tone: "good", message: `${what} copied – paste into a spreadsheet` }))
    .catch(() => toast({ tone: "error", message: "The browser did not allow copying" }));
}

function PanelHead({ title, n, onCopy, onCsv }: { title: string; n: number; onCopy: () => void; onCsv: () => void }) {
  return (
    <div className="lk-panel-head">
      <h2>{title}</h2>
      <span className="muted">{n.toLocaleString("en-US")}</span>
      <span className="fb-spacer" />
      <button type="button" className="btn btn-ghost btn-sm" onClick={onCopy} disabled={!n} title="Copy the table">
        <Icon name="copy" size={13} /> Copy
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onCsv} disabled={!n} title="Download as CSV">
        <Icon name="download" size={13} /> CSV
      </button>
    </div>
  );
}

export function EasyLookup({
  state,
  setState,
  onAdvanced,
}: {
  state: EasyState;
  setState: (patch: Partial<EasyState>) => void;
  onAdvanced: (d: LookupDestination) => void;
}) {
  const navigate = useTabNavigate();
  const [text, setText] = useState(state.text);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const typed = useDebounced(text, 200);
  const resolve = useLookupResolve(typed, state.live);
  const input = useRef<HTMLInputElement>(null);
  const userTyped = useRef(false);

  // Results appear as you type: the best match is looked up straight away.
  useEffect(() => {
    if (!userTyped.current || typed !== text) return;
    const first = resolve.data?.destinations[0];
    if (resolve.data && typed.trim()) setState({ text: typed, mccmnc: first?.mccmnc ?? null });
  }, [resolve.data, typed]); // eslint-disable-line react-hooks/exhaustive-deps

  const req: RateLookupRequest | null = state.mccmnc
    ? {
        mccmnc: state.mccmnc,
        myClientsOnly: state.mine,
        includeInactive: state.inactive,
        showScheduled: state.scheduled,
        currency: state.converted ? "converted" : "original",
      }
    : null;
  const result = useRateLookup(req);
  const r = result.data;
  const platform = usePlatformCurrency();
  const ccy = r?.lookupCurrency ?? platform;
  const shown = (l: { rate: number; currency: string; rateConverted: number }) =>
    state.converted ? money(l.rateConverted, ccy) : money(l.rate, l.currency);
  const shownNext = (l: LookupVendorCost | LookupClientRate) =>
    l.scheduled
      ? `${l.scheduled.rateConverted > l.rateConverted ? "↑" : "↓"} ${
          state.converted ? money(l.scheduled.rateConverted, ccy) : money(l.scheduled.rate, l.currency)
        } · ${day(l.scheduled.effectiveFrom)}`
      : "";
  const destinations = resolve.data?.destinations ?? [];
  const pick = (d: LookupDestination) => {
    userTyped.current = false;
    setOpen(false);
    setState({ mccmnc: d.mccmnc, text });
  };
  const openNew = (path: string, title: string) => navigate(path, { forceNew: true, title });

  const vendorColumns = useMemo<VColumn<LookupVendorCost>[]>(
    () => [
      {
        key: "vendor",
        header: "Vendor trunk",
        width: 200,
        render: (v) => (
          <button
            type="button"
            className="link lk-name"
            title={`${v.vendorTrunkName} · ${v.enterpriseName} (open the trunk)`}
            onClick={() => openNew(`/enterprises/vendor-trunks/${v.vendorTrunkId}`, v.vendorTrunkName)}
          >
            <span className="strong">{v.vendorTrunkName}</span> <span className="muted small">{v.enterpriseName}</span>
          </button>
        ),
      },
      { key: "tier", header: "Tier", width: 46, render: (v) => TIER[v.tier] },
      {
        key: "rate",
        header: "Rate",
        width: 104,
        align: "right",
        title: "Click to open the rate table in Rate Manager",
        render: (v) => (
          <button
            type="button"
            className={`lk-link num${v.status === "active" && v.rateConverted === r?.bestCost ? " tone-good strong" : ""}`}
            title={`${v.matchedCode !== r?.destination.mccmnc ? `Rate ${v.matchedCode}. ` : ""}Open the rate table`}
            onClick={() => openNew(`/rates/manager?table=${v.rateTableId}`, `Rates · ${v.vendorTrunkName}`)}
          >
            {shown(v)}
            {v.matchedCode !== r?.destination.mccmnc && <sup>*</sup>}
          </button>
        ),
      },
      { key: "from", header: "Since", width: 78, render: (v) => <span className="muted">{day(v.effectiveFrom)}</span> },
      ...(state.scheduled
        ? [
            {
              key: "next",
              header: "Scheduled",
              width: 150,
              render: (v: LookupVendorCost) => (
                <span className={v.scheduled && v.scheduled.rateConverted > v.rateConverted ? "tone-warning" : ""}>
                  {shownNext(v)}
                </span>
              ),
            },
          ]
        : []),
      { key: "n", header: "24h", width: 56, align: "right", render: (v) => count(v.messages24h) },
      {
        key: "asr",
        header: "ASR",
        width: 58,
        align: "right",
        render: (v) => <QualityPct value={v.asr24h}>{`${v.asr24h}%`}</QualityPct>,
      },
      {
        key: "dlr",
        header: "DLR",
        width: 58,
        align: "right",
        render: (v) => <QualityPct value={v.dlr24h}>{`${v.dlr24h}%`}</QualityPct>,
      },
      {
        key: "routed",
        header: "Routed",
        width: 70,
        title: "Routing sends this destination to the vendor for at least one client today",
        render: (v) => (v.routed ? <span className="tag tag-accent">Routed</span> : null),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.converted, state.scheduled, r?.bestCost, r?.destination.mccmnc, ccy],
  );

  const marginCell = (m: number | null, p: number | null) =>
    m === null ? (
      <span className="muted">—</span>
    ) : (
      <span className={m < 0 ? "tone-error strong" : ""}>
        {signed(m)} <span className="muted small">{p === null ? "" : `${p}%`}</span>
      </span>
    );

  const clientColumns = useMemo<VColumn<LookupClientRate>[]>(
    () => [
      {
        key: "client",
        header: "Client trunk",
        width: 190,
        render: (c) => (
          <button
            type="button"
            className="link lk-name"
            title={`${c.customerTrunkName} · ${c.enterpriseName} · table ${c.rateTableName}`}
            onClick={() => openNew(`/enterprises/customer-trunks/${c.customerTrunkId}`, c.customerTrunkName)}
          >
            <span className="strong">{c.customerTrunkName}</span>{" "}
            <span className="muted small">{c.enterpriseName}</span>
          </button>
        ),
      },
      { key: "am", header: "Account mgr", width: 112, render: (c) => c.accountManager?.name ?? "—" },
      {
        key: "sell",
        header: "Sell",
        width: 104,
        align: "right",
        render: (c) => (
          <button
            type="button"
            className={`lk-link num${c.marginBest !== null && c.marginBest < 0 ? " tone-error strong" : ""}`}
            title={`Table ${c.rateTableName}${c.matchedCode !== r?.destination.mccmnc ? `, rate ${c.matchedCode}` : ""} – open in Rate Manager`}
            onClick={() => openNew(`/rates/manager?table=${c.rateTableId}`, `Rates · ${c.rateTableName}`)}
          >
            {shown(c)}
            {c.matchedCode !== r?.destination.mccmnc && <sup>*</sup>}
          </button>
        ),
      },
      ...(state.scheduled
        ? [
            {
              key: "next",
              header: "Scheduled",
              width: 140,
              render: (c: LookupClientRate) => <span>{shownNext(c)}</span>,
            },
          ]
        : []),
      { key: "n", header: "7 days", width: 64, align: "right", render: (c) => count(c.messages7d) },
      {
        key: "best",
        header: "Margin vs best",
        width: 124,
        align: "right",
        render: (c) => marginCell(c.marginBest, c.marginBestPct),
      },
      {
        key: "routed",
        header: "vs routed",
        width: 176,
        render: (c) =>
          c.routedVendor ? (
            <span title={`Rule #${c.routedVendor.ruleId} (${c.routedVendor.decidedBy})`}>
              {marginCell(c.marginRouted, c.marginRoutedPct)} <span className="muted small">{c.routedVendor.name}</span>
            </span>
          ) : (
            <span className="muted">not routed</span>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.converted, state.scheduled, r?.destination.mccmnc, ccy],
  );

  const vendorRows = (rows: LookupVendorCost[]) => [
    [
      "Vendor trunk",
      "Enterprise",
      "Tier",
      "Rate",
      "Currency",
      `Rate ${ccy}`,
      "Rate code",
      "Since",
      "Scheduled",
      "Scheduled from",
      "24h",
      "ASR %",
      "DLR %",
      "Routed",
    ],
    ...rows.map((v) => [
      v.vendorTrunkName,
      v.enterpriseName,
      TIER[v.tier] ?? v.tier,
      v.rate,
      v.currency,
      v.rateConverted,
      v.matchedCode,
      v.effectiveFrom.slice(0, 10),
      v.scheduled?.rate ?? null,
      v.scheduled?.effectiveFrom.slice(0, 10) ?? null,
      v.messages24h,
      v.asr24h,
      v.dlr24h,
      v.routed ? "yes" : "",
    ]),
  ];
  const clientRows = (rows: LookupClientRate[]) => [
    [
      "Client trunk",
      "Enterprise",
      "Rate table",
      "Account manager",
      "Sell",
      "Currency",
      `Sell ${ccy}`,
      "Rate code",
      "7 days",
      `Margin vs best ${ccy}`,
      "Margin vs best %",
      "Routed vendor",
      `Margin vs routed ${ccy}`,
      "Margin vs routed %",
    ],
    ...rows.map((c) => [
      c.customerTrunkName,
      c.enterpriseName,
      c.rateTableName,
      c.accountManager?.name ?? "",
      c.rate,
      c.currency,
      c.rateConverted,
      c.matchedCode,
      c.messages7d,
      c.marginBest,
      c.marginBestPct,
      c.routedVendor?.name ?? "",
      c.marginRouted,
      c.marginRoutedPct,
    ]),
  ];
  const csv = (rows: (string | number | null)[][], name: string) =>
    downloadBlob(new Blob([toDelimited(rows, ",")], { type: "text/csv" }), name);

  const number = resolve.data?.kind === "number" ? resolve.data.number : null;
  const routeLink = (code: string) =>
    `/routing/rules?g=${encodeState({ ...emptyState(), columns: { destination: { field: "destination", op: "like", value: code } } })}`;

  return (
    <div className="lk-easy">
      <div className="lk-search-row">
        <div className="lk-search">
          <Icon name="search" />
          <input
            ref={input}
            autoFocus
            value={text}
            placeholder="Country, network, MCCMNC, dial code or phone number…"
            aria-label="Destination"
            role="combobox"
            aria-expanded={open && destinations.length > 0}
            onChange={(e) => {
              userTyped.current = true;
              setText(e.target.value);
              setOpen(true);
              setCursor(0);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setCursor((c) => Math.min(destinations.length - 1, c + 1));
              else if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
              else if (e.key === "Enter" && destinations[cursor]) pick(destinations[cursor]!);
              else if (e.key === "Escape") setOpen(false);
              else return;
              e.preventDefault();
            }}
          />
          {text && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Clear"
              onClick={() => {
                setText("");
                setState({ text: "", mccmnc: null });
                input.current?.focus();
              }}
            >
              <Icon name="x" size={14} />
            </button>
          )}
          {open && text.trim() && destinations.length > 0 && (
            <div className="lk-suggest" role="listbox">
              {destinations.map((d, i) => (
                <button
                  key={d.mccmnc}
                  type="button"
                  role="option"
                  aria-selected={d.mccmnc === state.mccmnc}
                  className={`${i === cursor ? "cursor" : ""}${d.mccmnc === state.mccmnc ? " on" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(d)}
                >
                  <span>{destLabel(d)}</span>
                  <span className="muted num">{d.mccmnc}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <label className="toggle-inline" title="Resolve a phone number by HLR instead of by its prefix">
          <input type="checkbox" checked={state.live} onChange={(e) => setState({ live: e.target.checked })} />
          Live lookup (HLR)
        </label>
      </div>

      <div className="lk-toggles">
        <label className="toggle-inline">
          <input type="checkbox" checked={state.mine} onChange={(e) => setState({ mine: e.target.checked })} />
          My clients only
        </label>
        <label className="toggle-inline">
          <input type="checkbox" checked={state.inactive} onChange={(e) => setState({ inactive: e.target.checked })} />
          Include inactive
        </label>
        <label className="toggle-inline">
          <input
            type="checkbox"
            checked={state.scheduled}
            onChange={(e) => setState({ scheduled: e.target.checked })}
          />
          Show scheduled rates
        </label>
        <div className="segmented small" role="radiogroup" aria-label="Currency">
          <button
            type="button"
            role="radio"
            aria-checked={!state.converted}
            className={!state.converted ? "on" : ""}
            onClick={() => setState({ converted: false })}
          >
            Original currency
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={state.converted}
            className={state.converted ? "on" : ""}
            onClick={() => setState({ converted: true })}
          >
            Converted ({ccy})
          </button>
        </div>
      </div>

      {r && (
        <div className="lk-dest">
          <h2>{destLabel(r.destination)}</h2>
          <span className="tag num">{r.destination.mccmnc}</span>
          {number && (
            <span className="muted small">
              {number.resolvedBy === "hlr"
                ? `HLR: ${number.ported ? "ported to this network" : "not ported"}`
                : `by prefix ${number.prefix ?? "—"}`}
            </span>
          )}
          <span className="muted">
            Best cost <strong className="tone-good num">{money(r.bestCost, ccy)}</strong>
          </span>
          {result.isFetching && <span className="muted small">Updating…</span>}
          <span className="fb-spacer" />
          <Button
            small
            icon="route"
            onClick={() => openNew(routeLink(r.destination.mccmnc), `Rules · ${r.destination.mccmnc}`)}
          >
            Route rules for this destination
          </Button>
          <Button small icon="grid" onClick={() => onAdvanced(r.destination)}>
            Compare the country
          </Button>
        </div>
      )}
      {result.isError && <p className="error-text">{(result.error as Error).message}</p>}
      {!state.mccmnc && !result.isFetching && (
        <div className="lk-hint muted">
          {text.trim() && resolve.data && destinations.length === 0
            ? "No destination matches. Try a country, a network, an MCCMNC such as 50501 or a number with its country code."
            : "Type a country, network, MCCMNC, dial code or phone number. Vendor costs and client rates appear as you type."}
        </div>
      )}

      {r && (
        <div className="lk-panels">
          {/* Customer (sell) on the left, vendor (buy) on the right, as on the other views (team trial round 2). */}
          <section className="lk-panel" aria-label="Client rates">
            <PanelHead
              title="Client rates"
              n={r.clients.length}
              onCopy={() => copyRows(clientRows(r.clients), "Client rates")}
              onCsv={() => csv(clientRows(r.clients), `client-rates-${r.destination.mccmnc}.csv`)}
            />
            <VirtualTable
              label="Client rates"
              rows={r.clients}
              columns={clientColumns}
              rowKey={(c) => String(c.customerTrunkId)}
              rowClass={(c) =>
                c.status === "inactive"
                  ? "inactive"
                  : c.marginBest !== null && c.marginBest < 0
                    ? "negative"
                    : undefined
              }
              empty={state.mine ? "None of your clients sells this destination." : "No client sells this destination."}
            />
          </section>
          <section className="lk-panel" aria-label="Vendor costs">
            <PanelHead
              title="Vendor costs"
              n={r.vendors.length}
              onCopy={() => copyRows(vendorRows(r.vendors), "Vendor costs")}
              onCsv={() => csv(vendorRows(r.vendors), `vendor-costs-${r.destination.mccmnc}.csv`)}
            />
            <VirtualTable
              label="Vendor costs"
              rows={r.vendors}
              columns={vendorColumns}
              rowKey={(v) => String(v.vendorTrunkId)}
              rowClass={(v) => (v.status === "inactive" ? "inactive" : undefined)}
              empty="No vendor has a rate for this destination."
            />
          </section>
        </div>
      )}
      {r && (
        <p className="muted small lk-foot">
          <StatusDot tone="good" /> best cost · <sup>*</sup> the country rate (all networks) or another network's rate
          applies · rates converted at the latest exchange rate · margins in {ccy}.
        </p>
      )}
    </div>
  );
}
