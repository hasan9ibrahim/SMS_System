// Pure helpers for the Switch utilities pages (§8): labels, blank forms, e-mail lists typed as text.
import type { EmailLogRow, SmsVoiceRuleInput, TrafficAlertInput, TrafficAlertRow } from "@sms/contract";

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
  status: "active",
});

/** A file as base64 without the data: prefix (Broadcast attachment). */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
