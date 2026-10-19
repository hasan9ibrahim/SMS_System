// Passwords, 2FA and stored secrets for Admin (§11, §13.28). Passwords are kept only as scrypt hashes;
// the rules are checked here for every screen that sets one. TOTP follows RFC 6238 (SHA-1, 6 digits,
// 30 s steps). Mailbox secrets are encrypted with a dev-only key in this phase (CLAUDE.md rule 1: fake).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/** §13.28 floors: the settings can raise these, never lower them (and the lifetime can't be turned off). */
export const MIN_PASSWORD_LENGTH = 12;
export const PASSWORD_HISTORY = 12;

/** Admin › Security settings (§13.28), cached for a few seconds; loadPolicy refreshes it from the database. */
export interface PasswordPolicy {
  passwordLifetimeDays: number;
  reminderDays: number[];
  tempPasswordHours: number;
  minPasswordLength: number;
  passwordHistory: number;
}
export const DEFAULT_POLICY: PasswordPolicy = {
  passwordLifetimeDays: Number(process.env.PASSWORD_LIFETIME_DAYS ?? 30),
  reminderDays: [7, 3, 1],
  tempPasswordHours: 24,
  minPasswordLength: MIN_PASSWORD_LENGTH,
  passwordHistory: PASSWORD_HISTORY,
};
let cached: { policy: PasswordPolicy; at: number } = { policy: DEFAULT_POLICY, at: 0 };
export const policy = () => cached.policy;
export const mapPolicy = (r: Record<string, unknown>): PasswordPolicy => ({
  passwordLifetimeDays: Number(r.password_lifetime_days),
  reminderDays: (r.reminder_days as number[]).map(Number).sort((a, b) => b - a),
  tempPasswordHours: Number(r.temp_password_hours),
  minPasswordLength: Number(r.min_password_length),
  passwordHistory: Number(r.password_history),
});
export async function loadPolicy(
  c: { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> },
  force = false,
): Promise<PasswordPolicy> {
  if (!force && Date.now() - cached.at < 5000) return cached.policy;
  const { rows } = await c.query("SELECT * FROM security_settings WHERE id = 1");
  cached = { policy: rows[0] ? mapPolicy(rows[0]) : DEFAULT_POLICY, at: Date.now() };
  return cached.policy;
}
/** The lifetime as SQL, so lists and the gate follow the settings at once. */
export const LIFETIME_SQL =
  "make_interval(days => (SELECT password_lifetime_days FROM security_settings WHERE id = 1))";

const DAY = 86_400_000;

// scrypt N=4096 keeps the generator fast; the backend picks its own cost (BACKEND_TODO).
const N = 4096;
export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  const hash = scryptSync(password.normalize("NFKC"), salt, 32, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [kind, n, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64"), want.length, {
    N: Number(n),
    r: 8,
    p: 1,
  });
  return timingSafeEqual(want, got);
}

/** A short list standing in for a known-leaked password list (the backend uses a full k-anonymity check). */
const LEAKED = new Set(
  [
    "123456789012",
    "password1234",
    "password12345",
    "passwordpassword",
    "qwertyuiop12",
    "qwertyuiopasdf",
    "letmein123456",
    "welcome12345",
    "iloveyou1234",
    "admin1234567",
    "administrator",
    "changeme1234",
    "111111111111",
    "000000000000",
    "abc123456789",
    "p@ssw0rd1234",
    "football1234",
    "monkey123456",
    "sunshine1234",
    "trustno1trustno1",
  ].map((p) => p.toLowerCase()),
);

export interface RuleResult {
  key: "length" | "not_name" | "not_recent" | "not_leaked";
  label: string;
  met: boolean;
}

/** §13.28 new-password rules, each reported so the screen can tick them as they are met. */
export function passwordRules(
  password: string,
  who: { username?: string | null; firstName?: string | null; lastName?: string | null },
  recentHashes: string[],
  pol: PasswordPolicy = policy(),
): RuleResult[] {
  const p = password.toLowerCase();
  const names = [who.username, who.firstName, who.lastName]
    .map((n) => (n ?? "").trim().toLowerCase())
    .filter((n) => n.length >= 3);
  return [
    {
      key: "length",
      label: `At least ${pol.minPasswordLength} characters`,
      met: [...password].length >= pol.minPasswordLength,
    },
    {
      key: "not_name",
      label: "Not your username or name",
      met: password.length > 0 && !names.some((n) => p.includes(n)),
    },
    {
      key: "not_recent",
      label: `Not one of your last ${pol.passwordHistory} passwords`,
      met: password.length > 0 && !recentHashes.some((h) => verifyPassword(password, h)),
    },
    { key: "not_leaked", label: "Not on a known-leaked password list", met: password.length > 0 && !LEAKED.has(p) },
  ];
}

export const passwordExpiry = (changedAt: Date, pol: PasswordPolicy = policy()) =>
  new Date(changedAt.getTime() + pol.passwordLifetimeDays * DAY);
/** Known-leaked list size, for the settings page. */
export const leakedListSize = () => LEAKED.size;
export const daysLeft = (expiresAt: Date, now = Date.now()) => Math.floor((expiresAt.getTime() - now) / DAY);

// ---------------------------------------------------------------- TOTP (RFC 6238)

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32(randomBytes(20));

export function totpCode(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", unbase32(secret)).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, "0");
}
/** Accepts the current 30 s step and one either side. */
export const verifyTotp = (secret: string, code: string, at = Date.now()) =>
  [-1, 0, 1].some((d) => totpCode(secret, at + d * 30_000) === code);
export const otpauthUri = (secret: string, account: string) =>
  `otpauth://totp/SMS%20Platform:${encodeURIComponent(account)}?secret=${secret}&issuer=SMS%20Platform&digits=6&period=30`;

// ---------------------------------------------------------------- stored secrets

const KEY = createHash("sha256")
  .update(process.env.MOCK_SECRET_KEY ?? "dev-only-not-a-real-key")
  .digest();
/** `iv` is for deterministic seeds only; at runtime every secret gets a random one. */
export function encryptSecret(plain: string, iv: Buffer = randomBytes(12)): string {
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `enc:v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64")}`;
}
export function decryptSecret(stored: string): string | null {
  if (!stored.startsWith("enc:v1:")) return null;
  const raw = Buffer.from(stored.slice(7), "base64");
  try {
    const d = createDecipheriv("aes-256-gcm", KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
