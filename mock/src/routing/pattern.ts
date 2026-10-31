// Rule patterns as the switch reads them (QA 2026-10-31, §6.3, §6.4): the screens save JavaScript regular
// expressions, the switch compiles them with PCRE (Sms.Switch.Rules.Pattern) and a pattern PCRE refuses never matches
// there. The service checks and runs them in JavaScript's Unicode mode (`u`), which refuses what PCRE reads otherwise
// (`a{,3}`: literal text in JavaScript, a quantifier in PCRE) and gives `\p{L}` its PCRE meaning, plus:
//
//   * `[^]` (anything in JavaScript) and `[]` (nothing) are refused: PCRE takes the `]` as a member of the class;
//   * `\u` is refused: PCRE has no `\u` escape;
//   * `\` before any other non-alphanumeric character is that character, as in PCRE (`\-`, `\_`, `\'`), where Unicode
//     mode only takes it before syntax characters.

const SYNTAX = new Set([..."^$\\.*+?()[]{}|/"]);

/** The pattern as Unicode mode should read it, or null when PCRE would read it otherwise. */
function forUnicode(pattern: string): string | null {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const n = pattern[i + 1];
      if (n === undefined) return out + c; // a trailing backslash: RegExp refuses it
      i++;
      if (n === "u") return null;
      out += /[A-Za-z0-9]/.test(n) || SYNTAX.has(n) || (inClass && n === "-") ? c + n : n;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      const rest = pattern.slice(i + 1);
      if (rest.startsWith("]") || rest.startsWith("^]")) return null;
      inClass = true;
    }
    out += c;
  }
  return out;
}

/** Compiles a saved pattern (flags besides `u`: `i`, `g`), or null when it is invalid for the switch. */
export function compilePattern(pattern: string, flags = ""): RegExp | null {
  const source = forUnicode(pattern);
  if (source === null) return null;
  try {
    return new RegExp(source, flags.includes("u") ? flags : `${flags}u`);
  } catch {
    return null;
  }
}
