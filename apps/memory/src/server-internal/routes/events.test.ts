/**
 * server-internal/routes/events.test.ts — SSE 스트림 + 폴백 목록 + event-bus 통합 검증
 * (Phase 7 2차 Task 3).
 *
 * 검증 정신: *라우트 토큰 게이트 + SSE 헤더 + Last-Event-ID 이어받기 + emit fan-out +
 * 연결 격리*. 실 :memory: SQLite + 실 EventRepository + 실 SseTokenStore + 실 EventBus +
 * 실 Hono app — mock 클래스 0(인터페이스 가짜 구현체 안 만든다 / CLAUDE.md 테스트 정책).
 *
 * SseTokenStore 는 파일 보관이라 테스트마다 임시 경로를 쓴다(실 발급·검증).
 *
 * DB 준비 — events 테이블은 sqlite-vec 와 무관한 일반 테이블이다. 그래서 여기서는
 * openMemoryDatabase(vec_nodes 확장 로드 → 로컬 WSL 의 Windows용 node_modules 에서
 * vec0.so 미스매치로 깨짐)를 거치지 않고, bun:sqlite Database 를 직접 열어 기준 스키마의
 * events DDL 만 적용한다. 이러면 로컬에서도 실 SQLite + 실 EventRepository 로 검증된다
 * (mock 클래스 0 — 실 구현체만). 운영 경로(openMemoryDatabase 가 기준 스키마로
 * events 를 만드는 경로)의 검증은 T1 event-repository.test.ts + baseline-schema.assets-cleanup.test.ts 권위.
 *
 * 검증 가족:
 *   (a) 토큰 없음 → 401 / 무효 토큰 → 401(silent 통과 금지)
 *   (b) 유효 토큰 → SSE 헤더(text/event-stream / no-cache) + 연결 유지
 *   (c) Last-Event-ID: N → N 초과 backlog 를 id 오름차순으로 먼저 흘림(놓침 0)
 *   (d) emit → events 큐 append + 그 순간 열린 SSE 연결에 id/event/data 형식 송출
 *   (e) GET /events?since=N 폴백 목록(JSON / listSince 위임 / 토큰 검증)
 *   (f) event-bus 연결 격리 — 한 구독자 throw 가 다른 구독자·호출자를 안 깸 + 유실 0
 *   (h) 토큰 회수·교체·권한 축소 즉시 반영(SA-6) — 운영 조립(인증 게이트 + events +
 *       어댑터 토큰 라우트)을 Bun.serve 로 띄워 실제 SSE 연결로 확인한다.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { EventRepository } from "../../db/store-internal/event-repository.ts";
import type { EventRecord } from "../../db/store-internal/event-repository.ts";
import { EventBus } from "../event-bus.ts";
import { SseTokenStore } from "../../federation/sse-tokens.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import { createAuthGate } from "../auth-gate.ts";
import { registerAdapterTokenRoutes } from "./adapter-tokens.ts";
import { registerEventsRoutes } from "./events.ts";

let db: Database;
let eventRepository: EventRepository;
let eventBus: EventBus;
let sseTokens: SseTokenStore;
let app: Hono;
let tokenDir: string;
let validToken: string;

/**
 * events 테이블만 가진 sqlite-vec-free :memory: DB. 기준 스키마의 events DDL 과 동일
 * (id AUTOINCREMENT / type / payload_json / created_at default). openMemoryDatabase 를
 * 우회해 로컬에서도 실 SQLite + 실 EventRepository 검증을 가능하게 한다.
 */
function openEventsOnlyDb(): Database {
  const d = new Database(":memory:");
  d.exec(
    `CREATE TABLE events (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       type         TEXT NOT NULL,
       payload_json TEXT NOT NULL,
       created_at   TEXT NOT NULL DEFAULT (datetime('now'))
     );`,
  );
  return d;
}

beforeEach(() => {
  db = openEventsOnlyDb();
  eventRepository = new EventRepository(db);
  eventBus = new EventBus(eventRepository);

  tokenDir = mkdtempSync(join(tmpdir(), "bara-sse-tokens-"));
  sseTokens = new SseTokenStore(join(tokenDir, "sse-tokens.json"));
  validToken = sseTokens.issueToken("dashboard");

  app = new Hono({ strict: false });
  registerEventsRoutes(app, { eventBus, eventRepository, sseTokens });
});

afterEach(() => {
  db.close();
  if (existsSync(tokenDir)) {
    rmSync(tokenDir, { recursive: true, force: true });
  }
});

/**
 * SSE 응답 스트림(ReadableStream)을 한 chunk 만 읽어 문자열로 회신하고 reader 를
 * 취소한다(연결 끊김 유도). 무한 SSE 라 전부 읽으면 안 끝나므로 첫 chunk 만 본다.
 * timeoutMs 안에 아무것도 안 오면 빈 문자열(연결은 유지됐다는 뜻 — 실시간 케이스용).
 */
async function readOneChunk(res: Response, timeoutMs = 1500): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  try {
    const winner = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: false }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: false }), timeoutMs),
      ),
    ]);
    if (winner.value === undefined) return "";
    return decoder.decode(winner.value);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

describe("GET /events/stream — 토큰 게이트", () => {
  test("(a1) 토큰 없음 → 401", async () => {
    const res = await app.request("/events/stream");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("토큰 없음");
  });

  test("(a2) 무효 토큰 → 401 (silent 통과 금지)", async () => {
    const res = await app.request("/events/stream?token=not-a-real-token");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("무효");
  });

  test("(a3) 토큰 값은 에러 메시지에 안 들어감", async () => {
    const res = await app.request("/events/stream?token=SUPERSECRET123");
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("SUPERSECRET123");
  });
});

describe("GET /events/stream — SSE 헤더 + 연결", () => {
  test("(b) 유효 토큰 → text/event-stream + no-cache 헤더", async () => {
    const res = await app.request(`/events/stream?token=${validToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
    // 연결 유지 — 스트림 reader 를 열고 즉시 취소(끊김 유도). 헤더만 검증.
    await res.body!.getReader().cancel().catch(() => {});
  });

  test("(b2) Authorization: Bearer 헤더 통로도 검증", async () => {
    const res = await app.request("/events/stream", {
      headers: { Authorization: `Bearer ${validToken}` },
    });
    expect(res.status).toBe(200);
    await res.body!.getReader().cancel().catch(() => {});
  });
});

describe("GET /events/stream — Last-Event-ID 이어받기 (놓침 0)", () => {
  test("(c) Last-Event-ID: N → N 초과 backlog 를 id 오름차순으로 먼저 흘림", async () => {
    // 연결 전에 4건 적재 — 끊긴 동안 쌓인 알림 가정.
    const id1 = eventBus.emit("cleanup_proposals_ready", { count: 1 });
    const id2 = eventBus.emit("cleanup_proposals_ready", { count: 2 });
    const id3 = eventBus.emit("cleanup_proposals_ready", { count: 3 });
    eventBus.emit("cleanup_proposals_ready", { count: 4 });

    // id2 까지 받았던 어댑터가 재연결 — id3·id4 만 이어받아야 한다(id1·id2 재전송 X).
    const res = await app.request(`/events/stream?token=${validToken}`, {
      headers: { "Last-Event-ID": String(id2) },
    });
    expect(res.status).toBe(200);

    const chunk = await readOneChunk(res);
    // 첫 chunk 에 id3 부터 — id1·id2 는 빠지고 id3 이 먼저(오름차순).
    expect(chunk).toContain(`id: ${id3}`);
    expect(chunk).toContain("event: cleanup_proposals_ready");
    expect(chunk).toContain('"count":3');
    // 이미 받은 id1·id2 는 backlog 에 없다(중복 차단).
    expect(chunk).not.toContain(`id: ${id1}`);
    expect(chunk).not.toContain('"count":1');
  });

  test("(c2) Last-Event-ID 없음 → backlog 없이 실시간 대기(과거 재전송 0)", async () => {
    eventBus.emit("cleanup_proposals_ready", { count: 9 });
    const res = await app.request(`/events/stream?token=${validToken}`);
    expect(res.status).toBe(200);
    // Last-Event-ID 없으면 과거 큐를 안 흘린다 — 첫 chunk 가 비어야(timeout) 한다.
    const chunk = await readOneChunk(res, 600);
    expect(chunk).toBe("");
  });
});

describe("GET /events/stream — 실시간 emit fan-out", () => {
  test("(d) 연결 열린 뒤 emit → id/event/data 형식 송출", async () => {
    const res = await app.request(`/events/stream?token=${validToken}`);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // 연결이 구독으로 합류할 때까지 잠깐 기다린 뒤 emit(구독 등록은 streamSSE
    // 콜백 안 첫 await 전에 일어난다 — 짧은 양보로 충분).
    await new Promise((r) => setTimeout(r, 150));
    const emittedId = eventBus.emit("cleanup_proposals_ready", { count: 7, kind: "metadata_fill" });

    const read = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined }>((resolve) =>
        setTimeout(() => resolve({ value: undefined }), 1500),
      ),
    ]);
    await reader.cancel().catch(() => {});

    expect(read.value).not.toBeUndefined();
    const chunk = decoder.decode(read.value);
    expect(chunk).toContain(`id: ${emittedId}`);
    expect(chunk).toContain("event: cleanup_proposals_ready");
    expect(chunk).toContain('"count":7');
    expect(chunk).toContain('"kind":"metadata_fill"');
  });
});

describe("GET /events?since=N — 폴백 목록", () => {
  test("(e1) 토큰 없음 → 401", async () => {
    const res = await app.request("/events?since=0");
    expect(res.status).toBe(401);
  });

  test("(e2) 유효 토큰 → since 초과분 JSON 목록(listSince 위임)", async () => {
    eventBus.emit("a", { n: 1 });
    const id2 = eventBus.emit("b", { n: 2 });
    eventBus.emit("c", { n: 3 });

    const res = await app.request(`/events?since=${id2 - 1}&token=${validToken}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: EventRecord[] };
    // id2 - 1 초과 = id2·id3 두 건, id 오름차순.
    expect(body.events.map((e) => e.type)).toEqual(["b", "c"]);
    expect(body.events[0]!.payload).toEqual({ n: 2 });
  });

  test("(e3) since 미지정 → 0 으로 보정(전체 큐 앞부분부터)", async () => {
    eventBus.emit("x", { n: 1 });
    const res = await app.request(`/events?token=${validToken}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: EventRecord[] };
    expect(body.events.length).toBe(1);
    expect(body.events[0]!.type).toBe("x");
  });
});

describe("GET /dashboard/sse-token — 같은 origin 대시보드 토큰 발급 (Task 5)", () => {
  test("token omission or restricted tokens cannot mint the dashboard capability", async () => {
    expect((await app.request("/dashboard/sse-token")).status).toBe(401);
    const restricted = sseTokens.issueToken("reader", undefined, undefined, "read-only");
    expect((await app.request("/dashboard/sse-token", { headers: { Authorization: `Bearer ${restricted}` } })).status).toBe(403);
  });
  test("(g1) 토큰 발급 — adapterId='dashboard' + 검증 통과하는 토큰", async () => {
    const res = await app.request("/dashboard/sse-token", { headers: { Authorization: `Bearer ${validToken}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { adapterId: string; token: string };
    expect(body.adapterId).toBe("dashboard");
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    // 발급한 토큰은 같은 store 의 verifyToken 을 통과해야 한다(실 발급·검증).
    expect(sseTokens.verifyToken(body.token)).toBe("dashboard");
  });

  test("(g2) 발급 멱등 — 두 번 받아도 같은 토큰(재시작 후 어댑터 토큰 유효)", async () => {
    const a = (await (await app.request("/dashboard/sse-token", { headers: { Authorization: `Bearer ${validToken}` } })).json()) as { token: string };
    const b = (await (await app.request("/dashboard/sse-token", { headers: { Authorization: `Bearer ${validToken}` } })).json()) as { token: string };
    expect(a.token).toBe(b.token);
    // beforeEach 가 이미 issueToken("dashboard") 한 토큰과도 같아야 한다(멱등).
    expect(a.token).toBe(validToken);
  });

  test("(g3) 발급한 토큰으로 SSE 연결이 실제로 통과한다(통로 정합)", async () => {
    const { token } = (await (await app.request("/dashboard/sse-token", { headers: { Authorization: `Bearer ${validToken}` } })).json()) as { token: string };
    const res = await app.request(`/events/stream?token=${token}`);
    expect(res.status).toBe(200);
    await res.body!.getReader().cancel().catch(() => {});
  });
});

describe("legacy 직접 토큰 발급 경로 제거", () => {
  test("/bot/sse-token 과 /ocr-companion/token 은 events route 에 등록되지 않는다", async () => {
    expect((await app.request("/bot/sse-token")).status).toBe(404);
    expect((await app.request("/ocr-companion/token")).status).toBe(404);
  });
});

describe("GET /events/stream — 토큰 회수·교체·권한 변경 즉시 반영 (SA-6)", () => {
  /** 닫힘을 기다리는 상한. ping 주기(25초)보다 훨씬 짧다 — 닫힘이 ping 이 아닌 통지 덕분임을 보인다. */
  const CLOSE_WAIT_MS = 3000;
  const TIMED_OUT = Symbol("timed-out");

  interface GatedServer {
    base: string;
    stop: () => void;
  }

  /** 운영 조립 순서(인증 게이트 → events + 어댑터 토큰 라우트)를 실제 loopback HTTP 로 띄운다. */
  function startGatedServer(): GatedServer {
    const gated = new Hono({ strict: false });
    gated.use(
      "*",
      createAuthGate({
        sseTokens,
        remoteAddrOf: () => "127.0.0.1",
        getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
      }),
    );
    registerEventsRoutes(gated, { eventBus, eventRepository, sseTokens });
    registerAdapterTokenRoutes(gated, { sseTokens });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: gated.fetch });
    return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 스트림 연결을 열고 서버 쪽 구독이 붙을 때까지 기다린다. Bun 은 첫 본문 바이트 전까지
   * 응답 헤더를 보내지 않아 fetch 가 그때까지 끝나지 않으므로, 응답 Promise 는 구독을
   * 확인한 뒤 따로 기다린다.
   */
  async function connectStream(base: string, token: string): Promise<{ response: Promise<Response> }> {
    const before = eventBus.subscriberCount();
    const response = fetch(`${base}/events/stream`, { headers: { Authorization: `Bearer ${token}` } });
    const deadline = Date.now() + CLOSE_WAIT_MS;
    while (eventBus.subscriberCount() === before && Date.now() < deadline) await Bun.sleep(10);
    expect(eventBus.subscriberCount()).toBe(before + 1);
    return { response };
  }

  async function streamResponse(stream: { response: Promise<Response> }): Promise<Response> {
    const res = await withTimeout(stream.response, CLOSE_WAIT_MS);
    if (res === TIMED_OUT) throw new Error("SSE 응답이 상한 안에 시작되지 않았다");
    expect(res.status).toBe(200);
    return res;
  }

  /** 스트림이 서버 쪽에서 닫힐 때까지 읽는다. 상한 안에 안 닫히면 closed=false. */
  async function readUntilClosed(stream: { response: Promise<Response> }): Promise<{ closed: boolean; text: string }> {
    const reader = (await streamResponse(stream)).body!.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + CLOSE_WAIT_MS;
    let text = "";
    while (Date.now() < deadline) {
      const chunk = await withTimeout(reader.read(), deadline - Date.now());
      if (chunk === TIMED_OUT) break;
      if (chunk.done) return { closed: true, text };
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    return { closed: false, text };
  }

  /** 열린 스트림에서 marker 가 든 이벤트가 상한 안에 도착하는지 읽고 연결을 끊는다. */
  async function readUntilContains(stream: { response: Promise<Response> }, marker: string): Promise<string> {
    const reader = (await streamResponse(stream)).body!.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + CLOSE_WAIT_MS;
    let text = "";
    while (Date.now() < deadline && !text.includes(marker)) {
      const chunk = await withTimeout(reader.read(), deadline - Date.now());
      if (chunk === TIMED_OUT || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    return text;
  }

  function captureWarnings(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = ((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }) as typeof console.warn;
    return { lines, restore: () => { console.warn = original; } };
  }

  function bearer(token: string, body?: unknown): RequestInit {
    return {
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
  }

  test("(h1) DELETE /adapter-tokens 회수 직후 열린 스트림이 ping 을 기다리지 않고 닫히고 이후 이벤트를 받지 않는다", async () => {
    const owner = sseTokens.issueToken("owner", undefined, undefined, "full");
    const aiToken = sseTokens.issueToken("ai-x", undefined, undefined, "mcp-standard");
    const server = startGatedServer();
    const warnings = captureWarnings();
    try {
      const stream = await connectStream(server.base, aiToken);
      const revoke = await fetch(`${server.base}/adapter-tokens/ai-x`, { method: "DELETE", ...bearer(owner) });
      expect(revoke.status).toBe(200);
      eventBus.emit("cleanup_proposals_ready", { marker: "after-revoke" });
      const result = await readUntilClosed(stream);
      expect(result.closed).toBe(true);
      expect(result.text).not.toContain("after-revoke");
      expect(warnings.lines.some((line) => line.includes("adapterId=ai-x") && line.includes("사유=revoked"))).toBe(true);
      expect(warnings.lines.join("\n")).not.toContain(aiToken);
      expect(eventBus.subscriberCount()).toBe(0);
      const reconnect = await fetch(`${server.base}/events/stream`, bearer(aiToken));
      expect(reconnect.status).toBe(401);
    } finally {
      warnings.restore();
      server.stop();
    }
  });

  test("(h2) PATCH scope read-only 직후 열린 스트림이 닫히고 재연결은 403", async () => {
    const owner = sseTokens.issueToken("owner", undefined, undefined, "full");
    const aiToken = sseTokens.issueToken("ai-y", undefined, undefined, "mcp-standard");
    const server = startGatedServer();
    const warnings = captureWarnings();
    try {
      const stream = await connectStream(server.base, aiToken);
      const narrowed = await fetch(`${server.base}/adapter-tokens/ai-y/scope`, {
        method: "PATCH",
        ...bearer(owner, { scope: "read-only" }),
      });
      expect(narrowed.status).toBe(200);
      expect((await readUntilClosed(stream)).closed).toBe(true);
      expect(warnings.lines.some((line) => line.includes("adapterId=ai-y") && line.includes("사유=scope-changed"))).toBe(true);
      const reconnect = await fetch(`${server.base}/events/stream`, bearer(aiToken));
      expect(reconnect.status).toBe(403);
    } finally {
      warnings.restore();
      server.stop();
    }
  });

  test("(h3) 재등록 rotate 승인 직후 옛 토큰 스트림이 닫히고 새 토큰으로는 연결된다", async () => {
    const owner = sseTokens.issueToken("owner", undefined, undefined, "full");
    const oldToken = sseTokens.issueToken("bot-discord");
    const server = startGatedServer();
    const warnings = captureWarnings();
    try {
      const stream = await connectStream(server.base, oldToken);
      const enrolled = (await (await fetch(`${server.base}/adapter-enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapterId: "bot-discord", requestedScope: "full" }),
      })).json()) as { requestId: string; pickupSecret: string };
      const approved = await fetch(`${server.base}/adapter-tokens/${enrolled.requestId}/approve`, {
        method: "POST",
        ...bearer(owner, { existingToken: "rotate" }),
      });
      expect(approved.status).toBe(200);
      expect((await readUntilClosed(stream)).closed).toBe(true);
      expect(warnings.lines.some((line) => line.includes("adapterId=bot-discord") && line.includes("사유=rotated"))).toBe(true);

      const picked = (await (await fetch(
        `${server.base}/adapter-enroll/${enrolled.requestId}/token?pickupSecret=${encodeURIComponent(enrolled.pickupSecret)}`,
      )).json()) as { token: string };
      expect(picked.token).not.toBe(oldToken);
      const fresh = await connectStream(server.base, picked.token);
      eventBus.emit("cleanup_proposals_ready", { marker: "rotated-token-live" });
      expect(await readUntilContains(fresh, "rotated-token-live")).toContain("rotated-token-live");
    } finally {
      warnings.restore();
      server.stop();
    }
  });

  test("(h4) 운영 옛 full 토큰 스트림은 다른 어댑터 회수·자기 자동 재등록 뒤에도 열린 채 이벤트를 받는다", async () => {
    const owner = sseTokens.issueToken("owner", undefined, undefined, "full");
    const endpoint = "http://127.0.0.1:3100";
    const botToken = sseTokens.issueToken("bot-discord", endpoint);
    sseTokens.issueToken("ai-z", undefined, undefined, "mcp-standard");
    const server = startGatedServer();
    const warnings = captureWarnings();
    try {
      const stream = await connectStream(server.base, botToken);
      expect((await fetch(`${server.base}/adapter-tokens/ai-z`, { method: "DELETE", ...bearer(owner) })).status).toBe(200);
      const restart = await fetch(`${server.base}/adapter-enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapterId: "bot-discord", endpoint, existingToken: botToken, requestedScope: "full" }),
      });
      expect(restart.status).toBe(200);

      eventBus.emit("cleanup_proposals_ready", { marker: "still-open" });
      const text = await readUntilContains(stream, "still-open");
      expect(text).toContain("still-open");
      expect(warnings.lines.some((line) => line.includes("adapterId=bot-discord") && line.includes("사유="))).toBe(false);
      expect(sseTokens.verifyToken(botToken)).toBe("bot-discord");
      expect(sseTokens.getIssuedTokenScope("bot-discord")).toEqual({ scope: "full", legacyScope: true });
    } finally {
      warnings.restore();
      server.stop();
    }
  });

  test("(h5) 권한이 여전히 맞는 변경 통지(mcp-standard → full)는 스트림을 닫지 않는다", async () => {
    const owner = sseTokens.issueToken("owner", undefined, undefined, "full");
    const aiToken = sseTokens.issueToken("ai-w", undefined, undefined, "mcp-standard");
    const server = startGatedServer();
    try {
      const stream = await connectStream(server.base, aiToken);
      const widened = await fetch(`${server.base}/adapter-tokens/ai-w/scope`, {
        method: "PATCH",
        ...bearer(owner, { scope: "full" }),
      });
      expect(widened.status).toBe(200);
      eventBus.emit("cleanup_proposals_ready", { marker: "after-widen" });
      const text = await readUntilContains(stream, "after-widen");
      expect(text).toContain("after-widen");
    } finally {
      server.stop();
    }
  });

  test("(h6) 라우트도 스트림 권한이 없는 토큰(read-only)은 연결 시점에 403 으로 거부한다", async () => {
    const readOnly = sseTokens.issueToken("reader", undefined, undefined, "read-only");
    const res = await app.request(`/events/stream?token=${readOnly}`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(readOnly);
    expect(eventBus.subscriberCount()).toBe(0);
  });
});

describe("EventBus — 연결 격리 + 유실 0", () => {
  test("(f1) emit 은 append 를 먼저 한다 — fan-out 전부 실패해도 큐에 남음(유실 0)", () => {
    // 항상 throw 하는 구독자 하나만 등록 — fan-out 이 전부 실패하는 상황.
    eventBus.subscribe("broken-adapter", () => {
      throw new Error("연결 끊김 모사");
    });

    // emit 이 throw 하지 않아야 한다(fan-out 실패는 격리). 반환 id 는 적재된 커서.
    const id = eventBus.emit("cleanup_proposals_ready", { count: 5 });
    expect(id).toBeGreaterThan(0);

    // 핵심 — fan-out 이 다 실패해도 events 큐에는 남는다(재연결 시 이어받기 토대).
    const persisted = eventRepository.listSince(0);
    expect(persisted.length).toBe(1);
    expect(persisted[0]!.id).toBe(id);
    expect(persisted[0]!.payload).toEqual({ count: 5 });
  });

  test("(f2) 한 구독자 throw 가 다른 구독자 송출을 안 막는다", () => {
    const received: EventRecord[] = [];
    eventBus.subscribe("broken-adapter", () => {
      throw new Error("연결 끊김 모사");
    });
    eventBus.subscribe("healthy-adapter", (record) => {
      received.push(record);
    });

    eventBus.emit("cleanup_proposals_ready", { count: 2 });

    // 망가진 구독자가 먼저 throw 해도 건강한 구독자는 받았다(격리).
    expect(received.length).toBe(1);
    expect(received[0]!.payload).toEqual({ count: 2 });
  });

  test("(f3) unsubscribe 후엔 fan-out 대상에서 빠진다 + 멱등", () => {
    const received: EventRecord[] = [];
    const sub = eventBus.subscribe("temp-adapter", (r) => received.push(r));
    expect(eventBus.subscriberCount()).toBe(1);

    eventBus.unsubscribe(sub);
    eventBus.unsubscribe(sub); // 멱등 — 두 번 빼도 무해.
    expect(eventBus.subscriberCount()).toBe(0);

    eventBus.emit("cleanup_proposals_ready", { count: 1 });
    expect(received.length).toBe(0);
  });
});
