import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { HlrProviderDetail } from "@sms/contract";
import {
  blankEntry,
  blankProvider,
  dnidPreview,
  entrySummary,
  hoursText,
  providerInput,
  sortEntries,
} from "./hlrModel";

describe("HLR model (§6.5, §13.24)", () => {
  test("a saved provider maps to the form with the password left alone", () => {
    const d = {
      ...blankProvider(),
      id: 3,
      passwordSet: true,
      stats: {},
      rules: 1,
      policies: 0,
    } as unknown as HlrProviderDetail;
    const input = providerInput(d);
    assert.equal(input.password, null, "null keeps the stored password");
    assert.ok(!("passwordSet" in input));
  });

  test("cache times and entry summaries read naturally", () => {
    assert.equal(hoursText(0), "no cache");
    assert.equal(hoursText(24), "1 day");
    assert.equal(hoursText(168), "7 days");
    assert.equal(hoursText(36), "36 h");
    const names = new Map([
      [1, "Lookupia"],
      [2, "Portacheck"],
    ]);
    assert.equal(
      entrySummary({ ...blankEntry("234"), providerIds: [1, 2] }, names),
      "Lookupia → Portacheck · cache 7 days ported / 14 days not ported",
    );
    assert.equal(
      entrySummary(
        { ...blankEntry(null), mode: "auto", minSuccessPct: 90, providerIds: [2, 1], cacheHoursPorted: 24 },
        names,
      ),
      "auto: cheapest of Portacheck, Lookupia with success ≥ 90 % · cache 1 day ported / 14 days not ported",
    );
  });

  test("entries sort by code with the catch-all last", () => {
    assert.deepEqual(
      sortEntries([blankEntry(null), blankEntry("262"), blankEntry("234")]).map((e) => e.code),
      ["234", "262", null],
    );
  });

  test("DNID pattern preview", () => {
    assert.equal(dnidPreview("^44", "447700900123"), "match");
    assert.equal(dnidPreview("^44", "4917"), "no_match");
    assert.equal(dnidPreview("([", "44"), "invalid");
  });
});
