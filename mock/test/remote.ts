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

export function injector(app: FastifyInstance) {
  return async (opts: InjectOptions): Promise<LightMyRequestResponse> => {
    if (!API_URL) return app.inject(opts as FastifyInjectOptions);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
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
