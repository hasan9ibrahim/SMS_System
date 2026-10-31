// Customer or vendor trunk record (§5.4, §5.5) in its own tab: General form, Rules (§13.2)
// and History (§13.10). New trunks open from an enterprise (?enterprise=ID) or as a clone
// of another trunk (?clone=ID: everything copied except name, username and password).
import { useCan, useTabShown } from "../../api/access";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { Enterprise, TrunkListRow } from "@sms/contract";
import { fetchListPage } from "../../api/hooks";
import {
  useEnterpriseName,
  useReference,
  useSaveTrunk,
  useTrunk,
  type TrunkDetail,
  type TrunkKind,
} from "../../api/records";
import { FormBanner, FormField, useForm } from "../../form/form";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { Avatar, PageHeader } from "../../page/PageHeader";
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
import { Button, StatusPill } from "../../ui/primitives";
import { RateTableView } from "../rates/RateTableView";
import { RulesTab } from "./RulesTab";
import {
  CustomerTrunkFields,
  VendorTrunkFields,
  blankTrunk,
  checkTrunk,
  fillService,
  toTrunkForm,
  type TrunkForm,
} from "./TrunkForms";

const SECTIONS = ["general", "rates", "rules", "history"] as const;
const LABEL = { customer: "Customer trunk", vendor: "Vendor trunk" } as const;

/** The trunk's live connection, from its list row (the record has no live state). */
function useTrunkConnection(kind: TrunkKind, id: number | null) {
  const q = useQuery({
    queryKey: ["list", `${kind}_trunks`, "connection", id],
    queryFn: () =>
      fetchListPage<TrunkListRow>(kind === "customer" ? "customer_trunks" : "vendor_trunks", {
        filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: id! }] },
        limit: 1,
        withTotal: false,
      }),
    enabled: id !== null,
    refetchInterval: 30_000,
  });
  return q.data?.rows[0]?.connection ?? null;
}

function GeneralSection({
  kind,
  record,
  seed,
  slot,
  onDirty,
  connection,
  lockedEnterprise = false,
}: {
  kind: TrunkKind;
  record: TrunkDetail | null;
  seed: TrunkForm;
  slot: HTMLElement | null;
  onDirty: (d: boolean) => void;
  connection: TrunkListRow["connection"] | null;
  /** Added from an enterprise's page: the trunk belongs to it (team trial round 12). */
  lockedEnterprise?: boolean;
}) {
  const isNew = record === null;
  const form = useForm<TrunkForm>(seed);
  const save = useSaveTrunk(kind);
  const notifySaved = useNotifySaved();
  const navigate = useTabNavigate();
  const [banner, setBanner] = useState<string | null>(null);
  const enterprise = useEnterpriseName(form.values.enterpriseId || null);
  const readOnly = !!record?.archived;

  const version = record ? `${record.id}:${record.updatedAt}:${record.archived?.at ?? ""}` : "new";
  useEffect(() => {
    if (record && !form.dirty) form.reset({ ...toTrunkForm(record), password: "" });
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onDirty(form.dirty), [form.dirty, onDirty]);

  const submit = () => {
    const values = fillService(kind, form.values, isNew);
    // The trunk's own rules, plus every field's limits and each host IP, all at once (functional QA round 13).
    const errors = form.check(checkTrunk(kind, values, isNew));
    if (Object.keys(errors).length) {
      setBanner(`Check the highlighted fields (${Object.keys(errors).length})`);
      return;
    }
    setBanner(null);
    const input = { ...values };
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
      <fieldset disabled={readOnly} className="plain-fieldset form-main">
        {/* Enterprise, trunk ID and buy table as three small cards (record redesign, team trial round 4). */}
        <section className="info-cards">
          <div className="info-card-grid">
            <FormField
              label="Enterprise"
              required
              error={form.error("enterpriseId")}
              hint={
                isNew ? (lockedEnterprise ? "Added from this enterprise" : undefined) : "Clone the trunk to move it"
              }
            >
              {isNew && lockedEnterprise ? (
                <div className="ff-readonly strong">
                  {enterprise.data ? enterpriseLabel(enterprise.data) : `Enterprise ${form.values.enterpriseId}`}
                </div>
              ) : isNew ? (
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
              <FormField label="Buy rate table">
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
          <CustomerTrunkFields
            form={form}
            isNew={isNew}
            passwordSet={record?.passwordSet ?? false}
            trunkId={record?.id ?? null}
          />
        ) : (
          <VendorTrunkFields
            form={form}
            isNew={isNew}
            passwordSet={record?.passwordSet ?? false}
            connected={connection ? connection === "up" : null}
            trunkId={record?.id ?? null}
          />
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
  const connection = useTrunkConnection(kind, t?.id ?? null);
  const [section, setSection] = useSectionTab(SECTIONS);
  const shownTab = useTabShown();
  const canRates = useCan("rate-manager");
  // A hidden tab opened from a link falls back to General (§11, trial round 2).
  const hiddenSection = section !== "general" && !shownTab(`${kind}-trunks.${section}`);
  useEffect(() => {
    if (hiddenSection) setSection("general");
  }, [hiddenSection, setSection]);
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
        <PageHeader page={page} title={`${LABEL[kind]} ${raw}`} helpTopic="trunk-record" />
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
        <PageHeader page={page} title={LABEL[kind]} helpTopic="trunk-record" />
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
        helpTopic="trunk-record"
        page={page}
        title={title}
        // Record header (team trial round 4): breadcrumb through the enterprise, a tile, chips with the live bind.
        crumbs={[
          { label: "Enterprises", path: "/enterprises" },
          ...(t ? [{ label: t.enterpriseName, path: `/enterprises/${t.enterpriseId}` }] : []),
          { label: `${LABEL[kind]}s`, path: `/enterprises/${kind}-trunks` },
          { label: t ? t.name : title },
        ]}
        avatar={<Avatar name={title} icon={<Icon name={kind === "vendor" ? "arrowUpRight" : "arrowDownLeft"} />} />}
        meta={
          t && (
            <>
              <span className={`chip-tag ${kind === "vendor" ? "amber" : "blue"}`}>{LABEL[kind]}</span>
              {connection && (
                <span
                  className={`chip-tag ${connection === "up" ? "green" : connection === "reconnecting" ? "amber" : ""}`}
                >
                  <span className="dot-mini" />
                  {connection === "up" ? "Connected" : connection === "reconnecting" ? "Reconnecting" : "Down"}
                </span>
              )}
              <span className="chip-tag">{t.protocol.toUpperCase()}</span>
              <span className="chip-tag">{t.tps.toLocaleString("en-US")} TPS</span>
              <StatusPill active={t.status === "active"} />
            </>
          )
        }
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
      {t && <ArchivedBanner kind={kind} id={t.id} archived={t.archived} what="trunk" />}
      <SectionTabs
        tabs={[
          { key: "general", label: "General" },
          // The vendor trunk's own rate table is a Rate manager table: only with Rate manager (backend step 10).
          ...(kind === "vendor" && canRates ? [{ key: "rates", label: "Rates", disabled: !t?.ownRateTableId }] : []),
          { key: "rules", label: "Rules", disabled: !t },
          { key: "history", label: "History", disabled: !t },
        ].filter((x) => shownTab(`${kind}-trunks.${x.key}`))}
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
              connection={connection}
              lockedEnterprise={!t && !cloneOf && presetEnterprise > 0}
            />
          </div>
        )}
        {/* The vendor trunk's own buy rates, edited here as in Rate manager (team trial round 1). */}
        {t && kind === "vendor" && canRates && t.ownRateTableId && visited.has("rates") && (
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
