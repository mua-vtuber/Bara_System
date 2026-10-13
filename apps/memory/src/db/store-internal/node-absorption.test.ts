/**
 * node-absorption.test.ts — 저장·흡수 한 번의 출처 기록과 계보 연결 규칙(WP-B1-20T 설계 3.5·3.6, T2).
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 저장 경로(SqliteMemoryStore.addNode·addNodeIdempotent·
 * absorbInput). 출처 행은 실제 NodeSourceRepository 로 읽는다.
 *
 *  - 새 노드: source 는 출처 행 1개, 부모 있는 derived 는 계보 엣지만. provenance 를 비우면 인자에서 도출.
 *  - 같은 메시지 재전송: 행·언급·metadata·가시성 번호 불변.
 *  - 다른 메시지의 같은 본문: 행 2개(H1 기록 부분). 대시보드 반복 저장: 행 1개·언급 +1.
 *  - 파생 흡수: 두 번째 부모 엣지. 흡수한 노드가 부모 자신이거나 부모의 계보 조상이면 엣지 없음.
 *  - 파생의 원문(extractionOriginId)은 같은 본문 흡수 후보에서 빠진다.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { SqliteMemoryStore } from "../store.ts";
import { NodeSourceRepository, type NodeSourceRow } from "./node-source-repository.ts";
import { LINEAGE_EDGE_WEIGHT } from "./node-absorption.ts";
import {
  describeInputSource,
  sourceKeyOf,
  type NodeProvenance,
  type NodeSourceRef,
} from "../../memory/node-sources/source-ref.ts";

const AUTHOR = "owner";
const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

const opened: Database[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function makeStore(): { db: Database; store: SqliteMemoryStore } {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  opened.push(db);
  return { db, store: new SqliteMemoryStore(db, embedder) };
}

function discordMessage(messageId: string): NodeSourceRef {
  return describeInputSource({ source: PLATFORM, author: AUTHOR, metadata: { messageId, source: DISCORD_SOURCE } });
}

const DASHBOARD = describeInputSource({ source: "dashboard", author: AUTHOR });
const source = (ref: NodeSourceRef): NodeProvenance => ({ kind: "source", source: ref });
const derived = (
  parentId: number | null,
  edgeProvenance: "system" | "regex" = "system",
  extractionOriginId?: number,
): NodeProvenance => ({
  kind: "derived",
  parentId,
  relation: "merged_into",
  edgeProvenance,
  ...(extractionOriginId !== undefined ? { extractionOriginId } : {}),
});

function sourceRows(db: Database, id: number): NodeSourceRow[] {
  return new NodeSourceRepository(db).listSync([id]).get(id)!;
}

const sourceKeys = (db: Database, id: number) => sourceRows(db, id).map((row) => row.key);

function lineageParents(db: Database, id: number) {
  return db.query(`SELECT target_id AS parentId, relation, provenance, weight FROM knowledge_edges
    WHERE source_id = ? AND relation IN ('merged_into', 'parent_of') ORDER BY target_id`).all(id) as Array<{
    parentId: number; relation: string; provenance: string; weight: number;
  }>;
}

function nodeState(db: Database, id: number): { mentions: number; metadataJson: string } {
  const row = db.query("SELECT mention_count, metadata_json FROM knowledge_nodes WHERE id = ?").get(id) as {
    mention_count: number; metadata_json: string;
  };
  return { mentions: row.mention_count, metadataJson: row.metadata_json };
}

function visibilityGeneration(db: Database): number {
  return (db.query("SELECT generation FROM memory_visibility_state WHERE id = 1").get() as { generation: number }).generation;
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("새 노드", () => {
  test("source 출처는 행 1개를 남기고, 부모 있는 derived 는 계보 엣지만 남긴다", async () => {
    const { db, store } = makeStore();
    const origin = await store.addNode({ content: "배포 창구는 금요일이다", provenance: source(discordMessage("m-1")) });
    expect(sourceRows(db, origin)).toEqual([expect.objectContaining({
      nodeId: origin, key: sourceKeyOf({ kind: "message", platform: PLATFORM, messageId: "m-1" }),
      kind: "message", platform: PLATFORM, externalId: "m-1",
    })]);

    const child = await store.addNode({ content: "금요일 배포", sourceType: "llm_extract", provenance: derived(origin) });
    expect(sourceRows(db, child)).toEqual([]);
    expect(lineageParents(db, child)).toEqual([
      { parentId: origin, relation: "merged_into", provenance: "system", weight: LINEAGE_EDGE_WEIGHT },
    ]);

    const orphan = await store.addNode({ content: "부모 없는 파생", sourceType: "llm_extract", provenance: derived(null) });
    expect(sourceRows(db, orphan)).toEqual([]);
    expect(lineageParents(db, orphan)).toEqual([]);
  }, 60_000);

  test("provenance 를 비우면 저장소가 인자에서 결정적으로 정한다(설계 3.5)", async () => {
    const { db, store } = makeStore();
    const plain = await store.addNode({ content: "짧은 메모", platform: "dashboard", author: AUTHOR });
    expect(sourceKeys(db, plain)).toEqual([DASHBOARD.key]);
    const discord = await store.addNode({ content: "디스코드 글", metadata: { messageId: "m-9", source: DISCORD_SOURCE } });
    expect(sourceKeys(db, discord)).toEqual([sourceKeyOf({ kind: "message", platform: PLATFORM, messageId: "m-9" })]);
    // 파생 모양(파생 source_type, regex 원자)은 부모 없는 derived — 출처 행도 엣지도 없다.
    const chunk = await store.addNode({ content: "청크 조각", sourceType: "document_chunk" });
    const regexAtom = await store.addNode({ content: "정규식 원자", metadata: { source: "regex" } });
    for (const id of [chunk, regexAtom]) {
      expect(sourceRows(db, id)).toEqual([]);
      expect(lineageParents(db, id)).toEqual([]);
    }
  }, 60_000);

  test("계보 엣지 쓰기가 실패하면 노드 INSERT 도 같은 트랜잭션으로 되돌린다", async () => {
    const { db, store } = makeStore();
    await expect(store.addNode({ content: "없는 부모의 자식", sourceType: "llm_extract", provenance: derived(987_654) }))
      .rejects.toThrow(/FOREIGN KEY/);
    expect(count(db, "knowledge_nodes")).toBe(0);
    expect(count(db, "vec_nodes")).toBe(0);
    expect(count(db, "knowledge_edges")).toBe(0);
  }, 60_000);
});

describe("같은 본문 흡수 — 직접 저장 입력", () => {
  test("같은 메시지 재전송은 행·언급·metadata·가시성 번호를 바꾸지 않는다(설계 5.2)", async () => {
    const { db, store } = makeStore();
    const content = "회의는 화요일 오후다";
    const first = await store.addNodeIdempotent({ content, provenance: source(discordMessage("m-1")) });
    const before = nodeState(db, first.id);
    const generation = visibilityGeneration(db);

    const resent = await store.addNodeIdempotent({ content, provenance: source(discordMessage("m-1")) });
    expect(resent).toEqual({ id: first.id, reused: true });
    expect(await store.absorbInput(first.id, source(discordMessage("m-1")))).toEqual({ recordedNewSource: false, resend: true });

    expect(sourceKeys(db, first.id)).toEqual([discordMessage("m-1").key]);
    expect(nodeState(db, first.id)).toEqual(before);
    expect(visibilityGeneration(db)).toBe(generation);
  }, 60_000);

  test("다른 메시지의 같은 본문은 행 2개가 되고 언급이 오른다 — metadata 는 그대로(H1 기록)", async () => {
    const { db, store } = makeStore();
    const content = "점심은 12시에 먹는다";
    const first = await store.addNodeIdempotent({ content, provenance: source(discordMessage("m-1")) });
    const before = nodeState(db, first.id);
    const generation = visibilityGeneration(db);

    const second = await store.addNodeIdempotent({ content, provenance: source(discordMessage("m-2")) });
    expect(second).toEqual({ id: first.id, reused: true });
    expect(sourceKeys(db, first.id)).toEqual([discordMessage("m-1").key, discordMessage("m-2").key]);
    expect(nodeState(db, first.id)).toEqual({ mentions: before.mentions + 1, metadataJson: before.metadataJson });
    expect(visibilityGeneration(db)).toBe(generation);
  }, 60_000);

  test("같은 채널·작성자의 반복 저장은 행 1개에 언급만 오른다", async () => {
    const { db, store } = makeStore();
    const content = "주간 보고는 금요일에 쓴다";
    const first = await store.addNodeIdempotent({ content, provenance: source(DASHBOARD) });
    const before = nodeState(db, first.id).mentions;
    expect(await store.absorbInput(first.id, source(DASHBOARD))).toEqual({ recordedNewSource: false, resend: false });
    await store.addNodeIdempotent({ content, provenance: source(DASHBOARD) });
    expect(sourceKeys(db, first.id)).toEqual([DASHBOARD.key]);
    expect(nodeState(db, first.id).mentions).toBe(before + 2);
  }, 60_000);

  test("흡수는 metadata 를 읽지 않는다 — 클라이언트가 넣은 absorbedInputs 칸이 깨져 있어도 흡수된다(H2)", async () => {
    const { db, store } = makeStore();
    const content = "깨진 칸을 가진 기억";
    const first = await store.addNodeIdempotent({
      content, metadata: { absorbedInputs: "x" }, provenance: source(discordMessage("m-1")),
    });
    expect(await store.absorbInput(first.id, source(DASHBOARD))).toEqual({ recordedNewSource: true, resend: false });
    expect(sourceKeys(db, first.id)).toEqual([discordMessage("m-1").key, DASHBOARD.key]);
    expect(JSON.parse(nodeState(db, first.id).metadataJson)).toEqual({ absorbedInputs: "x" });
  }, 60_000);
});

describe("파생 흡수 — 계보 연결", () => {
  test("다른 부모의 파생이 같은 본문으로 흡수되면 두 번째 부모 엣지가 생긴다", async () => {
    const { db, store } = makeStore();
    const originA = await store.addNode({ content: "A 원문 전체", provenance: source(discordMessage("m-a")) });
    const originB = await store.addNode({ content: "B 원문 전체", provenance: source(discordMessage("m-b")) });
    const atom = { content: "공유되는 사실이다", metadata: { source: "regex" } };
    const shared = await store.addNode({ ...atom, provenance: derived(originA, "regex") });
    const mentions = nodeState(db, shared).mentions;
    const generation = visibilityGeneration(db);

    const again = await store.addNodeIdempotent({ ...atom, provenance: derived(originB, "regex") });
    expect(again).toEqual({ id: shared, reused: true });
    expect(lineageParents(db, shared).map((e) => [e.parentId, e.provenance])).toEqual([[originA, "regex"], [originB, "regex"]]);
    expect(nodeState(db, shared).mentions).toBe(mentions + 1);
    expect(sourceRows(db, shared)).toEqual([]);
    // 새 계보 엣지는 기본 조회 가시성 입력이라 번호가 오른다(v43 트리거).
    expect(visibilityGeneration(db)).toBeGreaterThan(generation);
  }, 60_000);

  test("흡수한 노드가 부모 자신이거나 부모의 계보 조상이면 엣지를 만들지 않는다(순환 방지)", async () => {
    const { db, store } = makeStore();
    const originText = "원문과 같은 문장이다";
    const origin = await store.addNode({ content: originText, provenance: source(DASHBOARD) });
    const chunk = await store.addNode({ content: "원문의 조각", sourceType: "document_chunk", provenance: derived(origin) });
    const claim = await store.addNode({ content: "조각의 주장", sourceType: "llm_extract", provenance: derived(chunk) });
    const mentions = nodeState(db, origin).mentions;

    // 자기 자신: 원문 전체와 같은 regex 원자가 원문에 흡수된다.
    const self = await store.addNodeIdempotent({ content: originText, metadata: { source: "regex" }, provenance: derived(origin, "regex") });
    expect(self).toEqual({ id: origin, reused: true });
    // 조상: 주장(손자)에서 파생된 입력이 원문(조부모)과 같은 본문이다 — 원문 → 주장 엣지는 순환을 만든다.
    const ancestor = await store.addNodeIdempotent({ content: originText, sourceType: "llm_extract", provenance: derived(claim) });
    expect(ancestor).toEqual({ id: origin, reused: true });

    expect(lineageParents(db, origin)).toEqual([]);
    expect(nodeState(db, origin).mentions).toBe(mentions + 2);
    expect(lineageParents(db, chunk).map((e) => e.parentId)).toEqual([origin]);
    expect(lineageParents(db, claim).map((e) => e.parentId)).toEqual([chunk]);
  }, 60_000);

  test("부모를 모르는 파생 흡수는 언급만 올린다", async () => {
    const { db, store } = makeStore();
    const node = await store.addNode({ content: "추출 사실", sourceType: "llm_extract", provenance: derived(null) });
    const mentions = nodeState(db, node).mentions;
    expect(await store.absorbInput(node, derived(null))).toEqual({ recordedNewSource: false, resend: false });
    expect(nodeState(db, node).mentions).toBe(mentions + 1);
    expect(lineageParents(db, node)).toEqual([]);
    expect(sourceRows(db, node)).toEqual([]);
  }, 60_000);

  test("파생의 원문(extractionOriginId)은 같은 본문 흡수 후보에서 빠진다(설계 3.6)", async () => {
    const { db, store } = makeStore();
    const text = "한 문장짜리 원문이다";
    const origin = await store.addNode({ content: text, provenance: source(discordMessage("m-1")) });
    const child = await store.addNodeIdempotent({
      content: text, sourceType: "llm_extract", provenance: derived(origin, "system", origin),
    });
    expect(child.reused).toBe(false);
    expect(child.id).not.toBe(origin);
    expect(lineageParents(db, child.id).map((e) => e.parentId)).toEqual([origin]);
    expect(sourceKeys(db, origin)).toEqual([discordMessage("m-1").key]);
  }, 60_000);
});

describe("흡수 대상과 출처만 남기기", () => {
  test("없는 노드에 흡수하면 노드 id 를 밝혀 멈추고 아무것도 쓰지 않는다", async () => {
    const { db, store } = makeStore();
    await expect(store.absorbInput(424_242, source(DASHBOARD))).rejects.toThrow("424242");
    expect(count(db, "memory_node_sources")).toBe(0);
  }, 60_000);

  test("recordSourceSync 는 출처 행만 남기고 언급은 올리지 않는다(철회된 기억 흡수용, 설계 5.1)", async () => {
    const { db, store } = makeStore();
    const node = await store.addNode({ content: "철회될 기억", provenance: source(DASHBOARD) });
    const mentions = nodeState(db, node).mentions;
    const mcp = describeInputSource({ source: "mcp", author: "ai-a" });
    expect(store.nodeRepo.recordSourceSync(node, mcp)).toBe(true);
    expect(store.nodeRepo.recordSourceSync(node, mcp)).toBe(false);
    expect(sourceKeys(db, node)).toEqual([mcp.key, DASHBOARD.key].sort());
    expect(nodeState(db, node).mentions).toBe(mentions);
  }, 60_000);
});
