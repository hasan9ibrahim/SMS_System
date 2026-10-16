/**
 * Fake names (CLAUDE.md rule 1: no real customer or vendor names). Company and
 * brand names are built from invented syllables; person names are common given
 * and family names combined at random. Domains use the reserved .example TLD,
 * IPs come from RFC 5737 documentation ranges and RFC 1918 private ranges.
 */
import type { Rng } from "./rng.js";

const SYL_START = [
  "Al",
  "Bel",
  "Cor",
  "Dar",
  "El",
  "Fen",
  "Gal",
  "Hal",
  "Ir",
  "Jun",
  "Kal",
  "Lun",
  "Mar",
  "Nor",
  "Or",
  "Pel",
  "Quin",
  "Ras",
  "Sol",
  "Tal",
  "Ul",
  "Ven",
  "Wex",
  "Xan",
  "Yor",
  "Zen",
  "Bri",
  "Cal",
  "Dov",
  "Ery",
  "Fal",
  "Gor",
  "Hel",
  "Isk",
  "Kor",
  "Lys",
  "Mev",
  "Nex",
  "Oza",
  "Pry",
  "Rov",
  "Syl",
  "Tor",
  "Vex",
  "Wyn",
  "Zar",
];
const SYL_MID = ["a", "e", "i", "o", "u", "ar", "en", "is", "or", "um", "el", "av", "ex", "ir", "on", "al", "ev", "yn"];
const SYL_END = [
  "tra",
  "vex",
  "nix",
  "lia",
  "tis",
  "cor",
  "dex",
  "mos",
  "nar",
  "qua",
  "ria",
  "ton",
  "vis",
  "zor",
  "bis",
  "lon",
  "ven",
  "xa",
  "ro",
  "dia",
  "nta",
  "phy",
  "sar",
  "tek",
];
const COMPANY_WORDS = [
  "Telecom",
  "Mobile",
  "Networks",
  "Communications",
  "Messaging",
  "Global",
  "Connect",
  "Telco",
  "Wireless",
  "Digital",
  "Solutions",
  "Link",
  "Gateway",
  "Interactive",
  "Media",
];
const LEGAL = ["Ltd", "LLC", "FZE", "GmbH", "SA", "Pte Ltd", "BV", "Inc", "SRL", "AB", "Oy", "DMCC", ""];

export const FIRST_NAMES = [
  "Adam",
  "Aisha",
  "Ali",
  "Amir",
  "Ana",
  "Anna",
  "Arjun",
  "Bilal",
  "Carla",
  "Chen",
  "Daniel",
  "David",
  "Diana",
  "Elena",
  "Emma",
  "Farah",
  "Fatima",
  "Gabriel",
  "Hana",
  "Hassan",
  "Ibrahim",
  "Ines",
  "Ivan",
  "Jana",
  "Javier",
  "John",
  "Karim",
  "Lara",
  "Layla",
  "Leo",
  "Lina",
  "Luca",
  "Maya",
  "Mehmet",
  "Mia",
  "Mohamed",
  "Nadia",
  "Nina",
  "Noah",
  "Omar",
  "Priya",
  "Rahul",
  "Rana",
  "Rami",
  "Rosa",
  "Sami",
  "Sara",
  "Sofia",
  "Tariq",
  "Tom",
  "Victor",
  "Yara",
  "Yusuf",
  "Zain",
  "Zara",
];
export const LAST_NAMES = [
  "Abbas",
  "Ahmed",
  "Alvarez",
  "Bauer",
  "Becker",
  "Costa",
  "Daher",
  "Demir",
  "Diaz",
  "Farouk",
  "Fischer",
  "Garcia",
  "Haddad",
  "Hamdan",
  "Hansen",
  "Ivanova",
  "Jansen",
  "Kamal",
  "Khan",
  "Khoury",
  "Kim",
  "Kowalski",
  "Lambert",
  "Lee",
  "Lopez",
  "Mansour",
  "Martin",
  "Meyer",
  "Moreau",
  "Nasser",
  "Novak",
  "Okafor",
  "Ozturk",
  "Patel",
  "Perez",
  "Petrov",
  "Rahman",
  "Rossi",
  "Saad",
  "Saleh",
  "Santos",
  "Schmidt",
  "Sharma",
  "Silva",
  "Singh",
  "Taha",
  "Tan",
  "Wang",
  "Weber",
  "Yilmaz",
  "Younes",
  "Zayed",
];

const CITY_PARTS = ["North", "South", "East", "West", "Port", "Lake", "New", "Old", "Upper", "Lower"];
const STREET = [
  "Harbour Road",
  "Market Street",
  "Station Avenue",
  "Park Lane",
  "Business Bay",
  "Tower Plaza",
  "Innovation Way",
  "Riverside Drive",
  "Central Square",
  "Garden Street",
];

const SENDER_WORDS = [
  "VERIFY",
  "SECURE",
  "ALERT",
  "INFO",
  "NOTIFY",
  "PAY",
  "SHOP",
  "BANK",
  "TAXI",
  "FOOD",
  "TRAVEL",
  "HEALTH",
  "GAME",
  "CLOUD",
  "MAIL",
  "CODE",
  "AUTH",
  "PROMO",
  "DEALS",
  "POST",
];

export function syllableWord(rng: Rng): string {
  const parts = [rng.pick(SYL_START)];
  if (rng.chance(0.5)) parts.push(rng.pick(SYL_MID));
  parts.push(rng.pick(SYL_END));
  return parts.join("");
}

export function companyName(rng: Rng): string {
  const legal = rng.pick(LEGAL);
  return `${syllableWord(rng)} ${rng.pick(COMPANY_WORDS)}${legal ? " " + legal : ""}`;
}

/** Uppercase alias from a company name, 4–8 letters. */
export function aliasOf(name: string): string {
  return name
    .split(" ")[0]!
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 8);
}

export function domainOf(name: string): string {
  return `${name
    .split(" ")[0]!
    .toLowerCase()
    .replace(/[^a-z]/g, "")}.example`;
}

export function personName(rng: Rng): { first: string; last: string } {
  return { first: rng.pick(FIRST_NAMES), last: rng.pick(LAST_NAMES) };
}

export function city(rng: Rng): string {
  return `${rng.pick(CITY_PARTS)} ${syllableWord(rng)}`;
}

export function street(rng: Rng): string {
  return `${rng.int(1, 450)} ${rng.pick(STREET)}`;
}

/** Fake phone in E.164 using the reserved-looking 555 block after the country code. */
export function phone(rng: Rng, dialCode: string): string {
  return `+${dialCode}555${rng.digits(6)}`;
}

/** Alphanumeric sender (max 11 chars), numeric short code or long number. */
export function senderId(rng: Rng, dialCode: string): string {
  const r = rng.next();
  if (r < 0.7) {
    const s = rng.chance(0.5)
      ? syllableWord(rng).toUpperCase()
      : `${syllableWord(rng).slice(0, 5).toUpperCase()}${rng.pick(SENDER_WORDS)}`;
    return s.slice(0, 11);
  }
  if (r < 0.85) return rng.digits(rng.int(4, 6)).replace(/^0/, "1");
  return `${dialCode}${rng.digits(9)}`;
}

/** RFC 5737 TEST-NET addresses (198.51.100.0/24, 203.0.113.0/24, 192.0.2.0/24). */
export function testNetIp(rng: Rng): string {
  return `${rng.pick(["198.51.100", "203.0.113", "192.0.2"])}.${rng.int(1, 254)}`;
}

/** RFC 1918 private address. */
export function privateIp(rng: Rng): string {
  return `10.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`;
}

export function fakeSecret(rng: Rng, len = 12): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[rng.int(0, chars.length - 1)];
  return s;
}

const OTP_TEXTS = [
  "Your verification code is {code}",
  "Use {code} to sign in to {brand}. Do not share this code.",
  "{brand}: your one-time password is {code}",
  "{code} is your {brand} security code",
];
const OTHER_TEXTS = [
  "{brand}: your order has been shipped and will arrive tomorrow.",
  "Reminder from {brand}: your appointment is tomorrow at 10:00.",
  "{brand} deals this week: 20% off selected items. Reply STOP to opt out.",
  "Your {brand} account balance is low. Top up to keep using the service.",
  "{brand}: your driver is arriving in 3 minutes.",
  "Payment of 25.00 received by {brand}. Thank you.",
];

export function messageText(rng: Rng, brand: string, otp: boolean): string {
  const tpl = otp || rng.chance(0.45) ? rng.pick(OTP_TEXTS) : rng.pick(OTHER_TEXTS);
  return tpl.replace("{code}", rng.digits(6)).replace("{brand}", brand);
}
