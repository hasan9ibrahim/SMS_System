import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { RnLineRow, RnRow } from "@sms/contract";
import { decodeState } from "../../../grid/filterModel";
import { changeSummary, decidable, lineFlags, rerouteUrl, updateCustomersUrl } from "./rnModel";

const line = (over: Partial<RnLineRow>): RnLineRow => ({
  id: 1,
  rnId: 1,
  lineNo: 2,
  mccmnc: "26201",
  country: "Germany",
  network: "Telekom",
  senderId: null,
  currentRate: 0.05,
  newRate: 0.055,
  currency: "EUR",
  change: "increase",
  changeAmount: 0.005,
  changePct: 10,
  statedFrom: "2026-10-12T00:00:00.000Z",
  appliedFrom: "2026-10-17T10:00:00.000Z",
  noticeDaysGiven: 0,
  liveTraffic: true,
  flagged: true,
  noticeBreach: true,
  backdated: true,
  traffic1h: 3,
  traffic24h: 120,
  traffic7d: 900,
  sentBetween: 40,
  costBetween: 2,
  affectedCustomers: "Alpha",
  marginNowPct: 5,
  marginNewPct: -4,
  turnsNegative: true,
  decision: "pending",
  rejectReason: null,
  ...over,
});

describe("incoming RN model (§13.32)", () => {
  test("line flags, most serious first", () => {
    assert.deepEqual(
      lineFlags(line({})).map((f) => f.label),
      ["Increase on live traffic", "Turns negative", "Notice breach", "Back-dated"],
    );
    assert.equal(
      lineFlags(line({ change: "closed", turnsNegative: false, noticeBreach: false, backdated: false }))[0]!.label,
      "Closed on live traffic",
    );
    assert.deepEqual(
      lineFlags(line({ flagged: false, turnsNegative: false, noticeBreach: false, backdated: false })),
      [],
    );
  });
  test("links to Route Rules and Bulk rating", () => {
    const g = new URL(`http://x${rerouteUrl({ vendorTrunk: "VEGA_OTP" })}`).searchParams.get("g")!;
    assert.equal(decodeState(g).columns.vendors?.value, "VEGA_OTP");
    assert.equal(
      updateCustomersUrl({ affectedRateTableIds: [4, 5], affectedMccmncs: ["26201"] }),
      "/rates/bulk?tables=4,5&mccmnc=26201",
    );
  });
  test("summary and decidable states", () => {
    const r = { increases: 3, decreases: 0, newLines: 1, closed: 2, unchanged: 0 } as RnRow;
    assert.equal(changeSummary(r), "3 up · 1 new · 2 closed");
    assert.equal(decidable("pending"), true);
    assert.equal(decidable("partly_accepted"), false);
    assert.equal(decidable("accepted"), false);
  });
});
