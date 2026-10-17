// SMPP reference values shared by the EDR screens (spec §2): command_status cause codes and the
// delivery receipt states. Names follow SMPP v3.4.

export const CAUSE_CODES: { code: number; name: string; label: string }[] = [
  { code: 0, name: "ESME_ROK", label: "OK" },
  { code: -1, name: "ESME_UNKNOWN", label: "Unknown" },
  { code: 1, name: "ESME_RINVMSGLEN", label: "Invalid message length" },
  { code: 2, name: "ESME_RINVCMDLEN", label: "Invalid command length" },
  { code: 3, name: "ESME_RINVCMDID", label: "Invalid command ID" },
  { code: 4, name: "ESME_RINVBNDSTS", label: "Incorrect bind status" },
  { code: 5, name: "ESME_RALYBND", label: "Already bound" },
  { code: 6, name: "ESME_RINVPRTFLG", label: "Invalid priority flag" },
  { code: 7, name: "ESME_RINVREGDLVFLG", label: "Invalid registered delivery flag" },
  { code: 8, name: "ESME_RSYSERR", label: "System error" },
  { code: 10, name: "ESME_RINVSRCADR", label: "Invalid source address" },
  { code: 11, name: "ESME_RINVDSTADR", label: "Invalid destination address" },
  { code: 12, name: "ESME_RINVMSGID", label: "Invalid message ID" },
  { code: 13, name: "ESME_RBINDFAIL", label: "Bind failed" },
  { code: 14, name: "ESME_RINVPASWD", label: "Invalid password" },
  { code: 15, name: "ESME_RINVSYSID", label: "Invalid system ID" },
  { code: 17, name: "ESME_RCANCELFAIL", label: "Cancel failed" },
  { code: 19, name: "ESME_RREPLACEFAIL", label: "Replace failed" },
  { code: 20, name: "ESME_RMSGQFUL", label: "Message queue full" },
  { code: 21, name: "ESME_RINVSERTYP", label: "Invalid service type" },
  { code: 51, name: "ESME_RINVNUMDESTS", label: "Invalid number of destinations" },
  { code: 52, name: "ESME_RINVDLNAME", label: "Invalid distribution list" },
  { code: 64, name: "ESME_RINVDESTFLAG", label: "Invalid destination flag" },
  { code: 66, name: "ESME_RINVSUBREP", label: "Submit-with-replace not allowed" },
  { code: 67, name: "ESME_RINVESMCLASS", label: "Invalid esm_class" },
  { code: 68, name: "ESME_RCNTSUBDL", label: "Cannot submit to distribution list" },
  { code: 69, name: "ESME_RSUBMITFAIL", label: "Submit failed" },
  { code: 72, name: "ESME_RINVSRCTON", label: "Invalid source TON" },
  { code: 73, name: "ESME_RINVSRCNPI", label: "Invalid source NPI" },
  { code: 80, name: "ESME_RINVDSTTON", label: "Invalid destination TON" },
  { code: 81, name: "ESME_RINVDSTNPI", label: "Invalid destination NPI" },
  { code: 83, name: "ESME_RINVSYSTYP", label: "Invalid system_type" },
  { code: 84, name: "ESME_RINVREPFLAG", label: "Invalid replace_if_present" },
  { code: 85, name: "ESME_RINVNUMMSGS", label: "Invalid number of messages" },
  { code: 88, name: "ESME_RTHROTTLED", label: "Throttling error" },
  { code: 97, name: "ESME_RINVSCHED", label: "Invalid scheduled delivery time" },
  { code: 98, name: "ESME_RINVEXPIRY", label: "Invalid validity period" },
  { code: 99, name: "ESME_RINVDFTMSGID", label: "Invalid predefined message ID" },
];
const BY_CODE = new Map(CAUSE_CODES.map((c) => [c.code, c]));
export const causeName = (code: number) => BY_CODE.get(code)?.name ?? `0x${(code >>> 0).toString(16).padStart(8, "0")}`;

/** Message Status values of the EDR Search filter (§9.1). */
export const MESSAGE_STATUSES = [
  "DELIVRD",
  "ACCEPTD",
  "EXPIRED",
  "DELETED",
  "UNDELIV",
  "UNKNOWN",
  "REJECTD",
  "SENT",
  "ACKED",
  "BUFFRED",
  "ENROUTE",
];

// GSM 03.38 extension table: these characters take two septets.
const GSM_EXT = "^{}\\[~]|€\f";
const LABELS = [
  "GSM 7-bit (SMSC default)",
  "IA5 (ASCII)",
  "8-bit binary",
  "Latin-1",
  "8-bit binary",
  "JIS",
  "Cyrillic",
  "Latin/Hebrew",
  "UCS-2",
];

/** Characters, size and SMS count of a message for a data_coding (0–8), as the Route Simulator shows (§9.2). */
export function messageEncoding(text: string, dataCoding: number) {
  const label = LABELS[dataCoding] ?? `data_coding ${dataCoding}`;
  if (dataCoding === 0 || dataCoding === 1) {
    let septets = 0;
    for (const ch of text) septets += GSM_EXT.includes(ch) ? 2 : 1;
    return {
      dataCoding,
      label,
      chars: septets,
      bitsPerChar: 7,
      segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
      bytes: Math.ceil((septets * 7) / 8),
    };
  }
  if (dataCoding === 8) {
    const units = text.length; // UTF-16 code units
    return {
      dataCoding,
      label,
      chars: units,
      bitsPerChar: 16,
      segments: units <= 70 ? 1 : Math.ceil(units / 67),
      bytes: units * 2,
    };
  }
  const bytes = Buffer.byteLength(text, "latin1");
  return {
    dataCoding,
    label,
    chars: bytes,
    bitsPerChar: 8,
    segments: bytes <= 140 ? 1 : Math.ceil(bytes / 134),
    bytes,
  };
}
