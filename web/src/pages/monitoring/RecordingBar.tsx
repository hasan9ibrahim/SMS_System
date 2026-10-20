// Extract a PCAP from the 60-day traffic recording (§9.2, team trial round 1): a period of up to 24 hours
// and a customer or vendor trunk, number, message ID or IP. Used on PCAP Trace and the Signaling deck; the
// file joins the capture files list.
import { useState } from "react";
import type { TrunkListRow } from "@sms/contract";
import { useExtractRecording, useRecordingStatus } from "../../api/observation";
import { ListLookup } from "../../records/parts";
import { toast } from "../../ui/feedback";
import { Button } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { DateTimeInput } from "../../ui/DateTimeInput";

/** "YYYY-MM-DDTHH:mm" in UTC for a datetime-local input, and back. */
const toLocalInput = (t: number) => new Date(t).toISOString().slice(0, 16);
const fromLocalInput = (v: string) => new Date(`${v}:00Z`).toISOString();

/**
 * From the recording (§9, team trial round 1): every SMPP packet is recorded and kept 60 days; cut a PCAP
 * for a window (up to 24 h) and a trunk, IP, number or message ID. The file joins the list below.
 */
export function RecordingBar({ onExtracted }: { onExtracted?: () => void }) {
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
              onExtracted?.();
            },
            onError: (e) => toast({ tone: "error", message: problemText(e) }),
          },
        );
      }}
    >
      <label className="small">
        From (UTC)
        <DateTimeInput min={oldest} value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label className="small">
        To (UTC)
        <DateTimeInput min={oldest} value={to} onChange={(e) => setTo(e.target.value)} />
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
