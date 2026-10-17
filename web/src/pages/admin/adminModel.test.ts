import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessCompanyRecord } from "@sms/contract";
import {
  allowed,
  blankCompany,
  blankMailbox,
  companyInput,
  insertAt,
  passwordLabel,
  toggleModule,
  togglePermission,
  toggleSection,
} from "./adminModel";

const rr = { key: "route-rules", label: "Route rules", section: "routing", actions: ["view", "add", "edit", "delete"] };
const map = { key: "route-map", label: "Route map", section: "routing", actions: ["view", "export"] };

describe("admin model (§11, §13.28)", () => {
  test("access matrix: actions need View, View off clears the page", () => {
    let p = togglePermission({}, rr, "edit", true);
    assert.deepEqual(p, { "route-rules": ["view", "edit"] });
    p = togglePermission(p, rr, "delete", true);
    assert.deepEqual(p["route-rules"], ["view", "edit", "delete"]);
    p = togglePermission(p, rr, "view", false);
    assert.deepEqual(p, {});
    assert.deepEqual(toggleModule({}, map, true), { "route-map": ["view", "export"] });
    assert.deepEqual(Object.keys(toggleSection({}, [rr, map], true)), ["route-rules", "route-map"]);
    assert.deepEqual([...allowed({ "*": ["view", "export", "send"] }, map)], ["view", "export"]);
  });

  test("company form keeps secrets out and starts mailboxes from the website", () => {
    const m = blankMailbox("billing", "https://www.fenphy.example");
    assert.equal(m.smtpEmail, "billing@fenphy.example");
    assert.equal(m.smtpHost, "smtp.fenphy.example");
    const rec = {
      ...blankCompany(),
      id: 1,
      mailboxes: [{ ...m, hasSmtpPassword: true, hasClientSecret: true, lastCheckAt: null, lastCheckOk: null }],
      files: [],
      enterprises: 0,
      users: 0,
      updatedBy: null,
      updatedAt: "2026-10-16T00:00:00Z",
      archivedAt: null,
    } as unknown as BusinessCompanyRecord;
    const input = companyInput(rec);
    assert.equal(input.mailboxes[0]!.clientSecret, null);
    assert.ok(!("hasClientSecret" in input.mailboxes[0]!));
    assert.ok(!("files" in input));
  });

  test("password column wording", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const base = { tempPasswordExpiresAt: null };
    assert.equal(passwordLabel({ ...base, passwordState: "ok", passwordDaysLeft: 12 }, now), "12 days left");
    assert.equal(passwordLabel({ ...base, passwordState: "expired", passwordDaysLeft: -1 }, now), "Expired 1 day ago");
    assert.equal(passwordLabel({ ...base, passwordState: "expiring", passwordDaysLeft: 0 }, now), "Expires today");
    assert.equal(
      passwordLabel(
        { passwordState: "temporary", passwordDaysLeft: 30, tempPasswordExpiresAt: "2026-10-17T00:00:00Z" },
        now,
      ),
      "Temporary · 12 h left",
    );
  });

  test("placeholders insert at the caret", () => {
    assert.deepEqual(insertAt("Dear , hi", 5, 5, "{enterprise}"), { text: "Dear {enterprise}, hi", caret: 17 });
    assert.deepEqual(insertAt("abc", 1, 2, "X"), { text: "aXc", caret: 2 });
  });
});
