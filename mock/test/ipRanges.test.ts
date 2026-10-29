// Customer trunk addresses (§5.4, team trial round 9): addresses, networks (IP/prefix or IP/mask) and ranges, and the
// networks a range is saved as (the switch matches networks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostEntry, hostNetworks } from "../src/ipRanges.js";
import { chQuery } from "../src/edr.js";
import { dec, decFactor } from "../src/reports/source.js";

const nets = (t: string) => {
  const r = hostEntry(t);
  assert.ok("networks" in r, `${t}: ${JSON.stringify(r)}`);
  return r.networks;
};

test("addresses and networks", () => {
  assert.deepEqual(nets("192.0.2.10"), ["192.0.2.10"]);
  assert.deepEqual(nets("192.0.2.0/24"), ["192.0.2.0/24"]);
  assert.deepEqual(nets("192.0.2.0/32"), ["192.0.2.0"]);
  // The network's own address, and a dotted mask.
  assert.deepEqual(nets("192.0.2.7/24"), ["192.0.2.0/24"]);
  assert.deepEqual(nets("192.0.2.0/255.255.255.0"), ["192.0.2.0/24"]);
  assert.deepEqual(nets("2001:db8::1"), ["2001:db8::1"]);
  assert.deepEqual(nets("2001:db8::/32"), ["2001:db8::/32"]);
});

test("a range becomes the networks that cover exactly it", () => {
  assert.deepEqual(nets("192.0.2.10-192.0.2.13"), ["192.0.2.10/31", "192.0.2.12/31"]);
  assert.deepEqual(nets("192.0.2.0-192.0.2.255"), ["192.0.2.0/24"]);
  assert.deepEqual(nets("192.0.2.250-255"), ["192.0.2.250/31", "192.0.2.252/30"]);
  assert.deepEqual(nets("10.0.0.0-10.255.255.255"), ["10.0.0.0/8"]);
  assert.deepEqual(nets("2001:db8::1-2001:db8::4"), ["2001:db8::1", "2001:db8::2/127", "2001:db8::4"]);
});

test("what is refused", () => {
  for (const t of ["192.0.2.300", "abc", "192.0.2.0/33", "192.0.2.0/255.0.255.0", "192.0.2.9-192.0.2.1", "1.2.3.4-::1"])
    assert.ok("error" in hostEntry(t), t);
  const r = hostNetworks(["192.0.2.1", "192.0.2.1/32", "nope"]);
  assert.deepEqual(r.networks, ["192.0.2.1"], "repeats are dropped");
  assert.deepEqual(
    r.errors.map((e) => e.index),
    [2],
  );
});

test("money sums work on an empty EDR store with one currency (no business company yet)", async (t) => {
  // ClickHouse 24.8 rejected sum(decimal × constant decimal), so every report failed on a new server (R9).
  try {
    const rows = await chQuery<{ s: number }>(
      `SELECT toFloat64(sum(${dec("revenue_sys")} * ${decFactor("1.0")})) AS s FROM edr WHERE 0`,
    );
    assert.equal(Number(rows[0]?.s ?? 0), 0);
  } catch (err) {
    if (String(err).includes("fetch failed") || String(err).includes("ECONNREFUSED")) t.skip("EDR store not available");
    else throw err;
  }
});
