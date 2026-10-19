// Admin › Migration center (§13.22): one page with three views kept in the tab URL (?view=).
// - Imports: CSV per entity from the old platform (through a column mapping) or a package from another
//   installation; the dry run shows what would be created, updated or skipped and every problem by row;
//   apply writes it as one change in History (undo = rollback); trunks wait inactive until go-live.
// - Exports: one encrypted package with every entity and a manifest; credentials only with 2FA;
//   downloads through single-use links that expire after 15 minutes.
// - Column mappings: the old system's column names per template field, saved per source system.
import { useMemo, useState } from "react";
import { useLocation } from "react-router";
import type {
  MigrationConflict,
  MigrationExport,
  MigrationFileInput,
  MigrationImport,
  MigrationImportEntity,
  MigrationImportInput,
  MigrationIssue,
  MigrationMapping,
} from "@sms/contract";
import {
  downloadPackage,
  downloadTemplate,
  useActivateTrunks,
  useApplyImport,
  useCreateExport,
  useCreateImport,
  useCreateLink,
  useMigrationEntities,
  useMigrationExports,
  useMigrationImport,
  useMigrationImports,
  useMigrationMappings,
  useRevalidateImport,
  useSaveMapping,
} from "../../../api/migration";
import { useMe } from "../../../api/hooks";
import { useUndo } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { PageHeader } from "../../../page/PageHeader";
import { ListLookup } from "../../../records/parts";
import { useTabNavigate } from "../../../shell/tabContext";
import { ask, confirmDialog, toast } from "../../../ui/feedback";
import { Button, Modal, StatusDot } from "../../../ui/primitives";
import { VirtualTable, type VColumn } from "../../lookup/VirtualTable";
import { fmtWhen } from "../../reference/shared";
import { problemText } from "../../routing/dialogs";
import {
  blankExport,
  CONFLICTS,
  ENTITY_ORDER,
  exportInput,
  exportProblems,
  fmtBytes,
  headerHasCredentials,
  isView,
  nextStep,
  reportLine,
  SENSITIVITY,
  sensitivityTone,
  STATUS,
  VIEWS,
  type ExportDraft,
  type MigrationView,
} from "./migrationModel";

const page = pageForPath("/admin/migration")!;
const fail = (e: unknown) => toast({ tone: "error", message: problemText(e) });
const int = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US"));

function useMigNav() {
  const location = useLocation();
  const navigate = useTabNavigate();
  const params = new URLSearchParams(location.search);
  const raw = params.get("view");
  const view: MigrationView = isView(raw) ? raw : "imports";
  const id = Number(params.get("id")) || null;
  return {
    view,
    id,
    go: (next: MigrationView, nextId: number | null = null) =>
      navigate(`/admin/migration?view=${next}${nextId ? `&id=${nextId}` : ""}`, { replace: true }),
  };
}

// ---------------------------------------------------------------- export

function ExportDialog({ done }: { done: (x: MigrationExport | null) => void }) {
  const { data: me } = useMe();
  const isAdmin = !!me?.permissions.includes("*");
  const create = useCreateExport();
  const [d, setD] = useState<ExportDraft>(blankExport());
  const set = (patch: Partial<ExportDraft>) => setD({ ...d, ...patch });
  const problems = exportProblems(d);
  return (
    <Modal
      title="New export package"
      onClose={() => done(null)}
      width={560}
      footer={
        <>
          <span className="muted small mig-foot">{problems[0] ?? ""}</span>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant="primary"
            icon="download"
            disabled={problems.length > 0 || create.isPending}
            onClick={() =>
              create.mutate(exportInput(d), {
                onSuccess: (x) => {
                  toast({ tone: "good", message: `Export #${x.id} started: the package is written in the background` });
                  done(x);
                },
                onError: fail,
              })
            }
          >
            Make package
          </Button>
        </>
      }
    >
      <p className="small muted">
        One encrypted file with every entity as its own CSV and a manifest of record counts and links. It opens only
        with the password below, which is not stored: keep it safe.
      </p>
      <div className="form-grid cols-2">
        <label className="field">
          <span>Rate lines</span>
          <select value={d.rateLines} onChange={(e) => set({ rateLines: e.target.value as ExportDraft["rateLines"] })}>
            <option value="current">Current and future only</option>
            <option value="all">All, with history</option>
            <option value="none">None</option>
          </select>
        </label>
        <div />
        <label className="field">
          <span>Package password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={d.password}
            onChange={(e) => set({ password: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Repeat password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={d.confirm}
            onChange={(e) => set({ confirm: e.target.value })}
          />
        </label>
      </div>
      <fieldset className="mig-creds">
        <legend>Credentials (admins only)</legend>
        <label className="toggle-inline">
          <input
            type="checkbox"
            disabled={!isAdmin}
            checked={d.includeCredentials}
            onChange={(e) =>
              set({ includeCredentials: e.target.checked, withPasswords: e.target.checked && d.withPasswords })
            }
          />{" "}
          Include trunk connection details (System IDs, hosts, IPs, ports)
        </label>
        <label className="toggle-inline">
          <input
            type="checkbox"
            disabled={!d.includeCredentials}
            checked={d.withPasswords}
            onChange={(e) => set({ withPasswords: e.target.checked })}
          />{" "}
          Also include passwords
        </label>
        {d.includeCredentials && (
          <label className="field narrow">
            <span>Your 2FA code</span>
            <input
              inputMode="numeric"
              maxLength={6}
              value={d.totpCode ?? ""}
              onChange={(e) => set({ totpCode: e.target.value.replace(/\D/g, "") })}
            />
            <small>Logged in the audit trail; the other admins get an e-mail.</small>
          </label>
        )}
        {!isAdmin && <p className="small muted">Only administrators can include credentials.</p>}
      </fieldset>
    </Modal>
  );
}

function LinkDialog({ x, done }: { x: MigrationExport; done: (v: boolean | null) => void }) {
  const link = useCreateLink();
  const [code, setCode] = useState("");
  const get = () =>
    link.mutate(
      { id: x.id, totpCode: x.includesCredentials ? code : null },
      {
        onSuccess: (l) =>
          void downloadPackage(l.url)
            .then(() => {
              toast({ tone: "good", message: `Package #${x.id} downloaded. ${l.note}` });
              done(true);
            })
            .catch(fail),
        onError: fail,
      },
    );
  return (
    <Modal
      title={`Download export #${x.id}`}
      onClose={() => done(null)}
      width={460}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant="primary"
            icon="download"
            disabled={link.isPending || (x.includesCredentials && !/^\d{6}$/.test(code))}
            onClick={get}
          >
            Download
          </Button>
        </>
      }
    >
      <p className="small">
        A single-use link is made and used at once; it expires after 15 minutes. {fmtBytes(x.sizeBytes)}.
      </p>
      {x.includesCredentials && (
        <label className="field narrow">
          <span>Your 2FA code</span>
          <input
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            autoFocus
          />
          <small>This package holds credentials: the download is audited and the other admins are told.</small>
        </label>
      )}
    </Modal>
  );
}

function ExportPanel({ x }: { x: MigrationExport }) {
  const m = x.manifest;
  return (
    <div className="team-card">
      <div className="team-card-head">
        <strong>Export #{x.id}</strong>
        <span className="small">
          <StatusDot tone={x.status === "done" ? "good" : x.status === "failed" ? "error" : "warning"} /> {x.status}
        </span>
      </div>
      <div className="small muted">
        {x.createdBy} · {fmtWhen(x.createdAt)} · {fmtBytes(x.sizeBytes)} · rate lines {x.rateLines}
        {x.includesCredentials ? (x.withPasswords ? " · credentials and passwords" : " · credentials") : ""}
      </div>
      {x.error && <div className="tone-error small">{x.error}</div>}
      {x.status === "done" && (
        <Button
          variant="primary"
          icon="download"
          onClick={() => void ask<boolean>((done) => <LinkDialog x={x} done={done} />)}
        >
          Download
        </Button>
      )}
      {m && (
        <>
          <table className="mig-table">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Level</th>
                <th className="num">Records</th>
              </tr>
            </thead>
            <tbody>
              {m.entities.map((e) => (
                <tr key={e.entity}>
                  <td>{e.entity}</td>
                  <td>
                    <StatusDot tone={sensitivityTone(e.sensitivity)} hollow={e.sensitivity === "general"} />{" "}
                    {SENSITIVITY[e.sensitivity]}
                  </td>
                  <td className="num">{int(e.rows)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details>
            <summary className="small">Links in the manifest ({m.links.length})</summary>
            <table className="mig-table">
              <tbody>
                {m.links.map((l) => (
                  <tr key={`${l.from}-${l.via}`}>
                    <td>
                      {l.from} → {l.to}
                    </td>
                    <td className="muted">{l.via}</td>
                    <td className="num">{int(l.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </div>
  );
}

function ExportsView({ id, select }: { id: number | null; select: (id: number) => void }) {
  const q = useMigrationExports();
  const rows = q.data ?? [];
  const current = rows.find((x) => x.id === id) ?? null;
  const columns: VColumn<MigrationExport>[] = [
    { key: "id", header: "#", width: 60, align: "right", render: (x) => x.id },
    {
      key: "status",
      header: "Status",
      width: 110,
      render: (x) => (
        <>
          <StatusDot tone={x.status === "done" ? "good" : x.status === "failed" ? "error" : "warning"} /> {x.status}
        </>
      ),
    },
    {
      key: "content",
      header: "Content",
      width: 260,
      render: (x) =>
        `Rate lines: ${x.rateLines}${x.includesCredentials ? (x.withPasswords ? " · credentials + passwords" : " · credentials") : ""}`,
    },
    { key: "size", header: "Size", width: 90, align: "right", render: (x) => fmtBytes(x.sizeBytes) },
    { key: "by", header: "Made by", width: 150, render: (x) => x.createdBy ?? "—" },
    { key: "at", header: "Made", width: 175, render: (x) => fmtWhen(x.createdAt) },
  ];
  return (
    <div className="team-body">
      <div className="rate-grid-card">
        {q.isError ? (
          <div className="grid-message tone-error">{problemText(q.error)}</div>
        ) : (
          <VirtualTable<MigrationExport>
            label="Export packages"
            rows={rows}
            columns={columns}
            onRowClick={(x) => select(x.id)}
            rowKey={(x) => String(x.id)}
            rowClass={(x) => (x.id === id ? "team-active" : undefined)}
            empty={q.isPending ? "Loading…" : "No export yet"}
          />
        )}
      </div>
      <aside className="team-side">
        {current ? (
          <ExportPanel x={current} />
        ) : (
          <div className="team-card small muted">
            Pick an export to see its manifest and download it. Packages are encrypted with their own password and hold
            every entity as its own CSV; EDRs stay in the reporting store and link through the old IDs.
          </div>
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- import

interface FileSlot {
  fileName: string;
  content: string;
  mappingId: number | null;
}

function ImportDialog({
  existing,
  done,
}: {
  existing: MigrationImport | null;
  done: (i: MigrationImport | null) => void;
}) {
  const entities = useMigrationEntities();
  const mappings = useMigrationMappings();
  const exports = useMigrationExports();
  const create = useCreateImport();
  const revalidate = useRevalidateImport();
  const [source, setSource] = useState(existing?.sourceSystem ?? "");
  const [mode, setMode] = useState<"files" | "package">("files");
  const [slots, setSlots] = useState<Partial<Record<MigrationImportEntity, FileSlot>>>({});
  const [conflicts, setConflicts] = useState<Record<string, MigrationConflict>>(
    (existing?.conflicts as Record<string, MigrationConflict>) ?? {},
  );
  const [inactive, setInactive] = useState(existing?.trunksInactive ?? true);
  const [pkg, setPkg] = useState<number | null>(null);
  const [pkgPassword, setPkgPassword] = useState("");
  const [totp, setTotp] = useState("");
  const systems = [...new Set((mappings.data ?? []).map((m) => m.sourceSystem))];
  const creds = Object.values(slots).some((s) => s && headerHasCredentials(s.content));
  const files: MigrationFileInput[] = ENTITY_ORDER.flatMap((e) => {
    const s = slots[e];
    return s ? [{ entity: e, fileName: s.fileName, content: s.content, mappingId: s.mappingId }] : [];
  });
  const body: MigrationImportInput = {
    sourceSystem: source.trim(),
    files: mode === "files" ? files : [],
    packageExportId: mode === "package" ? pkg : null,
    packagePassword: mode === "package" ? pkgPassword : null,
    conflicts,
    trunksInactive: inactive,
    totpCode: totp || null,
  };
  const problem = !source.trim()
    ? "Name the system the data comes from"
    : mode === "files" && !files.length
      ? "Add at least one file"
      : mode === "package" && (!pkg || !pkgPassword)
        ? "Pick a package and enter its password"
        : creds && !/^\d{6}$/.test(totp)
          ? "These files hold credentials: enter your 2FA code"
          : null;
  const pending = create.isPending || revalidate.isPending;
  const run = () => {
    const opts = { onSuccess: (i: MigrationImport) => done(i), onError: fail };
    if (existing) revalidate.mutate({ id: existing.id, body }, opts);
    else create.mutate(body, opts);
  };
  const pick = (entity: MigrationImportEntity, file: File | null) => {
    if (!file) return setSlots({ ...slots, [entity]: undefined });
    void file.text().then((content) => {
      const forSource = (mappings.data ?? []).find((m) => m.entity === entity && m.sourceSystem === source.trim());
      setSlots((s) => ({ ...s, [entity]: { fileName: file.name, content, mappingId: forSource?.id ?? null } }));
    });
  };
  return (
    <Modal
      title={existing ? `Fix and re-run import #${existing.id}` : "New import"}
      onClose={() => done(null)}
      width={760}
      footer={
        <>
          <span className="muted small mig-foot">{problem ?? "The dry run writes nothing."}</span>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" icon="play" disabled={!!problem || pending} onClick={run}>
            {pending ? "Checking…" : "Run dry run"}
          </Button>
        </>
      }
    >
      <div className="form-grid cols-2">
        <label className="field">
          <span>Source system</span>
          <input
            list="mig-systems"
            value={source}
            placeholder="e.g. Reference platform"
            onChange={(e) => setSource(e.target.value)}
          />
          <datalist id="mig-systems">
            {systems.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <small>Old IDs are kept per source system, so a second run updates instead of duplicating.</small>
        </label>
        <div className="field">
          <span>From</span>
          <div className="segmented small" role="radiogroup" aria-label="Import from">
            {(["files", "package"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? "on" : ""}
                onClick={() => setMode(m)}
              >
                {m === "files" ? "CSV files" : "Export package"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {mode === "files" ? (
        <table className="mig-table mig-files">
          <thead>
            <tr>
              <th>Entity</th>
              <th>File</th>
              <th>Columns</th>
              <th>If it exists</th>
            </tr>
          </thead>
          <tbody>
            {(entities.data ?? []).map((info) => {
              const e = info.entity as MigrationImportEntity;
              const s = slots[e];
              const maps = (mappings.data ?? []).filter((m) => m.entity === e);
              return (
                <tr key={e}>
                  <td>
                    <strong>{info.label}</strong>
                    <div className="muted small">
                      {info.sensitivity === "credentials" ? "holds credentials · " : ""}match: {info.matchBy}
                    </div>
                  </td>
                  <td>
                    <input
                      type="file"
                      accept=".csv,.txt,text/csv"
                      aria-label={`${info.label} file`}
                      onChange={(ev) => pick(e, ev.target.files?.[0] ?? null)}
                    />
                    <button type="button" className="link small" onClick={() => void downloadTemplate(e).catch(fail)}>
                      Template
                    </button>
                  </td>
                  <td>
                    <select
                      aria-label={`${info.label} columns`}
                      disabled={!s}
                      value={s?.mappingId ?? ""}
                      onChange={(ev) =>
                        s &&
                        setSlots({
                          ...slots,
                          [e]: { ...s, mappingId: ev.target.value ? Number(ev.target.value) : null },
                        })
                      }
                    >
                      <option value="">Template names</option>
                      {maps.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.sourceSystem} · {m.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {e === "rate_lines" || e === "opening_balances" ? (
                      <span className="muted small">always added</span>
                    ) : (
                      <select
                        aria-label={`${info.label} when it exists`}
                        value={conflicts[e] ?? "skip"}
                        onChange={(ev) => setConflicts({ ...conflicts, [e]: ev.target.value as MigrationConflict })}
                      >
                        {CONFLICTS.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="form-grid cols-2">
          <label className="field">
            <span>Package</span>
            <select value={pkg ?? ""} onChange={(e) => setPkg(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Pick an export</option>
              {(exports.data ?? [])
                .filter((x) => x.status === "done")
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    #{x.id} · {fmtWhen(x.createdAt)} · {fmtBytes(x.sizeBytes)}
                  </option>
                ))}
            </select>
            <small>A package made by a Migration export of another installation (system to system).</small>
          </label>
          <label className="field">
            <span>Package password</span>
            <input
              type="password"
              autoComplete="off"
              value={pkgPassword}
              onChange={(e) => setPkgPassword(e.target.value)}
            />
          </label>
        </div>
      )}
      <div className="lcr-controls">
        <label className="toggle-inline">
          <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Create trunks
          inactive (go live per partner later)
        </label>
        <label className="field narrow">
          <span>2FA code</span>
          <input
            inputMode="numeric"
            maxLength={6}
            value={totp}
            onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))}
          />
          <small>Needed when the data holds trunk credentials (admins only).</small>
        </label>
      </div>
    </Modal>
  );
}

function ActivateDialog({ i, done }: { i: MigrationImport; done: (v: boolean | null) => void }) {
  const activate = useActivateTrunks();
  const [enterprise, setEnterprise] = useState<{ id: number; name: string } | null>(null);
  const go = (ids: number[] | null) =>
    activate.mutate(
      { id: i.id, body: { enterpriseIds: ids } },
      {
        onSuccess: (r) => {
          toast({
            tone: r.activated ? "good" : "warning",
            message: r.activated ? `${r.activated} trunks are live` : "No inactive imported trunk for that partner",
          });
          done(true);
        },
        onError: fail,
      },
    );
  return (
    <Modal
      title={`Go live: import #${i.id}`}
      onClose={() => done(null)}
      width={480}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button disabled={!enterprise || activate.isPending} onClick={() => go([enterprise!.id])}>
            Activate this partner
          </Button>
          <Button variant="primary" disabled={activate.isPending} onClick={() => go(null)}>
            Activate all {i.inactiveTrunks}
          </Button>
        </>
      }
    >
      <p className="small">
        {i.inactiveTrunks} trunks from this import are inactive. Activating is one change in History and can be undone.
      </p>
      <div className="field">
        <span>Partner</span>
        <ListLookup<{ id: number; name: string }>
          list="enterprises"
          value={enterprise?.id ?? null}
          onChange={(x) => setEnterprise(x)}
          labelOf={(x) => x.name}
          placeholder="One partner…"
        />
      </div>
    </Modal>
  );
}

function ImportPanel({ id }: { id: number }) {
  const q = useMigrationImport(id);
  const apply = useApplyImport();
  const undo = useUndo();
  const i = q.data;
  const [onlyErrors, setOnlyErrors] = useState(false);
  const issues = useMemo(
    () => (i?.report.issues ?? []).filter((x) => !onlyErrors || x.severity === "error"),
    [i, onlyErrors],
  );
  if (!i) return <div className="team-card small muted">{q.isError ? problemText(q.error) : "Loading…"}</div>;
  const st = STATUS[i.status];
  const issueColumns: VColumn<MigrationIssue>[] = [
    {
      key: "sev",
      header: "",
      width: 28,
      render: (x) => <StatusDot tone={x.severity === "error" ? "error" : "warning"} label={x.severity} />,
    },
    { key: "entity", header: "Entity", width: 120, render: (x) => x.entity },
    { key: "row", header: "Row", width: 60, align: "right", render: (x) => (x.row ? x.row : "—") },
    {
      key: "message",
      header: "Problem",
      width: 420,
      render: (x) => (
        <span title={x.message}>
          {x.field ? `${x.field}: ` : ""}
          {x.message}
        </span>
      ),
    },
  ];
  return (
    <div className="team-panel">
      <div className="team-card">
        <div className="team-card-head">
          <strong>
            Import #{i.id} · {i.sourceSystem}
          </strong>
          <span className="small">
            <StatusDot tone={st.tone} /> {st.label}
          </span>
        </div>
        <div className="small muted">
          {i.createdBy} · checked {fmtWhen(i.validatedAt)}
          {i.appliedAt ? ` · applied ${fmtWhen(i.appliedAt)}` : ""}
          {i.includesCredentials ? " · holds credentials" : ""}
          {i.changeId ? ` · change #${i.changeId} in History` : ""}
        </div>
        <div className="small">{nextStep(i)}</div>
        <div className="mig-actions">
          {i.status === "validated" && (
            <>
              <Button
                icon="refresh"
                onClick={() => void ask<MigrationImport>((done) => <ImportDialog existing={i} done={done} />)}
              >
                Fix and re-run
              </Button>
              <Button
                variant="primary"
                icon="check"
                disabled={!i.report.canApply || apply.isPending}
                onClick={() =>
                  void confirmDialog({
                    title: `Apply import #${i.id}?`,
                    message: `${reportLine(i.report.entities)}. It is one change in History: undoing it rolls the whole import back.`,
                    ok: "Apply",
                  }).then(
                    (yes) =>
                      yes &&
                      apply.mutate(i.id, {
                        onSuccess: (r) =>
                          toast({ tone: "good", message: `Import #${r.id} applied as change #${r.changeId}` }),
                        onError: fail,
                      }),
                  )
                }
              >
                Apply
              </Button>
            </>
          )}
          {i.status === "applied" && i.inactiveTrunks > 0 && (
            <Button
              variant="primary"
              icon="play"
              onClick={() => void ask<boolean>((done) => <ActivateDialog i={i} done={done} />)}
            >
              Go live
            </Button>
          )}
          {i.status === "applied" && i.changeId && (
            <Button
              icon="undo"
              onClick={() =>
                void confirmDialog({
                  title: `Roll back import #${i.id}?`,
                  message:
                    "Every record it created is archived and every field it updated goes back. You can redo it from History.",
                  ok: "Roll back",
                  danger: true,
                }).then((yes) => yes && void undo(i.changeId!).then(() => void q.refetch()))
              }
            >
              Roll back
            </Button>
          )}
        </div>
      </div>
      <div className="team-card">
        <table className="mig-table">
          <thead>
            <tr>
              <th>Entity</th>
              <th className="num">In file</th>
              <th className="num">New</th>
              <th className="num">Update</th>
              <th className="num">Skip</th>
              <th className="num">Errors</th>
              <th className="num" title="Records in this system now">
                In system
              </th>
            </tr>
          </thead>
          <tbody>
            {i.report.entities.map((e) => (
              <tr key={e.entity}>
                <td>{e.entity}</td>
                <td className="num">{int(e.source)}</td>
                <td className="num">{int(e.create)}</td>
                <td className="num">{int(e.update)}</td>
                <td className="num">{int(e.skip)}</td>
                <td className={`num${e.errors ? " tone-error" : ""}`}>{int(e.errors)}</td>
                <td className="num muted">{int(e.inSystem)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="small muted">
          Files: {i.files.map((f) => `${f.fileName}${f.mapping ? ` (${f.mapping})` : ""}`).join(", ")}
        </div>
      </div>
      <div className="team-card mig-issues">
        <div className="team-card-head">
          <strong>
            Problems{" "}
            {i.report.issueCount > i.report.issues.length
              ? `(first ${i.report.issues.length} of ${int(i.report.issueCount)})`
              : `(${i.report.issueCount})`}
          </strong>
          <label className="toggle-inline small">
            <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> Errors only
          </label>
        </div>
        <VirtualTable<MigrationIssue>
          label="Import problems"
          rows={issues}
          columns={issueColumns}
          rowKey={(x) => `${x.entity}:${x.row}:${x.field}:${x.message}`}
          rowHeight={30}
          empty="No problem found"
        />
      </div>
    </div>
  );
}

function ImportsView({ id, select }: { id: number | null; select: (id: number) => void }) {
  const q = useMigrationImports();
  const rows = q.data ?? [];
  const columns: VColumn<MigrationImport>[] = [
    { key: "id", header: "#", width: 60, align: "right", render: (x) => x.id },
    {
      key: "status",
      header: "Status",
      width: 120,
      render: (x) => (
        <>
          <StatusDot tone={STATUS[x.status].tone} /> {STATUS[x.status].label}
        </>
      ),
    },
    { key: "source", header: "Source", width: 170, render: (x) => x.sourceSystem },
    { key: "files", header: "Files", width: 70, align: "right", render: (x) => x.files.length },
    { key: "result", header: "Result", width: 280, render: (x) => reportLine(x.report.entities) },
    { key: "by", header: "By", width: 140, render: (x) => x.createdBy ?? "—" },
    { key: "at", header: "Checked", width: 175, render: (x) => fmtWhen(x.validatedAt) },
  ];
  return (
    <div className="team-body">
      <div className="rate-grid-card">
        {q.isError ? (
          <div className="grid-message tone-error">{problemText(q.error)}</div>
        ) : (
          <VirtualTable<MigrationImport>
            label="Imports"
            rows={rows}
            columns={columns}
            onRowClick={(x) => select(x.id)}
            rowKey={(x) => String(x.id)}
            rowClass={(x) => (x.id === id ? "team-active" : undefined)}
            empty={q.isPending ? "Loading…" : "No import yet: start one with New import"}
          />
        )}
      </div>
      <aside className="team-side">
        {id ? (
          <ImportPanel key={id} id={id} />
        ) : (
          <div className="team-card small">
            <strong>How an import works</strong>
            <ol className="mig-steps">
              <li>Export each entity from the old platform as CSV, or download our templates.</li>
              <li>Pick a column mapping (the reference platform&apos;s is ready) or save your own.</li>
              <li>Run the dry run: it writes nothing and lists every problem by file and row.</li>
              <li>Fix and re-run until it is clean, then apply: one change in History.</li>
              <li>Trunks arrive inactive; go live per partner. Undo the change to roll back.</li>
            </ol>
          </div>
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- mappings

function MappingDialog({ base, done }: { base: MigrationMapping | null; done: (v: boolean | null) => void }) {
  const entities = useMigrationEntities();
  const save = useSaveMapping();
  const [source, setSource] = useState(base && !base.builtIn ? base.sourceSystem : "");
  const [name, setName] = useState(base && !base.builtIn ? base.name : "Default");
  const [entity, setEntity] = useState<MigrationImportEntity>(base?.entity ?? "users");
  const [columns, setColumns] = useState<Record<string, string>>(base?.columns ?? {});
  const info = (entities.data ?? []).find((e) => e.entity === entity);
  const missing = (info?.fields ?? []).filter((f) => f.required && !columns[f.field]?.trim());
  const problem = !source.trim()
    ? "Name the source system"
    : missing.length
      ? `Map ${missing.map((f) => f.label).join(", ")}`
      : null;
  return (
    <Modal
      title={base?.builtIn ? `Copy of ${base.name}` : base ? `Mapping ${base.name}` : "New column mapping"}
      onClose={() => done(null)}
      width={620}
      footer={
        <>
          <span className="muted small mig-foot">{problem ?? ""}</span>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant="primary"
            icon="save"
            disabled={!!problem || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  sourceSystem: source.trim(),
                  entity,
                  name: name.trim(),
                  columns: Object.fromEntries(Object.entries(columns).filter(([, v]) => v.trim())),
                },
                { onSuccess: () => done(true), onError: fail },
              )
            }
          >
            Save mapping
          </Button>
        </>
      }
    >
      <div className="form-grid cols-2">
        <label className="field">
          <span>Source system</span>
          <input value={source} onChange={(e) => setSource(e.target.value)} />
        </label>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Entity</span>
          <select value={entity} disabled={!!base} onChange={(e) => setEntity(e.target.value as MigrationImportEntity)}>
            {(entities.data ?? []).map((e) => (
              <option key={e.entity} value={e.entity}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <table className="mig-table">
        <thead>
          <tr>
            <th>Our field</th>
            <th>Their column name</th>
          </tr>
        </thead>
        <tbody>
          {(info?.fields ?? []).map((f) => (
            <tr key={f.field}>
              <td>
                {f.label}
                {f.required ? " *" : ""}
                {f.credential ? <span className="muted small"> · credential</span> : null}
                {f.description && <div className="muted small">{f.description}</div>}
              </td>
              <td>
                <input
                  aria-label={`${f.label} column`}
                  value={columns[f.field] ?? ""}
                  placeholder={f.label}
                  onChange={(e) => setColumns({ ...columns, [f.field]: e.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

function MappingsView() {
  const q = useMigrationMappings();
  const rows = q.data ?? [];
  const columns: VColumn<MigrationMapping>[] = [
    { key: "source", header: "Source system", width: 200, render: (m) => m.sourceSystem },
    { key: "entity", header: "Entity", width: 150, render: (m) => m.entity },
    {
      key: "name",
      header: "Name",
      width: 180,
      render: (m) =>
        m.builtIn ? (
          <>
            {m.name} <span className="muted small">· ready</span>
          </>
        ) : (
          m.name
        ),
    },
    { key: "cols", header: "Mapped fields", width: 120, align: "right", render: (m) => Object.keys(m.columns).length },
    { key: "upd", header: "Updated", width: 175, render: (m) => fmtWhen(m.updatedAt) },
    {
      key: "act",
      header: "",
      width: 110,
      render: (m) => (
        <Button small onClick={() => void ask<boolean>((done) => <MappingDialog base={m} done={done} />)}>
          {m.builtIn ? "Copy" : "Edit"}
        </Button>
      ),
    },
  ];
  return (
    <div className="rate-grid-card">
      {q.isError ? (
        <div className="grid-message tone-error">{problemText(q.error)}</div>
      ) : (
        <VirtualTable<MigrationMapping>
          label="Column mappings"
          rows={rows}
          columns={columns}
          rowKey={(m) => String(m.id)}
          empty={q.isPending ? "Loading…" : "No mapping"}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- page

export function MigrationPage() {
  const { view, id, go } = useMigNav();
  return (
    <div className="page team-page">
      <PageHeader
        page={page}
        actions={
          <>
            {view === "mappings" && (
              <Button
                icon="plus"
                onClick={() => void ask<boolean>((done) => <MappingDialog base={null} done={done} />)}
              >
                New mapping
              </Button>
            )}
            <Button
              icon="download"
              onClick={() =>
                void ask<MigrationExport>((done) => <ExportDialog done={done} />).then((x) => x && go("exports", x.id))
              }
            >
              New export
            </Button>
            <Button
              variant="primary"
              icon="upload"
              onClick={() =>
                void ask<MigrationImport>((done) => <ImportDialog existing={null} done={done} />).then(
                  (i) => i && go("imports", i.id),
                )
              }
            >
              New import
            </Button>
          </>
        }
      />
      <div className="rm-trunk">
        <div className="segmented small" role="radiogroup" aria-label="Migration view">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              role="radio"
              aria-checked={view === v.key}
              className={view === v.key ? "on" : ""}
              onClick={() => go(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      {view === "imports" && <ImportsView id={id} select={(x) => go("imports", x)} />}
      {view === "exports" && <ExportsView id={id} select={(x) => go("exports", x)} />}
      {view === "mappings" && <MappingsView />}
    </div>
  );
}
