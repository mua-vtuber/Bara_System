/**
 * PATCH /memories/:id — 편집 뒤 충돌 재검사가 편집한 기억의 같은 계보를 상대로 잇지 않는다
 * (WP-B1-20T T6, 설계 5.11 · 3.6.1).
 *
 * 한 글에서 나온 원문과 추출 자식은 같은 내용이라 서로 반대 주장이 아니다. 저장 경로의 충돌 검사는
 * 이미 계보를 후보에서 뺀다(T3). 편집 재검사(ConflictChecker.recheckAfterEdit)도 같은 규칙을 따라야 한다:
 *  - 추출 자식을 고치면 그 원문(조상)과 contradicts 로 이어지지 않는다.
 *  - 원문을 주장은 그대로 두고 고치면(줄바꿈만 바꿈 — 계보 무효화 대상이 아니라 자식이 남는다) 그 자식(자손)과
 *    contradicts 로 이어지지 않는다.
 *  - 같은 원문의 다른 자식(형제)은 지금처럼 비교한다 — 한 글 안의 두 주장은 서로 어긋날 수 있다.
 *
 * 실제 SQLite + 실제 bge-m3 임베더 + buildMemoryApi 로 end-to-end. 두 글의 정확한 cosine 은 고정할 수
 * 없으므로 충돌 범위를 결과가 강제되는 값 [0.05, 0.9999) 으로 주입한다(설정 주입이지 mock 아님,
 * memories-edit.conflict-recheck.test.ts 와 같은 방식): 관련 한국어 문장 쌍은 확실히 안쪽이라, 계보 제외가
 * 없으면 이 파일의 모든 쌍이 후보가 된다. 계보 엣지는 실제 SQLite 행(merged_into)을 데이터로 넣는다.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { ConflictChecker } from "../../memory/conflict-checker.ts";
import { readSharedMemory } from "../../memory/shared-memory-contract.ts";
import { buildMemoryApi } from "../../server.ts";

const WIDE_SIM_LOW = 0.05;
const WIDE_SIM_HIGH = 0.9999;
const AUTHOR = "owner";

const ORIGIN_TEXT = "답변은 한국어로 해 주세요. 코드 주석도 한국어로 남겨 주세요.";
const ORIGIN_TEXT_REFLOWED = "답변은 한국어로 해 주세요.\n코드 주석도 한국어로 남겨 주세요.";
const FIRST_CLAIM = "답변은 한국어로 해 주세요";
const FIRST_CLAIM_EDITED = "답변은 한국어로 해 주시면 좋겠습니다";
const SECOND_CLAIM = "코드 주석도 한국어로 남겨 주세요";
const SECOND_CLAIM_CONTRADICTED = "코드 주석은 영어로 남겨 주세요";

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
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.db.close();
});

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const conflictChecker = new ConflictChecker(store, { simLow: WIDE_SIM_LOW, simHigh: WIDE_SIM_HIGH });
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(), conflictChecker,
  });
  const h = { app, db, store };
  harnesses.push(h);
  return h;
}

/** 원문(auto_capture)과, 그 원문에서 뽑아 merged_into 로 이은 추출 자식들(llm_extract). */
async function originWithChildren(h: Harness, originText: string, childTexts: string[]): Promise<{ origin: number; children: number[] }> {
  const origin = await h.store.addNode({
    content: originText, memoryType: "fact", sourceType: "auto_capture", author: AUTHOR, platform: "discord",
  });
  const children: number[] = [];
  for (const text of childTexts) {
    const child = await h.store.addNode({ content: text, memoryType: "fact", sourceType: "llm_extract", author: AUTHOR });
    await h.store.addEdge({
      sourceId: child, targetId: origin, relation: "merged_into", provenance: "system", sourceNodeId: origin, weight: 1,
    });
    children.push(child);
  }
  return { origin, children };
}

async function patchContent(h: Harness, id: number, content: string): Promise<void> {
  const res = await h.app.request(`/memories/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, editor: "owner", source: "test" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { changed: boolean; warnings: string[] };
  expect(body.changed).toBe(true);
  expect(body.warnings).toEqual([]);
}

function contradicts(h: Harness): Array<{ source_id: number; target_id: number }> {
  return h.db.query("SELECT source_id, target_id FROM knowledge_edges WHERE relation = 'contradicts' ORDER BY source_id, target_id")
    .all() as Array<{ source_id: number; target_id: number }>;
}

async function statusOf(h: Harness, id: number): Promise<string> {
  return readSharedMemory((await h.store.getNode(id))!.metadata).status;
}

describe("PATCH /memories/:id — 편집 재검사와 계보", () => {
  test("추출 자식을 고쳐도 그 원문(조상)과 충돌 후보로 이어지지 않는다", async () => {
    const h = makeHarness();
    const { origin, children: [child] } = await originWithChildren(h, ORIGIN_TEXT, [FIRST_CLAIM]);

    await patchContent(h, child!, FIRST_CLAIM_EDITED);

    expect(contradicts(h)).toEqual([]);
    expect(await statusOf(h, child!)).toBe("active");
    expect(await statusOf(h, origin)).toBe("active");
  });

  test("계보 무효화 없이 고친 원문(줄바꿈만 바뀜)은 그대로 남은 추출 자식(자손)과 충돌 후보로 이어지지 않는다", async () => {
    const h = makeHarness();
    const { origin, children: [child] } = await originWithChildren(h, ORIGIN_TEXT, [FIRST_CLAIM]);

    await patchContent(h, origin, ORIGIN_TEXT_REFLOWED);

    // 줄바꿈만 바뀐 편집은 추출 주장이 같아 자식이 철회되지 않고 계보 엣지도 그대로다.
    expect(await statusOf(h, child!)).toBe("active");
    expect(h.db.query("SELECT 1 FROM knowledge_edges WHERE relation = 'merged_into' AND source_id = ? AND target_id = ?")
      .get(child!, origin)).not.toBeNull();
    expect(contradicts(h)).toEqual([]);
    expect(await statusOf(h, origin)).toBe("active");
  });

  test("같은 원문의 다른 추출 자식(형제)과는 지금처럼 비교한다 — 원문과는 잇지 않는다", async () => {
    const h = makeHarness();
    const { origin, children: [first, second] } = await originWithChildren(h, ORIGIN_TEXT, [FIRST_CLAIM, SECOND_CLAIM]);

    await patchContent(h, second!, SECOND_CLAIM_CONTRADICTED);

    expect(contradicts(h)).toEqual([{ source_id: second!, target_id: first! }]);
    expect(contradicts(h).some((edge) => edge.target_id === origin || edge.source_id === origin)).toBe(false);
    expect(await statusOf(h, second!)).toBe("disputed");
    expect(await statusOf(h, first!)).toBe("active");
  });
});
