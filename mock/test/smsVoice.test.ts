// SMS to voice over SIP (§8, decided 2026-10-31, docs/SMS_TO_VOICE.md): recording conversion and refusals, the call
// decision (code, caller ID, number dialled, gateway), voice gateways (write-only password, safe delete, history and
// undo), rules with a gateway and their own recording, the rule test and the Route Simulator. Responses are checked
// against the contract; rows the tests add are removed. Fake data only.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import type { Change } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { MAX_SECONDS, parseWav, toVoiceWav, VOICE_RATE, WavError } from "../src/audio/wav.js";
import {
  callerIdFor,
  decideVoice,
  dialledNumber,
  findCode,
  phraseFor,
  pickGateway,
  type VoiceGateway,
  type VoiceRule,
} from "../src/routing/smsVoice.js";

// ---------------------------------------------------------------- WAV fixtures

/** A PCM WAV with a sine per channel (440 Hz left, 660 Hz right), or the given header fields. */
function makeWav(o: { rate: number; channels: number; bits: number; seconds: number; format?: number }): Buffer {
  const frames = Math.round(o.rate * o.seconds);
  const step = o.bits / 8;
  const data = Buffer.alloc(frames * o.channels * step);
  for (let i = 0; i < frames; i++)
    for (let ch = 0; ch < o.channels; ch++) {
      const v = 0.5 * Math.sin((2 * Math.PI * (ch ? 660 : 440) * i) / o.rate);
      const at = (i * o.channels + ch) * step;
      if (o.bits === 8) data[at] = Math.round(128 + v * 127);
      else if (o.bits === 16) data.writeInt16LE(Math.round(v * 32767), at);
      else if (o.bits === 24) data.writeIntLE(Math.round(v * 8388607), at, 3);
      else data.writeFloatLE(v, at);
    }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8, "latin1");
  head.write("fmt ", 12, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(o.format ?? 1, 20);
  head.writeUInt16LE(o.channels, 22);
  head.writeUInt32LE(o.rate, 24);
  head.writeUInt32LE(o.rate * o.channels * step, 28);
  head.writeUInt16LE(o.channels * step, 32);
  head.writeUInt16LE(o.bits, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const rms = (b: Buffer) => {
  const { data } = parseWav(b);
  let sum = 0;
  for (let i = 0; i < data.length; i += 2) sum += (data.readInt16LE(i) / 32768) ** 2;
  return Math.sqrt(sum / (data.length / 2));
};

const refusal = (input: Buffer) => {
  try {
    toVoiceWav(input);
  } catch (err) {
    assert.ok(err instanceof WavError, String(err));
    return err.message;
  }
  assert.fail("the file was accepted");
};

describe("SMS to voice recordings (§8): convert any PCM WAV, refuse the rest", () => {
  test("a stereo 44.1 kHz 16-bit WAV becomes mono 8 kHz 16-bit PCM", () => {
    const out = toVoiceWav(makeWav({ rate: 44100, channels: 2, bits: 16, seconds: 1 }));
    const { format, data } = parseWav(out);
    assert.deepEqual(format, { channels: 1, rate: VOICE_RATE, bits: 16, blockAlign: 2 });
    assert.equal(data.length / 2, 8000);
    assert.equal(out.length, 44 + 16000);
    // Two half-scale sines averaged: 0.25 RMS, kept through the resampler's low-pass (both are below 4 kHz).
    assert.ok(Math.abs(rms(out) - 0.25) < 0.02, String(rms(out)));
    // Converting the stored file again gives the same bytes, so the SHA-256 the switch uses stays the same.
    assert.ok(toVoiceWav(out).equals(out));
  });

  test("8 and 24-bit, mono, other rates and a 1-minute file are accepted", () => {
    for (const w of [
      { rate: 22050, channels: 1, bits: 8, seconds: 0.5 },
      { rate: 48000, channels: 2, bits: 24, seconds: 0.5 },
      { rate: 16000, channels: 1, bits: 16, seconds: 0.5 },
      { rate: 6000, channels: 1, bits: 16, seconds: 0.5 },
    ]) {
      const { format, data } = parseWav(toVoiceWav(makeWav(w)));
      assert.equal(format.rate, 8000);
      assert.equal(format.channels, 1);
      assert.equal(Math.abs(data.length / 2 - 4000) <= 1, true, JSON.stringify(w));
    }
    const minute = toVoiceWav(makeWav({ rate: 8000, channels: 1, bits: 16, seconds: 60 }));
    assert.ok(minute.length <= 1024 * 1024);
  });

  test("MP3, compressed or float WAV, too long, too many channels and other files are refused plainly", () => {
    assert.match(refusal(Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000!rest-of-an-mp3", "latin1")), /MP3/);
    assert.match(refusal(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0])), /MP3/);
    assert.match(
      refusal(makeWav({ rate: 8000, channels: 1, bits: 8, seconds: 0.1, format: 6 })),
      /compressed \(A-law\)/,
    );
    assert.match(refusal(makeWav({ rate: 8000, channels: 1, bits: 32, seconds: 0.1, format: 3 })), /floating-point/);
    assert.match(
      refusal(makeWav({ rate: 8000, channels: 1, bits: 16, seconds: MAX_SECONDS + 5 })),
      new RegExp(`at most ${MAX_SECONDS} s`),
    );
    assert.match(refusal(makeWav({ rate: 8000, channels: 3, bits: 16, seconds: 0.1 })), /mono or stereo/);
    assert.match(refusal(Buffer.from("just some text, not audio")), /not a WAV/);
    assert.match(refusal(Buffer.alloc(0)), /empty/);
  });
});

// ---------------------------------------------------------------- the decision

const gw = (o: Partial<VoiceGateway> & { id: number }): VoiceGateway => ({
  name: `GW${o.id}`,
  active: true,
  priority: 1,
  callerIdMode: "sender",
  fixedCallerId: "+15550100",
  dialPrefix: "",
  ringTimeoutS: 30,
  retryDelayS: 60,
  ...o,
});
const rule = (o: Partial<VoiceRule> & { id: number }): VoiceRule => ({
  senderId: null,
  receiverId: null,
  prefix: null,
  mccmnc: null,
  repeat: 2,
  gatewayId: null,
  promptName: null,
  promptSha256: null,
  ...o,
});

describe("SMS to voice decision (§8, docs/SMS_TO_VOICE.md)", () => {
  test("the code is the first run of 4 to 8 digits", () => {
    assert.equal(findCode("Your code is 482913"), "482913");
    assert.equal(findCode("PIN 12"), null);
    assert.equal(findCode("Call 0123456789 then enter 4829"), "4829");
    assert.equal(findCode("123 and 12345678 and 9999"), "12345678");
    assert.equal(findCode("no digits"), null);
  });

  test("caller ID, number dialled, phrase and gateway", () => {
    const g = gw({ id: 1, dialPrefix: "00" });
    assert.equal(callerIdFor(g, "+447700900123"), "+447700900123");
    assert.equal(callerIdFor(g, "MYBANK"), "+15550100");
    assert.equal(callerIdFor({ ...g, callerIdMode: "fixed" }, "447700900123"), "+15550100");
    assert.equal(callerIdFor({ ...g, fixedCallerId: null }, "MYBANK"), null);
    assert.equal(dialledNumber(g, "+44 20 7946 0000"), "00442079460000");
    assert.equal(phraseFor("4829", null), "Your verification code is 4, 8, 2, 9.");
    assert.equal(phraseFor("4829", "greeting.wav"), "“greeting.wav” 4, 8, 2, 9.");
    const gateways = [gw({ id: 1, priority: 5 }), gw({ id: 2, priority: 1 }), gw({ id: 3, active: false })];
    assert.deepEqual(pickGateway(rule({ id: 1 }), gateways), { gateway: gateways[1], isDefault: true });
    assert.deepEqual(pickGateway(rule({ id: 1, gatewayId: 1 }), gateways), { gateway: gateways[0], isDefault: false });
    // The rule's own gateway is inactive: the default one places the call.
    assert.equal(pickGateway(rule({ id: 1, gatewayId: 3 }), gateways)?.gateway.id, 2);
    assert.equal(pickGateway(rule({ id: 1 }), [gw({ id: 9, active: false })]), null);
  });

  test("call, or why it goes as an SMS", () => {
    const rules = [rule({ id: 4, senderId: "%otp%", prefix: "4420", repeat: 3, promptName: "hello.wav" })];
    const gateways = [gw({ id: 7, dialPrefix: "9" })];
    const m = { sender: "MyOTP", receiver: "+442079460000", text: "Code 482913", mccmnc: "23415" };
    const d = decideVoice(rules, gateways, m);
    assert.equal(d.outcome, "call");
    assert.deepEqual(d.call, {
      ruleId: 4,
      gatewayId: 7,
      gateway: "GW7",
      gatewayDefault: true,
      dialled: "9442079460000",
      callerId: "+15550100",
      code: "482913",
      prompt: "recording",
      promptName: "hello.wav",
      phrase: "“hello.wav” 4, 8, 2, 9, 1, 3.",
      repeat: 3,
      ringTimeoutS: 30,
      retryDelayS: 60,
    });
    assert.equal(decideVoice(rules, gateways, { ...m, sender: "BANK" }).smsReason, "no_rule");
    assert.equal(decideVoice(rules, gateways, { ...m, text: "PIN 12" }).smsReason, "no_code");
    assert.equal(decideVoice(rules, [gw({ id: 7, active: false })], m).smsReason, "no_gateway");
    assert.equal(decideVoice([rule({ id: 1, mccmnc: "20801" })], gateways, m).smsReason, "no_rule");
  });
});

// ---------------------------------------------------------------- API

const app = await buildServer({ socket: false });
const ready = await dbReady();
const voiceReady =
  ready &&
  (await db()
    .query("SELECT to_regclass('voice_gateways') IS NOT NULL AS ok")
    .then((r) => r.rows[0].ok));
const skip = voiceReady
  ? false
  : "seeded database with migration 105 not available (npm run db:up && npm run seed:small)";
const started = new Date();
const run = Date.now().toString(36).slice(-5);
after(async () => {
  if (voiceReady) {
    await db().query("DELETE FROM sms_voice_rules WHERE inserted_at >= $1", [started]);
    await db().query("DELETE FROM voice_gateways WHERE inserted_at >= $1", [started]);
    await db().query(
      "DELETE FROM changes WHERE inserted_at >= $1 AND entity_type IN ('voice_gateway', 'sms_voice_rule')",
      [started],
    );
  }
  await app.close();
  await closeDb();
});

function check(operationId: string, res: LightMyRequestResponse) {
  const op = operations.find((o) => o.operationId === operationId)!;
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `${operationId} answered ${status}, which the contract does not list: ${res.body}`);
  const validate = op.responses[status];
  if (validate && /json/.test(String(res.headers["content-type"])))
    assert.ok(validate(res.json()), `${operationId} ${status}: ${JSON.stringify(validate.errors)}`);
}
const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });
async function ok(operationId: string, res: Promise<LightMyRequestResponse>, status = 200) {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return /json/.test(String(r.headers["content-type"])) ? r.json() : r;
}
const undo = (change: Change | null) =>
  change ? ok("undoChange", call("POST", `/changes/${change.id}/undo`, {})) : Promise.resolve(null);

const gatewayInput = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  host: "voice-test.example.net",
  port: 5060,
  transport: "udp",
  username: "smsvoice-test",
  fromDomain: null,
  callerIdMode: "sender",
  fixedCallerId: "+15550199",
  dialPrefix: "",
  codecs: ["alaw", "ulaw"],
  maxCalls: 5,
  ringTimeoutS: 30,
  retryDelayS: 60,
  priority: 50,
  status: "active",
  password: "fake-sip-secret",
  ...extra,
});
const ruleInput = (extra: Record<string, unknown> = {}) => ({
  senderId: `V${run}%`,
  receiverId: null,
  prefix: "99977",
  repeat: 2,
  mccmnc: null,
  gatewayId: null,
  status: "active",
  ...extra,
});
const wavUpload = (name: string, wav: Buffer) => ({ name, contentBase64: wav.toString("base64") });

describe("Voice gateways (§8, §13.10, §13.29)", { skip }, () => {
  test("add, list, edit, password write-only, history and undo", async () => {
    const created = await ok("createVoiceGateway", call("POST", "/voice-gateways", gatewayInput(`GW-${run}`)), 201);
    const g = created.record;
    assert.equal(g.passwordSet, true);
    assert.ok(
      !("password" in g) && !JSON.stringify(created).includes("fake-sip-secret"),
      "the password never comes back",
    );
    const { rows } = await db().query("SELECT password_enc FROM voice_gateways WHERE id = $1", [g.id]);
    assert.ok(rows[0].password_enc && !String(rows[0].password_enc).includes("fake-sip-secret"), "stored encrypted");

    const dup = await call("POST", "/voice-gateways", gatewayInput(`gw-${run}`));
    assert.equal(dup.statusCode, 409);
    const fixedWithout = await call(
      "POST",
      "/voice-gateways",
      gatewayInput(`GW2-${run}`, { callerIdMode: "fixed", fixedCallerId: null }),
    );
    assert.equal(fixedWithout.statusCode, 400);
    assert.match(fixedWithout.body, /fixedCallerId/);

    const page = await ok(
      "queryVoiceGateways",
      call("POST", "/voice-gateways/query", {
        limit: 10,
        filter: { logic: "and", conditions: [{ field: "name", op: "like", value: `GW-${run}` }] },
      }),
    );
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].rules, 0);

    // Null keeps the password; moving to another host without typing it again is refused.
    const moved = await call(
      "PUT",
      `/voice-gateways/${g.id}`,
      gatewayInput(`GW-${run}`, { host: "voice-other.example.net", password: null }),
    );
    assert.equal(moved.statusCode, 400);
    assert.match(moved.body, /password/);
    const edited = await ok(
      "updateVoiceGateway",
      call(
        "PUT",
        `/voice-gateways/${g.id}`,
        gatewayInput(`GW-${run}`, { maxCalls: 9, dialPrefix: "00", password: null }),
      ),
    );
    assert.equal(edited.record.maxCalls, 9);
    assert.equal(edited.record.passwordSet, true);
    assert.deepEqual(edited.change.diff.map((d: { field: string }) => d.field).sort(), ["dialPrefix", "maxCalls"]);
    await undo(edited.change);
    const back = await ok("getVoiceGateway", call("GET", `/voice-gateways/${g.id}`));
    assert.equal(back.maxCalls, 5);
    assert.equal(back.dialPrefix, "");
    // A new password is logged as changed, never stored in the history.
    const pw = await ok(
      "updateVoiceGateway",
      call("PUT", `/voice-gateways/${g.id}`, gatewayInput(`GW-${run}`, { password: "another-fake" })),
    );
    assert.equal(pw.change.diff[0].field, "password");
    assert.ok(!JSON.stringify(pw.change).includes("another-fake"));
    const history = await ok(
      "queryChanges",
      call("POST", "/changes/query", {
        limit: 10,
        filter: {
          logic: "and",
          conditions: [
            { field: "entityType", op: "eq", value: "voice_gateway" },
            { field: "entityId", op: "eq", value: g.id },
          ],
        },
      }),
    );
    assert.ok(history.rows.length >= 3);
    assert.ok(history.rows.some((c: { summary?: string }) => c.summary?.includes(`GW-${run}`)));
  });

  test("delete is refused while a rule uses the gateway, then archives and restores", async () => {
    const g = (await ok("createVoiceGateway", call("POST", "/voice-gateways", gatewayInput(`GWD-${run}`)), 201)).record;
    const r = (await ok("createSmsVoiceRule", call("POST", "/sms-voice-rules", ruleInput({ gatewayId: g.id })), 201))
      .record;
    assert.equal(r.gatewayId, g.id);
    assert.equal(r.gateway, `GWD-${run}`);
    const deps = await ok("getVoiceGatewayDependencies", call("GET", `/voice-gateways/${g.id}/dependencies`));
    assert.equal(deps.blocked, true);
    assert.equal(deps.items[0].count, 1);
    const refused = await ok(
      "archiveVoiceGateway",
      call("POST", `/voice-gateways/${g.id}/archive`, { override: true, reason: "x" }),
      409,
    );
    assert.equal(refused.dependencies.blocked, true, "not even an administrator overrides it");
    await ok("archiveSmsVoiceRule", call("POST", `/sms-voice-rules/${r.id}/archive`, {}));
    const archived = await ok("archiveVoiceGateway", call("POST", `/voice-gateways/${g.id}/archive`, {}));
    assert.ok(archived.record.archivedAt);
    // A rule cannot name a deleted gateway, and its deleted rule comes back only with the gateway.
    const bad = await call("POST", "/sms-voice-rules", ruleInput({ gatewayId: g.id }));
    assert.equal(bad.statusCode, 400);
    assert.equal((await call("POST", `/sms-voice-rules/${r.id}/restore`)).statusCode, 409);
    await ok("restoreVoiceGateway", call("POST", `/voice-gateways/${g.id}/restore`));
    await ok("restoreSmsVoiceRule", call("POST", `/sms-voice-rules/${r.id}/restore`));
  });
});

describe("SMS to voice rules with a gateway and a recording (§8)", { skip }, () => {
  test("upload, play, remove, undo; the list shows Default or the file name", async () => {
    const stereo = makeWav({ rate: 44100, channels: 2, bits: 16, seconds: 1.5 });
    const preview = await call("POST", "/sms-voice-rules/recording-preview", wavUpload("hello.wav", stereo));
    assert.equal(preview.statusCode, 200);
    check("previewSmsVoiceRecording", preview);
    assert.match(String(preview.headers["content-type"]), /audio\/wav/);
    const converted = preview.rawPayload;
    assert.deepEqual(parseWav(converted).format, { channels: 1, rate: 8000, bits: 16, blockAlign: 2 });
    const mp3 = await call("POST", "/sms-voice-rules/recording-preview", {
      name: "x.mp3",
      contentBase64: Buffer.from("ID3\u0004rest", "latin1").toString("base64"),
    });
    assert.equal(mp3.statusCode, 400);
    assert.match(mp3.body, /MP3/);

    const created = await ok(
      "createSmsVoiceRule",
      call("POST", "/sms-voice-rules", ruleInput({ recording: wavUpload("hello.wav", stereo) })),
      201,
    );
    const r = created.record;
    assert.equal(r.recording.name, "hello.wav");
    assert.equal(r.recording.bytes, converted.length);
    assert.equal(r.recording.durationMs, 1500);
    assert.equal(r.recording.sha256, createHash("sha256").update(converted).digest("hex"));
    const played = await call("GET", `/sms-voice-rules/${r.id}/recording`);
    assert.equal(played.statusCode, 200);
    check("downloadSmsVoiceRecording", played);
    assert.ok(played.rawPayload.equals(converted));

    const listed = await ok(
      "querySmsVoiceRules",
      call("POST", "/sms-voice-rules/query", {
        limit: 5,
        filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: r.id }] },
      }),
    );
    assert.equal(listed.rows[0].recording.name, "hello.wav");

    // Refused upload: a plain message on the recording field, nothing saved.
    const refused = await call(
      "PUT",
      `/sms-voice-rules/${r.id}`,
      ruleInput({ recording: wavUpload("long.wav", makeWav({ rate: 8000, channels: 1, bits: 16, seconds: 70 })) }),
    );
    assert.equal(refused.statusCode, 400);
    assert.match(refused.body, /\/recording.*at most 65 s/);

    // Left out: the recording stays; null: back to the default phrase, as one undoable change.
    const kept = await ok("updateSmsVoiceRule", call("PUT", `/sms-voice-rules/${r.id}`, ruleInput({ repeat: 3 })));
    assert.equal(kept.record.recording.name, "hello.wav");
    const removed = await ok(
      "updateSmsVoiceRule",
      call("PUT", `/sms-voice-rules/${r.id}`, ruleInput({ repeat: 3, recording: null })),
    );
    assert.equal(removed.record.recording, null);
    const entry = removed.change.diff.find((d: { field: string }) => d.field === "recording");
    assert.deepEqual(
      [entry.before, entry.after],
      ["hello.wav", "Default phrase"],
      "the history shows names, not bytes",
    );
    assert.ok(JSON.stringify(removed.change).length < 5000);
    const defaults = await ok(
      "querySmsVoiceRules",
      call("POST", "/sms-voice-rules/query", {
        limit: 5,
        filter: {
          logic: "and",
          conditions: [
            { field: "id", op: "eq", value: r.id },
            { field: "recording", op: "eq", value: "Default" },
          ],
        },
      }),
    );
    assert.equal(defaults.rows.length, 1);
    assert.equal((await call("GET", `/sms-voice-rules/${r.id}/recording`)).statusCode, 404);
    await undo(removed.change);
    const restored = await ok("getSmsVoiceRule", call("GET", `/sms-voice-rules/${r.id}`));
    assert.equal(restored.recording.sha256, r.recording.sha256);
    assert.ok((await call("GET", `/sms-voice-rules/${r.id}/recording`)).rawPayload.equals(converted));
  });

  test("the test box: the call through the rule's gateway, or why it is an SMS", async () => {
    const g = (
      await ok(
        "createVoiceGateway",
        call("POST", "/voice-gateways", gatewayInput(`GWT-${run}`, { dialPrefix: "00", fixedCallerId: "+15550123" })),
        201,
      )
    ).record;
    const r = (
      await ok(
        "createSmsVoiceRule",
        call("POST", "/sms-voice-rules", ruleInput({ gatewayId: g.id, repeat: 3, prefix: "99976" })),
        201,
      )
    ).record;
    const hit = await ok(
      "testSmsVoiceRules",
      call("POST", "/sms-voice-rules/test", {
        senderId: `V${run}BANK`,
        receiver: "+99976123456",
        text: "Your code is 4829",
      }),
    );
    assert.equal(hit.outcome, "call");
    assert.equal(hit.rule.id, r.id);
    assert.equal(hit.code, "4829");
    assert.equal(hit.call.gatewayId, g.id);
    assert.equal(hit.call.gatewayDefault, false);
    assert.equal(hit.call.dialled, "0099976123456");
    assert.equal(hit.call.callerId, "+15550123", "an alphanumeric sender: the fixed caller ID");
    assert.equal(hit.call.phrase, "Your verification code is 4, 8, 2, 9.");
    assert.equal(hit.call.repeat, 3);
    assert.equal(hit.call.prompt, "default");
    const noCode = await ok(
      "testSmsVoiceRules",
      call("POST", "/sms-voice-rules/test", { senderId: `V${run}BANK`, receiver: "+99976123456", text: "PIN 12" }),
    );
    assert.deepEqual([noCode.outcome, noCode.smsReason, noCode.call], ["sms", "no_code", null]);
    const noRule = await ok(
      "testSmsVoiceRules",
      call("POST", "/sms-voice-rules/test", { senderId: "NOBODY", receiver: "+99976123456", text: "Code 4829" }),
    );
    assert.deepEqual([noRule.outcome, noRule.smsReason, noRule.matched], ["sms", "no_rule", false]);
    // The rule's gateway switched off: the active gateway with the lowest priority calls instead.
    await ok(
      "updateVoiceGateway",
      call("PUT", `/voice-gateways/${g.id}`, gatewayInput(`GWT-${run}`, { status: "inactive", password: null })),
    );
    const { rows } = await db().query(
      "SELECT id FROM voice_gateways WHERE deleted_at IS NULL AND status = 'active' ORDER BY priority, id LIMIT 1",
    );
    const fallback = await ok(
      "testSmsVoiceRules",
      call("POST", "/sms-voice-rules/test", { senderId: `V${run}BANK`, receiver: "+99976123456", text: "Code 4829" }),
    );
    if (rows[0]) {
      assert.equal(fallback.call.gatewayId, Number(rows[0].id));
      assert.equal(fallback.call.gatewayDefault, true);
    } else assert.equal(fallback.smsReason, "no_gateway");
  });

  test("the Route Simulator shows the call instead of a vendor", async () => {
    // A customer trunk with a current, unblocked rate for a destination, and a number of that destination.
    const { rows: candidates } = await db().query(
      `SELECT t.id, d.prefix FROM customer_trunks t
         JOIN customer_trunk_rate_tables x ON x.customer_trunk_id = t.id
         JOIN rate_lines l ON l.rate_table_id = x.rate_table_id AND l.sender_id IS NULL AND NOT l.is_blocked
              AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
         JOIN mccmnc m ON m.id = l.mccmnc_id AND length(m.mccmnc) >= 5
         JOIN dial_codes d ON d.mccmnc_id = m.id AND d.profile = 'All' AND d.deleted_at IS NULL
        WHERE t.deleted_at IS NULL AND t.status = 'active' ORDER BY t.id, d.prefix LIMIT 40`,
    );
    const g = (await ok("createVoiceGateway", call("POST", "/voice-gateways", gatewayInput(`GWS-${run}`)), 201)).record;
    const simulate = (trunk: number, receiver: string, text: string) =>
      ok(
        "runRouteSimulator",
        call("POST", "/route-simulator", {
          customerTrunkId: trunk,
          senderId: "+15550142",
          receiver,
          sourceTon: 1,
          sourceNpi: 1,
          destTon: 1,
          destNpi: 1,
          text,
          dataCoding: 0,
          testSms: true,
        }),
      );
    let picked: { trunk: number; receiver: string } | null = null;
    for (const c of candidates) {
      const receiver = `${c.prefix}${"5550123456".slice(0, Math.max(4, 12 - String(c.prefix).length))}`;
      const before = await simulate(Number(c.id), receiver, "Your code is 4829");
      if (before.customerRate && !before.blocked && !before.voiceCall) {
        picked = { trunk: Number(c.id), receiver: before.receiver };
        break;
      }
    }
    assert.ok(picked, "a trunk with a rate and a free number");
    const r = (
      await ok(
        "createSmsVoiceRule",
        call("POST", "/sms-voice-rules", ruleInput({ senderId: null, prefix: picked.receiver, gatewayId: g.id })),
        201,
      )
    ).record;
    const sim = await simulate(picked.trunk, picked.receiver, "Your code is 4829");
    assert.equal(sim.voiceCall.ruleId, r.id);
    assert.equal(sim.voiceCall.gatewayId, g.id);
    assert.equal(sim.voiceCall.callerId, "+15550142", "a numeric sender is the caller ID");
    assert.equal(sim.blocked, null);
    assert.equal(sim.vendorTranslation, null, "no vendor gets the message");
    assert.equal(sim.vendorCost.rate, 0);
    assert.ok(["DELIVRD", "UNDELIV"].includes(sim.testSms.status));
    assert.match(sim.testSms.detail, new RegExp(`^Called ${picked.receiver} through GWS-${run}`));
    const sms = await simulate(picked.trunk, picked.receiver, "No code here");
    assert.equal(sms.voiceCall, null);
  });
});
