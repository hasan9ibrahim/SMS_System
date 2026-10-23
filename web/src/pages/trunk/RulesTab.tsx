// A trunk's Rules (§13.2): every translation rule (and, on customer trunks, HLR rule) that
// runs on the trunk, where it comes from (this trunk, its enterprise, its category or all
// trunks) and its order. Order, on/off and "continue" belong to this trunk only; a rule
// attached directly can be detached here, inherited ones are changed on the rule itself. Rows are dragged to reorder
// and the two kinds sit side by side (team trial round 4).
import { useEffect, useState } from "react";
import type { TrunkRule, TrunkRulesInput } from "@sms/contract";
import { useSaveTrunkRules, useTrunkRules, type TrunkKind } from "../../api/records";
import { testTrunkRules } from "../../api/switchRules";
import { useNotifySaved } from "../../history/undo";
import { HeaderAction, type SectionProps } from "../../records/parts";
import { toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button } from "../../ui/primitives";
import { TranslationTest } from "../switch/TranslationTest";
import { useDragOrder } from "../../records/dragOrder";

interface Row extends TrunkRule {
  detach: boolean;
}

const SOURCE_LABEL = { trunk: "Direct", enterprise: "Enterprise", category: "Category", all: "All trunks" } as const;

function RuleTable({
  title,
  rows,
  onChange,
  withContinue,
  disabled,
}: {
  title: string;
  rows: Row[];
  onChange: (rows: Row[]) => void;
  withContinue: boolean;
  disabled: boolean;
}) {
  // Drag a row by its handle to reorder (team trial round 4); Alt+↑ / Alt+↓ on a focused row.
  const { rowProps } = useDragOrder(rows, onChange, disabled);
  const patch = (i: number, p: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <section className="fsection rules-card">
      <header>
        <h2>{title}</h2>
        <span className="muted small">
          Run top to bottom · {rows.filter((r) => !r.detach).length} rules
          {rows.length > 1 && !disabled ? " · drag to reorder" : ""}
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="muted">No rules reach this trunk.</p>
      ) : (
        <table className="rtable rules-order">
          <thead>
            <tr>
              <th aria-label="Drag" />
              <th className="num">#</th>
              <th>Rule</th>
              <th>On</th>
              {withContinue && <th title="Run the next rule after this one matches">Continue</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const drag = rowProps(i);
              return (
                <tr
                  key={r.ruleId}
                  {...drag}
                  className={`${!r.enabled || !r.ruleActive || r.detach ? "off" : ""} ${drag.className ?? ""}`.trim()}
                  aria-label={`${i + 1}. ${r.name}`}
                >
                  <td className="drag-handle" title={disabled ? undefined : "Drag to reorder (or Alt+↑ / Alt+↓)"}>
                    {!disabled && <span aria-hidden="true">⠿</span>}
                  </td>
                  <td className="num">{i + 1}</td>
                  <td>
                    <div className="rule-cell">
                      <span className="strong">{r.name}</span>
                      <span className={`tag${r.source.type === "trunk" ? " tag-accent" : ""}`}>
                        {SOURCE_LABEL[r.source.type]}
                      </span>
                      {r.source.type !== "trunk" && <span className="muted small">{r.source.label}</span>}
                      {!r.ruleActive && <span className="tag">Rule inactive</span>}
                      {r.detach && <span className="tag">Detach on save</span>}
                    </div>
                    {r.detail && <div className="muted small rule-detail">{r.detail}</div>}
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Run ${r.name} on this trunk`}
                      checked={r.enabled}
                      disabled={disabled || r.detach}
                      onChange={(e) => patch(i, { enabled: e.target.checked })}
                    />
                  </td>
                  {withContinue && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Continue after ${r.name}`}
                        checked={r.continueAfter}
                        disabled={disabled || r.detach}
                        onChange={(e) => patch(i, { continueAfter: e.target.checked })}
                      />
                    </td>
                  )}
                  <td className="actions">
                    {r.source.type === "trunk" && (
                      <Button
                        small
                        variant="ghost"
                        icon={r.detach ? "undo" : "x"}
                        disabled={disabled}
                        title={r.detach ? "Keep the rule on this trunk" : "Remove the rule's direct link to this trunk"}
                        onClick={() => patch(i, { detach: !r.detach })}
                      >
                        {r.detach ? "Keep" : "Detach"}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

const toRows = (rules: TrunkRule[]): Row[] => rules.map((r) => ({ ...r, detach: false }));
const signature = (rows: Row[]) => JSON.stringify(rows.map((r) => [r.ruleId, r.enabled, r.continueAfter, r.detach]));

export function RulesTab({
  kind,
  id,
  archived,
  slot,
  onDirty,
}: SectionProps & { kind: TrunkKind; id: number; archived: boolean }) {
  const q = useTrunkRules(kind, id);
  const save = useSaveTrunkRules(kind, id);
  const notifySaved = useNotifySaved();
  const [translation, setTranslation] = useState<Row[]>([]);
  const [hlr, setHlr] = useState<Row[]>([]);
  const [base, setBase] = useState("");
  useEffect(() => {
    if (!q.data) return;
    const t = toRows(q.data.translation);
    const h = toRows(q.data.hlr);
    setTranslation(t);
    setHlr(h);
    setBase(signature(t) + signature(h));
  }, [q.data]);
  const dirty = !!base && signature(translation) + signature(hlr) !== base;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const submit = () => {
    const keep = (rows: Row[]) => rows.filter((r) => !r.detach);
    const body: TrunkRulesInput = {
      translation: keep(translation).map((r) => ({
        ruleId: r.ruleId,
        enabled: r.enabled,
        continueAfter: r.continueAfter,
      })),
      detachTranslationRuleIds: translation.filter((r) => r.detach).map((r) => r.ruleId),
      ...(kind === "customer"
        ? {
            hlr: keep(hlr).map((r) => ({ ruleId: r.ruleId, enabled: r.enabled })),
            detachHlrRuleIds: hlr.filter((r) => r.detach).map((r) => r.ruleId),
          }
        : {}),
    };
    save.mutate(body, {
      onSuccess: (r) =>
        r.change ? notifySaved(r.change, "Rules saved") : toast({ tone: "info", message: "Nothing changed" }),
      onError: (e) => toast({ tone: "error", message: (e as Error).message }),
    });
  };

  if (q.isError) return <p className="error-text">{(q.error as Error).message}</p>;
  if (!q.data) return <p className="muted">Loading…</p>;
  return (
    <>
      <HeaderAction slot={slot}>
        <Button variant="primary" icon="save" disabled={archived || !dirty || save.isPending} onClick={submit}>
          Save rules
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            onClick={() => q.data && (setTranslation(toRows(q.data.translation)), setHlr(toRows(q.data.hlr)))}
          >
            Discard
          </Button>
        )}
      </HeaderAction>
      <p className="muted small">
        <Icon name="route" size={13} /> Rules reach a trunk through what they apply to (§13.2). Order and on/off here
        change this trunk only; to change where an inherited rule applies, edit the rule.
      </p>
      {/* Translation and HLR rules side by side (team trial round 4); vendor trunks have translation rules only. */}
      <div className={`rules-split${kind === "customer" ? " two" : ""}`}>
        <RuleTable
          title="Translation rules"
          rows={translation}
          onChange={setTranslation}
          withContinue
          disabled={archived}
        />
        {kind === "customer" && (
          <RuleTable title="HLR rules" rows={hlr} onChange={setHlr} withContinue={false} disabled={archived} />
        )}
      </div>
      <section className="fsection">
        <header>
          <h2>Test</h2>
          <span className="muted small">
            A sample message through this trunk&apos;s rules{kind === "customer" ? " and HLR rules" : ""} (§13.2)
          </span>
        </header>
        <TranslationTest
          run={(m) => testTrunkRules(kind, id, m)}
          note={dirty ? "Runs the saved order: save the rules first to test your changes." : undefined}
        />
      </section>
    </>
  );
}
