// Currencies and exchange rates (§7): three views in the tab URL (?view=). Currency (Add,
// Edit, Export), Currency Exchange (Edit, Sync Rates; the rate in force per currency, units per
// 1 USD) and the Currency Exchange History (every rate, who and when). A new rate starts now
// and earlier ones stay, so amounts already converted never move (§13.29).
import { useState } from "react";
import { useLocation } from "react-router";
import type { CurrencyInput, CurrencyRateHistoryRow, CurrencyRateRow, CurrencyRow } from "@sms/contract";
import { useSaveCurrency, useSetRate, useSyncRates } from "../../api/finance";
import { downloadCsv } from "../../api/masterData";
import { NumberField, TextField, useForm } from "../../form/form";
import { toListQuery } from "../../grid/filterModel";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, confirmDialog, toast } from "../../ui/feedback";
import { Button } from "../../ui/primitives";
import { fmtWhen, RecordDialog } from "../reference/shared";
import { problemText } from "../routing/dialogs";

const page = pageForPath("/finance/currencies")!;
type View = "currencies" | "exchange" | "history";

function useView(): [View, (v: View) => void] {
  const location = useLocation();
  const navigate = useTabNavigate();
  const raw = new URLSearchParams(location.search).get("view");
  const view: View = raw === "exchange" || raw === "history" ? raw : "currencies";
  return [view, (v) => navigate(`/finance/currencies?view=${v}`, { replace: true })];
}

function ViewSwitch({ note }: { note: string }) {
  const [view, setView] = useView();
  return (
    <div className="rm-trunk">
      <div className="segmented small" role="radiogroup" aria-label="View">
        {(
          [
            ["currencies", "Currency"],
            ["exchange", "Currency Exchange"],
            ["history", "Exchange history"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={view === k}
            className={view === k ? "on" : ""}
            onClick={() => setView(k)}
          >
            {l}
          </button>
        ))}
      </div>
      <span className="muted small">{note}</span>
    </div>
  );
}

const rateText = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 6 });

// ---------------------------------------------------------------- dialogs

function CurrencyDialog({ row, done }: { row: CurrencyRow | null; done: () => void }) {
  const form = useForm<CurrencyInput>({
    iso: row?.iso ?? "",
    name: row?.name ?? "",
    symbol: row?.symbol ?? "",
    ratePerUsd: row?.ratePerUsd ?? 1,
  });
  const save = useSaveCurrency();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    save.mutate(
      { id: row?.id ?? null, input: { ...form.values, iso: form.values.iso.toUpperCase() } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `${row ? "Saved" : "Added"} ${r.record.iso}`);
          done();
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  return (
    <RecordDialog
      title={row ? `Edit ${row.iso}` : "Add currency"}
      saveLabel={row ? "Save" : "Add currency"}
      saving={save.isPending}
      error={error}
      onSave={submit}
      onClose={done}
    >
      <TextField form={form} path="name" label="Currency" required maxLength={60} nullable={false} />
      <TextField form={form} path="symbol" label="Symbol" required maxLength={8} nullable={false} />
      {!row && (
        <>
          <TextField
            form={form}
            path="iso"
            label="ISO"
            required
            maxLength={3}
            nullable={false}
            placeholder="CHF"
            hint="Three letters; it cannot change later"
          />
          <NumberField form={form} path="ratePerUsd" label="Rate" required min={0} step={0.000001} suffix="per 1 USD" />
        </>
      )}
    </RecordDialog>
  );
}

function RateDialog({ row, done }: { row: CurrencyRateRow; done: () => void }) {
  const form = useForm<{ ratePerUsd: number }>({ ratePerUsd: row.ratePerUsd });
  const set = useSetRate();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const move = row.ratePerUsd ? ((form.values.ratePerUsd - row.ratePerUsd) / row.ratePerUsd) * 100 : 0;
  const submit = () =>
    set.mutate(
      { iso: row.iso, ratePerUsd: form.values.ratePerUsd },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `${row.iso} = ${rateText(r.record.ratePerUsd)} per USD`);
          done();
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  return (
    <RecordDialog
      title={`Edit rate · ${row.iso} ${row.currency}`}
      saveLabel="Save rate"
      saving={set.isPending}
      error={error}
      onSave={submit}
      onClose={done}
    >
      <NumberField
        form={form}
        path="ratePerUsd"
        label="Rate"
        required
        wide
        min={0}
        step={0.000001}
        suffix={`${row.iso} per 1 USD`}
        hint={`Now ${rateText(row.ratePerUsd)}${move ? ` · change ${move > 0 ? "+" : ""}${move.toFixed(2)} %` : ""}. Applies from now; amounts already converted keep their rate.`}
      />
    </RecordDialog>
  );
}

// ---------------------------------------------------------------- views

function CurrenciesView() {
  return (
    <ListScreen<CurrencyRow>
      list="currencies"
      page={page}
      title="Currency"
      historyScope={{ entityTypes: ["currency"] }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          onSelect: () => void ask<void>((d) => <CurrencyDialog row={r} done={() => d()} />),
        },
      ]}
      primary={{
        label: "Add currency",
        icon: "plus",
        onClick: () => void ask<void>((d) => <CurrencyDialog row={null} done={() => d()} />),
      }}
      above={<ViewSwitch note="Rates are kept per USD; the platform currency is used for totals." />}
      onExport={(s) =>
        void downloadCsv("/currencies/export", toListQuery(s)).catch((e) =>
          toast({ tone: "error", message: problemText(e) }),
        )
      }
      columns={{
        id: { width: 110 },
        name: { width: 200, render: (r) => <strong>{r.name}</strong> },
        iso: { width: 80 },
        symbol: { width: 80 },
        ratePerUsd: {
          width: 140,
          align: "right",
          render: (r) => <span className="num">{rateText(r.ratePerUsd)}</span>,
        },
        enterprises: { width: 110, align: "right" },
        updatedBy: { width: 140, render: (r) => r.updatedBy ?? <span className="muted">seed data</span> },
      }}
      onOpen={(r) => void ask<void>((d) => <CurrencyDialog row={r} done={() => d()} />)}
      detail={(r) => ({
        title: (
          <>
            <strong>
              {r.iso} · {r.name}
            </strong>
            <span className="muted">
              {r.symbol} · {rateText(r.ratePerUsd)} per USD
            </span>
          </>
        ),
        sections: [
          {
            key: "currency",
            label: "Currency",
            actions: (
              <Button
                small
                icon="file"
                onClick={() => void ask<void>((d) => <CurrencyDialog row={r} done={() => d()} />)}
              >
                Edit
              </Button>
            ),
            content: (
              <dl className="kv">
                <dt>Rate</dt>
                <dd>
                  {rateText(r.ratePerUsd)} per USD since {fmtWhen(r.rateUpdatedAt)}
                </dd>
                <dt>Used by</dt>
                <dd>{r.enterprises} enterprise billing settings</dd>
              </dl>
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["currency"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}

function ExchangeView() {
  const sync = useSyncRates();
  const notifySaved = useNotifySaved();
  const [, setView] = useView();
  const runSync = async () => {
    const ok = await confirmDialog({
      title: "Sync Rates?",
      message: (
        <p>Pulls today&apos;s market rate for every currency. New rates apply from now; past amounts keep theirs.</p>
      ),
      ok: "Sync rates",
    });
    if (!ok) return;
    sync.mutate(undefined, {
      onSuccess: (r) =>
        r.change ? notifySaved(r.change, `${r.updated} rates synced`) : toast({ tone: "info", message: "No change" }),
      onError: (e) => toast({ tone: "error", message: problemText(e) }),
    });
  };
  const edit = (r: CurrencyRateRow) =>
    r.iso === "USD"
      ? toast({ tone: "info", message: "Rates are per USD; USD is always 1." })
      : void ask<void>((d) => <RateDialog row={r} done={() => d()} />);
  return (
    <ListScreen<CurrencyRateRow>
      list="currency_rates"
      page={page}
      title="Currency Exchange"
      historyScope={{ entityTypes: ["currency"] }}
      rowActions={(r) => [
        {
          label: "Edit rate…",
          icon: "file",
          main: true,
          disabled: r.iso === "USD",
          ...(r.iso === "USD" ? { hint: "Rates are per USD; USD is always 1." } : {}),
          onSelect: () => edit(r),
        },
      ]}
      primary={{
        label: sync.isPending ? "Syncing…" : "Sync Rates",
        icon: "refresh",
        disabled: sync.isPending,
        onClick: () => void runSync(),
      }}
      actions={
        <Button icon="history" onClick={() => setView("history")}>
          Exchange history
        </Button>
      }
      above={<ViewSwitch note="The rate in force per currency, in units per 1 USD." />}
      columns={{
        id: { width: 90 },
        iso: { width: 80, render: (r) => <strong>{r.iso}</strong> },
        currency: { width: 200 },
        ratePerUsd: {
          width: 180,
          align: "right",
          render: (r) => {
            const move = r.previousRate ? ((r.ratePerUsd - r.previousRate) / r.previousRate) * 100 : null;
            return (
              <span className="num">
                {rateText(r.ratePerUsd)}
                {move !== null && Math.abs(move) >= 0.005 && (
                  <span className="muted small">
                    {" "}
                    ({move > 0 ? "+" : ""}
                    {move.toFixed(2)} %)
                  </span>
                )}
              </span>
            );
          },
        },
        validFrom: {
          width: 170,
          render: (r) => (r.validFrom ? fmtWhen(r.validFrom) : <span className="muted">base</span>),
        },
        updatedBy: { width: 150, render: (r) => r.updatedBy ?? <span className="muted">market feed</span> },
      }}
      onOpen={(r) => edit(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.iso}</strong>
            <span className="muted">
              {r.currency} · {rateText(r.ratePerUsd)} per USD
            </span>
          </>
        ),
        sections: [
          {
            key: "rate",
            label: "Rate",
            actions:
              r.iso === "USD" ? undefined : (
                <Button small icon="file" onClick={() => edit(r)}>
                  Edit
                </Button>
              ),
            content: (
              <dl className="kv">
                <dt>In force</dt>
                <dd>
                  {rateText(r.ratePerUsd)} since {fmtWhen(r.validFrom)} · {r.updatedBy ?? "market feed"}
                </dd>
                <dt>Before</dt>
                <dd>{r.previousRate === null ? "—" : rateText(r.previousRate)}</dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits the rate · Ctrl+Z undo"
    />
  );
}

function HistoryView() {
  return (
    <ListScreen<CurrencyRateHistoryRow>
      list="currency_rate_history"
      page={page}
      title="Currency Exchange History"
      noSelection
      historyScope={null}
      above={<ViewSwitch note="Every rate ever set. Filter ISO for one currency." />}
      columns={{
        iso: { width: 80, render: (r) => <strong>{r.iso}</strong> },
        currency: { width: 200 },
        ratePerUsd: {
          width: 150,
          align: "right",
          render: (r) => <span className="num">{rateText(r.ratePerUsd)}</span>,
        },
        validFrom: { width: 170, render: (r) => fmtWhen(r.validFrom) },
        updatedBy: { width: 150, render: (r) => r.updatedBy ?? <span className="muted">market feed</span> },
      }}
      shortcuts="↑↓ move · an ISO filter shows one currency's history"
    />
  );
}

export function CurrenciesPage() {
  const [view] = useView();
  if (view === "exchange") return <ExchangeView />;
  if (view === "history") return <HistoryView />;
  return <CurrenciesView />;
}
