// Automatic TON / NPI after translation (docs/SMPP_SCENARIOS.md S-4.7), as the switch sets it (sms_switch
// message/address.ex auto/2, source_problem/3): what the Route Simulator, the rule Test and Simulate use for a trunk set
// to auto. Pure, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoTonNpi, pinnedBy, senderProblem, withTonNpiMode, type Addresses } from "../src/routing/tonNpi.js";
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
});
