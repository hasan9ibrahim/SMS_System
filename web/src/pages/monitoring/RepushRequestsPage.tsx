// Repush Request (§9.2): EDRs re-sent to another vendor trunk from EDR Search, with Total EDR Count,
// outcome, Created By and Created Time. The new attempts open in EDR Search.
import type { RepushRequestRow } from "@sms/contract";
import { emptyState, encodeState } from "../../grid/filterModel";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useTabNavigate } from "../../shell/tabContext";
import { Button, StatusDot } from "../../ui/primitives";
import { fmtWhen } from "../reference/shared";
import { jobTone } from "./monitorModel";

const page = pageForPath("/monitoring/repush")!;
const muted = (v: string) => <span className="muted">{v}</span>;

/** EDR Search showing one repush request's new attempts. */
export const repushEdrsPath = (id: number) =>
  `/monitoring/edr?g=${encodeState({
    ...emptyState(),
    columns: { repushRequestId: { field: "repushRequestId", op: "eq", value: id } },
    visible: [
      "startTime",
      "customerTrunk",
      "senderId",
      "dnid",
      "vendorTrunk",
      "attemptNo",
      "msgStatus",
      "repushRequestId",
    ],
  })}`;

export function RepushRequestsPage() {
  const navigate = useTabNavigate();
  return (
    <ListScreen<RepushRequestRow>
      list="repush_requests"
      page={page}
      noSelection
      historyScope={null}
      rowActions={(r) => [
        { label: "View EDRs", icon: "search", main: true, onSelect: () => navigate(repushEdrsPath(r.id)) },
      ]}
      columns={{
        id: { width: 90 },
        edrCount: {
          width: 130,
          align: "right",
          render: (r) => <span className="num">{r.edrCount.toLocaleString("en-US")}</span>,
        },
        vendorTrunk: { width: 200 },
        status: {
          width: 100,
          render: (r) => (
            <span>
              <StatusDot tone={jobTone(r.status)} /> {r.status === "done" ? "Done" : "Pending"}
            </span>
          ),
        },
        delivered: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{r.delivered.toLocaleString("en-US")}</span>,
        },
        failed: {
          width: 100,
          align: "right",
          render: (r) => (r.failed ? <span className="num tone-error">{r.failed}</span> : muted("0")),
        },
        createdBy: { width: 140, render: (r) => r.createdBy ?? muted("—") },
        createdAt: { width: 170, render: (r) => fmtWhen(r.createdAt) },
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>Repush request {r.id}</strong>
            <span className="muted">
              {r.edrCount} EDRs → {r.vendorTrunk}
            </span>
          </>
        ),
        sections: [
          {
            key: "request",
            label: "Request",
            actions: (
              <Button small icon="search" onClick={() => navigate(repushEdrsPath(r.id))}>
                New attempts in EDR Search
              </Button>
            ),
            content: (
              <dl className="kv">
                <dt>Vendor trunk</dt>
                <dd>{r.vendorTrunk}</dd>
                <dt>Re-sent</dt>
                <dd>
                  {r.edrCount} EDRs · {r.delivered} delivered · {r.failed} failed
                </dd>
                <dt>Skipped</dt>
                <dd>{r.skipped ? `${r.skipped} (delivered, or not the final attempt)` : "none"}</dd>
                <dt>Created</dt>
                <dd>
                  {fmtWhen(r.createdAt)} by {r.createdBy ?? "—"}
                </dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move"
    />
  );
}
