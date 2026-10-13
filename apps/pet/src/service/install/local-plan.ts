import type { ConnectionMode } from "../../shared/contracts.ts";

/** The Pet's own install record (`managed-install.json`). */
export interface LocalJournalFact { phase: "preparing" | "complete"; port: number }

/** What `install.local` knows before it changes anything. */
export interface LocalInstallFacts {
  journal: LocalJournalFact | null;
  /** Saved connection mode. */
  mode: ConnectionMode;
  /** A client token is stored for the saved connection. */
  hasToken: boolean;
  /** Whether a Bara core already answers on this PC's default core port. Probed only when there is
   * neither an install record nor a token (`needsCoreProbe`); `null` when it was not probed. */
  coreRunning: boolean | null;
}

export type LocalInstallBlock = "INSTALL_EXISTING_CONNECTION" | "INSTALL_EXISTING_CORE";

export type LocalInstallPlan =
  /** Connect to the Pet's complete local install with the stored token. */
  | { kind: "reuse"; port: number }
  /** Continue the Pet's own install on its recorded port; every step is idempotent. */
  | { kind: "resume"; port: number }
  /** Nothing of the Pet's or of an existing core is here: install on a newly chosen port. */
  | { kind: "fresh" }
  /** Installing would replace a connection or data the user already has. */
  | { kind: "blocked"; code: LocalInstallBlock };

/** The core probe matters only when neither the Pet's install record nor a token exists. */
export function needsCoreProbe(facts: Pick<LocalInstallFacts, "journal" | "hasToken">): boolean {
  return facts.journal === null && !facts.hasToken;
}

export function decideLocalInstall(facts: LocalInstallFacts): LocalInstallPlan {
  const { journal } = facts;
  // A token for anything but the Pet's own local install is a connection the user already has, remote
  // or existing, whatever install record is left behind.
  if (facts.hasToken && !(facts.mode === "local" && journal))
    return { kind: "blocked", code: "INSTALL_EXISTING_CONNECTION" };
  if (journal?.phase === "complete" && facts.mode === "local" && facts.hasToken) return { kind: "reuse", port: journal.port };
  if (journal) return { kind: "resume", port: journal.port };
  if (facts.coreRunning === null)
    throw new Error("decideLocalInstall needs the core probe when there is neither an install record nor a token");
  // A running core owns memories the user already keeps; a new store beside it would split them.
  return facts.coreRunning ? { kind: "blocked", code: "INSTALL_EXISTING_CORE" } : { kind: "fresh" };
}
