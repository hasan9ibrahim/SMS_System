// Route Rules dialogs: new rule and rule settings (§6.3 General Information), bulk edit
// (§13.11) and the in-place vendor split editor of the Vendors column (§15.4).
import { useState } from "react";
import type {
  RouteBulkRequest,
  RouteRuleDetail,
  RouteRuleInput,
  RouteRuleRow,
  RouteVendor,
  TrunkListRow,
} from "@sms/contract";
import { ApiError } from "../../api/client";
import { useReference } from "../../api/records";
import { useBulkRouteRules, useRouteRule, useSaveRouteRule } from "../../api/routing";
import { useNotifySaved } from "../../history/undo";
import { ListLookup } from "../../records/parts";
import { Icon } from "../../ui/Icon";
import { Button, Modal } from "../../ui/primitives";
import { ROUTE_TYPES, shareProblems, toInput } from "./ruleModel";

export const problemText = (e: unknown) => {
  if (!(e instanceof ApiError)) return String(e);
  const errors = (e.problem.errors ?? []) as { path: string; message: string }[];
  return errors.length ? errors.map((x) => `${x.path.replace(/^\//, "")}: ${x.message}`).join("; ") : e.message;
};

type General = Pick<
  RouteRuleInput,
  | "name"
  | "priority"
  | "status"
  | "routeType"
  | "groupId"
  | "nextGroupId"
  | "continueRouting"
  | "comment"
  | "dlrTargetPct"
>;

/** New rule (rule = null) or the rule's settings (E edit). */
export function RuleDialog({ rule, done }: { rule: RouteRuleDetail | null; done: (id: number | null) => void }) {
  const ref = useReference();
  const save = useSaveRouteRule();
  const notifySaved = useNotifySaved();
  const [g, setG] = useState<General>(
    rule
      ? {
          name: rule.name,
          priority: rule.priority,
          status: rule.status,
          routeType: rule.routeType,
          groupId: rule.groupId,
          nextGroupId: rule.nextGroupId,
          continueRouting: rule.continueRouting,
          comment: rule.comment,
          dlrTargetPct: rule.dlrTargetPct,
        }
      : {
          name: "",
          priority: 50,
          // A new rule starts off: with no conditions yet it would match all traffic.
          status: "inactive",
          routeType: "static",
          groupId: null,
          nextGroupId: null,
          continueRouting: "stop",
          comment: null,
          dlrTargetPct: null,
        },
  );
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<General>) => setG((x) => ({ ...x, ...patch }));
  const groups = ref.data?.routeRuleGroups ?? [];
  const submit = () => {
    if (!g.name.trim()) return setError("Enter the rule name.");
    if (g.continueRouting === "next" && !g.nextGroupId) return setError("Choose the next group for NEXT.");
    const input: RouteRuleInput = rule
      ? toInput(rule, { ...g, name: g.name.trim() })
      : ({ ...g, name: g.name.trim() } as RouteRuleInput);
    save.mutate(
      { id: rule?.id ?? null, input },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, rule ? "Saved" : `Added #${r.record.id} ${r.record.name}`);
          done(r.record.id);
        },
        onError: (e) => setError(problemText(e)),
      },
    );
  };
  return (
    <Modal
      title={rule ? `Edit #${rule.id} ${rule.name}` : "New route rule"}
      width={560}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>
            {rule ? "Save" : "Add rule"}
          </Button>
        </>
      }
    >
      <div className="fgrid cols-3">
        <label className="field span-2">
          <span>
            Name<span className="req">*</span>
          </span>
          <input autoFocus value={g.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="field">
          <span>
            Priority<span className="req">*</span>
          </span>
          <input
            type="number"
            min={1}
            max={100}
            value={g.priority}
            onChange={(e) => set({ priority: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })}
          />
          <small className="muted">1–100, low first</small>
        </label>
      </div>
      {!rule && (
        <div className="field">
          <span>Route type</span>
          <div className="segmented" role="radiogroup">
            {ROUTE_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={g.routeType === t.value}
                className={g.routeType === t.value ? "on" : ""}
                onClick={() => set({ routeType: t.value })}
              >
                <span className={`dot dot-${t.tone}`} /> {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="fgrid cols-3">
        <label className="field">
          <span>Continue routing</span>
          <select
            value={g.continueRouting}
            onChange={(e) => set({ continueRouting: e.target.value as General["continueRouting"] })}
          >
            <option value="stop">STOP – end here</option>
            <option value="yes">YES – keep evaluating</option>
            <option value="next">NEXT – jump to group</option>
          </select>
        </label>
        <label className="field">
          <span>Group</span>
          <select
            value={g.groupId ?? ""}
            onChange={(e) => set({ groupId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">—</option>
            {groups.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Next group</span>
          <select
            value={g.nextGroupId ?? ""}
            disabled={g.continueRouting !== "next"}
            onChange={(e) => set({ nextGroupId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">—</option>
            {groups.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>DLR target %</span>
        <input
          type="number"
          min={0}
          max={100}
          step={0.5}
          placeholder="Empty = the destinations' targets"
          value={g.dlrTargetPct ?? ""}
          onChange={(e) =>
            set({ dlrTargetPct: e.target.value === "" ? null : Math.max(0, Math.min(100, Number(e.target.value))) })
          }
        />
        <small className="muted">
          The grid shows the rule's DLR in amber below it. Destination targets are set on the MCCMNC codes page.
        </small>
      </label>
      <label className="field">
        <span>Comment</span>
        <textarea
          rows={2}
          maxLength={1000}
          value={g.comment ?? ""}
          onChange={(e) => set({ comment: e.target.value || null })}
        />
      </label>
      <label className="toggle-inline">
        <input
          type="checkbox"
          checked={g.status === "active"}
          onChange={(e) => set({ status: e.target.checked ? "active" : "inactive" })}
        />
        Rule on
      </label>
      {!rule && (
        <p className="muted small">
          The rule starts off. Add its conditions and vendors in the detail panel, test it, then turn it on.
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

type BulkKind = "set_priority" | "shift_priority" | "replace_vendor";

/** Bulk edit with a value (§13.11); enable, disable and delete need none. One bulk = one change. */
export function BulkDialog({ kind, ids, done }: { kind: BulkKind; ids: number[]; done: (ok: boolean) => void }) {
  const bulk = useBulkRouteRules();
  const notifySaved = useNotifySaved();
  const [priority, setPriority] = useState(50);
  const [shift, setShift] = useState(10);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const title =
    kind === "set_priority" ? "Set priority" : kind === "shift_priority" ? "Shift priority" : "Replace vendor";
  const submit = () => {
    const body: RouteBulkRequest = { ruleIds: ids, action: kind, ...(note.trim() ? { note: note.trim() } : {}) };
    if (kind === "set_priority") body.priority = priority;
    if (kind === "shift_priority") body.shift = shift;
    if (kind === "replace_vendor") {
      if (!from || !to) return setError("Choose both vendor trunks.");
      if (from === to) return setError("Choose two different vendor trunks.");
      body.fromVendorTrunkId = from;
      body.toVendorTrunkId = to;
    }
    bulk.mutate(body, {
      onSuccess: (r) => {
        if (r.change) notifySaved(r.change, `${title}: ${r.affected} rule${r.affected === 1 ? "" : "s"} changed`);
        done(true);
      },
      onError: (e) => setError(problemText(e)),
    });
  };
  return (
    <Modal
      title={`${title} · ${ids.length} rule${ids.length === 1 ? "" : "s"}`}
      onClose={() => done(false)}
      footer={
        <>
          <Button onClick={() => done(false)}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={bulk.isPending}>
            Apply
          </Button>
        </>
      }
    >
      {kind === "set_priority" && (
        <label className="field">
          <span>New priority (1–100)</span>
          <input
            autoFocus
            type="number"
            min={1}
            max={100}
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
          />
        </label>
      )}
      {kind === "shift_priority" && (
        <label className="field">
          <span>Shift by (negative = earlier)</span>
          <input
            autoFocus
            type="number"
            min={-99}
            max={99}
            value={shift}
            onChange={(e) => setShift(Number(e.target.value))}
          />
          <small className="muted">Results are kept between 1 and 100.</small>
        </label>
      )}
      {kind === "replace_vendor" && (
        <div className="fgrid cols-2">
          <div className="field">
            <span>Replace vendor trunk</span>
            <ListLookup<TrunkListRow>
              list="vendor_trunks"
              value={from}
              onChange={(r) => setFrom(r?.id ?? null)}
              labelOf={(r) => r.name}
              detailOf={(r) => r.enterpriseName}
              placeholder="Vendor trunk…"
            />
          </div>
          <div className="field">
            <span>with</span>
            <ListLookup<TrunkListRow>
              list="vendor_trunks"
              value={to}
              onChange={(r) => setTo(r?.id ?? null)}
              labelOf={(r) => r.name}
              detailOf={(r) => r.enterpriseName}
              placeholder="Vendor trunk…"
            />
          </div>
          <p className="muted small" style={{ gridColumn: "1 / -1" }}>
            Swaps the vendor on every level, in the vendor scope and in number whitelists of the chosen rules.
          </p>
        </div>
      )}
      <label className="field">
        <span>Note (kept with the change)</span>
        <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

/** In-place editor of the Vendors column: the vendor split of level 1 (§15.4). */
export function VendorSplitEditor({
  row,
  onClose,
  onMore,
}: {
  row: RouteRuleRow;
  onClose: () => void;
  onMore: () => void;
}) {
  const rule = useRouteRule(row.id);
  const save = useSaveRouteRule();
  const notifySaved = useNotifySaved();
  const [split, setSplit] = useState<RouteVendor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const r = rule.data;
  if (!r)
    return <div className="split-editor muted small pad">{rule.isError ? "Could not load the rule." : "Loading…"}</div>;
  if (r.routeType !== "static")
    return (
      <div className="split-editor">
        <p className="small">
          {r.routeType === "block"
            ? "A block rule has no vendors."
            : "Least cost and quality rules rank the vendors in scope; edit the scope in the Vendors section."}
        </p>
        <Button small onClick={onMore}>
          Open Vendors section
        </Button>
      </div>
    );
  const level1 = split ?? r.vendors.filter((v) => v.level === 1 && !v.isBackup);
  const others = r.vendors.filter((v) => !(v.level === 1 && !v.isBackup));
  const pct = r.huntPolicy === "percentage";
  const setAt = (i: number, patch: Partial<RouteVendor>) =>
    setSplit(level1.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const problems = shareProblems(level1, r.huntPolicy);
  const submit = () => {
    if (!level1.length) return setError("Keep at least one vendor.");
    if (level1.some((v) => !v.vendorTrunkId)) return setError("Choose a vendor trunk on every row.");
    if (problems.length) return setError(problems.join(" "));
    save.mutate(
      { id: r.id, input: toInput(r, { vendors: [...level1, ...others] }) },
      {
        onSuccess: (res) => {
          if (res.change) notifySaved(res.change, `Vendors of #${r.id} saved`);
          onClose();
        },
        onError: (e) => setError(problemText(e)),
      },
    );
  };
  return (
    <div
      className="split-editor"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") submit();
      }}
    >
      <div className="split-head">
        <strong>Level 1 vendors</strong>
        <span className="muted small">{pct ? "percentage split" : r.huntPolicy.replace("_", " ")}</span>
      </div>
      {level1.map((v, i) => (
        <div key={i} className="split-row">
          <ListLookup<TrunkListRow>
            list="vendor_trunks"
            value={v.vendorTrunkId || null}
            clearable={false}
            onChange={(t) => t && setAt(i, { vendorTrunkId: t.id })}
            labelOf={(t) => t.name}
            placeholder="Vendor trunk…"
          />
          {pct && (
            <input
              className="num w-num"
              type="number"
              min={0}
              max={100}
              aria-label="Share %"
              value={v.sharePct ?? ""}
              onChange={(e) => setAt(i, { sharePct: e.target.value === "" ? null : Number(e.target.value) })}
            />
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="Remove vendor"
            onClick={() => setSplit(level1.filter((_, j) => j !== i))}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
      <div className="split-foot">
        <Button
          small
          icon="plus"
          onClick={() =>
            setSplit([
              ...level1,
              {
                level: 1,
                vendorTrunkId: 0,
                sharePct: pct ? 0 : null,
                isBackup: false,
                warmupCount: null,
                warmupPer: null,
                warmupReset: null,
              },
            ])
          }
        >
          Add
        </Button>
        {others.length > 0 && (
          <button type="button" className="link small" onClick={onMore}>
            +{others.length} on other levels
          </button>
        )}
        <span className="fb-spacer" />
        <Button small onClick={onClose}>
          Cancel
        </Button>
        <Button small onClick={submit} disabled={save.isPending || split === null}>
          Save
        </Button>
      </div>
      {problems.length > 0 && <p className="tone-warning small">{problems.join(" ")}</p>}
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}
