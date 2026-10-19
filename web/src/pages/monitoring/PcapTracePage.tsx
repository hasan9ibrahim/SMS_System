// PCAP Trace (§9.2, team trial round 1): every SMPP packet on the switch is recorded into one file per
// 15 minutes and kept 60 days. Trace files lists them (File Name, File Size, Download, Update Time UTC),
// filtered and paged on the server; the filter above extracts a PCAP for a period and a customer or vendor
// trunk, number, message ID or IP into Extracted files (deleted 30 days after they are made unless kept).
import { useState } from "react";
import type { PcapTraceRow, TrunkListRow } from "@sms/contract";
import { downloadFrom, useExtractRecording, useRecordingStatus } from "../../api/observation";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ListLookup } from "../../records/parts";
import { toast } from "../../ui/feedback";
import { Button } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen } from "../reference/shared";
import { fmtBytes } from "./monitorModel";
import { useAutoRefresh } from "./parts";
import { CaptureFiles } from "./SignalingPage";

const page = pageForPath("/monitoring/pcap-trace")!;
const download = (r: PcapTraceRow) =>
  void downloadFrom(`/pcap-traces/${r.id}/file`, undefined, r.fileName).catch((e) =>
    toast({ tone: "error", message: problemText(e) }),
  );

/** "YYYY-MM-DDTHH:mm" in UTC for a datetime-local input, and back. */
const toLocalInput = (t: number) => new Date(t).toISOString().slice(0, 16);
const fromLocalInput = (v: string) => new Date(`${v}:00Z`).toISOString();

/**
 * From the recording (§9, team trial round 1): every SMPP packet is recorded and kept 60 days; cut a PCAP
 * for a window (up to 24 h) and a trunk, IP, number or message ID. The file joins the list below.
 */
function RecordingBar({ onExtracted }: { onExtracted: () => void }) {
  const status = useRecordingStatus();
  const extract = useExtractRecording();
  const now = Date.now();
  const [from, setFrom] = useState(() => toLocalInput(now - 3_600_000));
  const [to, setTo] = useState(() => toLocalInput(now));
  const [customerTrunkId, setCustomerTrunkId] = useState<number | null>(null);
  const [vendorTrunkId, setVendorTrunkId] = useState<number | null>(null);
  const [number, setNumber] = useState("");
  const [messageId, setMessageId] = useState("");
  const [ip, setIp] = useState("");
  const oldest = status.data ? toLocalInput(Date.parse(status.data.oldestAt)) : undefined;
  return (
    <form
      className="deck-above capture-form recording-form"
      onSubmit={(e) => {
        e.preventDefault();
        extract.mutate(
          {
            from: fromLocalInput(from),
            to: fromLocalInput(to),
            customerTrunkId,
            vendorTrunkId,
            number: number.trim() || null,
            messageId: messageId.trim() || null,
            ipFilter: ip.trim() || null,
          },
          {
            onSuccess: (c) => {
              toast({ tone: "good", message: `Preparing ${c.fileName}` });
              onExtracted();
            },
            onError: (e) => toast({ tone: "error", message: problemText(e) }),
          },
        );
      }}
    >
      <label className="small">
        From (UTC)
        <input type="datetime-local" min={oldest} value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label className="small">
        To (UTC)
        <input type="datetime-local" min={oldest} value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      <div className="small capture-pick">
        <span>Customer trunk</span>
        <ListLookup<TrunkListRow>
          list="customer_trunks"
          value={customerTrunkId}
          onChange={(t) => setCustomerTrunkId(t?.id ?? null)}
          labelOf={(t) => t.name}
          detailOf={(t) => t.enterpriseName}
          placeholder="Any"
        />
      </div>
      <div className="small capture-pick">
        <span>Vendor trunk</span>
        <ListLookup<TrunkListRow>
          list="vendor_trunks"
          value={vendorTrunkId}
          onChange={(t) => setVendorTrunkId(t?.id ?? null)}
          labelOf={(t) => t.name}
          detailOf={(t) => t.enterpriseName}
          placeholder="Any"
        />
      </div>
      <label className="small">
        Number
        <input value={number} placeholder="Sender or receiver" onChange={(e) => setNumber(e.target.value)} />
      </label>
      <label className="small">
        Message ID
        <input value={messageId} placeholder="Ours or the vendor's" onChange={(e) => setMessageId(e.target.value)} />
      </label>
      <label className="small">
        IP
        <input value={ip} placeholder="Address or range" onChange={(e) => setIp(e.target.value)} />
      </label>
      <span className="muted small">
        {status.data
          ? `All SMPP traffic is recorded and kept ${status.data.retentionDays} days · up to ${status.data.maxWindowHours} h per file`
          : ""}
      </span>
      <span className="fb-spacer" />
      <Button type="submit" variant="primary" icon="download" disabled={extract.isPending || !from || !to}>
        Extract PCAP
      </Button>
    </form>
  );
}

type Tab = "files" | "extracted";

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <div className="segmented capture-mode" role="tablist" aria-label="PCAP trace">
      <button type="button" role="tab" className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>
        Trace files
      </button>
      <button type="button" role="tab" className={tab === "extracted" ? "on" : ""} onClick={() => setTab("extracted")}>
        Extracted files
      </button>
    </div>
  );
}

export function PcapTracePage() {
  const [tab, setTab] = useState<Tab>("files");
  useAutoRefresh(tab === "files" ? 15_000 : 2000);
  const above = (
    <>
      <RecordingBar onExtracted={() => setTab("extracted")} />
      <Tabs tab={tab} setTab={setTab} />
    </>
  );
  if (tab === "extracted") return <CaptureFiles source="recording" page={page} above={above} />;
  return (
    <ListScreen<PcapTraceRow>
      list="pcap_traces"
      page={page}
      noSelection
      historyScope={null}
      above={above}
      onOpen={(r) => download(r)}
      columns={{
        fileName: {
          width: 330,
          render: (r) => (
            <button type="button" className="link" onClick={() => download(r)}>
              {r.fileName}
            </button>
          ),
        },
        sizeBytes: {
          width: 130,
          align: "right",
          render: (r) => (
            <span className="num" title={r.inProgress ? "Still being written" : undefined}>
              {fmtBytes(r.sizeBytes)}
            </span>
          ),
        },
        updatedAt: {
          width: 190,
          render: (r) => (
            <span>
              {fmtWhen(r.updatedAt)}
              {r.inProgress ? <span className="muted"> · recording</span> : null}
            </span>
          ),
        },
      }}
      rowActions={(r) => [{ label: "Download", icon: "download", main: true, onSelect: () => download(r) }]}
      trailing={{
        header: "Download",
        width: 120,
        render: (r) => (
          <Button small icon="download" onClick={() => download(r)}>
            Download
          </Button>
        ),
      }}
      shortcuts="Double-click or Enter downloads · one file per 15 minutes · kept 60 days"
    />
  );
}
