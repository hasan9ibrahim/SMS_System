/**
 * Seeded pseudo-random generator (sfc32). Same seed => same data set, so the
 * config can be rebuilt in memory for EDR generation without reading it back.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | string) {
    // xmur3-style string hash to four 32-bit words.
    const s = String(seed);
    let h = 1779033703 ^ s.length;
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    const next = () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 15; i++) this.next();
  }

  /** Independent child stream, so adding draws in one module does not shift another. */
  fork(label: string): Rng {
    return new Rng(`${this.int(0, 2 ** 31)}:${label}`);
  }

  /** Float in [0, 1). */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)] as T;
  }

  /** k distinct items (k capped at arr.length). */
  sample<T>(arr: readonly T[], k: number): T[] {
    const n = Math.min(k, arr.length);
    if (n > arr.length / 2) return this.shuffle([...arr]).slice(0, n);
    const seen = new Set<number>();
    const out: T[] = [];
    while (out.length < n) {
      const i = Math.floor(this.next() * arr.length);
      if (!seen.has(i)) {
        seen.add(i);
        out.push(arr[i] as T);
      }
    }
    return out;
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
    }
    return arr;
  }

  /** Standard normal (Box-Muller). */
  normal(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Log-normal with the given median and spread (sigma of the underlying normal). */
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }

  /** Pick by weight from a parallel array. For repeated picks build a WeightedPicker. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i] ?? 0;
      if (r < 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }

  hex(len: number): string {
    let s = "";
    while (s.length < len)
      s += Math.floor(this.next() * 4294967296)
        .toString(16)
        .padStart(8, "0");
    return s.slice(0, len);
  }

  digits(len: number): string {
    let s = "";
    for (let i = 0; i < len; i++) s += Math.floor(this.next() * 10);
    return s;
  }

  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab".charAt(parseInt(h.charAt(16), 16) & 3)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}

/** O(log n) repeated weighted picks via a cumulative array. */
export class WeightedPicker<T> {
  private readonly cumulative: Float64Array;
  readonly total: number;

  constructor(
    readonly items: readonly T[],
    weights: readonly number[],
  ) {
    if (items.length === 0) throw new Error("WeightedPicker needs at least one item");
    this.cumulative = new Float64Array(items.length);
    let acc = 0;
    for (let i = 0; i < items.length; i++) {
      acc += Math.max(0, weights[i] ?? 0);
      this.cumulative[i] = acc;
    }
    this.total = acc;
  }

  pick(rng: Rng): T {
    const r = rng.next() * this.total;
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid]! > r) hi = mid;
      else lo = mid + 1;
    }
    return this.items[lo] as T;
  }
}

/** Zipf-like weights 1/(rank^s), rank starting at 1. */
export function zipfWeights(n: number, s = 1): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = 1 / Math.pow(i + 1, s);
  return out;
}
