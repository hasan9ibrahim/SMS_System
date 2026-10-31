// Route Simulator (§9.2): Customer Trunk ID, Sender ID, Receiver IDs, MCCMNC, Source / Dest TON and
// NPI, Message Text, Test SMS and Data coding (0–8), with the live counter (coding, SMS per message,
// size). Go shows what the switch would do: the trunk's translation rules and HLR rule, the destination
// and customer rate, the route rules tried, the chosen vendor with its cost and the margin. Test SMS
// also sends it (simulated outcome in this phase). Team trial round 1: a vendor trunk can be tested
// directly (instead of Service Type Routing), several receivers run at once, and the data coding and
// TON / NPI follow the text and the addresses until changed by hand.
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouteRule } from "../../api/routing";
import type { RouteSimulatorResult, TrunkListRow } from "@sms/contract";
import { autoCoding, autoTonNpi, parseReceivers, receiverProblem } from "./monitorModel";
import { runRouteSimulator } from "../../api/observation";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { ListLookup } from "../../records/parts";
import { usePageStatus } from "../../shell/tabContext";
import { toast } from "../../ui/feedback";
import { Button, Popover, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { codeChips, DestinationTree, useDestinationTree, type TreeCountry } from "../rates/DestinationTree";
import { Icon } from "../../ui/Icon";
import { repeatText } from "../switch/tools/toolsModel";
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


type MsgState = RouteSimulatorResult["translation"]["before"];
const XLATE_ROWS: { field: keyof MsgState; label: string; always?: boolean }[] = [
  { field: "sender", label: "Sender ID", always: true },
  { field: "receiver", label: "Receiver", always: true },
  { field: "text", label: "Content", always: true },
  { field: "senderTon", label: "Sender TON" },
  { field: "senderNpi", label: "Sender NPI" },
  { field: "destTon", label: "Receiver TON" },
  { field: "destNpi", label: "Receiver NPI" },
  { field: "registeredDelivery", label: "Registered delivery" },
];
const shown = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

/**
 * What translation did to the message (team trial round 7): Sender ID, receiver and content always, other fields when
 * they changed; each row with the value before, the value after and the rule that changed it.
 */
function TranslationTable({ before, after, steps }: { before: MsgState; after: MsgState; steps: Step[] }) {
  const by = (field: string) =>
    steps.filter((s) => s.changes.some((c) => c.field === field)).map((s) => s.name).join(", ");
  const rows = XLATE_ROWS.filter((r) => r.always || before[r.field] !== after[r.field]);
  return (
    <table className="rs-xlate">
      <thead>
        <tr>
          <th scope="col" />
          <th scope="col">Received</th>
          <th scope="col">Sent on</th>
          <th scope="col">Changed by</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const changed = before[r.field] !== after[r.field];
          return (
            <tr key={r.field} className={changed ? "changed" : undefined}>
              <th scope="row">{r.label}</th>
              <td className={r.field === "text" ? "rs-text" : "num"}>{shown(before[r.field])}</td>
              <td className={r.field === "text" ? "rs-text" : "num"}>
                {changed ? <strong>{shown(after[r.field])}</strong> : <span className="muted">unchanged</span>}
              </td>
              <td className="muted small">{changed ? by(r.field) || "a rule" : ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * One simulated message (team trial round 6: clearer and simpler): the verdict on one line, then the steps the
 * message goes through, each a row that opens for its details. The route step lists the matching rule's whole split
 * (every vendor with its share, cost and margin; the one picked this time marked), not only the picked vendor.
 */
function Result({ r }: { r: RouteSimulatorResult }) {
  const d = r.route.decision;
  const forced = r.forcedVendor;
  const t = r.translation;
  const changed = XLATE_ROWS.some((x) => t.after[x.field] !== t.before[x.field]);
  const margin = r.marginPct === null ? "—" : `${r.marginPct} %`;
  return (
    <div className="rs-result">
      <div className={`rs-verdict ${r.blocked ? "tone-bad" : "tone-ok"}`}>
        <StatusDot tone={r.blocked ? "error" : "good"} />{" "}
        {r.blocked ? (
          <strong>{r.blocked}</strong>
        ) : r.voiceCall ? (
          <strong>
            Phone call through {r.voiceCall.gateway} to {r.voiceCall.dialled} (no vendor) · cost{" "}
            {money(r.vendorCost?.rate, r.vendorCost?.currency)} · margin {margin}
          </strong>
        ) : forced ? (
          <strong>
            Sent straight to {forced.name} (routing skipped) · cost {money(forced.rate, forced.currency ?? undefined)}{" "}
            · margin {margin}
          </strong>
        ) : (
          <strong>
            Routes to {d!.vendor!.name} · cost {money(r.vendorCost?.rate, r.vendorCost?.currency)} · margin {margin}
          </strong>
        )}
        {r.testSms && (
          <span className="rs-test">
            Test SMS <span className="num">{r.testSms.messageId}</span>:{" "}
            <StatusDot tone={msgStatusTone(r.testSms.status)} /> {r.testSms.status} · {r.testSms.detail}
          </span>
        )}
      </div>
      <div className="rs-steps">
        <Step
          n={1}
          title={`Customer trunk ${r.trunk.name}`}
          tone={t.blocked ? "error" : "good"}
          summary={t.blocked ? "blocked by a translation rule" : changed ? "message changed by translation" : "no change"}
        >
          <TranslationTable before={t.before} after={t.after} steps={t.steps} />
          <dl className="kv">
            <dt>Translation rules</dt>
            <dd>
              <MatchedRules steps={t.steps} none="none on this trunk" />
            </dd>
            <dt>HLR rule</dt>
            <dd>{t.hlr ? `${t.hlr.ruleName} → ${t.hlr.providerName}` : "none"}</dd>
          </dl>
        </Step>
        <Step
          n={2}
          title={`Destination ${r.destination ?? "unknown"}`}
          tone={r.customerRate ? "good" : "error"}
          summary={
            r.customerRate
              ? `customer rate ${money(r.customerRate.rate, r.customerRate.currency)}`
              : "no customer rate"
          }
        >
          <dl className="kv">
            <dt>MCCMNC</dt>
            <dd className="num">{r.mccmnc ?? "—"}</dd>
            <dt>Customer rate</dt>
            <dd>
              {r.customerRate ? (
                <>
                  {money(r.customerRate.rate, r.customerRate.currency)}{" "}
                  <span className="muted">({r.customerRate.rateTable})</span>
                </>
              ) : (
                <span className="tone-error">no rate now</span>
              )}
            </dd>
            <dt>Encoding</dt>
            <dd>
              {r.encoding.label} · {r.encoding.chars} chars · {r.encoding.segments} SMS · {r.encoding.bytes} bytes
            </dd>
          </dl>
        </Step>
        {r.voiceCall ? (
          // SMS to voice (§8): the switch calls before routing; no route rule or vendor is used.
          <Step
            n={3}
            title={`SMS to voice rule #${r.voiceCall.ruleId}`}
            tone="good"
            summary={`a call through ${r.voiceCall.gateway}, not sent to a vendor`}
            open
          >
            <dl className="kv">
              <dt>Gateway</dt>
              <dd>
                {r.voiceCall.gateway}
                {r.voiceCall.gatewayDefault && <span className="muted"> · default gateway</span>}
              </dd>
              <dt>Dials</dt>
              <dd>
                <span className="num">{r.voiceCall.dialled}</span>
              </dd>
              <dt>Caller ID</dt>
              <dd>
                {r.voiceCall.callerId ? (
                  <span className="num">{r.voiceCall.callerId}</span>
                ) : (
                  <span className="muted">withheld</span>
                )}
              </dd>
              <dt>Says</dt>
              <dd>
                {r.voiceCall.phrase} <span className="muted">· {repeatText(r.voiceCall.repeat)}</span>
              </dd>
              <dt>No answer</dt>
              <dd>
                rings {r.voiceCall.ringTimeoutS} s, one retry after {r.voiceCall.retryDelayS} s, then not delivered
                and not charged
              </dd>
            </dl>
          </Step>
        ) : (
          <Step
            n={3}
            title={d ? `Route rule #${d.ruleId}` : "Route rule"}
            tone={!d || d.outcome !== "route" ? "error" : "good"}
            summary={
              forced
                ? "skipped: the test went straight to a vendor"
                : !d
                  ? "no rule matched"
                  : d.outcome === "route"
                    ? `${d.vendor!.name} picked (${d.vendor!.decidedBy})`
                    : d.outcome.replace("_", " ")
            }
            open
          >
            {d && <RuleSplit ruleId={d.ruleId} picked={d.vendor?.vendorTrunkId ?? null} r={r} />}
            {r.route.tried.some((x) => x.reason.startsWith("shadowed")) && (
              <div className="rs-shadowed">
                <strong className="small">Also match, never reached (rule #{d?.ruleId} decides first):</strong>
                <ul>
                  {r.route.tried
                    .filter((x) => x.reason.startsWith("shadowed"))
                    .map((x) => (
                      <li key={x.ruleId} className="small">
                        <span className="num">#{x.ruleId}</span> {x.name} <span className="muted">· priority {x.priority}</span>
                      </li>
                    ))}
                </ul>
              </div>
            )}
            <details className="rs-more">
              <summary className="small">Every rule tried, in order ({r.route.tried.length})</summary>
              <ol className="rs-tried">
                {r.route.tried.map((x) => (
                  <li
                    key={x.ruleId}
                    className={x.matched ? "" : x.reason.startsWith("shadowed") ? "tone-warning" : "muted"}
                  >
                    <span className="num">#{x.ruleId}</span> {x.name} <span className="small">({x.reason})</span>
                  </li>
                ))}
              </ol>
            </details>
          </Step>
        )}
        {r.egressSkipped.length > 0 && (
          <Step n={4} title="Vendors skipped" tone="warning" summary={`${r.egressSkipped.length} blocked by their own rules`}>
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
          </Step>
        )}
        {r.vendorTranslation && (
          <Step
            n={r.egressSkipped.length > 0 ? 5 : 4}
            title={`Vendor trunk ${r.vendorTranslation.vendorTrunk}`}
            tone="good"
            summary="what the vendor receives"
          >
            <VendorTranslation v={r.vendorTranslation} />
          </Step>
        )}
      </div>
    </div>
  );
}

/** A step of the message's path: a row with its outcome that opens for the details. */
function Step({
  n,
  title,
  summary,
  tone,
  open = false,
  children,
}: {
  n: number;
  title: string;
  summary: string;
  tone: "good" | "warning" | "error";
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="rs-step" open={open}>
      <summary>
        <span className="rs-step-n">{n}</span>
        <strong>{title}</strong>
        <span className={`rs-step-sum tone-${tone === "good" ? "good" : tone}`}>{summary}</span>
      </summary>
      <div className="rs-step-body">{children}</div>
    </details>
  );
}

/**
 * The matching rule's vendors as the evaluator saw them for this message (team trial round 6): every vendor with its
 * level, share, cost and margin, and what it does: picked, its share of other messages, next level or backup, or why
 * it cannot take traffic now (no rate, margin below the rule's minimum, blocked by its own rules).
 */
function RuleSplit({ ruleId, picked, r }: { ruleId: number; picked: number | null; r: RouteSimulatorResult }) {
  const rule = useRouteRule(ruleId);
  const d = r.route.decision!;
  const share = new Map((rule.data?.vendors ?? []).map((v) => [v.vendorTrunkId, v.sharePct]));
  const sell = r.customerRate?.platformRate ?? null;
  const problem = (note: string | null | undefined) => !!note && /^(cannot|no rate)/.test(note);
  return (
    <>
      {rule.data && (
        <p className="small muted">
          {rule.data.name} · {rule.data.routeType === "static" ? rule.data.huntPolicy.replace("_", " ") : routeKind(rule.data.routeType)}
        </p>
      )}
      <table className="mini-table rs-split">
        <thead>
          <tr>
            <th>Vendor trunk</th>
            <th>Level</th>
            <th>Share</th>
            <th>Cost (EUR)</th>
            <th>Margin</th>
            <th>For this message</th>
          </tr>
        </thead>
        <tbody>
          {d.candidates.map((c, i) => {
            const isPicked = c.vendorTrunkId === picked;
            const sh = share.get(c.vendorTrunkId);
            const status = isPicked ? (c.cost === null ? "picked, but it has no rate here" : "picked") : (c.note ?? "");
            return (
              <tr key={`${c.vendorTrunkId}-${i}`} className={isPicked ? "row-current" : undefined}>
                <td>
                  {isPicked ? <Icon name="check" size={12} /> : null} {c.name}
                </td>
                <td className="num">{c.level}</td>
                <td className="num">{sh === null || sh === undefined ? "—" : `${sh} %`}</td>
                <td className="num">{c.cost === null ? "—" : money(c.cost)}</td>
                <td className="num">
                  {sell === null || c.cost === null ? "—" : `${Math.round(((sell - c.cost) / sell) * 1000) / 10} %`}
                </td>
                <td className={`small ${problem(status) || (isPicked && c.cost === null) ? "tone-error" : "muted"}`}>
                  {status}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

const routeKind = (t: string) => (t === "dynamic" ? "least cost" : t === "qbr" ? "quality" : t);

/** Egress translation (§6.4, §13.2): what the chosen vendor trunk's rules do after routing. */
function VendorTranslation({ v }: { v: NonNullable<RouteSimulatorResult["vendorTranslation"]> }) {
  const { before, after, steps } = v.result;
  return (
    <>
      <TranslationTable before={before} after={after} steps={steps} />
      <dl className="kv">
        <dt>Rules</dt>
        <dd>
          <MatchedRules steps={steps} none="none on this vendor trunk" />
        </dd>
      </dl>
    </>
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

/**
 * Destinations as a compact field (team trial round 12): a button opening the country / network tree, the picks as
 * chips under it, so the field sits in one row with the trunks.
 */
function SimDestinationPick({ value, onChange }: { value: string[]; onChange: (codes: string[]) => void }) {
  const { tree } = useDestinationTree();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const chips = useMemo(() => codeChips(tree, value), [tree, value]);
  return (
    <div className="sim-dests">
      <span className="lookup">
        <button
          ref={ref}
          type="button"
          className="lookup-btn"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span>
            {value.length ? (
              `${value.length} destination${value.length === 1 ? "" : "s"}`
            ) : (
              <span className="muted">Pick countries or networks…</span>
            )}
          </span>
          <Icon name="chevronDown" size={13} />
        </button>
      </span>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="sim-dest-pop">
        <DestinationTree
          selected={value}
          height={300}
          onChange={(codes) => {
            const next = simDests(tree, codes);
            if (next.length > MAX_DESTS && next.length > value.length)
              return toast({ tone: "warning", message: `At most ${MAX_DESTS} networks at once` });
            onChange(next);
          }}
        />
      </Popover>
      {chips.length > 0 && (
        <div className="chips">
          {chips.map((c) => (
            <span key={c.key} className="chip">
              {c.label}
              <button
                type="button"
                aria-label={`Remove ${c.label}`}
                onClick={() => onChange(value.filter((v) => !c.codes.includes(v)))}
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const tonLabel = (v: number) => TON[v] ?? String(v);
const npiLabel = (v: number) => NPI.find(([n]) => n === v)?.[1] ?? String(v);

export function RouteSimulatorPage() {
  const [trunk, setTrunk] = useState<TrunkListRow | null>(null);
  const trunkId = trunk?.id ?? null;
  const [sender, setSender] = useState("INFO");
  // No number filled in (team trial round 12): the user types the numbers, or picks destinations, or both.
  const [receivers, setReceivers] = useState("");
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
  const [testNumber, setTestNumber] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ receiver: string; r: RouteSimulatorResult | null; error?: string }[]>([]);
  const routed = results.filter((x) => x.r && !x.r.blocked).length;
  usePageStatus({
    rows: results.length ? `${routed} of ${results.length} would be routed` : "Fill in the message and simulate",
    shortcuts: "Enter runs",
  });
  const list = parseReceivers(receivers);
  const numbersProblem = receiverProblem(receivers);
  const realNumber = testNumber.replace(/\D/g, "");
  // Numbers and destinations together (team trial round 12, no switch between them): one run each.
  const runs = [
    ...list.map((r) => ({ key: r, receiver: r as string | null, mccmnc: null as string | null })),
    ...dests.map((d) => ({ key: d, receiver: testSms && realNumber ? realNumber : null, mccmnc: d as string | null })),
  ];
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
    if (numbersProblem) return toast({ tone: "warning", message: numbersProblem });
    if (!runs.length) return toast({ tone: "warning", message: "Enter a number or pick a destination" });
    if (list.length > 20) return toast({ tone: "warning", message: "At most 20 numbers at once" });
    if (dests.length > MAX_DESTS) return toast({ tone: "warning", message: `At most ${MAX_DESTS} networks at once` });
    if (testSms && dests.length && (!realNumber || dests.length !== 1))
      return toast({
        tone: "warning",
        message: !realNumber
          ? "Enter the number the real test SMS goes to"
          : "A real test SMS goes to one destination at a time",
      });
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
  const to = [
    list.length ? (list.length > 1 ? `${list[0]} +${list.length - 1}` : list[0]) : null,
    dests.length ? `${dests.length} destination${dests.length === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // One column (team trial round 12): Route (trunk, numbers, destinations, vendor) and Message (Sender ID,
  // content) as two compact cards, the run bar, then the route step by step across the full width.
  return (
    <div className="page rs-page">
      <PageHeader page={page} title="Route simulator" />
      <form
        className="sim-flow"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <section className="sim-card">
          <h2 className="sim-step">
            <span className="sim-num">1</span> Route
            <span className="muted small sim-hint">Numbers, destinations or both; one result each</span>
          </h2>
          <div className="sim-row route">
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
                placeholder="Search trunk or enterprise…"
              />
            </div>
            <label className="field">
              <span>Numbers</span>
              <input
                value={receivers}
                maxLength={400}
                inputMode="tel"
                placeholder="e.g. 447700900123, 33612345678"
                onChange={(e) => setReceivers(e.target.value)}
              />
              {numbersProblem ? (
                <span className="error-text small">{numbersProblem}</span>
              ) : (
                <span className="muted small">
                  {list.length > 1 ? `${list.length} numbers` : "Comma-separated, up to 20"}
                </span>
              )}
            </label>
            <div className="field">
              <span>Destinations</span>
              <SimDestinationPick value={dests} onChange={setDests} />
              {!dests.length && <span className="muted small">Up to {MAX_DESTS} networks</span>}
            </div>
            <div className="field">
              <span>Vendor trunk</span>
              <ListLookup<TrunkListRow>
                list="vendor_trunks"
                value={vendorId}
                onChange={setVendor}
                labelOf={(t) => `${t.id} · ${t.name}`}
                detailOf={(t) => t.enterpriseName}
                placeholder="Any (by the route rules)"
                limit={1000}
              />
              <span className="muted small">{vendor ? "Tested directly, skips routing" : "Optional"}</span>
            </div>
          </div>
        </section>
        <section className="sim-card">
          <h2 className="sim-step">
            <span className="sim-num">2</span> Message
          </h2>
          <div className="sim-row message">
            <label className="field">
              <span>Sender ID</span>
              <input value={sender} maxLength={20} onChange={(e) => setSender(e.target.value)} />
            </label>
            <label className="field">
              <span>Content</span>
              <textarea
                className="sim-text"
                rows={2}
                value={text}
                maxLength={1600}
                onChange={(e) => setText(e.target.value)}
              />
              <span className="tag-row sim-counter">
                <span className="chip-tag green">{enc.segments} SMS</span>
                <span className="chip-tag">{enc.label.replace(" (SMSC default)", "")}</span>
                <span className="chip-tag">
                  {enc.chars} / {perSms * enc.segments} chars
                </span>
                <span className="chip-tag">{enc.bytes} bytes</span>
                {effCoding < 2 && needsUcs2(text) && (
                  <span className="chip-tag amber">Characters outside GSM: use UCS-2</span>
                )}
              </span>
            </label>
          </div>
          <div className="sim-adv-head">
            <p className="muted small">
              <strong>Advanced</strong> · {isAuto ? "Auto · " : ""}TON {tonLabel(effSrc.ton)} · NPI{" "}
              {npiLabel(effSrc.npi)} → TON {tonLabel(effDst.ton)} · NPI {npiLabel(effDst.npi)} · coding{" "}
              {CODINGS[effCoding]}
              {mccmnc ? ` · MCCMNC ${mccmnc}` : ""}
            </p>
            <button type="button" className="link" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
              {advanced ? "Hide" : "Change"}{" "}
              <Icon name="chevronDown" size={12} className={advanced ? "flip" : undefined} />
            </button>
          </div>
          {advanced && (
            <div className="sim-grid six">
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
              {/* The numbers' network, when it should not be detected from the number. */}
              <label className="field">
                <span>MCCMNC of the numbers</span>
                <input
                  value={mccmnc}
                  maxLength={6}
                  placeholder="Detected"
                  onChange={(e) => setMccmnc(e.target.value.replace(/\D/g, ""))}
                />
              </label>
              {!isAuto && (
                <button
                  type="button"
                  className="link sim-span-all"
                  onClick={() => setTouched({ coding: false, src: false, dst: false })}
                >
                  Back to automatic coding and TON / NPI
                </button>
              )}
            </div>
          )}
        </section>
        <div className="sim-run">
          <span className="sim-run-sum muted small">
            {trunk ? trunk.name : <span className="tone-error">Pick a customer trunk</span>} · {sender || "—"} →{" "}
            {to || "—"} · {enc.segments} SMS · {vendor ? vendor.name : "by route rules"}
          </span>
          <label className="toggle-inline sim-test-toggle">
            <input type="checkbox" checked={testSms} onChange={(e) => setTestSms(e.target.checked)} />
            Also send a real test SMS
          </label>
          {testSms && dests.length > 0 && (
            // A real test needs a real phone (team trial round 6): the made-up number is replaced by this one.
            <input
              className="sim-test-number"
              value={testNumber}
              inputMode="tel"
              aria-label="Number for the real test SMS"
              placeholder="Phone for the test SMS, e.g. 2348031234567"
              onChange={(e) => setTestNumber(e.target.value)}
            />
          )}
          <Button type="submit" variant="primary" icon="play" disabled={busy}>
            {busy ? "Simulating…" : `Simulate route${runs.length > 1 ? ` (${runs.length})` : ""}`}
          </Button>
        </div>
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
      </form>
    </div>
  );
}
