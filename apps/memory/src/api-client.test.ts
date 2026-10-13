/**
 * End-to-end check: MemoryApiClient ↔ real Hono memory-api over real HTTP.
 *
 * The api client is consumed by every external surface (bot-discord,
 * future bot-telegram, MCP wrapper, manual scripts) so we exercise it
 * against the actual server (in-process, ephemeral port) rather than
 * unit-testing the fetch wrapper in isolation.
 *
 * 요청을 기록하는 루프백 서버 + 실제 코어로 헤더·토큰·OCR·postIngest 를 보는 시험은 800줄 상한 때문에
 * api-client.loopback.test.ts 로 옮겼다(WP-B1-20U 설계 17.19 설계 6 M4).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "./embedding/bge-m3.ts";
import { openMemoryDatabase } from "./db/migrations.ts";
import { SqliteMemoryStore } from "./db/store.ts";
import { HybridRetriever } from "./memory/retriever.ts";
import { ContextAssembler } from "./memory/context-assembler.ts";
import { buildMemoryApi } from "./server.ts";
import { MemoryApiClient, MemoryApiError } from "./api-client.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

interface Harness {
  client: MemoryApiClient;
  server: ReturnType<typeof Bun.serve>;
  db: Database;
}

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const app = buildMemoryApi({ store, retriever, assembler });

  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const client = new MemoryApiClient(baseUrl);

  return { client, server, db };
}

/** Extended harness that also exposes the store for direct seeding. */
interface HarnessWithStore extends Harness {
  store: SqliteMemoryStore;
}

function makeHarnessWithStore(): HarnessWithStore {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const app = buildMemoryApi({ store, retriever, assembler });

  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const client = new MemoryApiClient(baseUrl);

  return { client, server, db, store };
}

describe("MemoryApiClient end-to-end", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => {
    h.server.stop(true);
    h.db.close();
  });

  test("ingest + show round-trip", async () => {
    const { id } = await h.client.ingest({
      content: "디스코드에서 들어온 첫 메모",
      metadata: { source: "discord-channel", messageId: "abc" },
    });
    expect(id).toBeGreaterThan(0);

    const memory = await h.client.show(id!);
    expect(memory).not.toBeNull();
    expect(memory!.content).toBe("디스코드에서 들어온 첫 메모");
  });

  test("ingest entity-only input returns entity_patch with null id", async () => {
    const result = await h.client.ingest({
      content:
        "#사람:홍길동 #직업:2D산골나무꾼 #별명:동글이 #생일:0000년0월0일",
    });

    expect(result.type).toBe("entity_patch");
    expect(result.id).toBeNull();
    expect(result.originNodeId).toBeNull();
    expect(result.nodeIds).toEqual([]);
    expect(result.entities?.some((e) => e.typeName === "person")).toBe(true);
    const count = (
      h.db.prepare("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  test("ingest + search returns the memory", async () => {
    await h.client.ingest({ content: "철수는 커피를 좋아한다" });
    await h.client.ingest({ content: "자동차를 새로 샀다" });

    const results = await h.client.search("커피", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.content).toBe("철수는 커피를 좋아한다");
  });

  test("recent returns newest first", async () => {
    await h.client.ingest({ content: "첫째" });
    await h.client.ingest({ content: "둘째" });
    await h.client.ingest({ content: "셋째" });

    const recent = await h.client.recent(2);
    expect(recent.length).toBe(2);
    expect(recent[0]!.content).toBe("셋째");
    expect(recent[1]!.content).toBe("둘째");
  });

  test("forget removes the memory", async () => {
    const { id } = await h.client.ingest({ content: "삭제 대상" });
    expect(await h.client.show(id!)).not.toBeNull();
    expect(await h.client.forget(id!)).toEqual({
      deleted: id!,
      derivedDeletedIds: [],
      archivePurgedIds: [],
      // WP-B1-20U 설계 17.17 — 문서·이미지 기억이 아니라 해제한 첨부가 없다.
      assetCleanup: { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] },
    });
    expect(await h.client.show(id!)).toBeNull();
  });

  test("forget on missing id returns null", async () => {
    expect(await h.client.forget(99999)).toBeNull();
  });

  test("editMemory + appendToMemory round-trip", async () => {
    const { id } = await h.client.ingest({ content: "수정 전" });

    const edited = await h.client.editMemory(id!, {
      content: "수정 후",
      reason: "테스트",
      editor: "api-client",
      source: "api",
    });
    expect(edited.changed).toBe(true);
    expect(edited.memory.content).toBe("수정 후");
    expect(edited.revision?.oldContent).toBe("수정 전");
    expect(edited.revision?.newContent).toBe("수정 후");

    const tagged = await h.client.addTagToMemory(id!, {
      tag: "중요",
      editor: "api-client",
      source: "api",
    });
    expect(tagged.changed).toBe(true);
    expect(tagged.tag).toBe("중요");
    expect(tagged.memory.content).toBe("수정 후\n\n#중요");
    expect(tagged.revision?.oldContent).toBe("수정 후");
    expect(tagged.revision?.newContent).toBe("수정 후\n\n#중요");

    const appended = await h.client.appendToMemory(id!, {
      content: "추가 기록",
      author: "api-client",
      platform: "api",
    });
    expect(appended.targetId).toBe(id!);
    expect(appended.appendedId).toBeGreaterThan(0);
    expect(appended.appendedId).not.toBe(id!);
    expect((await h.client.show(appended.appendedId))?.content).toBe("추가 기록");
  });

  test("stats reflects insertions", async () => {
    for (let i = 0; i < 3; i++) {
      await h.client.ingest({ content: `m${i}` });
    }
    const stats = await h.client.stats();
    expect(stats.totalMemories).toBe(3);
  });

  test("cleanup placeholder reports Phase 2", async () => {
    const r = await h.client.cleanup();
    expect(r.phase).toBe(2);
    expect(r.message).toContain("Phase 2");
  });

  test("deleteBySource → 메시지 매칭 노드 삭제", async () => {
    const { id: keepId } = await h.client.ingest({
      content: "다른 메시지",
      metadata: { source: "discord-channel", messageId: "msg-other" },
    });
    const { id: killId } = await h.client.ingest({
      content: "삭제 대상",
      metadata: { source: "discord-channel", messageId: "msg-target" },
    });

    const result = await h.client.deleteBySource({
      messageId: "msg-target",
      platform: "discord",
    });
    expect(result.deletedCount).toBe(1);
    expect(result.deletedIds).toEqual([killId!]);
    expect(await h.client.show(keepId!)).not.toBeNull();
    expect(await h.client.show(killId!)).toBeNull();
  });

  test("deleteBySource: 없는 messageId면 0", async () => {
    const result = await h.client.deleteBySource({
      messageId: "totally-unknown",
    });
    expect(result.deletedCount).toBe(0);
    expect(result.deletedIds).toEqual([]);
  });

  test("extractFromText: extractor 미부착 시 503 → 의미 있는 에러", async () => {
    // 기본 harness는 extractor를 부착하지 않으므로 서버는 503 반환해야 함.
    let thrown: unknown = null;
    try {
      await h.client.extractFromText({ text: "테스트" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("extractor");
  });

  test("error response surfaces helpful detail", async () => {
    let thrown: unknown = null;
    try {
      await h.client.ingest({ content: "" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("memory-api");
  });

  test("비2xx 는 MemoryApiError 를 던지고 status 필드를 담는다(문자열 파싱 제거 근거)", async () => {
    // 빈 content 는 서버가 400 으로 거절한다 — unwrap 이 MemoryApiError(400) 을 던져야 한다.
    let thrown: unknown = null;
    try {
      await h.client.ingest({ content: "" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MemoryApiError);
    const e = thrown as MemoryApiError;
    // status 가 필드로 들어 있어야 한다(호출자가 문자열을 정규식으로 파내지 않게).
    expect(e.status).toBe(400);
    expect(typeof e.statusText).toBe("string");
    // 메시지 형식은 옛 그대로 보존(하위 호환) — status 숫자도 문장 안에 남는다.
    expect(e.message).toContain("memory-api request failed");
    expect(e.message).toContain("400");
    expect(e.name).toBe("MemoryApiError");
  });
});

// ── ApiClient archive + activity ────────────────────────────────────────

describe("ApiClient archive + activity", () => {
  test("getArchive + restoreArchived 라운드트립", async () => {
    const hw = makeHarnessWithStore();

    const id = await hw.store.addNode({
      content: "api-client 휴지통",
      importance: 0.2,
    });
    await hw.store.trashNodes([id], "cascade");

    const archive = await hw.client.getArchive({ limit: 10 });
    expect(archive).toHaveLength(1);
    expect(archive[0]!.id).toBe(id);
    expect(archive[0]!.archivedAt).toBeTruthy();

    const restored = await hw.client.restoreArchived(id);
    expect(restored.id).toBe(id);
    expect(restored.content).toBe("api-client 휴지통");

    hw.server.stop(true);
    hw.db.close();
  });

  test("restoreArchived: 없는 id → Error(404)", async () => {
    const hw = makeHarnessWithStore();

    let thrown: unknown = null;
    try {
      await hw.client.restoreArchived(99999);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("404");

    hw.server.stop(true);
    hw.db.close();
  });

  test("getEvolverActivity 반환 구조", async () => {
    const hw = makeHarnessWithStore();

    await hw.store.logAutoCleanupActivity({
      clusterEdgesAdded: 7,
      nodesArchived: 2,
    });
    await hw.store.logTrashActivity({
      nodesPurged: 1,
      soonToPurgeCount: 3,
    });

    const acts = await hw.client.getEvolverActivity(5);
    expect(acts).toHaveLength(2);
    // ran_at 가 같은 초로 겹칠 수 있어 위치 대신 합으로 단언(정렬 비결정 회피).
    const sumPurged = acts.reduce((s, a) => s + a.nodesPurged, 0);
    const sumSoon = acts.reduce((s, a) => s + a.soonToPurgeCount, 0);
    const sumEdges = acts.reduce((s, a) => s + a.clusterEdgesAdded, 0);
    const sumArchived = acts.reduce((s, a) => s + a.nodesArchived, 0);
    expect(sumPurged).toBe(1);
    expect(sumSoon).toBe(3);
    expect(sumEdges).toBe(7);
    expect(sumArchived).toBe(2);
    expect(acts[0]!.ranAt).toBeTruthy();

    hw.server.stop(true);
    hw.db.close();
  });
});
