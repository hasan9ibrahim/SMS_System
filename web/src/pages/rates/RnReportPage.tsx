// RN report (team trial round 7, §8, §13.10): every rate notification send, newest first. A send with one e-mail
// shows it in the row (enterprise, rate table, trunks, recipients, result); a bulk send shows its totals and opens
// as the report shown after the send (Report, or double-click the row).
import type { RnReport, RnReportRow } from "@sms/contract";
import { api, unwrap } from "../../api/client";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ask, toast } from "../../ui/feedback";
import { StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen } from "../reference/shared";
import { RnSummaryDialog } from "./SendRatesDialog";

const page = pageForPath("/rates/rn-report")!;
const muted = (v: string) => <span className="muted">{v}</span>;
const SOURCE: Record<RnReportRow["source"], string> = { rate_table: "Rate table save", bulk_rating: "Bulk rating" };

/** Opens the send's report: who got the RN and who did not, one line per enterprise and rate table. */
export async function openRnReport(id: number) {
  try {
    const r: RnReport = await unwrap(api.GET("/rn-reports/{id}", { params: { path: { id } } }));
    const by = r.sentBy ? ` by ${r.sentBy}` : "";
    await ask<void>((done) => (
      <RnSummaryDialog
        rows={r.notices}
        done={() => done(undefined)}
        subtitle={`${SOURCE[r.source]} · ${fmtWhen(r.sentAt)}${by}${r.changeId ? ` · change #${r.changeId}` : ""}${
          r.note ? ` · “${r.note}”` : ""
        }`}
      />
    ));
  } catch (e) {
    toast({ tone: "error", message: problemText(e) });
  }
}

const bulk = (r: RnReportRow) => r.noticeCount > 1;
/** A bulk send's summary cell opens the report. */
const summary = (r: RnReportRow, text: string) =>
  bulk(r) ? (
    <button
      type="button"
      className="link"
      onClick={(e) => {
        e.stopPropagation();
        void openRnReport(r.id);
      }}
    >
      {text}
    </button>
  ) : (
    text || muted("—")
  );

export function RnReportPage() {
  return (
    <ListScreen<RnReportRow>
      list="rn_reports"
      listExport
      page={page}
      noSelection
      historyScope={null}
      onOpen={(r) => void openRnReport(r.id)}
      rowActions={(r) => [{ label: "Report…", icon: "file", main: true, onSelect: () => void openRnReport(r.id) }]}
      columns={{
        sentAt: { width: 160, render: (r) => fmtWhen(r.sentAt) },
        source: { width: 140, render: (r) => SOURCE[r.source] },
        enterprise: { width: 220, render: (r) => summary(r, r.enterprise) },
        rateTable: { width: 200, render: (r) => summary(r, r.rateTable) },
        trunks: { width: 200, render: (r) => summary(r, r.trunks) },
        to: { width: 240, render: (r) => summary(r, r.to) },
        noticeCount: { width: 90 },
        sent: { width: 90 },
        failed: { width: 90, render: (r) => (r.failed ? <span className="tone-error">{r.failed}</span> : "0") },
        status: {
          width: 200,
          render: (r) => (
            <span title={r.reason ?? undefined}>
              <StatusDot tone={r.status === "sent" ? "good" : r.status === "partial" ? "warning" : "error"} />{" "}
              {r.status === "sent"
                ? bulk(r)
                  ? `Sent (${r.sent})`
                  : "Sent"
                : r.status === "partial"
                  ? `${r.failed} of ${r.noticeCount} failed`
                  : (r.reason ?? "Failed")}
            </span>
          ),
        },
        sentBy: { width: 130, render: (r) => r.sentBy ?? muted("platform") },
        note: { width: 240, render: (r) => r.note ?? muted("—") },
      }}
      shortcuts="↑↓ move · double-click or Report opens the send's report"
    />
  );
}
