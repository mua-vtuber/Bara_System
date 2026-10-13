import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSshFixture } from "./ssh-fixture.ts";

let dir: string;
let key: string;
let fixture: Record<string, unknown>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-ssh-fixture-"));
  key = join(dir, "client");
  writeFileSync(key, "test-only-key-file");
  fixture = { host: "127.0.0.1", port: 22289, user: "root", keyPath: key,
    fingerprint: `SHA256:${"A".repeat(43)}`, serverPath: "/tmp/bara-pet-test-123/install", serverPort: 30191 };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("loads explicit JSON file and inline JSON into a validated SSH connection", () => {
  const file = join(dir, "fixture.json");
  writeFileSync(file, JSON.stringify(fixture));
  expect(loadSshFixture(["--fixture", file]).ssh.keyPath).toBe(key);
  expect(loadSshFixture(["--fixture", JSON.stringify(fixture)]).fingerprint).toBe(fixture.fingerprint as string);
});

test("rejects production-like hosts, paths, missing keys and malformed fields", () => {
  for (const change of [
    { host: "example.com" }, { serverPath: "/home/root/bara" },
    { serverPath: "/tmp/bara-pet-test-123/../install" }, { port: 0 },
    { fingerprint: "SHA256:short" }, { keyPath: join(dir, "missing") },
    { unexpected: "field" },
  ]) expect(() => loadSshFixture(["--fixture", JSON.stringify({ ...fixture, ...change })])).toThrow();
});
