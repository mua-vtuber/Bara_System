import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAudience } from "../src/shared/contracts.ts";
import { MemoryClient, normalizeMemory, normalizeReceipt, normalizeSearch, requestJson } from "../src/service/client.ts";
import { ConfigStore } from "../src/service/config.ts";
import { rebindSnapshot } from "../src/service/install/connection-policy.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { startListenerProcess } from "./fixtures/loopback-listener.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";
import { messages } from "../src/ui/messages.ts";

/** Real HTTP fixture standing in for `/client-info`, with a fixed body unless a test overrides it. */
function clientInfoFixture(respond: () => Response) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname !== "/client-info") return new Response("", { status: 404 });
    return respond();
  } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

async function realClient(baseUrl: string): Promise<{ client: MemoryClient; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pet-client-test-"));
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
  await config.save({ connection: { mode: "existing", baseUrl }, token: "authored-test-token" });
  return { client: new MemoryClient(config, new CredentialRoutes(new LocalServer())), dir };
}

const PET_INTEGRATION_BODY = JSON.stringify({ protocolVersion: 1, version: "0.9.0",
  captureKinds: ["idea", "decision", "question", "preference", "task"],
  capabilities: ["ingest-receipts", "capture", "memory-deeplink", "cleanup-proposals", "editable-memory-body"] });

test("search response flat rows become cited memories", () => {
  const result = normalizeSearch({ query: "키", results: [{ id: 7, content: "책상 위", memoryType: "fact", metadata: { capture: { kind: "idea", source: "user" } }, score: 0.8 }] }, "키");
  expect(result.results[0]?.memory).toMatchObject({ id: 7, content: "책상 위", metadata: { capture: { kind: "idea", source: "user" } } });
});

test("memory revision is read from server metadata", () => {
  expect(normalizeMemory({ id: 3, content: "one", metadata: { sharedMemory: { revision: 2 } } }).revision).toBe(2);
});

test("server-derived editable content remains separate from the tagged raw text", () => {
  expect(normalizeMemory({ id: 3, content: "본문 #fixture", editableContent: "본문" })).toMatchObject({ content: "본문 #fixture", editableContent: "본문" });
});
test("normalized memory and search hits carry their originating server audience", () => {
  const audience = '{"mode":"existing","origin":"https://one.example","ssh":null}';
  expect(normalizeMemory({ id: 2, content: "one" }, audience).audience).toBe(audience);
  expect(normalizeSearch({ results: [{ id: 2, content: "one" }] }, "one", audience).results[0]?.memory.audience).toBe(audience);
});

test("authenticated local request uses bearer and rejects redirects", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/redirect") return Response.redirect(new URL("/other", request.url));
    return Response.json({ auth: request.headers.get("authorization") });
  } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    expect(await requestJson(base, "secret", "GET", "/ok", undefined, new AbortController().signal)).toEqual({ auth: "Bearer secret" });
    await expect(requestJson(base, "secret", "GET", "/redirect", undefined, new AbortController().signal)).rejects.toThrow();
  } finally { server.stop(true); }
});

test("an absent receipt remains unknown, never proof of a failed save", () => {
  const requestId = "810eb554-6f98-4522-a587-70d6e09d5da1";
  expect(normalizeReceipt({ state: "unknown" }, requestId)).toMatchObject({ state: "unknown", requestId });
  expect(normalizeReceipt({ state: "saved", result: { ok: true, originNodeId: 7 } }, requestId)).toMatchObject({ state: "saved", requestId, resultType: "memory" });
});

test("a bodyless entity-only input (entity_patch) is a normal receipt, not an unknown save", () => {
  const requestId = "810eb554-6f98-4522-a587-70d6e09d5da1";
  expect(normalizeReceipt({ state: "saved", result: { ok: true, type: "entity_patch", originNodeId: null } }, requestId)).toMatchObject({ state: "saved", requestId, resultType: "entity_patch" });
});

test("an older server with no type field still requires a valid integer originNodeId to count as saved", () => {
  const requestId = "810eb554-6f98-4522-a587-70d6e09d5da1";
  expect(normalizeReceipt({ state: "saved", result: { ok: true, originNodeId: null } }, requestId)).toMatchObject({ state: "unknown", requestId });
  expect(normalizeReceipt({ state: "saved", result: { ok: false, type: "entity_patch", originNodeId: null } }, requestId)).toMatchObject({ state: "unknown", requestId });
});

test("ingest error marks only auth and explicit pre-write responses as rejected", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const type = new URL(request.url).searchParams.get("case");
    if (type === "auth") return new Response("", { status: 401 });
    if (type === "prewrite") return new Response("", { status: 503, headers: { "X-Ingest-Retryable": "true" } });
    return new Response("", { status: 409 });
  } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const [path, definite] of [["/ingest?case=auth", true], ["/ingest?case=prewrite", true], ["/ingest?case=conflict", false]] as const) {
      try { await requestJson(base, "token", "POST", path, {}, new AbortController().signal); expect.unreachable(); }
      catch (error) { expect((error as { writeNotStarted?: boolean }).writeNotStarted).toBe(definite); }
    }
  } finally { server.stop(true); }
});

test("a pre-integration server (403 on /client-info) reads as a version mismatch, not a permission error", async () => {
  const info = clientInfoFixture(() => new Response("", { status: 403 }));
  const { client, dir } = await realClient(info.baseUrl);
  try {
    const status = await client.info();
    expect(status).toMatchObject({ connected: false, message: "이 바라 서버는 펫 연동을 지원하지 않는 이전 버전입니다. 펫 연동을 지원하는 버전으로 서버를 업데이트한 뒤 다시 연결해 주세요." });
  } finally { info.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("a pre-integration server (404 on /client-info, full token) reads the same version mismatch as 403", async () => {
  const info = clientInfoFixture(() => new Response("", { status: 404 }));
  const { client, dir } = await realClient(info.baseUrl);
  try {
    const status = await client.info();
    expect(status).toMatchObject({ connected: false, message: "이 바라 서버는 펫 연동을 지원하지 않는 이전 버전입니다. 펫 연동을 지원하는 버전으로 서버를 업데이트한 뒤 다시 연결해 주세요." });
  } finally { info.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("a revoked token (401 on /client-info) stays a distinct auth message, never confused with a version mismatch", async () => {
  const info = clientInfoFixture(() => new Response("", { status: 401 }));
  const { client, dir } = await realClient(info.baseUrl);
  try {
    const status = await client.info();
    expect(status.connected).toBe(false);
    expect(status.message).not.toContain("이전 버전");
    expect(status.message).toContain("토큰");
  } finally { info.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("protocolVersion:1 with a required capability missing gets its own message, distinct from a version mismatch", async () => {
  const body = JSON.stringify({ protocolVersion: 1, capabilities: ["ingest-receipts", "capture"] }); // memory-deeplink missing
  const info = clientInfoFixture(() => new Response(body, { status: 200 }));
  const { client, dir } = await realClient(info.baseUrl);
  try {
    const status = await client.info();
    expect(status.connected).toBe(false);
    expect(status.message).toContain("memory-deeplink");
    expect(status.message).not.toBe("이 바라 서버는 펫 연동을 지원하지 않는 이전 버전입니다. 펫 연동을 지원하는 버전으로 서버를 업데이트한 뒤 다시 연결해 주세요.");
  } finally { info.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("a full pet-integration answer with every required capability connects", async () => {
  const info = clientInfoFixture(() => new Response(PET_INTEGRATION_BODY, { status: 200 }));
  const { client, dir } = await realClient(info.baseUrl);
  try {
    const status = await client.info();
    expect(status).toMatchObject({ connected: true, protocolVersion: 1, serverVersion: "0.9.0",
      capabilities: ["ingest-receipts", "capture", "memory-deeplink", "cleanup-proposals", "editable-memory-body"] });
  } finally { info.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

/** Real HTTP fixture standing in for `/ingest` (+ optional `/ingest/status/:id`, `/memories/:id`). */
function ingestFixture(handlers: { ingest?: () => Response; status?: () => Response; memory?: () => Response }) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/ingest" && request.method === "POST" && handlers.ingest) return handlers.ingest();
    if (pathname.startsWith("/ingest/status/") && handlers.status) return handlers.status();
    if (pathname.startsWith("/memories/") && handlers.memory) return handlers.memory();
    return new Response("", { status: 404 });
  } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

test("save() recognizes a bodyless entity-only input (entity_patch) as saved, not unknown", async () => {
  const fixture = ingestFixture({ ingest: () => Response.json({ ok: true, type: "entity_patch", id: null, originNodeId: null }, { status: 201 }) });
  const { client, dir } = await realClient(fixture.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: fixture.baseUrl });
    const result = await client.save({ content: "#가계부:미용 #금액:28000원", requestId: crypto.randomUUID(), audience }, { signal: new AbortController().signal, progress() {} });
    expect(result).toMatchObject({ state: "saved", resultType: "entity_patch" });
    expect(result.memory).toBeUndefined();
  } finally { fixture.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("re-checking an entity_patch save (status re-check path) never regresses to unknown", async () => {
  const fixture = ingestFixture({
    status: () => Response.json({ state: "saved", result: { ok: true, type: "entity_patch", id: null, originNodeId: null } }),
  });
  const { client, dir } = await realClient(fixture.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: fixture.baseUrl });
    const result = await client.status(crypto.randomUUID(), { signal: new AbortController().signal, progress() {} }, audience);
    expect(result).toMatchObject({ state: "saved", resultType: "entity_patch" });
    expect(result.memory).toBeUndefined();
  } finally { fixture.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

// WP-P2-19: a pending receipt stored before the audience gained its version tag holds the old
// `{mode, origin, ssh}` text with the tunnel's local port in it. After a restart moves the tunnel to a
// new local port (the P1 rebind path), "check save" must still ask the same remote server, and never
// the program now holding the old port; a receipt from another remote server is still refused.
// WP-PFIX-4: the new port's listener is a separate process verified as the port's only owner, the way
// the service verifies its SSH tunnel; once that process is gone nothing is sent at all.
test("a receipt stored with the untagged audience is still checked after the SSH tunnel moves to a new local port", async () => {
  const tunnelEnd = await startListenerProcess({
    "/ingest/status/*": { body: { state: "saved", result: { ok: true, type: "text", originNodeId: 42 } } },
    "/memories/42": { body: { memory: { id: 42, content: "터널 이동 전에 저장한 내용" } } },
  });
  let oldPortHits = 0;
  const oldPortHolder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { oldPortHits++; return new Response("", { status: 404 }); } });
  const dir = mkdtempSync(join(tmpdir(), "pet-client-tunnel-move-"));
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
  const ctx = { signal: new AbortController().signal, progress() {} };
  try {
    const ssh = { host: "a.example.org", port: 22, user: "ubuntu", keyPath: join(dir, "key"), fingerprint: `SHA256:${"A".repeat(43)}`, serverPort: 3001 };
    await config.save({ connection: { mode: "remote", baseUrl: `http://127.0.0.1:${oldPortHolder.port}`, ssh }, token: "authored-test-token" });
    const before = (await config.load()).connection;
    // The exact text an earlier Pet stored with the receipt: its audience formula over the saved settings.
    const storedAudience = JSON.stringify({ mode: before.mode, origin: before.baseUrl, ssh: before.ssh ?? null });
    const moved = { ...before, baseUrl: tunnelEnd.baseUrl };
    await rebindSnapshot(config, await config.snapshot(), moved);
    const routes = new CredentialRoutes(new LocalServer());
    await routes.verifyTunnel(tunnelEnd.process, moved, ctx.signal);
    const client = new MemoryClient(config, routes);
    const result = await client.status(crypto.randomUUID(), ctx, storedAudience);
    expect(result).toMatchObject({ state: "saved", resultType: "memory", audience: connectionAudience((await config.load()).connection) });
    expect(result.memory).toMatchObject({ id: 42, content: "터널 이동 전에 저장한 내용" });
    expect(oldPortHits).toBe(0);
    const otherServer = JSON.stringify({ mode: before.mode, origin: before.baseUrl, ssh: { ...before.ssh!, host: "b.example.org" } });
    await expect(client.status(crypto.randomUUID(), ctx, otherServer)).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    const otherKey = JSON.stringify({ mode: before.mode, origin: before.baseUrl, ssh: { ...before.ssh!, fingerprint: `SHA256:${"B".repeat(43)}` } });
    await expect(client.status(crypto.randomUUID(), ctx, otherKey)).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    await tunnelEnd.stop();
    await expect(client.status(crypto.randomUUID(), ctx, storedAudience)).rejects.toMatchObject({ code: "SSH_TUNNEL_UNVERIFIED" });
    expect(oldPortHits).toBe(0);
  } finally { await tunnelEnd.stop(); oldPortHolder.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("save() still confirms a normal memory save and fetches it (resultType: memory)", async () => {
  const fixture = ingestFixture({
    ingest: () => Response.json({ ok: true, type: "text", originNodeId: 42 }, { status: 201 }),
    memory: () => Response.json({ memory: { id: 42, content: "저장된 내용" } }),
  });
  const { client, dir } = await realClient(fixture.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: fixture.baseUrl });
    const result = await client.save({ content: "저장된 내용", requestId: crypto.randomUUID(), audience }, { signal: new AbortController().signal, progress() {} });
    expect(result).toMatchObject({ state: "saved", resultType: "memory" });
    expect(result.memory).toMatchObject({ id: 42, content: "저장된 내용" });
  } finally { fixture.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

// WP-P2-18: a capture kind the server knows but this Pet does not (a newer server feature) must never
// surface as an input-validation error when reading a memory back -- only the write direction stays strict.
test("client.get() tolerates a capture kind the server knows but this Pet does not (unknownCapture, no throw)", async () => {
  const fixture = ingestFixture({ memory: () => Response.json({ memory: { id: 9, content: "새 분류 기억", metadata: { capture: { kind: "habit", source: "ai" } } } }) });
  const { client, dir } = await realClient(fixture.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: fixture.baseUrl });
    const memory = await client.get(9, { signal: new AbortController().signal, progress() {} }, audience);
    expect(memory.metadata?.capture).toBeUndefined();
    expect(memory.metadata?.unknownCapture).toEqual({ kind: "habit", source: "ai" });
    expect(memory.content).toBe("새 분류 기억");
  } finally { fixture.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("normalizeMemory keeps a known capture kind under capture, never unknownCapture", () => {
  const result = normalizeMemory({ id: 5, content: "아이디어", metadata: { capture: { kind: "idea", source: "user" } } });
  expect(result.metadata?.capture).toEqual({ kind: "idea", source: "user" });
  expect(result.metadata?.unknownCapture).toBeUndefined();
});

test("normalizeMemory reports an unknown capture kind honestly instead of throwing", () => {
  const result = normalizeMemory({ id: 6, content: "새 기능", metadata: { capture: { kind: "habit", source: "user" } } });
  expect(result.metadata?.capture).toBeUndefined();
  expect(result.metadata?.unknownCapture).toEqual({ kind: "habit", source: "user" });
  expect(result.metadata).not.toHaveProperty("capture");
});

// WP-PFIX-1 (P2-18 QA follow-up): a known kind must never be mislabeled "unknown category" just
// because its source is something other than "user"/"ai" -- only the kind decides known vs. unknown.
test("normalizeMemory keeps a known capture kind even when its source is neither user nor ai", () => {
  const result = normalizeMemory({ id: 7, content: "아이디어", metadata: { capture: { kind: "idea", source: "server-internal" } } });
  // `Memory.metadata.capture` is `StoredCapture` (source: string), the read-direction type -- unlike the
  // outgoing `Capture` (source: "user" | "ai") used for save/update params -- so this needs no cast.
  expect(result.metadata?.capture).toEqual({ kind: "idea", source: "server-internal" });
  expect(result.metadata?.unknownCapture).toBeUndefined();
});

// The server's raw source string is preserved verbatim for an unknown kind too, instead of being
// forced to "ai" -- that substitution used to hide what the server actually sent.
test("normalizeMemory preserves an unknown kind's raw source instead of defaulting it to ai", () => {
  const result = normalizeMemory({ id: 8, content: "새 기능", metadata: { capture: { kind: "habit", source: "server-internal" } } });
  expect(result.metadata?.unknownCapture).toEqual({ kind: "habit", source: "server-internal" });
});

// A capture object whose kind or source is not even a string breaks the response contract itself
// (not merely an unrecognized classification), so it surfaces as a server response error instead of
// being silently relabeled "unknown".
test("normalizeMemory rejects a capture object with a non-string kind as a server response error", () => {
  expect(() => normalizeMemory({ id: 9, content: "깨진 응답", metadata: { capture: { kind: 42, source: "ai" } } }))
    .toThrow(expect.objectContaining({ code: "SERVER_RESPONSE" }));
});
test("normalizeMemory rejects a capture object with a non-string source as a server response error", () => {
  expect(() => normalizeMemory({ id: 10, content: "깨진 응답", metadata: { capture: { kind: "idea", source: null } } }))
    .toThrow(expect.objectContaining({ code: "SERVER_RESPONSE" }));
});

// Regression: the outgoing direction (update/save) must still reject an unknown capture kind as this
// Pet's own bug -- WP-P2-18 only relaxed reading a server response, never what this Pet sends.
test("client.update() still rejects an unknown capture kind as invalid input (write direction stays strict)", async () => {
  const fixture = ingestFixture({ memory: () => Response.json({ memory: { id: 9, content: "본문" } }) });
  const { client, dir } = await realClient(fixture.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: fixture.baseUrl });
    await expect(client.update({ id: 9, audience, capture: { kind: "habit" as never, source: "user" } }, { signal: new AbortController().signal, progress() {} }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  } finally { fixture.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("allowedCaptureKinds shares info()'s judgment: a pre-integration 403 is a version mismatch, not FORBIDDEN", async () => {
  const info = clientInfoFixture(() => new Response("", { status: 403 }));
  const { client, dir } = await realClient(info.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: info.baseUrl });
    await expect(client.allowedCaptureKinds({ signal: new AbortController().signal, progress() {} }, audience))
      .rejects.toMatchObject({ code: "SERVER_UPGRADE_REQUIRED", publicMessage: "이 바라 서버는 펫 연동을 지원하지 않는 이전 버전입니다. 펫 연동을 지원하는 버전으로 서버를 업데이트한 뒤 다시 연결해 주세요." });
  } finally { info.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

/** Real HTTP fixture for a memory edit: PATCH and GET on `/memories/9`, each answered by the test, with
 * the requests it received recorded so a test can prove what was (and was not) sent. */
function editFixture(handlers: { patch: (body: Record<string, unknown>) => Response; get: () => Response }) {
  const seen = { patch: [] as unknown[], get: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/memories/9") return new Response("", { status: 404 });
    if (request.method === "PATCH") { const body = await request.json() as Record<string, unknown>; seen.patch.push(body); return handlers.patch(body); }
    if (request.method === "GET") { seen.get++; return handlers.get(); }
    return new Response("", { status: 405 });
  } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}`, seen };
}
const editContext = () => ({ signal: new AbortController().signal, progress() {} });
const rereadMemory = () => Response.json({ memory: { id: 9, content: "고친 본문 #독서", editableContent: "고친 본문", metadata: { sharedMemory: { revision: 4 } } } });

// WP-P2-09 (CC-6): the server's 409 body names which conflict it was and the node's current revision
// (bara routes/memories-edit.ts); both reach the caller instead of being flattened into one fixed text.
test("update() carries the server's CONFLICT code and currentRevision from a 409 body", async () => {
  const fixture = editFixture({ patch: () => Response.json({ code: "CONFLICT", error: "memory changed since it was read", nodeId: 9, currentRevision: 5 }, { status: 409 }), get: rereadMemory });
  const { client, dir } = await realClient(fixture.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: fixture.baseUrl });
    await expect(client.update({ id: 9, audience, content: "고친 본문", expectedRevision: 3 }, editContext()))
      .rejects.toMatchObject({ code: "EDIT_CONFLICT", serverCode: "CONFLICT", currentRevision: 5, publicMessage: messages.memory.editConflict });
    expect(fixture.seen.get).toBe(0);
  } finally { fixture.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("update() tells an AI-over-user classification conflict apart from a stale revision", async () => {
  const fixture = editFixture({ patch: () => Response.json({ code: "CAPTURE_CONFLICT", error: "AI classification cannot replace a user classification", nodeId: 9, currentRevision: 2 }, { status: 409 }), get: rereadMemory });
  const { client, dir } = await realClient(fixture.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: fixture.baseUrl });
    await expect(client.update({ id: 9, audience, expectedRevision: 2, capture: { kind: "idea", source: "ai" } }, editContext()))
      .rejects.toMatchObject({ code: "CAPTURE_CONFLICT", serverCode: "CAPTURE_CONFLICT", currentRevision: 2, publicMessage: messages.memory.captureConflict });
  } finally { fixture.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("a 409 that names no known conflict keeps the generic CONFLICT error", async () => {
  const fixture = editFixture({ patch: () => Response.json({ error: "memory 9 source_type=document is not directly editable; upload searchable text or edit its derived text node instead" }, { status: 409 }), get: rereadMemory });
  const { client, dir } = await realClient(fixture.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: fixture.baseUrl });
    const error = await client.update({ id: 9, audience, content: "고친 본문", expectedRevision: 3 }, editContext()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONFLICT", publicMessage: messages.serverClient.http.conflict });
    expect(error).not.toHaveProperty("serverCode");
  } finally { fixture.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

// The 409 body is read only for 409: every other status keeps its old mapping for all requestJson callers.
test("requestJson reads a conflict body only for 409 and leaves other statuses unchanged", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/bad") return Response.json({ code: "CONFLICT", currentRevision: 5 }, { status: 400 });
    if (pathname === "/plain-conflict") return new Response("not json", { status: 409 });
    return Response.json({ code: "CONFLICT", currentRevision: -1 }, { status: 409 });
  } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const signal = new AbortController().signal;
    const bad = await requestJson(base, "secret", "GET", "/bad", undefined, signal).catch((caught: unknown) => caught);
    expect(bad).toMatchObject({ code: "INVALID_INPUT", publicMessage: messages.serverClient.http.rejectedInput });
    expect(bad).not.toHaveProperty("serverCode");
    expect(bad).not.toHaveProperty("currentRevision");
    const plain = await requestJson(base, "secret", "GET", "/plain-conflict", undefined, signal).catch((caught: unknown) => caught);
    expect(plain).toMatchObject({ code: "CONFLICT", publicMessage: messages.serverClient.http.conflict });
    expect(plain).not.toHaveProperty("serverCode");
    const negative = await requestJson(base, "secret", "GET", "/negative", undefined, signal).catch((caught: unknown) => caught);
    expect(negative).toMatchObject({ code: "CONFLICT", serverCode: "CONFLICT" });
    expect(negative).not.toHaveProperty("currentRevision");
  } finally { server.stop(true); }
});

// WP-P2-09 (CC-3 root cause): the PATCH answer is the raw node without `editableContent`; handing it back
// when the re-read fails let the editor send the tagged original as the next body.
test("a failed re-read after a successful PATCH is an error that says the edit was saved, never the PATCH body", async () => {
  const fixture = editFixture({ patch: () => Response.json({ changed: true, memory: { id: 9, content: "고친 본문 #독서", metadata: { sharedMemory: { revision: 4 } } }, revision: 4, warnings: [] }),
    get: () => new Response("", { status: 500 }) });
  const { client, dir } = await realClient(fixture.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: fixture.baseUrl });
    await expect(client.update({ id: 9, audience, content: "고친 본문", expectedRevision: 3 }, editContext()))
      .rejects.toMatchObject({ code: "EDIT_REREAD_FAILED", publicMessage: messages.memory.editRereadFailed("서버 요청이 실패했습니다 (500).") });
    expect(fixture.seen.patch).toHaveLength(1);
    expect(fixture.seen.get).toBe(1);
  } finally { fixture.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

// WP-PFIX-2: a 2xx PATCH means the server saved the edit, so a malformed PATCH answer is the same
// "saved, reload to check" case as a failed re-read -- never a bare SERVER_RESPONSE that reads as a failed save.
test("a malformed answer to a successful PATCH says the edit was saved and asks for a reload", async () => {
  const fixture = editFixture({ patch: () => Response.json({ changed: true, memory: { id: "nine" } }), get: rereadMemory });
  const { client, dir } = await realClient(fixture.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: fixture.baseUrl });
    await expect(client.update({ id: 9, audience, content: "고친 본문", expectedRevision: 3 }, editContext()))
      .rejects.toMatchObject({ code: "EDIT_REREAD_FAILED", publicMessage: messages.memory.editRereadFailed(messages.serverClient.memoryUnreadable) });
    expect(fixture.seen.patch).toHaveLength(1);
  } finally { fixture.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("a successful update() returns the re-read memory with its tag-free body and sends the caller's revision", async () => {
  const fixture = editFixture({ patch: () => Response.json({ changed: true, memory: { id: 9, content: "고친 본문 #독서" }, revision: 4, warnings: [] }), get: rereadMemory });
  const { client, dir } = await realClient(fixture.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: fixture.baseUrl });
    const updated = await client.update({ id: 9, audience, content: "고친 본문", expectedRevision: 3 }, editContext());
    expect(updated).toMatchObject({ id: 9, content: "고친 본문 #독서", editableContent: "고친 본문", revision: 4 });
    expect(fixture.seen.patch).toEqual([{ content: "고친 본문", expectedRevision: 3 }]);
  } finally { fixture.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("a capture-only AI update leaves edit actor attribution to the server and returns the re-read classification", async () => {
  const memory = { id: 9, content: "나는 조용한 카페가 좋아", metadata: { sharedMemory: { revision: 4 }, capture: { kind: "preference", source: "ai" } } };
  const fixture = editFixture({
    patch: (body) => {
      // Adapter tokens may edit a memory, but cannot choose the audited actor or edit source.
      if (["editor", "editSource", "source"].some((key) => key in body)) return Response.json({ error: "edit actor metadata requires full scope" }, { status: 403 });
      return Response.json({ changed: true, memory, revision: 4, warnings: [] });
    },
    get: () => Response.json({ memory: { ...memory, editableContent: "나는 조용한 카페가 좋아" } }),
  });
  const { client, dir } = await realClient(fixture.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: fixture.baseUrl });
    const updated = await client.update({ id: 9, audience, expectedRevision: 3, capture: { kind: "preference", source: "ai" } }, editContext());
    expect(updated).toMatchObject({ id: 9, editableContent: "나는 조용한 카페가 좋아", revision: 4, metadata: { capture: { kind: "preference", source: "ai" } } });
    expect(fixture.seen.patch).toEqual([{ expectedRevision: 3, capture: { kind: "preference", source: "ai" } }]);
    expect(fixture.seen.get).toBe(1);
  } finally { fixture.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

// Reading the latest revision and sending it back would make the server's stale-edit check always pass.
test("update() without expectedRevision is refused before any request, never filled in from a fresh read", async () => {
  const fixture = editFixture({ patch: () => Response.json({ changed: true, memory: { id: 9, content: "고친 본문" } }), get: rereadMemory });
  const { client, dir } = await realClient(fixture.baseUrl);
  try {
    const audience = connectionAudience({ mode: "existing", baseUrl: fixture.baseUrl });
    await expect(client.update({ id: 9, audience, content: "고친 본문" }, editContext()))
      .rejects.toMatchObject({ code: "INVALID_INPUT", publicMessage: messages.memory.editRevisionMissing });
    expect(fixture.seen.patch).toHaveLength(0);
    expect(fixture.seen.get).toBe(0);
  } finally { fixture.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
