/**
 * SMS to voice (§8, decided 2026-10-31, docs/SMS_TO_VOICE.md) in the generated data: the voice gateways (the
 * operator's own voice switches, fake hosts and credentials) and the SMS-to-voice rules, shared by the switch
 * utilities step (switchExtras.ts writes them) and the EDR generator (edr.ts turns some OTP messages to the rules'
 * landline ranges into calls). Deterministic: no random draws.
 */
export interface GenVoiceGateway {
  id: number;
  name: string;
  host: string;
  port: number;
  transport: "udp" | "tcp" | "tls";
  username: string | null;
  fromDomain: string | null;
  callerIdMode: "sender" | "fixed";
  /** Fictional numbers (+1 555 01xx). */
  fixedCallerId: string | null;
  dialPrefix: string;
  codecs: string[];
  maxCalls: number;
  ringTimeoutS: number;
  retryDelayS: number;
  priority: number;
  active: boolean;
}

export const VOICE_GATEWAYS: GenVoiceGateway[] = [
  {
    id: 1,
    name: "VSW-Main",
    host: "voice-gw1.example.net",
    port: 5060,
    transport: "udp",
    username: "smsvoice",
    fromDomain: "voice.example.net",
    callerIdMode: "sender",
    fixedCallerId: "+15550100",
    dialPrefix: "",
    codecs: ["alaw", "ulaw"],
    maxCalls: 30,
    ringTimeoutS: 30,
    retryDelayS: 60,
    priority: 1,
    active: true,
  },
  {
    id: 2,
    name: "VSW-Backup",
    host: "voice-gw2.example.net",
    port: 5061,
    transport: "tls",
    username: "smsvoice",
    fromDomain: "voice.example.net",
    callerIdMode: "fixed",
    fixedCallerId: "+15550101",
    dialPrefix: "00",
    codecs: ["alaw"],
    maxCalls: 10,
    ringTimeoutS: 25,
    retryDelayS: 90,
    priority: 2,
    active: true,
  },
  {
    id: 3,
    name: "VSW-Lab",
    host: "voice-gw3.example.net",
    port: 5060,
    transport: "tcp",
    username: null,
    fromDomain: null,
    callerIdMode: "sender",
    fixedCallerId: null,
    dialPrefix: "9",
    codecs: ["ulaw", "g722"],
    maxCalls: 2,
    ringTimeoutS: 20,
    retryDelayS: 60,
    priority: 9,
    active: false,
  },
];

export interface GenVoiceRule {
  id: number;
  sender: string | null;
  prefix: string;
  repeat: number;
  /** Null = the default gateway (the active one with the lowest priority). */
  gatewayId: number | null;
  active: boolean;
}

/** Landline ranges that cannot take SMS; mostly OTP senders. */
export const VOICE_RULES: GenVoiceRule[] = [
  { id: 1, sender: "%OTP%", prefix: "4420", repeat: 2, gatewayId: null, active: true },
  { id: 2, sender: "%VERIFY%", prefix: "4930", repeat: 2, gatewayId: null, active: true },
  { id: 3, sender: null, prefix: "331", repeat: 3, gatewayId: 2, active: true },
  { id: 4, sender: "%BANK%", prefix: "97142", repeat: 2, gatewayId: null, active: true },
  { id: 5, sender: null, prefix: "6562", repeat: 2, gatewayId: null, active: false },
  { id: 6, sender: "%CODE%", prefix: "3491", repeat: 3, gatewayId: null, active: true },
  { id: 7, sender: null, prefix: "1212555", repeat: 2, gatewayId: 1, active: true },
  { id: 8, sender: "%OTP%", prefix: "9122", repeat: 2, gatewayId: null, active: true },
  { id: 9, sender: "%PIN%", prefix: "2341", repeat: 3, gatewayId: 3, active: true },
  { id: 10, sender: null, prefix: "6129", repeat: 2, gatewayId: null, active: true },
  { id: 11, sender: "%AUTH%", prefix: "3120", repeat: 2, gatewayId: null, active: false },
  { id: 12, sender: null, prefix: "48222", repeat: 2, gatewayId: null, active: true },
];

/** The gateway that places a rule's calls: its own while active, else the active one with the lowest priority. */
export function gatewayFor(rule: GenVoiceRule): GenVoiceGateway {
  const own = VOICE_GATEWAYS.find((g) => g.id === rule.gatewayId && g.active);
  return own ?? [...VOICE_GATEWAYS].filter((g) => g.active).sort((a, b) => a.priority - b.priority)[0]!;
}
