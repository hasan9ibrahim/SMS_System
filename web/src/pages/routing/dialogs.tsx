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
import { fieldLine, problemFields } from "../../api/problems";
import { useBulkRouteRules, useRouteRule, useSaveRouteRule } from "../../api/routing";
import { useNotifySaved } from "../../history/undo";
import { useMe } from "../../api/hooks";
import { isAdminUser, ListLookup } from "../../records/parts";
import { Icon } from "../../ui/Icon";
import { Button, Modal } from "../../ui/primitives";
import { shareProblems, soleOnLevel, toInput, withSoleShares } from "./ruleModel";

/** New rules start at 97; 98–100 are kept for administrators (team trial round 1). */
export const DEFAULT_PRIORITY = 97;
const useMaxPriority = () => (isAdminUser(useMe().data?.permissions) ? 100 : DEFAULT_PRIORITY);

/** What went wrong, in plain words: each field's problem, else the problem's title (functional QA round 13). */
export const problemText = (e: unknown) => {
  if (!(e instanceof ApiError)) return String(e);
  const fields = problemFields(e.problem);
  return fields.length ? fields.map(fieldLine).join(" ") : e.message;
};

type General = Pick<
  RouteRuleInput,
  "name" | "priority" | "status" | "routeType" | "continueRouting" | "comment" | "dlrTargetPct"
>;

/** New rule (rule = null) or the rule's settings (E edit). */
/**
 * The rule's general fields (name, priority, route type for a new rule, continue routing, DLR target,
 * comment, on / off), shared by the Edit section of the detail panel, New rule and Duplicate (team trial round 2).
 * `onSaved` gets the rule id after a save; `onCancel` shows a Cancel button.
 */
export function RuleGeneralForm({
  rule,
  onSaved,
  onCancel,
  submitLabel,
  hint,
  hideStatus = false,
  draft = false,
  draftName,
  bindSubmit,
  windowed = false,
  onEdit,
}: {
  rule: RouteRuleDetail | null;
  onSaved: (id: number) => void;
  onCancel?: () => void;
  submitLabel?: string;
  hint?: string;
  /** New rule has Rule on in its footer. */
  hideStatus?: boolean;
  /**
   * New rule (team trial round 3): `rule` is the draft just created; the name starts empty, the route type can still
   * be picked, and there is no button of its own: the window's Save calls the function given to `bindSubmit`.
   */
  draft?: boolean;
  /** The name a draft starts with (Clone: "… (copy)", team trial round 6); empty otherwise. */
  draftName?: string;
  bindSubmit?: (submit: (patch?: Partial<RouteRuleInput>) => Promise<string | null>) => void;
  /** In the Edit window (team trial round 8): no button of its own, the window's Save calls `bindSubmit`. */
  windowed?: boolean;
  /** A field changed: the window clears the error it shows from the last Save. */
  onEdit?: () => void;
}) {
  const save = useSaveRouteRule();
  const notifySaved = useNotifySaved();
  const maxPriority = useMaxPriority();
  const [g, setG] = useState<General>(
    rule
      ? {
          name: draft ? (draftName ?? "") : rule.name,
          priority: rule.priority,
          status: rule.status,
          routeType: rule.routeType,
          continueRouting: rule.continueRouting,
          comment: rule.comment,
          dlrTargetPct: rule.dlrTargetPct,
        }
      : {
          name: "",
          priority: DEFAULT_PRIORITY,
          // A new rule starts off: with no conditions yet it would match all traffic.
          status: "inactive",
          routeType: "static",
          continueRouting: "stop",
          comment: null,
          dlrTargetPct: null,
        },
  );
  const [error, setError] = useState<string | null>(null);
  // An edit clears the last Save's error ("Enter the rule name." stayed after a name was typed, functional QA round 13).
  const set = (patch: Partial<General>) => {
    setG((x) => ({ ...x, ...patch }));
    setError(null);
    onEdit?.();
  };
  // Saves the fields (plus `patch`, e.g. Rule on from New rule's footer); resolves with an error text or null.
  const submitAsync = async (patch: Partial<RouteRuleInput> = {}): Promise<string | null> => {
    const fail = (m: string) => (setError(m), m);
    if (!g.name.trim()) return fail("Enter the rule name.");
    const input: RouteRuleInput = rule
      ? toInput(rule, { ...g, name: g.name.trim(), ...patch })
      : ({ ...g, name: g.name.trim(), ...patch } as RouteRuleInput);
    try {
      const r = await save.mutateAsync({ id: rule?.id ?? null, input });
      if (r.change && !draft) notifySaved(r.change, rule ? "Saved" : `Added #${r.record.id} ${r.record.name}`);
      setError(null);
      onSaved(r.record.id);
      return null;
    } catch (e) {
      return fail(problemText(e));
    }
  };
  const submit = () => void submitAsync();
  bindSubmit?.(submitAsync);
  return (
    <div className="rule-general">
      {/* Compact (team trial round 8): one row of one-line fields; STOP / YES is a small switch,
          and the DLR target is kept as it is (set on the MCCMNC codes page). The route type is set in Configuration. */}
      <div className="rule-general-grid">
        <label className="field rg-name">
          <span>
            Name<span className="req">*</span>
          </span>
          <input
            autoFocus
            value={g.name}
            maxLength={120}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => set({ name: e.target.value })}
          />
        </label>
        <label
          className="field rg-prio"
          title={`1–100, 100 tried first${maxPriority < 100 ? "; 98–100 only by an administrator" : ""}`}
        >
          <span>
            Priority<span className="req">*</span>
          </span>
          <input
            type="number"
            min={1}
            max={Math.max(maxPriority, rule?.priority ?? 0)}
            value={g.priority}
            onChange={(e) =>
              set({
                priority: Math.max(
                  1,
                  Math.min(Math.max(maxPriority, rule?.priority ?? 0), Number(e.target.value) || 1),
                ),
              })
            }
          />
        </label>
        {/* R3 (2026-10-24): a matched rule with a working vendor always wins; this only applies when none can
            take the message. Groups and NEXT were removed (R4). */}
        <div
          className="field rg-cont"
          title="When this rule matches but none of its vendors can take the message: STOP fails it here, YES tries the next matching rule"
        >
          <span>No vendor can take it</span>
          <label className="mini-switch">
            <input
              type="checkbox"
              checked={g.continueRouting === "yes"}
              onChange={(e) => set({ continueRouting: e.target.checked ? "yes" : "stop" })}
            />
            <span className="mini-switch-track" aria-hidden="true" />
            <span className="mini-switch-text">{g.continueRouting === "yes" ? "YES · next rule" : "STOP"}</span>
          </label>
        </div>
        <label className="field rg-comment">
          <span>Comment</span>
          <input
            maxLength={1000}
            value={g.comment ?? ""}
            placeholder="Optional"
            onChange={(e) => set({ comment: e.target.value || null })}
          />
        </label>
      </div>
      {rule && hideStatus ? null : rule ? (
        <label className="toggle-inline">
          <input
            type="checkbox"
            checked={g.status === "active"}
            onChange={(e) => set({ status: e.target.checked ? "active" : "inactive" })}
          />
          Rule on
        </label>
      ) : (
        hint && <p className="muted small">{hint}</p>
      )}
      {error && <p className="error-text">{error}</p>}
      {!draft && !windowed && (
        <div className="form-actions">
          {onCancel && <Button onClick={onCancel}>Cancel</Button>}
          <Button variant="primary" onClick={submit} disabled={save.isPending}>
            {submitLabel ?? (rule ? "Save" : "Add rule")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The general fields in a dialog (Duplicate opens the copy here to rename it). */
export function RuleDialog({ rule, done }: { rule: RouteRuleDetail | null; done: (id: number | null) => void }) {
  return (
    <Modal title={rule ? `Edit #${rule.id} ${rule.name}` : "New route rule"} width={560} onClose={() => done(null)}>
      <RuleGeneralForm rule={rule} onSaved={(id) => done(id)} onCancel={() => done(null)} />
    </Modal>
  );
}

type BulkKind = "set_priority" | "shift_priority" | "replace_vendor" | "set_lcr_profile";

/** Bulk edit with a value (§13.11); enable, disable and delete need none. One bulk = one change. */
export function BulkDialog({ kind, ids, done }: { kind: BulkKind; ids: number[]; done: (ok: boolean) => void }) {
  const bulk = useBulkRouteRules();
  const notifySaved = useNotifySaved();
  const maxPriority = useMaxPriority();
  const [priority, setPriority] = useState(DEFAULT_PRIORITY);
  const [shift, setShift] = useState(10);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [profile, setProfile] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const title =
    kind === "set_priority"
      ? "Set priority"
      : kind === "shift_priority"
        ? "Shift priority"
        : kind === "set_lcr_profile"
          ? "Apply LCR profile"
          : "Replace vendor";
  const submit = () => {
    const body: RouteBulkRequest = { ruleIds: ids, action: kind, ...(note.trim() ? { note: note.trim() } : {}) };
    if (kind === "set_priority") body.priority = priority;
    if (kind === "shift_priority") body.shift = shift;
    if (kind === "set_lcr_profile") {
      if (!profile) return setError("Choose an LCR profile.");
      body.lcrProfileId = profile;
    }
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
          <span>New priority (1–{maxPriority})</span>
          <input
            autoFocus
            type="number"
            min={1}
            max={maxPriority}
            value={priority}
            onChange={(e) => setPriority(Math.max(1, Math.min(maxPriority, Number(e.target.value) || 1)))}
          />
        </label>
      )}
      {kind === "shift_priority" && (
        <label className="field">
          <span>Shift by (positive = earlier)</span>
          <input
            autoFocus
            type="number"
            min={-99}
            max={99}
            value={shift}
            onChange={(e) => setShift(Number(e.target.value))}
          />
        </label>
      )}
      {kind === "set_lcr_profile" && (
        <div className="field">
          <span>LCR profile</span>
          <ListLookup<{ id: number; name: string; vendorCount: number }>
            list="lcr_profiles"
            value={profile}
            onChange={(r) => setProfile(r?.id ?? null)}
            labelOf={(r) => r.name}
            detailOf={(r) => `${r.vendorCount} vendors`}
            placeholder="Profile…"
          />
        </div>
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

/**
 * In-place editor of the Vendors column (§15.4): the vendors of every level (team trial round 12: level 1 only
 * before). Backups are kept as they are; a vendor's own backups follow it when it changes and go when it is removed.
 */
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
  const [edited, setEdited] = useState<RouteVendor[] | null>(null);
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
            : r.routeType === "dynamic"
              ? "Least cost: the vendors in scope are ranked by the rule's LCR profile."
              : "Quality: the vendors in scope are ranked by their quality."}
        </p>
        {r.routeType !== "block" && (
          <Button small onClick={onMore}>
            {r.routeType === "dynamic" ? "Open LCR settings" : "Open vendor settings"}
          </Button>
        )}
      </div>
    );
  const all = edited ?? r.vendors;
  const main = all.filter((v) => !v.isBackup);
  const backups = all.filter((v) => v.isBackup);
  const levels = [...new Set(main.map((v) => v.level))].sort((a, b) => a - b);
  const pct = r.huntPolicy === "percentage";
  const setAt = (target: RouteVendor, patch: Partial<RouteVendor>) =>
    setEdited(
      all.map((v) =>
        v === target
          ? { ...v, ...patch }
          : // A vendor's own backups follow it to its new trunk.
            patch.vendorTrunkId && v.isBackup && target.vendorTrunkId && v.backupForVendorTrunkId === target.vendorTrunkId
            ? { ...v, backupForVendorTrunkId: patch.vendorTrunkId }
            : v,
      ),
    );
  const remove = (target: RouteVendor) =>
    setEdited(
      all.filter(
        (v) => v !== target && !(v.isBackup && target.vendorTrunkId && v.backupForVendorTrunkId === target.vendorTrunkId),
      ),
    );
  const add = (level: number) =>
    setEdited([
      ...all,
      {
        level,
        vendorTrunkId: 0,
        sharePct: pct ? 0 : null,
        isBackup: false,
        warmupCount: null,
        warmupPer: null,
        warmupReset: null,
      },
    ]);
  const problems = shareProblems(all, r.huntPolicy);
  const submit = () => {
    if (!main.length) return setError("Keep at least one vendor.");
    if (main.some((v) => !v.vendorTrunkId)) return setError("Choose a vendor trunk on every row.");
    if (problems.length) return setError(problems.join(" "));
    const vendors = withSoleShares(all, r.huntPolicy);
    // A level added here raises the rule's route levels to match (the server refuses vendors above them).
    const maxRouteLevel = Math.max(r.maxRouteLevel, ...vendors.map((v) => v.level));
    save.mutate(
      { id: r.id, input: toInput(r, { vendors, maxRouteLevel }) },
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
        <strong>Vendors</strong>
        <span className="muted small">{pct ? "percentage split" : r.huntPolicy.replace("_", " ")}</span>
      </div>
      {levels.map((level) => (
        <div key={level} className="split-level">
          {levels.length > 1 && <div className="split-level-head muted small">Level {level}</div>}
          {main
            .filter((v) => v.level === level)
            .map((v, i) => (
              <div key={`${level}-${i}`} className="split-row">
                <ListLookup<TrunkListRow>
                  list="vendor_trunks"
                  value={v.vendorTrunkId || null}
                  clearable={false}
                  onChange={(t) => t && setAt(v, { vendorTrunkId: t.id })}
                  labelOf={(t) => t.name}
                  placeholder="Vendor trunk…"
                />
                {pct &&
                  (soleOnLevel(all, v) ? (
                    // Alone on its level it takes everything: no share to type (team trial round 12).
                    <span className="muted num w-num" title="The only vendor on this level takes all of it">
                      100%
                    </span>
                  ) : (
                    <input
                      className="num w-num"
                      type="number"
                      min={0}
                      max={100}
                      aria-label="Share %"
                      value={v.sharePct ?? ""}
                      onChange={(e) => setAt(v, { sharePct: e.target.value === "" ? null : Number(e.target.value) })}
                    />
                  ))}
                <button type="button" className="icon-btn" aria-label="Remove vendor" onClick={() => remove(v)}>
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
          <button type="button" className="link small split-add" onClick={() => add(level)}>
            + Add vendor{levels.length > 1 ? ` to level ${level}` : ""}
          </button>
        </div>
      ))}
      <div className="split-foot">
        <Button small icon="plus" onClick={() => add((levels.at(-1) ?? 0) + 1)}>
          {levels.length ? "Add level" : "Add vendor"}
        </Button>
        {backups.length > 0 && (
          <button type="button" className="link small" onClick={onMore}>
            {backups.length} backup{backups.length === 1 ? "" : "s"}
          </button>
        )}
        <span className="fb-spacer" />
        <Button small onClick={onClose}>
          Cancel
        </Button>
        <Button small onClick={submit} disabled={save.isPending || edited === null}>
          Save
        </Button>
      </div>
      {problems.length > 0 && <p className="tone-warning small">{problems.join(" ")}</p>}
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}
