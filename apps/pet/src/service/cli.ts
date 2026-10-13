import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AiProbeReason, AiProbeResult } from "../shared/contracts.ts";
import { messages } from "../ui/messages.ts";
import { ServiceError, serviceError } from "./errors.ts";

export type CliProvider = "claude" | "codex";
const MAX_OUTPUT = 100_000;
const BASE_ENV = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "LANG"] as const;
const allowEnv = (): Record<string, string> => Object.fromEntries(BASE_ENV.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));

/** Whether `provider`'s executable resolves on the same PATH the launcher hands the CLI (`allowEnv`); on Windows
 * `Bun.which` resolves executable extensions such as .exe/.cmd/.bat. Nothing is run and no login is checked. */
export function isCliInstalled(provider: CliProvider): boolean {
  return Bun.which(provider, { PATH: allowEnv().PATH ?? "" }) !== null;
}

export function cliArgs(provider: CliProvider, model: string, schemaPath: string): string[] {
  if (provider === "claude") return ["--print", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--permission-prompts", "none", "--output-format", "json", "--json-schema", schemaPath, ...(model ? ["--model", model] : [])];
  return ["--disable", "shell_tool", "--disable", "code_mode", "--disable", "code_mode_host", "--disable", "tool_call_mcp_elicitation", "--disable", "browser_use", "--disable", "browser_use_external", "--disable", "browser_use_full_cdp_access", "--disable", "computer_use", "--disable", "apps", "--disable", "plugins", "--disable", "skill_search", "--disable", "hooks", "--enable", "skip_host_skill_discovery", "--strict-config", "-c", 'web_search="disabled"', "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--output-schema", schemaPath, ...(model ? ["--model", model] : []), "-"];
}

export function parseCliOutput(provider: CliProvider, text: string): Record<string, unknown> {
  let envelope: unknown;
  try { envelope = JSON.parse(text); } catch { throw serviceError("CLI_RESPONSE", messages.cleanupService.cli.responseUnreadable); }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw serviceError("CLI_RESPONSE", messages.cleanupService.cli.responseUnreadable);
  const data = envelope as Record<string, unknown>;
  if (provider === "claude") {
    if (data.type !== "result" || data.is_error === true) throw serviceError("CLI_RESPONSE", messages.cleanupService.cli.claudeResponseUnconfirmed);
    if (data.structured_output && typeof data.structured_output === "object" && !Array.isArray(data.structured_output)) return data.structured_output as Record<string, unknown>;
    if (typeof data.result === "string") return parseObject(data.result);
    throw serviceError("CLI_RESPONSE", messages.cleanupService.cli.claudeStructuredMissing);
  }
  return data;
}

function parseObject(text: string): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch {}
  throw serviceError("CLI_RESPONSE", messages.cleanupService.modelJsonUnreadable);
}

async function killTree(proc: Bun.Subprocess): Promise<void> {
  if (process.platform === "win32" && proc.pid) {
    try { const killer = Bun.spawn(["taskkill.exe", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", env: allowEnv() }); await killer.exited; return; } catch {}
  }
  proc.kill();
}

async function boundedOutput(stream: ReadableStream<Uint8Array>, proc: Bun.Subprocess): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_OUTPUT) { await killTree(proc); throw serviceError("CLI_OUTPUT_LIMIT", messages.cleanupService.cli.outputTooLarge); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function launch(command: string[], cwd: string, prompt: string, signal: AbortSignal, timeoutMs: number, acceptedExitCodes: readonly number[] = [0]): Promise<{ output: string; exitCode: number }> {
  if (signal.aborted) throw serviceError("CANCELLED", messages.cleanupService.cancelled);
  const proc = Bun.spawn(command, { cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore", env: allowEnv(), windowsHide: true });
  const onAbort = () => { void killTree(proc); };
  signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void killTree(proc); }, timeoutMs);
  try {
    proc.stdin.write(prompt);
    proc.stdin.end();
    const output = await boundedOutput(proc.stdout, proc);
    const exitCode = await proc.exited;
    if (signal.aborted) throw serviceError("CANCELLED", messages.cleanupService.cancelled);
    if (timedOut) throw serviceError("CLI_TIMEOUT", messages.cleanupService.cli.timeout);
    if (!acceptedExitCodes.includes(exitCode)) throw serviceError("CLI_FAILED", messages.cleanupService.cli.failed);
    return { output, exitCode };
  } finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
}

/** CLI receives only the candidate fixture on stdin, never a token or server URL. */
export async function runCliJson(provider: CliProvider, prompt: string, schema: Record<string, unknown>, model: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, "bara-pet-cleanup-"));
  if (!resolve(directory).startsWith(`${tempRoot}${sep}`)) throw serviceError("CLI_DIR", messages.cleanupService.cli.tempDirFailed);
  const schemaPath = join(directory, "schema.json");
  const outputPath = join(directory, "result.json");
  try {
    await writeFile(schemaPath, JSON.stringify(schema), { encoding: "utf8", mode: 0o600 });
    const args = cliArgs(provider, model, provider === "claude" ? JSON.stringify(schema) : schemaPath);
    if (provider === "codex") args.splice(args.length - 1, 0, "--output-last-message", outputPath);
    const { output } = await launch([provider, ...args], directory, prompt, signal, 90_000);
    if (provider === "codex") return parseCliOutput("codex", await readFile(outputPath, "utf8"));
    return parseCliOutput("claude", output);
  } catch (error) {
    if (error instanceof Error && "publicMessage" in error) throw error;
    throw serviceError("CLI_UNAVAILABLE", messages.cleanupService.cli.launchFailed);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function probeCli(provider: CliProvider, signal: AbortSignal, installed: (provider: CliProvider) => boolean = isCliInstalled): Promise<AiProbeResult> {
  const fail = (message: string, reason: AiProbeReason): AiProbeResult => ({ available: false, models: [], message, reason });
  if (!installed(provider)) return fail(messages.cleanupService.cli.probeNotInstalled[provider], "not-installed");
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, "bara-pet-probe-"));
  if (!resolve(directory).startsWith(`${tempRoot}${sep}`)) return fail(messages.cleanupService.cli.probeTempDirFailed, "connection-failed");
  try {
    const help = (await launch([provider, provider === "claude" ? "--help" : "exec", ...(provider === "codex" ? ["--help"] : [])], directory, "", signal, 10_000)).output;
    const flags = provider === "claude" ? ["--safe-mode", "--tools", "--strict-mcp-config", "--json-schema", "--no-session-persistence"] : ["--disable", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--output-schema"];
    if (flags.some((flag) => !help.includes(flag))) return fail(messages.cleanupService.cli.probeUnsafeVersion, "unsafe-version");
    if (provider === "codex") {
      const features = (await launch(["codex", "features", "list"], directory, "", signal, 10_000)).output;
      if (!/^shell_tool\s+stable\s+true/m.test(features) || !features.includes("skip_host_skill_discovery") || !features.includes("hooks")) return fail(messages.cleanupService.cli.probeCodexRestrictionUnconfirmed, "unsafe-version");
      // Codex prints its login status to stderr on Windows. launch rejects a nonzero exit, which is what a logged-out Codex returns.
      try { await launch(["codex", "login", "status"], directory, "", signal, 10_000); }
      catch (error) { if (error instanceof ServiceError && error.code === "CLI_FAILED") return fail(messages.cleanupService.cli.probeCodexLogin, "login-required"); throw error; }
    } else {
      // Claude reports a logged-out status as JSON with exit 1. That exit is usable only with an explicit loggedIn: false.
      const result = await launch(["claude", "auth", "status"], directory, "", signal, 10_000, [0, 1]);
      const auth = parseObject(result.output);
      if (result.exitCode !== 0 && auth.loggedIn !== false) throw serviceError("CLI_FAILED", messages.cleanupService.cli.failed);
      if (auth.loggedIn !== true) return fail(messages.cleanupService.cli.probeClaudeLogin, "login-required");
    }
    return { available: true, models: [], message: messages.cleanupService.cli.probeAvailable[provider] };
  } catch (error) {
    // A cancelled check is not a failed connection: it propagates, as AiClient.probe expects. launch reports an aborted signal as CANCELLED once the killed process exits.
    if (error instanceof ServiceError && error.code === "CANCELLED") throw error;
    if (signal.aborted) throw serviceError("CANCELLED", messages.cleanupService.cancelled);
    return fail(messages.cleanupService.cli.probeUnavailable, "connection-failed");
  }
  finally { await rm(directory, { recursive: true, force: true }); }
}
