import { connectionRoute, type ConnectionSettings } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import type { LocalServer } from "./local-server.ts";
import { isRunning } from "./process.ts";
import { waitForTunnelListener } from "./port-owner.ts";

/** The local listeners this service verified as the only owner of a connection's port: the SSH tunnel
 * it started (P1-15, P2-19) and the memory server it started on this PC (P1-13). Every request that
 * carries the memory token or the owner token asks `assertServes` right before it is sent, so a
 * program holding a saved or old local port never receives a credential, whichever path the request
 * took and whether or not `ensureConnection` ran first. The check reads process state only; it starts
 * no lookup, so it can run before every request. */
export class CredentialRoutes {
  private tunnel: { route: string; process: Bun.Subprocess } | null = null;

  constructor(private readonly local: Pick<LocalServer, "serves">) {}

  /** Wait until `tunnel` alone listens on `connection`'s local port, then allow requests on that
   * connection's route while the tunnel process runs. */
  async verifyTunnel(tunnel: Bun.Subprocess, connection: ConnectionSettings, signal: AbortSignal): Promise<void> {
    this.forgetTunnel(tunnel);
    await waitForTunnelListener(tunnel, connection.baseUrl, signal);
    this.tunnel = { route: connectionRoute(connection), process: tunnel };
  }

  /** Called when the service stops or replaces `tunnel`: requests stop before its process has exited. */
  forgetTunnel(tunnel: Bun.Subprocess | null): void {
    if (tunnel && this.tunnel?.process === tunnel) this.tunnel = null;
  }

  assertServes(connection: ConnectionSettings): void {
    const route = connectionRoute(connection);
    if (connection.ssh || connection.mode === "remote") {
      const verified = this.tunnel;
      if (!verified || verified.route !== route || !isRunning(verified.process))
        throw serviceError("SSH_TUNNEL_UNVERIFIED", messages.connectionErrors.SSH_TUNNEL_UNVERIFIED);
      return;
    }
    if (connection.mode === "local") {
      if (!this.local.serves(Number(new URL(connection.baseUrl).port), route))
        throw serviceError("LOCAL_SERVER_UNVERIFIED", messages.connectionErrors.LOCAL_SERVER_UNVERIFIED);
      return;
    }
    // An existing server reached without SSH is the address the user entered; no local listener of
    // this service stands between the Pet and that server, so there is no owner to verify.
  }
}
