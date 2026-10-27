// HLR policies (§13.24): per destination (an MCCMNC code, a whole country by its MCC, or the
// catch-all for every other destination) the providers to ask in order, or "auto" (cheapest
// meeting a minimum success rate), and how long ported and not-ported answers are cached. Route
// rules use a policy in their HLR action; the Test shows which provider a number would get.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  Destination,
  HlrPolicyDetail,
  HlrPolicyEntry,
  HlrPolicyInput,
  HlrPolicyRow,
  HlrPolicyTestResult,
  HlrProviderRow,
} from "@sms/contract";
import { fetchListPage, useMe } from "../../../api/hooks";
import { useRestore } from "../../../api/records";
import { testHlrPolicy, useHlrPolicy, useSaveHlrPolicy } from "../../../api/hlr";
import { Section, SelectField, TextField, useForm } from "../../../form/form";
import { HistoryList, useNotifySaved } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { isAdminUser, ListLookup, useDeleteRecord } from "../../../records/parts";
import { ask, toast } from "../../../ui/feedback";
import { Button, Modal, StatusDot } from "../../../ui/primitives";
import { fmtWhen, RecordActions } from "../../reference/shared";
import { problemText } from "../../routing/dialogs";
import { ViewSwitch } from "./HlrPage";
import { blankEntry, blankPolicy, entrySummary, hoursText, LIVE, policyInput, sortEntries } from "./hlrModel";
import { destLabel } from "../../rates/DestinationTree";

const page = pageForPath("/switch/hlr")!;
const muted = (v: string) => <span className="muted">{v}</span>;

function useProviders() {
  return useQuery({
    queryKey: ["list", "hlr_providers", "all"],
    queryFn: () => fetchListPage<HlrProviderRow>("hlr_providers", { limit: 200, withTotal: false }),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------- editor

/** The providers of one entry, in the order they are tried. */
function ProviderOrder({
  value,
  providers,
  onChange,
}: {
  value: number[];
  providers: HlrProviderRow[];
  onChange: (v: number[]) => void;
}) {
  const name = (id: number) => providers.find((p) => p.id === id)?.name ?? `#${id}`;
  const move = (i: number) => {
    const next = [...value];
    [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
    onChange(next);
  };
  const left = providers.filter((p) => !value.includes(p.id));
  return (
    <div className="prov-order">
      {value.map((id, i) => (
        <span key={id} className="chip">
          <span className="num muted">{i + 1}</span> {name(id)}
          {i > 0 && (
            <button type="button" className="chip-x" aria-label={`Try ${name(id)} earlier`} onClick={() => move(i)}>
              ←
            </button>
          )}
          <button
            type="button"
            className="chip-x"
            aria-label={`Remove ${name(id)}`}
            onClick={() => onChange(value.filter((x) => x !== id))}
          >
            ×
          </button>
        </span>
      ))}
      {left.length > 0 && value.length < 10 && (
        <select
          aria-label="Add a provider"
          value=""
          onChange={(e) => e.target.value && onChange([...value, Number(e.target.value)])}
        >
          <option value="">+ provider…</option>
          {left.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.status === "inactive" ? " (inactive)" : ""}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function EntriesEditor({
  value,
  errors,
  onChange,
}: {
  value: HlrPolicyEntry[];
  errors: (path: string) => string | undefined;
  onChange: (v: HlrPolicyEntry[]) => void;
}) {
  const providers = useProviders().data?.rows ?? [];
  const patch = (i: number, p: Partial<HlrPolicyEntry>) =>
    onChange(value.map((e, j) => (j === i ? { ...e, ...p } : e)));
  const hasCatchAll = value.some((e) => e.code === null);
  const num = (v: string) => (v === "" ? 0 : Math.max(0, Math.min(720, Math.round(Number(v)))));
  return (
    <div className="entries">
      <table className="mini-table entries-table">
        <thead>
          <tr>
            <th>Destination</th>
            <th>Mode</th>
            <th>Providers (tried in order)</th>
            <th className="num">Min success %</th>
            <th className="num">Cache ported (h)</th>
            <th className="num">Cache not ported (h)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {value.map((e, i) => {
            const err = (k: string) => errors(`entries.${i}.${k}`);
            return (
              <tr key={i}>
                <td>
                  {e.code === null ? (
                    <strong>Every other destination</strong>
                  ) : (
                    <div className="code-pick">
                      <span className="num strong">{e.code || "—"}</span>
                      <ListLookup<Destination>
                        list="destinations"
                        value={null}
                        onChange={(d) => d && patch(i, { code: d.allNetworks ? d.mcc : d.mccmnc })}
                        labelOf={(d) =>
                          destLabel(d.country, d.network, d.allNetworks, d.allNetworks ? d.mcc : d.mccmnc)
                        }
                        placeholder={e.code ? "Change…" : "Country or network…"}
                      />
                    </div>
                  )}
                  {err("code") && <span className="ff-error">{err("code")}</span>}
                </td>
                <td>
                  <select
                    aria-label="Mode"
                    value={e.mode}
                    onChange={(ev) =>
                      patch(i, {
                        mode: ev.target.value as HlrPolicyEntry["mode"],
                        minSuccessPct: ev.target.value === "auto" ? (e.minSuccessPct ?? 90) : null,
                      })
                    }
                  >
                    <option value="ordered">In order</option>
                    <option value="auto">Auto (cheapest)</option>
                  </select>
                </td>
                <td>
                  <ProviderOrder
                    value={e.providerIds}
                    providers={providers}
                    onChange={(ids) => patch(i, { providerIds: ids })}
                  />
                  {err("providerIds") && <span className="ff-error">{err("providerIds")}</span>}
                </td>
                <td className="num">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    aria-label="Minimum success rate"
                    disabled={e.mode !== "auto"}
                    value={e.minSuccessPct ?? ""}
                    onChange={(ev) =>
                      patch(i, { minSuccessPct: ev.target.value === "" ? null : Number(ev.target.value) })
                    }
                  />
                  {err("minSuccessPct") && <span className="ff-error">{err("minSuccessPct")}</span>}
                </td>
                <td className="num">
                  <input
                    type="number"
                    min={0}
                    max={720}
                    aria-label="Cache hours for ported numbers"
                    value={e.cacheHoursPorted}
                    onChange={(ev) => patch(i, { cacheHoursPorted: num(ev.target.value) })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    min={0}
                    max={720}
                    aria-label="Cache hours for numbers not ported"
                    value={e.cacheHoursNotPorted}
                    onChange={(ev) => patch(i, { cacheHoursNotPorted: num(ev.target.value) })}
                  />
                </td>
                <td>
                  <Button
                    small
                    variant="ghost"
                    icon="x"
                    aria-label="Remove the destination"
                    onClick={() => onChange(value.filter((_, j) => j !== i))}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="entries-add">
        <Button small icon="plus" onClick={() => onChange([...value, blankEntry("")])}>
          Add destination
        </Button>
        {!hasCatchAll && (
          <Button small icon="plus" onClick={() => onChange([...value, blankEntry(null)])}>
            Add catch-all
          </Button>
        )}
      </div>
    </div>
  );
}

function PolicyEditor({ detail, done }: { detail: HlrPolicyDetail | null; done: (id: number | null) => void }) {
  const form = useForm<HlrPolicyInput>(detail ? policyInput(detail) : blankPolicy());
  const save = useSaveHlrPolicy();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const blank = form.values.entries.findIndex((e) => e.code === "");
    if (blank >= 0) return setError(`Choose the destination of row ${blank + 1}.`);
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
  };
  return (
    <Modal
      title={detail ? `Edit HLR policy · ${detail.name}` : "Add HLR policy"}
      width={1100}
      onClose={() => done(null)}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" icon="save" disabled={save.isPending} onClick={submit}>
            {detail ? "Save" : "Add policy"}
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
        <Section title="Policy" columns={3}>
          <TextField form={form} path="name" label="Policy" required wide maxLength={100} nullable={false} />
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
        </Section>
        <Section title="Destinations" columns={1}>
          <EntriesEditor
            value={form.values.entries}
            errors={form.error}
            onChange={(entries) => form.set("entries", entries)}
          />
        </Section>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function EditLoader({ id, done }: { id: number; done: (id: number | null) => void }) {
  const q = useHlrPolicy(id);
  if (q.data) return <PolicyEditor detail={q.data} done={done} />;
  return (
    <Modal title="Loading policy…" onClose={() => done(null)} width={360}>
      <p className={q.isError ? "error-text" : "muted"}>{q.isError ? problemText(q.error) : "Loading…"}</p>
    </Modal>
  );
}

const openEditor = (id: number | null) =>
  ask<number>((done) =>
    id === null ? <PolicyEditor detail={null} done={done} /> : <EditLoader id={id} done={done} />,
  );

// ---------------------------------------------------------------- detail

function PolicyDetail({ row }: { row: HlrPolicyRow }) {
  const q = useHlrPolicy(row.id);
  const d = q.data;
  if (!d) return <p className="muted">{q.isError ? problemText(q.error) : "Loading…"}</p>;
  const names = new Map(d.providers.map((p) => [p.id, p.name]));
  return (
    <div className="tr-detail">
      <div className="detail-actions">
        {!d.archivedAt && (
          <Button small icon="file" onClick={() => void openEditor(d.id)}>
            Edit
          </Button>
        )}
        <RecordActions kind="hlr_policy" id={d.id} name={`policy ${d.name}`} archived={!!d.archivedAt} />
        <span className="muted small">
          {d.usedBy ? `Used by ${d.usedBy} route rule${d.usedBy === 1 ? "" : "s"}` : "No route rule uses it"} · updated
          by {d.updatedBy ?? "seed data"} {fmtWhen(d.updatedAt)}
        </span>
      </div>
      {d.entries.length === 0 ? (
        <p className="muted">No destinations: the policy never does a lookup.</p>
      ) : (
        <table className="mini-table">
          <thead>
            <tr>
              <th>Destination</th>
              <th>Providers</th>
            </tr>
          </thead>
          <tbody>
            {sortEntries(d.entries).map((e) => (
              <tr key={e.code ?? "*"}>
                <td className="num">{e.code ?? <strong>Every other</strong>}</td>
                <td>{entrySummary(e, names)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PolicyTest({ id }: { id: number }) {
  const [receiver, setReceiver] = useState("");
  const [result, setResult] = useState<HlrPolicyTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await testHlrPolicy(id, receiver));
    } catch (e) {
      setError(problemText(e));
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="test-section">
      <form
        className="test-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="fgrid cols-4">
          <label className="field">
            <span>
              Receiver number<span className="req">*</span>
            </span>
            <input
              value={receiver}
              inputMode="numeric"
              placeholder="447700900123"
              onChange={(e) => setReceiver(e.target.value.replace(/[^\d+]/g, ""))}
            />
          </label>
          <div className="field test-run">
            <span>&nbsp;</span>
            <Button type="submit" icon="play" disabled={running || !/^\+?[0-9]{5,15}$/.test(receiver)}>
              Run
            </Button>
          </div>
        </div>
      </form>
      {error && <p className="error-text">{error}</p>}
      {result && (
        <div className="tt-result">
          <div className="decision-head">
            <StatusDot tone={result.entry ? "good" : "neutral"} />
            <strong>
              {result.entry
                ? `Entry ${result.entry.code ?? "every other destination"} · ${
                    result.entry.mode === "auto" ? "auto (cheapest)" : "in order"
                  }`
                : "No entry: no HLR lookup"}
            </strong>
            <span className="fb-spacer" />
            <span className="muted small">
              {result.mccmnc ?? "unknown network"}
              {result.destination ? ` · ${result.destination}` : ""}
              {result.entry
                ? ` · cache ${hoursText(result.entry.cacheHoursPorted)} ported / ${hoursText(result.entry.cacheHoursNotPorted)} not`
                : ""}
            </span>
          </div>
          {result.providers.length > 0 && (
            <table className="mini-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Provider</th>
                  <th className="num">Price</th>
                  <th className="num">Success</th>
                  <th>Live</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {result.providers.map((p, i) => {
                  const first = result.providers.findIndex((x) => !x.skipped) === i;
                  return (
                    <tr key={p.providerId} className={first ? "chosen" : p.skipped ? "off" : ""}>
                      <td className="num">{i + 1}</td>
                      <td>{p.name}</td>
                      <td className="num">{`${p.rate} ${p.currency}`}</td>
                      <td className="num">{p.successPct === null ? "—" : `${p.successPct.toFixed(1)} %`}</td>
                      <td>
                        <StatusDot tone={LIVE[p.liveStatus].tone} /> {LIVE[p.liveStatus].label}
                      </td>
                      <td className={first ? "strong" : "muted"}>
                        {p.skipped ? `skipped: ${p.skipped}` : first ? "asked first" : "fallback"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- view

export function PoliciesView() {
  const [selectId, setSelectId] = useState<number | null>(null);
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const deleteOne = useDeleteRecord();
  const restore = useRestore("hlr_policy");
  const notifySaved = useNotifySaved();
  return (
    <ListScreen<HlrPolicyRow>
      list="hlr_policies"
      page={page}
      title="HLR · Policies"
      selectId={selectId}
      historyScope={{ entityTypes: ["hlr_policy"] }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted policies cannot be edited" : undefined,
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
                  onSuccess: (res) => res.change && notifySaved(res.change, `Restored policy ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete…",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("hlr_policy", r.id, `policy ${r.name}`),
            },
      ]}
      primary={{
        label: "Add policy",
        icon: "plus",
        onClick: () => void openEditor(null).then((id) => id && setSelectId(id)),
      }}
      above={<ViewSwitch />}
      columns={{
        id: { width: 60 },
        name: { width: 220, render: (r) => <strong>{r.name}</strong> },
        status: { width: 90, render: (r) => (r.status === "active" ? "Active" : muted("Inactive")) },
        destinations: { width: 110, align: "right" },
        hasCatchAll: { width: 100, render: (r) => (r.hasCatchAll ? "Yes" : muted("No")) },
        providerNames: { width: 360 },
        usedBy: { width: 110, align: "right" },
        updatedBy: { width: 140, render: (r) => r.updatedBy ?? muted("—") },
        updatedAt: { width: 170, render: (r) => fmtWhen(r.updatedAt) },
      }}
      onOpen={(r) => !r.archivedAt && void openEditor(r.id).then((id) => id && setSelectId(id))}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {r.destinations} destinations{r.hasCatchAll ? " + catch-all" : ""} · {r.usedBy} route rule
              {r.usedBy === 1 ? "" : "s"}
            </span>
          </>
        ),
        sections: [
          { key: "policy", label: "Destinations", content: <PolicyDetail row={r} /> },
          { key: "test", label: "Test", content: <PolicyTest id={r.id} /> },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["hlr_policy"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
