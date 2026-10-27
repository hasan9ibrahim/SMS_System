// Number format in translation rule content (team trial round 6, §13.2), for the live preview on the rule form. The
// same rules as formatNumber in mock/src/routing/translate.ts and the switch (Sms.Switch.Rules.Translation): # takes
// the next digit, anything else is kept; a longer number repeats the last group, a shorter one stops after its last
// digit, and what follows the last # is added when the pattern was filled to the end.

export function formatNumber(digits: string, pattern: string): string {
  const last = pattern.lastIndexOf("#");
  if (last < 0) return digits;
  let groupStart = last;
  while (groupStart > 0 && pattern[groupStart - 1] === "#") groupStart--;
  let sepStart = groupStart;
  while (sepStart > 0 && pattern[sepStart - 1] !== "#") sepStart--;
  const head = pattern.slice(0, last + 1);
  const repeat = pattern.slice(sepStart, last + 1);
  let out = "";
  let i = 0;
  let filled = false;
  for (let part = head; i < digits.length; part = repeat) {
    let complete = true;
    for (const ch of part) {
      if (i >= digits.length) {
        complete = false;
        break;
      }
      out += ch === "#" ? digits[i++] : ch;
    }
    filled = i >= digits.length && complete && part.endsWith("#");
  }
  return filled ? out + pattern.slice(last + 1) : out;
}

/** Every run of at least minDigits (null = 6) digits in the text, through the pattern (empty = off). */
export function formatNumbers(text: string, pattern: string | null | undefined, minDigits?: number | null): string {
  if (!pattern?.includes("#")) return text;
  const min = Math.max(2, minDigits ?? 6);
  return text.replace(/\d+/g, (run) => (run.length >= min ? formatNumber(run, pattern) : run));
}
