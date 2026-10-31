// Pure helpers for the Switch utilities pages (§8): labels, blank forms, e-mail lists typed as text.
import type {
  EmailLogRow,
  SmsVoiceRuleInput,
  SmsVoiceRuleRow,
  TrafficAlertInput,
  TrafficAlertRow,
  VoiceGatewayCodec,
  VoiceGatewayInput,
  VoiceGatewayRow,
} from "@sms/contract";

type Tone = "good" | "warning" | "error" | "neutral" | "accent";

export const EMAIL_TYPE: Record<EmailLogRow["emailType"], string> = {
  send_rate: "Send Rate",
  send_tech_info: "Send Tech Info",
  invoice: "Invoice",
  check_smtp: "Check SMTP Connection",
  bind_down_alert: "Bind Down Alert",
  otp: "OTP",
  forgot_password: "Forgot Password",
  auto_upload_rate: "Auto Upload Rate",
  credit_alert: "Credit Alert",
  balance_alert: "Balance Alert",
  schedule_report_alert: "Schedule Report Alert",
  traffic_alert: "Traffic Alert",
  auto_upload_rejected: "Auto Upload Report – Rejected",
  daily_report: "Daily Report",
  broadcast: "Broadcast",
  trouble_ticket: "Trouble Ticket",
  send_soa: "Send SOA",
  payment_confirmation: "Payment Confirmation",
  invoice_acceptance: "Invoice Acceptance",
  invoice_rejection: "Invoice Rejection",
  monitoring_alert: "Monitoring Alert",
  cleanup_summary: "Cleanup Summary",
  credential_transfer: "Credential Transfer",
  password_reminder: "Password Reminder",
  template_test: "Template Test",
  currency_alert: "Currency Alert",
  rn_reminder: "RN Reminder",
  password_setup: "Password Set-up Link",
  am_handover: "Account Manager Handover",
};

export const ALERT_STATE: Record<TrafficAlertRow["state"], { label: string; tone: Tone }> = {
  ok: { label: "OK", tone: "good" },
  firing: { label: "Firing", tone: "error" },
  too_few: { label: "Too few messages", tone: "neutral" },
  unknown: { label: "Not checked", tone: "neutral" },
};

export const LISTENER: Record<string, string> = {
  smpp: "SMPP",
  http: "HTTP API",
  portal: "Portal",
  all: "All listeners",
};

/** E-mails typed as text: comma, semicolon, space or new line between them. */
export function parseEmails(text: string): { emails: string[]; invalid: string[] } {
  const parts = text
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const ok = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  return { emails: [...new Set(parts.filter(ok))], invalid: parts.filter((e) => !ok(e)) };
}

export function blankAlert(): TrafficAlertInput {
  return {
    name: "",
    sampleCount: 100,
    sampleMinutes: 15,
    asrThreshold: 70,
    dlrThreshold: 50,
    marginThreshold: 0,
    customerTrunkId: 0,
    vendorTrunkId: null,
    senderId: null,
    mccmnc: null,
    delayThreshold: null,
    notificationEmails: [],
    contactEmail: "none",
    templateId: 5,
    status: "active",
  };
}

export const alertInput = (r: TrafficAlertRow): TrafficAlertInput => ({
  name: r.name,
  sampleCount: r.sampleCount,
  sampleMinutes: r.sampleMinutes,
  asrThreshold: r.asrThreshold,
  dlrThreshold: r.dlrThreshold,
  marginThreshold: r.marginThreshold,
  customerTrunkId: r.customerTrunkId,
  vendorTrunkId: r.vendorTrunkId,
  senderId: r.senderId,
  mccmnc: r.mccmnc,
  delayThreshold: r.delayThreshold,
  notificationEmails: r.notificationEmails,
  contactEmail: r.contactEmail,
  templateId: r.templateId,
  status: r.status,
});

export const blankVoiceRule = (): SmsVoiceRuleInput => ({
  senderId: null,
  receiverId: null,
  prefix: null,
  repeat: 2,
  mccmnc: null,
  gatewayId: null,
  status: "active",
});

/** The rule form's values from a saved rule (the recording is chosen beside the form). */
export const voiceRuleInput = (r: SmsVoiceRuleRow): SmsVoiceRuleInput => ({
  senderId: r.senderId,
  receiverId: r.receiverId,
  prefix: r.prefix,
  repeat: r.repeat,
  mccmnc: r.mccmnc,
  gatewayId: r.gatewayId,
  status: r.status,
});

// ---------------------------------------------------------------- voice gateways (§8)

export const blankVoiceGateway = (): VoiceGatewayInput => ({
  name: "",
  host: "",
  port: 5060,
  transport: "udp",
  username: null,
  fromDomain: null,
  callerIdMode: "sender",
  fixedCallerId: null,
  dialPrefix: "",
  codecs: ["alaw", "ulaw"],
  maxCalls: 10,
  ringTimeoutS: 30,
  retryDelayS: 60,
  priority: 1,
  status: "active",
  password: null,
});

/** The form's values from a saved gateway; the password stays as it is unless one is typed. */
export const voiceGatewayInput = (r: VoiceGatewayRow): VoiceGatewayInput => ({
  name: r.name,
  host: r.host,
  port: r.port,
  transport: r.transport,
  username: r.username,
  fromDomain: r.fromDomain,
  callerIdMode: r.callerIdMode,
  fixedCallerId: r.fixedCallerId,
  dialPrefix: r.dialPrefix,
  codecs: r.codecs,
  maxCalls: r.maxCalls,
  ringTimeoutS: r.ringTimeoutS,
  retryDelayS: r.retryDelayS,
  priority: r.priority,
  status: r.status,
  password: null,
});

export const TRANSPORTS: { value: VoiceGatewayRow["transport"]; label: string }[] = [
  { value: "udp", label: "UDP" },
  { value: "tcp", label: "TCP" },
  { value: "tls", label: "TLS" },
];

export const CODECS: { value: VoiceGatewayCodec; label: string }[] = [
  { value: "alaw", label: "G.711 A-law" },
  { value: "ulaw", label: "G.711 µ-law" },
  { value: "g722", label: "G.722" },
  { value: "gsm", label: "GSM" },
];
export const codecLabel = (c: string) => CODECS.find((x) => x.value === c)?.label ?? c;

export const CALLER_ID_MODES: { value: VoiceGatewayRow["callerIdMode"]; label: string }[] = [
  { value: "sender", label: "The sender when it is a number" },
  { value: "fixed", label: "Always the fixed caller ID" },
];

/** "sip:voice-gw1.example.net:5060 (UDP)". */
export const gatewayAddress = (g: Pick<VoiceGatewayRow, "host" | "port" | "transport">) =>
  `${g.transport === "tls" ? "sips" : "sip"}:${g.host}:${g.port} (${g.transport.toUpperCase()})`;

/** "12.3 s", or "1 min 5 s" from a minute. */
export function fmtDurationMs(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** "said twice, one second apart". */
export function repeatText(n: number): string {
  if (n === 1) return "said once";
  return `said ${n === 2 ? "twice" : `${n} times`}, one second apart`;
}

/** The largest WAV the server takes as uploaded (it is converted to mono 8 kHz, at most 1 MB). */
export const MAX_RECORDING_UPLOAD = 10 * 1024 * 1024;

/** A file as base64 without the data: prefix (Broadcast attachment). */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
