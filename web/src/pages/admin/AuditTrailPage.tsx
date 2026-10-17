// Audit Trail (§11): Info ID, IP Address, Module Name, Controller, Method, Action, Table Name, Master
// ID, Update Time, User (filter by user). Every call that changes something is recorded; read-only.
// Field-level before / after values are in Change history (§13.10).
import type { AuditRow } from "@sms/contract";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useTabNavigate } from "../../shell/tabContext";
import { Button } from "../../ui/primitives";
import { fmtWhen } from "../reference/shared";
import { Kv } from "./parts";

const page = pageForPath("/admin/audit")!;
const muted = (v: string) => <span className="muted">{v}</span>;

export function AuditTrailPage() {
  const navigate = useTabNavigate();
  return (
    <ListScreen<AuditRow>
      list="audit_log"
      page={page}
      noSelection
      historyScope={null}
      columns={{
        id: { width: 100, render: (r) => <span className="num">{r.id}</span> },
        ip: { width: 140, render: (r) => (r.ip ? <span className="mono">{r.ip}</span> : muted("—")) },
        module: { width: 120 },
        controller: { width: 260, render: (r) => <span className="mono small">{r.controller}</span> },
        method: { width: 90 },
        action: { width: 220 },
        tableName: { width: 160, render: (r) => r.tableName ?? muted("—") },
        masterId: { width: 100, render: (r) => (r.masterId ? <span className="num">{r.masterId}</span> : muted("—")) },
        at: { width: 170, render: (r) => fmtWhen(r.at) },
        user: { width: 160, render: (r) => r.user ?? muted("system") },
        status: {
          width: 100,
          align: "right",
          render: (r) => <span className={`num${r.status >= 400 ? " tone-error" : ""}`}>{r.status}</span>,
        },
      }}
      rowClass={(r) => (r.status >= 400 ? "row-muted" : undefined)}
      detail={(r) => ({
        title: (
          <>
            <strong>
              {r.method} {r.controller}
            </strong>
            <span className="muted">
              {r.action} · {r.user ?? "system"} · {fmtWhen(r.at)}
            </span>
          </>
        ),
        sections: [
          {
            key: "entry",
            label: "Entry",
            actions: r.userId ? (
              <Button small icon="history" onClick={() => navigate("/admin/changes")}>
                Change history
              </Button>
            ) : undefined,
            content: (
              <Kv
                items={[
                  ["Module", r.module],
                  ["Action", r.action],
                  ["Table", r.tableName],
                  ["Master ID", r.masterId],
                  ["User", r.user],
                  ["IP address", r.ip],
                  ["Answer", `${r.status} in ${r.durationMs} ms`],
                ]}
              />
            ),
          },
        ],
      })}
      shortcuts="↑↓ move"
    />
  );
}
