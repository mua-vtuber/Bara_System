/**
 * cleanup-helpers 단위 — Phase 5.6 W5 (2026-05-20).
 *
 * 실제 SQLite + bge-m3 임베더 활용 (mock 0 — CLAUDE.md 테스트 정책 정합).
 * 같은 messageId 묶음 중복 raw 정리 helper 의 dryRun + 실 적용 + 자식 박힌 raw
 * 우선 keep 검증.
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

import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "./migrations.ts";
import { SqliteMemoryStore } from "./store.ts";
import { cleanupDuplicateRaws } from "./cleanup-helpers.ts";
import { NodeSourceRepository } from "./store-internal/node-source-repository.ts";
import { archivedLineageKeyOf, describeInputSource } from "../memory/node-sources/source-ref.ts";
import { lineageOrphans } from "../test-utils/lineage-invariant.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

afterAll(() => {});

describe("cleanupDuplicateRaws — Phase 5.6 W5", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  function liveIds(): number[] {
    return (db.query("SELECT id FROM knowledge_nodes ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
  }

  function archivedIds(): number[] {
    return (db.query("SELECT id FROM knowledge_nodes_archive ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
  }

  function archivedKeys(id: number): string[] {
    return (db.query("SELECT source_key FROM memory_node_sources_archive WHERE node_id = ? ORDER BY source_key")
      .all(id) as Array<{ source_key: string }>).map((r) => r.source_key);
  }

  /**
   * raw INSERT 로 옛 중복 DB 재현 — store.addNode 는 P0-A 멱등으로 같은 (content,
   * project_id) 를 한 노드로 흡수하므로, 이 소급 정리 도구(cleanupDuplicateRaws,
   * scripts/cleanup-duplicates.ts 운영 CLI)가 다루는 실제 상황(입력 멱등 이전에 옛
   * 백필 cron 버그로 축적된 같은 messageId 중복 raw)을 재현하려면 흡수를 우회해야
   * 한다. addNode 와 동등한 노드(knowledge_nodes + vec_nodes + FTS/trigram 트리거)를
   * 만들되 content_hash 흡수 게이트만 건너뛴다 — content_hash 는 NULL 로 둔다(이 헬퍼는
   * messageId 로만 그룹을 찾고 content_hash 는 안 본다). 실제 축적분도 P0-A 이전
   * 저장이라 content_hash 가 NULL 인 정합.
   */
  async function insertDuplicateRaw(
    content: string,
    messageId: string,
  ): Promise<number> {
    const vector = await embedder.embed(content);
    const metadataJson = JSON.stringify({ messageId });
    const insertNode = db.query(
      `INSERT INTO knowledge_nodes
        (content, memory_type, source_type, importance, confidence,
         platform, author, metadata_json, created_at, last_accessed_at)
       VALUES (?, 'fact', 'auto_capture', 0.5, 0.7, '', '', ?,
               datetime('now', 'localtime'), datetime('now', 'localtime'))`,
    );
    const insertVec = db.query(
      "INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)",
    );
    const tx = db.transaction(() => {
      insertNode.run(content, metadataJson);
      const idRow = db.query("SELECT last_insert_rowid() AS id").get() as {
        id: number;
      };
      insertVec.run(idRow.id, vector);
      return idRow.id;
    });
    return tx();
  }

  test("dryRun — 중복 그룹 통계 산출, DB 변동 0", async () => {
    // 같은 messageId 가 3 회 누적된 raw 묶음. raw INSERT 로 옛 중복을 재현한다 —
    // store.addNode 는 P0-A 멱등으로 3개를 1개로 흡수하므로 이 소급 정리 도구의
    // 검증 대상(입력 멱등 이전 축적분)을 만들 수 없다(insertDuplicateRaw 주석 참조).
    const r1 = await insertDuplicateRaw("raw 본문 #도커 #cli", "msg-A");
    const r2 = await insertDuplicateRaw("raw 본문 #도커 #cli", "msg-A");
    const r3 = await insertDuplicateRaw("raw 본문 #도커 #cli", "msg-A");

    const result = await cleanupDuplicateRaws(store, { dryRun: true });

    expect(result.candidateGroups).toBe(1);
    expect(result.rawNodesArchived).toBe(2);
    expect(result.atomicNodesArchived).toBe(0);
    expect(result.perGroup).toHaveLength(1);
    expect(result.perGroup[0]!.messageId).toBe("msg-A");
    // 자식 박힌 raw 없으니 가장 옛 (id ASC) 가 keep.
    expect(result.perGroup[0]!.keepId).toBe(r1);
    expect(result.perGroup[0]!.archivedRawIds.sort()).toEqual([r2, r3].sort());

    // dryRun = DB 변동 0 — 세 raw 모두 살아있어야 한다.
    expect(await store.getNode(r1)).not.toBeNull();
    expect(await store.getNode(r2)).not.toBeNull();
    expect(await store.getNode(r3)).not.toBeNull();
  });

  test("실 적용 — 자식 박힌 raw 우선 keep + 나머지 archive 이동", async () => {
    // 그룹 A — 자식 박힌 raw 가 두 번째 (r5 = 자식 박힘). raw INSERT 로 옛 중복을
    // 재현한다 — store.addNode 는 P0-A 멱등으로 세 raw 를 1개로 흡수하므로(같은
    // content + 같은 project). atomic5 는 다른 content(llm_extract)라 흡수 무관이고,
    // 애초에 흡수 게이트가 document_chunk 만 손대지 않으므로 store.addNode 그대로 둔다.
    const r4 = await insertDuplicateRaw("raw 본문 #일러스트", "msg-B");
    const r5 = await insertDuplicateRaw("raw 본문 #일러스트", "msg-B");
    const atomic5 = await store.addNode({
      content: "본인은 일러스트를 좋아한다.",
      sourceType: "llm_extract",
    });
    await store.addEdge({
      sourceId: atomic5,
      targetId: r5,
      relation: "merged_into",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 1.0,
    });
    const r6 = await insertDuplicateRaw("raw 본문 #일러스트", "msg-B");

    const result = await cleanupDuplicateRaws(store, { dryRun: false });

    expect(result.candidateGroups).toBe(1);
    // r5 가 자식 박혀 있어 keep, r4 + r6 archive.
    expect(result.perGroup[0]!.keepId).toBe(r5);
    expect(result.perGroup[0]!.archivedRawIds.sort()).toEqual([r4, r6].sort());

    // DB 안 — keep r5 + atomic5 만 살아있고 r4 + r6 archive 이동.
    expect(await store.getNode(r5)).not.toBeNull();
    expect(await store.getNode(atomic5)).not.toBeNull();
    expect(await store.getNode(r4)).toBeNull();
    expect(await store.getNode(r6)).toBeNull();
  });

  test("계보 정리(WP-B1-20U 설계 17.3) — 출처 없는 자손은 archived_lineage 와 함께 옮기고 자기 출처가 있는 자식은 남기며, dry-run 수치 = 실제 수치", async () => {
    const messageId = "msg-lineage";
    const sources = new NodeSourceRepository(db);
    const messageRef = describeInputSource({ source: "discord", metadata: { messageId, source: "discord-channel" } });
    const r1 = await insertDuplicateRaw("raw 본문 #계보", messageId);
    const r2 = await insertDuplicateRaw("raw 본문 #계보", messageId);
    // 두 raw 모두 그 메시지의 출처 행을 가진다(같은 메시지가 두 번 저장된 옛 중복 모양).
    sources.insertSync(r1, messageRef);
    sources.insertSync(r2, messageRef);
    const derived = (content: string, parentId: number) => store.addNode({
      content,
      sourceType: "llm_extract",
      provenance: { kind: "derived", parentId, relation: "merged_into", edgeProvenance: "system" },
    });
    // 두 raw 모두 자식이 있으면 가장 옛 r1 이 keep 이고 r2 를 옮긴다.
    const keptChild = await derived("keep raw 에서 뽑은 사실", r1);
    const bare = await derived("옮길 raw 에만 기댄 사실", r2);
    const grandChild = await derived("그 사실에서 다시 뽑은 사실", bare);
    const held = await derived("대시보드에도 저장된 사실", r2);
    sources.insertSync(held, describeInputSource({ source: "dashboard", author: "owner" }));
    const liveBefore = liveIds();

    const dry = await cleanupDuplicateRaws(store, { dryRun: true });
    expect(dry).toMatchObject({ candidateGroups: 1, rawNodesArchived: 1, atomicNodesArchived: 2 });
    expect(dry.perGroup).toEqual([
      { messageId, keepId: r1, archivedRawIds: [r2], archivedAtomicIds: [bare, grandChild].sort((a, b) => a - b) },
    ]);
    // 옮길 세 노드에 닿은 엣지(계보 엣지 bare→r2, held→r2, grandChild→bare 포함) — 실제 표에서 센 값과 같다.
    const touching = (db.query(
      "SELECT COUNT(*) AS n FROM knowledge_edges WHERE source_id IN (?, ?, ?) OR target_id IN (?, ?, ?)",
    ).get(r2, bare, grandChild, r2, bare, grandChild) as { n: number }).n;
    expect(touching).toBeGreaterThanOrEqual(3);
    expect(dry.edgesArchived).toBe(touching);
    expect(liveIds()).toEqual(liveBefore);

    const applied = await cleanupDuplicateRaws(store, { dryRun: false });
    expect(applied).toEqual(dry);
    expect(liveIds()).toEqual([r1, keptChild, held].sort((a, b) => a - b));
    expect(archivedIds()).toEqual([r2, bare, grandChild].sort((a, b) => a - b));
    expect(archivedKeys(bare)).toEqual([archivedLineageKeyOf(r2)]);
    expect(archivedKeys(grandChild)).toEqual([archivedLineageKeyOf(bare)]);
    expect(lineageOrphans(db)).toEqual([]);
  });

  test("그룹 0 — 중복 messageId 없으면 통계 모두 0", async () => {
    await store.addNode({
      content: "raw 본문",
      sourceType: "auto_capture",
      metadata: { messageId: "msg-uniq-1" },
    });
    await store.addNode({
      content: "다른 raw",
      sourceType: "auto_capture",
      metadata: { messageId: "msg-uniq-2" },
    });
    const result = await cleanupDuplicateRaws(store, { dryRun: false });
    expect(result.candidateGroups).toBe(0);
    expect(result.rawNodesArchived).toBe(0);
    expect(result.atomicNodesArchived).toBe(0);
    expect(result.perGroup).toEqual([]);
  });
});
