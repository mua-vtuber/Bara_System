import { expect, test } from "bun:test";
import { audienceMatches, CONNECTION_AUDIENCE_VERSION, connectionAudience, type ConnectionSettings, type SshConnection } from "./contracts.ts";

// The native host validates the audience of a feedback bubble in Rust (`src-tauri/src/feedback/audience.rs`
// `valid_audience`) with the rule the service applies here, so a value one side refuses is refused by the
// other. These tests pin the service side of the remote-mode rule that the Rust tests mirror.
const SSH: SshConnection = { host: "a.example.org", port: 22, user: "ubuntu", keyPath: "C:\\keys\\a", fingerprint: `SHA256:${"A".repeat(43)}`, serverPort: 3001 };
const REMOTE: ConnectionSettings = { mode: "remote", baseUrl: "http://127.0.0.1:41001", ssh: SSH };
const CONNECTIONS: ConnectionSettings[] = [
  REMOTE,
  { mode: "local", baseUrl: REMOTE.baseUrl },
  { mode: "existing", baseUrl: REMOTE.baseUrl },
  { mode: "existing", baseUrl: REMOTE.baseUrl, ssh: SSH },
];

test("a remote connection's audience is its host identity, never an address identity", () => {
  expect(Object.keys(JSON.parse(connectionAudience(REMOTE))).sort()).toEqual(["fingerprint", "host", "mode", "serverPort", "v"]);
});

test("an address identity in remote mode matches no connection, tagged or not", () => {
  const stored = [
    JSON.stringify({ v: CONNECTION_AUDIENCE_VERSION, mode: "remote", origin: REMOTE.baseUrl, ssh: SSH }),
    JSON.stringify({ v: CONNECTION_AUDIENCE_VERSION, mode: "remote", origin: REMOTE.baseUrl, ssh: null }),
    JSON.stringify({ mode: "remote", origin: REMOTE.baseUrl, ssh: null }),
  ];
  for (const value of stored) for (const connection of CONNECTIONS) expect(audienceMatches(value, connection)).toBe(false);
});

test("an untagged remote audience with its SSH settings still names the remote server", () => {
  expect(audienceMatches(JSON.stringify({ mode: "remote", origin: REMOTE.baseUrl, ssh: SSH }), REMOTE)).toBe(true);
});
