// Fake DLR targets (decided 2026-10-16: per destination or per rule). Deterministic from the
// code or rule ID, so they draw no random numbers and leave the rest of the data unchanged.
// Production targets are set by the team on the MCCMNC codes page and in the rule form.

function hash01(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return (h % 10_000) / 10_000;
}

/** Countries get 55–80 % in steps of 5; about one network in eight has its own target near it. */
export function fakeDestinationTarget(code: string, isAllNetworks: boolean): number | null {
  const country = 55 + 5 * Math.floor(hash01(`c${code.slice(0, 3)}`) * 6);
  if (isAllNetworks) return country;
  const h = hash01(`n${code}`);
  if (h >= 0.125) return null;
  return Math.min(95, Math.max(40, country + (h < 0.06 ? -5 : 5)));
}

/** About one rule in 25 has its own target, 60–85 %. */
export function fakeRuleTarget(ruleId: number): number | null {
  const h = hash01(`r${ruleId}`);
  return h < 0.04 ? 60 + ((5 * Math.floor(h * 150)) % 30) : null;
}
