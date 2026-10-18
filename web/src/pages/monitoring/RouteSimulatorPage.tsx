// Route Simulator (§9.2): Customer Trunk ID, Sender ID, Receiver IDs, MCCMNC, Source / Dest TON and
// NPI, Message Text, Test SMS and Data coding (0–8), with the live counter (coding, SMS per message,
// size). Go shows what the switch would do: the trunk's translation rules and HLR rule, the destination
// and customer rate, the route rules tried, the chosen vendor with its cost and the margin. Test SMS
// also sends it (simulated outcome in this phase). Team trial round 1: a vendor trunk can be tested
// directly (instead of Service Type Routing), several receivers run at once, and the data coding and
// TON / NPI follow the text and the addresses until changed by hand.
import { useState } from "react";
import type { RouteSimulatorResult, TrunkListRow } from "@sms/contract";
import { autoCoding, autoTonNpi, parseReceivers } from "./monitorModel";
import { runRouteSimulator } from "../../api/observation";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { ListLookup } from "../../records/parts";
import { usePageStatus } from "../../shell/tabContext";
import { toast } from "../../ui/feedback";
import { Button, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { DestinationPick } from "../routing/pickers";
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
  const forced = r.forcedVendor;
  return (
    <div className="rs-result">
      <div className={`rs-verdict ${r.blocked ? "tone-bad" : "tone-ok"}`}>
        <StatusDot tone={r.blocked ? "error" : "good"} />{" "}
        {r.blocked ? (
          <strong>{r.blocked}</strong>
        ) : forced ? (
          <strong>
            Sent straight to {forced.name} (routing skipped) · cost {money(forced.rate, forced.currency ?? undefined)} ·
            margin {r.marginPct === null ? "—" : `${r.marginPct} %`}
          </strong>
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
          <h3>
            Route {d ? `· rule ${d.ruleId} (${d.outcome.replace("_", " ")})` : "· no rule matched"}
            {forced && <span className="muted small"> · shown for reference; the test went to {forced.name}</span>}
          </h3>
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
  const [receivers, setReceivers] = useState("447700900123");
  // Send to numbers, or just pick destinations: a test number is made from each network's dial code.
  const [mode, setMode] = useState<"numbers" | "destinations">("numbers");
  const [dests, setDests] = useState<string[]>([]);
  const [mccmnc, setMccmnc] = useState("");
  const [srcTon, setSrcTon] = useState(5);
  const [srcNpi, setSrcNpi] = useState(0);
  const [dstTon, setDstTon] = useState(1);
  const [dstNpi, setDstNpi] = useState(1);
  const [vendorId, setVendorId] = useState<number | null>(null);
  // Hand-set values stop following the text and the addresses.
  const [touched, setTouched] = useState({ coding: false, src: false, dst: false });
  const [text, setText] = useState("Your verification code is 482913");
  const [coding, setCoding] = useState(0);
  const [testSms, setTestSms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ receiver: string; r: RouteSimulatorResult | null; error?: string }[]>([]);
  const routed = results.filter((x) => x.r && !x.r.blocked).length;
  usePageStatus({
    rows: results.length ? `${routed} of ${results.length} would be routed` : "Fill in the message and press Go",
    shortcuts: "Enter runs",
  });
  const list = parseReceivers(receivers);
  const runs =
    mode === "numbers"
      ? list.map((r) => ({ key: r, receiver: r, mccmnc: null }))
      : dests.map((d) => ({ key: d, receiver: null, mccmnc: d }));
  // Auto values: coding from the text, TON / NPI from the sender and the first receiver.
  const autoSrc = autoTonNpi(sender);
  const autoDst = autoTonNpi(list[0] ?? "");
  const effCoding = touched.coding ? coding : autoCoding(text);
  const effSrc = touched.src ? { ton: srcTon, npi: srcNpi } : autoSrc;
  const effDst = touched.dst ? { ton: dstTon, npi: dstNpi } : autoDst;
  const enc = messageEncoding(text, effCoding);
  const go = async () => {
    if (!trunkId) return toast({ tone: "warning", message: "Choose the customer trunk" });
    if (!runs.length)
      return toast({
        tone: "warning",
        message: mode === "numbers" ? "Enter at least one receiver" : "Pick at least one destination",
      });
    if (runs.length > 20) return toast({ tone: "warning", message: "At most 20 at once" });
    setBusy(true);
    const out: typeof results = [];
    for (const run of runs) {
      const receiver = run.receiver ?? "";
      try {
        const r = await runRouteSimulator({
          customerTrunkId: trunkId,
          senderId: sender,
          ...(run.receiver ? { receiver: run.receiver } : {}),
          mccmnc: run.mccmnc ?? (mccmnc.trim() || null),
          sourceTon: effSrc.ton,
          sourceNpi: effSrc.npi,
          destTon: touched.dst ? dstTon : autoTonNpi(receiver || "447000000000").ton,
          destNpi: touched.dst ? dstNpi : autoTonNpi(receiver || "447000000000").npi,
          vendorTrunkId: vendorId,
          text,
          dataCoding: effCoding,
          testSms,
        });
        out.push({ receiver: run.key, r });
      } catch (e) {
        out.push({ receiver: run.key, r: null, error: problemText(e) });
      }
      setResults([...out]);
    }
    setBusy(false);
  };
  const select = (
    label: string,
    value: number,
    set: (v: number) => void,
    options: [number, string][],
    auto = false,
  ) => (
    <label className="field">
      <span>
        {label} *{auto && <span className="muted small"> (auto)</span>}
      </span>
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
          void go();
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
        <div className="field rs-receivers">
          <span>
            Send to *
            <span className="segmented" role="radiogroup" aria-label="Send to">
              {(["numbers", "destinations"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  className={mode === m ? "on" : ""}
                  onClick={() => setMode(m)}
                >
                  {m === "numbers" ? "Numbers" : "Destination"}
                </button>
              ))}
            </span>
          </span>
          {mode === "numbers" ? (
            <input
              value={receivers}
              maxLength={400}
              placeholder="447700900123, 33612345678"
              aria-label="Receiver IDs"
              title="Comma-separated, up to 20"
              onChange={(e) => setReceivers(e.target.value)}
            />
          ) : (
            <DestinationPick value={dests} onChange={setDests} />
          )}
          <span className="muted small">
            {mode === "numbers"
              ? list.length > 1
                ? `${list.length} receivers`
                : "Comma-separated, up to 20"
              : "Country or network; a test number is made from its dial code"}
          </span>
        </div>
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
          effSrc.ton,
          (v) => (setSrcTon(v), setSrcNpi(effSrc.npi), setTouched((t) => ({ ...t, src: true }))),
          TON.map((l, i) => [i, l]),
          !touched.src,
        )}
        {select(
          "Source NPI",
          effSrc.npi,
          (v) => (setSrcNpi(v), setSrcTon(effSrc.ton), setTouched((t) => ({ ...t, src: true }))),
          NPI,
          !touched.src,
        )}
        {select(
          "Dest TON",
          effDst.ton,
          (v) => (setDstTon(v), setDstNpi(effDst.npi), setTouched((t) => ({ ...t, dst: true }))),
          TON.map((l, i) => [i, l]),
          !touched.dst,
        )}
        {select(
          "Dest NPI",
          effDst.npi,
          (v) => (setDstNpi(v), setDstTon(effDst.ton), setTouched((t) => ({ ...t, dst: true }))),
          NPI,
          !touched.dst,
        )}
        <div className="field rs-vendor">
          <span>Vendor trunk (test directly, skips routing)</span>
          <ListLookup<TrunkListRow>
            list="vendor_trunks"
            value={vendorId}
            onChange={(t) => setVendorId(t?.id ?? null)}
            labelOf={(t) => `${t.id} · ${t.name}`}
            detailOf={(t) => t.enterpriseName}
            placeholder="Any (by the route rules)"
          />
        </div>
        {select(
          "Data coding",
          effCoding,
          (v) => (setCoding(v), setTouched((t) => ({ ...t, coding: true }))),
          CODINGS.map((l, i) => [i, l]),
          !touched.coding,
        )}
        <label className="field rs-text">
          <span>Message Text</span>
          <textarea rows={3} value={text} maxLength={1600} onChange={(e) => setText(e.target.value)} />
          <span className="rs-counter small">
            {enc.label} · {enc.chars} chars · {enc.bitsPerChar} bits per char · <strong>{enc.segments} SMS</strong> ·{" "}
            {enc.bytes} bytes
            {effCoding < 2 && needsUcs2(text) && (
              <span className="tone-warning"> · has characters outside GSM: use 8 UCS-2</span>
            )}
          </span>
        </label>
        <div className="rs-actions">
          <label className="toggle-inline">
            <input type="checkbox" checked={testSms} onChange={(e) => setTestSms(e.target.checked)} />
            Test SMS (also send it)
          </label>
          {(touched.coding || touched.src || touched.dst) && (
            <button
              type="button"
              className="link"
              onClick={() => setTouched({ coding: false, src: false, dst: false })}
            >
              Back to automatic coding and TON / NPI
            </button>
          )}
          <Button type="submit" variant="primary" icon="play" disabled={busy}>
            Go{runs.length > 1 ? ` (${runs.length})` : ""}
          </Button>
        </div>
      </form>
      {results.map((x) => (
        <section key={x.receiver} className="rs-one" aria-label={`Result for ${x.receiver}`}>
          {results.length > 1 && (
            <h2 className="rs-receiver">
              {x.r && x.r.destination ? (
                // Country and network first, then the MCCMNC (team trial round 1); a number keeps its number in front.
                <>
                  {x.r.mccmnc === x.receiver ? "" : `${x.receiver} · `}
                  {x.r.destination} <span className="num muted">{x.r.mccmnc}</span>
                </>
              ) : (
                x.receiver
              )}
            </h2>
          )}
          {x.r ? <Result r={x.r} /> : <p className="error-text">{x.error}</p>}
        </section>
      ))}
    </div>
  );
}
