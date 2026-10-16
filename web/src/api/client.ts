// Typed API client. Paths, bodies and responses are checked against the types
// generated from contract/openapi.yaml, so a contract change shows up as a type error.
import createClient from "openapi-fetch";
import type { paths, Problem } from "@sms/contract";

export const api = createClient<paths>({ baseUrl: "/api/v1" });

/** A problem+json answer (RFC 9457), or a network failure (status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Partial<Problem> & Pick<Problem, "title" | "status"> & Record<string, unknown>,
  ) {
    super(problem.detail ? `${problem.title}: ${problem.detail}` : problem.title);
  }
}

/** Unwraps an openapi-fetch result: returns data or throws ApiError. */
export async function unwrap<T>(call: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  let result: { data?: T; error?: unknown; response: Response };
  try {
    result = await call;
  } catch {
    throw new ApiError(0, { title: "Mock server not reachable (npm run dev:mock)", status: 0 });
  }
  if (result.error !== undefined || !result.response.ok) {
    const problem = (result.error ?? {}) as Partial<Problem> & Record<string, unknown>;
    throw new ApiError(result.response.status, {
      ...problem,
      title: problem.title ?? result.response.statusText,
      status: result.response.status,
    });
  }
  return result.data as T;
}
