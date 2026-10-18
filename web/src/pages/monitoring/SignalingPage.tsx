// Signaling Deck and PCAP Trace (§9.2): start an SMPP capture with Filter (IP address or range), Max
// Duration (s) and Max File Size (bytes); captured trace files list with Sr. No., File Name, File
// Size, Download and Update Time (UTC). Running captures refresh every 2 s.
import { useState } from "react";
import type { SignalingCaptureRow } from "@sms/contract";
import { downloadCapture, useStartCapture, useStopCapture } from "../../api/observation";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { toast } from "../../ui/feedback";
import { Button, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen } from "../reference/shared";
import { fmtBytes, jobTone } from "./monitorModel";
import { useAutoRefresh } from "./parts";

const page = pageForPath("/monitoring/signaling")!;
const muted = (v: string) => <span className="muted">{v}</span>;
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
  const stop = useStopCapture();
  useAutoRefresh(2000);
  return (
    <ListScreen<SignalingCaptureRow>
      list="signaling_captures"
      page={page}
      noSelection
      historyScope={null}
      above={<StartBar />}
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
                <dt>Limits</dt>
                <dd>
                  {r.maxDurationSeconds} s or {fmtBytes(r.maxFileSizeBytes)}, whichever comes first
                </dd>
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
