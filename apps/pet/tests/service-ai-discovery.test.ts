import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_METHODS, type AiProbeResult, type CleanupProvider } from "../src/shared/contracts.ts";
import { AiClient, listModelsAt } from "../src/service/ai.ts";
import { DISCOVERY_CANDIDATES, DISCOVERY_TIMEOUT_MS, discoverAi, type DiscoveryCandidate } from "../src/service/ai-discovery.ts";
import { isCliInstalled, probeCli } from "../src/service/cli.ts";
import { ConfigStore } from "../src/service/config.ts";
import { messages } from "../src/ui/messages.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

// `ai.discover` and the probe `reason` field. Real HTTP servers on loopback stand in for the local AI
// servers; the production candidate list is fixed, so tests point candidates at the fixtures through `deps`.
type Fixture = ReturnType<typeof Bun.serve>;
const fixtures: Fixture[] = [];
function serve(fetch: (request: Request) => Response | Promise<Response>): { baseUrl: string; server: Fixture } {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  fixtures.push(server);
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}
const path = (request: Request) => new URL(request.url).pathname;
const ollama = (names: string[]) => serve((request) => path(request) === "/api/tags" ? Response.json({ models: names.map((name) => ({ name })) }) : new Response("", { status: 404 }));
const openai = (ids: string[]) => serve((request) => path(request) === "/v1/models" ? Response.json({ object: "list", data: ids.map((id) => ({ id })) }) : new Response("", { status: 404 }));
/** A closed loopback port: a server that was listening a moment ago. */
function refusing(): string {
  const { server, baseUrl } = ollama([]);
  server.stop(true);
  return baseUrl;
}
const signal = () => new AbortController().signal;
const never = (_: string) => false;
const candidate = (id: string, provider: DiscoveryCandidate["provider"], baseUrl: string): DiscoveryCandidate => ({ id, provider, baseUrl });

afterAll(() => { for (const server of fixtures) server.stop(true); });

test("the production candidates are the four fixed loopback addresses, in order", () => {
  expect(DISCOVERY_CANDIDATES).toEqual([
    { id: "ollama", provider: "ollama", baseUrl: "http://127.0.0.1:11434" },
    { id: "lm-studio", provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234" },
    { id: "jan", provider: "openai-compatible", baseUrl: "http://127.0.0.1:1337" },
    { id: "llama-cpp", provider: "openai-compatible", baseUrl: "http://127.0.0.1:8080" },
  ]);
  expect(DISCOVERY_TIMEOUT_MS).toBe(2000);
});

test("listModelsAt reads an Ollama and an OpenAI-compatible model list", async () => {
  expect(await listModelsAt("ollama", ollama(["qwen", "llama"]).baseUrl, null, signal(), 2000)).toEqual(["qwen", "llama"]);
  expect(await listModelsAt("openai-compatible", openai(["gpt-local"]).baseUrl, null, signal(), 2000)).toEqual(["gpt-local"]);
});

test("discovery reports the servers that answer with a model list, in candidate order, and omits the rest", async () => {
  const html = serve(() => new Response("<html>not an AI server</html>", { headers: { "content-type": "text/html" } }));
  const wrongShape = serve(() => Response.json({ hello: "world" }));
  const result = await discoverAi(signal(), { cliInstalled: never, candidates: [
    candidate("ollama", "ollama", ollama(["qwen3:8b"]).baseUrl),
    candidate("lm-studio", "openai-compatible", refusing()),
    candidate("jan", "openai-compatible", html.baseUrl),
    candidate("llama-cpp", "openai-compatible", openai(["local-model"]).baseUrl),
    candidate("extra", "openai-compatible", wrongShape.baseUrl),
  ] });
  expect(result.servers.map(({ id, provider, models }) => ({ id, provider, models }))).toEqual([
    { id: "ollama", provider: "ollama", models: ["qwen3:8b"] },
    { id: "llama-cpp", provider: "openai-compatible", models: ["local-model"] },
  ]);
  expect(result.servers[0]!.baseUrl).toStartWith("http://127.0.0.1:");
});

test("a server that answers with an empty model list is still found", async () => {
  const { baseUrl } = openai([]);
  const result = await discoverAi(signal(), { cliInstalled: never, candidates: [candidate("jan", "openai-compatible", baseUrl)] });
  expect(result.servers).toEqual([{ id: "jan", provider: "openai-compatible", baseUrl, models: [] }]);
});

test("discovery sends no credential to a candidate", async () => {
  let authorization: string | null = "unset";
  const { baseUrl } = serve((request) => { authorization = request.headers.get("authorization"); return Response.json({ data: [] }); });
  await discoverAi(signal(), { cliInstalled: never, candidates: [candidate("jan", "openai-compatible", baseUrl)] });
  expect(authorization).toBeNull();
});

test("one hanging candidate cannot hold the whole discovery past the per-candidate timeout", async () => {
  const hang = serve(() => new Promise<Response>(() => {}));
  const started = performance.now();
  const result = await discoverAi(signal(), { cliInstalled: never, timeoutMs: 300, candidates: [
    candidate("lm-studio", "openai-compatible", hang.baseUrl),
    candidate("ollama", "ollama", ollama(["qwen"]).baseUrl),
  ] });
  expect(performance.now() - started).toBeLessThan(1500);
  expect(result.servers.map((server) => server.id)).toEqual(["ollama"]);
});

test("a cancelled discovery is reported as CANCELLED, not as nothing found", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const before = await discoverAi(cancelled.signal, { cliInstalled: never, candidates: [] }).then(() => null, (error: unknown) => error);
  expect(before).not.toBeNull();
  const midway = new AbortController();
  const hang = serve(() => new Promise<Response>(() => {}));
  const pending = discoverAi(midway.signal, { cliInstalled: never, candidates: [candidate("jan", "openai-compatible", hang.baseUrl)] });
  setTimeout(() => midway.abort(), 50);
  expect(await pending.then(() => null, (error: unknown) => error)).toMatchObject({ code: "CANCELLED" });
});

test("discovery reports claude and codex as installed or absent from the injected lookup, in that order", async () => {
  const looked: string[] = [];
  const both = await discoverAi(signal(), { candidates: [], cliInstalled: (provider) => { looked.push(provider); return true; } });
  expect(both).toEqual({ servers: [], clis: [{ provider: "claude", installed: true }, { provider: "codex", installed: true }] });
  expect(looked).toEqual(["claude", "codex"]);
  const onlyCodex = await discoverAi(signal(), { candidates: [], cliInstalled: (provider) => provider === "codex" });
  expect(onlyCodex.clis).toEqual([{ provider: "claude", installed: false }, { provider: "codex", installed: true }]);
});

test("the real executable lookup answers without running anything", () => {
  expect(typeof isCliInstalled("claude")).toBe("boolean");
  expect(typeof isCliInstalled("codex")).toBe("boolean");
});

// --- probe reasons ---------------------------------------------------------------------------------

/** These checks save settings through the real Windows DPAPI vault, one PowerShell process per secret. The first
 * PowerShell start on a fresh hosted runner took over 5s; later ones took about 0.4s. */
const DPAPI_TEST_TIMEOUT_MS = 30_000;

async function probeWith(settings: { ai?: { provider: "ollama" | "openai-compatible"; baseUrl: string; model: string }; cleanupProvider?: CleanupProvider }, target: "answer" | "cleanup" = "answer"): Promise<AiProbeResult> {
  const dir = mkdtempSync(join(tmpdir(), "pet-ai-reason-"));
  try {
    const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
    const baseUrl = settings.ai?.baseUrl ?? "http://127.0.0.1:9";
    await config.save({ connection: { mode: "existing", baseUrl }, token: "authored-test-token",
      ...(settings.ai ? { ai: settings.ai } : {}), ...(settings.cleanupProvider ? { cleanup: { provider: settings.cleanupProvider, model: "" } } : {}) });
    return await new AiClient(config).probe(target, { signal: signal(), progress() {} });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a cleanup check with no cleanup AI chosen is not-configured", async () => {
  expect(await probeWith({}, "cleanup")).toEqual({ available: false, models: [], message: messages.aiService.probe.pickCleanupAi, reason: "not-configured" });
}, DPAPI_TEST_TIMEOUT_MS);

test("a server check without a selected model is model-missing, and lists the models", async () => {
  const { baseUrl } = ollama(["qwen"]);
  expect(await probeWith({ ai: { provider: "ollama", baseUrl, model: "" } })).toEqual({ available: false, models: ["qwen"], message: messages.aiService.modelNeeded, reason: "model-missing" });
}, DPAPI_TEST_TIMEOUT_MS);

test("a server check whose model is not listed is model-missing", async () => {
  const { baseUrl } = ollama(["qwen"]);
  expect(await probeWith({ ai: { provider: "ollama", baseUrl, model: "other" } })).toMatchObject({ available: false, reason: "model-missing", message: messages.aiService.probe.modelNotFound });
}, DPAPI_TEST_TIMEOUT_MS);

test("a server that cannot be reached is connection-failed", async () => {
  expect(await probeWith({ ai: { provider: "ollama", baseUrl: refusing(), model: "qwen" } })).toMatchObject({ available: false, reason: "connection-failed", message: messages.aiService.probe.networkFailed });
}, DPAPI_TEST_TIMEOUT_MS);

test("a server that lists the selected model carries no reason", async () => {
  const { baseUrl } = ollama(["qwen"]);
  const result = await probeWith({ ai: { provider: "ollama", baseUrl, model: "qwen" } });
  expect(result.available).toBe(true);
  expect(result.reason).toBeUndefined();
}, DPAPI_TEST_TIMEOUT_MS);

test("a CLI that is not on PATH is not-installed, with an install text for that CLI, without running anything", async () => {
  for (const provider of ["claude", "codex"] as const) {
    expect(await probeCli(provider, signal(), () => false)).toEqual({ available: false, models: [], message: messages.cleanupService.cli.probeNotInstalled[provider], reason: "not-installed" });
  }
  expect(messages.cleanupService.cli.probeNotInstalled.claude).not.toBe(messages.cleanupService.cli.probeNotInstalled.codex);
});

// --- RPC surface -------------------------------------------------------------------------------------

test("ai.discover is an RPC method and is in the native host's allowlist, which lists the same methods", () => {
  expect(RPC_METHODS).toContain("ai.discover");
  const policy = readFileSync(join(import.meta.dir, "..", "src-tauri", "src", "policy.rs"), "utf8");
  const list = /pub const METHODS: &\[&str\] = &\[([\s\S]*?)\];/.exec(policy)?.[1] ?? "";
  const allowed = [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  expect(allowed).toContain("ai.discover");
  expect([...allowed].sort()).toEqual([...RPC_METHODS].sort());
});
