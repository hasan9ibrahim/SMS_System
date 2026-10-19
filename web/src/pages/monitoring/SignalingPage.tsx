// Signaling Deck (§9.2): start an SMPP capture with Filter (IP address or range), Max Duration (s) and Max
// File Size (bytes); trace files list with Sr. No., File Name, File Size, Download and Update Time (UTC),
// deleted 30 days after they end unless kept (team trial round 1). Running captures refresh every 2 s.
import { useState, type ReactNode } from "react";
import type { SignalingCaptureRow } from "@sms/contract";
import { fetchListPage } from "../../api/hooks";
import { downloadCapture, useKeepCapture, useStartCapture, useStopCapture } from "../../api/observation";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { toast } from "../../ui/feedback";
import { Button, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen } from "../reference/shared";
import { fmtBytes, jobTone } from "./monitorModel";
import { useAutoRefresh } from "./parts";
import { RecordingBar } from "./RecordingBar";

const page = pageForPath("/monitoring/signaling")!;
export const muted = (v: string) => <span className="muted">{v}</span>;
const download = (id: number) =>
  void downloadCapture(id).catch((e) => toast({ tone: "error", message: problemText(e) }));

function StartBar() {
  const [ip, setIp] = useState("");
  const [duration, setDuration] = useState(60);
  const [size, setSize] = useState(10 * 1024 * 1024);
  const start = useStartCapture();
  return (
    <form
      className="deck-above capture-form"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate(
          { ipFilter: ip.trim() || null, maxDurationSeconds: duration, maxFileSizeBytes: size },
          {
            onSuccess: (c) => toast({ tone: "good", message: `Capture ${c.id} started: ${c.fileName}` }),
            onError: (e) => toast({ tone: "error", message: problemText(e) }),
          },
        );
      }}
    >
      <label className="small">
        Filter
        <input value={ip} placeholder="IP address or range; empty = all SMPP" onChange={(e) => setIp(e.target.value)} />
      </label>
      <label className="small">
        Max Duration (s)
        <input
          type="number"
          min={1}
          max={3600}
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
        />
      </label>
      <label className="small">
        Max File Size (bytes)
        <input
          type="number"
          min={1024}
          max={104857600}
          step={1024}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
        />
      </label>
      <span className="muted small">{fmtBytes(size)}</span>
      <span className="fb-spacer" />
      <Button type="submit" variant="primary" icon="play" disabled={start.isPending || duration < 1 || size < 1024}>
        Start
      </Button>
    </form>
  );
}

export function SignalingPage() {
  // Live capture from now on, or extract from the 60-day recording (team trial round 1); both kinds of file
  // are listed here.
  const [mode, setMode] = useState<"live" | "extract">("live");
  return (
    <CaptureFiles
      page={page}
      above={
        <>
          <div className="segmented capture-mode" role="tablist" aria-label="New file">
            <button type="button" role="tab" className={mode === "live" ? "on" : ""} onClick={() => setMode("live")}>
              Live capture
            </button>
            <button
              type="button"
              role="tab"
              className={mode === "extract" ? "on" : ""}
              onClick={() => setMode("extract")}
            >
              Extract from the recording
            </button>
          </div>
          {mode === "live" ? <StartBar /> : <RecordingBar />}
        </>
      }
    />
  );
}

/**
 * The capture files: live captures on the Signaling deck, or files cut from the traffic recording on PCAP
 * Trace (team trial round 1). Both are deleted 30 days after they end unless kept.
 */
export function CaptureFiles({
  source,
  page,
  above,
  title,
}: {
  /** Only files of this kind; all when left out. */
  source?: SignalingCaptureRow["source"];
  page: NonNullable<ReturnType<typeof pageForPath>>;
  above: ReactNode;
  title?: string;
}) {
  const stop = useStopCapture();
  const keep = useKeepCapture();
  useAutoRefresh(2000);
  // Files are deleted 30 days after the capture ended unless kept (team trial round 1).
  const setKeep = (r: SignalingCaptureRow, on: boolean) =>
    keep.mutate(
      { id: r.id, keep: on },
      {
        onSuccess: () => toast({ tone: "good", message: on ? `${r.fileName} is kept` : `${r.fileName} will expire` }),
        onError: (e) => toast({ tone: "error", message: problemText(e) }),
      },
    );
  const expiry = (r: SignalingCaptureRow) =>
    r.keep ? (
      <span title={r.keptBy ? `Kept by ${r.keptBy}` : undefined}>Kept</span>
    ) : r.expiresAt ? (
      fmtWhen(r.expiresAt)
    ) : (
      muted("after it ends")
    );
  return (
    <ListScreen<SignalingCaptureRow>
      list="signaling_captures"
      page={page}
      {...(title ? { title } : {})}
      queryScope={source ?? "all"}
      fetchPage={(body) =>
        fetchListPage<SignalingCaptureRow>(
          "signaling_captures",
          source
            ? {
                ...body,
                filter: {
                  logic: "and",
                  conditions: [{ field: "source", op: "in", values: [source] }, ...(body.filter ? [body.filter] : [])],
                },
              }
            : body,
        )
      }
      noSelection
      historyScope={null}
      above={above}
      columns={{
        id: { width: 80 },
        fileName: {
          width: 330,
          render: (r) =>
            r.status === "failed" ? (
              r.fileName
            ) : (
              <button type="button" className="link" onClick={() => download(r.id)}>
                {r.fileName}
              </button>
            ),
        },
        ipFilter: {
          width: 160,
          render: (r) => (r.ipFilter ? <span className="num">{r.ipFilter}</span> : muted("all")),
        },
        source: {
          width: 230,
          render: (r) =>
            r.source === "recording" ? (
              <span title={r.criteria ?? "all traffic"}>
                Recording {fmtWhen(r.recordedFrom!)} – {fmtWhen(r.recordedTo!).slice(-5)}
              </span>
            ) : (
              muted("Live capture")
            ),
        },
        status: {
          width: 110,
          render: (r) => (
            <span>
              <StatusDot tone={jobTone(r.status === "running" ? "inprogress" : r.status)} />{" "}
              {r.status[0]!.toUpperCase() + r.status.slice(1)}
            </span>
          ),
        },
        sizeBytes: { width: 110, align: "right", render: (r) => <span className="num">{fmtBytes(r.sizeBytes)}</span> },
        packets: {
          width: 100,
          align: "right",
          render: (r) => <span className="num">{r.packets.toLocaleString("en-US")}</span>,
        },
        updatedAt: { width: 170, render: (r) => fmtWhen(r.updatedAt) },
        startedBy: { width: 140, render: (r) => r.startedBy ?? muted("—") },
        keep: {
          width: 70,
          render: (r) => (
            <input
              type="checkbox"
              aria-label={`Keep ${r.fileName}`}
              title={r.keep ? "Kept: never deleted automatically" : "Keep this file past 30 days"}
              checked={r.keep}
              disabled={keep.isPending}
              onChange={(e) => setKeep(r, e.target.checked)}
              onClick={(e) => e.stopPropagation()}
            />
          ),
        },
        expiresAt: { width: 170, render: expiry },
      }}
      rowActions={(r) => [
        {
          label: "Download",
          icon: "download",
          main: true,
          disabled: r.status === "failed",
          hint: r.status === "failed" ? "The capture failed: no file" : undefined,
          onSelect: () => download(r.id),
        },
        {
          label: "Stop",
          icon: "pause",
          main: true,
          disabled: r.status !== "running",
          hint: r.status === "running" ? "Stop this capture" : "Only running captures can be stopped",
          onSelect: () => stop.mutate(r.id, { onError: (e) => toast({ tone: "error", message: problemText(e) }) }),
        },
        r.keep
          ? { label: "Stop keeping", icon: "undo", onSelect: () => setKeep(r, false) }
          : { label: "Keep", icon: "check", onSelect: () => setKeep(r, true) },
      ]}
      trailing={{
        header: "Action",
        width: 110,
        render: (r) =>
          r.status === "running" ? (
            <Button
              small
              onClick={() => stop.mutate(r.id, { onError: (e) => toast({ tone: "error", message: problemText(e) }) })}
            >
              Stop
            </Button>
          ) : r.status !== "failed" ? (
            <Button small icon="download" onClick={() => download(r.id)}>
              Download
            </Button>
          ) : null,
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.fileName}</strong>
            <span className="muted">
              {r.status} · {fmtBytes(r.sizeBytes)}
            </span>
          </>
        ),
        sections: [
          {
            key: "capture",
            label: "Capture",
            content: (
              <dl className="kv">
                <dt>Filter</dt>
                <dd>{r.ipFilter ?? "all SMPP traffic"}</dd>
                {r.source === "recording" ? (
                  <>
                    <dt>From the recording</dt>
                    <dd>
                      {fmtWhen(r.recordedFrom!)} – {fmtWhen(r.recordedTo!)} UTC
                    </dd>
                    <dt>Asked for</dt>
                    <dd>{r.criteria ?? "all traffic in the window"}</dd>
                  </>
                ) : (
                  <>
                    <dt>Limits</dt>
                    <dd>
                      {r.maxDurationSeconds} s or {fmtBytes(r.maxFileSizeBytes)}, whichever comes first
                    </dd>
                  </>
                )}
                <dt>Captured</dt>
                <dd>
                  {r.packets.toLocaleString("en-US")} packets · {fmtBytes(r.sizeBytes)}
                </dd>
                <dt>Started</dt>
                <dd>
                  {fmtWhen(r.startedAt)} by {r.startedBy ?? "—"}
                </dd>
                <dt>Updated</dt>
                <dd>{fmtWhen(r.updatedAt)}</dd>
                <dt>Deleted on</dt>
                <dd>
                  {expiry(r)}
                  {r.keep && r.keptBy ? <span className="muted"> by {r.keptBy}</span> : null}{" "}
                  <button type="button" className="link" onClick={() => setKeep(r, !r.keep)}>
                    {r.keep ? "Stop keeping" : "Keep this file"}
                  </button>
                </dd>
                <dt>Opens in</dt>
                <dd>Wireshark (libpcap, SMPP on port 2775)</dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · running captures refresh every 2 s"
    />
  );
}
