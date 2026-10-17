// Record details under a visibility policy (§13.17): another AM's enterprise or trunk is shown with a
// neutral ID instead of its name, contact details and credentials are withheld when the policy hides
// contacts, and saving such a record is refused (a masked form must never write the mask back).
import type { FastifyReply } from "fastify";
import { sendProblem } from "../problem.js";
import { restrictingViewer } from "./context.js";

const LABEL: Record<string, string> = { customer: "Customer", vendor: "Vendor" };
const HIDDEN_CONTACT = { name: null, phone: null, emails: ["hidden@masked.invalid"] };

/** True when the current viewer sees this enterprise masked. */
export async function isMasked(enterpriseId: number): Promise<boolean> {
  const v = await restrictingViewer();
  return !!v && v.policy.maskOthers && !v.own.includes(enterpriseId);
}

/** 403 for a save to a record the viewer sees masked; null when allowed. */
export async function refuseMasked(reply: FastifyReply, enterpriseId: number): Promise<FastifyReply | null> {
  return (await isMasked(enterpriseId))
    ? sendProblem(reply, 403, "This record belongs to another account manager", {
        detail: "Your visibility policy masks it (§13.17), so it cannot be changed here.",
      })
    : null;
}

async function contactsHidden(enterpriseId: number): Promise<boolean> {
  const v = await restrictingViewer();
  if (!v) return false;
  const s = v.policy.items.contacts;
  return (v.own.includes(enterpriseId) ? s.own : s.others) === "hide";
}

export async function maskEnterpriseDetail<T extends Record<string, unknown>>(e: T): Promise<T> {
  const id = Number(e.id);
  const out: Record<string, unknown> = { ...e };
  if (await isMasked(id)) {
    out.name = `${LABEL[String(e.type)] ?? "Enterprise"} #${id}`;
    out.alias = out.name;
  }
  if (await contactsHidden(id)) {
    out.contacts = Object.fromEntries(Object.keys((e.contacts as object) ?? {}).map((k) => [k, HIDDEN_CONTACT]));
    out.address = { line1: "Hidden", line2: null, city: null, state: null, countryId: null, zip: null };
    for (const k of ["website", "fax", "registrationNumber", "vatNumber"]) if (k in out) out[k] = null;
  }
  return out as T;
}

export async function maskTrunkDetail<T extends Record<string, unknown>>(
  t: T,
  kind: "customer" | "vendor",
): Promise<T> {
  const enterpriseId = Number(t.enterpriseId);
  const out: Record<string, unknown> = { ...t };
  if (await isMasked(enterpriseId)) out.name = `${kind === "customer" ? "Customer" : "Vendor"} trunk #${t.id}`;
  if (await contactsHidden(enterpriseId)) {
    if (typeof out.username === "string") out.username = "hidden";
    if (Array.isArray(out.hostIps)) out.hostIps = ["0.0.0.0"];
    if (typeof out.host === "string") out.host = "0.0.0.0";
    for (const k of ["dlrPushUrl", "moPushUrl"]) if (typeof out[k] === "string") out[k] = null;
  }
  return out as T;
}
