// Commands to the switch servers (backend step 11c, §9.1, §9.2): plain NATS request/reply on `smscmd.*`, outside the
// JetStream `sms.>` stream (backend/apps/sms_switch/lib/sms/switch/commands.ex).
//
//   * `any`: one server answers (queue group), e.g. Test SMS, Repush;
//   * `all`: every server answers (each records and captures its own traffic), e.g. captures, the recording's files;
//   * `node`: one named server, e.g. reading a file it holds.
//
// Each answer is `{ ok, node, data | error, skip? }`. No server answering is `SwitchUnreachable` (503 on the screen).
import type { FastifyReply } from "fastify";
import { connect, RequestStrategy, type NatsConnection } from "nats";
import { sendProblem } from "../problem.js";

export interface SwitchAnswer<T> {
  ok: boolean;
  node: string;
  data?: T;
  error?: string;
  skip?: boolean;
}

/** No switch server answered in time. */
export class SwitchUnreachable extends Error {
  constructor(command: string) {
    super(`No switch server answered ${command}`);
  }
}

/** A switch server refused the command (its reason). */
export class SwitchRefused extends Error {}

let nc: Promise<NatsConnection> | null = null;

function conn(): Promise<NatsConnection> {
  nc ??= connect({
    servers: (process.env.NATS_URL ?? "nats://127.0.0.1:4222").split(","),
    maxReconnectAttempts: -1,
    name: "sms-service-commands",
  }).catch((err: unknown) => {
    nc = null;
    throw err;
  });
  return nc;
}

/** How many switch servers to wait for on an `all` command (SWITCH_NODES, default 2). */
const nodes = () => Math.max(1, Number(process.env.SWITCH_NODES ?? 2) || 2);

const encode = (data: unknown) => new TextEncoder().encode(JSON.stringify(data ?? {}));
const decode = <T>(bytes: Uint8Array): SwitchAnswer<T> => JSON.parse(new TextDecoder().decode(bytes)) as SwitchAnswer<T>;

/** One server's answer to a command; throws `SwitchUnreachable` when none answers within `timeoutMs`. */
export async function askAny<T>(command: string, data: unknown, timeoutMs = 15_000): Promise<SwitchAnswer<T>> {
  try {
    const c = await conn();
    const msg = await c.request(`smscmd.any.${command}`, encode(data), { timeout: timeoutMs });
    return decode<T>(msg.data);
  } catch (err) {
    throw unreachableOr(command, err);
  }
}

/** That server's answer (`node` as the switch names itself). */
export async function askNode<T>(node: string, command: string, data: unknown, timeoutMs = 15_000) {
  if (!/^[A-Za-z0-9_-]+$/.test(node)) throw new SwitchRefused(`unknown switch server ${node}`);
  try {
    const c = await conn();
    const msg = await c.request(`smscmd.node.${node}.${command}`, encode(data), { timeout: timeoutMs });
    return decode<T>(msg.data);
  } catch (err) {
    throw unreachableOr(command, err);
  }
}

/** Every server's answer that came within `timeoutMs` (all of SWITCH_NODES, or fewer when one is down). */
export async function askAll<T>(command: string, data: unknown, timeoutMs = 5_000): Promise<SwitchAnswer<T>[]> {
  const answers: SwitchAnswer<T>[] = [];
  try {
    const c = await conn();
    const replies = await c.requestMany(`smscmd.all.${command}`, encode(data), {
      strategy: RequestStrategy.Count,
      maxMessages: nodes(),
      maxWait: timeoutMs,
    });
    for await (const m of replies) answers.push(decode<T>(m.data));
  } catch (err) {
    if (!answers.length) throw unreachableOr(command, err);
  }
  if (!answers.length) throw new SwitchUnreachable(command);
  return answers;
}

/** The data of an answer, or `SwitchRefused` with the server's reason. */
export function dataOf<T>(answer: SwitchAnswer<T>): T {
  if (!answer.ok) throw new SwitchRefused(answer.error ?? "the switch refused the command");
  return answer.data as T;
}

function unreachableOr(command: string, err: unknown): Error {
  if (err instanceof SwitchRefused) return err;
  // No responders, a timeout or no connection to NATS: the switch cannot be asked.
  return new SwitchUnreachable(command);
}

/** Closes the connection (tests, shutdown). */
export async function closeSwitchCommands() {
  const c = nc;
  nc = null;
  if (c) await (await c.catch(() => null))?.close();
}

/**
 * The screen's answer for a command that failed: 503 when no switch server answered, 400 with the switch's reason when
 * it refused; anything else is rethrown.
 */
export function switchProblem(reply: FastifyReply, err: unknown) {
  if (err instanceof SwitchUnreachable)
    return sendProblem(reply, 503, "The switch did not answer", {
      detail: "No switch server answered in time. Nothing was done; try again in a moment.",
      code: "switch_unreachable",
    });
  if (err instanceof SwitchRefused)
    return sendProblem(reply, 400, "The switch refused it", { detail: err.message, code: "switch_refused" });
  throw err;
}
