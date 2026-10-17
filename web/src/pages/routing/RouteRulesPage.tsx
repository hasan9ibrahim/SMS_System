// Route Rules (§6.3, §13.8–13.11, §13.24, §13.27). The one page that copies the reference
// screenshot's layout and form exactly (§15.4): header links and actions, grid columns with
// a filter under each, the detail panel (Conditions / Vendors / Traffic / History / Test)
// with condition chips and the 24h trend on the right, and the status bar shortcuts.
import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RouteRuleDetail, RouteRuleRow, TrafficWindow } from "@sms/contract";
import { api, unwrap } from "../../api/client";
import { useBulkRouteRules, useCloneRouteRule, exportRouteRules, useRouteRule } from "../../api/routing";
import { toListQuery } from "../../grid/filterModel";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen, useGridUrlState, type DetailContent } from "../../page/ListScreen";
import { useDeleteRecord } from "../../records/parts";
import { ask, confirmDialog, toast } from "../../ui/feedback";
import { Button, Popover, StatusDot } from "../../ui/primitives";
import { formatPct } from "../rates/format";
import { AddCondition, ConditionsSection, RuleTitle, useRuleSaver as useSaver } from "./Conditions";
import { BulkDialog, RuleDialog, VendorSplitEditor, problemText } from "./dialogs";
import { compact, routeTypeOf } from "./ruleModel";
import { SimulateDialog, TestSection } from "./TestPanel";
import { TrafficAside, TrafficHover, TrafficSection, money, usePlatformCurrency } from "./Traffic";
import { VendorsSection } from "./VendorsSection";

const page = pageForPath("/routing/rules")!;

/**
 * DLR shows amber below the rule's target (§15.4; decided 2026-10-16): its own target, else
 * its destinations' (set on the MCCMNC codes page). No target = no colour.
 */
const dlrTitle = (r: RouteRuleRow) =>
  r.dlrTarget === null
    ? "No DLR target (set one on the rule or on its destinations)"
    : `Target ${r.dlrTarget}% (${r.dlrTargetSource === "rule" ? "this rule" : "its destinations"})`;

const SHORTCUTS = "↑↓ move · Space select · E edit · D duplicate · Ctrl+Z undo";

function VendorsSectionFor({ id }: { id: number }) {
  const rule = useRouteRule(id);
  const { save, saving } = useSaver(rule.data);
  if (!rule.data) return <p className="muted">Loading…</p>;
  if (rule.data.archived) return <p className="muted">Restore the rule to edit its vendors.</p>;
  // Keyed by the change time, so a save or undo elsewhere reloads the form.
  return <VendorsSection key={rule.data.updatedAt} rule={rule.data} saving={saving} onSave={save} />;
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
      <button
        ref={anchor}
        type="button"
        className={`cell-edit${open ? " editing" : ""}`}
        title="Edit the vendor split"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {row.vendorsLabel}
      </button>
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

function TrunksCell({ row }: { row: RouteRuleRow }) {
  const m = /^(.*?)( \+\d+)$/.exec(row.customerTrunksLabel);
  const more = row.customerTrunkCount - row.customerTrunkNames.length;
  const title = row.customerTrunkNames.length
    ? row.customerTrunkNames.join("\n") + (more > 0 ? `\n… and ${more} more` : "")
    : undefined;
  return (
    <span title={title}>
      {m ? (
        <>
          {m[1]}
          <span className="muted">{m[2]}</span>
        </>
      ) : (
        row.customerTrunksLabel
      )}
    </span>
  );
}

export function RouteRulesPage() {
  const qc = useQueryClient();
  const [state, setState] = useGridUrlState();
  const bulk = useBulkRouteRules();
  const clone = useCloneRouteRule();
  const notifySaved = useNotifySaved();
  const deleteRecord = useDeleteRecord();
  const ccy = usePlatformCurrency();
  const [selectId, setSelectId] = useState<number | null>(null);
  const sectionState = useState<string | null>(null);
  const [, setSection] = sectionState;
  const win = (state.columns.window?.value as TrafficWindow | undefined) ?? "24h";

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

  const duplicate = (row: RouteRuleRow) =>
    clone.mutate(row.id, {
      onSuccess: (r) => {
        if (r.change) notifySaved(r.change, `Duplicated as #${r.record.id} (off)`);
        showRule(r.record.id);
      },
      onError: (e) => toast({ tone: "error", message: problemText(e) }),
    });

  const edit = async (row: RouteRuleRow) => {
    try {
      const rule = await loadRule(row.id);
      if (rule.archived) return toast({ tone: "info", message: "Restore the rule to edit it." });
      await ask<number>((done) => <RuleDialog rule={rule} done={done} />);
    } catch (e) {
      toast({ tone: "error", message: problemText(e) });
    }
  };

  const newRule = async () => {
    const id = await ask<number>((done) => <RuleDialog rule={null} done={done} />);
    if (id) {
      showRule(id);
      setSection("conditions");
    }
  };

  const detail = (row: RouteRuleRow): DetailContent => ({
    title: <RuleTitle id={row.id} fallback={row.name} />,
    sections: [
      {
        key: "conditions",
        label: "Conditions",
        content: <ConditionsSection id={row.id} />,
        actions: <AddCondition id={row.id} />,
      },
      { key: "vendors", label: "Vendors", content: <VendorsSectionFor id={row.id} /> },
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
      id: { width: 70, render: (r: RouteRuleRow) => <span className="muted num">{r.id}</span> },
      name: { width: 200, render: (r: RouteRuleRow) => <span className="strong">{r.name}</span> },
      priority: { width: 56 },
      routeType: {
        width: 110,
        render: (r: RouteRuleRow) => {
          const t = routeTypeOf(r.routeType);
          return (
            <span className="with-dot">
              <StatusDot tone={t.tone} /> {t.label}
            </span>
          );
        },
      },
      category: { width: 90, render: (r: RouteRuleRow) => <span className="muted">{r.categoryLabel}</span> },
      customerTrunks: { width: 240, render: (r: RouteRuleRow) => <TrunksCell row={r} /> },
      destination: {
        width: 150,
        render: (r: RouteRuleRow) => <span className="muted num">{r.destinationLabel}</span>,
      },
      vendors: {
        width: 250,
        render: (r: RouteRuleRow) =>
          r.routeType === "block" ? (
            <span className="muted">—</span>
          ) : (
            <VendorsCell
              row={r}
              onMore={() => {
                setSelectId(null);
                setSection("vendors");
              }}
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
      asr: { width: 70, render: (r: RouteRuleRow) => formatPct(r.asr) },
      dlr: {
        width: 70,
        render: (r: RouteRuleRow) => (
          <span
            className={r.dlr !== null && r.dlrTarget !== null && r.dlr < r.dlrTarget ? "tone-warning strong" : ""}
            title={dlrTitle(r)}
          >
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
        width: 50,
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
      list="route_rules"
      page={page}
      historyScope={{ entityTypes: ["route_rule"] }}
      primary={{ label: "New rule", onClick: () => void newRule() }}
      actions={
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
      }
      onExport={(s) =>
        void exportRouteRules(toListQuery(s)).catch((e) => toast({ tone: "error", message: problemText(e) }))
      }
      columns={columns}
      detail={detail}
      selectId={selectId}
      section={sectionState}
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
        if (key === "e" || key === "E") return (void edit(row), true);
        if (key === "d" || key === "D") return (void duplicate(row), true);
        return false;
      }}
      shortcuts={SHORTCUTS}
    />
  );
}
