import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { probeCli, runCliJson, type CliProvider } from "../src/service/cli.ts";
import { ServiceError } from "../src/service/errors.ts";
import { messages } from "../src/ui/messages.ts";
import type { CliProbeResponse } from "./fixtures/cli-probe.ts";

// Real Bun subprocesses on Windows and POSIX. Sequential tests isolate PATH from installed user CLIs.
const claudeFlags = "--safe-mode --tools --strict-mcp-config --json-schema --no-session-persistence";
const codexFlags = "--disable --ignore-user-config --ignore-rules --ephemeral --output-schema";
const goodFeatures = "shell_tool stable true\nskip_host_skill_discovery experimental false\nhooks stable false";

let binDir = "";
let savedPath: string | undefined;

beforeEach(async () => {
  binDir = await mkdtemp(join(tmpdir(), "bara-pet-cli-fixture-"));
  savedPath = process.env.PATH;
  const systemPath = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin";
  process.env.PATH = `${binDir}${delimiter}${systemPath}`;
});

afterEach(async () => {
  if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  await rm(binDir, { recursive: true, force: true });
});

async function cliFixture(provider: CliProvider, responses: Record<string, CliProbeResponse>): Promise<void> {
  const configPath = join(binDir, `${provider}.json`);
  await writeFile(configPath, JSON.stringify(responses));
  const command = [process.execPath, join(import.meta.dir, "fixtures", "cli-probe.ts"), configPath];
  const path = join(binDir, process.platform === "win32" ? `${provider}.cmd` : provider);
  const script = process.platform === "win32"
    ? `@echo off\r\n${command.map((part) => `"${part}"`).join(" ")} %*\r\nexit /b %errorlevel%\r\n`
    : `#!/bin/sh\nexec ${command.map((part) => `'${part.replaceAll("'", "'\"'\"'")}'`).join(" ")} "$@"\n`;
  await writeFile(path, script);
  if (process.platform !== "win32") await chmod(path, 0o755);
}

function codexFixture(opts: { help?: string; features?: string; loginExit?: number } = {}): Promise<void> {
  const { help = codexFlags, features = goodFeatures, loginExit = 0 } = opts;
  return cliFixture("codex", { exec: { stdout: help }, features: { stdout: features }, login: { exitCode: loginExit } });
}

function claudeFixture(auth: string, exitCode = 0): Promise<void> {
  return cliFixture("claude", { "--help": { stdout: claudeFlags }, auth: { stdout: auth, exitCode } });
}

test("a good codex is available", async () => {
  await codexFixture();
  const result = await probeCli("codex", new AbortController().signal);
  expect(result).toEqual({ available: true, models: [], message: messages.cleanupService.cli.probeAvailable.codex });
});

test("codex whose login status exits 1 needs a login", async () => {
  await codexFixture({ loginExit: 1 });
  const result = await probeCli("codex", new AbortController().signal);
  expect(result.available).toBe(false);
  expect(result.reason).toBe("login-required");
  expect(result.message).toBe(messages.cleanupService.cli.probeCodexLogin);
});

test("codex help without the safety flags is an unsafe version", async () => {
  await codexFixture({ help: "--disable --ephemeral" });
  const result = await probeCli("codex", new AbortController().signal);
  expect(result.available).toBe(false);
  expect(result.reason).toBe("unsafe-version");
  expect(result.message).toBe(messages.cleanupService.cli.probeUnsafeVersion);
});

test("codex features list without the required lines is an unsafe version", async () => {
  for (const features of ["shell_tool stable false\nskip_host_skill_discovery x\nhooks y", "shell_tool stable true\nhooks y", "shell_tool stable true\nskip_host_skill_discovery x"]) {
    await codexFixture({ features });
    const result = await probeCli("codex", new AbortController().signal);
    expect(result.reason).toBe("unsafe-version");
    expect(result.message).toBe(messages.cleanupService.cli.probeCodexRestrictionUnconfirmed);
  }
});

test("a good claude is available", async () => {
  await claudeFixture('{"loggedIn":true}');
  const result = await probeCli("claude", new AbortController().signal);
  expect(result).toEqual({ available: true, models: [], message: messages.cleanupService.cli.probeAvailable.claude });
});

test.each([0, 1])("claude logged-out JSON with exit %i needs a login", async (exitCode) => {
  await claudeFixture('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}', exitCode);
  const result = await probeCli("claude", new AbortController().signal);
  expect(result.available).toBe(false);
  expect(result.reason).toBe("login-required");
  expect(result.message).toBe(messages.cleanupService.cli.probeClaudeLogin);
});

test.each(['{"loggedIn":true}', "not json", "{}"])("claude exit 1 without confirmed logged-out JSON (%s) is a failed connection", async (auth) => {
  await claudeFixture(auth, 1);
  const result = await probeCli("claude", new AbortController().signal);
  expect(result.available).toBe(false);
  expect(result.reason).toBe("connection-failed");
  expect(result.message).toBe(messages.cleanupService.cli.probeUnavailable);
});

test("a CLI that exits nonzero on --help is a failed connection even with usable stdout", async () => {
  await cliFixture("claude", { "--help": { stdout: claudeFlags, exitCode: 1 } });
  const result = await probeCli("claude", new AbortController().signal);
  expect(result.available).toBe(false);
  expect(result.reason).toBe("connection-failed");
  expect(result.message).toBe(messages.cleanupService.cli.probeUnavailable);
});

test("an unreadable claude auth status is a failed connection", async () => {
  await claudeFixture("not json");
  const result = await probeCli("claude", new AbortController().signal);
  expect(result.reason).toBe("connection-failed");
});

test("a nonzero cleanup command still rejects valid JSON without exposing CLI output", async () => {
  await cliFixture("claude", { "--print": { stdout: '{"type":"result","structured_output":{"secret":"fixture-private-value"}}', stderr: "fixture-private-error", exitCode: 1 } });
  const error = await runCliJson("claude", "fixture prompt", {}, "", new AbortController().signal).then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe("CLI_FAILED");
  expect((error as ServiceError).publicMessage).toBe(messages.cleanupService.cli.failed);
  expect(JSON.stringify(error)).not.toContain("fixture-private");
});

test("claude auth output stays bounded even when it exits 1", async () => {
  await claudeFixture(`${" ".repeat(100_001)}{"loggedIn":false}`, 1);
  const result = await probeCli("claude", new AbortController().signal);
  expect(result.reason).toBe("connection-failed");
});

test("a probe aborted during Claude auth rejects with CANCELLED", async () => {
  const startedFile = join(binDir, "auth-started");
  await cliFixture("claude", { "--help": { stdout: claudeFlags }, auth: { stdout: '{"loggedIn":false}', exitCode: 1, delayMs: 30_000, startedFile } });
  const controller = new AbortController();
  const started = Date.now();
  const probe = probeCli("claude", controller.signal).then(() => undefined, (caught: unknown) => caught);
  try {
    while (!await Bun.file(startedFile).exists() && Date.now() - started < 5_000) await Bun.sleep(10);
    expect(await Bun.file(startedFile).exists()).toBe(true);
  } finally { controller.abort(); }
  const error = await probe;
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe("CANCELLED");
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("a Claude auth timeout remains a failed connection", async () => {
  await cliFixture("claude", { "--help": { stdout: claudeFlags }, auth: { stdout: '{"loggedIn":false}', exitCode: 1, delayMs: 30_000 } });
  const result = await probeCli("claude", new AbortController().signal);
  expect(result.reason).toBe("connection-failed");
}, 20_000);

test("a probe whose signal is already aborted rejects with CANCELLED without running the CLI", async () => {
  await codexFixture();
  const controller = new AbortController();
  controller.abort();
  const error = await probeCli("codex", controller.signal).then(() => undefined, (caught: unknown) => caught);
  expect((error as ServiceError).code).toBe("CANCELLED");
});

test("a missing CLI is not installed", async () => {
  const result = await probeCli("claude", new AbortController().signal);
  expect(result.reason).toBe("not-installed");
});
