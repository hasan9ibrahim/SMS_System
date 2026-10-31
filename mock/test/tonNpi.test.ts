// Automatic TON / NPI after translation (docs/SMPP_SCENARIOS.md S-4.7), as the switch sets it (sms_switch
// message/address.ex auto/2, source_problem/3): what the Route Simulator, the rule Test and Simulate use for a trunk set
// to auto. Pure, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoTonNpi,
  fitTonNpi,
  pinnedBy,
  senderProblem,
  senderRefusal,
  withTonNpiMode,
  type Addresses,
} from "../src/routing/tonNpi.js";
import { incapable, type VendorCapabilities } from "../src/routing/coding.js";

const msg = (over: Partial<Addresses> = {}): Addresses => ({
  sender: "FakeBank",
  receiver: "4915112345678",
  senderTon: 1,
  senderNpi: 1,
  destTon: 0,
  destNpi: 0,
  ...over,
});

test("source: alphanumeric TON 5 / NPI 0; + then digits TON 1 / NPI 1 without the +; 9+ digits 1 / 1; 3-8 digits 3 / 0", () => {
  assert.deepEqual(autoTonNpi(msg()), { ...msg(), senderTon: 5, senderNpi: 0, destTon: 1, destNpi: 1 });
  const intl = autoTonNpi(msg({ sender: "+447700900123", senderTon: 5, senderNpi: 0 }));
  assert.deepEqual([intl.sender, intl.senderTon, intl.senderNpi], ["447700900123", 1, 1]);
  const long = autoTonNpi(msg({ sender: "447700900123", senderTon: 0 }));
  assert.deepEqual([long.sender, long.senderTon, long.senderNpi], ["447700900123", 1, 1]);
  const short = autoTonNpi(msg({ sender: "12345", senderTon: 1 }));
  assert.deepEqual([short.sender, short.senderTon, short.senderNpi], ["12345", 3, 0]);
  // 1-2 digits and no sender: auto has nothing to go on, left as they are.
  for (const sender of ["", "12"]) {
    const same = autoTonNpi(msg({ sender, senderTon: 2, senderNpi: 8 }));
    assert.deepEqual([same.sender, same.senderTon, same.senderNpi], [sender, 2, 8], sender);
  }
});

test("destination: a full international number TON 1 / NPI 1 without the +; anything else as it is", () => {
  const plus = autoTonNpi(msg({ receiver: "+4915112345678" }));
  assert.deepEqual([plus.receiver, plus.destTon, plus.destNpi], ["4915112345678", 1, 1]);
  for (const receiver of ["1234567", "1234567890123456", "49 151 1234"]) {
    const same = autoTonNpi(msg({ receiver, destTon: 2, destNpi: 8 }));
    assert.deepEqual([same.receiver, same.destTon, same.destNpi], [receiver, 2, 8], receiver);
  }
});

test("a field a translation rule set wins over auto; the + stays when the rule set the TON", () => {
  const out = autoTonNpi(msg({ sender: "+447700900123", senderTon: 2 }), new Set(["senderTon", "destNpi"]));
  assert.deepEqual([out.sender, out.senderTon, out.senderNpi], ["+447700900123", 2, 1]);
  assert.deepEqual([out.destTon, out.destNpi], [1, 0]);
  const rules = [
    { id: 1, senderTon: 5, senderNpi: null, destTon: null, destNpi: null },
    { id: 2, senderTon: null, senderNpi: 0, destTon: null, destNpi: null },
    { id: 3, senderTon: null, senderNpi: null, destTon: 1, destNpi: null },
  ];
  const steps = [
    { ruleId: 1, matched: true, blocked: false },
    { ruleId: 2, matched: false, blocked: false },
    { ruleId: 3, matched: true, blocked: false },
  ];
  assert.deepEqual([...pinnedBy(rules, steps)].sort(), ["destTon", "senderTon"]);
});

test("as_sent changes nothing", () => {
  const m = msg({ sender: "+447700900123", senderTon: 5 });
  assert.equal(withTonNpiMode("as_sent", m), m);
  assert.equal(withTonNpiMode(null, m), m);
  assert.equal(withTonNpiMode("auto", m).senderTon, 1);
});

test("auto cannot fix a sender's length or characters: still unfit to send", () => {
  const fixed = autoTonNpi(msg({ sender: "ABCDEFGHIJKLMN" }));
  assert.equal(fixed.senderTon, 5);
  assert.match(senderProblem(fixed.sender, fixed.senderTon, fixed.senderNpi)!, /longer than 11 characters/);
  assert.equal(senderProblem("FakeBank", 5, 0), null);
  assert.equal(senderProblem("447700900123", 1, 1), null);
  assert.match(senderProblem("+447700900123", 5, 0)!, /longer than 11/, "a number sent as alphanumeric");
  assert.match(senderProblem("1".repeat(21), 1, 1)!, /longer than 20 digits/);
  assert.match(senderProblem("Fake", 7, 0)!, /^source TON 7/);
  assert.match(senderProblem("Fake", 5, 2)!, /^source NPI 2/);
  assert.match(senderProblem("", null, null)!, /no sender/);
});

test("the capability filter checks the sender when it is given (S-4.7)", () => {
  const ANY: VendorCapabilities = {
    allowedDataCodings: null,
    allowedSrcTon: null,
    allowedSrcNpi: null,
    allowedDstTon: [1],
    allowedDstNpi: null,
    maxMsgLen: null,
    supportMultipart: true,
  };
  const form = { text: "hello", dataCoding: 0 };
  const sent = msg({ sender: "FakeBank", senderTon: 5, senderNpi: 0 });
  assert.match(incapable(ANY, { form, text: "hello", ...sent })!, /^destination TON 0 is not allowed/);
  assert.equal(incapable(ANY, { form, text: "hello", ...autoTonNpi(sent) }), null, "auto: destination TON 1");
  const long = autoTonNpi(msg({ sender: "ABCDEFGHIJKLMN" }));
  assert.match(incapable(ANY, { form, text: "hello", ...long })!, /longer than 11 characters/);
  // Refuse invalid senders off: the vendor takes it as it is (its destination TON still counts).
  const takesAny = { ...ANY, allowedDstTon: null, refuseInvalidSenders: false };
  assert.equal(incapable(takesAny, { form, text: "hello", ...long }), null);
});

test("the one equivalent a vendor's lists take, only where they do not take what it has (S-4.7)", () => {
  const lists = { allowedSrcTon: [5], allowedSrcNpi: [0], allowedDstTon: [1], allowedDstNpi: [1] };
  const any = { allowedSrcTon: null, allowedSrcNpi: null, allowedDstTon: null, allowedDstNpi: null };
  const fit = fitTonNpi(msg(), lists);
  assert.deepEqual([fit.sender, fit.senderTon, fit.senderNpi], ["FakeBank", 5, 0]);
  assert.deepEqual([fit.receiver, fit.destTon, fit.destNpi], ["4915112345678", 1, 1]);
  assert.deepEqual(fitTonNpi(msg(), any), msg(), "null lists take anything");
  const plus = fitTonNpi(msg({ sender: "+447700900123", senderTon: 5, senderNpi: 0 }), { ...any, allowedSrcTon: [1] });
  assert.deepEqual([plus.sender, plus.senderTon, plus.senderNpi], ["447700900123", 1, 1]);
  // No single equivalent (a short code, a national number) or one the lists do not take either: as it is.
  const short = fitTonNpi(msg({ sender: "12345", senderTon: 0 }), { ...any, allowedSrcTon: [3] });
  assert.deepEqual([short.senderTon, short.senderNpi], [0, 1]);
  assert.equal(fitTonNpi(msg({ receiver: "1234567" }), { ...any, allowedDstTon: [1] }).destTon, 0);
  assert.equal(fitTonNpi(msg(), { ...any, allowedSrcTon: [2] }).senderTon, 1);
  // Not given: not checked.
  assert.equal(fitTonNpi(msg({ destTon: null, destNpi: null }), lists).destTon, null);
});

test("which senders a vendor refuses: SMPP's limits always, what a handset shows unless switched off", () => {
  assert.match(senderRefusal("Fake", 7, 0, false)!, /^source TON 7/);
  assert.match(senderRefusal("", 5, 0, false)!, /no sender/);
  assert.match(senderRefusal("A".repeat(21), 5, 0, false)!, /longer than 20 characters/);
  assert.match(senderRefusal("ABCDEFGHIJKLMN", 5, 0)!, /longer than 11 characters/);
  assert.equal(senderRefusal("ABCDEFGHIJKLMN", 5, 0, false), null);
  assert.match(senderRefusal("Fakë", 5, 0)!, /not printable ASCII/);
  assert.equal(senderRefusal("447700900123", 1, 1), null);
});
