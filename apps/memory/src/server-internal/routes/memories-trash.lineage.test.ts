/**
 * memories-trash.lineage.test.ts — 휴지통 이동이 출처 삭제와 같은 계보 규칙을 쓴다 (WP-B1-20).
 *
 * 옛 휴지통 이동은 원문 metadata.extractedTo 만 따라가, 재추출 뒤 extractedTo 에서 빠진 옛 자식,
 * 긴 글의 청크, regex 원자를 라이브에 남겼다(원문 없는 파생 노드가 독립 기억처럼 보인다).
 *
 * Real bun:sqlite(:memory:) + real Bgem3Embedder + 실제 저장 경로(saveTextInput)와 라우트.
 *  - 원문을 옮기면 계보 파생 노드(현재 자식, 재추출로 빠진 옛 자식, 청크, regex 원자)를 함께 옮긴다.
 *  - 살아 남는 다른 원문에서도 파생된 공유 자식과, 흡수돼 계보 엣지를 받은 독립 기억은 남는다.
 *  - 사용자가 고른 파생 노드는 공유 자식이어도 그것만 옮긴다.
 *  - WP-B1-20T 설계 5.4 — 계획은 출처 삭제와 같은 planSourceRemoval(trash 방아쇠)이다. 자기 출처 행이 있는
 *    자손은 남고, 옮긴 노드의 출처 행은 보관 출처 표로 갔다가 복원 때 돌아온다. 행 없는 파생은
 *    archived_lineage 행으로 계보 부모를 기록한다.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { RegexL0Extractor } from "../../memory/regex-l0/extractor.ts";
import { buildMemoryApi } from "../../server.ts";
import { saveTextInput } from "../save-input.ts";
import { NodeSourceRepository } from "../../db/store-internal/node-source-repository.ts";
import { archivedLineageKeyOf, sourceKeyOf } from "../../memory/node-sources/source-ref.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";

/** 실제 builtin regex 양식이 원자를 만드는 문장. */
const REGEX_SENTENCE = "배포 알림은 앞으로 운영팀 채널로 보내기로 확정했다.";
const LONG_PARAGRAPHS = [
  "첫 문단은 금요일 오후 창구를 쓴다. 이유는 주말 대응 인력 때문이다.",
  "둘째 문단은 알림 경로를 정한다. 운영팀 채널로 보낸다.",
  "셋째 문단은 점검 목록을 정한다. 배포 전날 저녁에 다시 확인한다.",
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
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.db.close();
});

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const app = buildMemoryApi({ store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() });
  const h = { app, db, store };
  harnesses.push(h);
  return h;
}

async function trash(h: Harness, id: number) {
  const res = await h.app.request(`/memories/${id}/trash`, { method: "POST" });
  expect(res.status).toBe(200);
  // WP-B1-20U 설계 17.0 — 휴지통 이동 뒤에도 살아 있는 노드는 모두 자기 출처 행이나 살아 있는 계보 부모를 가진다.
  expect(lineageOrphans(h.db)).toEqual([]);
  return await res.json() as { trashed: number; cascadeTrashedIds: number[] };
}

function mergedInto(sourceId: number, targetId: number) {
  return { sourceId, targetId, relation: "merged_into", provenance: "system", sourceNodeId: sourceId, weight: 1.0 } as const;
}

function liveIds(db: Database): number[] {
  return (db.query("SELECT id FROM knowledge_nodes ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

function archivedIds(db: Database): number[] {
  return (db.query("SELECT id FROM knowledge_nodes_archive ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

const ascending = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe("POST /memories/:id/trash — 계보 파생 노드", () => {
  test("재추출로 extractedTo 에서 빠진 옛 자식과 regex 원자까지 함께 옮긴다", async () => {
    const h = makeHarness();
    const saved = await saveTextInput(h.store, {
      content: REGEX_SENTENCE, source: "discord", author: "owner", force: true,
      regexL0: new RegexL0Extractor({ patternPaths: [], boosterPaths: [], userRepo: undefined, langs: ["ko"] }),
      regexEnabled: true,
    });
    const origin = saved.originNodeId!;
    const regexAtoms = saved.extracted;
    expect(regexAtoms.length).toBeGreaterThan(0);
    // 재추출 뒤 모양: 옛 자식은 계보 엣지만 남고(철회), 원문 extractedTo 는 새 자식만 가리킨다.
    const oldChild = await h.store.addNode({ content: "옛 추출 사실", sourceType: "llm_extract" });
    const newChild = await h.store.addNode({ content: "새 추출 사실", sourceType: "llm_extract" });
    await h.store.addEdge(mergedInto(oldChild, origin));
    await h.store.addEdge(mergedInto(newChild, origin));
    await h.store.markNodeExtracted(origin, [newChild]);

    const body = await trash(h, origin);
    expect(body.trashed).toBe(origin);
    expect(body.cascadeTrashedIds).toEqual(ascending([oldChild, newChild, ...regexAtoms]));
    expect(liveIds(h.db)).toEqual([]);
    expect(archivedIds(h.db)).toEqual(ascending([origin, oldChild, newChild, ...regexAtoms]));
  });

  test("긴 글을 옮기면 청크와 청크의 추출 자식도 함께 옮긴다", async () => {
    const h = makeHarness();
    const saved = await saveTextInput(h.store, {
      content: LONG_PARAGRAPHS.join("\n\n"), source: "test", author: "owner", force: true,
      chunking: { tokenCap: 80, minChunkTokens: 1 },
    });
    const origin = saved.originNodeId!;
    expect(saved.chunkNodeIds.length).toBeGreaterThan(1);
    const chunkChild = await h.store.addNode({ content: "청크에서 뽑은 사실", sourceType: "llm_extract" });
    await h.store.addEdge(mergedInto(chunkChild, saved.chunkNodeIds[0]!));

    const body = await trash(h, origin);
    expect(body.cascadeTrashedIds).toEqual(ascending([...saved.chunkNodeIds, chunkChild]));
    expect(liveIds(h.db)).toEqual([]);
  });

  test("살아 남는 원문과 공유한 자식, 흡수돼 계보 엣지를 받은 독립 기억은 남는다", async () => {
    const h = makeHarness();
    const originA = await h.store.addNode({ content: "원문 A" });
    const originB = await h.store.addNode({ content: "원문 B" });
    const shared = await h.store.addNode({ content: "공유 사실", sourceType: "llm_extract" });
    const independent = await h.store.addNode({ content: "먼저 저장된 독립 기억" });
    await h.store.addEdge(mergedInto(shared, originA));
    await h.store.addEdge(mergedInto(shared, originB));
    await h.store.addEdge(mergedInto(independent, originA));
    await h.store.markNodeExtracted(originA, [shared, independent]);

    const body = await trash(h, originA);
    expect(body.cascadeTrashedIds).toEqual([]);
    expect(liveIds(h.db)).toEqual(ascending([originB, shared, independent]));
  });

  test("사용자가 고른 공유 자식은 그 노드만 옮긴다", async () => {
    const h = makeHarness();
    const originA = await h.store.addNode({ content: "원문 A" });
    const originB = await h.store.addNode({ content: "원문 B" });
    const shared = await h.store.addNode({ content: "공유 사실", sourceType: "llm_extract" });
    await h.store.addEdge(mergedInto(shared, originA));
    await h.store.addEdge(mergedInto(shared, originB));

    const body = await trash(h, shared);
    expect(body).toEqual({ trashed: shared, cascadeTrashedIds: [] });
    expect(liveIds(h.db)).toEqual(ascending([originA, originB]));
  });
});

async function restore(h: Harness, id: number) {
  const res = await h.app.request(`/archive/${id}/restore`, { method: "POST" });
  expect(res.status).toBe(200);
}

async function searchIds(h: Harness, query: string): Promise<number[]> {
  const res = await h.app.request("/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, limit: 20 }),
  });
  expect(res.status).toBe(200);
  return (await res.json() as { results: Array<{ id: number }> }).results.map((r) => r.id);
}

function lineageParentCount(db: Database, id: number): number {
  return (db.query(`SELECT COUNT(*) AS n FROM knowledge_edges
    WHERE source_id = ? AND relation IN ('merged_into', 'parent_of')`).get(id) as { n: number }).n;
}

function countByContent(db: Database, content: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE content = ?").get(content) as { n: number }).n;
}

describe("POST /memories/:id/trash — 파생 노드에 흡수된 독립 저장", () => {
  test("regex 원자에 흡수된 대시보드 저장은 원문을 옮겨도 남고, 복원·재이동에도 중복·유실이 없다", async () => {
    const h = makeHarness();
    const saved = await saveTextInput(h.store, {
      content: REGEX_SENTENCE, source: "discord", author: "owner", force: true,
      regexL0: new RegexL0Extractor({ patternPaths: [], boosterPaths: [], userRepo: undefined, langs: ["ko"] }),
      regexEnabled: true,
    });
    const origin = saved.originNodeId!;
    const atomContent = "운영팀 채널로 보내기로 확정했다.";
    const dashboard = await saveTextInput(h.store, { content: atomContent, source: "dashboard", author: "owner" });
    expect(dashboard.cacheHit).toBe(true);
    const absorbed = dashboard.originNodeId!;
    expect(saved.extracted).toContain(absorbed);
    const others = saved.extracted.filter((id) => id !== absorbed);

    const first = await trash(h, origin);
    expect(first.cascadeTrashedIds).toEqual(ascending(others));
    expect(liveIds(h.db)).toEqual([absorbed]);
    expect(lineageParentCount(h.db, absorbed)).toBe(0);
    expect(await searchIds(h, atomContent)).toContain(absorbed);

    // 원문을 복원해도 사용자 저장은 한 벌이다(옮긴 적이 없으니 되살아나는 사본이 없다).
    await restore(h, origin);
    expect(liveIds(h.db)).toEqual(ascending([origin, absorbed]));
    expect(countByContent(h.db, atomContent)).toBe(1);

    const second = await trash(h, origin);
    expect(second.cascadeTrashedIds).toEqual([]);
    expect(liveIds(h.db)).toEqual([absorbed]);
  });

  test("extractedTo 에만 남은 LLM 추출 자식이 대시보드 저장을 품었으면 복원 뒤 다시 옮겨도 남는다", async () => {
    const h = makeHarness();
    const saved = await saveTextInput(h.store, { content: "원문 본문이다. 두 문장이다.", source: "discord", author: "owner", force: true });
    const origin = saved.originNodeId!;
    const childContent = "원문에서 뽑은 사실";
    const child = await h.store.addNode({ content: childContent, sourceType: "llm_extract" });
    await h.store.addEdge(mergedInto(child, origin));
    await h.store.markNodeExtracted(origin, [child]);
    const dashboard = await saveTextInput(h.store, { content: childContent, source: "dashboard", author: "owner" });
    expect(dashboard.originNodeId).toBe(child);

    expect((await trash(h, origin)).cascadeTrashedIds).toEqual([]);
    expect(liveIds(h.db)).toEqual([child]);
    // 복원된 원문의 extractedTo 는 여전히 자식을 가리키지만 계보 엣지는 없다(계보 엣지 이전 데이터 모양).
    await restore(h, origin);
    expect(lineageParentCount(h.db, child)).toBe(0);
    expect((await trash(h, origin)).cascadeTrashedIds).toEqual([]);
    expect(liveIds(h.db)).toEqual([child]);
    expect(countByContent(h.db, childContent)).toBe(1);
  });
});

function sourceKeys(db: Database, id: number): string[] {
  return new NodeSourceRepository(db).listSync([id]).get(id)!.map((row) => row.key);
}

function archivedSourceKeys(db: Database, id: number): string[] {
  return (db.query("SELECT source_key FROM memory_node_sources_archive WHERE node_id = ? ORDER BY source_key")
    .all(id) as Array<{ source_key: string }>).map((r) => r.source_key);
}

describe("POST /memories/:id/trash — 출처 행의 이동과 복원 (WP-B1-20T 설계 5.4)", () => {
  test("자기 출처 행이 있는 자식은 남고, 옮긴 원문의 출처 행은 보관표로 갔다가 복원 때 돌아온다", async () => {
    const h = makeHarness();
    const messageId = "msg-trash-rows";
    const saved = await saveTextInput(h.store, {
      content: REGEX_SENTENCE, source: "discord", author: "owner", force: true,
      extraMetadata: { messageId, source: "discord-channel" },
      regexL0: new RegexL0Extractor({ patternPaths: [], boosterPaths: [], userRepo: undefined, langs: ["ko"] }),
      regexEnabled: true,
    });
    const origin = saved.originNodeId!;
    const messageKey = sourceKeyOf({ kind: "message", platform: "discord", messageId });
    const dashboardKey = sourceKeyOf({ kind: "direct_save", channel: "dashboard", actor: "owner" });
    const held = (await saveTextInput(h.store, { content: "운영팀 채널로 보내기로 확정했다.", source: "dashboard", author: "owner" }))
      .originNodeId!;
    expect(saved.extracted).toContain(held);
    const others = saved.extracted.filter((id) => id !== held);

    expect((await trash(h, origin)).cascadeTrashedIds).toEqual(ascending(others));
    // 자기 출처 행(대시보드 저장)이 있는 자식은 남고, 옮긴 원문으로 가는 계보 엣지만 끊긴다.
    expect(liveIds(h.db)).toEqual([held]);
    expect(sourceKeys(h.db, held)).toEqual([dashboardKey]);
    expect(lineageParentCount(h.db, held)).toBe(0);
    // 원문의 출처 행은 보관 출처 표로 옮겨지고, 행 없는 파생은 그 순간의 계보 부모를 기록한다.
    expect(archivedSourceKeys(h.db, origin)).toEqual([messageKey]);
    for (const id of others) expect(archivedSourceKeys(h.db, id)).toEqual([archivedLineageKeyOf(origin)]);

    await restore(h, origin);
    expect(sourceKeys(h.db, origin)).toEqual([messageKey]);
    expect(archivedSourceKeys(h.db, origin)).toEqual([]);
  });
});
