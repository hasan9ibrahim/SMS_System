import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeQuery, encodeQuery, filterCount, parseDestinations, rate, signed, toDelimited } from "./lookupModel";

test("pasted destinations: MCCMNCs, numbers and what can't be read", () => {
  const r = parseDestinations("50501, 505\n+61 412-345-678;4915112345678 abc 12 26201");
  assert.deepEqual(r.mccmncs, ["50501", "505", "26201"]);
  assert.deepEqual(r.numbers, ["61412345678", "4915112345678"]);
  assert.deepEqual(r.invalid, ["abc", "12"]);
});

test("the lookup round-trips through the URL; filters are counted", () => {
  const q = { view: "margin" as const, countryIds: [13], tiers: ["tier1" as const], senderId: "BANK", highlights: [] };
  assert.deepEqual(decodeQuery(encodeQuery(q)), q);
  assert.equal(decodeQuery("not-base64!"), null);
  assert.equal(filterCount(q), 2);
});

test("rates, signed margins and table copies", () => {
  assert.equal(rate(0.0182), "0.0182");
  assert.equal(rate(0.018262), "0.018262");
  assert.equal(signed(-0.0021), "−0.0021");
  assert.equal(
    toDelimited(
      [
        ["a,b", 1],
        ["c", null],
      ],
      ",",
    ),
    '"a,b",1\r\nc,\r\n',
  );
  assert.equal(toDelimited([["a\tb", 1]], "\t"), "a b\t1\n");
});
