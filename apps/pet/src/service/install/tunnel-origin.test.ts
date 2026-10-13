import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAudience, sameSshEndpoint, type ConnectionSettings, type SshConnection } from "../../shared/contracts.ts";
import { DpapiVault } from "../../../tests/e2e/dpapi-vault.ts";
import { ConfigStore } from "../config.ts";
import { availableLoopbackPort } from "./net.ts";
import { claimPreferredOrigin, triesPreferredPort, tunnelPortNotice } from "./tunnel-origin.ts";

const windowsOnly = test.skipIf(process.platform !== "win32");
const FINGERPRINT = `SHA256:${"A".repeat(43)}`;
const OTHER_FINGERPRINT = `SHA256:${"B".repeat(43)}`;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pet-tunnel-origin-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ssh = (change: Partial<SshConnection> = {}): SshConnection => ({ host: "memory.example.org", port: 22, user: "bara",
  keyPath: join(dir, "id_ed25519"), fingerprint: FINGERPRINT, serverPath: "/home/bara/.local/share/bara-pet-server", serverPort: 3001, ...change });
const remote = (baseUrl: string, change: Partial<SshConnection> = {}): ConnectionSettings => ({ mode: "remote", baseUrl, ssh: ssh(change) });
const existing = (baseUrl: string, value?: SshConnection): ConnectionSettings =>
  ({ mode: "existing", baseUrl, ...(value ? { ssh: value } : {}) });
const store = () => new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
const ledger = () => (JSON.parse(readFileSync(join(dir, "pet-settings.json"), "utf8")) as { reservedOrigins: Record<string, string> }).reservedOrigins;

test("an existing SSH tunnel names the remote connection's server only with the same host, host key and server port", () => {
  const url = "http://127.0.0.1:41101";
  const held = connectionAudience(existing(url, ssh({ user: "root", port: 2222, keyPath: join(dir, "other-key") })));
  // The login, SSH port and key file only change how the server is reached, as in the remote identity itself.
  expect(sameSshEndpoint(held, remote(url))).toBe(true);
  expect(sameSshEndpoint(connectionAudience(existing(url, ssh({ serverPort: undefined }))), remote(url))).toBe(true);
  for (const change of [{ host: "other.example.org" }, { fingerprint: OTHER_FINGERPRINT }, { serverPort: 3005 }])
    expect({ change, same: sameSshEndpoint(connectionAudience(existing(url, ssh(change))), remote(url)) }).toEqual({ change, same: false });
  // No pinned host key on either side proves nothing.
  expect(sameSshEndpoint(connectionAudience(existing(url, ssh({ fingerprint: undefined }))), remote(url))).toBe(false);
  expect(sameSshEndpoint(held, remote(url, { fingerprint: undefined }))).toBe(false);
  // Only an existing SSH tunnel's address passes, and only to a remote connection.
  expect(sameSshEndpoint(connectionAudience(existing(url)), remote(url))).toBe(false);
  expect(sameSshEndpoint(connectionAudience({ mode: "local", baseUrl: url }), remote(url))).toBe(false);
  expect(sameSshEndpoint(connectionAudience(remote(url)), existing(url, ssh()))).toBe(false);
  expect(sameSshEndpoint("not json", remote(url))).toBe(false);
});

test("the untagged audience an older Pet stored for the same existing tunnel passes too", () => {
  const url = "http://127.0.0.1:41102";
  const untagged = JSON.stringify({ mode: "existing", origin: url, ssh: { host: "memory.example.org", port: 22, user: "bara",
    keyPath: join(dir, "id_ed25519"), fingerprint: FINGERPRINT, serverPort: 3001 } });
  expect(sameSshEndpoint(untagged, remote(url))).toBe(true);
  expect(sameSshEndpoint(untagged, remote(url, { fingerprint: OTHER_FINGERPRINT }))).toBe(false);
});

test("a remote connection takes over the address its own server's existing tunnel reserved, and never the other way", async () => {
  const config = store();
  const url = "http://127.0.0.1:41103";
  await config.reserveOrigin(existing(url, ssh()));
  await config.reserveOrigin(remote(url));
  expect(ledger()[url]).toBe(connectionAudience(remote(url)));
  // The address is the remote connection's now; the existing tunnel cannot take it back.
  await expect(config.assertOriginAvailable(existing(url, ssh()))).rejects.toMatchObject({ code: "CONNECTION_ORIGIN_RESERVED" });
});

test("an address another server's connection reserved stays refused to a remote connection", async () => {
  const config = store();
  const cases: [string, ConnectionSettings][] = [
    ["http://127.0.0.1:41104", existing("http://127.0.0.1:41104", ssh({ fingerprint: OTHER_FINGERPRINT }))],
    ["http://127.0.0.1:41105", existing("http://127.0.0.1:41105", ssh({ serverPort: 3005 }))],
    ["http://127.0.0.1:41106", existing("http://127.0.0.1:41106", ssh({ fingerprint: undefined }))],
    ["http://127.0.0.1:41107", existing("http://127.0.0.1:41107")],
    ["http://127.0.0.1:41108", { mode: "local", baseUrl: "http://127.0.0.1:41108" }],
    ["http://127.0.0.1:41109", remote("http://127.0.0.1:41109", { host: "other.example.org" })],
  ];
  for (const [url, holder] of cases) {
    await config.reserveOrigin(holder);
    expect({ url, code: await config.reserveOrigin(remote(url)).then(() => "reserved", (error: { code?: string }) => error.code) })
      .toEqual({ url, code: "CONNECTION_ORIGIN_RESERVED" });
    expect(ledger()[url]).toBe(connectionAudience(holder));
  }
});

windowsOnly("saving the remote connection on its server's existing address moves the reservation and the credentials", async () => {
  const config = store();
  const url = "http://127.0.0.1:41110";
  await config.save({ connection: existing(url, ssh()), token: "t".repeat(48) });
  await config.save({ connection: remote("http://127.0.0.1:41111"), token: "r".repeat(48), ownerToken: "o".repeat(48) });
  const snapshot = await config.snapshot();
  await config.save({ connection: remote(url), token: snapshot.token!, ownerToken: snapshot.ownerToken! }, snapshot.settings.connection);
  const moved = await config.snapshot();
  expect({ baseUrl: moved.settings.connection.baseUrl, token: moved.token, ownerToken: moved.ownerToken })
    .toEqual({ baseUrl: url, token: "r".repeat(48), ownerToken: "o".repeat(48) });
  expect(ledger()[url]).toBe(connectionAudience(remote(url)));
}, 60_000);

test("a free preferred port is claimed and reserved for the remote connection before anything binds it", async () => {
  const config = store();
  const port = await availableLoopbackPort();
  const claim = await claimPreferredOrigin(config, remote("http://127.0.0.1:41112"), port, new AbortController().signal);
  expect(claim).toEqual({ kind: "claimed", baseUrl: `http://127.0.0.1:${port}` });
  expect(ledger()[`http://127.0.0.1:${port}`]).toBe(connectionAudience(remote("http://127.0.0.1:41112")));
});

test("a preferred port another server's connection reserved is reported, not claimed", async () => {
  const config = store();
  const port = await availableLoopbackPort();
  await config.reserveOrigin({ mode: "local", baseUrl: `http://127.0.0.1:${port}` });
  expect(await claimPreferredOrigin(config, remote("http://127.0.0.1:41113"), port, new AbortController().signal))
    .toEqual({ kind: "blocked", reason: "reserved" });
});

windowsOnly("a preferred port another program listens on is reported with its process and left unreserved", async () => {
  const config = store();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  try {
    const port = server.port!;
    expect(await claimPreferredOrigin(config, remote("http://127.0.0.1:41114"), port, new AbortController().signal))
      .toEqual({ kind: "blocked", reason: "in-use", owners: [process.pid] });
    expect(() => ledger()).toThrow(); // nothing was written: no settings file exists yet
  } finally { await server.stop(true); }
}, 30_000);

test("only a remote connection with a token, saved off the preferred port, tries that port", () => {
  expect(triesPreferredPort(remote("http://127.0.0.1:59785"), true, 3001)).toBe(true);
  expect(triesPreferredPort(remote("http://127.0.0.1:3001"), true, 3001)).toBe(false);
  expect(triesPreferredPort(remote("http://127.0.0.1:59785"), false, 3001)).toBe(false);
  expect(triesPreferredPort(existing("http://127.0.0.1:59785", ssh()), true, 3001)).toBe(false);
  expect(triesPreferredPort({ mode: "local", baseUrl: "http://127.0.0.1:59785" }, true, 3001)).toBe(false);
});

test("the notice says why the tunnel is off the preferred port, and nothing when it is on it", () => {
  expect(tunnelPortNotice("http://127.0.0.1:3001", 3001, "bind-failed")).toBeNull();
  expect(tunnelPortNotice("http://127.0.0.1:59785", 3001, { reason: "in-use", owners: [42] }))
    .toEqual({ preferredPort: 3001, port: 59785, reason: "in-use", owners: [42] });
  expect(tunnelPortNotice("http://127.0.0.1:59785", 3001, { reason: "reserved" }))
    .toEqual({ preferredPort: 3001, port: 59785, reason: "reserved", owners: [] });
  expect(tunnelPortNotice("http://127.0.0.1:59785", 3001, "bind-failed"))
    .toEqual({ preferredPort: 3001, port: 59785, reason: "bind-failed", owners: [] });
});
