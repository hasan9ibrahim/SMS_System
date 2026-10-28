// Building blocks shared by record pages (§5): section tabs kept in the tab's URL, the
// archived banner with Restore, the safe-delete dialog (§13.29), the "Name – Alias (ID)"
// record picker in the page header (§5.1) and a grid of a record's child rows.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Dependencies, Enterprise, FilterCondition, ListId } from "@sms/contract";
import { ApiError } from "../api/client";
import { fetchPickPage, useListFields, useMe } from "../api/hooks";
import { fetchDependencies, useArchive, useRestore, type RecordKind, type Saved } from "../api/records";
import { DataGrid, type ColumnOverride } from "../grid/DataGrid";
import { emptyState, type GridState } from "../grid/filterModel";
import { useNotifySaved } from "../history/undo";
import { ShowDeleted } from "../page/ListScreen";
import { useTabNavigate } from "../shell/tabContext";
import { ask, toast } from "../ui/feedback";
import { Icon } from "../ui/Icon";
import { Button, Modal, Popover } from "../ui/primitives";

export const isAdminUser = (permissions: string[] | undefined) => !!permissions?.includes("*");

// ---------------------------------------------------------------- header action slot

export interface SectionProps {
  /** Header slot for the section's filled button, set only while the section is shown. */
  slot: HTMLElement | null;
  onDirty: (dirty: boolean) => void;
}

/** Renders the section's main action into the page header (§15.3: one filled button). */
export function HeaderAction({ slot, children }: { slot: HTMLElement | null; children: ReactNode }) {
  return slot ? createPortal(children, slot) : null;
}

// ---------------------------------------------------------------- section tabs

/** The record's section (General, Billing, …) lives in the tab URL as ?tab=, so it survives restore. */
export function useSectionTab(keys: readonly string[]): [string, (key: string) => void] {
  const location = useLocation();
  const navigate = useTabNavigate();
  const params = new URLSearchParams(location.search);
  const current = params.get("tab");
  const key = current && keys.includes(current) ? current : keys[0]!;
  const set = (next: string) => {
    const p = new URLSearchParams(location.search);
    if (next === keys[0]) p.delete("tab");
    else p.set("tab", next);
    const qs = p.toString();
    navigate(`${location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
  };
  return [key, set];
}

export function SectionTabs({
  tabs,
  current,
  onChange,
}: {
  tabs: { key: string; label: string; count?: number | null; disabled?: boolean }[];
  current: string;
  onChange: (key: string) => void;
}) {
  return (
    <nav className="record-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.key === current}
          className={t.key === current ? "on" : ""}
          disabled={t.disabled}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.count != null && <span className="count num">{t.count.toLocaleString("en-US")}</span>}
        </button>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------- archived banner

export function ArchivedBanner({
  kind,
  id,
  archived,
  what,
}: {
  kind: RecordKind;
  id: number;
  archived: { at: string; by: string | null } | null;
  what: string;
}) {
  const { data: me } = useMe();
  const restore = useRestore(kind);
  const notifySaved = useNotifySaved();
  if (!archived) return null;
  return (
    <div className="archived-banner" role="status">
      <Icon name="trash" size={15} />
      <span>
        This {what} is <strong>deleted</strong> (archived {archived.at.slice(0, 16).replace("T", " ")} UTC
        {archived.by ? ` by ${archived.by}` : ""}). It stays in reports and billing; editing is off until it is
        restored.
      </span>
      <span className="fb-spacer" />
      {isAdminUser(me?.permissions) ? (
        <Button
          small
          icon="undo"
          disabled={restore.isPending}
          onClick={() =>
            restore.mutate(id, {
              onSuccess: (r) => r.change && notifySaved(r.change, "Restored"),
              onError: (e) => toast({ tone: "error", message: (e as Error).message }),
            })
          }
        >
          Restore
        </Button>
      ) : (
        <span className="muted small">An administrator can restore it.</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- safe delete (§13.29)

/**
 * Unassign before delete (team trial round 6): a rule still assigned to trunks or enterprises lists them in the delete
 * dialog, with a button that takes it off all of them (one undoable save); then it can be deleted.
 */
export interface Unassign {
  /** The trunks and enterprises the record is assigned to, as names. */
  load: () => Promise<string[]>;
  /** Takes it off all of them. */
  run: () => Promise<unknown>;
}

function DeleteDialog({
  kind,
  id,
  name,
  unassign,
  done,
}: {
  kind: RecordKind;
  id: number;
  name: string;
  unassign?: Unassign;
  done: (r: Saved<unknown> | null) => void;
}) {
  const { data: me } = useMe();
  const deps = useQuery<Dependencies>({
    queryKey: ["deps", kind, id],
    queryFn: () => fetchDependencies(kind, id),
    staleTime: 0,
    retry: false,
  });
  const archive = useArchive(kind);
  const assignedBlock = (deps.data?.items ?? []).some(
    (d) => d.key.startsWith("assigned_") && d.blocking && d.noOverride && d.count,
  );
  const assigned = useQuery({
    queryKey: ["deps", kind, id, "assigned"],
    queryFn: () => unassign!.load(),
    enabled: !!unassign && assignedBlock,
    staleTime: 0,
  });
  const [unassigning, setUnassigning] = useState(false);
  const runUnassign = async () => {
    setUnassigning(true);
    try {
      await unassign!.run();
      await deps.refetch();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setUnassigning(false);
    }
  };
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const admin = isAdminUser(me?.permissions);
  const blocked = deps.data?.blocked ?? false;
  // Blockers nobody can override (team trial round 3): e.g. an enterprise's live trunks.
  const hard = (deps.data?.items ?? []).filter((d) => d.blocking && d.noOverride && d.count);
  const canSubmit = !!deps.data && !hard.length && (!blocked || (override && reason.trim().length > 0));
  const submit = () =>
    archive.mutate(
      { id, body: { ...(reason.trim() ? { reason: reason.trim() } : {}), ...(override ? { override: true } : {}) } },
      {
        onSuccess: (r) => done(r),
        onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
      },
    );
  return (
    <Modal
      title={`Delete ${name}?`}
      width={560}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="danger" icon="trash" disabled={!canSubmit || archive.isPending} onClick={submit}>
            {blocked ? "Override and delete" : "Delete"}
          </Button>
        </>
      }
    >
      <p>
        Delete archives the record: it leaves lists, pickers and routing at once, and stays in reports, invoices and
        history. Nothing is removed from the database.
      </p>
      {deps.isPending && <p className="muted">Checking what depends on it…</p>}
      {deps.isError && <p className="error-text">{(deps.error as Error).message}</p>}
      {deps.data && (
        <>
          <ul className="dep-list">
            {deps.data.items.map((d) => {
              const blocking = d.blocking && d.count !== null && d.count !== 0;
              return (
                <li key={d.key} className={blocking ? "blocking" : ""}>
                  <Icon name={blocking ? "alert" : "check"} size={14} />
                  <span>{d.label}</span>
                  <span className="num strong">
                    {d.count === null
                      ? "—"
                      : d.key.endsWith("balance")
                        ? d.count.toLocaleString("en-US", { minimumFractionDigits: 2 })
                        : d.count.toLocaleString("en-US")}
                  </span>
                  {d.detail && <span className="muted small">{d.detail}</span>}
                </li>
              );
            })}
          </ul>
          {hard.length > 0 && unassign && assignedBlock && (
            <div className="unassign-box">
              <span className="strong">Assigned to</span>
              <span className="unassign-names">
                {assigned.isPending ? "Loading…" : (assigned.data ?? []).join(", ") || "—"}
              </span>
              <Button small icon="x" disabled={unassigning || assigned.isPending} onClick={() => void runUnassign()}>
                Unassign from all
              </Button>
            </div>
          )}
          {hard.length > 0 ? (
            <p className="error-text">
              {name} cannot be deleted while it has {hard.map((d) => d.label.toLowerCase()).join(" or ")}. Delete or
              unassign them first.
            </p>
          ) : (
            blocked && (
              <p className={admin ? "muted" : "error-text"}>
                {admin
                  ? "Settle the red items first, or override with a written reason (logged with the change)."
                  : "Settle the red items first. Only an administrator can override."}
              </p>
            )
          )}
        </>
      )}
      {blocked && admin && !hard.length && (
        <label className="toggle-inline">
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
          Override the blockers
        </label>
      )}
      <label className="field" style={{ marginTop: 10 }}>
        <span>Reason{blocked && override && <span className="req">*</span>}</span>
        <textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

/**
 * Delete several records from a list without opening them (team trial round 1). Each record's
 * dependencies are checked (§13.29); blocked ones are skipped unless an administrator overrides with a
 * reason. Each delete is its own change in History, so each can be undone.
 */
function BulkDeleteDialog({
  kind,
  rows,
  noun,
  done,
}: {
  kind: RecordKind;
  rows: { id: number; name: string }[];
  noun: string;
  done: (deleted: number) => void;
}) {
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const deps = useQueries({
    queries: rows.map((r) => ({
      queryKey: ["deps", kind, r.id],
      queryFn: () => fetchDependencies(kind, r.id),
      staleTime: 0,
      retry: false,
    })),
  });
  const archive = useArchive(kind);
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  const [running, setRunning] = useState<{ done: number; failed: string[] } | null>(null);
  const checking = deps.some((d) => d.isPending);
  const blockedOf = (i: number) => deps[i]?.data?.blocked ?? false;
  const blockers = (i: number) =>
    (deps[i]?.data?.items ?? []).filter((d) => d.blocking && d.count !== null && d.count !== 0).map((d) => d.label);
  const targets = rows.filter((_, i) => deps[i]?.data && (!blockedOf(i) || override));
  const blockedCount = rows.filter((_, i) => blockedOf(i)).length;
  const submit = async () => {
    const failed: string[] = [];
    let n = 0;
    setRunning({ done: 0, failed });
    for (const r of targets) {
      const blocked = blockedOf(rows.indexOf(r));
      try {
        await archive.mutateAsync({
          id: r.id,
          body: { ...(reason.trim() ? { reason: reason.trim() } : {}), ...(blocked ? { override: true } : {}) },
        });
        n++;
      } catch (e) {
        failed.push(`${r.name}: ${e instanceof ApiError ? e.message : String(e)}`);
      }
      setRunning({ done: n, failed: [...failed] });
    }
    if (!failed.length) done(n);
  };
  return (
    <Modal
      title={`Delete ${rows.length} ${noun}${rows.length === 1 ? "" : "s"}?`}
      width={620}
      onClose={() => done(running?.done ?? 0)}
      footer={
        <>
          <Button onClick={() => done(running?.done ?? 0)}>{running ? "Close" : "Cancel"}</Button>
          {!running && (
            <Button
              variant="danger"
              icon="trash"
              disabled={checking || !targets.length || (override && !reason.trim())}
              onClick={() => void submit()}
            >
              Delete {targets.length}
            </Button>
          )}
        </>
      }
    >
      <p>
        Delete archives each record (§13.29): it leaves lists, pickers and routing, and stays in reports, invoices and
        history. Each one is a change you can undo from History.
      </p>
      <ul className="dep-list bulk-del">
        {rows.map((r, i) => {
          const d = deps[i]!;
          const b = blockers(i);
          return (
            <li key={r.id} className={b.length ? "blocking" : ""}>
              <Icon name={d.isPending ? "clock" : b.length ? "alert" : d.isError ? "x" : "check"} size={14} />
              <span className="strong">{r.name}</span>
              <span className="muted small">
                {d.isPending
                  ? "checking…"
                  : d.isError
                    ? "could not check"
                    : b.length
                      ? `blocked: ${b.join(", ")}`
                      : "can be deleted"}
              </span>
            </li>
          );
        })}
      </ul>
      {blockedCount > 0 && (
        <p className={admin ? "muted" : "error-text"}>
          {blockedCount} blocked{" "}
          {admin
            ? "— skipped unless you override with a reason."
            : "— they are skipped; only an administrator can override."}
        </p>
      )}
      {blockedCount > 0 && admin && (
        <label className="toggle-inline">
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
          Override the blockers
        </label>
      )}
      <label className="field" style={{ marginTop: 10 }}>
        <span>Reason{override && <span className="req">*</span>}</span>
        <textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {running && (
        <p className={running.failed.length ? "error-text" : "muted"}>
          Deleted {running.done} of {targets.length}
          {running.failed.length ? ` · failed: ${running.failed.join("; ")}` : ""}
        </p>
      )}
    </Modal>
  );
}

/** Opens the bulk delete dialog; resolves with how many were deleted. */
export function useBulkDelete() {
  return async (kind: RecordKind, rows: { id: number; name: string }[], noun: string) => {
    const n = await ask<number>((resolve) => <BulkDeleteDialog kind={kind} rows={rows} noun={noun} done={resolve} />);
    if (n) toast({ tone: "good", message: `Deleted ${n} ${noun}${n === 1 ? "" : "s"} · undo each from History` });
    return n ?? 0;
  };
}

/** Opens the delete dialog; resolves with the archive result (with its change for Undo), or null. */
export function useDeleteRecord() {
  const notifySaved = useNotifySaved();
  return async (kind: RecordKind, id: number, name: string, unassign?: Unassign) => {
    const result = await ask<Saved<unknown>>((resolve) => (
      <DeleteDialog kind={kind} id={id} name={name} unassign={unassign} done={resolve} />
    ));
    if (result?.change) notifySaved(result.change, `Deleted ${name}`);
    return result;
  };
}

// ---------------------------------------------------------------- enterprise picker (§5.1)

export const enterpriseLabel = (e: Pick<Enterprise, "name" | "alias" | "id">) => `${e.name} – ${e.alias} (${e.id})`;

/** Searchable "Name – Alias (ID)" selector in the page header; picks another record. */
export function EnterprisePicker({ label, onPick }: { label: string; onPick: (e: Enterprise) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLButtonElement>(null);
  const results = useQuery({
    queryKey: ["picker", "enterprises", q],
    queryFn: () =>
      fetchPickPage<Enterprise>("enterprises", {
        ...(q.trim() ? { search: q.trim() } : {}),
        ...(/^\d+$/.test(q.trim())
          ? {
              filter: { logic: "or", conditions: [{ field: "id", op: "eq", value: Number(q.trim()) }] },
              search: undefined,
            }
          : {}),
        limit: 30,
        withTotal: false,
      }),
    enabled: open,
    staleTime: 30_000,
  });
  const rows = results.data?.rows ?? [];
  useEffect(() => setHi(0), [q]);
  const pick = (e: Enterprise) => {
    setOpen(false);
    setQ("");
    onPick(e);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setHi((h) => Math.min(h + 1, rows.length - 1));
    if (e.key === "ArrowUp") setHi((h) => Math.max(h - 1, 0));
    if (e.key === "Enter" && rows[hi]) pick(rows[hi]);
  };
  return (
    <div className="record-picker">
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        title="Switch enterprise"
      >
        <span>{label}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="picker-pop">
        <input
          autoFocus
          placeholder="Name, alias or ID…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          aria-label="Find an enterprise"
        />
        <div className="picker-list" role="listbox">
          {rows.map((e, i) => (
            <button
              key={e.id}
              type="button"
              role="option"
              aria-selected={i === hi}
              className={i === hi ? "on" : ""}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(e)}
            >
              <span>{enterpriseLabel(e)}</span>
              <span className="muted small">{e.type}</span>
            </button>
          ))}
          {results.isSuccess && rows.length === 0 && <p className="muted small pad">No enterprise matches.</p>}
        </div>
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------- child grid

/**
 * A server-side grid of child rows (e.g. an enterprise's trunks) with a fixed filter.
 * Column filters, sort and "Show deleted" work as on any list (§13.25).
 */
export function ChildGrid<Row extends { id: number }>({
  list,
  fixed,
  hide = [],
  columns,
  onOpen,
  toolbar,
}: {
  list: ListId;
  fixed: GridState["columns"];
  hide?: string[];
  columns?: Partial<Record<string, ColumnOverride<Row>>>;
  onOpen: (row: Row, e: MouseEvent | KeyboardEvent) => void;
  /** Header actions; a function gets the ticked rows (team trial round 8: Delete on the trunk tabs). */
  toolbar?: ReactNode | ((selected: Row[], clear: () => void) => ReactNode);
}) {
  const fields = useListFields(list);
  const [state, setState] = useState<GridState>(() => ({ ...emptyState(), columns: { ...fixed } }));
  const [active, setActive] = useState<Row | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [rows, setRows] = useState<Row[]>([]);
  const visible = fields.data?.fields.filter((f) => !f.hidden && !hide.includes(f.field)).map((f) => f.field) ?? null;
  if (!fields.data)
    return <div className="grid-message muted">{fields.isError ? "Fields unavailable" : "Loading…"}</div>;
  return (
    <>
      <div className="filter-row">
        {typeof toolbar === "function"
          ? toolbar(
              rows.filter((r) => selected.has(r.id)),
              () => setSelected(new Set()),
            )
          : toolbar}
        <span className="fb-spacer" />
        {/* Only lists with deleted (archived) records offer it (§13.29). */}
        {fields.data.fields.some((f) => f.field === "archived") && <ShowDeleted state={state} onChange={setState} />}
      </div>
      <DataGrid<Row>
        list={list}
        fields={fields.data}
        state={{ ...state, visible: state.visible ?? visible, columns: { ...state.columns, ...fixed } }}
        onStateChange={(s) => setState({ ...s, columns: { ...s.columns, ...fixed } })}
        {...(columns ? { columns } : {})}
        activeId={active?.id ?? null}
        onActiveChange={setActive}
        selected={selected}
        onSelectedChange={setSelected}
        onRows={setRows}
        onOpen={onOpen}
      />
    </>
  );
}

// ---------------------------------------------------------------- record lookup

/**
 * Picks one record from a server-side list by quick search (e.g. a vendor trunk or a
 * rate table). Shows the current choice by its label; `fixed` narrows the list.
 */
export function ListLookup<Row extends { id: number }>({
  list,
  value,
  onChange,
  labelOf,
  detailOf,
  fixed,
  placeholder = "Search…",
  disabled,
  exclude = [],
  clearable = true,
  limit = 30,
}: {
  list: ListId;
  value: number | null;
  onChange: (row: Row | null) => void;
  labelOf: (row: Row) => string;
  detailOf?: (row: Row) => string;
  fixed?: FilterCondition[];
  placeholder?: string;
  disabled?: boolean;
  exclude?: number[];
  clearable?: boolean;
  /** Rows offered before typing (team trial round 5: the simulator lists every vendor trunk). */
  limit?: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLButtonElement>(null);
  const current = useQuery({
    queryKey: ["lookup", list, "id", value],
    queryFn: () =>
      fetchPickPage<Row>(list, {
        filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: value! }] },
        limit: 1,
        withTotal: false,
      }),
    enabled: value != null,
    staleTime: 60_000,
  });
  const results = useQuery({
    queryKey: ["lookup", list, q, fixed, limit],
    queryFn: () =>
      fetchPickPage<Row>(list, {
        ...(q.trim() ? { search: q.trim() } : {}),
        ...(fixed?.length ? { filter: { logic: "and", conditions: fixed } } : {}),
        limit,
        withTotal: false,
      }),
    enabled: open,
    staleTime: 30_000,
  });
  const chosen = current.data?.rows[0];
  return (
    <span className="lookup">
      <button
        ref={ref}
        type="button"
        className="lookup-btn"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
      >
        <span className={chosen || value == null ? "" : "muted"}>
          {value == null ? <span className="muted">{placeholder}</span> : chosen ? labelOf(chosen) : `#${value}`}
        </span>
        <Icon name="chevronDown" size={13} />
      </button>
      {clearable && value != null && !disabled && (
        <button type="button" className="icon-btn" aria-label="Clear" onClick={() => onChange(null)}>
          <Icon name="x" size={13} />
        </button>
      )}
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="picker-pop">
        <input
          autoFocus
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={placeholder}
        />
        <div className="picker-list" role="listbox">
          {(results.data?.rows ?? [])
            .filter((r) => !exclude.includes(r.id))
            .map((r) => (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={r.id === value}
                className={r.id === value ? "on" : ""}
                onClick={() => {
                  setOpen(false);
                  setQ("");
                  onChange(r);
                }}
              >
                <span>{labelOf(r)}</span>
                {detailOf && <span className="muted small">{detailOf(r)}</span>}
              </button>
            ))}
          {results.isSuccess && results.data.rows.length === 0 && <p className="muted small pad">Nothing matches.</p>}
        </div>
      </Popover>
    </span>
  );
}
