import { createServer } from "node:net";
import { CORE_DEFAULT_PORT } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { clientInfoFailure, interpretClientInfo, type ClientInfo, type ClientInfoFailure } from "../client-info.ts";
import { serviceError, type ServiceError } from "../errors.ts";
import { EXISTING_CORE_PROBE_TIMEOUT_MS, READY_POLL_INTERVAL_MS, READY_REQUEST_TIMEOUT_MS } from "./limits.ts";

/** Reserve a loopback port briefly; the server/tunnel must still verify its bind. */
export async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("Unable to allocate a local port")); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export async function availableManagedPort(): Promise<number> {
  let port: number;
  do { port = await availableLoopbackPort(); } while (port === CORE_DEFAULT_PORT);
  return port;
}

/** Persist a candidate origin before anything binds it. A previously used
 * origin for another SSH audience is never recycled, even when the port is free. */
export async function reserveFreshOrigin(reserve: (baseUrl: string) => Promise<void>,
  allocate: () => Promise<number> = availableManagedPort): Promise<string> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = await allocate();
    const baseUrl = `http://127.0.0.1:${port}`;
    try { await reserve(baseUrl); return baseUrl; }
    catch (error) {
      if ((error as { code?: string }).code !== "CONNECTION_ORIGIN_RESERVED") throw error;
    }
  }
  throw serviceError("INSTALL_PORT_UNAVAILABLE", messages.installService.localPortUnavailable);
}

/** Code a wait for a server reports when its time runs out: this PC's server, or one reached over SSH. */
export type ReadyTimeoutCode = "INSTALL_SERVER_TIMEOUT" | "SSH_SERVER_TIMEOUT";

export interface ReadyWait {
  timeoutMs: number;
  timeoutCode: ReadyTimeoutCode;
  /** Runs before every request, e.g. to re-verify who alone owns the port the bearer is sent to. */
  beforeRequest?: () => Promise<void>;
}

/** The timeout error: the caller's code, the limit, and what the server last answered, if anything. */
export function readyTimeout(code: ReadyTimeoutCode, timeoutMs: number, lastStatus: number | null): ServiceError {
  const detail = lastStatus === null ? messages.connectionWait.noAnswer : messages.connectionWait.lastStatus(lastStatus);
  return serviceError(code, messages.connectionErrors[code](Math.ceil(timeoutMs / 1000), detail));
}

type Judged<Ready> = Ready | { kind: "retry"; status: number } | { kind: "failed"; code: ClientInfoFailure; status: number };
export type HealthVerdict = Judged<{ kind: "ready" }>;

function healthyBody(bodyText: string): boolean {
  let body: unknown;
  try { body = JSON.parse(bodyText); } catch { return false; } // not JSON: not a Bara core's answer
  return body !== null && typeof body === "object" && (body as { ok?: unknown }).ok === true;
}

/** `/health` is public on every Bara core and has answered `{"ok":true}` since the first release, so any
 * other answer is not a Bara core; a 5xx may come from a server that is still starting. */
export function interpretHealth(status: number, bodyText: string): HealthVerdict {
  if (status >= 500 && status <= 599) return { kind: "retry", status };
  return status >= 200 && status <= 299 && healthyBody(bodyText)
    ? { kind: "ready" } : { kind: "failed", code: "SERVER_INCOMPATIBLE", status };
}

/** One readiness request. `null` when no HTTP answer arrived (refused, reset or unanswered), as happens
 * while a server or tunnel is still starting. A redirect is an answer and is never followed, so a
 * bearer never reaches another origin. */
async function ask(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<{ status: number; body: string } | null> {
  try {
    const response = await fetch(url, { headers, redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS)]) });
    return { status: response.status, body: await response.text() };
  } catch {
    signal.throwIfAborted();
    return null; // Never log the failure: the request carried a credential.
  }
}

/** Ask until the answer is ready. An answer that proves a cause ends the wait at once with that cause;
 * only "no answer yet" and 5xx wait on, and running out of time reports the caller's code. */
async function waitUntilReady<Ready extends { kind: "ready" }>(url: URL, headers: Record<string, string>,
  signal: AbortSignal, wait: ReadyWait, interpret: (status: number, bodyText: string) => Judged<Ready>): Promise<Ready> {
  const deadline = Date.now() + wait.timeoutMs;
  let lastStatus: number | null = null;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (wait.beforeRequest) await wait.beforeRequest();
    const answer = await ask(url, headers, signal);
    if (answer) {
      const verdict = interpret(answer.status, answer.body);
      if (verdict.kind === "failed") throw clientInfoFailure(verdict);
      if (verdict.kind === "retry") lastStatus = verdict.status;
      else return verdict;
    }
    await Bun.sleep(READY_POLL_INTERVAL_MS);
  }
  throw readyTimeout(wait.timeoutCode, wait.timeoutMs, lastStatus);
}

export async function waitForClient(url: string, token: string, signal: AbortSignal, wait: ReadyWait): Promise<ClientInfo> {
  const ready = await waitUntilReady(new URL("/client-info", url), { authorization: `Bearer ${token}` }, signal, wait,
    interpretClientInfo);
  return ready.info;
}

export async function waitForHealth(url: string, signal: AbortSignal, wait: ReadyWait): Promise<void> {
  await waitUntilReady(new URL("/health", url), {}, signal, wait, interpretHealth);
}

/** Whether a Bara core answers the public `/health` on this PC's loopback `port`. Sends no credential.
 * No answer, or an answer that is not a Bara core's, means no core runs there. */
export async function isCoreRunning(port: number, signal: AbortSignal): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`Invalid TCP port: ${port}`);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(EXISTING_CORE_PROBE_TIMEOUT_MS)]) });
    return interpretHealth(response.status, await response.text()).kind === "ready";
  } catch {
    signal.throwIfAborted();
    return false; // refused or unanswered: nothing that answers like a core
  }
}
