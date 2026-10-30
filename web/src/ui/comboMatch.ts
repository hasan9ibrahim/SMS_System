// What the searchable dropdown keeps as you type (team trial round 12): pure, for tests.
export interface ComboOption {
  value: string | number;
  label: string;
}

/** The options whose label contains every word typed, in their order (pure, for tests). */
export function matchOptions<T extends ComboOption>(options: T[], text: string, limit = 300): T[] {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out: T[] = [];
  for (const o of options) {
    const l = o.label.toLowerCase();
    if (words.every((w) => l.includes(w))) out.push(o);
    if (out.length >= limit) break;
  }
  return out;
}
