// Rate Lookup advanced mode (§13.16): many destinations at once (countries, a list of
// MCCMNCs, pasted numbers or an uploaded file), filters, a point in time, four views and
// highlights. The matrix pages on the server and scrolls virtualised; it exports to CSV,
// copies to the clipboard, and lookups can be saved and shared.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type {
  Enterprise,
  MatrixCell,
  MatrixColumn,
  MatrixHighlight,
  MatrixRow,
  MatrixView,
  RateLookupQuery,
  RateMatrix,
  RateTableRow,
  SavedLookup,
  UserSummary,
} from "@sms/contract";
import { ApiError } from "../../api/client";
import { usePlatformCurrency, useReference } from "../../api/records";
import { exportMatrix, fetchMatrixPage, useDeleteLookup, useSaveLookup, useSavedLookups } from "../../api/lookup";
import { usePageStatus, useTabNavigate } from "../../shell/tabContext";
import { scopeUrl } from "../rates/bulkModel";
import { confirmDialog, toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, Modal, Popover } from "../../ui/primitives";
import { MultiPick, RefMulti, TrunkPick, type Picked } from "../routing/pickers";
import { filterCount, money, parseDestinations, signed, toDelimited } from "./lookupModel";
import { VirtualTable, type VColumn } from "./VirtualTable";
import { DateTimeInput } from "../../ui/DateTimeInput";

const VIEWS: { value: MatrixView; label: string }[] = [
  { value: "vendor_costs", label: "Vendor costs" },
  { value: "client_rates", label: "Client rates" },
  { value: "margin", label: "Margin matrix" },
  { value: "cheapest", label: "Cheapest vendors" },
];

export const HIGHLIGHTS: { value: MatrixHighlight; label: string; short: string; tone: string; title: string }[] = [
  {
    value: "below_cost",
    label: "Below-cost sells",
    short: "below cost",
    tone: "error",
    title: "A client sells under the best vendor cost",
  },
  {
    value: "cheaper_than_routed",
    label: "Cheaper than routed",
    short: "cheaper vendor",
    tone: "warning",
    title: "A vendor is cheaper than the one routing uses",
  },
  {
    value: "expiring_soon",
    label: "Expiring soon",
    short: "expiring",
    tone: "warning",
    title: "A rate ends within 14 days with no new version",
  },
  {
    value: "single_vendor",
    label: "Only one vendor",
    short: "1 vendor",
    tone: "warning",
    title: "Only one vendor has a rate",
  },
];

const errText = (e: unknown) =>
  e instanceof ApiError
    ? [e.message, ...((e.problem.errors ?? []) as { path: string; message: string }[]).map((x) => x.message)].join(
        " · ",
      )
    : String(e);

// ---------------------------------------------------------------- inputs

/** Picked records keep their names locally; the query stores only IDs. */
type Names = Record<string, Picked<number>[]>;

function FiltersPanel({
  q,
  set,
  names,
  setNames,
}: {
  q: RateLookupQuery;
  set: (patch: Partial<RateLookupQuery>) => void;
  names: Names;
  setNames: (key: string, v: Picked<number>[]) => void;
}) {
  const ref = useReference();
  const picked = (key: keyof RateLookupQuery) => {
    const ids = (q[key] as number[] | undefined) ?? [];
    const known = names[key] ?? [];
    return ids.map((id) => known.find((p) => p.key === id) ?? { key: id, label: `#${id}` });
  };
  const pick = (key: keyof RateLookupQuery) => (v: Picked<number>[]) => {
    setNames(key, v);
    set({ [key]: v.map((p) => p.key) });
  };
  return (
    <div className="lk-filters">
      <section>
        <h3>Clients</h3>
        <div className="field">
          <span>Account managers</span>
          <RefMulti
            options={(ref.data?.accountManagers ?? []).map((u) => ({ value: u.id, label: u.displayName }))}
            value={q.accountManagerIds ?? []}
            onChange={(v) => set({ accountManagerIds: v })}
            placeholder="Find an account manager…"
          />
        </div>
        <div className="field">
          <span>Customers</span>
          <MultiPick<Enterprise, number>
            list="enterprises"
            fixed={[{ field: "type", op: "in", values: ["customer", "reciprocal"] }]}
            value={picked("customerEnterpriseIds")}
            onChange={pick("customerEnterpriseIds")}
            toPicked={(e) => ({ key: e.id, label: e.name })}
            detailOf={(e) => e.alias}
            placeholder="Search customers…"
          />
        </div>
        <div className="field">
          <span>Customer trunks</span>
          <TrunkPick kind="customer" value={picked("customerTrunkIds")} onChange={pick("customerTrunkIds")} />
        </div>
        <div className="field">
          <span>Rate tables</span>
          <MultiPick<RateTableRow, number>
            list="rate_tables"
            fixed={[{ field: "kind", op: "in", values: ["customer"] }]}
            value={picked("rateTableIds")}
            onChange={pick("rateTableIds")}
            toPicked={(t) => ({ key: t.id, label: t.name })}
            detailOf={(t) => `${t.category} · ${t.currency}`}
            placeholder="Search sell tables…"
          />
        </div>
      </section>
      <section>
        <h3>Vendors</h3>
        <div className="field">
          <span>Vendors</span>
          <MultiPick<Enterprise, number>
            list="enterprises"
            fixed={[{ field: "type", op: "in", values: ["vendor", "reciprocal"] }]}
            value={picked("vendorEnterpriseIds")}
            onChange={pick("vendorEnterpriseIds")}
            toPicked={(e) => ({ key: e.id, label: e.name })}
            detailOf={(e) => e.alias}
            placeholder="Search vendors…"
          />
        </div>
        <div className="field">
          <span>Vendor trunks</span>
          <TrunkPick kind="vendor" value={picked("vendorTrunkIds")} onChange={pick("vendorTrunkIds")} />
        </div>
        <div className="field">
          <span>Vendor tier</span>
          <div className="check-row">
            {(["tier1", "tier2", "tier3"] as const).map((t) => (
              <label key={t} className="toggle-inline">
                <input
                  type="checkbox"
                  checked={q.tiers?.includes(t) ?? false}
                  onChange={(e) =>
                    set({ tiers: e.target.checked ? [...(q.tiers ?? []), t] : (q.tiers ?? []).filter((x) => x !== t) })
                  }
                />
                Tier {t.slice(-1)}
              </label>
            ))}
          </div>
        </div>
      </section>
      <section>
        <h3>Both sides</h3>
        <div className="field">
          <span>Product categories</span>
          <RefMulti
            options={(ref.data?.productCategories ?? []).map((c) => ({ value: c.id, label: c.name }))}
            value={q.categoryIds ?? []}
            onChange={(v) => set({ categoryIds: v })}
            placeholder="Find a category…"
          />
        </div>
        <div className="field">
          <span>Business companies</span>
          <RefMulti
            options={(ref.data?.businessCompanies ?? []).map((c) => ({ value: c.id, label: c.name }))}
            value={q.businessCompanyIds ?? []}
            onChange={(v) => set({ businessCompanyIds: v })}
            placeholder="Find a company…"
          />
        </div>
        <div className="field">
          <span>Rate table currencies</span>
          <RefMulti
            options={(ref.data?.currencies ?? []).map((c) => ({ value: c.iso, label: `${c.iso} – ${c.name}` }))}
            value={q.currencies ?? []}
            onChange={(v) => set({ currencies: v })}
            placeholder="Find a currency…"
          />
        </div>
        <label className="field">
          <span>Sender ID</span>
          <input
            value={q.senderId ?? ""}
            maxLength={20}
            placeholder="Use sender-ID rates where a table has them"
            onChange={(e) => set({ senderId: e.target.value || undefined })}
          />
        </label>
      </section>
    </div>
  );
}

function SaveDialog({
  query,
  current,
  done,
}: {
  query: RateLookupQuery;
  current: SavedLookup | null;
  done: (saved: SavedLookup | null) => void;
}) {
  const save = useSaveLookup();
  const own = current && !current.readOnly ? current : null;
  const [name, setName] = useState(own?.name ?? "");
  const [shared, setShared] = useState<Picked<number>[]>(
    (own?.sharedWithUserIds ?? []).map((id) => ({ key: id, label: `#${id}` })),
  );
  const [error, setError] = useState<string | null>(null);
  const submit = (asNew: boolean) => {
    if (!name.trim()) return setError("Enter a name, e.g. “Ahmad's clients – GCC”.");
    save.mutate(
      {
        id: asNew || !own ? null : own.id,
        input: { name: name.trim(), query, sharedWithUserIds: shared.map((s) => s.key) },
      },
      {
        onSuccess: (s) => {
          toast({ tone: "good", message: `Saved lookup “${s.name}”` });
          done(s);
        },
        onError: (e) => setError(errText(e)),
      },
    );
  };
  return (
    <Modal
      title={own ? `Save lookup “${own.name}”` : "Save lookup"}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          {own && (
            <Button onClick={() => submit(true)} disabled={save.isPending}>
              Save as new
            </Button>
          )}
          <Button variant="primary" onClick={() => submit(false)} disabled={save.isPending}>
            {own ? "Save changes" : "Save"}
          </Button>
        </>
      }
    >
      <label className="field">
        <span>
          Name<span className="req">*</span>
        </span>
        <input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field">
        <span>Share with (read-only)</span>
        <MultiPick<UserSummary, number>
          list="users"
          value={shared}
          onChange={setShared}
          toPicked={(u) => ({ key: u.id, label: u.displayName })}
          detailOf={(u) => u.department ?? u.username}
          placeholder="Search colleagues…"
        />
      </div>
      <p className="muted small">
        The lookup keeps its destinations, filters, date, view and highlights, not the results.
      </p>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

function SavedMenu({ onLoad, current }: { onLoad: (s: SavedLookup) => void; current: SavedLookup | null }) {
  const saved = useSavedLookups();
  const del = useDeleteLookup();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button" className="btn btn-ghost" onClick={() => setOpen((v) => !v)}>
        <Icon name="star" size={14} /> Saved lookups <Icon name="chevronDown" size={12} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="end" className="choice-pop lk-saved">
        {saved.data?.length === 0 && <p className="muted small pad">No saved lookups yet.</p>}
        {saved.data?.map((s) => (
          <div key={s.id} className={`lk-saved-row${current?.id === s.id ? " on" : ""}`}>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onLoad(s);
              }}
            >
              <span>{s.name}</span>
              {s.readOnly && <span className="muted small">shared by {s.owner.displayName}</span>}
            </button>
            {!s.readOnly && (
              <button
                type="button"
                className="icon-btn"
                aria-label={`Delete ${s.name}`}
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: `Delete “${s.name}”?`,
                      message: "Colleagues it was shared with lose it too.",
                      ok: "Delete",
                      danger: true,
                    })
                  )
                    del.mutate(s.id);
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            )}
          </div>
        ))}
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------- matrix cells

function cellView(view: MatrixView, c: MatrixCell, converted: boolean, ccy: string, row: MatrixRow): ReactNode {
  const value = converted ? money(c.rateConverted, ccy) : money(c.rate, c.currency);
  const tags = (
    <>
      {c.routed && <span className="lk-dot accent" title="Routing uses this vendor" />}
      {c.expiring && <span className="lk-dot warning" title="Ends within 14 days with no new version" />}
      {c.scheduled && (
        <span
          className="muted small"
          title={`Scheduled ${c.scheduled.rate} from ${c.scheduled.effectiveFrom.slice(0, 10)}`}
        >
          {c.scheduled.rate > c.rate ? "↑" : "↓"}
        </span>
      )}
    </>
  );
  if (view === "vendor_costs")
    return (
      <span className={c.best ? "tone-good strong" : ""}>
        {value}
        {tags}
      </span>
    );
  if (view === "cheapest")
    return (
      <span className="lk-cheap" title={`${c.vendorName} · ASR ${c.asr ?? "—"}% · DLR ${c.dlr ?? "—"}% (24h)`}>
        <span className="lk-cheap-name">{c.vendorName}</span>
        <span className={`num${c.best ? " tone-good strong" : ""}`}>
          {value}
          {tags}
        </span>
      </span>
    );
  const below = row.bestCost !== null && c.rateConverted < row.bestCost;
  if (view === "client_rates")
    return (
      <span className={below ? "tone-error strong" : ""} title={`Margin vs best ${signed(c.marginBest)} ${ccy}`}>
        {value}
        {tags}
      </span>
    );
  return (
    <span className="lk-margin" title={`Sell ${value} · routed to ${c.routedVendor ?? "—"}`}>
      <span className={(c.marginBest ?? 0) < 0 ? "tone-error strong" : ""}>{signed4(c.marginBest)}</span>
      <span className="muted">/</span>
      <span className={(c.marginRouted ?? 0) < 0 ? "tone-error strong" : ""}>{signed4(c.marginRouted)}</span>
    </span>
  );
}

/** Margins in the matrix keep 4 decimals so both fit a cell. */
const signed4 = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(4)}`;

const cellText = (view: MatrixView, c: MatrixCell | null, converted: boolean) => {
  if (!c) return "";
  const v = converted ? c.rateConverted : c.rate;
  if (view === "cheapest") return `${c.vendorName} ${v}`;
  if (view === "margin") return `${c.marginBest ?? ""} / ${c.marginRouted ?? ""}`;
  return v;
};

// ---------------------------------------------------------------- page body

export const emptyQuery = (): RateLookupQuery => ({ view: "vendor_costs", cheapestN: 3, highlights: [] });

export function AdvancedLookup({
  applied,
  apply,
  names,
  setNames,
}: {
  applied: RateLookupQuery | null;
  apply: (q: RateLookupQuery | null) => void;
  names: Names;
  setNames: (key: string, v: Picked<number>[]) => void;
}) {
  const ref = useReference();
  const navigate = useTabNavigate();
  const [draft, setDraft] = useState<RateLookupQuery>(applied ?? emptyQuery());
  const [paste, setPaste] = useState(() => [...(applied?.mccmncs ?? []), ...(applied?.numbers ?? [])].join("\n"));
  const [countryQ, setCountryQ] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loaded, setLoaded] = useState<SavedLookup | null>(null);
  const [saving, setSaving] = useState(false);
  const filtersRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<RateLookupQuery>) => setDraft((d) => ({ ...d, ...patch }));
  const parsed = useMemo(() => parseDestinations(paste), [paste]);
  const converted = draft.currency === "converted";

  const queryOf = (d: RateLookupQuery): RateLookupQuery => {
    const out: RateLookupQuery = { ...d, mccmncs: parsed.mccmncs, numbers: parsed.numbers };
    for (const k of Object.keys(out) as (keyof RateLookupQuery)[]) {
      const v = out[k];
      if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) delete out[k];
    }
    return out;
  };
  const run = (d = draft) => {
    const q = queryOf(d);
    if (!q.countryIds?.length && !q.mccmncs?.length && !q.numbers?.length)
      return toast({ tone: "info", message: "Choose countries or paste MCCMNCs or numbers first." });
    apply(q);
  };

  const matrix = useInfiniteQuery({
    queryKey: ["lookup", "matrix", applied],
    queryFn: ({ pageParam }) => fetchMatrixPage({ ...applied!, limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (p: RateMatrix) => p.nextCursor,
    enabled: applied !== null,
    retry: false,
  });
  const first = matrix.data?.pages[0];
  const rows = useMemo(() => matrix.data?.pages.flatMap((p) => p.rows) ?? [], [matrix.data]);
  const view = first?.view ?? applied?.view ?? "vendor_costs";
  const platform = usePlatformCurrency();
  const ccy = first?.lookupCurrency ?? platform;
  const shownConverted = applied?.currency === "converted";

  usePageStatus({
    rows: first
      ? `${first.total.toLocaleString("en-US")} destinations · ${rows.length.toLocaleString("en-US")} loaded · ${first.columns.length}${first.columnsTruncated ? "+" : ""} columns`
      : matrix.isFetching
        ? "Looking up…"
        : "",
    shortcuts: "Scroll for more destinations · Ctrl-click a name: new tab",
  });

  const columns = useMemo<VColumn<MatrixRow>[]>(() => {
    if (!first) return [];
    const fixed: VColumn<MatrixRow>[] = [
      {
        key: "dest",
        header: "Destination",
        width: 230,
        sticky: true,
        render: (r) => (
          <span className="lk-name" title={`${r.destination.country} · ${r.destination.network}`}>
            <span className="num muted">
              {r.destination.allNetworks ? `${r.destination.mccmnc}·all` : r.destination.mccmnc}
            </span>{" "}
            <span className="strong">{r.destination.country}</span>{" "}
            <span className="muted small">{r.destination.allNetworks ? "all networks" : r.destination.network}</span>
          </span>
        ),
      },
      {
        key: "best",
        header: `Best (${ccy})`,
        width: 104,
        align: "right",
        sticky: true,
        title: "Cheapest active vendor",
        render: (r) => <span title={r.bestVendor ?? ""}>{money(r.bestCost, ccy)}</span>,
      },
      { key: "n", header: "Vendors", width: 66, align: "right", sticky: true, render: (r) => r.vendorCount },
      {
        key: "flags",
        header: "Highlights",
        width: 196,
        sticky: true,
        render: (r) => (
          <span className="lk-flags">
            {r.highlights.map((h) => {
              const d = HIGHLIGHTS.find((x) => x.value === h)!;
              return (
                <span key={h} className={`lk-flag tone-${d.tone}`} title={d.title}>
                  {d.short}
                </span>
              );
            })}
          </span>
        ),
      },
    ];
    const data = first.columns.map((c: MatrixColumn, i: number) => ({
      key: c.key,
      header: (
        <span className="lk-colhead" title={`${c.name} · ${c.detail}`}>
          <span>{c.name}</span>
          <span className="muted small">{c.detail}</span>
        </span>
      ),
      width: view === "cheapest" ? 210 : view === "margin" ? 156 : 118,
      align: (view === "cheapest" ? "left" : "right") as "left" | "right",
      render: (r: MatrixRow) => {
        const cell = r.cells[i];
        return cell ? cellView(view, cell, shownConverted, ccy, r) : <span className="muted">·</span>;
      },
    }));
    return [...fixed, ...data];
  }, [first, view, shownConverted, ccy]);

  const copyTable = () => {
    if (!first) return;
    const head = [
      "MCCMNC",
      "Country",
      "Network",
      `Best ${ccy}`,
      "Best vendor",
      "Vendors",
      "Highlights",
      ...first.columns.map((c) => `${c.name} (${c.detail})`),
    ];
    const body = rows.map((r) => [
      r.destination.mccmnc,
      r.destination.country,
      r.destination.network,
      r.bestCost,
      r.bestVendor,
      r.vendorCount,
      r.highlights.join(" "),
      ...r.cells.map((c) => cellText(view, c, shownConverted)),
    ]);
    void navigator.clipboard
      .writeText(toDelimited([head, ...body], "\t"))
      .then(() => toast({ tone: "good", message: `${body.length} loaded rows copied – paste into a spreadsheet` }))
      .catch(() => toast({ tone: "error", message: "The browser did not allow copying" }));
  };

  const countries = ref.data?.countries ?? [];
  const countryHits = countryQ.trim()
    ? countries
        .filter(
          (c) => c.name.toLowerCase().includes(countryQ.trim().toLowerCase()) && !draft.countryIds?.includes(c.id),
        )
        .slice(0, 8)
    : [];
  const nFilters = filterCount(draft);

  return (
    <div className="lk-adv">
      <div className="lk-form">
        <div className="lk-form-main">
          <div className="field lk-countries">
            <span>Countries</span>
            <div className="chips">
              {(draft.countryIds ?? []).map((id) => (
                <span key={id} className="chip">
                  {countries.find((c) => c.id === id)?.name ?? `#${id}`}
                  <button
                    type="button"
                    aria-label="Remove"
                    onClick={() => set({ countryIds: (draft.countryIds ?? []).filter((x) => x !== id) })}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ))}
              <span className="lk-country-input">
                <input
                  value={countryQ}
                  placeholder="Add a country…"
                  aria-label="Add a country"
                  onChange={(e) => setCountryQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && countryHits[0]) {
                      e.preventDefault();
                      set({ countryIds: [...(draft.countryIds ?? []), countryHits[0].id] });
                      setCountryQ("");
                    }
                  }}
                />
                {countryHits.length > 0 && (
                  <span className="lk-suggest">
                    {countryHits.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          set({ countryIds: [...(draft.countryIds ?? []), c.id] });
                          setCountryQ("");
                        }}
                      >
                        <span>{c.name}</span>
                        <span className="muted num">+{c.dialCode}</span>
                      </button>
                    ))}
                  </span>
                )}
              </span>
            </div>
          </div>
          <label className="field lk-paste">
            <span>
              MCCMNCs or numbers{" "}
              <span className="muted small">
                {parsed.mccmncs.length} codes · {parsed.numbers.length} numbers
                {parsed.invalid.length ? ` · ${parsed.invalid.length} not read` : ""}
              </span>
            </span>
            <textarea
              rows={3}
              value={paste}
              placeholder={"50501, 50502\n+61412345678"}
              onChange={(e) => setPaste(e.target.value)}
              title={parsed.invalid.length ? `Not read: ${parsed.invalid.slice(0, 20).join(", ")}` : undefined}
            />
          </label>
          <div className="lk-file">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const text = await f.text();
                const p = parseDestinations(text);
                setPaste((cur) => [cur.trim(), ...p.mccmncs, ...p.numbers].filter(Boolean).join("\n"));
                toast({ tone: "info", message: `${f.name}: ${p.mccmncs.length} codes, ${p.numbers.length} numbers` });
                e.target.value = "";
              }}
            />
            <Button small icon="upload" onClick={() => fileRef.current?.click()}>
              Upload file
            </Button>
          </div>
        </div>
        <div className="lk-form-row">
          <div className="segmented" role="radiogroup" aria-label="View">
            {VIEWS.map((v) => (
              <button
                key={v.value}
                type="button"
                role="radio"
                aria-checked={draft.view === v.value}
                className={draft.view === v.value ? "on" : ""}
                onClick={() => set({ view: v.value })}
              >
                {v.label}
              </button>
            ))}
          </div>
          {draft.view === "cheapest" && (
            <label className="toggle-inline">
              N
              <select value={draft.cheapestN ?? 3} onChange={(e) => set({ cheapestN: Number(e.target.value) })}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            ref={filtersRef}
            type="button"
            className={`btn btn-default${nFilters ? " has-value" : ""}`}
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <Icon name="filter" size={14} /> Filters{nFilters ? ` (${nFilters})` : ""}
          </button>
          <Popover
            anchor={filtersRef}
            open={filtersOpen}
            onClose={() => setFiltersOpen(false)}
            className="lk-filters-pop"
          >
            <FiltersPanel q={draft} set={set} names={names} setNames={setNames} />
          </Popover>
          <label className="toggle-inline" title="Rates valid at this time (UTC); empty = now">
            As of
            <DateTimeInput
              value={draft.asOf ? draft.asOf.slice(0, 16) : ""}
              onChange={(e) =>
                set({ asOf: e.target.value ? new Date(`${e.target.value}:00Z`).toISOString() : undefined })
              }
            />
          </label>
          <label className="toggle-inline">
            <input
              type="checkbox"
              checked={!!draft.includeInactive}
              onChange={(e) => set({ includeInactive: e.target.checked || undefined })}
            />
            Include inactive
          </label>
          <div className="segmented small" role="radiogroup" aria-label="Currency">
            <button type="button" className={!converted ? "on" : ""} onClick={() => set({ currency: "original" })}>
              Original
            </button>
            <button type="button" className={converted ? "on" : ""} onClick={() => set({ currency: "converted" })}>
              {ccy}
            </button>
          </div>
        </div>
        <div className="lk-form-row">
          <span className="muted">Only destinations with</span>
          {HIGHLIGHTS.map((h) => {
            const on = draft.highlights?.includes(h.value) ?? false;
            return (
              <button
                key={h.value}
                type="button"
                className={`chip${on ? " accent" : ""}`}
                aria-pressed={on}
                title={h.title}
                onClick={() =>
                  set({
                    highlights: on
                      ? (draft.highlights ?? []).filter((x) => x !== h.value)
                      : [...(draft.highlights ?? []), h.value],
                  })
                }
              >
                {h.label}
              </button>
            );
          })}
          <span className="fb-spacer" />
          <SavedMenu
            current={loaded}
            onLoad={(s) => {
              setLoaded(s);
              setDraft({ ...emptyQuery(), ...s.query });
              setPaste([...(s.query.mccmncs ?? []), ...(s.query.numbers ?? [])].join("\n"));
              apply(s.query);
            }}
          />
          <Button icon="save" onClick={() => setSaving(true)}>
            Save lookup
          </Button>
          <Button
            onClick={() => {
              setDraft(emptyQuery());
              setPaste("");
              setLoaded(null);
              apply(null);
            }}
          >
            Clear
          </Button>
          <Button
            variant="primary"
            icon="search"
            onClick={() => run()}
            disabled={matrix.isFetching && !matrix.isFetchingNextPage}
          >
            Look up
          </Button>
        </div>
      </div>

      {applied && (
        <div className="lk-results-bar">
          {loaded && <span className="tag tag-accent">{loaded.name}</span>}
          {first && (
            <span className="muted">
              {first.total.toLocaleString("en-US")} destinations as of {first.asOf.slice(0, 16).replace("T", " ")} UTC
              {first.columnsTruncated
                ? " · the 60 trunks covering most destinations are shown; narrow with filters"
                : ""}
            </span>
          )}
          {first && first.unresolved.length > 0 && (
            <span className="tone-warning small" title={first.unresolved.join(", ")}>
              {first.unresolved.length} not found
            </span>
          )}
          <span className="fb-spacer" />
          <Button
            small
            disabled={!rows.length}
            title="Re-price the destinations shown (up to 500) in the bulk rating workspace (§13.11)"
            onClick={() =>
              navigate(
                scopeUrl({
                  tables: applied?.rateTableIds ?? [],
                  mccmncs: [...new Set(rows.slice(0, 500).map((r) => r.destination.mccmnc))],
                }),
                { newTab: true, title: "Bulk rating" },
              )
            }
          >
            Update rates
          </Button>
          <Button small disabled title="Bulk routing: use Route Rules' Bulk edit (§13.11)">
            Change route
          </Button>
          <Button small icon="copy" onClick={copyTable} disabled={!rows.length}>
            Copy
          </Button>
          <Button
            small
            icon="download"
            disabled={!first}
            onClick={() => void exportMatrix(applied).catch((e) => toast({ tone: "error", message: errText(e) }))}
          >
            Export CSV
          </Button>
        </div>
      )}
      {matrix.isError && <p className="error-text">{errText(matrix.error)}</p>}
      {applied && matrix.isPending && <div className="lk-hint muted">Looking up…</div>}
      {!applied && (
        <div className="lk-hint muted">
          Choose countries or paste MCCMNCs or numbers, pick a view and press Look up.
        </div>
      )}
      {first && (
        <div className="lk-matrix">
          <VirtualTable
            label="Rate lookup results"
            rows={rows}
            columns={columns}
            rowKey={(r) => r.destination.mccmnc}
            rowClass={(r) => (r.highlights.includes("below_cost") ? "negative" : undefined)}
            onEndReached={() => matrix.hasNextPage && void matrix.fetchNextPage()}
            loadingMore={matrix.isFetchingNextPage}
            empty="No destination matches these highlights."
          />
          <p className="muted small lk-foot">
            {view === "margin"
              ? `Cells: margin vs best / vs routed vendor, ${ccy}. `
              : view === "cheapest"
                ? "Hover a cell for the vendor's 24h ASR and DLR. "
                : ""}
            <span className="lk-dot accent" /> routed · <span className="lk-dot warning" /> expiring · ↑↓ scheduled
            change · green = best cost · red = below cost.{" "}
            <button type="button" className="link" onClick={() => navigate("/rates/manager", { forceNew: true })}>
              Open Rate Manager
            </button>
          </p>
        </div>
      )}
      {saving && (
        <SaveDialog
          query={queryOf(draft)}
          current={loaded}
          done={(s) => {
            setSaving(false);
            if (s) setLoaded(s);
          }}
        />
      )}
    </div>
  );
}
