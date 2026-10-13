import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../config.ts";
import { DpapiVault } from "../../../tests/e2e/dpapi-vault.ts";
import { rebindSnapshot } from "./connection-policy.ts";
import { reserveFreshOrigin } from "./net.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bara-rebind-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a stale reconnect cannot attach a new server's owner token to the old endpoint", async () => {
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
  const sshA = { host: "a.example.org", port: 22, user: "root", keyPath: join(dir, "key-a") };
  const sshB = { host: "b.example.org", port: 22, user: "root", keyPath: join(dir, "key-b") };
  const a = { mode: "remote" as const, baseUrl: "http://127.0.0.1:41001", ssh: sshA };
  const b = { mode: "remote" as const, baseUrl: "http://127.0.0.1:41002", ssh: sshB };
  await config.save({ connection: a, token: "token-A", ownerToken: "owner-A" });
  const oldA = await config.snapshot();
  await config.save({ connection: b, token: "token-B", ownerToken: "owner-B" });
  await expect(rebindSnapshot(config, oldA, { ...a, baseUrl: "http://127.0.0.1:41003" }))
    .rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
  const current = await config.snapshot();
  expect(current.settings.connection).toEqual(b);
  expect(current.token).toBe("token-B");
  expect(current.ownerToken).toBe("owner-B");

  await rebindSnapshot(config, current, { ...b, baseUrl: "http://127.0.0.1:41004" });
  const rebound = await config.snapshot();
  expect(rebound.settings.connection.baseUrl).toBe("http://127.0.0.1:41004");
  expect(rebound.token).toBe("token-B");
  expect(rebound.ownerToken).toBe("owner-B");
}, 30_000);

test("persisted reservations reject a different SSH audience and fresh selection skips its old port", async () => {
  const vault = new DpapiVault();
  const paths = { dataDir: dir, resourceDir: dir, bunPath: process.execPath };
  const config = new ConfigStore(paths, vault);
  const sshA = { host: "a.example.org", port: 22, user: "root", keyPath: join(dir, "key-a") };
  const sshB = { host: "b.example.org", port: 22, user: "root", keyPath: join(dir, "key-b") };
  const a = { mode: "existing" as const, baseUrl: "http://127.0.0.1:41011", ssh: sshA };
  await config.reserveOrigin(a);
  const before = readFileSync(join(dir, "pet-settings.json"));
  await config.reserveOrigin(a);
  expect(readFileSync(join(dir, "pet-settings.json"))).toEqual(before);
  const restarted = new ConfigStore(paths, vault);
  await expect(restarted.assertOriginAvailable({ mode: "remote", baseUrl: a.baseUrl, ssh: sshB }))
    .rejects.toMatchObject({ code: "CONNECTION_ORIGIN_RESERVED" });
  const ports = [41011, 41012];
  const selected = await reserveFreshOrigin((baseUrl) => restarted.reserveOrigin({ mode: "remote", baseUrl, ssh: sshB }),
    async () => ports.shift()!);
  expect(selected).toBe("http://127.0.0.1:41012");

  // A real local install also owns its selected loopback URL. An old browser
  // tab for that server must never later hit an unrelated remote SSH tunnel.
  await restarted.reserveOrigin({ mode: "local", baseUrl: "http://127.0.0.1:41013" });
  await expect(restarted.assertOriginAvailable({ mode: "remote", baseUrl: "http://127.0.0.1:41013", ssh: sshB }))
    .rejects.toMatchObject({ code: "CONNECTION_ORIGIN_RESERVED" });
});
