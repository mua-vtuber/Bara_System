import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SseTokenStore } from "../../memory/src/federation/sse-tokens.ts";
import { HEALTH_PROBE_TIMEOUT_MS, prepareClientTokens } from "./client-token.ts";
import { CLIENT_TOKEN_ERRORS, CLIENT_TOKEN_FALLBACK_LINE, clientTokenErrorCode, clientTokenErrorLine,
  type ClientTokenErrorCode } from "./client-token-errors.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bara-client-token-errors-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CLI = join(import.meta.dir, "client-token.ts");

function runCli(args: string[]): { exitCode: number | null; stderr: string; stdout: string } {
  const child = Bun.spawnSync([process.execPath, "run", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: child.exitCode, stderr: new TextDecoder().decode(child.stderr), stdout: new TextDecoder().decode(child.stdout) };
}

test("every known line maps to its own code, also with the line ending the CLI writes", () => {
  for (const [code, line] of Object.entries(CLIENT_TOKEN_ERRORS) as [ClientTokenErrorCode, string][]) {
    expect(clientTokenErrorCode(line)).toBe(code);
    expect(clientTokenErrorCode(`${line}\n`)).toBe(code);
    expect(clientTokenErrorCode(`${line}\r\n`)).toBe(code);
  }
  expect(new Set(Object.values(CLIENT_TOKEN_ERRORS)).size).toBe(Object.keys(CLIENT_TOKEN_ERRORS).length);
});

test("the fallback line, more than one line, a partial line or anything else maps to no code", () => {
  const line = CLIENT_TOKEN_ERRORS.CLIENT_TOKEN_STOP_UNCONFIRMED;
  for (const output of [CLIENT_TOKEN_FALLBACK_LINE, "", "\n", `${line}\n${line}\n`, `warning: something\n${line}\n`,
    `${line} (extra)`, line.slice(0, -1), `Error: ${line}`, line.toUpperCase()])
    expect(clientTokenErrorCode(output)).toBeUndefined();
});

test("the CLI line is the error's own message only when it is a known one", () => {
  expect(clientTokenErrorLine(new Error(CLIENT_TOKEN_ERRORS.CLIENT_TOKEN_FILE_MISSING))).toBe(CLIENT_TOKEN_ERRORS.CLIENT_TOKEN_FILE_MISSING);
  expect(clientTokenErrorLine(new Error("ENOENT: C:\\Users\\someone\\secret.json"))).toBe(CLIENT_TOKEN_FALLBACK_LINE);
  expect(clientTokenErrorLine("not an error")).toBe(CLIENT_TOKEN_FALLBACK_LINE);
});

/** A loopback listener that accepts connections and never answers, so `/health` can only time out. */
async function silentListener(): Promise<{ server: Server; port: number }> {
  const server = createServer(() => { /* accept and stay silent */ });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener has no port");
  return { server, port: address.port };
}

test("what the real CLI prints for each refusal maps back to that refusal's code", async () => {
  const fresh = join(dir, "fresh.json");
  const expectCode = (args: string[], code: ClientTokenErrorCode) => {
    const result = runCli(args);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(clientTokenErrorCode(result.stderr)).toBe(code);
  };
  expectCode(["--url", "http://127.0.0.1:49155/", "--tokens-file", fresh], "CLIENT_TOKEN_USAGE");
  expectCode(["--url", "http://127.0.0.1:49155/", "--tokens-file", "relative.json", "--fresh"], "CLIENT_TOKEN_PATH_NOT_ABSOLUTE");
  expectCode(["--url", "http://example.com/", "--tokens-file", fresh, "--fresh"], "CLIENT_TOKEN_URL_INVALID");
  expectCode(["--url", "http://127.0.0.1:49155/", "--tokens-file", fresh, "--read-existing"], "CLIENT_TOKEN_FILE_MISSING");

  const existing = join(dir, "existing.json");
  writeFileSync(existing, "null");
  expectCode(["--url", "http://127.0.0.1:49155/", "--tokens-file", existing, "--fresh"], "CLIENT_TOKEN_FILE_EXISTS");
  expectCode(["--url", "http://127.0.0.1:49155/", "--tokens-file", existing, "--read-existing"], "CLIENT_TOKEN_FILE_INVALID");

  const partial = join(dir, "partial.json");
  new SseTokenStore(partial).issueToken("pet", undefined, undefined, "read-only");
  expectCode(["--url", "http://127.0.0.1:49155/", "--tokens-file", partial, "--read-existing"], "CLIENT_TOKEN_SCOPES_MISSING");

  const answering = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
  try {
    const result = Bun.spawn([process.execPath, "run", CLI, "--url", `http://127.0.0.1:${answering.port}/`, "--tokens-file", fresh, "--fresh"],
      { stdout: "pipe", stderr: "pipe" });
    expect(await result.exited).toBe(1);
    expect(clientTokenErrorCode(await new Response(result.stderr).text())).toBe("CLIENT_TOKEN_SERVER_RESPONDING");
  } finally { answering.stop(true); }

  // A failure outside the known set (here an unknown option) prints the fallback line, which maps to nothing.
  const unknown = runCli(["--url", "http://127.0.0.1:49155/", "--tokens-file", fresh, "--fresh", "--bogus"]);
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr.trim()).toBe(CLIENT_TOKEN_FALLBACK_LINE);
  expect(clientTokenErrorCode(unknown.stderr)).toBeUndefined();
}, 30_000);

test("a port that accepts but never answers within the probe time is reported as unconfirmed by the CLI", async () => {
  const { server, port } = await silentListener();
  try {
    const started = Date.now();
    const child = Bun.spawn([process.execPath, "run", CLI, "--url", `http://127.0.0.1:${port}/`,
      "--tokens-file", join(dir, "silent.json"), "--fresh"], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    expect(clientTokenErrorCode(await new Response(child.stderr).text())).toBe("CLIENT_TOKEN_STOP_UNCONFIRMED");
    // The wait is the named probe time, not the old one second.
    expect(Date.now() - started).toBeGreaterThanOrEqual(HEALTH_PROBE_TIMEOUT_MS);
  } finally { server.close(); }
}, HEALTH_PROBE_TIMEOUT_MS + 15_000);

test("the health probe outlasts Windows' slow refusal of a closed loopback port", () => {
  // Windows refuses a connect to a closed port only after about 2 seconds; the probe must not give up before that.
  expect(HEALTH_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(4_000);
});

test("a server answering after the old one-second limit still counts as responding", async () => {
  const slow = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => { await Bun.sleep(1_500); return Response.json({ ok: true }); } });
  try {
    const file = join(dir, "slow.json");
    await expect(prepareClientTokens(`http://127.0.0.1:${slow.port}/`, file))
      .rejects.toThrow(CLIENT_TOKEN_ERRORS.CLIENT_TOKEN_SERVER_RESPONDING);
    expect(Bun.file(file).size).toBe(0);
  } finally { slow.stop(true); }
}, 10_000);
