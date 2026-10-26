// The NATS login is passed as options, not left in the URL (nats.js ignores it there; go-live rehearsal 2026-10-26).
import { test } from "node:test";
import assert from "node:assert/strict";
import { natsServers } from "../src/natsServers.js";

test("the login comes out of the URL and the servers keep host and port only", () => {
  assert.deepEqual(natsServers("nats://sms:p%40ss%2Fw@127.0.0.1:4222,nats://10.0.0.2:4222"), {
    servers: ["nats://127.0.0.1:4222", "nats://10.0.0.2:4222"],
    user: "sms",
    pass: "p@ss/w",
  });
});

test("without a login nothing is added", () => {
  assert.deepEqual(natsServers("nats://127.0.0.1:4222"), { servers: ["nats://127.0.0.1:4222"] });
});
