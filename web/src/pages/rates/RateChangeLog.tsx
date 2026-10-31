// Readable change log of a rate table (team trial round 2): every save in plain words, e.g. "Germany ·
// Example Mobile (26201): 0.0400 → 0.0420 (+5 %) from 21 Oct 2026, 00:00", with who saved it and why.
// The technical view (field snapshots, undo) is the History list.
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { RateChangeLogEntry, RateChangeLogItem } from "@sms/contract";
import { api, unwrap } from "../../api/client";
import { HistoryList } from "../../history/undo";
import { Button } from "../../ui/primitives";
import { formatZoned, usePlatformTz } from "../../ui/zonedTime";
import { formatPct, formatRate } from "./format";

const KIND: Record<RateChangeLogItem["kind"], { label: string; tone?: string }> = {
  new: { label: "New", tone: "accent" },
  increase: { label: "Increase", tone: "warning" },
  decrease: { label: "Decrease", tone: "good" },
  same: { label: "Same rate" },
  closed: { label: "Closed", tone: "error" },
  withdrawn: { label: "Scheduled rate withdrawn" },
  blocked: { label: "Blocked", tone: "error" },
  unblocked: { label: "Unblocked" },
  note: { label: "Note changed" },
};

/** One rate of a change as a sentence part. */
function itemText(i: RateChangeLogItem, currency: string, tz: string): string {
  const when = i.effectiveFrom ? ` from ${formatZoned(i.effectiveFrom, tz)}` : "";
  switch (i.kind) {
    case "new":
      return `${formatRate(i.newRate)} ${currency}${when}`;
    case "increase":
    case "decrease":
    case "same":
      return `${formatRate(i.oldRate)} → ${formatRate(i.newRate)} ${currency}${i.changePct !== null ? ` (${formatPct(i.changePct, true)})` : ""}${when}`;
    case "closed":
      return `${formatRate(i.oldRate)} ${currency} ends${i.effectiveFrom ? ` on ${formatZoned(i.effectiveFrom, tz)}` : ""}`;
    case "withdrawn":
      return `${formatRate(i.oldRate)} ${currency} that was to start${when.replace(" from", " on")} will not`;
    case "blocked":
    case "unblocked":
    case "note":
      return `at ${formatRate(i.newRate)} ${currency}`;
  }
}

function countsText(e: RateChangeLogEntry): string {
  return Object.entries(e.counts)
    .map(([k, n]) => `${n} ${KIND[k as RateChangeLogItem["kind"]]?.label.toLowerCase() ?? k}`)
    .join(", ");
}

/** The entry's title by what the save did (QA 2026-10-31, §13.12). */
const OPERATION: Record<RateChangeLogEntry["operation"], string> = {
  created: "Table created",
  rates: "Rate change",
  rates_added: "Rates added",
  bulk_rating: "Bulk rating",
  details: "Table details",
  deleted: "Table deleted",
  restored: "Table restored",
  undo: "Undo",
  cleanup: "Cleanup",
};

function Entry({ e, tz }: { e: RateChangeLogEntry; tz: string }) {
  const [open, setOpen] = useState(e.itemCount <= 10);
  const what = e.operation === "undo" ? `Undo of #${e.undoOfId}` : OPERATION[e.operation];
  return (
    <li className="rlog-entry">
      <div className="rlog-head">
        <strong>
          #{e.changeId} · {what}
        </strong>
        <span className="muted small">
          {formatZoned(e.at, tz)} · {e.user ?? "system"}
        </span>
        <span className="fb-spacer" />
        {/* A save without rates (a new table, its name, delete or restore) says no "0 rates". */}
        {(e.itemCount > 0 || ["rates", "rates_added", "bulk_rating", "undo"].includes(e.operation)) && (
          <span className="small">
            {e.itemCount} rate{e.itemCount === 1 ? "" : "s"}: {countsText(e) || "no rate changed"}
          </span>
        )}
      </div>
      {e.note && e.changeType !== "undo" && <div className="rlog-note small">“{e.note}”</div>}
      {e.itemCount > 0 && (
        <>
          {open ? (
            <ul className="rlog-items">
              {e.items.map((i, k) => (
                <li key={k}>
                  <span className={`tag${KIND[i.kind].tone ? ` tone-${KIND[i.kind].tone}` : ""}`}>
                    {KIND[i.kind].label}
                  </span>{" "}
                  <span>
                    {i.country ?? "?"} · {i.network ?? "?"} ({i.mccmnc}){i.senderId ? `, sender ${i.senderId}` : ""}
                  </span>
                  : <span className="tnum">{itemText(i, e.currency, tz)}</span>
                </li>
              ))}
              {e.itemCount > e.items.length && (
                <li className="muted small">… and {e.itemCount - e.items.length} more rates in this change.</li>
              )}
            </ul>
          ) : null}
          {e.itemCount > 10 && (
            <button type="button" className="link-btn small" onClick={() => setOpen(!open)}>
              {open ? "Hide the rates" : `Show the ${e.itemCount} rates`}
            </button>
          )}
        </>
      )}
    </li>
  );
}

export function RateChangeLog({ tableId }: { tableId: number }) {
  const tz = usePlatformTz();
  const [technical, setTechnical] = useState(false);
  const log = useInfiniteQuery({
    queryKey: ["rate-change-log", tableId],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/rate-tables/{id}/change-log", {
          params: { path: { id: tableId }, query: { limit: 25, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
    enabled: !technical,
  });
  const rows = log.data?.pages.flatMap((p) => p.rows) ?? [];
  return (
    <div className="rate-log">
      <div className="segmented small-seg" role="group" aria-label="Change log view">
        <button type="button" className={technical ? "" : "on"} onClick={() => setTechnical(false)}>
          Readable
        </button>
        <button type="button" className={technical ? "on" : ""} onClick={() => setTechnical(true)}>
          Technical (with undo)
        </button>
        <span className="muted small"> Times in {tz}, 24-hour.</span>
      </div>
      {technical ? (
        <HistoryList scope={{ entityTypes: ["rate_table"], entityId: tableId }} />
      ) : (
        <>
          {log.isError && <p className="error-text pad">{(log.error as Error).message}</p>}
          <ul className="rlog">
            {rows.map((e) => (
              <Entry key={e.changeId} e={e} tz={tz} />
            ))}
          </ul>
          {log.hasNextPage && (
            <div className="pad">
              <Button small onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
                Load older changes
              </Button>
            </div>
          )}
          {!log.isPending && !rows.length && !log.isError && <p className="muted pad">No changes recorded yet.</p>}
        </>
      )}
    </div>
  );
}
