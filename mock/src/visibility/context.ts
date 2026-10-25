// The viewer of the current request (§13.17): the signed-in user, or the user an administrator previews
// with the X-View-As header. Kept in AsyncLocalStorage so the list engine, search and record handlers
// read it without passing the request around; masking is enforced on the server (§13.17).
import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyRequest } from "fastify";
import { db } from "../db.js";
import { currentUserId } from "../api/session.js";
import { cachedViewer, restricts, type Viewer } from "./policy.js";

export interface VisibilityContext {
  /** User asked for with X-View-As (honoured for administrators only). */
  viewAs: number | null;
  viewer?: Promise<Viewer | null>;
}

const als = new AsyncLocalStorage<VisibilityContext>();

export function contextOf(request: FastifyRequest): VisibilityContext {
  const raw = request.headers["x-view-as"];
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return { viewAs: Number.isInteger(n) && n > 0 ? n : null };
}

/** Runs fn with this visibility context (a request, a scheduled report for a recipient, a test). */
export function runWithVisibility<T>(ctx: VisibilityContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** Runs fn as this user would see it, e.g. a scheduled report e-mailed to them. */
export function runAsUser<T>(userId: number, fn: () => T): T {
  return als.run({ viewAs: null, viewer: viewerOf(userId, false) }, fn);
}

function viewerOf(userId: number, viewAs: boolean): Promise<Viewer | null> {
  return cachedViewer(db(), userId, viewAs).catch(() => null);
}

async function resolve(ctx: VisibilityContext): Promise<Viewer | null> {
  if (ctx.viewAs !== null && ctx.viewAs !== currentUserId()) {
    const me = await viewerOf(currentUserId(), false);
    if (me?.exemptReason === "Administrator") return viewerOf(ctx.viewAs, true);
  }
  return viewerOf(currentUserId(), false);
}

/** The current viewer; null outside a request (background jobs see everything). */
export function currentViewer(ctx: VisibilityContext | undefined = als.getStore()): Promise<Viewer | null> {
  if (!ctx) return Promise.resolve(null);
  ctx.viewer ??= resolve(ctx);
  return ctx.viewer;
}

/** The current viewer when their policy masks or hides something, else null. */
export async function restrictingViewer(): Promise<(Viewer & { policy: NonNullable<Viewer["policy"]> }) | null> {
  const v = await currentViewer();
  return restricts(v) ? v : null;
}
