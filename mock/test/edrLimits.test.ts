// EDR lists are bounded (QA 2026-10-31, §9.1, §9.2): a Start Time period is required, ClickHouse stops a list query
// at its timeout (and when the caller gives up), and a timeout answers 503 instead of 500.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { buildServer, API_PREFIX } from "../src/server.js";
import { closeDb, dbReady } from "../src/db.js";
import { chQuery, chRows, ChTimeout } from "../src/edr.js";
import { hasPeriod } from "../src/api/observation.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const edrStore = ready && (await chRows<{ n: string }>("SELECT 1 AS n")) !== null;
const skip = ready && edrStore ? false : "seeded database and EDR store not available";
after(async () => {
  await app.close();
  await closeDb();
});

const between = { field: "startTime", op: "between", values: ["2026-10-16T00:00:00Z", "2026-10-16T01:00:00Z"] };
const q = (...conditions: object[]) => ({ filter: { logic: "and", conditions }, limit: 5 }) as never;

test("a period is a top-level Start Time between, or a lower and an upper bound", () => {
  assert.equal(hasPeriod(q(between)), true);
  assert.equal(
    hasPeriod(
      q(
        { field: "startTime", op: "gte", value: "2026-10-16T00:00:00Z" },
        { field: "startTime", op: "lt", value: "2026-10-17T00:00:00Z" },
      ),
    ),
    true,
  );
  assert.equal(hasPeriod(q({ field: "startTime", op: "gte", value: "2026-10-16T00:00:00Z" })), false);
  assert.equal(hasPeriod(q({ field: "senderId", op: "eq", value: "x" })), false);
  assert.equal(hasPeriod({ limit: 5 } as never), false);
  // Inside an OR group it does not bound the whole query.
  assert.equal(hasPeriod(q({ logic: "or", conditions: [between, { field: "senderId", op: "eq", value: "x" }] })), false);
});

describe("EDR lists without a period, and too slow (§9.1, §9.2)", { skip }, () => {
  test("EDR search and Failed EDRs ask for a period", async () => {
    for (const url of ["/edrs/query", "/failed-edrs/query"]) {
      for (const body of [{ limit: 5 }, q({ field: "startTime", op: "gte", value: "2026-10-16T00:00:00Z" })]) {
        const r = await app.inject({ method: "POST", url: `${API_PREFIX}${url}`, payload: body });
        assert.equal(r.statusCode, 400, `${url}: ${r.body}`);
        assert.match(r.json().title, /Choose a period/);
      }
      const r = await app.inject({ method: "POST", url: `${API_PREFIX}${url}`, payload: q(between) });
      assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
    }
  });

  test("ClickHouse stops a screen's read at its timeout; either way it is a ChTimeout (503)", async () => {
    // Stopped by ClickHouse (max_execution_time): the server's own timeout error.
    await assert.rejects(
      chQuery("SELECT sleepEachRow(1) FROM numbers(5) SETTINGS max_block_size = 1", 1000, { read: true }),
      ChTimeout,
    );
    // The caller gives up first.
    await assert.rejects(chQuery("SELECT sleepEachRow(1) FROM numbers(3) SETTINGS max_block_size = 1", 500), ChTimeout);
  });
});
