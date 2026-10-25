// Runs a test file's calls against a real server instead of the in-process mock (backend step 9): with API_URL set
// (e.g. http://127.0.0.1:4100, the Elixir API), `inject` sends each call over HTTP and returns an answer shaped like
// Fastify's inject result, so the same assertions check the Elixir API against the contract. Ported operations must
// pass the mock's own tests this way before the screens switch to them (docs/BACKEND_PLAN.md, phase B).
import type { FastifyInstance, InjectOptions as FastifyInjectOptions, LightMyRequestResponse } from "fastify";

export const API_URL = process.env.API_URL?.replace(/\/$/, "") ?? null;

interface InjectOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payload?: object;
}

/**
 * A session on the remote server as the seeded administrator (user 1, the mock's default user): password, then the
 * authenticator code. Calls without their own cookie use it.
 */
let remoteCookie: Promise<string> | null = null;
export function remoteSession(username: string, password: string, code: () => string): Promise<string> {
  remoteCookie ??= (async () => {
    const post = (path: string, body: object) =>
      fetch(`${API_URL}/api/v1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = await post("/session", { username, password });
    let res = first;
    const body = (await first.clone().json()) as { status: string; challenge?: string };
    if (body.status === "code_required") res = await post("/session/code", { challenge: body.challenge, code: code() });
    if (!res.ok) throw new Error(`remote sign-in failed: ${res.status} ${await res.text()}`);
    return res.headers.getSetCookie()[0]!.split(";")[0]!;
  })();
  return remoteCookie;
}

export function injector(app: FastifyInstance, session?: () => Promise<string>) {
  return async (opts: InjectOptions): Promise<LightMyRequestResponse> => {
    if (!API_URL) return app.inject(opts as FastifyInjectOptions);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (session && !headers.cookie) headers.cookie = await session();
    if (opts.payload !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${API_URL}${opts.url}`, {
      method: opts.method,
      headers,
      body: opts.payload !== undefined ? JSON.stringify(opts.payload) : undefined,
      redirect: "manual",
    });
    const body = await res.text();
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      out[k] = v;
    });
    const cookies = res.headers.getSetCookie();
    if (cookies.length) out["set-cookie"] = cookies.join(", ");
    return {
      statusCode: res.status,
      headers: out,
      body,
      json: () => JSON.parse(body),
    } as unknown as LightMyRequestResponse;
  };
}
