// Enterprise Rules tab (team trial round 4, §13.2): the translation rules (and HLR rules on customer trunks) that
// run on the enterprise's trunks, in one merged order. Drag to reorder; Save sets that order on every trunk of the
// kind as one undoable change (§13.10). A trunk can still change its own order on its Rules tab afterwards.
import { useEffect, useState } from "react";
import type { EnterpriseDetail, EnterpriseRule } from "@sms/contract";
import { useEnterpriseRules, useSaveEnterpriseRules, type TrunkKind } from "../../api/records";
import { useNotifySaved } from "../../history/undo";
import { useDragOrder } from "../../records/dragOrder";
import { HeaderAction, type SectionProps } from "../../records/parts";
import { toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button } from "../../ui/primitives";

const SOURCE_LABEL = { trunk: "Direct", enterprise: "Enterprise", category: "Category", all: "All trunks" } as const;

function OrderCard({
  title,
  rows,
  trunkCount,
  onChange,
}: {
  title: string;
  rows: EnterpriseRule[];
  trunkCount: number;
  onChange: (rows: EnterpriseRule[]) => void;
}) {
  const { rowProps } = useDragOrder(rows, onChange);
  return (
    <section className="fsection rules-card">
      <header>
        <h2>{title}</h2>
        <span className="muted small">
          Run top to bottom · {rows.length} rules{rows.length > 1 ? " · drag to reorder" : ""}
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="muted">No rules run on these trunks.</p>
      ) : (
        <table className="rtable rules-order">
          <thead>
            <tr>
              <th aria-label="Drag" />
              <th className="num">#</th>
              <th>Rule</th>
              <th className="num" title="How many of the enterprise's trunks the rule runs on">
                Trunks
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.ruleId} {...rowProps(i)} aria-label={`${i + 1}. ${r.name}`}>
                <td className="drag-handle" title="Drag to reorder (or Alt+↑ / Alt+↓)">
                  <span aria-hidden="true">⠿</span>
                </td>
                <td className="num">{i + 1}</td>
                <td>
                  <div className="rule-cell">
                    <span className="strong">{r.name}</span>
                    <span className={`tag${r.source.type === "enterprise" ? " tag-accent" : ""}`}>
                      {SOURCE_LABEL[r.source.type]}
                    </span>
                    <span className="muted small">{r.source.label}</span>
                    {!r.ruleActive && <span className="tag">Rule inactive</span>}
                  </div>
                  {r.detail && <div className="muted small rule-detail">{r.detail}</div>}
                </td>
                <td className="num">
                  {r.trunks}/{trunkCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const ids = (rows: EnterpriseRule[]) => rows.map((r) => r.ruleId);

export function EnterpriseRulesTab({ enterprise, slot, onDirty }: SectionProps & { enterprise: EnterpriseDetail }) {
  const kinds: TrunkKind[] =
    enterprise.type === "customer" ? ["customer"] : enterprise.type === "vendor" ? ["vendor"] : ["customer", "vendor"];
  // A bilateral partner opens on the side that has trunks.
  const [kind, setKind] = useState<TrunkKind>(kinds.find((k) => enterprise.trunkCounts[k] > 0) ?? kinds[0]!);
  const q = useEnterpriseRules(enterprise.id, kind);
  const save = useSaveEnterpriseRules(enterprise.id);
  const notifySaved = useNotifySaved();
  const [translation, setTranslation] = useState<EnterpriseRule[]>([]);
  const [hlr, setHlr] = useState<EnterpriseRule[]>([]);
  useEffect(() => {
    if (!q.data) return;
    setTranslation(q.data.translation);
    setHlr(q.data.hlr);
  }, [q.data]);
  const dirty =
    !!q.data &&
    (JSON.stringify(ids(translation)) !== JSON.stringify(ids(q.data.translation)) ||
      JSON.stringify(ids(hlr)) !== JSON.stringify(ids(q.data.hlr)));
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const submit = () =>
    save.mutate(
      { kind, translationRuleIds: ids(translation), ...(kind === "customer" ? { hlrRuleIds: ids(hlr) } : {}) },
      {
        onSuccess: (r) =>
          r.change
            ? notifySaved(r.change, `Rule order saved on ${q.data?.trunkCount ?? 0} trunks`)
            : toast({ tone: "info", message: "Nothing changed" }),
        onError: (e) => toast({ tone: "error", message: (e as Error).message }),
      },
    );

  return (
    <>
      <HeaderAction slot={slot}>
        {dirty && (
          <Button variant="ghost" onClick={() => q.data && (setTranslation(q.data.translation), setHlr(q.data.hlr))}>
            Discard
          </Button>
        )}
        <Button variant="primary" icon="save" disabled={!dirty || save.isPending} onClick={submit}>
          Save order
        </Button>
      </HeaderAction>
      <div className="rules-top">
        <p className="muted small">
          <Icon name="route" size={13} /> The rules that run on this enterprise&apos;s{" "}
          {kind === "customer" ? "customer" : "vendor"} trunks
          {q.data ? ` (${q.data.trunkCount})` : ""}. Saving sets this order on every one of them; a trunk can still
          change its own order on its Rules tab.
        </p>
        {kinds.length > 1 && (
          <div className="segmented" role="tablist" aria-label="Trunks">
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                className={kind === k ? "on" : ""}
                disabled={dirty && kind !== k}
                title={dirty && kind !== k ? "Save or discard the order first" : undefined}
                onClick={() => setKind(k)}
              >
                {k === "customer" ? "Customer trunks" : "Vendor trunks"}
              </button>
            ))}
          </div>
        )}
      </div>
      {q.isError ? (
        <p className="error-text">{(q.error as Error).message}</p>
      ) : !q.data ? (
        <p className="muted">Loading…</p>
      ) : q.data.trunkCount === 0 ? (
        <p className="muted">This enterprise has no {kind} trunks yet.</p>
      ) : (
        <div className={`rules-split${kind === "customer" ? " two" : ""}`}>
          <OrderCard
            title="Translation rules"
            rows={translation}
            trunkCount={q.data.trunkCount}
            onChange={setTranslation}
          />
          {kind === "customer" && (
            <OrderCard title="HLR rules" rows={hlr} trunkCount={q.data.trunkCount} onChange={setHlr} />
          )}
        </div>
      )}
    </>
  );
}
