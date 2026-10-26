// Go-live review (product owner 2026-10-26): the account manager is in CC of every e-mail about their accounts, not of
// mass mailings or internal mail, and never twice.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { closeDb, db, dbReady } from "../src/db.js";
import { logEmail } from "../src/api/emailLog.js";

const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const made: number[] = [];

after(async () => {
  if (made.length) await db().query("DELETE FROM email_logs WHERE id = ANY($1)", [made]);
  await closeDb();
});

async function sent(input: Parameters<typeof logEmail>[1]) {
  const id = { value: 0 };
  await logEmail(db(), input, id);
  made.push(id.value);
  const { rows } = await db().query("SELECT to_addresses, cc_addresses FROM email_logs WHERE id = $1", [id.value]);
  return rows[0] as { to_addresses: string[]; cc_addresses: string[] };
}

describe("account manager copy", { skip }, () => {
  test("partner e-mails copy the AM once; broadcasts and internal mail do not", async () => {
    const { rows } = await db().query(
      `SELECT e.id, u.email FROM enterprises e JOIN users u ON u.id = e.account_manager_id
        WHERE u.status = 'active' AND u.deleted_at IS NULL AND u.email <> '' LIMIT 1`,
    );
    const { id, email } = rows[0] as { id: number; email: string };
    const base = { enterpriseId: Number(id), to: ["partner@example.org"], subject: "test", body: "<p>x</p>" };
    assert.deepEqual((await sent({ ...base, type: "invoice" })).cc_addresses, [email]);
    assert.deepEqual((await sent({ ...base, type: "invoice", cc: [email.toUpperCase()] })).cc_addresses, [
      email.toUpperCase(),
    ]);
    assert.deepEqual((await sent({ ...base, type: "broadcast" })).cc_addresses, []);
    assert.deepEqual((await sent({ ...base, type: "otp", enterpriseId: null })).cc_addresses, []);
  });
});
