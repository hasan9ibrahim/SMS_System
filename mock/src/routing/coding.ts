// The coding a message goes to a vendor in (spec §5.5 AllowedDataCodingList, docs/SMPP_SCENARIOS.md S-2.11, S-3.12,
// S-4.4), as the switch works it out (backend/apps/sms_switch/lib/sms/switch/message/coding.ex and text.ex) for the
// Route Simulator, the rule Test and Simulate:
//   * a text no translation changed goes as the customer sent it; a changed one is encoded again in its alphabet, or
//     in UCS-2 when a character no longer fits (S-4.4);
//   * Latin-1 under data_coding 0 (a customer trunk whose Default Coding is Latin-1) goes in GSM when every character
//     has one and it needs no more parts, else as data_coding 3 (S-2.11);
//   * a coding the vendor does not allow is converted to one it allows when the text fits and needs no more parts
//     (3 → 0 when every character is in GSM); otherwise the vendor cannot take the message.
// Lengths are in the alphabet's own units (septets for 7-bit, escapes counting, UTF-16 units for UCS-2, bytes
// otherwise); parts are 160 / 153 septets, 70 / 67 units, 140 / 134 bytes, never cutting an escape or a surrogate pair.

import { senderRefusal } from "./tonNpi.js";

export type Alphabet = "gsm" | "ascii" | "latin1" | "ucs2" | "binary";

// GSM 03.38 default alphabet, code 0x00..0x7F (0x1B is the escape to the extension table).
const BASIC = [
  "@", "£", "$", "¥", "è", "é", "ù", "ì", "ò", "Ç", "\n", "Ø", "ø", "\r", "Å", "å",
  "Δ", "_", "Φ", "Γ", "Λ", "Ω", "Π", "Ψ", "Σ", "Θ", "Ξ", null, "Æ", "æ", "ß", "É",
  " ", "!", '"', "#", "¤", "%", "&", "'", "(", ")", "*", "+", ",", "-", ".", "/",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ":", ";", "<", "=", ">", "?",
  "¡", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O",
  "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "Ä", "Ö", "Ñ", "Ü", "§",
  "¿", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o",
  "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "ä", "ö", "ñ", "ü", "à",
]; // prettier-ignore
const GSM_BASIC = new Set(BASIC.filter((c): c is string => c !== null));
const GSM_EXTENSION = new Set(["\f", "^", "{", "}", "\\", "[", "~", "]", "|", "€"]);

/** The alphabet a data_coding means; 0 is Latin-1 on a customer trunk whose Default Coding is 3. */
export function alphabetOf(dataCoding: number, defaultCoding = 0): Alphabet {
  if (dataCoding === 0) return defaultCoding === 3 ? "latin1" : "gsm";
  if (dataCoding === 1) return "ascii";
  if (dataCoding === 3) return "latin1";
  if (dataCoding === 8) return "ucs2";
  if (dataCoding >= 0x10 && dataCoding <= 0x3f && (dataCoding & 0x20) === 0) {
    const g = dataCoding & 0x0c;
    return g === 0 ? "gsm" : g === 8 ? "ucs2" : "binary";
  }
  if (dataCoding >= 0xc0 && dataCoding <= 0xdf) return "gsm";
  if (dataCoding >= 0xe0 && dataCoding <= 0xef) return "ucs2";
  if (dataCoding >= 0xf0 && dataCoding <= 0xff) return (dataCoding & 0x04) === 0 ? "gsm" : "binary";
  return "binary";
}

/** The width of each character of `text` in `alphabet`'s units, or null when a character does not exist in it. */
export function encode(text: string, alphabet: Alphabet): number[] | null {
  const widths: number[] = [];
  for (const ch of text) {
    if (alphabet === "gsm") {
      if (GSM_BASIC.has(ch)) widths.push(1);
      else if (GSM_EXTENSION.has(ch)) widths.push(2);
      else return null;
    } else if (alphabet === "ascii") {
      if (ch.codePointAt(0)! >= 0x80) return null;
      widths.push(1);
    } else if (alphabet === "latin1") {
      if (ch.codePointAt(0)! > 0xff) return null;
      widths.push(1);
    } else if (alphabet === "ucs2") widths.push(ch.length);
    else return null;
  }
  return widths;
}

/** Characters as the customer's bytes carry them: a character its coding lacks is one unit (shown as "?", S-4.6). */
function asSent(text: string, alphabet: Alphabet): number[] {
  if (alphabet === "binary") return Array.from(Buffer.from(text, "latin1"), () => 1);
  return encode(text, alphabet) ?? Array.from(text, (ch) => (alphabet === "ucs2" ? ch.length : 1));
}

const units = (widths: number[]) => widths.reduce((a, w) => a + w, 0);

/** How many SMS parts the characters need (0 for none, which still go as one empty part). */
export function partCount(widths: number[], alphabet: Alphabet): number {
  const total = units(widths);
  if (total === 0) return 0;
  const [single, per] =
    alphabet === "gsm" || alphabet === "ascii" ? [160, 153] : alphabet === "ucs2" ? [70, 67] : [140, 134];
  if (total <= single) return 1;
  let parts = 1;
  let fill = 0;
  for (const w of widths) {
    if (fill + w > per) {
      parts++;
      fill = 0;
    }
    fill += w;
  }
  return parts;
}

/** The coding a text needs when none is given (the rule Test and Simulate): GSM when every character has one, else UCS-2. */
export const textCoding = (text: string) => (encode(text, "gsm") ? 0 : 8);

/** The message as the customer sent it: its text, in the coding the customer sent it. */
export interface MessageForm {
  text: string;
  dataCoding: number;
  /** The customer trunk's Default Coding (0 GSM, 3 Latin-1), for data_coding 0. */
  defaultCoding?: number;
}

export interface VendorCoding {
  alphabet: Alphabet;
  dataCoding: number;
  /** Length in the alphabet's units, and the SMS parts. */
  units: number;
  parts: number;
}

/** The form's own coding, length and parts (Deny Multipart counts these, §6.3). */
export function natural(form: MessageForm, text: string | null = null): VendorCoding | null {
  const sent = alphabetOf(form.dataCoding, form.defaultCoding);
  let alphabet = sent;
  let dataCoding = form.dataCoding;
  let widths: number[];
  if (text === null || text === form.text) widths = asSent(form.text, sent);
  else {
    // A changed text: its own alphabet when every character fits, else UCS-2 (S-4.4).
    if (sent !== "binary" && encode(text, sent) === null) alphabet = "ucs2";
    const w = encode(text, alphabet);
    if (!w) return null;
    widths = w;
    if (alphabet === "ucs2" && dataCoding !== 8 && alphabetOf(dataCoding) !== "ucs2") dataCoding = 8;
  }
  // Latin-1 under data_coding 0 would be read as GSM by the vendor: GSM when it fits in no more parts, else 3 (S-2.11).
  if (alphabet === "latin1" && dataCoding === 0) {
    const gsm = encode(text ?? form.text, "gsm");
    if (gsm && partCount(gsm, "gsm") <= partCount(widths, "latin1")) {
      alphabet = "gsm";
      widths = gsm;
    } else dataCoding = 3;
  }
  return { alphabet, dataCoding, units: units(widths), parts: partCount(widths, alphabet) };
}

// The codings a text may be converted to, in the order tried.
const CONVERSIONS: [Alphabet, number][] = [
  ["gsm", 0],
  ["ascii", 1],
  ["latin1", 3],
  ["ucs2", 8],
];

/**
 * The coding the message goes to a vendor in, its text after the vendor's egress translation being `text`, the vendor
 * allowing `allowed` codings (null: any). "unencodable": a changed text that cannot be encoded; "coding_not_allowed":
 * no coding the vendor allows fits.
 */
export function forVendor(
  form: MessageForm,
  text: string | null,
  allowed: number[] | null,
): VendorCoding | "unencodable" | "coding_not_allowed" {
  const n = natural(form, text);
  if (!n) return "unencodable";
  if (allowed === null || allowed.includes(n.dataCoding)) return n;
  if (n.alphabet === "binary") return "coding_not_allowed";
  const body = text ?? form.text;
  for (const [alphabet, dataCoding] of CONVERSIONS) {
    if (!allowed.includes(dataCoding)) continue;
    const w = encode(body, alphabet);
    if (w && partCount(w, alphabet) <= n.parts)
      return { alphabet, dataCoding, units: units(w), parts: partCount(w, alphabet) };
  }
  return "coding_not_allowed";
}

/** A vendor trunk's capability filter (§5.5): null lists allow any value. */
export interface VendorCapabilities {
  allowedDataCodings: number[] | null;
  allowedSrcTon: number[] | null;
  allowedSrcNpi: number[] | null;
  allowedDstTon: number[] | null;
  allowedDstNpi: number[] | null;
  maxMsgLen: number | null;
  supportMultipart: boolean;
  /** Refuse invalid senders (S-2.10, S-4.7): a sender a handset cannot show is not sent to it. Default true. */
  refuseInvalidSenders?: boolean;
}

/** The message a vendor would get after its egress translation; a TON or NPI left out is not checked. */
export interface VendorMessage {
  form: MessageForm;
  /** The text after the vendor's egress translation. */
  text: string;
  /** The sender after the vendor's egress translation (and its TON / NPI fixes); left out = not checked (S-4.7). */
  sender?: string;
  senderTon?: number | null;
  senderNpi?: number | null;
  destTon?: number | null;
  destNpi?: number | null;
}

/**
 * Why the vendor cannot take the message as it would get it after its egress translation, or null when it can
 * (switch router.ex incapable/3, S-3.9, S-4.4, S-4.7): a sender it refuses (senderRefusal), a source or destination
 * TON / NPI it does not allow, a data coding it does not allow that the text fits no other way, a multipart message
 * it does not support, or longer than its Max Msg Len. Checked in that order, as the switch does.
 */
export function incapable(caps: VendorCapabilities, msg: VendorMessage): string | null {
  const refused = refusedSender(caps, msg);
  if (refused) return refused;
  const field: [string, number[] | null, number | null | undefined][] = [
    ["source TON", caps.allowedSrcTon, msg.senderTon],
    ["source NPI", caps.allowedSrcNpi, msg.senderNpi],
    ["destination TON", caps.allowedDstTon, msg.destTon],
    ["destination NPI", caps.allowedDstNpi, msg.destNpi],
  ];
  for (const [name, list, value] of field)
    if (list && value !== null && value !== undefined && !list.includes(value))
      return `${name} ${value} is not allowed (it takes ${list.join(", ") || "none"})`;
  const coding = forVendor(msg.form, msg.text, caps.allowedDataCodings);
  if (coding === "unencodable") return "the translated text cannot be encoded";
  if (coding === "coding_not_allowed")
    return `data coding ${natural(msg.form, msg.text)?.dataCoding ?? msg.form.dataCoding} is not allowed and the text fits none it takes (${(caps.allowedDataCodings ?? []).join(", ")})`;
  if (caps.maxMsgLen !== null && coding.units > caps.maxMsgLen)
    return `${coding.units} characters, longer than its Max Msg Len ${caps.maxMsgLen}`;
  if (!caps.supportMultipart && coding.parts > 1) return `${coding.parts} parts, and it does not support multipart`;
  return null;
}

/** Why the vendor refuses the message's sender (incapable's first check), or null; no sender given: not checked. */
export const refusedSender = (caps: VendorCapabilities, msg: VendorMessage): string | null =>
  msg.sender === undefined
    ? null
    : senderRefusal(msg.sender, msg.senderTon, msg.senderNpi, caps.refuseInvalidSenders !== false);
