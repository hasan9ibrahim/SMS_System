// PCAP Trace (§9.2, team trial round 1): every SMPP packet on the switch is recorded into one file per
// 15 minutes and kept 120 days (60 on the servers, then off-site; product owner 2026-10-27). Trace files lists them (File Name, File Size, Download, Update Time UTC),
// filtered and paged on the server; the filter above extracts a PCAP for a period and a customer or vendor
// trunk, number, message ID or IP into Extracted files (deleted 30 days after they are made unless kept).
import { useState } from "react";
import type { PcapTraceRow } from "@sms/contract";
import { downloadFrom } from "../../api/observation";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { toast } from "../../ui/feedback";
import { Button } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen } from "../reference/shared";
import { fmtBytes } from "./monitorModel";
import { useAutoRefresh } from "./parts";
import { RecordingBar } from "./RecordingBar";
import { CaptureFiles } from "./SignalingPage";

const page = pageForPath("/monitoring/pcap-trace")!;
const download = (r: PcapTraceRow) =>
  void downloadFrom(`/pcap-traces/${r.id}/file`, undefined, r.fileName).catch((e) =>
    toast({ tone: "error", message: problemText(e) }),
  );

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
      shortcuts="Double-click or Enter downloads"
    />
  );
}
