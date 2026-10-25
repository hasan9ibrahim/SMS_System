// The exchange-rate source's real quotes (backend step 11, production): one HTTP call to the configured rate API
// (XE, Open Exchange Rates, Fixer, ExchangeRate-API, the ECB, or a custom JSON URL; api/fx.ts FX_PRESETS) and the
// rates it quotes turned into units per 1 EUR, the platform's base (team trial round 2). A currency the source does
// not quote keeps its rate. Outside production api/fx.ts simulates the quotes instead and nothing is called.

export interface FxSource {
  provider: string;
  apiUrl: string | null;
  authType: string;
  authParam: string | null;
  accountId: string | null;
  ratesPath: string | null;
  baseCurrency: string;
  apiKey: string | null;
}

/** The request for a source: URL with the key and base filled in, and its headers (exported for tests). */
export function sourceRequest(s: FxSource): { url: string; headers: Record<string, string> } {
  if (!s.apiUrl) throw new Error("The rate source has no API URL");
  const key = s.apiKey ?? "";
  if (s.authType !== "none" && !key) throw new Error("The rate source needs an API key (Exchange rates → Source)");
  const url = new URL(
    s.apiUrl.replaceAll("{base}", encodeURIComponent(s.baseCurrency)).replaceAll("{key}", encodeURIComponent(key)),
  );
  const headers: Record<string, string> = { accept: "application/json, text/xml" };
  if (s.authType === "query") url.searchParams.set(s.authParam || "access_key", key);
  else if (s.authType === "header") headers[(s.authParam || "apikey").toLowerCase()] = key;
  else if (s.authType === "bearer") headers.authorization = `Bearer ${key}`;
  else if (s.authType === "basic")
    headers.authorization = `Basic ${Buffer.from(`${s.accountId ?? ""}:${key}`).toString("base64")}`;
  return { url: url.toString(), headers };
}

/** Units of each currency per 1 `base` from the answer (exported for tests). */
export function parseQuotes(s: FxSource, body: string): Map<string, number> {
  const out = new Map<string, number>();
  const put = (iso: unknown, rate: unknown) => {
    const n = Number(rate);
    if (typeof iso === "string" && /^[A-Z]{3}$/.test(iso.trim()) && n > 0 && Number.isFinite(n)) out.set(iso.trim(), n);
  };
  if (s.provider === "ecb") {
    // <Cube currency="USD" rate="1.0812"/> per 1 EUR.
    for (const m of body.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) put(m[1], m[2]);
    return out;
  }
  let node: unknown = JSON.parse(body);
  for (const part of (s.ratesPath ?? "").split(".").filter(Boolean))
    node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  if (Array.isArray(node))
    // XE: [{ quotecurrency: "USD", mid: 1.08 }, …]
    for (const x of node as Record<string, unknown>[]) put(x.quotecurrency ?? x.currency ?? x.code, x.mid ?? x.rate);
  else if (node && typeof node === "object") for (const [iso, rate] of Object.entries(node)) put(iso, rate);
  if (!out.size) throw new Error(`No rates found in the answer${s.ratesPath ? ` at "${s.ratesPath}"` : ""}`);
  return out;
}

/** Units per 1 EUR, whatever the source's base (the base itself is 1). */
export function perEur(base: string, quotes: Map<string, number>): Map<string, number> {
  const b = base.trim().toUpperCase();
  quotes.set(b, 1);
  const eur = quotes.get("EUR");
  if (!eur) throw new Error(`The source does not quote EUR against ${b}`);
  return new Map([...quotes].map(([iso, r]) => [iso, Number((r / eur).toFixed(8))]));
}

/** Calls the source and returns units per 1 EUR. */
export async function fetchQuotes(s: FxSource, fetcher: typeof fetch = fetch): Promise<Map<string, number>> {
  const { url, headers } = sourceRequest(s);
  const res = await fetcher(url, { headers, signal: AbortSignal.timeout(20_000) });
  const body = await res.text();
  if (!res.ok) throw new Error(`The rate source answered ${res.status}: ${body.slice(0, 200)}`);
  return perEur(s.baseCurrency, parseQuotes(s, body));
}
