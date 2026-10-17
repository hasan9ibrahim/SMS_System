import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TeamMemberRow } from "@sms/contract";
import { METRICS, ranking, recordLink } from "./teamModel";

const row = (name: string, revenue: number | null, ack: number | null) =>
  ({
    name,
    business: revenue === null ? null : { revenue },
    noc: { avgAckMinutes: ack },
  }) as unknown as TeamMemberRow;

describe("team model (§13.18)", () => {
  test("ranking: highest first, members without a value left out, lower-is-better ascending", () => {
    const rows = [row("A", 10, 9), row("B", 50, 3), row("C", null, null), row("D", 0, 5)];
    assert.deepEqual(
      ranking(
        rows,
        METRICS.find((m) => m.key === "revenue")!,
      ).map((x) => x.name),
      ["B", "A"],
    );
    assert.deepEqual(
      ranking(
        rows,
        METRICS.find((m) => m.key === "ackMinutes")!,
      ).map((x) => x.name),
      ["B", "D", "A"],
    );
  });
  test("timeline links", () => {
    assert.equal(recordLink("rate_table", 7), "/rates/manager?table=7");
    assert.equal(recordLink("audit", 7), null);
    assert.equal(recordLink("route_rules", null), null);
  });
});
