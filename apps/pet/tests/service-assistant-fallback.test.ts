import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAudience, type RequestContext } from "../src/shared/contracts.ts";
import { Assistant } from "../src/service/assistant.ts";
import { MemoryClient } from "../src/service/client.ts";
import { ConfigStore } from "../src/service/config.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

// When the answer AI fails, `Assistant.ask` still hands back the memories the search found, and never
// reports the result as an AI-generated answer. These tests check only that contract (`generated`,
// `sources`), not the wording of the failure text, which has its own tests in service-assistant.test.ts.
// Both servers are real loopback HTTP servers; the memory server answers real search rows.

const windowsOnly = test.skipIf(process.platform !== "win32");
const ctx = (): RequestContext => ({ signal: new AbortController().signal, progress() {} });

const FOUND = [
  { id: 11, content: "테스트용 무지개 항성지도는 보라색 보관함에 있다." },
  { id: 12, content: "테스트용 별자리 기록지는 파란 서랍에 있다." },
];
const QUESTION = "무지개 항성지도는 어디에 있나?";

function memoryServer() {
  const seen = { search: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.method === "POST" && new URL(request.url).pathname === "/search") { seen.search++; return Response.json({ results: FOUND }); }
    return new Response("", { status: 404 });
  } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}`, seen };
}

/** An Ollama-shaped AI server: `/api/chat` answers with whatever `reply` returns. */
function aiServer(reply: () => Response) {
  const seen = { chat: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.method === "POST" && new URL(request.url).pathname === "/api/chat") { seen.chat++; return reply(); }
    return new Response("", { status: 404 });
  } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}`, seen };
}

/** A loopback address no program listens on: a real server that has been stopped. */
function unusedAddress(): string {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const baseUrl = `http://127.0.0.1:${listener.port}`;
  listener.stop(true);
  return baseUrl;
}

async function assistantFor(memoryBaseUrl: string, aiBaseUrl: string, dir: string): Promise<{ assistant: Assistant; audience: string }> {
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
  const settings = await config.save({ connection: { mode: "existing", baseUrl: memoryBaseUrl }, token: "authored-test-token",
    ai: { provider: "ollama", baseUrl: aiBaseUrl, model: "authored-fixture" } });
  return { assistant: new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer()))), audience: connectionAudience(settings.connection) };
}

const failures: Array<[string, () => Response]> = [
  ["the AI server answers 500", () => new Response("", { status: 500 })],
  ["the AI cites a memory the search never returned", () => Response.json({ message: { content: '{"answer":"근거 없는 답","sourceIds":[999]}' } })],
];

for (const [name, reply] of failures) {
  windowsOnly(`${name}: ask returns every found memory as a source and is not a generated answer`, async () => {
    const memory = memoryServer();
    const ai = aiServer(reply);
    const dir = mkdtempSync(join(tmpdir(), "pet-assistant-fallback-"));
    try {
      const { assistant, audience } = await assistantFor(memory.baseUrl, ai.baseUrl, dir);
      const answer = await assistant.ask(QUESTION, ctx(), audience);
      expect(answer.generated).toBe(false);
      expect(answer.outcome).toBe("aiFailed");
      expect(answer.sources.map((source) => source.id)).toEqual(FOUND.map((row) => row.id));
      expect(answer.sources.map((source) => source.content)).toEqual(FOUND.map((row) => row.content));
      expect(answer.audience).toBe(audience);
      expect(memory.seen.search).toBe(1);
      expect(ai.seen.chat).toBe(1); // the failure came from a real AI call, not from skipping it
    } finally { memory.server.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
}

windowsOnly("an AI server nobody listens on: ask returns every found memory as a source and is not a generated answer", async () => {
  const memory = memoryServer();
  const dir = mkdtempSync(join(tmpdir(), "pet-assistant-fallback-"));
  try {
    const { assistant, audience } = await assistantFor(memory.baseUrl, unusedAddress(), dir);
    const answer = await assistant.ask(QUESTION, ctx(), audience);
    expect(answer.generated).toBe(false);
    expect(answer.outcome).toBe("aiFailed");
    expect(answer.sources.map((source) => source.id)).toEqual(FOUND.map((row) => row.id));
    expect(memory.seen.search).toBe(1);
  } finally { memory.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// The same wiring with a well-formed, grounded AI answer is the contrast: here `generated` is true and
// only the memory the AI cited remains a source, so the tests above cannot pass by never reaching the AI.
windowsOnly("a grounded AI answer is generated and keeps only the cited memory as its source", async () => {
  const memory = memoryServer();
  const ai = aiServer(() => Response.json({ message: { content: '{"answer":"보라색 보관함에 있습니다.","sourceIds":[11]}' } }));
  const dir = mkdtempSync(join(tmpdir(), "pet-assistant-fallback-"));
  try {
    const { assistant, audience } = await assistantFor(memory.baseUrl, ai.baseUrl, dir);
    const answer = await assistant.ask(QUESTION, ctx(), audience);
    expect(answer.generated).toBe(true);
    expect(answer.text).toBe("보라색 보관함에 있습니다.");
    expect(answer.sources.map((source) => source.id)).toEqual([11]);
    expect(ai.seen.chat).toBe(1);
  } finally { memory.server.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
