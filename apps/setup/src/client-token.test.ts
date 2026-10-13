import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SseTokenStore } from "../../memory/src/federation/sse-tokens.ts";
import { prepareClientTokens, readExistingClientTokens } from "./client-token.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bara-client-tokens-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("fresh prestart provisioning persists separated client and owner scopes", async () => {
  const file = join(dir, "tokens.json");
  const result = await prepareClientTokens("http://127.0.0.1:49153/", file);
  const store = new SseTokenStore(file);
  expect(store.verifyToken(result.clientToken)).toBe("pet");
  expect(store.getTokenScope("pet")).toBe("mcp-standard");
  expect(store.verifyToken(result.ownerToken)).toBe("dashboard");
  expect(store.getTokenScope("dashboard")).toBe("full");
  expect(result.mcpUrl).toBe("http://127.0.0.1:49153/mcp");
  expect(new URLSearchParams(new URL(result.dashboardUrl).hash.slice(1)).get("bara-token")).toBe(result.ownerToken);
  const before = readFileSync(file);
  await expect(prepareClientTokens("http://127.0.0.1:49153/", file)).rejects.toThrow("already exists");
  expect(readFileSync(file)).toEqual(before);
});

test("existing file is never read or changed", async () => {
  const file = join(dir, "existing.json");
  writeFileSync(file, "existing authority");
  await expect(prepareClientTokens("http://127.0.0.1:49153/", file)).rejects.toThrow("already exists");
  expect(readFileSync(file, "utf8")).toBe("existing authority");
});

test("a responding server prevents token publication", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
  try {
    const file = join(dir, "tokens.json");
    await expect(prepareClientTokens(`http://127.0.0.1:${server.port}/`, file)).rejects.toThrow("responding");
    expect(Bun.file(file).size).toBe(0);
  } finally { server.stop(true); }
});

test("CLI writes a single JSON result to stdout and no secrets to stderr", () => {
  const file = join(dir, "cli-tokens.json");
  const child = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "client-token.ts"),
    "--url", "http://127.0.0.1:49154/", "--tokens-file", file, "--fresh"],
    { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(new TextDecoder().decode(child.stderr)).toBe("");
  const output = new TextDecoder().decode(child.stdout);
  expect(output.trim().split("\n")).toHaveLength(1);
  const result = JSON.parse(output) as { clientToken: string; ownerToken: string };
  expect(new SseTokenStore(file).verifyToken(result.clientToken)).toBe("pet");
  expect(new SseTokenStore(file).verifyToken(result.ownerToken)).toBe("dashboard");
});

test("read-existing recovers only the two scoped tokens without changing bytes while server is live", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
  try {
    const file = join(dir, "recovery.json");
    const store = new SseTokenStore(file);
    const clientToken = store.issueToken("pet", undefined, undefined, "mcp-standard");
    const ownerToken = store.issueToken("dashboard", undefined, undefined, "full");
    const before = readFileSync(file);
    const result = readExistingClientTokens(`http://127.0.0.1:${server.port}/`, file);
    expect(result.clientToken).toBe(clientToken);
    expect(result.ownerToken).toBe(ownerToken);
    expect(readFileSync(file)).toEqual(before);
    const child = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "client-token.ts"),
      "--url", `http://127.0.0.1:${server.port}/`, "--tokens-file", file, "--read-existing"],
      { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(child.stdout)).ownerToken).toBe(ownerToken);
    expect(readFileSync(file)).toEqual(before);
  } finally { server.stop(true); }
});

test("read-existing refuses missing or insufficient scopes without creating or promoting tokens", () => {
  const file = join(dir, "incomplete.json");
  expect(() => readExistingClientTokens("http://127.0.0.1:49154/", file)).toThrow("does not exist");
  const store = new SseTokenStore(file);
  store.issueToken("pet", undefined, undefined, "read-only");
  const before = readFileSync(file);
  expect(() => readExistingClientTokens("http://127.0.0.1:49154/", file)).toThrow("required pet and dashboard scopes");
  expect(readFileSync(file)).toEqual(before);
  const reloaded = new SseTokenStore(file);
  expect(reloaded.getTokenScope("pet")).toBe("read-only");
  expect(reloaded.listIssuedTokens().map((entry) => entry.adapterId)).toEqual(["pet"]);
});
