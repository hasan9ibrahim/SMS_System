import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  blankAlert,
  blankVoiceGateway,
  blankVoiceRule,
  codecLabel,
  EMAIL_TYPE,
  fmtDurationMs,
  gatewayAddress,
  parseEmails,
  repeatText,
  toBase64,
} from "./toolsModel";

describe("SMS to voice model (§8)", () => {
  test("blank rule and gateway, labels, durations", () => {
    assert.equal(blankVoiceRule().gatewayId, null);
    assert.deepEqual(blankVoiceGateway().codecs, ["alaw", "ulaw"]);
    assert.equal(blankVoiceGateway().password, null);
    assert.equal(codecLabel("ulaw"), "G.711 µ-law");
    assert.equal(
      gatewayAddress({ host: "voice-gw2.example.net", port: 5061, transport: "tls" }),
      "sips:voice-gw2.example.net:5061 (TLS)",
    );
    assert.equal(fmtDurationMs(12_340), "12.3 s");
    assert.equal(fmtDurationMs(65_000), "1 min 5 s");
    assert.equal(repeatText(1), "said once");
    assert.equal(repeatText(2), "said twice, one second apart");
    assert.equal(repeatText(3), "said 3 times, one second apart");
  });
});

describe("switch utilities model (§8)", () => {
  test("e-mail lists, labels, blank alert, base64", () => {
    assert.deepEqual(parseEmails("noc@a.example; ops@b.example\nnoc@a.example, wrong"), {
      emails: ["noc@a.example", "ops@b.example"],
      invalid: ["wrong"],
    });
    assert.equal(EMAIL_TYPE.send_soa, "Send SOA");
    assert.equal(blankAlert().templateId, 5);
    assert.equal(toBase64(new TextEncoder().encode("notice")), "bm90aWNl");
  });
});
