import { expect, test } from "bun:test";
import nativeHost from "./native-host.json";
import { audienceMatches, CONNECTION_AUDIENCE_VERSION, connectionAudience, connectionRoute, CORE_DEFAULT_PORT,
  type ConnectionSettings, type SshConnection } from "./contracts.ts";

// WP-P2-19: a remote server's audience is the remote server itself, not the local tunnel address.
const SSH: SshConnection = { host: "a.example.org", port: 22, user: "ubuntu", keyPath: "C:\\keys\\a", fingerprint: `SHA256:${"A".repeat(43)}`, serverPort: 3001 };
const REMOTE: ConnectionSettings = { mode: "remote", baseUrl: "http://127.0.0.1:41001", ssh: SSH };
/** The exact formula every audience was computed with before the version tag: the stored form of
 * pending receipts and deep links written by an earlier Pet. */
function untaggedAudience(connection: ConnectionSettings): string {
  return JSON.stringify({ mode: connection.mode, origin: connection.baseUrl, ssh: connection.ssh ?? null });
}

test("the audience version matches the native host contract", () => {
  expect(nativeHost.contract.connectionAudienceVersion).toBe(CONNECTION_AUDIENCE_VERSION);
  expect(JSON.parse(connectionAudience(REMOTE)).v).toBe(CONNECTION_AUDIENCE_VERSION);
  expect(JSON.parse(connectionAudience({ mode: "local", baseUrl: "http://127.0.0.1:3001" })).v).toBe(CONNECTION_AUDIENCE_VERSION);
});

test("a remote audience stays the same when only the local tunnel port, SSH user or SSH port changes", () => {
  const audience = connectionAudience(REMOTE);
  expect(connectionAudience({ ...REMOTE, baseUrl: "http://127.0.0.1:41002" })).toBe(audience);
  expect(connectionAudience({ ...REMOTE, ssh: { ...SSH, user: "admin", port: 2222, keyPath: "C:\\keys\\b" } })).toBe(audience);
  expect(connectionAudience({ ...REMOTE, ssh: { ...SSH, serverPath: "/srv/bara" } })).toBe(audience);
});

test("a remote audience changes with the host, the host key fingerprint or the remote server port", () => {
  const audience = connectionAudience(REMOTE);
  expect(connectionAudience({ ...REMOTE, ssh: { ...SSH, host: "b.example.org" } })).not.toBe(audience);
  expect(connectionAudience({ ...REMOTE, ssh: { ...SSH, fingerprint: `SHA256:${"B".repeat(43)}` } })).not.toBe(audience);
  expect(connectionAudience({ ...REMOTE, ssh: { ...SSH, fingerprint: undefined } })).not.toBe(audience);
  expect(connectionAudience({ ...REMOTE, ssh: { ...SSH, serverPort: 3002 } })).not.toBe(audience);
  // An unset remote server port is the core's default port, the one the tunnel actually forwards to.
  const { serverPort: _omitted, ...withoutServerPort } = SSH;
  expect(connectionAudience({ ...REMOTE, ssh: withoutServerPort })).toBe(connectionAudience({ ...REMOTE, ssh: { ...SSH, serverPort: CORE_DEFAULT_PORT } }));
});

test("local and existing audiences remain their address", () => {
  const local: ConnectionSettings = { mode: "local", baseUrl: "http://127.0.0.1:3001" };
  expect(connectionAudience({ ...local, baseUrl: "http://127.0.0.1:3002" })).not.toBe(connectionAudience(local));
  const existing: ConnectionSettings = { mode: "existing", baseUrl: "https://memory.example.org" };
  expect(connectionAudience(existing)).not.toBe(connectionAudience({ ...existing, baseUrl: "https://other.example.org" }));
  expect(connectionAudience({ ...existing, ssh: SSH })).not.toBe(connectionAudience({ ...existing, ssh: { ...SSH, host: "b.example.org" } }));
  expect(connectionAudience(existing)).not.toBe(connectionAudience({ ...existing, mode: "local" }));
});

test("the current audience format matches, and so does the untagged audience of the same server", () => {
  expect(audienceMatches(connectionAudience(REMOTE), REMOTE)).toBe(true);
  // A receipt stored before a restart, when the tunnel listened on another local port.
  const moved: ConnectionSettings = { ...REMOTE, baseUrl: "http://127.0.0.1:41002" };
  expect(audienceMatches(untaggedAudience(REMOTE), moved)).toBe(true);
  expect(audienceMatches(untaggedAudience(REMOTE), { ...moved, ssh: { ...SSH, user: "admin" } })).toBe(true);
  // Key order in the stored SSH object does not decide the match.
  const reordered = JSON.stringify({ mode: "remote", origin: REMOTE.baseUrl, ssh: { serverPort: 3001, fingerprint: SSH.fingerprint, keyPath: SSH.keyPath, user: SSH.user, port: SSH.port, host: SSH.host } });
  expect(audienceMatches(reordered, moved)).toBe(true);
  const local: ConnectionSettings = { mode: "local", baseUrl: "http://127.0.0.1:3001" };
  expect(audienceMatches(untaggedAudience(local), local)).toBe(true);
  const existing: ConnectionSettings = { mode: "existing", baseUrl: "http://127.0.0.1:41005", ssh: SSH };
  expect(audienceMatches(untaggedAudience(existing), existing)).toBe(true);
});

test("the untagged audience of another server never matches", () => {
  const moved: ConnectionSettings = { ...REMOTE, baseUrl: "http://127.0.0.1:41002" };
  expect(audienceMatches(untaggedAudience({ ...REMOTE, ssh: { ...SSH, host: "b.example.org" } }), moved)).toBe(false);
  expect(audienceMatches(untaggedAudience({ ...REMOTE, ssh: { ...SSH, fingerprint: `SHA256:${"B".repeat(43)}` } }), moved)).toBe(false);
  expect(audienceMatches(untaggedAudience({ ...REMOTE, ssh: { ...SSH, serverPort: 3002 } }), moved)).toBe(false);
  // The same address in another mode, or through a different SSH route, is not the same server.
  expect(audienceMatches(untaggedAudience({ mode: "existing", baseUrl: REMOTE.baseUrl, ssh: SSH }), REMOTE)).toBe(false);
  const local: ConnectionSettings = { mode: "local", baseUrl: "http://127.0.0.1:3001" };
  expect(audienceMatches(untaggedAudience(local), { ...local, baseUrl: "http://127.0.0.1:3002" })).toBe(false);
  expect(audienceMatches(untaggedAudience(local), { mode: "remote", baseUrl: local.baseUrl, ssh: SSH })).toBe(false);
  const existing: ConnectionSettings = { mode: "existing", baseUrl: "http://127.0.0.1:41005", ssh: SSH };
  expect(audienceMatches(untaggedAudience(existing), { ...existing, ssh: { ...SSH, fingerprint: `SHA256:${"B".repeat(43)}` } })).toBe(false);
  expect(audienceMatches(connectionAudience({ ...REMOTE, ssh: { ...SSH, host: "b.example.org" } }), REMOTE)).toBe(false);
});

test("an unreadable or unknown audience never matches", () => {
  for (const stored of ["", "not json", "null", "[]", JSON.stringify({ mode: "remote", origin: REMOTE.baseUrl }),
    JSON.stringify({ mode: "remote", origin: REMOTE.baseUrl, ssh: SSH, extra: 1 }),
    JSON.stringify({ mode: "remote", origin: REMOTE.baseUrl, ssh: { ...SSH, token: "x" } }),
    JSON.stringify({ mode: "remote", origin: REMOTE.baseUrl, ssh: { ...SSH, port: "22" } }),
    JSON.stringify({ mode: "cloud", origin: REMOTE.baseUrl, ssh: SSH }),
    JSON.stringify({ ...JSON.parse(connectionAudience(REMOTE)), v: CONNECTION_AUDIENCE_VERSION + 1 })]) {
    expect(audienceMatches(stored, REMOTE)).toBe(false);
  }
});

test("the route changes with the local tunnel port and SSH login while the audience does not", () => {
  const moved: ConnectionSettings = { ...REMOTE, baseUrl: "http://127.0.0.1:41002" };
  expect(connectionRoute(moved)).not.toBe(connectionRoute(REMOTE));
  expect(connectionRoute({ ...REMOTE, ssh: { ...SSH, user: "admin" } })).not.toBe(connectionRoute(REMOTE));
  const reordered: SshConnection = { serverPort: 3001, fingerprint: SSH.fingerprint, keyPath: SSH.keyPath, user: SSH.user, port: SSH.port, host: SSH.host };
  expect(connectionRoute({ ...REMOTE, ssh: reordered })).toBe(connectionRoute(REMOTE));
  // A route is never an audience, current or untagged.
  expect(audienceMatches(connectionRoute(REMOTE), REMOTE)).toBe(false);
});
