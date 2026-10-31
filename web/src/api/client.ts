// Typed API client. Paths, bodies and responses are checked against the types
// generated from contract/openapi.yaml, so a contract change shows up as a type error.
import createClient from "openapi-fetch";
import type { paths, Problem } from "@sms/contract";
import { problemSummary } from "./problems";

export const api = createClient<paths>({ baseUrl: "/api/v1" });

// Administrators can preview the system as another user sees it (X-View-As, §13.17).
let viewAsId: number | null = null;
try {
  const saved = Number(sessionStorage.getItem("viewAs"));
  viewAsId = Number.isInteger(saved) && saved > 0 ? saved : null;
} catch {
  viewAsId = null;
}
export const getViewAs = () => viewAsId;
export function setViewAs(id: number | null) {
  viewAsId = id;
  try {
    if (id) sessionStorage.setItem("viewAs", String(id));
    else sessionStorage.removeItem("viewAs");
  } catch {
    // Not kept across reloads then.
  }
}
/** Fired when the server answers 403 password_change_required (§13.28): the shell then shows only Change Password. */
export const PASSWORD_REQUIRED_EVENT = "password-change-required";
/** Fired when the server answers 401 sign_in_required (backend step 9, §13.28): the shell then shows Sign in. */
export const SIGN_IN_REQUIRED_EVENT = "sign-in-required";
async function watchPasswordGate(response: Response) {
  if (response.status !== 403 && response.status !== 401) return;
  try {
    const body = (await response.clone().json()) as { code?: string };
    if (body.code === "password_change_required") window.dispatchEvent(new Event(PASSWORD_REQUIRED_EVENT));
    if (body.code === "sign_in_required") window.dispatchEvent(new Event(SIGN_IN_REQUIRED_EVENT));
  } catch {
    // Not a problem document.
  }
}
api.use({
  onRequest({ request }) {
    if (viewAsId) request.headers.set("X-View-As", String(viewAsId));
    return request;
  },
  async onResponse({ response }) {
    await watchPasswordGate(response);
    return response;
  },
});

/**
 * A problem+json answer (RFC 9457), or a network failure (status 0). Its message is in plain words: contract
 * validation errors are mapped per field (api/problems.ts, functional QA round 13).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Partial<Problem> & Pick<Problem, "title" | "status"> & Record<string, unknown>,
  ) {
    super(problemSummary(problem));
  }
}

/** Unwraps an openapi-fetch result: returns data or throws ApiError. */
export async function unwrap<T>(call: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  let result: { data?: T; error?: unknown; response: Response };
  try {
    result = await call;
  } catch {
    throw new ApiError(0, { title: "The server is not reachable. Check the connection and try again.", status: 0 });
  }
  if (result.error !== undefined || !result.response.ok) {
    const problem = (result.error ?? {}) as Partial<Problem> & Record<string, unknown>;
    throw new ApiError(result.response.status, {
      ...problem,
      // Never an empty message (R9): over HTTP/2 there is no status text.
      title:
        problem.title ??
        (typeof problem.message === "string" ? problem.message : null) ??
        (result.response.statusText || `Request failed (HTTP ${result.response.status})`),
      status: result.response.status,
    });
  }
  return result.data as T;
}

/** fetch for downloads outside the typed client, with the same preview header (§13.17). */
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (viewAsId) headers.set("X-View-As", String(viewAsId));
  return fetch(input, { ...init, headers }).then(async (res) => {
    await watchPasswordGate(res);
    return res;
  });
}
