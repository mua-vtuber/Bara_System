import type { ConnectionSettings, TunnelPortNotice } from "../../shared/contracts.ts";
import type { ConfigStore } from "../config.ts";
import { tunnelPort } from "../validation.ts";
import { inspectListener } from "./port-owner.ts";

/** Why the preferred local port could not be claimed for a remote tunnel. */
export type PreferredBlock = { reason: "in-use"; owners: number[] } | { reason: "reserved" };
export type PreferredClaim = { kind: "claimed"; baseUrl: string } | ({ kind: "blocked" } & PreferredBlock);

/** Claim `http://127.0.0.1:<preferredPort>` for a remote connection's tunnel: nothing may listen there,
 * and the address must be free in the reservation ledger or held by the same server (`sameSshEndpoint`).
 * A claimed address is reserved for this connection's audience before anything binds it. Any failure
 * other than another server's reservation is thrown, never turned into a fallback. */
export async function claimPreferredOrigin(config: ConfigStore, connection: ConnectionSettings, preferredPort: number,
  signal: AbortSignal): Promise<PreferredClaim> {
  const listener = await inspectListener(preferredPort, signal);
  if (listener.kind !== "none") return { kind: "blocked", reason: "in-use", owners: listener.kind === "other" ? listener.others : [] };
  const baseUrl = `http://127.0.0.1:${preferredPort}`;
  try { await config.reserveOrigin({ ...connection, baseUrl }); }
  catch (error) {
    if ((error as { code?: string }).code !== "CONNECTION_ORIGIN_RESERVED") throw error;
    return { kind: "blocked", reason: "reserved" };
  }
  return { kind: "claimed", baseUrl };
}

/** Whether a tunnel for `connection` should first try the preferred port: only a remote connection with a
 * stored token (the token is rebound to the new address) that is not already saved on that port. */
export function triesPreferredPort(connection: ConnectionSettings, hasToken: boolean, preferredPort: number): boolean {
  return connection.mode === "remote" && hasToken && tunnelPort(connection.baseUrl) !== preferredPort;
}

/** The screen's notice for a remote tunnel that ended up on `baseUrl`: null when that is the preferred port,
 * else why it is not. `block` is what kept the preferred port: a blocked claim, or `"bind-failed"` when a
 * tunnel on the preferred port could not be opened. */
export function tunnelPortNotice(baseUrl: string, preferredPort: number, block: PreferredBlock | "bind-failed"): TunnelPortNotice | null {
  const port = tunnelPort(baseUrl);
  if (port === null || port === preferredPort) return null;
  if (block === "bind-failed") return { preferredPort, port, reason: "bind-failed", owners: [] };
  return { preferredPort, port, reason: block.reason, owners: block.reason === "in-use" ? block.owners : [] };
}
