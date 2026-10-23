// Margin calculator (team trial round 3, §13.12): the SMS version of the team's swap-deal sheet. Two legs with the
// same carrier: "Us to carrier" (we send, the carrier is our vendor) and "Carrier to us" (it sends, it is our
// customer). Each leg lists destinations with cost, selling rate and SMS over the period; the page works out margin
// per SMS, per day and in total, the deal's total margin and the netting (who pays whom). Deals can be saved.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Destination, Enterprise, MarginDealInput, MarginDealLine } from "@sms/contract";
import { ApiError } from "../../api/client";
import { fetchListPage } from "../../api/hooks";
import { downloadBlob } from "../../api/lookup";
import { fetchMarginDeal, useDeleteMarginDeal, useMarginDeals, useSaveMarginDeal } from "../../api/marginDeals";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { ListLookup } from "../../records/parts";
import { useTabDirty } from "../../shell/tabContext";
import { confirmDialog, toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, Popover } from "../../ui/primitives";
import { blankDeal, blankLine, dealCsv, dealSummary, lineFigures } from "./marginModel";

const page = pageForPath("/rates/margin-calculator")!;

const money = (v: number, digits = 2) =>
  v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const rate = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
const count = (v: number) => Math.round(v).toLocaleString("en-US");

function numberOf(text: string): number {
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** A number box that keeps what is typed (e.g. "0.0") and reports the value. */
function NumberCell({
  value,
  onChange,
  integer,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  integer?: boolean;
  label: string;
}) {
  const [text, setText] = useState(value ? String(value) : "");
  useEffect(() => {
    if (numberOf(text) !== value) setText(value ? String(value) : "");
    // Only an outside change (a loaded deal) replaces the text.
  }, [value]);
  return (
    <input
      className="mc-num"
      inputMode="decimal"
      aria-label={label}
      value={text}
      placeholder="0"
      onChange={(e) => {
        setText(e.target.value);
        const n = numberOf(e.target.value);
        onChange(integer ? Math.round(n) : n);
      }}
    />
  );
}

/** Destination box with suggestions from the MCCMNC list; free text is fine too. */
function DestinationCell({ line, onChange }: { line: MarginDealLine; onChange: (l: MarginDealLine) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const q = line.destination.trim();
  const found = useQuery({
    queryKey: ["lookup", "destinations", "margin", q],
    queryFn: () => fetchListPage<Destination>("destinations", { search: q, limit: 12, withTotal: false }),
    enabled: open && q.length >= 2,
    staleTime: 60_000,
  });
  return (
    <>
      <input
        ref={ref}
        className="mc-dest"
        aria-label="Destination"
        placeholder="Country · network"
        value={line.destination}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange({ ...line, destination: e.target.value, mccmnc: null });
          setOpen(true);
        }}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      />
      <Popover
        anchor={ref}
        open={open && !!found.data?.rows.length}
        onClose={() => setOpen(false)}
        className="picker-pop"
      >
        <div className="picker-list" role="listbox" onMouseDown={(e) => e.preventDefault()}>
          {found.data?.rows.map((d) => (
            <button
              key={d.id}
              type="button"
              role="option"
              aria-selected={line.mccmnc === d.mccmnc}
              onClick={() => {
                onChange({ ...line, destination: `${d.country} · ${d.network}`, mccmnc: d.mccmnc });
                setOpen(false);
              }}
            >
              <span>
                {d.country} · {d.network}
              </span>
              <span className="muted small">{d.mccmnc}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function LegTable({
  title,
  hint,
  side,
  lines,
  periodDays,
  currency,
  onChange,
}: {
  title: string;
  hint: string;
  side: "outbound" | "inbound";
  lines: MarginDealLine[];
  periodDays: number;
  currency: string;
  onChange: (lines: MarginDealLine[]) => void;
}) {
  const totals = dealSummary({ outbound: lines, inbound: [], periodDays }).outbound;
  const set = (i: number, l: MarginDealLine) => onChange(lines.map((x, j) => (j === i ? l : x)));
  const out = side === "outbound";
  return (
    <section className="mc-leg" aria-label={title}>
      <header>
        <h2>{title}</h2>
        <span className="muted small">{hint}</span>
      </header>
      <div className="mc-table-wrap">
        <table className="mc-table">
          <thead>
            <tr>
              <th className="mc-input-col">Destination</th>
              <th className="mc-input-col num">Cost / SMS</th>
              <th className="mc-input-col num">Selling rate</th>
              <th className="mc-input-col num">SMS</th>
              <th className="num">Margin / SMS</th>
              <th className="num">{out ? "Cost / day" : "Revenue / day"}</th>
              <th className="num">Margin / day</th>
              <th className="num">SMS / day</th>
              <th className="num">{out ? "Total cost" : "Total revenue"}</th>
              <th className="num">Total margin</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const f = lineFigures(l, periodDays);
              return (
                <tr key={i}>
                  <td>
                    <DestinationCell line={l} onChange={(x) => set(i, x)} />
                  </td>
                  <td className="num">
                    <NumberCell label="Cost per SMS" value={l.cost} onChange={(v) => set(i, { ...l, cost: v })} />
                  </td>
                  <td className="num">
                    <NumberCell label="Selling rate" value={l.rate} onChange={(v) => set(i, { ...l, rate: v })} />
                  </td>
                  <td className="num">
                    <NumberCell
                      label="SMS"
                      integer
                      value={l.messages}
                      onChange={(v) => set(i, { ...l, messages: v })}
                    />
                  </td>
                  <td className={`num ${f.marginPerSms < 0 ? "bad" : ""}`}>{rate(f.marginPerSms)}</td>
                  <td className="num">{money(out ? f.costPerDay : f.revenuePerDay)}</td>
                  <td className={`num ${f.marginPerDay < 0 ? "bad" : ""}`}>{money(f.marginPerDay)}</td>
                  <td className="num">{count(f.smsPerDay)}</td>
                  <td className="num">{money(out ? f.totalCost : f.totalRevenue)}</td>
                  <td className={`num strong ${f.totalMargin < 0 ? "bad" : ""}`}>{money(f.totalMargin)}</td>
                  <td>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Remove this destination"
                      onClick={() => onChange(lines.length > 1 ? lines.filter((_, j) => j !== i) : [blankLine()])}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>
                <button type="button" className="link small" onClick={() => onChange([...lines, blankLine()])}>
                  + Add destination
                </button>
              </td>
              <td colSpan={2} className="muted small">
                Total ({currency})
              </td>
              <td className="num">{count(totals.messages)}</td>
              <td />
              <td className="num">{money(out ? totals.costPerDay : totals.revenuePerDay)}</td>
              <td className={`num ${totals.marginPerDay < 0 ? "bad" : ""}`}>{money(totals.marginPerDay)}</td>
              <td className="num">{count(totals.smsPerDay)}</td>
              <td className="num">{money(out ? totals.cost : totals.revenue)}</td>
              <td className={`num strong ${totals.margin < 0 ? "bad" : ""}`}>{money(totals.margin)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function DealsButton({ onPick }: { onPick: (id: number) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const deals = useMarginDeals(q.trim(), open);
  return (
    <>
      <button ref={ref} type="button" className="btn btn-default" onClick={() => setOpen((v) => !v)}>
        <Icon name="folder" size={15} />
        Saved deals <Icon name="chevronDown" size={13} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="picker-pop mc-deals-pop" align="end">
        <input
          autoFocus
          placeholder="Deal or carrier…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Find a deal"
        />
        <div className="picker-list" role="listbox">
          {deals.data?.map((d) => (
            <button
              key={d.id}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => {
                setOpen(false);
                onPick(d.id);
              }}
            >
              <span>
                {d.name} <span className="muted">· {d.carrierName}</span>
              </span>
              <span className={`small ${d.totalMargin < 0 ? "bad" : "muted"}`}>
                {money(d.totalMargin)} {d.currency}
              </span>
            </button>
          ))}
          {deals.isSuccess && !deals.data.length && <p className="muted small pad">No saved deals.</p>}
        </div>
      </Popover>
    </>
  );
}

export function MarginCalculatorPage() {
  const [deal, setDeal] = useState<MarginDealInput>(blankDeal);
  const [id, setId] = useState<number | null>(null);
  const [saved, setSaved] = useState(() => JSON.stringify(blankDeal()));
  const save = useSaveMarginDeal();
  const remove = useDeleteMarginDeal();
  const dirty = JSON.stringify(deal) !== saved;
  useTabDirty(dirty);
  const s = useMemo(() => dealSummary(deal), [deal]);
  const carrier = deal.carrierName.trim() || "the carrier";
  const set = <K extends keyof MarginDealInput>(k: K, v: MarginDealInput[K]) => setDeal((d) => ({ ...d, [k]: v }));

  const leave = async () =>
    !dirty ||
    confirmDialog({
      title: "Discard changes?",
      message: "This deal has changes that are not saved.",
      ok: "Discard",
      danger: true,
    });

  const load = async (dealId: number) => {
    if (!(await leave())) return;
    try {
      const d = await fetchMarginDeal(dealId);
      const input: MarginDealInput = {
        name: d.name,
        carrierEnterpriseId: d.carrierEnterpriseId ?? null,
        carrierName: d.carrierName,
        currency: d.currency,
        periodDays: d.periodDays,
        notes: d.notes ?? null,
        outbound: d.outbound.length ? d.outbound : [blankLine()],
        inbound: d.inbound.length ? d.inbound : [blankLine()],
      };
      setDeal(input);
      setId(d.id);
      setSaved(JSON.stringify(input));
    } catch (e) {
      toast({ tone: "error", message: e instanceof ApiError ? e.message : String(e) });
    }
  };

  const doSave = () => {
    // Blank rows are left out; the sheet keeps one empty row to type in.
    const used = (l: MarginDealLine) => l.destination.trim() || l.cost || l.rate || l.messages;
    const input = { ...deal, outbound: deal.outbound.filter(used), inbound: deal.inbound.filter(used) };
    if (!input.name.trim()) return toast({ tone: "warning", message: "Give the deal a name" });
    if (!input.carrierName.trim()) return toast({ tone: "warning", message: "Enter the carrier" });
    if ([...input.outbound, ...input.inbound].some((l) => !l.destination.trim()))
      return toast({ tone: "warning", message: "Every row with figures needs a destination" });
    save.mutate(
      { id, input },
      {
        onSuccess: (d) => {
          const next = {
            ...input,
            outbound: input.outbound.length ? input.outbound : [blankLine()],
            inbound: input.inbound.length ? input.inbound : [blankLine()],
          };
          setDeal(next);
          setId(d.id);
          setSaved(JSON.stringify(next));
          toast({ tone: "good", message: `Deal "${d.name}" saved` });
        },
        onError: (e) => toast({ tone: "error", message: e instanceof ApiError ? e.message : String(e) }),
      },
    );
  };

  const doNew = async () => {
    if (!(await leave())) return;
    const d = blankDeal();
    setDeal(d);
    setId(null);
    setSaved(JSON.stringify(d));
  };

  const doDelete = async () => {
    if (id === null) return;
    if (
      !(await confirmDialog({
        title: "Delete deal",
        message: `Delete the saved deal "${deal.name}"? The figures on screen stay until you leave.`,
        ok: "Delete",
        danger: true,
      }))
    )
      return;
    remove.mutate(id, {
      onSuccess: () => {
        setId(null);
        setSaved("");
        toast({ tone: "good", message: "Deal deleted" });
      },
      onError: (e) => toast({ tone: "error", message: e instanceof ApiError ? e.message : String(e) }),
    });
  };

  const exportCsv = () => {
    const name = (deal.name.trim() || "margin-deal").replace(/[^\w.-]+/g, "-");
    downloadBlob(new Blob([dealCsv(deal)], { type: "text/csv" }), `${name}.csv`);
  };

  return (
    <div className="page mc-page">
      <PageHeader
        page={page}
        actions={
          <>
            <DealsButton onPick={(dealId) => void load(dealId)} />
            <Button icon="plus" onClick={() => void doNew()}>
              New
            </Button>
            <Button icon="download" onClick={exportCsv}>
              Export CSV
            </Button>
            {id !== null && (
              <Button icon="trash" onClick={() => void doDelete()}>
                Delete
              </Button>
            )}
            <Button variant="primary" icon="save" disabled={save.isPending || !dirty} onClick={doSave}>
              {id === null ? "Save deal" : "Save"}
            </Button>
          </>
        }
      />
      <div className="mc-body">
        <section className="mc-deal" aria-label="Deal">
          <label className="field">
            <span>Deal name</span>
            <input
              value={deal.name}
              maxLength={120}
              placeholder="e.g. Q4 swap"
              onChange={(e) => set("name", e.target.value)}
            />
          </label>
          <label className="field">
            <span>Carrier</span>
            <input
              value={deal.carrierName}
              maxLength={120}
              placeholder="Carrier name"
              onChange={(e) => set("carrierName", e.target.value)}
            />
          </label>
          <div className="field">
            <span>Enterprise (optional)</span>
            <ListLookup<Enterprise>
              list="enterprises"
              value={deal.carrierEnterpriseId ?? null}
              onChange={(e) =>
                setDeal((d) => ({ ...d, carrierEnterpriseId: e?.id ?? null, carrierName: e ? e.name : d.carrierName }))
              }
              labelOf={(e) => e.name}
              detailOf={(e) => `${e.alias} · ${e.type}`}
              placeholder="Link to an enterprise…"
            />
          </div>
          <label className="field mc-short">
            <span>Currency</span>
            <input
              value={deal.currency}
              maxLength={3}
              onChange={(e) => set("currency", e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
            />
          </label>
          <label className="field mc-short">
            <span>Period (days)</span>
            <input
              inputMode="numeric"
              value={deal.periodDays || ""}
              onChange={(e) => set("periodDays", Math.min(366, Math.max(0, Math.round(numberOf(e.target.value)))))}
              onBlur={() => !deal.periodDays && set("periodDays", 30)}
            />
          </label>
          <label className="field mc-notes">
            <span>Notes</span>
            <input
              value={deal.notes ?? ""}
              maxLength={2000}
              placeholder="Terms, validity, contacts…"
              onChange={(e) => set("notes", e.target.value || null)}
            />
          </label>
        </section>

        <section className="mc-summary" aria-label="Summary">
          <div className="mc-card">
            <span className="mc-card-label">Total margin</span>
            <strong className={s.totalMargin < 0 ? "bad" : s.totalMargin > 0 ? "good" : ""}>
              {money(s.totalMargin)} {deal.currency}
            </strong>
            <span className="muted small">
              {money(s.totalMargin / Math.max(1, deal.periodDays))} / day over {deal.periodDays || 30} days
            </span>
          </div>
          <div className="mc-card">
            <span className="mc-card-label">Netting</span>
            <strong>
              {money(Math.abs(s.netting))} {deal.currency}
            </strong>
            <span className="small">
              {s.netting > 0 ? `We pay ${carrier}` : s.netting < 0 ? `${carrier} pays us` : "Even: nobody pays"}
            </span>
          </div>
          <div className="mc-card">
            <span className="mc-card-label">Us to {carrier}</span>
            <strong className={s.outbound.margin < 0 ? "bad" : ""}>
              {money(s.outbound.margin)} {deal.currency}
            </strong>
            <span className="muted small">
              {count(s.outbound.messages)} SMS · cost {money(s.outbound.cost)}
            </span>
          </div>
          <div className="mc-card">
            <span className="mc-card-label">{deal.carrierName.trim() || "Carrier"} to us</span>
            <strong className={s.inbound.margin < 0 ? "bad" : ""}>
              {money(s.inbound.margin)} {deal.currency}
            </strong>
            <span className="muted small">
              {count(s.inbound.messages)} SMS · revenue {money(s.inbound.revenue)}
            </span>
          </div>
        </section>

        <LegTable
          title={`Us to ${carrier}`}
          hint="We send this traffic to the carrier: the carrier is our vendor (cost) and we sell it on to our clients."
          side="outbound"
          lines={deal.outbound}
          periodDays={deal.periodDays}
          currency={deal.currency}
          onChange={(l) => set("outbound", l)}
        />
        <LegTable
          title={`${deal.carrierName.trim() || "Carrier"} to us`}
          hint="The carrier sends us this traffic: the carrier is our customer (selling rate) and our vendors carry it (cost)."
          side="inbound"
          lines={deal.inbound}
          periodDays={deal.periodDays}
          currency={deal.currency}
          onChange={(l) => set("inbound", l)}
        />
      </div>
    </div>
  );
}
