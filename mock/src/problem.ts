import type { FastifyReply } from "fastify";
import type { ErrorObject } from "ajv";
import type { Problem } from "@sms/contract";

export function sendProblem(reply: FastifyReply, status: number, title: string, extra: Partial<Problem> = {}) {
  const body: Problem = { type: "about:blank", title, status, ...extra };
  return reply.code(status).type("application/problem+json").send(body);
}

export function ajvErrors(errors: ErrorObject[] | null | undefined, prefix = ""): NonNullable<Problem["errors"]> {
  return (errors ?? []).map((e) => ({ path: `${prefix}${e.instancePath}` || "/", message: e.message ?? "invalid" }));
}
