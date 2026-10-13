import { PROTOCOL_VERSION } from "../shared/contracts.ts";
import { messages } from "../ui/messages.ts";
import { serviceError, type ServiceError } from "./errors.ts";

/** What this Pet relies on from an authenticated `GET /client-info` answer
 * (apps/setup/PET-INTEGRATION.md "클라이언트 API"). */
export interface ClientInfo {
  protocolVersion: typeof PROTOCOL_VERSION;
  /** Server release, when the server reports one. */
  version?: string;
  capabilities: string[];
  /** Absent when the server does not report its capture kinds. */
  captureKinds?: string[];
}

/** Causes a single answer proves on its own. Asking the same server again with the same credential
 * cannot change them, so a wait for the server ends at once. */
export type ClientInfoFailure =
  /** 401: the server does not accept the stored bearer (revoked, or issued by another server). */
  | "AUTH_REJECTED"
  /** 403 or 404: a server without the Pet client API, i.e. before the Pet integration. Its scope gate
   * refuses a `mcp-standard` token (403) and a `full` token finds no route (404). */
  | "SERVER_UPGRADE_REQUIRED"
  /** Any other answer outside this Pet's protocol: not JSON, another protocol version, no
   * capability list, a redirect, or a status the contract does not define. */
  | "SERVER_INCOMPATIBLE";

export type ClientInfoVerdict =
  | { kind: "ready"; info: ClientInfo }
  /** 5xx: the server, or something in front of it, failed this time; asking again can succeed. */
  | { kind: "retry"; status: number }
  | { kind: "failed"; code: ClientInfoFailure; status: number };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function strings(values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string");
}

function parseClientInfo(bodyText: string): ClientInfo | null {
  let value: unknown;
  try { value = JSON.parse(bodyText); } catch { return null; }
  const body = record(value);
  if (!body || body.protocolVersion !== PROTOCOL_VERSION || !Array.isArray(body.capabilities)) return null;
  return { protocolVersion: PROTOCOL_VERSION, capabilities: strings(body.capabilities),
    ...(typeof body.version === "string" ? { version: body.version } : {}),
    ...(Array.isArray(body.captureKinds) ? { captureKinds: strings(body.captureKinds) } : {}) };
}

/** One judgement of a `/client-info` answer, shared by every wait for a server and by connection checks,
 * so the same answer never means "ready" in one place and "incompatible" in another. */
export function interpretClientInfo(status: number, bodyText: string): ClientInfoVerdict {
  if (status === 401) return { kind: "failed", code: "AUTH_REJECTED", status };
  if (status === 403 || status === 404) return { kind: "failed", code: "SERVER_UPGRADE_REQUIRED", status };
  if (status >= 500 && status <= 599) return { kind: "retry", status };
  const info = status >= 200 && status <= 299 ? parseClientInfo(bodyText) : null;
  return info ? { kind: "ready", info } : { kind: "failed", code: "SERVER_INCOMPATIBLE", status };
}

/** The service error naming a failed verdict's cause, with its text from `messages.connectionErrors`. */
export function clientInfoFailure(verdict: { code: ClientInfoFailure; status: number }): ServiceError {
  const text = messages.connectionErrors;
  switch (verdict.code) {
    case "AUTH_REJECTED": return serviceError(verdict.code, text.AUTH_REJECTED);
    case "SERVER_UPGRADE_REQUIRED": return serviceError(verdict.code, text.SERVER_UPGRADE_REQUIRED);
    case "SERVER_INCOMPATIBLE": return serviceError(verdict.code, text.SERVER_INCOMPATIBLE(verdict.status));
  }
}
