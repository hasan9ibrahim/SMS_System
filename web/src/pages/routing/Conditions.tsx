// Conditions section of the detail panel (§15.4): the rule title with "all must match"
// (switchable to any), + Add condition, and one chip per condition (field, operator,
// value). A chip opens its editor; its × removes it. Each save is one change (§13.10).
import { useRef, useState } from "react";
import type { RouteRuleDetail, RouteRuleInput } from "@sms/contract";
import { useRouteRule, useSaveRouteRule } from "../../api/routing";
import { useNotifySaved } from "../../history/undo";
import { ArchivedBanner } from "../../records/parts";
import { Icon } from "../../ui/Icon";
import { Menu, Popover } from "../../ui/primitives";
import { ConditionEditor } from "./ConditionEditor";
import { problemText } from "./dialogs";
import {
  CONDITION_LABELS,
  CONFIG_KEYS,
  clearCondition,
  conditionChips,
  missingConditions,
  toInput,
  type ConditionKey,
} from "./ruleModel";
import { DuplicateWarning } from "../admin/cleanup/DuplicateWarning";
import { codesText, useDestinationTree } from "../rates/DestinationTree";

/** Saves a patch of the rule as one change; resolves with an error text or null. */
export function useRuleSaver(rule: RouteRuleDetail | undefined) {
  const save = useSaveRouteRule();
  const notifySaved = useNotifySaved();
  const run = async (patch: Partial<RouteRuleInput>, message = "Saved"): Promise<string | null> => {
    if (!rule) return "The rule is still loading.";
    try {
      const r = await save.mutateAsync({ id: rule.id, input: toInput(rule, patch) });
      if (r.change) notifySaved(r.change, message);
      return null;
    } catch (e) {
      return problemText(e);
    }
  };
  return { save: run, saving: save.isPending };
}

/** "#17945 AU OTP Premium  all must match" (§15.4). */
export function RuleTitle({ id, fallback }: { id: number; fallback: string }) {
  const rule = useRouteRule(id);
  const { save, saving } = useRuleSaver(rule.data);
  const r = rule.data;
  return (
    <span className="rule-title">
      <strong>
        #{id} {r?.name ?? fallback}
      </strong>
      {r && (
        <button
          type="button"
          className="match-mode"
          disabled={saving || !!r.archived}
          title="Switch between all conditions and any one condition"
          onClick={() => void save({ matchMode: r.matchMode === "all" ? "any" : "all" }, "Match mode saved")}
        >
          {r.matchMode === "all" ? "all must match" : "any one matches"}
        </button>
      )}
    </span>
  );
}

export function AddCondition({ id }: { id: number }) {
  const rule = useRouteRule(id);
  const { save, saving } = useRuleSaver(rule.data);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ConditionKey | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const r = rule.data;
  if (!r || r.archived) return null;
  const missing = missingConditions(r);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="btn btn-ghost btn-sm accent-text"
        disabled={missing.length === 0}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="plus" size={13} /> Add condition
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="end">
        <Menu
          onClose={() => setOpen(false)}
          items={missing.map((k) => ({
            label: CONDITION_LABELS[k],
            onSelect: () => (k === "multipart" ? void save({ denyMultipart: true }, "Condition added") : setEditing(k)),
          }))}
        />
      </Popover>
      {editing && (
        <ConditionEditor
          conditionKey={editing}
          rule={r}
          saving={saving}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            const err = await save(patch, "Condition added");
            if (!err) setEditing(null);
            return err;
          }}
        />
      )}
    </>
  );
}

export function ConditionsSection({ id }: { id: number }) {
  const rule = useRouteRule(id);
  const { save, saving } = useRuleSaver(rule.data);
  const [editing, setEditing] = useState<ConditionKey | null>(null);
  const { tree } = useDestinationTree();
  const r = rule.data;
  if (rule.isError) return <p className="error-text">{(rule.error as Error).message}</p>;
  if (!r) return <p className="muted">Loading…</p>;
  // Category, customer trunks and destination are under Configuration (team trial round 2).
  const chips = conditionChips(r, Date.now(), (codes) => codesText(tree, codes, 4)).filter(
    (c) => !CONFIG_KEYS.includes(c.key),
  );
  const locked = !!r.archived;
  return (
    <>
      <ArchivedBanner kind="route_rule" id={r.id} archived={r.archived} what="rule" />
      {!locked && (
        <DuplicateWarning what="rule" check={{ kind: "route_rule", excludeId: r.id, routeRule: toInput(r) }} />
      )}
      <div className="cond-grid">
        {chips.map((c) => (
          <div key={c.key} className="cond-chip">
            <button
              type="button"
              className="cond-body"
              disabled={locked}
              title={`Edit ${CONDITION_LABELS[c.key]}`}
              onClick={() => setEditing(c.key)}
            >
              <span className="cond-field">{c.field}</span>
              {c.op && <span className="cond-op">{c.op}</span>}
              <span className="cond-value">{c.value}</span>
            </button>
            {c.key !== "time" && !locked && (
              <button
                type="button"
                className="cond-x"
                aria-label={`Remove ${CONDITION_LABELS[c.key]} condition`}
                disabled={saving}
                onClick={() => void save(clearCondition(c.key, r), `${CONDITION_LABELS[c.key]} condition removed`)}
              >
                <Icon name="x" size={11} />
              </button>
            )}
          </div>
        ))}
      </div>
      {r.comment && <p className="muted small rule-comment">{r.comment}</p>}
      {editing && (
        <ConditionEditor
          conditionKey={editing}
          rule={r}
          saving={saving}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            const err = await save(patch);
            if (!err) setEditing(null);
            return err;
          }}
        />
      )}
    </>
  );
}
