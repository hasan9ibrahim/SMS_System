// Network Diagnosis (§9.2): Ping, Trace Route, MTR and Telnet from the switch host, with Count,
// Destination, Source and Port. Output shows as the tool prints it; the last runs stay on the page.
// The mock answers with simulated output.
import { useState } from "react";
import type { NetworkDiagnosisInput, NetworkDiagnosisResult } from "@sms/contract";
import { runNetworkDiagnosis } from "../../api/observation";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { usePageStatus } from "../../shell/tabContext";
import { toast } from "../../ui/feedback";
import { Button, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";

const page = pageForPath("/monitoring/diagnosis")!;
const TOOLS: { key: NetworkDiagnosisInput["tool"]; label: string }[] = [
  { key: "ping", label: "Ping" },
  { key: "traceroute", label: "Trace Route" },
  { key: "mtr", label: "MTR" },
  { key: "telnet", label: "Telnet" },
];

export function NetworkDiagnosisPage() {
  const [tool, setTool] = useState<NetworkDiagnosisInput["tool"]>("ping");
  const [destination, setDestination] = useState("");
  const [source, setSource] = useState("");
  const [port, setPort] = useState(2775);
  const [count, setCount] = useState(4);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<(NetworkDiagnosisResult & { at: string })[]>([]);
  usePageStatus({
    rows: runs.length ? `${runs.length} run${runs.length === 1 ? "" : "s"} on this page` : "No runs yet",
    shortcuts: "Enter runs",
  });
  const go = () => {
    setBusy(true);
    void runNetworkDiagnosis({
      tool,
      destination: destination.trim(),
      source: source.trim() || null,
      port: tool === "telnet" ? port : null,
      count,
    })
      .then((r) => setRuns((xs) => [{ ...r, at: new Date().toISOString() }, ...xs].slice(0, 10)))
      .catch((e) => toast({ tone: "error", message: problemText(e) }))
      .finally(() => setBusy(false));
  };
  return (
    <div className="page diag-page">
      <PageHeader page={page} />
      <form
        className="diag-form"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <div className="field">
          <span>Tool</span>
          <div className="segmented small" role="radiogroup" aria-label="Tool">
            {TOOLS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="radio"
                aria-checked={tool === t.key}
                className={tool === t.key ? "on" : ""}
                onClick={() => setTool(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <label className="field diag-dest">
          <span>Destination *</span>
          <input
            value={destination}
            placeholder="Host name or IP, e.g. 198.51.100.20"
            onChange={(e) => setDestination(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Source</span>
          <input value={source} placeholder="Switch IP (optional)" onChange={(e) => setSource(e.target.value)} />
        </label>
        {tool === "telnet" ? (
          <label className="field">
            <span>Port *</span>
            <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </label>
        ) : (
          <label className="field">
            <span>Count</span>
            <input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </label>
        )}
        <Button type="submit" variant="primary" icon="play" disabled={busy || !destination.trim()}>
          Go
        </Button>
      </form>
      <div className="diag-runs">
        {runs.length === 0 && (
          <p className="muted small">
            Runs from the switch host show here. Nothing leaves the switch until you press Go.
          </p>
        )}
        {runs.map((r, i) => (
          <section key={`${r.at}-${i}`} className="card diag-run">
            <div className="diag-head">
              <StatusDot tone={r.exitCode === 0 ? "good" : "error"} /> <code>{r.command}</code>
              <span className="fb-spacer" />
              <span className="muted small">
                exit {r.exitCode} · {(r.durationMs / 1000).toFixed(1)} s · {r.at.slice(11, 19)} UTC
              </span>
            </div>
            <pre className="terminal">{r.lines.join("\n")}</pre>
          </section>
        ))}
      </div>
    </div>
  );
}
