/**
 * save-input-immediate.origin-first.test.ts — 즉시 추출은 원문을 먼저 저장한다(WP-B1-20T T3, 설계 5.9·3.6.1, C2).
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 Hono 라우트(buildMemoryApi: POST /memories, DELETE·PATCH
 * /memories/by-source, POST /search) + 실제 MemoryExtractor·OllamaClient. LLM 은 테스트 안 루프백 서버
 * (test-utils/prompt-ollama-chat-server.ts)가 원문마다 정해 둔 추출 항목을 Ollama /api/chat 형식으로 돌려준다.
 *
 *  - C2: Discord 모양 저장에서 LLM 이 원문과 같은 문장을 항목으로 돌려줘도 auto_capture 원문이 남고, 같은
 *    본문의 llm_extract 노드·자기 엣지가 없고, 원문에 메시지 행 1개. 같은 메시지 재전송 3번은 아무것도 바꾸지
 *    않고, 메시지 삭제는 원문과 파생을 모두 지워 검색 0건, PATCH by-source 는 단일 출처 원문을 같은 id 로 고친다.
 *  - LLM 이 입력 문장 하나만 돌려주는 흔한 응답은 원문 재진술 필터(filterTrivialSingleExtraction)가 버린다.
 *  - 원문은 LLM 응답 뒤에 저장된다 — 잠금 없이 부르는 POST /memories 의 LLM 이 느린 동안 백필 주기가 원문을
 *    후보로 잡지 않는다.
 *  - 원문 저장 뒤 추출 저장이 실패하면 원문은 남고 추출 대기로 돌아가 백필 후보가 된다(실제 SQLite 트리거로
 *    자식 INSERT 를 막아 재현).
 */

import { TEST_EXTRACTION_BACKFILL_RETRY } from "../test-utils/backfill-retry.ts";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { EMBEDDING_CONFLICT_THRESHOLDS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { NodeSourceRepository } from "../db/store-internal/node-source-repository.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import { ConflictChecker } from "../memory/conflict-checker.ts";
import { ContextAssembler } from "../memory/context-assembler.ts";
import { MemoryExtractor } from "../memory/extractor.ts";
import { HybridRetriever } from "../memory/retriever.ts";
import { sourceKeyOf } from "../memory/node-sources/source-ref.ts";
import { startBackfillScheduler } from "../scheduler.ts";
import { buildMemoryApi } from "../server.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import {
  startPromptOllamaChatServer,
  type ExtractionReply,
  type PromptOllamaChatServer,
} from "../test-utils/prompt-ollama-chat-server.ts";

const AUTHOR = "owner";
const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";
const BGE_M3 = EMBEDDING_CONFLICT_THRESHOLDS["bge-m3"];

/** 원문과 같은 문장 + 다른 문장 하나를 돌려주는 응답 — 원문과 같은 항목은 자기 주장이다. */
const SELF_CLAIM_ORIGIN = "답변은 한국어로 해 주세요. 코드 주석도 한국어로 남겨 주세요.";
/** 원문과 다른 항목(bge-m3 실측 원문 유사도 0.832 — 중복 흡수 임계 0.85 아래라 자식이 된다). */
const SELF_CLAIM_CHILD = "코드 주석도 한국어로 남겨 주세요";
/** LLM 이 입력 문장 하나만 그대로 돌려주는 응답(짧은글 게이트를 넘는 한 문장). */
const SINGLE_SENTENCE = "내일 오후 세 시에 치과 예약이 있어서 병원에 가야 한다";
/** PATCH by-source 새 본문. */
const EDITED_ORIGIN = "답변은 영어로 해 주세요. 코드 주석도 영어로 남겨 주세요.";

const REPLIES: readonly ExtractionReply[] = [
  {
    source: SELF_CLAIM_ORIGIN,
    items: [
      { content: SELF_CLAIM_ORIGIN, memoryType: "preference", importance: 0.8 },
      { content: SELF_CLAIM_CHILD, memoryType: "preference", importance: 0.7 },
    ],
  },
  { source: SINGLE_SENTENCE, items: [{ content: SINGLE_SENTENCE, memoryType: "fact", importance: 0.8 }] },
];

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  llm: PromptOllamaChatServer;
  extractor: MemoryExtractor;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.llm.stop();
    h.db.close();
  }
});

/** server.ts 조립과 같은 임계(충돌 범위·추출 중복 흡수)를 글 모델 값으로 넘긴다. */
function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const llm = startPromptOllamaChatServer(REPLIES);
  const extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: llm.url, model: "test-model" }), store, embedder,
    { conflictChecker: new ConflictChecker(store, { simLow: BGE_M3.conflictLow, simHigh: BGE_M3.conflictHigh }), duplicateSim: BGE_M3.dedupSim },
  );
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.llm.extractor.enabled = true;
  settings.llm.extractor.mode = "immediate";
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(), extractor,
    getSettings: () => settings,
  });
  const h = { app, db, store, llm, extractor };
  harnesses.push(h);
  return h;
}

type Json = Record<string, unknown>;

async function request(h: Harness, method: string, path: string, body?: Json): Promise<{ status: number; body: Json }> {
  const res = await h.app.request(path, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as Json };
}

/** Discord 봇이 보내는 모양 그대로(messageId·channelId·source 칸). */
function saveDiscord(h: Harness, content: string, messageId: string) {
  return request(h, "POST", "/memories", {
    content, author: AUTHOR, platform: PLATFORM,
    metadata: { messageId, channelId: "channel-1", source: DISCORD_SOURCE },
  });
}

interface NodeRow { id: number; content: string; source_type: string; mention_count: number; metadata_json: string }

function nodes(db: Database): NodeRow[] {
  return db.query("SELECT id, content, source_type, mention_count, metadata_json FROM knowledge_nodes ORDER BY id")
    .all() as NodeRow[];
}

function nodeRow(db: Database, id: number): NodeRow {
  return db.query("SELECT id, content, source_type, mention_count, metadata_json FROM knowledge_nodes WHERE id = ?")
    .get(id) as NodeRow;
}

function lineageEdges(db: Database): Array<{ source_id: number; target_id: number; relation: string }> {
  return db.query(`SELECT source_id, target_id, relation FROM knowledge_edges
    WHERE relation IN ('merged_into', 'parent_of') ORDER BY source_id, target_id`)
    .all() as Array<{ source_id: number; target_id: number; relation: string }>;
}

function selfEdgeCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM knowledge_edges WHERE source_id = target_id").get() as { n: number }).n;
}

function sourceKeys(db: Database, id: number): string[] {
  return (new NodeSourceRepository(db).listSync([id]).get(id) ?? []).map((row) => row.key);
}

const messageKey = (messageId: string) => sourceKeyOf({ kind: "message", platform: PLATFORM, messageId });

async function searchContents(h: Harness, query: string): Promise<string[]> {
  const { status, body } = await request(h, "POST", "/search", { query, limit: 20 });
  expect(status).toBe(200);
  return (body.results as Array<{ content: string }>).map((r) => r.content);
}

describe("C2 — 원문과 같은 문장을 돌려주는 즉시 추출", () => {
  test("auto_capture 원문이 남고 같은 본문 llm_extract·자기 엣지가 없으며, 원문에 메시지 행 1개", async () => {
    const h = makeHarness();
    const saved = await saveDiscord(h, SELF_CLAIM_ORIGIN, "msg-c2");
    expect(saved.status).toBe(201);
    const originId = saved.body.id as number;
    expect(saved.body).toMatchObject({ originNodeId: originId, cacheHit: false });

    const all = nodes(h.db);
    const origin = all.find((row) => row.id === originId)!;
    expect(origin).toMatchObject({ content: SELF_CLAIM_ORIGIN, source_type: "auto_capture" });
    // 원문과 같은 항목은 자기 주장이라 자식이 없다 — 원문과 다른 항목 하나만 자식이다(설계 3.6.1).
    expect(all.filter((row) => row.source_type === "llm_extract").map((row) => row.content)).toEqual([SELF_CLAIM_CHILD]);
    const child = all.find((row) => row.content === SELF_CLAIM_CHILD)!;
    expect(saved.body.extracted).toEqual([child.id]);
    expect(JSON.parse(origin.metadata_json)).toMatchObject({ extracted: 1, extractedTo: [child.id] });

    // 계보 엣지는 자식 → 원문 하나뿐이고, 자기 엣지는 없다.
    expect(lineageEdges(h.db)).toEqual([{ source_id: child.id, target_id: originId, relation: "merged_into" }]);
    expect(selfEdgeCount(h.db)).toBe(0);
    // 출처 행 — 원문은 메시지 행 1개, 자식은 계보로 붙잡혀 행이 없다(설계 3.4).
    expect(sourceKeys(h.db, originId)).toEqual([messageKey("msg-c2")]);
    expect(sourceKeys(h.db, child.id)).toEqual([]);
    // 자식은 자기 원문과 충돌 후보로 이어지지 않는다.
    expect(h.db.query("SELECT COUNT(*) AS n FROM knowledge_edges WHERE relation = 'contradicts'").get()).toEqual({ n: 0 });
    expect(h.llm.requestCount()).toBe(1);
  }, 120_000);

  test("같은 메시지를 3번 다시 보내도 언급 횟수·metadata·출처 행이 그대로다", async () => {
    const h = makeHarness();
    const first = await saveDiscord(h, SELF_CLAIM_ORIGIN, "msg-resend");
    const originId = first.body.id as number;
    const before = nodes(h.db);

    for (let i = 0; i < 3; i += 1) {
      const resent = await saveDiscord(h, SELF_CLAIM_ORIGIN, "msg-resend");
      expect(resent.status).toBe(201);
      expect(resent.body).toMatchObject({ id: originId, cacheHit: true });
    }

    expect(nodes(h.db)).toEqual(before);
    expect(sourceKeys(h.db, originId)).toEqual([messageKey("msg-resend")]);
    // 재전송은 LLM 을 다시 부르지 않는다(같은 본문 프리체크).
    expect(h.llm.requestCount()).toBe(1);
  }, 120_000);

  test("메시지를 지우면 원문과 파생이 모두 지워지고 두 본문 모두 검색 0건", async () => {
    const h = makeHarness();
    const saved = await saveDiscord(h, SELF_CLAIM_ORIGIN, "msg-delete");
    const originId = saved.body.id as number;
    const childId = (saved.body.extracted as number[])[0]!;

    const deleted = await request(h, "DELETE", `/memories/by-source?messageId=msg-delete&platform=${PLATFORM}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ deletedIds: [originId], derivedDeletedIds: [childId], keptIds: [] });
    expect(nodes(h.db)).toEqual([]);
    expect(await searchContents(h, SELF_CLAIM_ORIGIN)).toEqual([]);
    expect(await searchContents(h, SELF_CLAIM_CHILD)).toEqual([]);
  }, 120_000);

  test("PATCH by-source — 출처가 이 메시지 하나인 원문은 같은 id 로 고쳐진다", async () => {
    const h = makeHarness();
    const saved = await saveDiscord(h, SELF_CLAIM_ORIGIN, "msg-edit");
    const originId = saved.body.id as number;

    const edited = await request(h, "PATCH", "/memories/by-source", {
      messageId: "msg-edit", platform: PLATFORM, content: EDITED_ORIGIN,
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ changed: true, editedIds: [originId], skippedIds: [] });
    expect(nodeRow(h.db, originId).content).toBe(EDITED_ORIGIN);
    expect(sourceKeys(h.db, originId)).toEqual([messageKey("msg-edit")]);
  }, 120_000);

  test("LLM 이 입력 문장 하나만 그대로 돌려주면 재진술 필터가 버려 원문만 남는다", async () => {
    const h = makeHarness();
    const saved = await saveDiscord(h, SINGLE_SENTENCE, "msg-single");
    expect(saved.status).toBe(201);
    const originId = saved.body.id as number;

    expect(h.llm.requestCount()).toBe(1);
    expect(nodes(h.db).map((row) => [row.id, row.source_type])).toEqual([[originId, "auto_capture"]]);
    expect(saved.body.extracted).toEqual([]);
    expect(JSON.parse(nodeRow(h.db, originId).metadata_json)).toMatchObject({ extracted: 1, extractedTo: [] });
    expect(sourceKeys(h.db, originId)).toEqual([messageKey("msg-single")]);
    expect(selfEdgeCount(h.db)).toBe(0);
  }, 120_000);
});

describe("원문은 LLM 응답 뒤에 저장된다", () => {
  test("잠금 없이 부르는 POST /memories 의 LLM 이 느린 동안 백필 주기는 원문을 후보로 잡지 않는다", async () => {
    const h = makeHarness();
    const scheduler = startBackfillScheduler(h.extractor, h.store, { intervalMs: 60_000, batchSize: 5, retry: TEST_EXTRACTION_BACKFILL_RETRY });
    try {
      const release = h.llm.hold();
      const arrived = h.llm.nextRequest();
      const pending = saveDiscord(h, SELF_CLAIM_ORIGIN, "msg-slow");
      await arrived;

      // LLM 이 응답을 붙잡고 있는 동안 — 원문 행이 아직 없어 백필 후보도 없다.
      const during = await scheduler.tickNow();
      expect(during).toMatchObject({ candidatesFound: 0, processed: 0 });
      expect(nodes(h.db)).toEqual([]);

      release();
      const saved = await pending;
      expect(saved.status).toBe(201);
      const originId = saved.body.id as number;
      // 원문은 처음부터 추출 완료로 표시돼 저장 뒤에도 후보가 아니다.
      const after = await scheduler.tickNow();
      expect(after).toMatchObject({ candidatesFound: 0, processed: 0 });
      expect(h.store.nodeRepo.isBackfillCandidateEligible(originId)).toBe(false);
      expect(h.llm.requestCount()).toBe(1);
    } finally {
      await scheduler.stop();
    }
  }, 120_000);
});

describe("원문 저장 뒤 추출 저장 실패", () => {
  test("원문은 남고 추출 대기로 돌아가 백필 후보가 되며, 원인이 경고로 남는다", async () => {
    const h = makeHarness();
    // 실제 SQLite 트리거로 추출 자식 INSERT 를 막는다(원문 auto_capture 는 통과).
    h.db.run(`CREATE TRIGGER t3_block_llm_extract BEFORE INSERT ON knowledge_nodes
      WHEN NEW.source_type = 'llm_extract'
      BEGIN SELECT RAISE(ABORT, 't3 test: llm_extract insert blocked'); END`);
    const warn = spyOn(console, "warn");
    try {
      const saved = await saveDiscord(h, SELF_CLAIM_ORIGIN, "msg-store-fail");
      expect(saved.status).toBe(201);
      const originId = saved.body.id as number;
      // plain 저장과 같은 응답 형식(추출 칸 없음).
      expect(saved.body.extracted).toBeUndefined();
      expect(nodes(h.db).map((row) => [row.id, row.source_type])).toEqual([[originId, "auto_capture"]]);
      expect(JSON.parse(nodeRow(h.db, originId).metadata_json)).toMatchObject({ extracted: 0 });
      expect(JSON.parse(nodeRow(h.db, originId).metadata_json)).not.toHaveProperty("extractedTo");
      expect(h.store.nodeRepo.isBackfillCandidateEligible(originId)).toBe(true);
      expect(sourceKeys(h.db, originId)).toEqual([messageKey("msg-store-fail")]);
      const logged = warn.mock.calls.map((call: unknown[]) => call.map(String).join(" "))
        .filter((line) => line.includes("추출 저장 실패"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("t3 test: llm_extract insert blocked");
      expect(logged[0]).toContain(`원문 ${originId}`);
    } finally {
      warn.mockRestore();
    }
  }, 120_000);
});
