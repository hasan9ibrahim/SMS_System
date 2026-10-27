// Send rate sheets from Rate Manager (team trial round 4, §8, §13.12): one table or several, each to every live
// customer trunk using it (one e-mail per trunk with its current sheet). The same window then shows what was sent
// and, per customer trunk, what failed and why.
import { useState } from "react";
import type { NotificationResult, RateNoticeOutcome, RateTableRow } from "@sms/contract";
import { useSendRate } from "../../api/switchTools";
import { ask } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, Modal } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";

function SendRatesDialog({
  tables,
  done,
}: {
  tables: Pick<RateTableRow, "id" | "name" | "trunkCount">[];
  done: () => void;
}) {
  const send = useSendRate();
  const [fileType, setFileType] = useState<"excel" | "csv">("excel");
  const [result, setResult] = useState<NotificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trunks = tables.reduce((n, t) => n + (t.trunkCount ?? 0), 0);
  const run = () => {
    setError(null);
    send.mutate(
      { rateTableIds: tables.map((t) => t.id), fileType, sendEmail: true },
      { onSuccess: setResult, onError: (e) => setError(problemText(e)) },
    );
  };
  if (result) {
    const failed = result.failed.length + (result.skippedTables?.length ?? 0);
    return (
      <Modal
        title={failed ? (result.sent ? "Rates sent, with some failures" : "Rates not sent") : "Rates sent"}
        width={680}
        onClose={done}
        footer={
          <Button variant="primary" onClick={done}>
            Close
          </Button>
        }
      >
        <div className={`send-summary ${failed ? (result.sent ? "partial" : "bad") : "good"}`}>
          <Icon name={failed && !result.sent ? "alert" : "check"} />
          <span>
            <strong>{result.sent}</strong> customer trunk{result.sent === 1 ? "" : "s"} e-mailed
            {failed ? (
              <>
                {" "}
                · <strong>{result.failed.length}</strong> failed
                {result.skippedTables?.length ? ` · ${result.skippedTables.length} table(s) skipped` : ""}
              </>
            ) : null}
          </span>
        </div>
        {!!result.sentTrunks?.length && (
          <>
            <h3 className="part-title">Sent</h3>
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Customer trunk</th>
                  <th>Enterprise</th>
                  <th>To</th>
                </tr>
              </thead>
              <tbody>
                {result.sentTrunks.map((t) => (
                  <tr key={t.trunkId}>
                    <td className="strong">{t.trunk}</td>
                    <td>{t.enterprise}</td>
                    <td className="small">{t.to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {result.failed.length > 0 && (
          <>
            <h3 className="part-title">Failed</h3>
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Customer trunk</th>
                  <th>Enterprise</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {result.failed.map((t) => (
                  <tr key={t.trunkId}>
                    <td className="strong">{t.trunk}</td>
                    <td>{t.enterprise ?? "—"}</td>
                    <td className="tone-error">{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {!!result.skippedTables?.length && (
          <>
            <h3 className="part-title">Tables with nothing to send</h3>
            <ul className="plain-list">
              {result.skippedTables.map((t) => (
                <li key={t.rateTableId}>
                  <strong>{t.rateTable}</strong> <span className="muted">· {t.reason}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted small">Every e-mail is in Switch › Email logs.</p>
      </Modal>
    );
  }
  return (
    <Modal
      title={tables.length === 1 ? `Send rates · ${tables[0]!.name}` : `Send rates · ${tables.length} tables`}
      width={500}
      onClose={done}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          <Button variant="primary" icon="send" disabled={send.isPending} onClick={run}>
            {send.isPending ? "Sending…" : "Send rates"}
          </Button>
        </>
      }
    >
      <p>
        Each customer trunk using {tables.length === 1 ? "this table" : "these tables"}
        {trunks ? ` (${trunks})` : ""} gets one e-mail with its current rate sheet, to the enterprise&apos;s Rates
        contact (Commercial when there is none).
      </p>
      {tables.length > 1 && <p className="muted small">{tables.map((t) => t.name).join(", ")}</p>}
      <label className="field">
        <span>File type</span>
        <select value={fileType} onChange={(e) => setFileType(e.target.value as "excel" | "csv")}>
          <option value="excel">Excel</option>
          <option value="csv">CSV</option>
        </select>
      </label>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

export function openSendRates(tables: Pick<RateTableRow, "id" | "name" | "trunkCount">[]) {
  return ask<void>((done) => <SendRatesDialog tables={tables} done={() => done(undefined)} />);
}

// Who got the rate notification and who did not (team trial round 6, §8): shown after a save or bulk rating that
// sent RNs, one row per enterprise and rate table.
function RnSummaryDialog({ rows, done }: { rows: RateNoticeOutcome[]; done: () => void }) {
  const sent = rows.filter((r) => r.status === "sent").length;
  const failed = rows.length - sent;
  return (
    <Modal
      title={failed ? (sent ? "RNs sent, with some failures" : "RNs not sent") : "RNs sent"}
      width={720}
      onClose={done}
      footer={
        <Button variant="primary" onClick={done}>
          Close
        </Button>
      }
    >
      <div className={`send-summary ${failed ? (sent ? "partial" : "bad") : "good"}`}>
        <Icon name={failed && !sent ? "alert" : "check"} />
        <span>
          <strong>{sent}</strong> e-mail{sent === 1 ? "" : "s"} sent
          {failed ? (
            <>
              {" "}
              · <strong>{failed}</strong> failed
            </>
          ) : null}
        </span>
      </div>
      <table className="mini-table">
        <thead>
          <tr>
            <th>Enterprise</th>
            <th>Rate table</th>
            <th>Customer trunks</th>
            <th>To</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.enterpriseId}-${r.rateTable}`}>
              <td className="strong">{r.enterprise}</td>
              <td>{r.rateTable}</td>
              <td className="small">{r.trunks.join(", ")}</td>
              <td className="small">{r.to.join(", ") || "—"}</td>
              <td className={r.status === "sent" ? "tone-good" : "tone-error"}>
                {r.status === "sent" ? "Sent" : (r.reason ?? "Failed")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

/** Opens the RN summary when the save sent any notifications. */
export function showRnSummary(rows: RateNoticeOutcome[] | undefined) {
  if (!rows?.length) return;
  void ask<void>((done) => <RnSummaryDialog rows={rows} done={() => done(undefined)} />);
}
