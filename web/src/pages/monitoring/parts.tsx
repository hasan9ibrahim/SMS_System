// Shared pieces of the Observation Deck pages (§9): view tabs in the tab URL, auto refresh while
// jobs run, the download request dialog, and the EDR / Failed EDR download list (§9.2, §12.4).
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import type { EdrDownloadRow, ListQuery } from "@sms/contract";
import { fetchListPage } from "../../api/hooks";
import { downloadEdrFile, useCancelEdrDownload, useEdrTemplates, useRequestEdrDownload } from "../../api/observation";
import { useRefreshRecords } from "../../api/records";
import { toListQuery, type GridState } from "../../grid/filterModel";
import type { PageDef } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useTabNavigate } from "../../shell/tabContext";
import { toast } from "../../ui/feedback";
import { Button, Modal, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen } from "../reference/shared";
import { fmtBytes, jobTone } from "./monitorModel";

const muted = (v: string) => <span className="muted">{v}</span>;

/** `?view=` of the tab; the first view has no parameter. */
export function useView<V extends string>(path: string, views: readonly V[], param = "view"): [V, (v: V) => void] {
  const location = useLocation();
  const navigate = useTabNavigate();
  const raw = new URLSearchParams(location.search).get(param) as V | null;
  const view = raw && views.includes(raw) ? raw : views[0]!;
  return [view, (v) => navigate(`${path}${v === views[0] ? "" : `?${param}=${v}`}`)];
}

export function ViewTabs<V extends string>({
  label,
  views,
  value,
  onChange,
}: {
  label: string;
  views: { key: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <div className="segmented small" role="tablist" aria-label={label}>
      {views.map((v) => (
        <button
          key={v.key}
          type="button"
          role="tab"
          aria-selected={value === v.key}
          className={value === v.key ? "on" : ""}
          onClick={() => onChange(v.key)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

/** Refreshes lists and records every `ms` while the page is shown (live status, running jobs). */
export function useAutoRefresh(ms: number, enabled = true) {
  const refresh = useRefreshRecords();
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => void refresh(), ms);
    return () => clearInterval(t);
  }, [ms, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** EDR Request / Failed EDR Request: the current filters, a file type and (EDRs) a template. */
export function RequestDialog({
  kind,
  state,
  done,
}: {
  kind: "edr" | "failed_edr";
  state: GridState;
  done: () => void;
}) {
  const templates = useEdrTemplates();
  const [fileType, setFileType] = useState<"csv" | "xlsx">("csv");
  const [templateId, setTemplateId] = useState<number | null>(null);
  const request = useRequestEdrDownload();
  const navigate = useTabNavigate();
  const target = kind === "edr" ? "/monitoring/edr-download" : "/monitoring/failed-edr?view=downloads";
  return (
    <Modal
      title={kind === "edr" ? "EDR Download Request" : "Failed EDR Request"}
      width={520}
      onClose={done}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            icon="download"
            disabled={request.isPending}
            onClick={() =>
              request.mutate(
                { kind, query: toListQuery(state), fileType, templateId, columns: templateId ? null : state.visible },
                {
                  onSuccess: (d) => {
                    toast({ tone: "good", message: `Request ${d.id} queued · ${d.filterSummary}` });
                    done();
                    // A new tab, so the page the request came from keeps its period and filters (team trial round 6).
                    navigate(target, { newTab: true });
                  },
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                },
              )
            }
          >
            {kind === "edr" ? "Request" : "Generate Request"}
          </Button>
        </>
      }
    >
      <div className="field">
        <span>Download File Type</span>
        <div className="segmented small" role="radiogroup" aria-label="File type">
          {(["csv", "xlsx"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={fileType === t}
              className={fileType === t ? "on" : ""}
              onClick={() => setFileType(t)}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {kind === "edr" && (
        <label className="field">
          <span>EDR Template</span>
          <select
            value={templateId ?? ""}
            onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">The columns shown now</option>
            {templates.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </Modal>
  );
}

const download = (id: number) =>
  void downloadEdrFile(id).catch((e) => toast({ tone: "error", message: problemText(e) }));

/** EDR Download / Failed EDR Download (§9.2): background exports with progress, file and cancel. */
export function DownloadsList({
  kind,
  page,
  title,
  above,
}: {
  kind: "edr" | "failed_edr";
  page: PageDef;
  title?: string;
  above?: React.ReactNode;
}) {
  const cancel = useCancelEdrDownload();
  useAutoRefresh(3000);
  const withKind = (body: ListQuery): ListQuery => ({
    ...body,
    filter: {
      logic: "and",
      conditions: [{ field: "kind", op: "eq", value: kind }, ...(body.filter ? [body.filter] : [])],
    },
  });
  const stop = (id: number) => cancel.mutate(id, { onError: (e) => toast({ tone: "error", message: problemText(e) }) });
  return (
    <ListScreen<EdrDownloadRow>
      key={kind}
      list="edr_downloads"
      page={page}
      title={title}
      queryScope={kind}
      fetchPage={(body) => fetchListPage<EdrDownloadRow>("edr_downloads", withKind(body))}
      noSelection
      historyScope={null}
      above={above}
      columns={{
        id: { width: 90 },
        status: {
          width: 170,
          render: (r) => (
            <span className="job-status">
              <StatusDot tone={jobTone(r.status)} />{" "}
              {r.status === "inprogress" ? "In progress" : r.status[0]!.toUpperCase() + r.status.slice(1)}
              {r.status === "inprogress" && (
                <span className="progress" aria-label={`${r.progress} %`}>
                  <span style={{ width: `${r.progress}%` }} />
                </span>
              )}
            </span>
          ),
        },
        fileName: {
          width: 190,
          render: (r) =>
            r.status === "success" ? (
              <button type="button" className="link" onClick={() => download(r.id)}>
                {r.fileName}
              </button>
            ) : (
              muted("—")
            ),
        },
        fileType: { width: 90, render: (r) => r.fileType.toUpperCase() },
        progress: { width: 90, align: "right", render: (r) => <span className="num">{r.progress} %</span> },
        rows: {
          width: 110,
          align: "right",
          render: (r) => (r.rows === null ? muted("—") : <span className="num">{r.rows.toLocaleString("en-US")}</span>),
        },
        filterSummary: { width: 380, render: (r) => <span title={r.filterSummary}>{r.filterSummary}</span> },
        requestedAt: { width: 170, render: (r) => fmtWhen(r.requestedAt) },
        finishedAt: { width: 170, render: (r) => fmtWhen(r.finishedAt) },
        error: {
          width: 260,
          render: (r) =>
            r.error ? (
              <span className="tone-error" title={r.error}>
                {r.error}
              </span>
            ) : (
              muted("—")
            ),
        },
        requestedBy: { width: 130, render: (r) => r.requestedBy ?? muted("—") },
      }}
      rowActions={(r) => [
        {
          label: "Download",
          icon: "download",
          main: true,
          disabled: r.status !== "success",
          hint: r.status === "success" ? undefined : "The file is ready once the request succeeds",
          onSelect: () => download(r.id),
        },
        {
          label: "Cancel",
          icon: "x",
          disabled: r.status !== "pending" && r.status !== "inprogress",
          hint:
            r.status === "pending" || r.status === "inprogress"
              ? "Stop this request"
              : "Only pending or running requests can be cancelled",
          onSelect: () => stop(r.id),
        },
      ]}
      trailing={{
        header: "Action",
        // Fits the small Download button with its icon (design QA round 13).
        width: 128,
        render: (r) =>
          r.status === "success" ? (
            <Button small icon="download" onClick={() => download(r.id)}>
              Download
            </Button>
          ) : r.status === "pending" || r.status === "inprogress" ? (
            <Button small onClick={() => stop(r.id)}>
              Cancel
            </Button>
          ) : null,
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>
              {kind === "edr" ? "EDR" : "Failed EDR"} No {r.id}
            </strong>
            <span className="muted">
              {r.fileType.toUpperCase()} · {r.status}
            </span>
          </>
        ),
        sections: [
          {
            key: "request",
            label: "Request",
            content: (
              <dl className="kv">
                <dt>Filters</dt>
                <dd>{r.filterSummary}</dd>
                <dt>Columns</dt>
                <dd>{r.template ?? "As shown when requested"}</dd>
                <dt>Rows</dt>
                <dd>{r.rows === null ? "—" : r.rows.toLocaleString("en-US")}</dd>
                <dt>Size</dt>
                <dd>{r.sizeBytes === null ? "—" : fmtBytes(r.sizeBytes)}</dd>
                <dt>Requested</dt>
                <dd>
                  {fmtWhen(r.requestedAt)} by {r.requestedBy ?? "—"}
                </dd>
                <dt>Finished</dt>
                <dd>{fmtWhen(r.finishedAt)}</dd>
                {r.error && (
                  <>
                    <dt>Error</dt>
                    <dd className="tone-error">{r.error}</dd>
                  </>
                )}
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · refreshes every 3 s"
    />
  );
}
