// Route Simulator (§9.2): Customer Trunk ID, Sender ID, Receiver IDs, MCCMNC, Source / Dest TON and
// NPI, Message Text, Test SMS and Data coding (0–8), with the live counter (coding, SMS per message,
// size). Go shows what the switch would do: the trunk's translation rules and HLR rule, the destination
// and customer rate, the route rules tried, the chosen vendor with its cost and the margin. Test SMS
// also sends it (simulated outcome in this phase). Team trial round 1: a vendor trunk can be tested
// directly (instead of Service Type Routing), several receivers run at once, and the data coding and
// TON / NPI follow the text and the addresses until changed by hand.
import { Fragment, useState } from "react";
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
import { useDestinationTree, type TreeCountry } from "../rates/DestinationTree";
import { Icon } from "../../ui/Icon";
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

type Step = RouteSimulatorResult["translation"]["steps"][number];
/** Only the translation rules that matched (team trial round 5); the rest are counted, not listed. */
function MatchedRules({ steps, none }: { steps: Step[]; none: string }) {
  const hit = steps.filter((s) => s.matched || s.fired || s.blocked);
  const missed = steps.length - hit.length;
  if (!steps.length) return <>{none}</>;
  return (
    <>
      {hit.map((s) => (
        <div key={s.ruleId} className="small">
          <StatusDot tone={s.blocked ? "error" : s.fired ? "accent" : "neutral"} /> {s.name}{" "}
          <span className="muted">{s.blocked ? "blocked" : s.fired ? "changed the message" : "matched"}</span>
        </div>
      ))}
      {!hit.length && <span className="muted small">No rule matched</span>}
      {missed > 0 && (
        <div className="muted small">
          {missed} other rule{missed === 1 ? "" : "s"} did not match
        </div>
      )}
    </>
  );
}

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
              <MatchedRules steps={r.translation.steps} none="none on this trunk" />
            </dd>
            <dt>HLR rule</dt>
            <dd>{r.translation.hlr ? `${r.translation.hlr.ruleName} → ${r.translation.hlr.providerName}` : "none"}</dd>
          </dl>
        </section>
        {r.egressSkipped.length > 0 && (
          <section className="card">
            <h3>Vendors skipped</h3>
            <p className="muted small">
              Their own vendor translation rules block this message, so the next vendor was tried.
            </p>
            <dl className="kv">
              {r.egressSkipped.map((x) => (
                <Fragment key={x.vendorTrunkId}>
                  <dt>{x.vendorTrunk}</dt>
                  <dd>
                    <StatusDot tone="error" /> blocked by{" "}
                    {x.result.steps
                      .filter((st) => st.blocked)
                      .map((st) => st.name)
                      .join(", ") || "a rule"}
                  </dd>
                </Fragment>
              ))}
            </dl>
          </section>
        )}
        {r.vendorTranslation && <VendorTranslation v={r.vendorTranslation} />}
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

/** Egress translation (§6.4, §13.2): what the chosen vendor trunk's rules do after routing. */
function VendorTranslation({ v }: { v: NonNullable<RouteSimulatorResult["vendorTranslation"]> }) {
  const { before, after, steps } = v.result;
  const change = (a: string, b: string) => (
    <>
      {a || "—"}
      {b !== a && (
        <>
          {" "}
          → <strong>{b || "—"}</strong>
        </>
      )}
    </>
  );
  return (
    <section className="card">
      <h3>Vendor translation · {v.vendorTrunk}</h3>
      <dl className="kv">
        <dt>Sender</dt>
        <dd>{change(before.sender, after.sender)}</dd>
        <dt>Receiver</dt>
        <dd>{change(before.receiver, after.receiver)}</dd>
        {after.text !== before.text && (
          <>
            <dt>Text</dt>
            <dd>
              <strong>{after.text}</strong>
            </dd>
          </>
        )}
        <dt>Rules</dt>
        <dd>
          <MatchedRules steps={steps} none="none on this vendor trunk" />
        </dd>
      </dl>
      <p className="muted small">
        What the vendor receives. Routing and the customer rate use the message before this step.
      </p>
    </section>
  );
}

/** At most this many networks per Destination run (team trial round 5). */
const MAX_DESTS = 5;

/**
 * Destination picks for the simulator (team trial round 5): a whole country ticked stands for its All networks
 * (default) code only, so it gives one result, not one per network; at most MAX_DESTS networks.
 */
function simDests(tree: TreeCountry[], picked: string[]): string[] {
  const sel = new Set(picked);
  const out: string[] = [];
  for (const c of tree) {
    const mine = c.codes.filter((x) => sel.has(x.mccmnc));
    if (!mine.length) continue;
    const def = c.codes.find((x) => x.allNetworks);
    if (def && mine.length === c.codes.length) out.push(def.mccmnc);
    else out.push(...mine.map((x) => x.mccmnc));
  }
  return out;
}

function SimDestinationPick({ value, onChange }: { value: string[]; onChange: (codes: string[]) => void }) {
  const { tree } = useDestinationTree();
  return (
    <DestinationPick
      value={value}
      onChange={(codes) => {
        const next = simDests(tree, codes);
        if (next.length > MAX_DESTS && next.length > value.length)
          return toast({ tone: "warning", message: `At most ${MAX_DESTS} networks at once` });
        onChange(next);
      }}
    />
  );
}

const tonLabel = (v: number) => TON[v] ?? String(v);
const npiLabel = (v: number) => NPI.find(([n]) => n === v)?.[1] ?? String(v);

export function RouteSimulatorPage() {
  const [trunk, setTrunk] = useState<TrunkListRow | null>(null);
  const trunkId = trunk?.id ?? null;
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
  const [vendor, setVendor] = useState<TrunkListRow | null>(null);
  const vendorId = vendor?.id ?? null;
  // Hand-set values stop following the text and the addresses.
  const [touched, setTouched] = useState({ coding: false, src: false, dst: false });
  const [text, setText] = useState("Your verification code is 482913");
  const [coding, setCoding] = useState(0);
  const [testSms, setTestSms] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ receiver: string; r: RouteSimulatorResult | null; error?: string }[]>([]);
  const routed = results.filter((x) => x.r && !x.r.blocked).length;
  usePageStatus({
    rows: results.length ? `${routed} of ${results.length} would be routed` : "Fill in the message and simulate",
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
  const perSms = effCoding === 8 ? (enc.segments > 1 ? 67 : 70) : effCoding < 2 ? (enc.segments > 1 ? 153 : 160) : 140;
  const isAuto = !touched.coding && !touched.src && !touched.dst;
  const go = async () => {
    if (!trunkId) return toast({ tone: "warning", message: "Choose the customer trunk" });
    if (!runs.length)
      return toast({
        tone: "warning",
        message: mode === "numbers" ? "Enter at least one receiver" : "Pick at least one destination",
      });
    if (mode === "numbers" && runs.length > 20)
      return toast({ tone: "warning", message: "At most 20 numbers at once" });
    if (mode === "destinations" && runs.length > MAX_DESTS)
      return toast({ tone: "warning", message: `At most ${MAX_DESTS} networks at once` });
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
        {label}
        {auto && <span className="muted small"> (auto)</span>}
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
  const to =
    mode === "numbers"
      ? list.length > 1
        ? `${list[0]} +${list.length - 1}`
        : list[0] || "—"
      : dests.length
        ? `${dests.length} destination${dests.length === 1 ? "" : "s"}`
        : "—";
  // The page in two columns (team trial round 5): numbered input cards on the left; a summary with the run button
  // and, under it, the route step by step on the right.
  return (
    <div className="page rs-page">
      <PageHeader page={page} title="Route simulator" />
      <form
        className="sim-layout"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <div className="sim-main">
          <section className="sim-card">
            <h2 className="sim-step">
              <span className="sim-num">1</span> Who is sending
            </h2>
            <div className="sim-grid">
              <div className="field">
                <span>
                  Customer trunk <span className="req">*</span>
                </span>
                <ListLookup<TrunkListRow>
                  list="customer_trunks"
                  value={trunkId}
                  onChange={setTrunk}
                  labelOf={(t) => `${t.id} · ${t.name}`}
                  detailOf={(t) => t.enterpriseName}
                  placeholder="Search trunk name or enterprise…"
                />
              </div>
              <label className="field">
                <span>Sender ID</span>
                <input value={sender} maxLength={20} onChange={(e) => setSender(e.target.value)} />
              </label>
            </div>
          </section>
          <section className="sim-card">
            <h2 className="sim-step">
              <span className="sim-num">2</span> Send to
              <span className="segmented sim-seg" role="radiogroup" aria-label="Send to">
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
            </h2>
            {mode === "numbers" ? (
              <div className="sim-grid">
                <label className="field">
                  <span>
                    Numbers <span className="req">*</span>
                  </span>
                  <input
                    value={receivers}
                    maxLength={400}
                    placeholder="447700900123, 33612345678"
                    onChange={(e) => setReceivers(e.target.value)}
                  />
                  <span className="muted small">
                    {list.length > 1 ? `${list.length} numbers` : "Comma-separated, up to 20"}
                  </span>
                </label>
                <label className="field">
                  <span>MCCMNC</span>
                  <input
                    value={mccmnc}
                    maxLength={6}
                    placeholder="Detected from the number"
                    onChange={(e) => setMccmnc(e.target.value.replace(/\D/g, ""))}
                  />
                  <span className="muted small">Leave empty to detect it automatically</span>
                </label>
              </div>
            ) : (
              <div className="field">
                <SimDestinationPick value={dests} onChange={setDests} />
                <span className="muted small">
                  Up to {MAX_DESTS} networks; a whole country is its All networks (default) entry. A test number is made
                  from each one&apos;s dial code.
                </span>
              </div>
            )}
          </section>
          <section className="sim-card">
            <h2 className="sim-step">
              <span className="sim-num">3</span> Message
            </h2>
            <textarea
              className="sim-text"
              rows={3}
              value={text}
              maxLength={1600}
              aria-label="Message text"
              onChange={(e) => setText(e.target.value)}
            />
            <div className="tag-row sim-counter">
              <span className="chip-tag green">{enc.segments} SMS</span>
              <span className="chip-tag">{enc.label.replace(" (SMSC default)", "")}</span>
              <span className="chip-tag">
                {enc.chars} / {perSms * enc.segments} chars
              </span>
              <span className="chip-tag">{enc.bytes} bytes</span>
              {effCoding < 2 && needsUcs2(text) && (
                <span className="chip-tag amber">Characters outside GSM: use UCS-2</span>
              )}
            </div>
          </section>
          <section className="sim-card">
            <h2 className="sim-step">
              <span className="sim-num">4</span> Vendor
            </h2>
            <div className="field">
              <span>Vendor trunk (test directly, skips routing)</span>
              <ListLookup<TrunkListRow>
                list="vendor_trunks"
                value={vendorId}
                onChange={setVendor}
                labelOf={(t) => `${t.id} · ${t.name}`}
                detailOf={(t) => t.enterpriseName}
                placeholder="Any (by the route rules)"
                limit={1000}
              />
              <span className="muted small">
                Empty = by the route rules. Every vendor trunk is listed; type to narrow.
              </span>
            </div>
          </section>
          <section className="sim-card">
            <div className="sim-adv-head">
              <div>
                <h2 className="sim-step">Advanced settings</h2>
                <p className="muted small">
                  {isAuto ? "Auto · " : ""}TON {tonLabel(effSrc.ton)} · NPI {npiLabel(effSrc.npi)} → TON{" "}
                  {tonLabel(effDst.ton)} · NPI {npiLabel(effDst.npi)} · coding {CODINGS[effCoding]}
                </p>
              </div>
              <button type="button" className="link" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
                {advanced ? "Hide" : "Change"}{" "}
                <Icon name="chevronDown" size={12} className={advanced ? "flip" : undefined} />
              </button>
            </div>
            {advanced && (
              <div className="sim-grid four">
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
                {select(
                  "Data coding",
                  effCoding,
                  (v) => (setCoding(v), setTouched((t) => ({ ...t, coding: true }))),
                  CODINGS.map((l, i) => [i, l]),
                  !touched.coding,
                )}
                {!isAuto && (
                  <button
                    type="button"
                    className="link sim-span4"
                    onClick={() => setTouched({ coding: false, src: false, dst: false })}
                  >
                    Back to automatic coding and TON / NPI
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
        <aside className="sim-side">
          <section className="sim-card">
            <h2 className="sim-step">Summary</h2>
            <dl className="sim-summary">
              <dt>From</dt>
              <dd>{trunk ? trunk.name : <span className="tone-error">Pick a customer trunk</span>}</dd>
              <dt>Sender ID</dt>
              <dd>{sender || "—"}</dd>
              <dt>To</dt>
              <dd className="num">{to}</dd>
              <dt>Message</dt>
              <dd>
                {enc.segments} SMS · {enc.label.replace(" (SMSC default)", "")}
              </dd>
              <dt>Vendor</dt>
              <dd>{vendor ? vendor.name : "By route rules"}</dd>
            </dl>
            <label className="sim-test">
              <input type="checkbox" checked={testSms} onChange={(e) => setTestSms(e.target.checked)} />
              <span>
                <strong>Also send a real test SMS</strong>
                <span className="muted small">Off = simulate only, nothing is sent</span>
              </span>
            </label>
            <Button type="submit" variant="primary" icon="play" disabled={busy} className="sim-go">
              {busy ? "Simulating…" : `Simulate route${runs.length > 1 ? ` (${runs.length})` : ""}`}
            </Button>
          </section>
          <section className="sim-card sim-results">
            {results.length === 0 ? (
              <div className="sim-empty">
                <Icon name="route" size={22} />
                <strong>The route shows here</strong>
                <span className="muted small">Run a simulation to see each step the message would take</span>
              </div>
            ) : (
              results.map((x) => (
                <section key={x.receiver} className="rs-one" aria-label={`Result for ${x.receiver}`}>
                  {results.length > 1 && (
                    <h2 className="rs-receiver">
                      {x.r && x.r.destination ? (
                        // Country and network first, then the MCCMNC; a number keeps its number in front.
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
              ))
            )}
          </section>
        </aside>
      </form>
    </div>
  );
}
