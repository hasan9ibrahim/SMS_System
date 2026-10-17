import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { blankAlert, EMAIL_TYPE, parseEmails, toBase64 } from "./toolsModel";

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
