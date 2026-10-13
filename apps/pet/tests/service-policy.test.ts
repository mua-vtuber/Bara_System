import { expect, test } from "bun:test";
import { parseBaseUrl, parseOwnerLink, validateSaveInput, validateSettingsUpdate } from "../src/service/validation.ts";

test("only loopback HTTP and clean HTTPS origins are accepted", () => {
  expect(parseBaseUrl("http://127.0.0.1:3210/")).toBe("http://127.0.0.1:3210");
  expect(parseBaseUrl("https://memory.example.org/")).toBe("https://memory.example.org");
  for (const url of ["http://memory.example.org", "http://localhost.evil.org", "https://u:p@memory.example.org", "https://memory.example.org/?token=x", "https://memory.example.org/#x", "https://memory.example.org/path"]) {
    expect(() => parseBaseUrl(url)).toThrow();
  }
});

test("owner dashboard link yields only a clean origin and secret", () => {
  expect(parseOwnerLink("https://memory.example.org/#bara-token=abc123")).toEqual({ baseUrl: "https://memory.example.org", token: "abc123" });
  expect(() => parseOwnerLink("https://memory.example.org/?token=abc#bara-token=def")).toThrow();
});

test("explicit unclassified input stays null and validates draft UUID", () => {
  expect(validateSaveInput({ content: "abc", requestId: "810eb554-6f98-4522-a587-70d6e09d5da1", audience: "server-A", kind: null, autoClassify: true }).kind).toBeNull();
  expect(() => validateSaveInput({ content: "abc", requestId: "bad", audience: "server-A" })).toThrow();
  expect(() => validateSaveInput({ content: "abc", requestId: "810eb554-6f98-4522-a587-70d6e09d5da1", audience: "" })).toThrow();
});

test("SSH settings reject unsafe host, path and port", () => {
  const connection = { mode: "remote" as const, baseUrl: "http://127.0.0.1:41001", ssh: { host: "example.org;rm", port: 22, user: "ubuntu", keyPath: "C:\\key" } };
  expect(() => validateSettingsUpdate({ connection })).toThrow();
});

test("unrecognized SSH fields never reach persisted public settings", () => {
  const connection = { mode: "remote" as const, baseUrl: "http://127.0.0.1:41001", ssh: { host: "example.org", port: 22, user: "ubuntu", keyPath: "C:\\key", password: "DO-NOT-PERSIST" } };
  expect(JSON.stringify(validateSettingsUpdate({ connection }).connection)).not.toContain("DO-NOT-PERSIST");
});

// WP-PFIX-4: a remote server's audience leaves out the local address, so an outside address saved under
// the same SSH settings would keep the stored token. Only the tunnel's own loopback form is accepted.
test("a remote connection accepts only the SSH tunnel's http://127.0.0.1:<port> address", () => {
  const ssh = { host: "example.org", port: 22, user: "ubuntu", keyPath: "C:\\key" };
  expect(validateSettingsUpdate({ connection: { mode: "remote", baseUrl: "http://127.0.0.1:41001", ssh } }).connection?.baseUrl).toBe("http://127.0.0.1:41001");
  for (const baseUrl of ["https://memory.example.org", "http://localhost:41001", "http://[::1]:41001", "http://127.0.0.1", "https://127.0.0.1:41001"]) {
    let code: string | undefined;
    try { validateSettingsUpdate({ connection: { mode: "remote", baseUrl, ssh } }); } catch (error) { code = (error as { code?: string }).code; }
    expect({ baseUrl, code }).toEqual({ baseUrl, code: "INVALID_INPUT" });
  }
  // An existing server reached without SSH keeps its outside address.
  expect(validateSettingsUpdate({ connection: { mode: "existing", baseUrl: "https://memory.example.org" } }).connection?.baseUrl).toBe("https://memory.example.org");
});

test("a dashboard URL cannot be stored as the daily bearer token", () => {
  expect(() => validateSettingsUpdate({ token: "https://memory.example.org/#bara-token=owner" })).toThrow();
});
