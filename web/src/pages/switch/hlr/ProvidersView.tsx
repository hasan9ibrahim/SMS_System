// HLR providers (§6.5, §13.24): the provider grid with live status and the last 24 hours of
// lookups, success, response time and cost; the provider form (request template, credentials,
// response mapping); and each provider's per-destination prices (?provider=<id>) with Rate,
// Import Rate and Export Rate. The password is write-only (§13.22).
import { useState } from "react";
import type {
  Destination,
  HlrProviderDetail,
  HlrProviderInput,
  HlrProviderRate,
  HlrProviderRow,
  ListQuery,
} from "@sms/contract";
import { useQuery } from "@tanstack/react-query";
import { fetchListPage } from "../../../api/hooks";
import { useDeleteHlrRates, useHlrProvider, useSaveHlrProvider, useSetHlrRate } from "../../../api/hlr";
import { downloadCsv } from "../../../api/masterData";
import { usePlatformCurrency, useReference } from "../../../api/records";
import { FormField, NumberField, Section, SelectField, TextArea, TextField, useForm } from "../../../form/form";
import { HistoryList, useNotifySaved } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { ListLookup } from "../../../records/parts";
import { ask, toast } from "../../../ui/feedback";
import { Button, Modal, StatusDot } from "../../../ui/primitives";
import { fmtWhen, openImport, RecordActions, RecordDialog } from "../../reference/shared";
import { problemText } from "../../routing/dialogs";
import { useHlrNav, ViewSwitch } from "./HlrPage";
import { blankProvider, LIVE, MAPPING_FIELDS, PROVIDER_TYPES, providerInput, providerTypeLabel } from "./hlrModel";
import { destLabel } from "../../rates/DestinationTree";

const page = pageForPath("/switch/hlr")!;
const muted = (v: string) => <span className="muted">{v}</span>;
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} %`);

// ---------------------------------------------------------------- provider form

function ProviderEditor({ detail, done }: { detail: HlrProviderDetail | null; done: (id: number | null) => void }) {
  const form = useForm<HlrProviderInput>(detail ? providerInput(detail) : blankProvider());
  const save = useSaveHlrProvider();
  const notifySaved = useNotifySaved();
  const currencies = useReference().data?.currencies ?? [];
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    save.mutate(
      { id: detail?.id ?? null, input: { ...form.values, name: form.values.name.trim() } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `${detail ? "Saved" : "Added"} ${r.record.name}`);
          else toast({ tone: "info", message: "Nothing changed" });
          done(r.record.id);
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  return (
    <Modal
      title={detail ? `Edit HLR provider · ${detail.name}` : "Add HLR provider"}
      width={980}
      onClose={() => done(null)}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" icon="save" disabled={save.isPending} onClick={submit}>
            {detail ? "Save" : "Add provider"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Section title="Provider" columns={4}>
          <TextField form={form} path="name" label="Provider Name" required wide maxLength={100} nullable={false} />
          <SelectField form={form} path="providerType" label="Type" required options={PROVIDER_TYPES} />
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
            path="currency"
            label="Currency"
            required
            options={currencies.map((c) => ({ value: c.iso, label: c.iso }))}
          />
          <NumberField
            form={form}
            path="defaultRate"
            label="Default Rate"
            required
            min={0}
            max={1}
            step={0.000001}
            hint="Per live lookup, where a destination has no price"
          />
          <NumberField
            form={form}
            path="cacheDays"
            label="Enable Caching"
            required
            min={0}
            max={7}
            step={1}
            suffix="days"
            hint="0 = no cache; a policy can set its own"
          />
          <NumberField
            form={form}
            path="timeoutMs"
            label="Timeout"
            required
            min={100}
            max={30000}
            step={100}
            suffix="ms"
          />
          <NumberField
            form={form}
            path="dailyBudget"
            label="Daily Budget"
            min={0}
            step={10}
            hint="Skipped for the day once spent; empty = no limit"
          />
        </Section>
        <Section title="Request" columns={2} note="{DNID} is replaced by the number">
          <TextField
            form={form}
            path="url"
            label="URL"
            required
            wide
            maxLength={500}
            nullable={false}
            placeholder="https://api.example.com/lookup?msisdn={DNID}"
          />
          <TextField form={form} path="username" label="UserName" maxLength={100} />
          <FormField
            label="Password"
            hint={
              detail?.passwordSet
                ? "Stored and never shown. Type a new one to replace it."
                : "Never shown again after saving (§13.22)."
            }
          >
            <input
              type="password"
              autoComplete="new-password"
              value={form.values.password ?? ""}
              placeholder={detail?.passwordSet ? "•••••••• (unchanged)" : ""}
              onChange={(e) => form.set("password", e.target.value === "" ? null : e.target.value)}
            />
          </FormField>
          <TextArea form={form} path="extraHeaders" label="Extra Headers" rows={3} placeholder="X-Api-Key: …" />
          <TextArea form={form} path="postData" label="Data (POST body)" rows={3} placeholder='{"msisdn":"{DNID}"}' />
        </Section>
        <Section title="Response mapping" columns={4} note="Where each value is found in the provider's answer">
          {MAPPING_FIELDS.map((f) => (
            <TextField
              key={f.key}
              form={form}
              path={`responseMapping.${f.key}`}
              label={f.label}
              required={f.required}
              maxLength={200}
              nullable={!f.required}
            />
          ))}
        </Section>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function EditLoader({ id, done }: { id: number; done: (id: number | null) => void }) {
  const q = useHlrProvider(id);
  if (q.data) return <ProviderEditor detail={q.data} done={done} />;
  return (
    <Modal title="Loading provider…" onClose={() => done(null)} width={360}>
      <p className={q.isError ? "error-text" : "muted"}>{q.isError ? problemText(q.error) : "Loading…"}</p>
    </Modal>
  );
}

const openEditor = (id: number | null) =>
  ask<number>((done) =>
    id === null ? <ProviderEditor detail={null} done={done} /> : <EditLoader id={id} done={done} />,
  );

// ---------------------------------------------------------------- detail

function ProviderDetail({ row }: { row: HlrProviderRow }) {
  const q = useHlrProvider(row.id);
  const { go } = useHlrNav();
  const currency = usePlatformCurrency();
  const d = q.data;
  if (!d) return <p className="muted">{q.isError ? problemText(q.error) : "Loading…"}</p>;
  const live = LIVE[d.stats.liveStatus];
  return (
    <div className="tr-detail">
      <div className="detail-actions">
        {!d.archivedAt && (
          <>
            <Button small icon="file" onClick={() => void openEditor(d.id)}>
              Edit
            </Button>
            <Button small icon="list" onClick={() => go("providers", `&provider=${d.id}`)}>
              Prices ({row.rates})
            </Button>
          </>
        )}
        <RecordActions kind="hlr_provider" id={d.id} name={`provider ${d.name}`} archived={!!d.archivedAt} />
      </div>
      <dl className="kv">
        <dt>Live</dt>
        <dd>
          <StatusDot tone={live.tone} /> {live.label}
          <span className="muted small">
            {" "}
            · {d.stats.lookups.toLocaleString("en-US")} lookups in 24 h ({d.stats.liveLookups.toLocaleString("en-US")}{" "}
            live, {d.stats.cachedLookups.toLocaleString("en-US")} cached) · success {pct(d.stats.successPct)} · avg{" "}
            {d.stats.avgResponseMs ?? "—"} ms of {d.timeoutMs} ms · cost {d.stats.cost.toFixed(2)} {currency} ·{" "}
            {d.stats.ported.toLocaleString("en-US")} ported
          </span>
        </dd>
        <dt>Type</dt>
        <dd>{providerTypeLabel(d.providerType)}</dd>
        <dt>Request</dt>
        <dd>
          <code>{d.postData ? `POST ${d.url}` : `GET ${d.url}`}</code>
        </dd>
        <dt>Credentials</dt>
        <dd>
          {d.username ?? muted("no user")} · password {d.passwordSet ? "stored" : muted("none")}
        </dd>
        <dt>Price</dt>
        <dd>
          {d.defaultRate} {d.currency} per live lookup by default · {row.rates} destinations priced
        </dd>
        <dt>Cache · budget</dt>
        <dd>
          {d.cacheDays ? `${d.cacheDays} day${d.cacheDays === 1 ? "" : "s"}` : "no cache"} ·{" "}
          {d.dailyBudget === null ? "no daily budget" : `${d.dailyBudget} ${d.currency} a day`}
        </dd>
        <dt>Used by</dt>
        <dd>
          {d.rules} HLR rule{d.rules === 1 ? "" : "s"} · {d.policies} polic{d.policies === 1 ? "y" : "ies"}
        </dd>
        <dt>Mapping</dt>
        <dd className="small">
          {MAPPING_FIELDS.filter((f) => d.responseMapping[f.key])
            .map((f) => `${f.label} = ${d.responseMapping[f.key]}`)
            .join(" · ")}
        </dd>
        <dt>Updated</dt>
        <dd>
          {d.updatedBy ?? "seed data"} · {fmtWhen(d.updatedAt)}
        </dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------- prices (§6.5 Rate)

function RateDialog({
  providerId,
  currency,
  row,
  done,
}: {
  providerId: number;
  currency: string;
  row: HlrProviderRate | null;
  done: () => void;
}) {
  const form = useForm<{ destinationId: number; rate: number | null }>({
    destinationId: row?.destinationId ?? 0,
    rate: row?.rate ?? null,
  });
  const set = useSetHlrRate(providerId);
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!form.values.destinationId) return setError("Choose the destination.");
    if (form.values.rate === null) return setError("Enter the price.");
    set.mutate(
      { destinationId: form.values.destinationId, rate: form.values.rate },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `Price ${r.record.mccmnc} = ${r.record.rate} ${currency}`);
          done();
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  };
  return (
    <RecordDialog
      title={row ? `Price for ${row.mccmnc} ${row.country}` : "Set a destination price"}
      saveLabel="Save price"
      saving={set.isPending}
      error={error}
      onSave={submit}
      onClose={done}
    >
      {row ? (
        <FormField label="Destination" wide>
          <span>
            {row.mccmnc} · {row.country} · {row.network}
          </span>
        </FormField>
      ) : (
        <FormField
          label="Destination"
          required
          wide
          error={form.error("destinationId")}
          hint="The country’s All networks code is the default price for networks without their own"
        >
          <ListLookup<Destination>
            list="destinations"
            value={form.values.destinationId || null}
            onChange={(d) => form.set("destinationId", d?.id ?? 0)}
            labelOf={(d) => destLabel(d.country, d.network, d.allNetworks, d.allNetworks ? d.mcc : d.mccmnc)}
            placeholder="Country, network or MCCMNC…"
            clearable={false}
          />
        </FormField>
      )}
      <NumberField
        form={form}
        path="rate"
        label="Rate"
        required
        min={0}
        max={1}
        step={0.000001}
        suffix={currency}
        wide
      />
    </RecordDialog>
  );
}

function Prices({ id }: { id: number }) {
  const { go } = useHlrNav();
  const provider = useQuery({
    queryKey: ["list", "hlr_providers", "one", id],
    queryFn: () =>
      fetchListPage<HlrProviderRow>("hlr_providers", {
        filter: {
          logic: "and",
          conditions: [
            { field: "id", op: "eq", value: id },
            { field: "archived", op: "in", values: [true, false] },
          ],
        },
        limit: 1,
        withTotal: false,
      }).then((p) => p.rows[0] ?? null),
  });
  const del = useDeleteHlrRates(id);
  const notifySaved = useNotifySaved();
  const p = provider.data;
  if (provider.isPending) return <div className="grid-message muted">Loading…</div>;
  if (!p)
    return (
      <div className="grid-message">
        Provider {id} not found.{" "}
        <button type="button" className="link" onClick={() => go("providers")}>
          Back to the providers
        </button>
      </div>
    );
  const archived = !!p.archivedAt;
  const edit = (row: HlrProviderRate | null) =>
    ask<void>((done) => <RateDialog providerId={id} currency={p.currency} row={row} done={() => done()} />);
  const remove = (ids: number[], clear?: () => void) =>
    del.mutate(ids, {
      onSuccess: (r) => {
        if (r.change) notifySaved(r.change, `Removed ${ids.length} price${ids.length === 1 ? "" : "s"}`);
        clear?.();
      },
      onError: (e) => toast({ tone: "error", message: problemText(e) }),
    });
  const withProvider = (body: ListQuery): ListQuery => ({
    ...body,
    filter: {
      logic: "and",
      conditions: [{ field: "providerId", op: "eq", value: id }, ...(body.filter ? [body.filter] : [])],
    },
  });
  return (
    <ListScreen<HlrProviderRate>
      list="hlr_provider_rates"
      page={page}
      title={`HLR prices · ${p.name}`}
      historyScope={{ entityTypes: ["hlr_provider_rate"] }}
      queryScope={id}
      fetchPage={(body) => fetchListPage<HlrProviderRate>("hlr_provider_rates", withProvider(body))}
      primary={{ label: "Set price", icon: "plus", disabled: archived, onClick: () => void edit(null) }}
      actions={
        <>
          <Button icon="list" onClick={() => go("providers")}>
            All providers
          </Button>
          <Button
            icon="upload"
            disabled={archived}
            onClick={() =>
              void openImport({
                target: { kind: "hlr_rates", providerId: id },
                title: `Import Rate · ${p.name}`,
                help: (
                  <p>
                    Columns <code>mccmnc</code> and <code>rate</code> ({p.currency} per live lookup). A destination
                    already priced is updated, a new one added.
                  </p>
                ),
                replaceHint: `Prices of ${p.name} missing from the file are removed (those destinations use the default rate).`,
              })
            }
          >
            Import Rate
          </Button>
        </>
      }
      onExport={() =>
        void downloadCsv(`/hlr-providers/${id}/rates/export`).catch((e) =>
          toast({ tone: "error", message: problemText(e) }),
        )
      }
      above={
        <div className="rm-trunk">
          <span className="muted small">
            Default rate {p.defaultRate} {p.currency} for every destination not listed here. A network&apos;s own price
            wins over its country&apos;s.
          </span>
        </div>
      }
      columns={{
        country: { width: 200 },
        network: { width: 240 },
        mccmnc: { width: 100, render: (r) => <span className="num">{r.mccmnc}</span> },
        rate: { width: 130, align: "right", render: (r) => <span className="num">{`${r.rate} ${r.currency}`}</span> },
        updatedBy: { width: 140, render: (r) => r.updatedBy ?? muted("—") },
        updatedAt: { width: 170, render: (r) => fmtWhen(r.updatedAt) },
      }}
      onOpen={(r) => !archived && void edit(r)}
      selection={
        archived
          ? undefined
          : {
              summary: (_rows, ids) => `${ids.size} selected`,
              bulk: (ids, clear) => [
                {
                  label: `Remove ${ids.length} price${ids.length === 1 ? "" : "s"}`,
                  icon: "trash",
                  danger: true,
                  onSelect: () => remove(ids, clear),
                },
              ],
            }
      }
      detail={(r) => ({
        title: (
          <>
            <strong className="num">{r.mccmnc}</strong>
            <span className="muted">
              {r.country} · {r.network} · {r.rate} {r.currency}
            </span>
          </>
        ),
        sections: [
          {
            key: "price",
            label: "Price",
            actions: archived ? undefined : (
              <>
                <Button small icon="file" onClick={() => void edit(r)}>
                  Edit
                </Button>
                <Button small icon="trash" onClick={() => remove([r.id])}>
                  Remove
                </Button>
              </>
            ),
            content: (
              <dl className="kv">
                <dt>Updated</dt>
                <dd>
                  {r.updatedBy ?? "seed data"} · {fmtWhen(r.updatedAt)}
                </dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits the price · Space selects · Ctrl+Z undo"
    />
  );
}

// ---------------------------------------------------------------- view

export function ProvidersView() {
  const { providerId } = useHlrNav();
  const currency = usePlatformCurrency();
  const [selectId, setSelectId] = useState<number | null>(null);
  if (providerId !== null) return <Prices id={providerId} />;
  return (
    <ListScreen<HlrProviderRow>
      list="hlr_providers"
      page={page}
      title="HLR · Providers"
      selectId={selectId}
      historyScope={{ entityTypes: ["hlr_provider", "hlr_provider_rate"] }}
      primary={{
        label: "Add provider",
        icon: "plus",
        onClick: () => void openEditor(null).then((id) => id && setSelectId(id)),
      }}
      above={<ViewSwitch note="Live status and figures: last 24 hours, refreshed every 5 minutes." />}
      columns={{
        id: { width: 60 },
        name: { width: 200, render: (r) => <strong>{r.name}</strong> },
        providerType: { width: 120, render: (r) => providerTypeLabel(r.providerType) },
        liveStatus: {
          width: 100,
          render: (r) => (
            <span>
              <StatusDot tone={LIVE[r.liveStatus].tone} /> {LIVE[r.liveStatus].label}
            </span>
          ),
        },
        lookups: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{r.lookups.toLocaleString("en-US")}</span>,
        },
        successPct: {
          width: 90,
          align: "right",
          render: (r) => (
            <span className={`num${r.successPct !== null && r.successPct < 90 ? " tone-warning" : ""}`}>
              {pct(r.successPct)}
            </span>
          ),
        },
        avgResponseMs: {
          width: 90,
          align: "right",
          render: (r) => <span className="num">{r.avgResponseMs ?? "—"}</span>,
        },
        cost: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{`${r.cost.toFixed(2)} ${currency}`}</span>,
        },
        defaultRate: {
          width: 120,
          align: "right",
          render: (r) => <span className="num">{`${r.defaultRate} ${r.currency}`}</span>,
        },
        currency: { width: 80 },
        rates: { width: 80, align: "right" },
        cacheDays: { width: 100, align: "right" },
        rules: { width: 70, align: "right" },
        policies: { width: 80, align: "right" },
        status: { width: 90, render: (r) => (r.status === "active" ? "Active" : muted("Inactive")) },
      }}
      onOpen={(r) => !r.archivedAt && void openEditor(r.id)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {providerTypeLabel(r.providerType)} · {LIVE[r.liveStatus].label}
            </span>
          </>
        ),
        sections: [
          { key: "provider", label: "Provider", content: <ProviderDetail row={r} /> },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["hlr_provider"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
