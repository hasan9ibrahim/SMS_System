// HLR rules (§6.5) assigned straight to customer trunks (§13.2, §13.24): provider + DNID
// pattern + Applies To, saved in one form so the rule runs at once. A trunk checks its HLR rules
// top to bottom (trunk Rules tab) and the first DNID match decides which provider is asked.
import { useState } from "react";
import type {
  Enterprise,
  HlrProviderRow,
  HlrRuleDetail,
  HlrRuleInput,
  HlrRuleRow,
  HlrTargetInput,
  ProductCategory,
  TrunkListRow,
} from "@sms/contract";
import { useHlrRule, useHlrRuleUsedBy, useSaveHlrRule } from "../../../api/hlr";
import { useMe } from "../../../api/hooks";
import { useRestore } from "../../../api/records";
import { FormField, Section, SelectField, TextField, useForm } from "../../../form/form";
import { HistoryList, useNotifySaved } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { isAdminUser, ListLookup, useDeleteRecord } from "../../../records/parts";
import { useTabNavigate } from "../../../shell/tabContext";
import { ask, confirmDialog, toast } from "../../../ui/feedback";
import { HoverList } from "../../../ui/HoverList";
import { Button, Modal } from "../../../ui/primitives";
import { fmtWhen, RecordActions } from "../../reference/shared";
import { problemText } from "../../routing/dialogs";
import { MultiPick } from "../../routing/pickers";
import { useHlrNav, ViewSwitch } from "./HlrPage";
import { blankHlrRule, dnidPreview, hlrRuleInput, providerTypeLabel } from "./hlrModel";
import { CleanupBadge } from "../../admin/cleanup/CleanupBadge";

const page = pageForPath("/switch/hlr")!;
const muted = (v: string) => <span className="muted">{v}</span>;
type TargetType = HlrTargetInput["type"];
const tkey = (t: HlrTargetInput) => `${t.type}:${t.id ?? ""}`;

/** Applies To for customer trunks: trunks, enterprises, categories or all of them (§13.24). */
function HlrTargets({
  value,
  labels,
  onChange,
}: {
  value: HlrTargetInput[];
  labels: Map<string, string>;
  onChange: (v: HlrTargetInput[]) => void;
}) {
  const [type, setType] = useState<Exclude<TargetType, "all">>("trunk");
  const [names, setNames] = useState(labels);
  const allOn = value.some((t) => t.type === "all");
  const picked = (t: TargetType) =>
    value.filter((v) => v.type === t).map((v) => ({ key: v.id!, label: names.get(tkey(v)) ?? `#${v.id}` }));
  const replace = (t: TargetType, next: { key: number; label: string }[]) => {
    const n = new Map(names);
    for (const p of next) n.set(tkey({ type: t, id: p.key }), p.label);
    setNames(n);
    onChange([...value.filter((v) => v.type !== t), ...next.map((p) => ({ type: t, id: p.key }))]);
  };
  return (
    <div className="targets">
      <label className="toggle-inline">
        <input
          type="checkbox"
          checked={allOn}
          onChange={(e) =>
            onChange(e.target.checked ? [...value, { type: "all", id: null }] : value.filter((v) => v.type !== "all"))
          }
        />
        All customer trunks
      </label>
      {!allOn && (
        <>
          <div className="segmented small" role="radiogroup" aria-label="Target type">
            {(
              [
                ["trunk", "Customer trunks"],
                ["enterprise", "Enterprises"],
                ["category", "Product categories"],
              ] as const
            ).map(([t, l]) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={type === t}
                className={type === t ? "on" : ""}
                onClick={() => setType(t)}
              >
                {l} {picked(t).length > 0 && <span className="num">({picked(t).length})</span>}
              </button>
            ))}
          </div>
          {type === "trunk" && (
            <MultiPick<TrunkListRow, number>
              list="customer_trunks"
              value={picked("trunk")}
              onChange={(p) => replace("trunk", p)}
              toPicked={(r) => ({ key: r.id, label: r.name })}
              detailOf={(r) => r.enterpriseName}
              placeholder="Trunk name or enterprise…"
            />
          )}
          {type === "enterprise" && (
            <MultiPick<Enterprise, number>
              list="enterprises"
              value={picked("enterprise")}
              onChange={(p) => replace("enterprise", p)}
              toPicked={(r) => ({ key: r.id, label: r.name })}
              detailOf={(r) => r.alias}
              placeholder="Enterprise name or alias…"
            />
          )}
          {type === "category" && (
            <MultiPick<ProductCategory, number>
              list="product_categories"
              value={picked("category")}
              onChange={(p) => replace("category", p)}
              toPicked={(r) => ({ key: r.id, label: r.name })}
              placeholder="Product category…"
            />
          )}
        </>
      )}
      {value.length === 0 && <p className="muted small">Not assigned: the rule runs on no trunk.</p>}
    </div>
  );
}

function RuleEditor({ detail, done }: { detail: HlrRuleDetail | null; done: (id: number | null) => void }) {
  const form = useForm<HlrRuleInput>(detail ? hlrRuleInput(detail) : blankHlrRule());
  const save = useSaveHlrRule();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState("");
  const v = form.values;
  const labels = new Map((detail?.targets ?? []).map((t) => [tkey(t), t.label]));
  const preview = dnidPreview(v.dnidPattern, sample);
  const submit = async () => {
    if (!v.providerId) return setError("Choose the provider.");
    if (detail && detail.usedBy > 1) {
      const ok = await confirmDialog({
        title: "Save a shared rule?",
        message: (
          <p>
            <strong>{detail.name}</strong> runs on <strong>{detail.usedBy} customer trunks</strong>. Saving changes it
            on all of them.
          </p>
        ),
        ok: `Save on ${detail.usedBy} trunks`,
      });
      if (!ok) return;
    }
    save.mutate(
      { id: detail?.id ?? null, input: { ...v, name: v.name.trim() } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `${detail ? "Saved" : "Added"} ${r.record.name}`);
          else toast({ tone: "info", message: "Nothing changed" });
          done(r.record.id);
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  };
  return (
    <Modal
      title={detail ? `Edit HLR rule · ${detail.name}` : "Add HLR rule"}
      width={860}
      onClose={() => done(null)}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" icon="save" disabled={save.isPending} onClick={() => void submit()}>
            {detail ? "Save" : "Add rule"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Section title="Rule" columns={3}>
          <TextField form={form} path="name" label="Rule Name" required wide maxLength={100} nullable={false} />
          <FormField label="Provider Name" required error={form.error("providerId")}>
            <ListLookup<HlrProviderRow>
              list="hlr_providers"
              value={v.providerId || null}
              onChange={(p) => form.set("providerId", p?.id ?? 0)}
              labelOf={(p) => p.name}
              detailOf={(p) => `${providerTypeLabel(p.providerType)} · ${p.status}`}
              placeholder="Live HLR, MNP or number check…"
              clearable={false}
            />
          </FormField>
          <TextField
            form={form}
            path="dnidPattern"
            label="DNID Pattern"
            required
            maxLength={200}
            nullable={false}
            hint="Regex on the receiver, e.g. ^44"
          />
          <FormField label="Try a number">
            <span className="input-suffix">
              <input value={sample} placeholder="447700900123" onChange={(e) => setSample(e.target.value.trim())} />
              {sample && (
                <span className={preview === "match" ? "tone-good" : preview === "invalid" ? "tone-error" : "muted"}>
                  {preview === "match" ? "matches" : preview === "invalid" ? "invalid pattern" : "no match"}
                </span>
              )}
            </span>
          </FormField>
          <SelectField
            form={form}
            path="status"
            label="Status"
            required
            options={[
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
            ]}
          />
          <SelectField
            form={form}
            path="insertAt"
            label="Position on trunks"
            required
            options={[
              { value: "bottom", label: "After the ordered rules" },
              { value: "top", label: "Before the ordered rules" },
            ]}
          />
        </Section>
        <Section title="Applies to" columns={1}>
          <FormField label="Targets" wide error={form.error("targets")}>
            <HlrTargets value={v.targets} labels={labels} onChange={(t) => form.set("targets", t)} />
          </FormField>
        </Section>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function EditLoader({ id, done }: { id: number; done: (id: number | null) => void }) {
  const q = useHlrRule(id);
  if (q.data) return <RuleEditor detail={q.data} done={done} />;
  return (
    <Modal title="Loading rule…" onClose={() => done(null)} width={360}>
      <p className={q.isError ? "error-text" : "muted"}>{q.isError ? problemText(q.error) : "Loading…"}</p>
    </Modal>
  );
}

const openEditor = (id: number | null) =>
  ask<number>((done) => (id === null ? <RuleEditor detail={null} done={done} /> : <EditLoader id={id} done={done} />));

function RuleDetail({ row }: { row: HlrRuleRow }) {
  const q = useHlrRule(row.id);
  const { go } = useHlrNav();
  const d = q.data;
  if (!d) return <p className="muted">{q.isError ? problemText(q.error) : "Loading…"}</p>;
  return (
    <div className="tr-detail">
      <div className="detail-actions">
        {!d.archivedAt && (
          <Button small icon="file" onClick={() => void openEditor(d.id)}>
            Edit
          </Button>
        )}
        <RecordActions kind="hlr_rule" id={d.id} name={`rule ${d.name}`} archived={!!d.archivedAt} />
      </div>
      <dl className="kv">
        <dt>Provider</dt>
        <dd>
          <button type="button" className="link" onClick={() => go("providers")}>
            {d.providerName}
          </button>{" "}
          <span className="muted small">{providerTypeLabel(row.providerType)}</span>
        </dd>
        <dt>DNID pattern</dt>
        <dd>
          <code>{d.dnidPattern}</code>
        </dd>
        <dt>Applies to</dt>
        <dd>{d.targets.length ? d.targets.map((t) => t.label).join(", ") : muted("Not assigned")}</dd>
        <dt>Status</dt>
        <dd>
          {d.status === "active" ? "Active" : "Inactive"} · runs {d.insertAt === "top" ? "before" : "after"} the ordered
          rules on trunks that have not ordered it
        </dd>
        <dt>Updated</dt>
        <dd>
          {d.updatedBy ?? "seed data"} · {fmtWhen(d.updatedAt)}
        </dd>
      </dl>
    </div>
  );
}

function UsedBy({ id }: { id: number }) {
  const q = useHlrRuleUsedBy(id);
  const navigate = useTabNavigate();
  if (q.isPending) return <p className="muted">Loading…</p>;
  if (q.isError) return <p className="error-text">{problemText(q.error)}</p>;
  if (!q.data.trunks.length) return <p className="muted">No live customer trunk is reached by the targets.</p>;
  return (
    <table className="mini-table">
      <thead>
        <tr>
          <th>Customer trunk</th>
          <th>Enterprise</th>
          <th>Through</th>
          <th>On</th>
        </tr>
      </thead>
      <tbody>
        {q.data.trunks.slice(0, 200).map((t) => (
          <tr key={t.id} className={t.enabled ? "" : "off"}>
            <td>
              <button
                type="button"
                className="link"
                onClick={() => navigate(`/enterprises/customer-trunks/${t.id}?tab=rules`)}
              >
                {t.name}
              </button>
            </td>
            <td>{t.enterpriseName}</td>
            <td className="muted">{t.via === "all" ? "all trunks" : t.via}</td>
            <td>{t.enabled ? "Yes" : muted("Off here")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RulesView() {
  const [selectId, setSelectId] = useState<number | null>(null);
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const deleteOne = useDeleteRecord();
  const restore = useRestore("hlr_rule");
  const notifySaved = useNotifySaved();
  return (
    <ListScreen<HlrRuleRow>
      list="hlr_rules"
      page={page}
      title="HLR · Rules"
      selectId={selectId}
      historyScope={{ entityTypes: ["hlr_rule"] }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted rules cannot be edited" : undefined,
          onSelect: () => void openEditor(r.id).then((id) => id && setSelectId(id)),
        },
        "separator",
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !admin || restore.isPending,
              hint: admin ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (res) => res.change && notifySaved(res.change, `Restored rule ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete…",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("hlr_rule", r.id, `rule ${r.name}`),
            },
      ]}
      actions={<CleanupBadge kinds={["hlr_rule_unassigned"]} />}
      primary={{
        label: "Add rule",
        icon: "plus",
        onClick: () => void openEditor(null).then((id) => id && setSelectId(id)),
      }}
      above={<ViewSwitch />}
      columns={{
        id: { width: 60 },
        name: { width: 280, render: (r) => <strong>{r.name}</strong> },
        provider: { width: 190 },
        providerType: { width: 120, render: (r) => providerTypeLabel(r.providerType) },
        dnidPattern: { width: 130, render: (r) => <code>{r.dnidPattern}</code> },
        status: { width: 90, render: (r) => (r.status === "active" ? "Active" : muted("Inactive")) },
        appliesTo: {
          width: 200,
          render: (r) =>
            r.appliesTo === "Not assigned" ? (
              <span className="tone-warning">Not assigned</span>
            ) : (
              <HoverList items={r.appliesToNames} more={r.appliesToCount - r.appliesToNames.length}>
                <span className="rr-label">
                  <span className="rr-main">{r.appliesTo}</span>
                </span>
              </HoverList>
            ),
        },
        usedBy: { width: 90, align: "right" },
        updatedBy: { width: 140, render: (r) => r.updatedBy ?? muted("—") },
      }}
      rowClass={(r) => (r.status === "inactive" ? "row-muted" : undefined)}
      onOpen={(r) => !r.archivedAt && void openEditor(r.id).then((id) => id && setSelectId(id))}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              #{r.id} · {r.provider} · {r.usedBy} trunk{r.usedBy === 1 ? "" : "s"}
            </span>
          </>
        ),
        sections: [
          { key: "rule", label: "Rule", content: <RuleDetail row={r} /> },
          { key: "used-by", label: `Used by (${r.usedBy})`, content: <UsedBy id={r.id} /> },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["hlr_rule"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
