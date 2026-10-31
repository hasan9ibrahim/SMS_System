// The coding a message goes to a vendor in and the vendors' capability filter (§5.5, S-2.11, S-3.12, S-4.4), as the
// switch works them out (sms_switch message/coding.ex, text.ex, pipeline/router.ex): the Route Simulator, the rule
// Test and Simulate pass over a vendor that cannot take the message.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alphabetOf,
  encode,
  forVendor,
  incapable,
  natural,
  partCount,
  textCoding,
  type VendorCapabilities,
} from "../src/routing/coding.js";

const ANY: VendorCapabilities = {
  allowedDataCodings: null,
  allowedSrcTon: null,
  allowedSrcNpi: null,
  allowedDstTon: null,
  allowedDstNpi: null,
  maxMsgLen: null,
  supportMultipart: true,
};

test("alphabets by data_coding, Latin-1 under 0 on a Latin-1 trunk", () => {
  assert.equal(alphabetOf(0), "gsm");
  assert.equal(alphabetOf(0, 3), "latin1");
  assert.equal(alphabetOf(1), "ascii");
  assert.equal(alphabetOf(3), "latin1");
  assert.equal(alphabetOf(8), "ucs2");
  assert.equal(alphabetOf(4), "binary");
  assert.equal(alphabetOf(0xf0), "gsm");
  assert.equal(alphabetOf(0xf4), "binary");
  assert.equal(textCoding("Hello €"), 0);
  assert.equal(textCoding("Привет"), 8);
});

test("parts: 160 / 153 septets, escapes count two and are never cut", () => {
  const gsm = (t: string) => partCount(encode(t, "gsm")!, "gsm");
  assert.equal(gsm("a".repeat(160)), 1);
  assert.equal(gsm("a".repeat(161)), 2);
  assert.equal(gsm("a".repeat(159) + "€"), 2, "the escape makes 161 septets");
  // 306 septets would fill two parts, but the escape would straddle the cut: three parts.
  assert.equal(gsm("a".repeat(152) + "€" + "a".repeat(152)), 3);
  assert.equal(partCount(encode("я".repeat(70), "ucs2")!, "ucs2"), 1);
  assert.equal(partCount(encode("я".repeat(71), "ucs2")!, "ucs2"), 2);
  // A surrogate pair is never cut either.
  assert.equal(partCount(encode("я".repeat(66) + "😀" + "я".repeat(66), "ucs2")!, "ucs2"), 3);
  assert.equal(partCount(encode("é".repeat(141), "latin1")!, "latin1"), 2);
  assert.equal(natural({ text: "", dataCoding: 0 })!.parts, 0);
});

test("a changed text keeps its alphabet when it fits, else goes in UCS-2 (S-4.4)", () => {
  assert.deepEqual(natural({ text: "Hi", dataCoding: 0 }, "Hi there"), {
    alphabet: "gsm",
    dataCoding: 0,
    units: 8,
    parts: 1,
  });
  assert.deepEqual(natural({ text: "Hi", dataCoding: 0 }, "Hi 😀"), {
    alphabet: "ucs2",
    dataCoding: 8,
    units: 5,
    parts: 1,
  });
});

test("Latin-1 under 0 goes in GSM when it fits in no more parts, else as 3 (S-2.11)", () => {
  assert.equal(natural({ text: "café", dataCoding: 0, defaultCoding: 3 })!.dataCoding, 0);
  assert.equal(natural({ text: "ÿes", dataCoding: 0, defaultCoding: 3 })!.dataCoding, 3);
});

test("a coding the vendor does not allow is converted when the text fits in no more parts", () => {
  const latin = { text: "café", dataCoding: 3 };
  assert.deepEqual(forVendor(latin, null, [0, 8]), { alphabet: "gsm", dataCoding: 0, units: 4, parts: 1 });
  assert.equal(forVendor({ text: "Ελλάδα ő", dataCoding: 8 }, null, [0, 3]), "coding_not_allowed");
  assert.equal(forVendor({ text: "binary", dataCoding: 4 }, null, [0]), "coding_not_allowed");
  // UCS-2 in one part converts to GSM in one part; a text that would need more parts in GSM does not.
  assert.equal((forVendor({ text: "hello", dataCoding: 8 }, null, [0]) as { dataCoding: number }).dataCoding, 0);
});

test("the capability filter says why a vendor cannot take the message", () => {
  const form = { text: "a".repeat(200), dataCoding: 0 };
  const base = { form, text: form.text, senderTon: 5, senderNpi: 0, destTon: 1, destNpi: 1 };
  assert.equal(incapable(ANY, base), null);
  assert.match(incapable({ ...ANY, allowedSrcTon: [1] }, base)!, /^source TON 5 is not allowed \(it takes 1\)/);
  assert.match(incapable({ ...ANY, allowedDstNpi: [0] }, base)!, /^destination NPI 1/);
  assert.equal(incapable({ ...ANY, allowedSrcTon: [1] }, { ...base, senderTon: null }), null, "not given: not checked");
  assert.equal(incapable({ ...ANY, maxMsgLen: 160 }, base), "200 characters, longer than its Max Msg Len 160");
  assert.equal(incapable({ ...ANY, supportMultipart: false }, base), "2 parts, and it does not support multipart");
  assert.match(
    incapable({ ...ANY, allowedDataCodings: [8] }, { ...base, form: { text: "x", dataCoding: 4 }, text: "x" })!,
    /^data coding 4 is not allowed/,
  );
  // After the vendor's egress translation: a text it shortens fits.
  assert.equal(incapable({ ...ANY, supportMultipart: false }, { ...base, text: "short" }), null);
});
