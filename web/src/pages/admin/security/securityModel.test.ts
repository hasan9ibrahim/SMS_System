import { test } from "node:test";
import assert from "node:assert/strict";
import { addReminderDay, policyLine, removeReminderDay, sameSettings, settingsProblems } from "./securityModel";

const base = {
  passwordLifetimeDays: 30,
  reminderDays: [7, 3, 1],
  tempPasswordHours: 24,
  minPasswordLength: 12,
  passwordHistory: 12,
};

test("floors and never off", () => {
  assert.deepEqual(settingsProblems(base), []);
  assert.match(settingsProblems({ ...base, passwordLifetimeDays: 0 })[0]!, /can't be turned off/);
  assert.match(settingsProblems({ ...base, minPasswordLength: 8 })[0]!, /12 to 64/);
  assert.match(settingsProblems({ ...base, passwordHistory: 5 })[0]!, /12 to 24/);
  assert.match(settingsProblems({ ...base, reminderDays: [] })[0]!, /at least one/);
  assert.match(
    settingsProblems({ ...base, passwordLifetimeDays: 7, reminderDays: [7] })[0]!,
    /before the password expires/,
  );
});

test("reminder days stay unique, sorted and at most five", () => {
  assert.deepEqual(addReminderDay([7, 1], 3), [7, 3, 1]);
  assert.deepEqual(addReminderDay([7, 1], 7), [7, 1]);
  assert.deepEqual(addReminderDay([7, 1], 31), [7, 1]);
  assert.deepEqual(addReminderDay([10, 7, 5, 3, 1], 2), [10, 7, 5, 3, 1]);
  assert.deepEqual(removeReminderDay([7, 3, 1], 3), [7, 1]);
});

test("change detection and the policy line", () => {
  assert.ok(sameSettings(base, { ...base, reminderDays: [1, 3, 7] }));
  assert.ok(!sameSettings(base, { ...base, passwordLifetimeDays: 45 }));
  assert.equal(policyLine(base), "Expires every 30 days · reminders 7, 3 and 1 days before");
});
