import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionSettings, RequestContext, SshConnection } from "../../shared/contracts.ts";
import { DpapiVault } from "../../../tests/e2e/dpapi-vault.ts";
import { ConfigStore } from "../config.ts";
import { InstallManager } from "./index.ts";

const windowsOnly = test.skipIf(process.platform !== "win32");

/** Await a rejection on the main event loop (see local-server.test.ts) and return its code. */
function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(() => { throw new Error("expected the promise to reject"); }, (error: unknown) => (error as { code?: string }).code);
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pet-remote-recovery-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (): RequestContext => ({ signal: new AbortController().signal, progress() {} });
const token = (seed: string) => seed.repeat(48);
const FINGERPRINT = `SHA256:${"A".repeat(43)}`;

/** A Pet data folder with a real settings store and real DPAPI. The resource folder is empty, so a run that
 * gets past the stored-connection check stops at the payload check, before any SSH work. */
function pet(): { config: ConfigStore; manager: InstallManager; ssh: SshConnection } {
  const paths = { dataDir: join(dir, "data"), resourceDir: join(dir, "resources"), bunPath: join(dir, "resources", "runtime", "bun.exe") };
  const config = new ConfigStore(paths, new DpapiVault());
  const ssh: SshConnection = { host: "memory.example.org", port: 22, user: "ubuntu", keyPath: join(dir, "id_ed25519"),
    fingerprint: FINGERPRINT, serverPath: "/home/ubuntu/.local/share/bara-pet-server", serverPort: 3001 };
  return { config, manager: new InstallManager(config, paths), ssh };
}

windowsOnly("a stored token keeps its connection: a run for another server stops before any install work", async () => {
  const { config, manager, ssh } = pet();
  const remote: ConnectionSettings = { mode: "remote", baseUrl: "http://127.0.0.1:41001", ssh };
  await config.save({ connection: remote, token: token("a"), ownerToken: token("b") });
  const before = await config.snapshot();
  try {
    for (const change of [{ host: "other.example.org" }, { port: 2222 }, { user: "root" }, { serverPath: "/srv/bara-pet" }])
      expect({ change, code: await rejectionCode(manager.remote({ ssh: { ...ssh, ...change }, acceptedFingerprint: FINGERPRINT }, ctx())) })
        .toEqual({ change, code: "INSTALL_EXISTING_CONNECTION" });
    const after = await config.snapshot();
    expect({ connection: after.settings.connection, token: after.token, ownerToken: after.ownerToken })
      .toEqual({ connection: before.settings.connection, token: before.token, ownerToken: before.ownerToken });
  } finally { await manager.close(); }
}, 60_000);

windowsOnly("a local or existing connection with a token is never replaced by a remote install", async () => {
  const { config, manager, ssh } = pet();
  try {
    for (const connection of [{ mode: "local", baseUrl: "http://127.0.0.1:41002" }, { mode: "existing", baseUrl: "http://127.0.0.1:41003", ssh }] as ConnectionSettings[]) {
      await config.save({ connection, token: token("c") });
      expect({ mode: connection.mode, code: await rejectionCode(manager.remote({ ssh, acceptedFingerprint: FINGERPRINT }, ctx())) })
        .toEqual({ mode: connection.mode, code: "INSTALL_EXISTING_CONNECTION" });
      expect((await config.snapshot()).settings.connection).toEqual(connection);
    }
  } finally { await manager.close(); }
}, 60_000);

windowsOnly("a run for the same remote server passes the stored-connection check as its recovery", async () => {
  const { config, manager, ssh } = pet();
  try {
    // A Pet without a stored token is not held back either.
    expect(await rejectionCode(manager.remote({ ssh, acceptedFingerprint: FINGERPRINT }, ctx()))).toBe("PAYLOAD_MISSING");
    await config.save({ connection: { mode: "remote", baseUrl: "http://127.0.0.1:41004", ssh }, token: token("d"), ownerToken: token("e") });
    // The key file, the server port and the path spelling may differ; host, SSH port, account and path decide.
    const { serverPath, ...withoutPath } = ssh;
    for (const request of [ssh, { ...withoutPath, keyPath: join(dir, "new-key"), serverPort: 3005 }, { ...ssh, serverPath: `${serverPath}/` }])
      expect(await rejectionCode(manager.remote({ ssh: request, acceptedFingerprint: FINGERPRINT }, ctx()))).toBe("PAYLOAD_MISSING");
  } finally { await manager.close(); }
}, 60_000);
