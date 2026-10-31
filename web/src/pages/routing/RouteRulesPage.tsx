// Route Rules (§6.3, §13.8–13.11, §13.24, §13.27). The one page that copies the reference
// screenshot's layout and form exactly (§15.4): header links and actions, grid columns with
// a filter under each, the detail panel (Edit / Configuration / Conditions / Traffic / History / Test)
// with condition chips and the 24h trend on the right, and the status bar shortcuts.
import { HoverList } from "../../ui/HoverList";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { MatchMode, RouteRuleDetail, RouteRuleInput, RouteRuleRow, TrafficWindow } from "@sms/contract";
import { api, unwrap } from "../../api/client";
import { useMe } from "../../api/hooks";
import { useRestore } from "../../api/records";
import {
  discardRouteRuleOnLeave,
  useBulkRouteRules,
  useDiscardRouteRule,
  exportRouteRules,
  useRouteRule,
  useSaveRouteRule,
} from "../../api/routing";
import { toListQuery } from "../../grid/filterModel";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen, useGridUrlState, type DetailContent } from "../../page/ListScreen";
import { isAdminUser, useDeleteRecord } from "../../records/parts";
import { ask, confirmDialog, toast } from "../../ui/feedback";
import { Button, Modal, Popover, StatusDot } from "../../ui/primitives";
import { qualityClass, qualityTone } from "../../ui/quality";
import { formatPct } from "../rates/format";
import { AddCondition, ConditionsSection, DraftRuleContext, RuleTitle, useRuleSaver as useSaver } from "./Conditions";
import { BulkDialog, DEFAULT_PRIORITY, RuleGeneralForm, VendorSplitEditor, problemText } from "./dialogs";
import { InlineCondition, NewDraftContext, PendingCategoryContext } from "./ConditionEditor";
import { codesText, useDestinationTree } from "../rates/DestinationTree";
import { compact, conditionChips, CONFIG_KEYS, routeTypeOf, toInput, type ConditionKey } from "./ruleModel";
import { SimulateDialog, TestSection } from "./TestPanel";
import { TrafficAside, TrafficHover, TrafficSection, money, usePlatformCurrency } from "./Traffic";
import { VendorsSection, VendorsView } from "./VendorsSection";
import { CleanupBadge } from "../admin/cleanup/CleanupBadge";

const page = pageForPath("/routing/rules")!;

/**
 * DLR is coloured by value like every ASR/DLR (§13.4); below the rule's target (§15.4) a value
 * that would be green shows amber instead, and the value is bold.
 */
function dlrClass(r: RouteRuleRow) {
  // A block rule fails its traffic on purpose: no colour (calm look, team trial round 5).
  if (r.routeType === "block") return "muted";
  const below = r.dlr !== null && r.dlrTarget !== null && r.dlr < r.dlrTarget;
  const tone = below && qualityTone(r.dlr) === "good" ? "tone-warning" : qualityClass(r.dlr);
  return below ? `${tone} strong` : tone;
}

/**
 * The DLR target behind the hint (§15.4; decided 2026-10-16): the rule's own target, else
 * its destinations' (set on the MCCMNC codes page). No target = colour by value only.
 */
const dlrTitle = (r: RouteRuleRow) =>
  r.dlrTarget === null
    ? "No DLR target (set one on the rule or on its destinations)"
    : `Target ${r.dlrTarget}% (${r.dlrTargetSource === "rule" ? "this rule" : "its destinations"})`;

const SHORTCUTS = "↑↓ move · Space select · E edit · D duplicate · Ctrl+Z undo";

/** The vendor editor in a wide popup showing everything without scrolling (team trial round 1). */
function VendorsDialog({ id, done }: { id: number; done: () => void }) {
  const rule = useRouteRule(id);
  const { save, saving } = useSaver(rule.data);
  return (
    <Modal title={`Vendors · ${rule.data?.name ?? `rule #${id}`}`} width={1180} onClose={done}>
      {!rule.data ? (
        <p className="muted">Loading…</p>
      ) : (
        <VendorsSection
          key={rule.data.updatedAt}
          rule={rule.data}
          saving={saving}
          onSave={async (patch) => {
            const error = await save(patch);
            if (!error) done();
            return error;
          }}
          onCancel={done}
        />
      )}
    </Modal>
  );
}

/** A rule has what it needs to run: customer trunks, and vendors unless it blocks (team trial round 2). */
export function readyToRun(r: RouteRuleDetail): boolean {
  const customers = r.customerTrunkMode === "inclusive" && r.customerTrunkIds.length > 0;
  const vendors = r.routeType === "block" || r.vendors.length > 0 || (r.vendorTrunkIds ?? []).length > 0;
  return customers && vendors;
}

type Collect = () => Partial<RouteRuleInput> | string;

/**
 * Configuration (team trial round 2): Category, Customer trunks and Destination, each a block like the vendors,
 * then the vendors. In the detail panel a block opens its editor in place; in New rule (`expanded`) every block is
 * open, the vendors are edited in place too, and the blocks have no Save of their own: the window's one Save gathers
 * them through `bind` (team trial round 6). Each save is one change (§13.10).
 */
function ConfigurationSection({
  id,
  expanded = false,
  bind,
}: {
  id: number;
  expanded?: boolean;
  bind?: (key: string, collect: Collect) => void;
}) {
  const rule = useRouteRule(id);
  const { save, saving } = useSaver(rule.data);
  const [open, setOpen] = useState<ConditionKey | null>(null);
  const { tree } = useDestinationTree();
  const r = rule.data;
  // In the rule window the trunk list follows the categories picked there before Save (team trial round 8).
  const [pendingCat, setPendingCat] = useState<{ mode: MatchMode; ids: number[] } | null>(null);
  const catCtx = useMemo(
    () =>
      expanded && r
        ? {
            mode: pendingCat?.mode ?? r.categoryMode,
            ids: pendingCat?.ids ?? r.categoryIds,
            set: (mode: MatchMode, ids: number[]) =>
              setPendingCat((p) => (p && p.mode === mode && p.ids.join() === ids.join() ? p : { mode, ids })),
          }
        : null,
    [expanded, r, pendingCat],
  );
  if (rule.isError) return <p className="error-text">{(rule.error as Error).message}</p>;
  if (!r) return <p className="muted">Loading…</p>;
  const locked = !!r.archived;
  const chips = conditionChips(r, Date.now(), (codes) => codesText(tree, codes, 4));
  const summary = (k: ConditionKey) => {
    const c = chips.find((x) => x.key === k);
    return c ? `${c.op} ${c.value}` : "All";
  };
  const LABEL: Record<string, string> = { category: "Category", trunk: "Customer trunks", destination: "Destination" };
  return (
    <PendingCategoryContext.Provider value={catCtx}>
    <div className={`cfg${expanded ? " cfg-expanded" : ""}`}>
      {CONFIG_KEYS.map((k) => (
        <section key={k} className={`cfg-block cfg-${k}`}>
          <div className="cfg-head">
            <strong>{LABEL[k]}</strong>
            <span className="muted cfg-summary" title={summary(k)}>
              {summary(k)}
            </span>
            <span className="fb-spacer" />
            {!expanded && !locked && (
              <button type="button" className="link" onClick={() => setOpen(open === k ? null : k)}>
                {open === k ? "Close" : "Edit"}
              </button>
            )}
          </div>
          {(expanded || open === k) && !locked && (
            <InlineCondition
              // In New rule the edits wait for the window's Save, so a saved "other condition" must not reset them.
              key={expanded ? k : `${k}${r.updatedAt}`}
              conditionKey={k}
              rule={r}
              saving={saving}
              {...(expanded
                ? { bind: (c: Collect) => bind?.(k, c) }
                : {
                    onSave: async (patch: Partial<RouteRuleInput>) => {
                      const err = await save(patch, `${LABEL[k]} saved`);
                      if (!err) setOpen(null);
                      return err;
                    },
                    onCancel: () => setOpen(null),
                  })}
            />
          )}
        </section>
      ))}
      <section className="cfg-block cfg-vendors">
        <div className="cfg-head">
          <strong>Vendors</strong>
        </div>
        {expanded ? (
          <VendorsSection rule={r} saving={saving} bind={(c) => bind?.("vendors", c)} />
        ) : (
          <VendorsSectionFor id={id} />
        )}
      </section>
    </div>
    </PendingCategoryContext.Provider>
  );
}

/**
 * New rule (team trial round 3): one window with every section at once. Opening it adds a draft rule, turned off; ×
 * discards the draft as if it never existed, and only Save keeps it (with the general fields and Rule on). A click
 * outside or Escape does nothing. "Rule on" ticks itself once the rule has customer trunks and vendors, unless
 * switched by hand.
 */
const copyName = (name: string) => `${name} (copy)`.slice(0, 120);

function NewRuleDialog({ done, from }: { done: (id: number | null) => void; from?: RouteRuleDetail }) {
  const [id, setId] = useState<number | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const create = useSaveRouteRule();
  const discard = useDiscardRouteRule();
  const started = useRef(false);
  const idRef = useRef<number | null>(null);
  // Saved (kept) or discarded: nothing more to do with the draft.
  const settled = useRef(false);
  // Closed before the draft existed (QA round 13): the draft goes as soon as it arrives.
  const abandoned = useRef(false);
  const leftPage = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    create
      .mutateAsync({
        id: null,
        // Clone (team trial round 6): the draft starts as a full copy of the rule, named "… (copy)".
        input: from
          ? toInput(from, { name: copyName(from.name), status: "inactive" })
          : { name: "New rule", priority: DEFAULT_PRIORITY, status: "inactive", routeType: "static" },
      })
      .then((r) => {
        idRef.current = r.record.id;
        if (abandoned.current || !mounted.current) {
          settled.current = true;
          if (leftPage.current) discardRouteRuleOnLeave(r.record.id);
          else void discard.mutateAsync(r.record.id).catch(() => undefined);
          return;
        }
        setId(r.record.id);
      })
      .catch((e) => setCreateError(problemText(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The window can go without × or Save, now that it lives in its tab (team trial round 12): its tab closed. The
  // draft goes with it, as × would. React's development double run unmounts and mounts again at once, so only a
  // window still gone a moment later counts.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (mounted.current || settled.current) return;
        settled.current = true;
        abandoned.current = true;
        if (idRef.current !== null) void discard.mutateAsync(idRef.current).catch(() => undefined);
      });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A reload, leaving the app or closing the window skips that cleanup (QA round 13): the draft goes with a request
  // that outlives the page. Should the browser bring the page back from its cache, the window is gone as well.
  useEffect(() => {
    const leave = () => {
      if (settled.current) return;
      settled.current = true;
      abandoned.current = true;
      leftPage.current = true;
      if (idRef.current !== null) discardRouteRuleOnLeave(idRef.current);
    };
    const back = (e: PageTransitionEvent) => {
      if (e.persisted && leftPage.current) done(null);
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", back);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rule = useRouteRule(id);
  const [manual, setManual] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitGeneral = useRef<((patch?: Partial<RouteRuleInput>) => Promise<string | null>) | null>(null);
  const blocks = useRef(new Map<string, Collect>());
  const r = id !== null ? rule.data : undefined;
  // Unless switched by hand, Save turns the rule on when it has what it needs to run.
  const on = manual ?? true;
  const [busy, setBusy] = useState(false);
  const close = async () => {
    setBusy(true);
    settled.current = true;
    abandoned.current = true;
    const draft = idRef.current;
    if (draft !== null) await discard.mutateAsync(draft).catch((e) => toast({ tone: "error", message: problemText(e) }));
    done(null);
  };
  const saveRule = async () => {
    if (!submitGeneral.current) return;
    // One Save for the whole window (team trial round 6): every block's edits and Rule on, as one change.
    const patches = [...blocks.current.values()].map((c) => c());
    const bad = patches.find((p): p is string => typeof p === "string");
    if (bad) return setError(bad);
    setError(null);
    const merged: Partial<RouteRuleInput> = Object.assign({}, ...patches);
    const run = manual ?? (r ? readyToRun({ ...r, ...merged } as RouteRuleDetail) : false);
    setBusy(true);
    const err = await submitGeneral.current({ ...merged, status: run ? "active" : "inactive" });
    setBusy(false);
    if (err) return setError(err);
    settled.current = true;
    done(id);
  };
  return (
    <Modal
      title={from ? `Clone of ${from.name}` : "New route rule"}
      width={1180}
      onClose={() => void close()}
      onlyCloseButton
      footer={
        <>
          <label className="toggle-inline" title="Saved on when it has customer trunks and vendors (unless switched off); × discards the rule">
            <input type="checkbox" checked={on} disabled={!r} onChange={(e) => setManual(e.target.checked)} />
            Rule on
          </label>
          <span className="fb-spacer" />
          <Button variant="primary" icon="save" onClick={() => void saveRule()} disabled={!r || busy}>
            Save
          </Button>
        </>
      }
    >
      <DraftRuleContext.Provider value={true}>
        <NewDraftContext.Provider value={!from}>
        <div className="new-rule">
          {createError && <p className="error-text">{createError}</p>}
          {!r && !createError && <p className="muted">Preparing the rule…</p>}
          {r && (
            <>
              <section className="cfg-block">
                <div className="cfg-head">
                  <strong>General</strong>
                </div>
                <RuleGeneralForm
                  rule={r}
                  draft
                  {...(from ? { draftName: copyName(from.name) } : {})}
                  hideStatus
                  onSaved={() => undefined}
                  bindSubmit={(fn) => (submitGeneral.current = fn)}
                />
              </section>
              <ConfigurationSection id={r.id} expanded bind={(k, c) => blocks.current.set(k, c)} />
              <section className="cfg-block">
                <div className="cfg-head">
                  <strong>Other conditions</strong>
                  <span className="fb-spacer" />
                  <AddCondition id={r.id} />
                </div>
                <ConditionsSection id={r.id} />
              </section>
            </>
          )}
          {error && <p className="error-text">{error}</p>}
        </div>
        </NewDraftContext.Provider>
      </DraftRuleContext.Provider>
    </Modal>
  );
}

/**
 * Edit (team trial round 8): the rule in the same window as New rule, with every section; Save applies the general
 * fields and the configuration blocks as one change (conditions save as they are added, as in the panel). × or
 * Cancel closes without saving the open edits.
 */
function EditRuleDialog({ id, done }: { id: number; done: () => void }) {
  const rule = useRouteRule(id);
  const submitGeneral = useRef<((patch?: Partial<RouteRuleInput>) => Promise<string | null>) | null>(null);
  const blocks = useRef(new Map<string, Collect>());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const r = rule.data;
  const saveRule = async () => {
    if (!submitGeneral.current) return;
    const patches = [...blocks.current.values()].map((c) => c());
    const bad = patches.find((p): p is string => typeof p === "string");
    if (bad) return setError(bad);
    setError(null);
    setBusy(true);
    const err = await submitGeneral.current(Object.assign({}, ...patches) as Partial<RouteRuleInput>);
    setBusy(false);
    if (err) return setError(err);
    done();
  };
  return (
    <Modal
      title={r ? `Rule #${id} · ${r.name}` : `Rule #${id}`}
      width={1180}
      onClose={done}
      onlyCloseButton
      footer={
        <>
          <span className="fb-spacer" />
          <Button onClick={done}>Cancel</Button>
          <Button variant="primary" icon="save" onClick={() => void saveRule()} disabled={!r || busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="new-rule">
        {!r && <p className="muted">Loading…</p>}
        {r && (
          <>
            <section className="cfg-block">
              <div className="cfg-head">
                <strong>General</strong>
              </div>
              <RuleGeneralForm
                key={r.id}
                rule={r}
                windowed
                onSaved={() => undefined}
                bindSubmit={(fn) => (submitGeneral.current = fn)}
              />
            </section>
            <ConfigurationSection id={r.id} expanded bind={(k, c) => blocks.current.set(k, c)} />
            <section className="cfg-block">
              <div className="cfg-head">
                <strong>Other conditions</strong>
                <span className="fb-spacer" />
                <AddCondition id={r.id} />
              </div>
              <ConditionsSection id={r.id} />
            </section>
          </>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </Modal>
  );
}

/** The rule's general fields in the panel, saved in place (team trial round 2). */
function EditSection({ id }: { id: number }) {
  const rule = useRouteRule(id);
  if (!rule.data) return <p className="muted">Loading…</p>;
  if (rule.data.archived) return <p className="muted">Restore the rule to edit it.</p>;
  return <RuleGeneralForm key={rule.data.updatedAt} rule={rule.data} onSaved={() => undefined} />;
}

/** Vendors are viewed in the panel and edited in the popup (team trial round 1). */
function VendorsSectionFor({ id }: { id: number }) {
  const rule = useRouteRule(id);
  if (!rule.data) return <p className="muted">Loading…</p>;
  return (
    <VendorsView
      rule={rule.data}
      onEdit={rule.data.archived ? null : () => void ask<void>((d) => <VendorsDialog id={id} done={() => d()} />)}
    />
  );
}

function TestSectionFor({ id }: { id: number }) {
  const rule = useRouteRule(id);
  return <TestSection ruleId={id} trunkId={rule.data?.customerTrunkIds[0] ?? null} />;
}

function VendorsCell({ row, onMore }: { row: RouteRuleRow; onMore: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <HoverList items={row.vendorNames} disabled={open}>
        <button
          ref={anchor}
          type="button"
          className={`cell-edit rr-strong${open ? " editing" : ""}`}
          title={row.vendorNames.length > 1 ? undefined : "Edit the vendor split"}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          <VendorLevels label={row.vendorsLabel} />
        </button>
      </HoverList>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} className="split-pop">
        <VendorSplitEditor
          row={row}
          onClose={() => setOpen(false)}
          onMore={() => {
            setOpen(false);
            onMore();
          }}
        />
      </Popover>
    </>
  );
}

/**
 * The vendors label, one line per level ("L1 … | L2 …" from the server; team trial round 12: level 1 only before).
 * Two levels show; more add a muted "+N", and pointing at the cell lists every vendor.
 */
function VendorLevels({ label }: { label: string }) {
  const levels = label.split(" | ");
  if (levels.length === 1) return <>{label}</>;
  return (
    <span className="rr-levels">
      {levels.slice(0, 2).map((l, i) => {
        const m = /^(L\d+) (.*)$/.exec(l);
        return (
          <span key={i} className="rr-level">
            {m ? (
              <>
                <span className="muted">{m[1]}</span> {m[2]}
              </>
            ) : (
              l
            )}
            {i === 1 && levels.length > 2 && <span className="muted"> +{levels.length - 2}</span>}
          </span>
        );
      })}
    </span>
  );
}

/** First trunks with a muted "+N"; pointing at the cell lists them all (team trial round 1). */
function TrunksCell({ row }: { row: RouteRuleRow }) {
  const m = /^(.*?)( \+\d+)$/.exec(row.customerTrunksLabel);
  const exclusive = row.customerTrunksLabel.startsWith("All but");
  return (
    <HoverList
      items={row.customerTrunkNames}
      more={row.customerTrunkCount - row.customerTrunkNames.length}
      heading={exclusive ? "All trunks except:" : undefined}
    >
      <span className="rr-strong rr-label">
        <span className="rr-main">{m ? m[1] : row.customerTrunksLabel}</span>
        {m && <span className="muted">{m[2]}</span>}
      </span>
    </HoverList>
  );
}

function DestinationCell({ row }: { row: RouteRuleRow }) {
  const m = /^(.*?)( \+\d+…?)$/.exec(row.destinationLabel);
  return (
    <HoverList
      items={row.destinationNames}
      more={row.destinationCount > row.destinationNames.length ? row.destinationCount - row.destinationNames.length : 0}
      heading={row.destinationLabel.startsWith("All but") ? "All destinations except:" : undefined}
    >
      <span className="rr-strong num rr-label">
        <span className="rr-main">{m ? m[1] : row.destinationLabel}</span>
        {m && <span className="muted">{m[2]}</span>}
      </span>
    </HoverList>
  );
}

export function RouteRulesPage() {
  const qc = useQueryClient();
  const [state, setState] = useGridUrlState();
  const bulk = useBulkRouteRules();
  const notifySaved = useNotifySaved();
  const deleteRecord = useDeleteRecord();
  const { data: me } = useMe();
  const restore = useRestore("route_rule");
  const isAdmin = isAdminUser(me?.permissions);
  const ccy = usePlatformCurrency();
  const [selectId, setSelectId] = useState<number | null>(null);
  const sectionState = useState<string | null>(null);
  const openRule = useRef<((row: RouteRuleRow) => void) | null>(null);
  const [, setSection] = sectionState;
  // The traffic window, picked in its header box or as a quick-search pill (both filter, team trial round 10).
  const win =
    ((state.columns.window ?? state.pills?.window ?? state.switches?.window)?.value as TrafficWindow | undefined) ??
    "24h";

  const loadRule = useCallback(
    (id: number) =>
      qc.fetchQuery<RouteRuleDetail>({
        queryKey: ["record", "route_rule", id],
        queryFn: () => unwrap(api.GET("/route-rules/{id}", { params: { path: { id } } })),
      }),
    [qc],
  );

  /** Shows a rule: filters the grid to it when it may not be loaded (new or far away). */
  const showRule = useCallback(
    (id: number) => {
      setState({ ...state, columns: { id: { field: "id", op: "eq", value: id } }, builder: null, search: "" });
      setSelectId(id);
    },
    [state, setState],
  );

  const runBulk = (ids: number[], action: "enable" | "disable", label: string) =>
    bulk.mutate(
      { ruleIds: ids, action },
      {
        onSuccess: (r) =>
          r.change && notifySaved(r.change, `${label}: ${r.affected} rule${r.affected === 1 ? "" : "s"}`),
        onError: (e) => toast({ tone: "error", message: problemText(e) }),
      },
    );

  // Clone (team trial round 6): the New rule window filled from the rule, nothing saved until Save; × discards it.
  const duplicate = async (row: RouteRuleRow) => {
    try {
      const from = await loadRule(row.id);
      const id = await ask<number | null>((done) => <NewRuleDialog done={done} from={from} />);
      if (id) showRule(id);
    } catch (e) {
      toast({ tone: "error", message: problemText(e) });
    }
  };

  const newRule = async () => {
    // One window with every section (team trial round 3); Save opens the rule in the panel.
    const id = await ask<number | null>((done) => <NewRuleDialog done={done} />);
    if (id) {
      showRule(id);
      setSection("edit");
    }
  };

  const detail = (row: RouteRuleRow): DetailContent => ({
    title: <RuleTitle id={row.id} fallback={row.name} />,
    // Edit first, then Configuration (category, customer trunks, destination, vendors) and the other conditions
    // (team trial round 2).
    sections: [
      { key: "edit", label: "Edit", content: <EditSection id={row.id} /> },
      { key: "configuration", label: "Configuration", content: <ConfigurationSection id={row.id} /> },
      {
        key: "conditions",
        label: "Conditions",
        content: <ConditionsSection id={row.id} />,
        actions: <AddCondition id={row.id} />,
      },
      { key: "traffic", label: "Traffic", content: <TrafficSection ruleId={row.id} /> },
      {
        key: "history",
        label: "History",
        content: <HistoryList scope={{ entityTypes: ["route_rule"], entityId: row.id }} />,
      },
      { key: "test", label: "Test", content: <TestSectionFor id={row.id} /> },
    ],
    aside: <TrafficAside ruleId={row.id} />,
  });

  const columns = useMemo(
    () => ({
      // ID and priority in bold (team trial round 8).
      id: { width: 70, render: (r: RouteRuleRow) => <strong className="num rr-bold">{r.id}</strong> },
      name: { width: 200, render: (r: RouteRuleRow) => <span className="strong">{r.name}</span> },
      // Headed "Pri" as in §15.4.
      priority: {
        width: 80,
        label: "Pri",
        render: (r: RouteRuleRow) => <strong className="num rr-bold">{r.priority}</strong>,
      },
      // Wide enough for "YYYY-MM-DD HH:MM" in tabular figures; On beside it keeps its filter inside (round 12).
      updatedAt: {
        width: 180,
        render: (r: RouteRuleRow) => <span className="num">{r.updatedAt.slice(0, 16).replace("T", " ")}</span>,
      },
      updatedBy: { width: 120, render: (r: RouteRuleRow) => r.updatedBy ?? <span className="muted">—</span> },
      routeType: {
        width: 110,
        render: (r: RouteRuleRow) => {
          const t = routeTypeOf(r.routeType);
          return (
            <span className="with-dot">
              <StatusDot tone={t.tone} /> <span className="with-dot-label">{t.label}</span>
            </span>
          );
        },
      },
      category: { width: 90, render: (r: RouteRuleRow) => <span className="muted">{r.categoryLabel}</span> },
      customerTrunks: { width: 220, render: (r: RouteRuleRow) => <TrunksCell row={r} /> },
      destination: {
        width: 200,
        render: (r: RouteRuleRow) => <DestinationCell row={r} />,
      },
      vendors: {
        width: 250,
        render: (r: RouteRuleRow) =>
          r.routeType === "block" ? (
            <span className="muted">—</span>
          ) : (
            <VendorsCell
              row={r}
              // The rule's vendor and LCR settings in their window (team trial round 8: it did nothing before).
              onMore={() => void ask<void>((d) => <VendorsDialog id={r.id} done={() => d()} />)}
            />
          ),
      },
      messages: {
        width: 70,
        label: win,
        render: (r: RouteRuleRow) =>
          r.messages === null ? (
            <span className="muted">—</span>
          ) : (
            <TrafficHover ruleId={r.id} frame={win}>
              {compact(r.messages)}
            </TrafficHover>
          ),
      },
      asr: {
        width: 70,
        render: (r: RouteRuleRow) => (
          <span className={r.routeType === "block" ? "muted" : qualityClass(r.asr)}>{formatPct(r.asr)}</span>
        ),
      },
      dlr: {
        width: 70,
        render: (r: RouteRuleRow) => (
          <span className={dlrClass(r)} title={dlrTitle(r)}>
            {formatPct(r.dlr)}
          </span>
        ),
      },
      margin: {
        width: 84,
        render: (r: RouteRuleRow) =>
          r.margin === null ? (
            <span className="muted">—</span>
          ) : (
            <span className={r.margin < 0 ? "tone-error strong" : ""}>{money(r.margin, ccy)}</span>
          ),
      },
      status: {
        width: 72,
        render: (r: RouteRuleRow) => (
          <button
            type="button"
            className="dot-toggle"
            disabled={r.archived}
            aria-label={r.status === "active" ? `Turn #${r.id} off` : `Turn #${r.id} on`}
            title={r.status === "active" ? "On – click to turn off" : "Off – click to turn on"}
            onClick={(e) => {
              e.stopPropagation();
              runBulk(
                [r.id],
                r.status === "active" ? "disable" : "enable",
                r.status === "active" ? "Turned off" : "Turned on",
              );
            }}
          >
            <StatusDot tone={r.status === "active" ? "good" : "neutral"} hollow={r.status !== "active"} />
          </button>
        ),
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [win, ccy],
  );

  return (
    <ListScreen<RouteRuleRow>
      // A click highlights the rule; double-click or Enter opens the panel on Edit (team trial round 3).
      detailOpensOn="double"
      // Half the page until dragged (team trial round 8).
      detailDefaultWidth="50%"
      openRef={openRule}
      onOpen={() => setSection("edit")}
      list="route_rules"
      page={page}
      historyScope={{ entityTypes: ["route_rule"] }}
      primary={{ label: "New rule", onClick: () => void newRule() }}
      actions={
        <>
          <CleanupBadge
            kinds={[
              "route_rule_unused",
              "route_rule_expired",
              "route_rule_identical",
              "route_rule_near_duplicate",
              "route_rule_shadowed",
              "route_rule_conflict",
              "route_rule_broken",
            ]}
          />
          <Button
            icon="play"
            onClick={() =>
              void ask<null>((done) => (
                <SimulateDialog
                  onClose={() => done(null)}
                  onOpenRule={(id) => {
                    done(null);
                    showRule(id);
                  }}
                />
              ))
            }
          >
            Simulate
          </Button>
        </>
      }
      onExport={(s) =>
        void exportRouteRules(toListQuery(s)).catch((e) => toast({ tone: "error", message: problemText(e) }))
      }
      columns={columns}
      detail={detail}
      selectId={selectId}
      // Ctrl K, Team report and Cleanup links: /routing/rules?rule=<id> opens that rule (functional QA round 13).
      deepLink="rule"
      section={sectionState}
      // The rule's own actions: E edit, D duplicate, the vendor popup, on/off, delete (§6.3, §13.29).
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: r.archived,
          hint: r.archived ? "Restore the rule to edit it" : undefined,
          // The rule in its own window, like New rule (team trial round 8); double-click opens the panel.
          onSelect: () => void ask<void>((d) => <EditRuleDialog id={r.id} done={() => d()} />),
        },
        {
          label: "Clone",
          icon: "copy",
          disabled: r.archived,
          hint: r.archived ? "Deleted rule" : "A copy, turned off",
          onSelect: () => duplicate(r),
        },
        {
          label: "Edit vendors…",
          icon: "shuffle",
          disabled: r.archived || r.routeType === "block",
          hint: r.archived ? "Deleted rule" : r.routeType === "block" ? "A block rule has no vendors" : undefined,
          onSelect: () => void ask<void>((d) => <VendorsDialog id={r.id} done={() => d()} />),
        },
        r.status === "active"
          ? {
              label: "Turn off",
              icon: "x",
              disabled: r.archived,
              onSelect: () => runBulk([r.id], "disable", "Turned off"),
            }
          : {
              label: "Turn on",
              icon: "check",
              disabled: r.archived,
              hint: r.archived ? "Deleted rule" : undefined,
              onSelect: () => runBulk([r.id], "enable", "Turned on"),
            },
        "separator",
        r.archived
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !isAdmin || restore.isPending,
              hint: isAdmin ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (res) => res.change && notifySaved(res.change, `Restored rule #${r.id}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteRecord("route_rule", r.id, `rule #${r.id}`),
            },
      ]}
      selection={{
        summary: (rows, ids) => {
          const msgs = rows.reduce((sum, r) => sum + (ids.has(r.id) ? (r.messages ?? 0) : 0), 0);
          return `${ids.size} selected · ${compact(msgs)} msgs`;
        },
        bulk: (ids, clear) => [
          { label: "Turn on", icon: "check", onSelect: () => runBulk(ids, "enable", "Turned on") },
          { label: "Turn off", icon: "x", onSelect: () => runBulk(ids, "disable", "Turned off") },
          "separator",
          {
            label: "Set priority…",
            icon: "sort",
            onSelect: () => void ask<boolean>((done) => <BulkDialog kind="set_priority" ids={ids} done={done} />),
          },
          {
            label: "Shift priority…",
            icon: "sort",
            onSelect: () => void ask<boolean>((done) => <BulkDialog kind="shift_priority" ids={ids} done={done} />),
          },
          {
            label: "Replace vendor…",
            icon: "shuffle",
            onSelect: () => void ask<boolean>((done) => <BulkDialog kind="replace_vendor" ids={ids} done={done} />),
          },
          {
            label: "Apply LCR profile…",
            icon: "route",
            onSelect: () => void ask<boolean>((done) => <BulkDialog kind="set_lcr_profile" ids={ids} done={done} />),
          },
          "separator",
          {
            label: ids.length === 1 ? "Delete…" : `Delete ${ids.length} rules…`,
            icon: "trash",
            danger: true,
            onSelect: () =>
              void (async () => {
                if (ids.length === 1) {
                  await deleteRecord("route_rule", ids[0]!, `rule #${ids[0]}`);
                  return clear();
                }
                const ok = await confirmDialog({
                  title: `Delete ${ids.length} rules?`,
                  message:
                    "Delete archives the rules: they stop routing at once and stay in reports and history. One Undo restores them all.",
                  ok: "Delete",
                  danger: true,
                });
                if (!ok) return;
                bulk.mutate(
                  { ruleIds: ids, action: "archive" },
                  {
                    onSuccess: (r) => {
                      if (r.change) notifySaved(r.change, `Deleted ${r.affected} rules`);
                      clear();
                    },
                    onError: (e) => toast({ tone: "error", message: problemText(e) }),
                  },
                );
              })(),
          },
        ],
      }}
      onKey={(key, row) => {
        if (!row) return false;
        if (key === "e" || key === "E") {
          // E is the Edit button: the rule in its own window (team trial round 8).
          if (row.archived) return false;
          void ask<void>((d) => <EditRuleDialog id={row.id} done={() => d()} />);
          return true;
        }
        if (key === "d" || key === "D") return (void duplicate(row), true);
        return false;
      }}
      shortcuts={SHORTCUTS}
    />
  );
}
