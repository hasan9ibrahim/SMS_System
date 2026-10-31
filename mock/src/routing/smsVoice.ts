// SMS to voice (§8, decided 2026-10-31, docs/SMS_TO_VOICE.md): after ingress translation and before routing, a
// message that matches an active rule and carries a 4 to 8 digit code is a phone call instead of an SMS. Shared by the
// rule test, the Route Simulator and the live traffic simulator, so all three decide as the switch does.
import type pg from "pg";
import type { SmsVoiceCall } from "@sms/contract";

type Db = pg.Pool | pg.PoolClient;

export interface VoiceRule {
  id: number;
  senderId: string | null;
  receiverId: string | null;
  prefix: string | null;
  mccmnc: string | null;
  repeat: number;
  gatewayId: number | null;
  /** The rule's own recording's file name; null = the default phrase. */
  promptName: string | null;
  promptSha256: string | null;
}

export interface VoiceGateway {
  id: number;
  name: string;
  active: boolean;
  priority: number;
  callerIdMode: "sender" | "fixed";
  fixedCallerId: string | null;
  dialPrefix: string;
  ringTimeoutS: number;
  retryDelayS: number;
}

export interface VoiceMessage {
  /** After ingress translation. */
  sender: string;
  receiver: string;
  text: string;
  /** The receiver's network as routing resolves it; null when unknown. */
  mccmnc: string | null;
}

export type SmsReason = "no_rule" | "no_code" | "no_gateway";

export interface VoiceDecision {
  outcome: "call" | "sms";
  /** An active rule matches the sender, receiver, prefix and destination. */
  rule: VoiceRule | null;
  code: string | null;
  call: SmsVoiceCall | null;
  smsReason: SmsReason | null;
  reason: string;
}

/** % = any characters, _ = one character, case-insensitive (§13.25 wildcards). */
export function likeMatch(pattern: string, value: string): boolean {
  const re = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${re}$`, "i").test(value);
}

/**
 * The code: the first run of 4 to 8 digits in the text. A run is all the digits side by side, so a 10-digit phone
 * number is not a code and "PIN 12" has none.
 */
export function findCode(text: string): string | null {
  for (const m of text.matchAll(/\d+/g)) if (m[0].length >= 4 && m[0].length <= 8) return m[0];
  return null;
}

const digitsOf = (number: string) => number.replace(/\D/g, "");

/** Every field the rule sets matches the message; an empty field matches anything. */
export function ruleMatches(rule: VoiceRule, m: VoiceMessage): boolean {
  const receiver = digitsOf(m.receiver);
  if (rule.senderId && !likeMatch(rule.senderId, m.sender)) return false;
  if (rule.receiverId && !likeMatch(rule.receiverId, receiver)) return false;
  if (rule.prefix && !receiver.startsWith(rule.prefix)) return false;
  if (rule.mccmnc && rule.mccmnc !== m.mccmnc) return false;
  return true;
}

/**
 * The gateway that places the rule's calls: its own while active, else the active gateway with the lowest priority
 * (then the lowest id). Null when no gateway is active.
 */
export function pickGateway(
  rule: VoiceRule,
  gateways: VoiceGateway[],
): { gateway: VoiceGateway; isDefault: boolean } | null {
  const own = rule.gatewayId === null ? null : gateways.find((g) => g.id === rule.gatewayId && g.active);
  if (own) return { gateway: own, isDefault: false };
  const first = gateways.filter((g) => g.active).sort((a, b) => a.priority - b.priority || a.id - b.id)[0];
  return first ? { gateway: first, isDefault: true } : null;
}

/** The sender when it is a number (digits, optional leading +) and the gateway passes it on, else the fixed one. */
export function callerIdFor(g: VoiceGateway, sender: string): string | null {
  const s = sender.trim();
  if (g.callerIdMode === "sender" && /^\+?\d+$/.test(s)) return s;
  return g.fixedCallerId;
}

/** The gateway's dial prefix and the receiver's digits. */
export const dialledNumber = (g: VoiceGateway, receiver: string) => `${g.dialPrefix}${digitsOf(receiver)}`;

/** "4, 8, 2, 9": the digits as Asterisk says them, one by one. */
export const spokenDigits = (code: string) => code.split("").join(", ");

/** What the person hears once: the default phrase, or the rule's recording, then the digits. */
export function phraseFor(code: string, recording: string | null): string {
  return recording ? `“${recording}” ${spokenDigits(code)}.` : `Your verification code is ${spokenDigits(code)}.`;
}

/** What the switch does with the message: the call, or why it stays an SMS. */
export function decideVoice(rules: VoiceRule[], gateways: VoiceGateway[], m: VoiceMessage): VoiceDecision {
  const rule = rules.find((r) => ruleMatches(r, m)) ?? null;
  const code = findCode(m.text);
  if (!rule)
    return {
      outcome: "sms",
      rule,
      code,
      call: null,
      smsReason: "no_rule",
      reason: "No active rule matches: sent as an SMS",
    };
  if (!code)
    return {
      outcome: "sms",
      rule,
      code,
      call: null,
      smsReason: "no_code",
      reason: `Rule ${rule.id} matches, but the text has no 4 to 8 digit code: sent as an SMS`,
    };
  const picked = pickGateway(rule, gateways);
  if (!picked)
    return {
      outcome: "sms",
      rule,
      code,
      call: null,
      smsReason: "no_gateway",
      reason: `Rule ${rule.id} matches, but no voice gateway is active: sent as an SMS`,
    };
  const g = picked.gateway;
  const call: SmsVoiceCall = {
    ruleId: rule.id,
    gatewayId: g.id,
    gateway: g.name,
    gatewayDefault: picked.isDefault,
    dialled: dialledNumber(g, m.receiver),
    callerId: callerIdFor(g, m.sender),
    code,
    prompt: rule.promptName ? "recording" : "default",
    promptName: rule.promptName,
    phrase: phraseFor(code, rule.promptName),
    repeat: rule.repeat,
    ringTimeoutS: g.ringTimeoutS,
    retryDelayS: g.retryDelayS,
  };
  return {
    outcome: "call",
    rule,
    code,
    call,
    smsReason: null,
    reason: `Rule ${rule.id} matches: a call through ${g.name} to ${call.dialled}`,
  };
}

export const VOICE_RULE_COLUMNS = `sv.id, sv.sender_id, sv.receiver_id, sv.prefix, sv.mccmnc, sv.repeat_count, sv.gateway_id,
  sv.prompt_wav_name, sv.prompt_wav_sha256`;

export const toVoiceRule = (r: Record<string, unknown>): VoiceRule => ({
  id: Number(r.id),
  senderId: (r.sender_id as string | null) ?? null,
  receiverId: (r.receiver_id as string | null) ?? null,
  prefix: (r.prefix as string | null) ?? null,
  mccmnc: (r.mccmnc as string | null) ?? null,
  repeat: Number(r.repeat_count),
  gatewayId: r.gateway_id == null ? null : Number(r.gateway_id),
  promptName: (r.prompt_wav_name as string | null) ?? null,
  promptSha256: (r.prompt_wav_sha256 as string | null) ?? null,
});

const toGateway = (r: Record<string, unknown>): VoiceGateway => ({
  id: Number(r.id),
  name: String(r.name),
  active: r.status === "active",
  priority: Number(r.priority),
  callerIdMode: r.caller_id_mode as VoiceGateway["callerIdMode"],
  fixedCallerId: (r.fixed_caller_id as string | null) ?? null,
  dialPrefix: String(r.dial_prefix ?? ""),
  ringTimeoutS: Number(r.ring_timeout_s),
  retryDelayS: Number(r.retry_delay_s),
});

/** The active rules in order of id and the gateways that are not deleted, as the switch loads them. */
export async function loadVoiceConfig(db: Db): Promise<{ rules: VoiceRule[]; gateways: VoiceGateway[] }> {
  const [rules, gateways] = await Promise.all([
    db.query(
      `SELECT ${VOICE_RULE_COLUMNS} FROM sms_voice_rules sv WHERE sv.deleted_at IS NULL AND sv.status = 'active'
        ORDER BY sv.id`,
    ),
    db.query(
      `SELECT id, name, status, priority, caller_id_mode, fixed_caller_id, dial_prefix, ring_timeout_s, retry_delay_s
         FROM voice_gateways WHERE deleted_at IS NULL ORDER BY id`,
    ),
  ]);
  return { rules: rules.rows.map(toVoiceRule), gateways: gateways.rows.map(toGateway) };
}

/** Asterisk hangup causes of a call that was not answered, with how often each happens in the simulation. */
export const UNANSWERED_CAUSES: [string, number][] = [
  ["NO_ANSWER", 55],
  ["USER_BUSY", 25],
  ["CALL_REJECTED", 8],
  ["CONGESTION", 7],
  ["NO_ROUTE_DESTINATION", 5],
];

/** A simulated call (test system, no Asterisk): answered about 80 % of the time. */
export function simulateCall(random: () => number = Math.random): {
  answered: boolean;
  hangupCause: string;
  durationMs: number;
} {
  if (random() < 0.8)
    return { answered: true, hangupCause: "NORMAL_CLEARING", durationMs: Math.round(9000 + random() * 14000) };
  let roll = random() * 100;
  for (const [cause, weight] of UNANSWERED_CAUSES) {
    roll -= weight;
    if (roll <= 0) return { answered: false, hangupCause: cause, durationMs: 0 };
  }
  return { answered: false, hangupCause: "NO_ANSWER", durationMs: 0 };
}
