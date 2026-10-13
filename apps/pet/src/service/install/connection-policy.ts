import type { ConnectionSettings } from "../../shared/contracts.ts";
import { ConfigStore, type CredentialSnapshot } from "../config.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";

/** Rebind a port only with the original endpoint's complete credential pair.
 * ConfigStore's connection check rejects a concurrent switch to another server or address. */
export async function rebindSnapshot(config: ConfigStore, snapshot: CredentialSnapshot,
  connection: ConnectionSettings): Promise<void> {
  if (!snapshot.token) throw serviceError("CONNECTION_CHANGED", messages.installService.rebindTokenMissing);
  await config.save({ connection, token: snapshot.token,
    ownerToken: snapshot.ownerToken ?? undefined }, snapshot.settings.connection);
}
