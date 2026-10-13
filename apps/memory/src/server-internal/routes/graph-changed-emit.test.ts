/**
 * graph-changed-emit.test.ts — 그래프 라이브 연출 2a 서버 발행 검증 (Task 5).
 *
 * 새 글이 진짜 저장된 끝(POST /memories 성공 · POST /ingest 텍스트/문서 성공)에서
 * eventBus 가 graph_changed 를 발행하는지, 그리고 eventBus 미주입이면 옛 흐름이
 * 그대로 보존되는지(no-op) 검증한다.
 *
 * 실 EventBus + 실 EventRepository + 실 SqliteMemoryStore(:memory:) + 실
 * Bgem3Embedder + 실 Hono app. Mock 클래스 0(프로젝트 정책) — 가짜 EventBus 를
 * 만들지 않고 진짜 인스턴스가 events 큐에 적재한 사실을 listSince 로 직접 확인한다.
 * SSE fan-out 자체(브라우저 EventSource 수신)는 라이브 검증(Task 11) 몫이라 여기선
 * 적재(append) 까지만 본다.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import { AssetStore } from "../../assets/asset-store.ts";
import { getMemorySettings } from "../../settings/memory-settings.ts";
import { EventBus, EVENT_TYPES } from "../event-bus.ts";
import { EventRepository } from "../../db/store-internal/event-repository.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  eventRepository: EventRepository;
  dir: string;
}

// 테스트가 만든 자산 임시 디렉토리들 — afterEach 에서 한꺼번에 정리한다.
const dirsToClean: string[] = [];

/** eventBus 주입 harness — graph_changed 적재를 listSince 로 확인할 수 있다. */
function makeHarnessWithBus(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bara-graph-changed-"));
  dirsToClean.push(dir);
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const assetStore = new AssetStore(dir);
  const settings = getMemorySettings("/nonexistent-default-graph-changed-test", "/nonexistent-default-graph-changed-test.secrets.json");
  const eventRepository = new EventRepository(db);
  const eventBus = new EventBus(eventRepository);
  const app = buildMemoryApi({
    store,
    retriever,
    assembler,
    assetStore,
    getSettings: () => settings,
    eventBus,
    eventRepository,
  });
  return { app, db, store, eventRepository, dir };
}

/** eventBus 미주입 harness — 옛 흐름 보존(no-op) 확인용. */
function makeHarnessNoBus(): { app: Hono; db: Database } {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db };
}

afterEach(() => {
  for (const d of dirsToClean.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** events 큐에서 graph_changed 레코드만 골라 반환한다. */
function listGraphChanged(repo: EventRepository) {
  return repo
    .listSince(0, 1000)
    .filter((r) => r.type === EVENT_TYPES.GRAPH_CHANGED);
}

describe("그래프 라이브 연출 2a — graph_changed 발행 (Task 5)", () => {
  test("POST /memories 성공 시 graph_changed { reason: 'memory-added' } 적재", async () => {
    const { app, eventRepository } = makeHarnessWithBus();

    const res = await app.request("/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "라이브 성장 검증 글 하나" }),
    });
    expect(res.status).toBe(201);

    const events = listGraphChanged(eventRepository);
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ reason: "memory-added" });
  });

  test("POST /ingest 텍스트 성공 시 graph_changed { reason: 'ingested' } 적재", async () => {
    const { app, eventRepository } = makeHarnessWithBus();

    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: { type: "text", data: "문서 입력 라이브 성장 검증 본문" },
      }),
    });
    expect(res.status).toBe(201);

    const events = listGraphChanged(eventRepository);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.payload).toEqual({ reason: "ingested" });
  });

  test("eventBus 미주입이면 POST /memories 가 그대로 성공(no-op, 옛 흐름 보존)", async () => {
    const { app } = makeHarnessNoBus();

    const res = await app.request("/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "버스 없이도 저장은 된다" }),
    });
    expect(res.status).toBe(201);
  });
});
