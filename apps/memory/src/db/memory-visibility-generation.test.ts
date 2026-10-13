/**
 * memory-visibility-generation.test.ts — 가시성 변경 번호(memory_visibility_state) 트리거 시험.
 *
 * 기억의 가시성 입력(노드 행·project·source_type·metadata, 계보 엣지)이 바뀔 때만 번호가 오르고,
 * 가시성과 무관한 쓰기(접근·언급 횟수, 중요도, 본문, 같은 값 재기록, 계보가 아닌 엣지)에서는
 * 오르지 않는다. 계보 엣지 트리거의 relation 목록 = 코드 상수(SHARED_MEMORY_LINEAGE_RELATIONS).
 *
 * 옛 memory-visibility-generation-migration.test.ts 에서 옮겼다(코드 상수 대조와 트리거 동작).
 * 표·트리거가 있는지, v42 DB 를 올리는 경로, 옛·새 통로의 DDL 동일성은 옮기지 않았다 — 모양은
 * schema-snapshot.test.ts 가 고정하고, 옛 버전 경로는 압축으로 사라진다.
 * 이 파일은 openMemoryDatabase 만 쓰므로 마이그레이션 압축 전후 모두 통과한다.
 *
 * Mock 0: 실제 openMemoryDatabase. 행은 데이터 fixture(원시 INSERT)다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "./migrations.ts";
import { SHARED_MEMORY_LINEAGE_RELATIONS } from "../memory/shared-memory-contract.ts";

const DIM = 8;
const STATE_TABLE = "memory_visibility_state";
const LINEAGE_EDGE_TRIGGERS = ["ke_visibility_insert", "ke_visibility_delete", "ke_visibility_update"] as const;

function generation(db: Database): number {
  return (db.query(`SELECT generation FROM ${STATE_TABLE} WHERE id = 1`).get() as { generation: number }).generation;
}

function unit(components: readonly number[]): Float32Array {
  const v = new Float32Array(DIM);
  components.forEach((x, i) => { v[i] = x; });
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

/** Real rows in every table the visibility triggers watch, plus the ledgers that point at them. */
function seedRows(db: Database): void {
  const node = db.prepare(`INSERT INTO knowledge_nodes
    (id, content, source_type, project_id, metadata_json, access_count, mention_count, importance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  node.run(1, "공용 배포 규칙", "user_explicit", null, "{}", 3, 1, 0.5);
  node.run(2, "A 프로젝트 결정", "user_explicit", "A",
    JSON.stringify({ sharedMemory: { status: "active", revision: 1, assertionKind: "user_statement", evidenceRefs: [1] } }), 0, 0, 0.7);
  node.run(3, "철회된 결정", "user_explicit", "A",
    JSON.stringify({ sharedMemory: { status: "retracted", revision: 2, assertionKind: "user_statement" } }), 0, 0, 0.4);
  node.run(4, "결정의 청크", "document_chunk", "A", JSON.stringify({ parentNodeId: 2, chunkIndex: 0 }), 0, 0, 0.5);
  node.run(5, "추출 자식", "llm_extract", "A", JSON.stringify({ source: "llm_extract" }), 0, 0, 0.5);
  node.run(6, "만료된 규칙", "user_explicit", null,
    JSON.stringify({ sharedMemory: { status: "active", revision: 0, assertionKind: "unknown", validUntil: "2020-01-01T00:00:00Z" } }), 0, 0, 0.5);
  node.run(7, "검토 대기", "auto_capture", null, JSON.stringify({ pending_review: true }), 0, 0, 0.3);
  const edge = db.prepare(`INSERT INTO knowledge_edges
    (source_id, target_id, relation, provenance, source_node_id, weight) VALUES (?, ?, ?, ?, ?, ?)`);
  edge.run(4, 2, "parent_of", "system", 4, 1);
  edge.run(5, 2, "merged_into", "system", 5, 1);
  edge.run(1, 2, "related_to", "evolver", null, 0.4);
  edge.run(2, 3, "supersedes", "user_input", 2, 1);
  const vec = db.prepare("INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)");
  for (let id = 1; id <= 7; id++) vec.run(id, unit([1, id * 0.1, 0, 0, 0, 0, 0, 0]));
  db.run(`INSERT INTO memory_mutations (request_id, node_id, actor, payload_hash, result_json, created_at)
    VALUES ('req-1', 3, 'client-a', 'hash', '{}', '2026-09-01 00:00:00')`);
  db.run(`INSERT INTO memory_source_events (event_key, node_id, evidence_json, created_at)
    VALUES ('event-1', 2, '{}', '2026-09-01 00:00:00')`);
}

describe("가시성 번호 트리거의 relation 목록", () => {
  test("계보 엣지 트리거의 relation 목록 = SHARED_MEMORY_LINEAGE_RELATIONS", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    try {
      for (const trigger of LINEAGE_EDGE_TRIGGERS) {
        const sql = (db.query("SELECT sql FROM sqlite_master WHERE name = ?").get(trigger) as { sql: string }).sql;
        const quoted = new Set([...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
        expect(quoted).toEqual(new Set(SHARED_MEMORY_LINEAGE_RELATIONS));
      }
    } finally {
      db.close();
    }
  });
});

describe("트리거 — 가시성 입력에서만 번호를 올린다", () => {
  let db: Database;
  const bumps = (write: () => void): number => {
    const before = generation(db);
    write();
    return generation(db) - before;
  };

  afterEach(() => db.close());

  test("노드 추가·삭제와 가시성 칸의 값 변경은 번호를 올린다", () => {
    db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    seedRows(db);
    expect(bumps(() => db.run("INSERT INTO knowledge_nodes (id, content) VALUES (8, '새 기억')"))).toBe(1);
    expect(bumps(() => db.run("UPDATE knowledge_nodes SET metadata_json = '{\"extracted\":1}' WHERE id = 8"))).toBe(1);
    expect(bumps(() => db.run("UPDATE knowledge_nodes SET project_id = 'B' WHERE id = 8"))).toBe(1);
    expect(bumps(() => db.run("UPDATE knowledge_nodes SET source_type = 'llm_extract' WHERE id = 8"))).toBe(1);
    // Renumber and restore, so the external-content FTS rows stay aligned for the delete below.
    expect(bumps(() => db.run("UPDATE knowledge_nodes SET id = 9 WHERE id = 8"))).toBe(1);
    expect(bumps(() => db.run("UPDATE knowledge_nodes SET id = 8 WHERE id = 9"))).toBe(1);
    expect(bumps(() => db.run("DELETE FROM knowledge_nodes WHERE id = 8"))).toBe(1);
    // Two rows in one statement bump twice: each row is a separate visibility input.
    expect(bumps(() => db.run("UPDATE knowledge_nodes SET project_id = 'C' WHERE id IN (1, 6)"))).toBe(2);
  });

  test("가시성과 무관한 칸, 같은 값 재기록은 번호를 올리지 않는다", () => {
    db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    seedRows(db);
    expect(bumps(() => db.run("UPDATE knowledge_nodes SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = 1"))).toBe(0);
    expect(bumps(() => db.run("UPDATE knowledge_nodes SET mention_count = mention_count + 1, last_mentioned_at = datetime('now') WHERE id = 1"))).toBe(0);
    expect(bumps(() => db.run("UPDATE knowledge_nodes SET importance = 0.9 WHERE id = 1"))).toBe(0);
    expect(bumps(() => db.run("UPDATE knowledge_nodes SET content = '고친 본문', updated_at = datetime('now') WHERE id = 1"))).toBe(0);
    expect(bumps(() => db.run("UPDATE knowledge_nodes SET metadata_json = metadata_json, project_id = project_id WHERE id = 2"))).toBe(0);
  });

  test("계보 엣지의 추가·삭제·관계 변경만 번호를 올린다", () => {
    db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    seedRows(db);
    for (const relation of SHARED_MEMORY_LINEAGE_RELATIONS) {
      expect(bumps(() => db.run(`INSERT INTO knowledge_edges (source_id, target_id, relation, provenance)
        VALUES (7, 1, ?, 'regex')`, [relation]))).toBe(1);
      expect(bumps(() => db.run("UPDATE knowledge_edges SET provenance = 'system' WHERE source_id = 7 AND relation = ?", [relation]))).toBe(1);
      expect(bumps(() => db.run("DELETE FROM knowledge_edges WHERE source_id = 7 AND relation = ?", [relation]))).toBe(1);
    }
    // Leaving or entering lineage changes support.
    expect(bumps(() => db.run("UPDATE knowledge_edges SET relation = 'related_to' WHERE source_id = 5 AND relation = 'merged_into'"))).toBe(1);
    expect(bumps(() => db.run("UPDATE knowledge_edges SET relation = 'merged_into' WHERE source_id = 5 AND relation = 'related_to'"))).toBe(1);
    // A weight change on a lineage edge and every non-lineage edge are not visibility inputs.
    expect(bumps(() => db.run("UPDATE knowledge_edges SET weight = 0.2 WHERE source_id = 4"))).toBe(0);
    for (const relation of ["related_to", "supersedes", "contradicts", "links_to"]) {
      expect(bumps(() => db.run(`INSERT INTO knowledge_edges (source_id, target_id, relation, provenance)
        VALUES (6, 7, ?, 'system')`, [relation]))).toBe(0);
      expect(bumps(() => db.run("DELETE FROM knowledge_edges WHERE source_id = 6 AND target_id = 7 AND relation = ?", [relation]))).toBe(0);
    }
  });

  test("노드 삭제의 계보 엣지 CASCADE 도 번호에 들어간다", () => {
    db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    seedRows(db);
    // Node 2 is the target of one parent_of and one merged_into edge: node row + two lineage rows.
    expect(bumps(() => db.run("DELETE FROM knowledge_nodes WHERE id = 2"))).toBe(3);
    expect((db.query("SELECT COUNT(*) AS c FROM knowledge_edges WHERE target_id = 2").get() as { c: number }).c).toBe(0);
  });
});
