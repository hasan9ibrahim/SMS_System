// Route Simulator (§9.2): Customer Trunk ID, Sender ID, Receiver ID, MCCMNC, Source / Dest TON and
// NPI, Service Type Routing, Message Text, Test SMS and Data coding (0–8), with the live counter
// (coding, SMS per message, size). Go shows what the switch would do: the trunk's translation rules
// and HLR rule, the destination and customer rate, the route rules tried, the chosen vendor with its
// cost and the margin. Test SMS also sends it (simulated outcome in this phase).
import { useState } from "react";
import type { RouteSimulatorResult, TrunkListRow } from "@sms/contract";
import { runRouteSimulator } from "../../api/observation";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { ListLookup } from "../../records/parts";
import { usePageStatus } from "../../shell/tabContext";
import { toast } from "../../ui/feedback";
import { Button, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { messageEncoding, msgStatusTone, needsUcs2 } from "./monitorModel";

const page = pageForPath("/routing/simulator")!;
const TON = [
  "0 Unknown",
  "1 International",
  "2 National",
  "3 Network specific",
  "4 Subscriber",
  "5 Alphanumeric",
  "6 Abbreviated",
];
const NPI: [number, string][] = [
  [0, "0 Unknown"],
  [1, "1 ISDN (E.164)"],
  [3, "3 Data"],
  [4, "4 Telex"],
  [6, "6 Land mobile"],
  [8, "8 National"],
  [9, "9 Private"],
  [10, "10 ERMES"],
  [14, "14 Internet"],
  [18, "18 WAP"],
];
const CODINGS = [
  "0 SMSC default (GSM 7-bit)",
  "1 IA5 (ASCII)",
  "2 8-bit binary",
  "3 Latin-1",
  "4 8-bit binary",
  "5 JIS",
  "6 Cyrillic",
  "7 Latin/Hebrew",
  "8 UCS-2",
];
const money = (v: number | null | undefined, ccy?: string) =>
  v === null || v === undefined ? "—" : `${v.toFixed(6)}${ccy ? ` ${ccy}` : ""}`;

function Result({ r }: { r: RouteSimulatorResult }) {
  const d = r.route.decision;
  return (
    <div className="rs-result">
      <div className={`rs-verdict ${r.blocked ? "tone-bad" : "tone-ok"}`}>
        <StatusDot tone={r.blocked ? "error" : "good"} />{" "}
        {r.blocked ? (
          <strong>{r.blocked}</strong>
        ) : (
          <strong>
            Routes to {d!.vendor!.name} ({d!.vendor!.decidedBy}, level {d!.vendor!.level}) · cost{" "}
            {money(r.vendorCost?.rate, r.vendorCost?.currency)} · margin{" "}
            {r.marginPct === null ? "—" : `${r.marginPct} %`}
          </strong>
        )}
        {r.testSms && (
          <span className="rs-test">
            Test SMS <span className="num">{r.testSms.messageId}</span>:{" "}
            <StatusDot tone={msgStatusTone(r.testSms.status)} /> {r.testSms.status} · {r.testSms.detail}
          </span>
        )}
      </div>
      <div className="rs-cards">
        <section className="card">
          <h3>Translation · {r.trunk.name}</h3>
          <dl className="kv">
            <dt>Sender</dt>
            <dd>
              {r.translation.before.sender || "—"}
              {r.translation.after.sender !== r.translation.before.sender && (
                <>
                  {" "}
                  → <strong>{r.translation.after.sender}</strong>
                </>
              )}
            </dd>
            <dt>Receiver</dt>
            <dd>
              {r.translation.before.receiver}
              {r.translation.after.receiver !== r.translation.before.receiver && (
                <>
                  {" "}
                  → <strong>{r.translation.after.receiver}</strong>
                </>
              )}
            </dd>
            <dt>Rules</dt>
            <dd>
              {r.translation.steps.length
                ? r.translation.steps.map((s) => (
                    <div key={s.ruleId} className="small">
                      <StatusDot tone={s.blocked ? "error" : s.fired ? "accent" : "neutral"} /> {s.name}{" "}
                      <span className="muted">
                        {s.blocked ? "blocked" : s.fired ? "changed the message" : s.matched ? "matched" : "no match"}
                      </span>
                    </div>
                  ))
                : "none on this trunk"}
            </dd>
            <dt>HLR rule</dt>
            <dd>{r.translation.hlr ? `${r.translation.hlr.ruleName} → ${r.translation.hlr.providerName}` : "none"}</dd>
          </dl>
        </section>
        <section className="card">
          <h3>Destination and rate</h3>
          <dl className="kv">
            <dt>Destination</dt>
            <dd>
              {r.destination ?? "unknown"} <span className="num muted">{r.mccmnc ?? ""}</span>
            </dd>
            <dt>Customer rate</dt>
            <dd>
              {r.customerRate ? (
                <>
                  {money(r.customerRate.rate, r.customerRate.currency)}{" "}
                  <span className="muted">({r.customerRate.rateTable})</span>
                </>
              ) : (
                <span className="tone-error">no rate</span>
              )}
            </dd>
            <dt>Encoding</dt>
            <dd>
              {r.encoding.label} · {r.encoding.chars} chars · {r.encoding.segments} SMS · {r.encoding.bytes} bytes
            </dd>
          </dl>
        </section>
        <section className="card rs-wide">
          <h3>Route {d ? `· rule ${d.ruleId} (${d.outcome.replace("_", " ")})` : "· no rule matched"}</h3>
          {d && d.candidates.length > 0 && (
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Vendor trunk</th>
                  <th className="num">Level</th>
                  <th className="num">Cost</th>
                  <th className="num">Margin</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {d.candidates.map((c) => (
                  <tr
                    key={c.vendorTrunkId}
                    className={c.vendorTrunkId === d.vendor?.vendorTrunkId ? "row-current" : undefined}
                  >
                    <td>{c.name}</td>
                    <td className="num">{c.level}</td>
                    <td className="num">{money(c.cost)}</td>
                    <td className="num">{c.margin === null ? "—" : c.margin.toFixed(6)}</td>
                    <td className="small muted">{c.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <details>
            <summary className="small">Rules tried ({r.route.tried.length})</summary>
            <ol className="rs-tried">
              {r.route.tried.map((t) => (
                <li key={t.ruleId} className={t.matched ? "" : "muted"}>
                  <span className="num">#{t.ruleId}</span> {t.name} <span className="small">({t.reason})</span>
                </li>
              ))}
            </ol>
          </details>
        </section>
      </div>
    </div>
  );
}

export function RouteSimulatorPage() {
  const [trunkId, setTrunkId] = useState<number | null>(null);
  const [sender, setSender] = useState("INFO");
  const [receiver, setReceiver] = useState("447700900123");
  const [mccmnc, setMccmnc] = useState("");
  const [srcTon, setSrcTon] = useState(5);
  const [srcNpi, setSrcNpi] = useState(0);
  const [dstTon, setDstTon] = useState(1);
  const [dstNpi, setDstNpi] = useState(1);
  const [serviceType, setServiceType] = useState("");
  const [text, setText] = useState("Your verification code is 482913");
  const [coding, setCoding] = useState(0);
  const [testSms, setTestSms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RouteSimulatorResult | null>(null);
  usePageStatus({
    rows: result ? (result.blocked ? "Would be rejected" : "Would be routed") : "Fill in the message and press Go",
    shortcuts: "Enter runs",
  });
  const enc = messageEncoding(text, coding);
  const go = () => {
    if (!trunkId) return toast({ tone: "warning", message: "Choose the customer trunk" });
    setBusy(true);
    void runRouteSimulator({
      customerTrunkId: trunkId,
      senderId: sender,
      receiver: receiver.replace(/\D/g, ""),
      mccmnc: mccmnc.trim() || null,
      sourceTon: srcTon,
      sourceNpi: srcNpi,
      destTon: dstTon,
      destNpi: dstNpi,
      serviceType: serviceType.trim() || null,
      text,
      dataCoding: coding,
      testSms,
    })
      .then(setResult)
      .catch((e) => toast({ tone: "error", message: problemText(e) }))
      .finally(() => setBusy(false));
  };
  const select = (label: string, value: number, set: (v: number) => void, options: [number, string][]) => (
    <label className="field">
      <span>{label} *</span>
      <select value={value} onChange={(e) => set(Number(e.target.value))}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="page rs-page">
      <PageHeader page={page} title="Route Simulator" />
      <form
        className="rs-form"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <div className="field rs-trunk">
          <span>Customer Trunk ID *</span>
          <ListLookup<TrunkListRow>
            list="customer_trunks"
            value={trunkId}
            onChange={(t) => setTrunkId(t?.id ?? null)}
            labelOf={(t) => `${t.id} · ${t.name}`}
            detailOf={(t) => t.enterpriseName}
            placeholder="Trunk name or enterprise…"
          />
        </div>
        <label className="field">
          <span>Sender ID</span>
          <input value={sender} maxLength={20} onChange={(e) => setSender(e.target.value)} />
        </label>
        <label className="field">
          <span>Receiver ID *</span>
          <input value={receiver} maxLength={16} inputMode="numeric" onChange={(e) => setReceiver(e.target.value)} />
        </label>
        <label className="field">
          <span>MCCMNC</span>
          <input
            value={mccmnc}
            maxLength={6}
            placeholder="from the number"
            onChange={(e) => setMccmnc(e.target.value.replace(/\D/g, ""))}
          />
        </label>
        {select(
          "Source TON",
          srcTon,
          setSrcTon,
          TON.map((l, i) => [i, l]),
        )}
        {select("Source NPI", srcNpi, setSrcNpi, NPI)}
        {select(
          "Dest TON",
          dstTon,
          setDstTon,
          TON.map((l, i) => [i, l]),
        )}
        {select("Dest NPI", dstNpi, setDstNpi, NPI)}
        <label className="field">
          <span>Service Type Routing</span>
          <input value={serviceType} maxLength={6} onChange={(e) => setServiceType(e.target.value)} />
        </label>
        {select(
          "Data coding",
          coding,
          setCoding,
          CODINGS.map((l, i) => [i, l]),
        )}
        <label className="field rs-text">
          <span>Message Text</span>
          <textarea rows={3} value={text} maxLength={1600} onChange={(e) => setText(e.target.value)} />
          <span className="rs-counter small">
            {enc.label} · {enc.chars} chars · {enc.bitsPerChar} bits per char · <strong>{enc.segments} SMS</strong> ·{" "}
            {enc.bytes} bytes
            {coding < 2 && needsUcs2(text) && (
              <span className="tone-warning"> · has characters outside GSM: use 8 UCS-2</span>
            )}
          </span>
        </label>
        <div className="rs-actions">
          <label className="toggle-inline">
            <input type="checkbox" checked={testSms} onChange={(e) => setTestSms(e.target.checked)} />
            Test SMS (also send it)
          </label>
          <Button type="submit" variant="primary" icon="play" disabled={busy}>
            Go
          </Button>
        </div>
      </form>
      {result && <Result r={result} />}
    </div>
  );
}
