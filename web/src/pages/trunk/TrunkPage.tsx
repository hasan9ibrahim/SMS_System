// Customer or vendor trunk record (§5.4, §5.5) in its own tab: General form, Rules (§13.2)
// and History (§13.10). New trunks open from an enterprise (?enterprise=ID) or as a clone
// of another trunk (?clone=ID: everything copied except name, username and password).
import { useCallback, useEffect, useState } from "react";
import { useLocation, useParams } from "react-router";
import type { Enterprise } from "@sms/contract";
import {
  useEnterprise,
  useReference,
  useSaveTrunk,
  useTrunk,
  type TrunkDetail,
  type TrunkKind,
} from "../../api/records";
import { FormBanner, FormField, useForm } from "../../form/form";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import {
  ArchivedBanner,
  EnterprisePicker,
  HeaderAction,
  SectionTabs,
  enterpriseLabel,
  useDeleteRecord,
  useSectionTab,
} from "../../records/parts";
import { usePageStatus, useTabDirty, useTabNavigate, useTabTitle } from "../../shell/tabContext";
import { Icon } from "../../ui/Icon";
import { Button } from "../../ui/primitives";
import { RateTableView } from "../rates/RateTableView";
import { RulesTab } from "./RulesTab";
import {
  CustomerTrunkFields,
  VendorTrunkFields,
  blankTrunk,
  checkTrunk,
  toTrunkForm,
  type TrunkForm,
} from "./TrunkForms";

const SECTIONS = ["general", "rates", "rules", "history"] as const;
const LABEL = { customer: "Customer trunk", vendor: "Vendor trunk" } as const;

function GeneralSection({
  kind,
  record,
  seed,
  slot,
  onDirty,
}: {
  kind: TrunkKind;
  record: TrunkDetail | null;
  seed: TrunkForm;
  slot: HTMLElement | null;
  onDirty: (d: boolean) => void;
}) {
  const isNew = record === null;
  const form = useForm<TrunkForm>(seed);
  const save = useSaveTrunk(kind);
  const notifySaved = useNotifySaved();
  const navigate = useTabNavigate();
  const [banner, setBanner] = useState<string | null>(null);
  const enterprise = useEnterprise(form.values.enterpriseId || null);
  const readOnly = !!record?.archived;

  const version = record ? `${record.id}:${record.updatedAt}:${record.archived?.at ?? ""}` : "new";
  useEffect(() => {
    if (record && !form.dirty) form.reset({ ...toTrunkForm(record), password: "" });
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onDirty(form.dirty), [form.dirty, onDirty]);

  const submit = () => {
    const errors = checkTrunk(kind, form.values, isNew);
    if (Object.keys(errors).length) {
      form.setErrors(errors);
      setBanner(`Check the highlighted fields (${Object.keys(errors).length})`);
      return;
    }
    setBanner(null);
    const input = { ...form.values };
    if (!input.password) delete input.password;
    save.mutate(
      { id: record?.id ?? null, input },
      {
        onSuccess: (r) => {
          form.reset({ ...toTrunkForm(r.record), password: "" });
          if (r.change) notifySaved(r.change, isNew ? `Added ${r.record.name}` : "Saved");
          if (isNew) navigate(`/enterprises/${kind}-trunks/${r.record.id}`, { replace: true });
        },
        onError: (err) => setBanner(form.fail(err)),
      },
    );
  };

  return (
    <>
      <HeaderAction slot={slot}>
        <Button
          variant="primary"
          icon="save"
          disabled={readOnly || save.isPending || (!isNew && !form.dirty)}
          onClick={submit}
        >
          {isNew ? `Add ${LABEL[kind].toLowerCase()}` : "Save"}
        </Button>
        {form.dirty && !isNew && (
          <Button variant="ghost" onClick={() => record && form.reset({ ...toTrunkForm(record), password: "" })}>
            Discard
          </Button>
        )}
      </HeaderAction>
      <FormBanner message={banner} onClose={() => setBanner(null)} />
      <fieldset disabled={readOnly} className="plain-fieldset">
        <section className="fsection">
          <div className="fgrid cols-3">
            <FormField
              label="Enterprise"
              required
              error={form.error("enterpriseId")}
              hint={isNew ? undefined : "A trunk stays with its enterprise; clone it to move it"}
            >
              {isNew ? (
                <EnterprisePicker
                  label={enterprise.data ? enterpriseLabel(enterprise.data) : "Choose an enterprise…"}
                  onPick={(e: Enterprise) => form.set("enterpriseId", e.id)}
                />
              ) : (
                <div className="ff-readonly">
                  <button
                    type="button"
                    className="link"
                    onClick={() => navigate(`/enterprises/${record!.enterpriseId}`, { newTab: true })}
                  >
                    {record!.enterpriseName} ({record!.enterpriseId})
                  </button>
                </div>
              )}
            </FormField>
            {record && (
              <FormField label="Trunk ID">
                <div className="ff-readonly num">{record.id}</div>
              </FormField>
            )}
            {kind === "vendor" && record?.ownRateTableId && (
              <FormField label="Buy rate table" hint="Every vendor trunk owns one (§13.12)">
                <div className="ff-readonly">
                  <button
                    type="button"
                    className="link"
                    onClick={() => navigate(`/rates/manager?table=${record.ownRateTableId}`, { newTab: true })}
                  >
                    Rate table #{record.ownRateTableId}
                  </button>
                </div>
              </FormField>
            )}
          </div>
        </section>
        {kind === "customer" ? (
          <CustomerTrunkFields form={form} isNew={isNew} passwordSet={record?.passwordSet ?? false} />
        ) : (
          <VendorTrunkFields form={form} isNew={isNew} passwordSet={record?.passwordSet ?? false} />
        )}
      </fieldset>
      {record && (
        <p className="muted small">
          Added {record.createdAt?.slice(0, 10) ?? "—"}
          {record.createdBy ? ` by ${record.createdBy}` : ""} · last updated{" "}
          {record.updatedAt.slice(0, 16).replace("T", " ")} UTC by {record.updatedBy}
        </p>
      )}
    </>
  );
}

export function TrunkPage({ kind }: { kind: TrunkKind }) {
  const raw = useParams().id;
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const id = raw === undefined || raw === "new" ? null : Number(raw);
  const cloneOf = id === null && params.get("clone") ? Number(params.get("clone")) : null;
  const presetEnterprise = Number(params.get("enterprise")) || 0;
  const page = pageForPath(`/enterprises/${kind}-trunks`) ?? pageForPath("/enterprises")!;
  const navigate = useTabNavigate();
  const ref = useReference();
  const q = useTrunk(kind, id !== null && Number.isInteger(id) && id > 0 ? id : null);
  const source = useTrunk(kind, cloneOf);
  const t = q.data;
  const [section, setSection] = useSectionTab(SECTIONS);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const deleteRecord = useDeleteRecord();
  const [visited, setVisited] = useState<Set<string>>(() => new Set([section]));
  if (!visited.has(section)) setVisited(new Set([...visited, section]));
  const dirtyFor = useCallback(
    (key: string) => (d: boolean) => setDirty((m) => (m[key] === d ? m : { ...m, [key]: d })),
    [],
  );
  const [onGeneral] = useState(() => dirtyFor("general"));
  const [onRules] = useState(() => dirtyFor("rules"));

  useTabTitle(id === null ? `New ${LABEL[kind].toLowerCase()}` : t ? `${LABEL[kind]} · ${t.name}` : undefined);
  useTabDirty(Object.values(dirty).some(Boolean));
  usePageStatus({ rows: t ? `${LABEL[kind]} ${t.id} · ${t.enterpriseName}` : "" });

  if (q.isError || source.isError) {
    return (
      <div className="page">
        <PageHeader page={page} title={`${LABEL[kind]} ${raw}`} />
        <div className="grid-message error">
          <Icon name="alert" /> {((q.error ?? source.error) as Error).message}
        </div>
      </div>
    );
  }
  const waiting = (id !== null && !t) || (cloneOf !== null && !source.data) || (id === null && !ref.data);
  if (waiting) {
    return (
      <div className="page">
        <PageHeader page={page} title={LABEL[kind]} />
        <div className="grid-message muted">Loading…</div>
      </div>
    );
  }

  // The form's starting values: the record, a clone of another trunk, or a blank new trunk.
  const seed: TrunkForm = t
    ? { ...toTrunkForm(t), password: "" }
    : source.data
      ? { ...toTrunkForm(source.data), name: `${source.data.name}_copy`, username: "", password: "" }
      : blankTrunk(kind, presetEnterprise, kind === "vendor" ? (ref.data?.productCategories[0]?.id ?? null) : null);

  const title = t
    ? t.name
    : cloneOf
      ? `New ${LABEL[kind].toLowerCase()} (clone of #${cloneOf})`
      : `New ${LABEL[kind].toLowerCase()}`;
  return (
    <div className="page record-page">
      <PageHeader
        page={page}
        title={title}
        actions={
          <>
            {t && (
              <Button
                icon="copy"
                onClick={() =>
                  navigate(`/enterprises/${kind}-trunks/new?clone=${t.id}`, {
                    newTab: true,
                    title: `Clone of ${t.name}`,
                  })
                }
              >
                Clone
              </Button>
            )}
            {t && !t.archived && (
              <Button
                icon="trash"
                onClick={async () => {
                  const r = await deleteRecord(kind, t.id, t.name);
                  if (r) setDirty({});
                }}
              >
                Delete
              </Button>
            )}
            <span ref={setSlot} className="action-slot" />
          </>
        }
      />
      {t && (
        <div className="record-meta muted">
          {LABEL[kind]} of {t.enterpriseName} · {t.protocol.toUpperCase()} · {t.tps.toLocaleString("en-US")} TPS ·{" "}
          {t.status === "active" ? "Active" : "Inactive"}
        </div>
      )}
      {t && <ArchivedBanner kind={kind} id={t.id} archived={t.archived} what="trunk" />}
      <SectionTabs
        tabs={[
          { key: "general", label: "General" },
          ...(kind === "vendor" ? [{ key: "rates", label: "Rates", disabled: !t?.ownRateTableId }] : []),
          { key: "rules", label: "Rules", disabled: !t },
          { key: "history", label: "History", disabled: !t },
        ]}
        current={section}
        onChange={setSection}
      />
      <div className="record-body">
        {visited.has("general") && (
          <div hidden={section !== "general"}>
            <GeneralSection
              key={`${id ?? "new"}:${cloneOf ?? ""}`}
              kind={kind}
              record={t ?? null}
              seed={seed}
              slot={section === "general" ? slot : null}
              onDirty={onGeneral}
            />
          </div>
        )}
        {/* The vendor trunk's own buy rates, edited here as in Rate manager (team trial round 1). */}
        {t && kind === "vendor" && t.ownRateTableId && visited.has("rates") && (
          <div hidden={section !== "rates"} className="trunk-rates">
            <RateTableView id={t.ownRateTableId} embedded />
          </div>
        )}
        {t && visited.has("rules") && (
          <div hidden={section !== "rules"}>
            <RulesTab
              kind={kind}
              id={t.id}
              archived={!!t.archived}
              slot={section === "rules" ? slot : null}
              onDirty={onRules}
            />
          </div>
        )}
        {t && section === "history" && (
          <div className="card">
            <HistoryList scope={{ entityTypes: [`${kind}_trunk`], entityId: t.id }} />
          </div>
        )}
      </div>
    </div>
  );
}
