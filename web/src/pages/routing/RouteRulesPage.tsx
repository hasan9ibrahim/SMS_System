// Route Rules (§6.3, §13.8–13.11, §13.24, §13.27). The one page that copies the reference
// screenshot's layout and form exactly (§15.4): header links and actions, grid columns with
// a filter under each, the detail panel (Conditions / Vendors / Traffic / History / Test)
// with condition chips and the 24h trend on the right, and the status bar shortcuts.
import { HoverList } from "../../ui/HoverList";
import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RouteRuleDetail, RouteRuleRow, TrafficWindow } from "@sms/contract";
import { api, unwrap } from "../../api/client";
import { useMe } from "../../api/hooks";
import { useRestore } from "../../api/records";
import { useBulkRouteRules, useCloneRouteRule, exportRouteRules, useRouteRule } from "../../api/routing";
import { toListQuery } from "../../grid/filterModel";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen, useGridUrlState, type DetailContent } from "../../page/ListScreen";
import { isAdminUser, useDeleteRecord } from "../../records/parts";
import { ask, confirmDialog, toast } from "../../ui/feedback";
import { Button, Modal, Popover, StatusDot } from "../../ui/primitives";
import { formatPct } from "../rates/format";
import { AddCondition, ConditionsSection, RuleTitle, useRuleSaver as useSaver } from "./Conditions";
import { BulkDialog, RuleDialog, VendorSplitEditor, problemText } from "./dialogs";
import { compact, routeTypeOf } from "./ruleModel";
import { SimulateDialog, TestSection } from "./TestPanel";
import { TrafficAside, TrafficHover, TrafficSection, money, usePlatformCurrency } from "./Traffic";
import { VendorsSection, VendorsView } from "./VendorsSection";
import { CleanupBadge } from "../admin/cleanup/CleanupBadge";

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
          {row.vendorsLabel}
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
  const clone = useCloneRouteRule();
  const notifySaved = useNotifySaved();
  const deleteRecord = useDeleteRecord();
  const { data: me } = useMe();
  const restore = useRestore("route_rule");
  const isAdmin = isAdminUser(me?.permissions);
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
        // The copy opens in the editor right away so it can be renamed (team trial round 1).
        void ask<number>((done) => <RuleDialog rule={r.record} done={done} />);
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
        width: 220,
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
      // Double-click or Enter edits the rule (team trial round 1).
      onOpen={(row) => void edit(row)}
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
      section={sectionState}
      // The rule's own actions: E edit, D duplicate, the vendor popup, on/off, delete (§6.3, §13.29).
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: r.archived,
          hint: r.archived ? "Restore the rule to edit it" : undefined,
          onSelect: () => void edit(r),
        },
        {
          label: "Clone",
          icon: "copy",
          disabled: r.archived || clone.isPending,
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
        if (key === "e" || key === "E") return (void edit(row), true);
        if (key === "d" || key === "D") return (void duplicate(row), true);
        return false;
      }}
      shortcuts={SHORTCUTS}
    />
  );
}
