/**
 * baseline-schema.memory-nodes.test.ts — 기준 스키마 중 기억 노드 묶음(knowledge_nodes ~
 * project_vocabularies, 기준 SQL 파일 01-memory-nodes.sql 의 범위)의 동작 시험.
 *
 * 표·칸·색인이 있는지, DDL 글자가 어떤지는 보지 않는다 — 그 모양은 schema-snapshot.test.ts 가
 * 글자까지 고정한다. 여기서는 모양이 만들어 내는 동작만 본다: FTS5·trigram 동기 트리거, vec0 KNN,
 * 외래 키 CASCADE, CHECK·UNIQUE·PK 제약, 부분 색인을 타는 쿼리 계획, 다시 열기 무해.
 *
 * 옛 migrations.test.ts(구조·트리거·KNN·CASCADE·idempotency·v11·v38 묶음), node-sources-
 * migration.test.ts(kind CHECK), revision-message-source-migration.test.ts(부분 색인 쿼리 계획)에서
 * 옮겼다. 이 파일은 openMemoryDatabase·runMigrations 만 쓰므로 마이그레이션 압축 전후 모두 통과한다.
 *
 * Mock 0: 실제 bun:sqlite + sqlite-vec. 행은 원시 INSERT 데이터 fixture.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase, runMigrations } from "./migrations.ts";
import { ARCHIVED_LINEAGE_KIND, NODE_SOURCE_KINDS } from "../memory/node-sources/source-ref.ts";

type CountRow = { c: number };
type IdRow = { id: number };
type DistanceRow = { node_id: number; distance: number };

const EMBEDDING_DIM = 384;
const SOURCES_DIM = 8;

// 384 차원 임베딩 — vec_nodes float[384] 로 만든 DB 용 데이터 fixture.
function makeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < v.length; i++) {
    v[i] = Math.sin(seed + i * 0.001);
  }
  return v;
}

describe("FTS5 sync triggers", () => {
  let db: Database;
  beforeEach(() => { db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM }); });
  afterEach(() => { db.close(); });

  test("INSERT propagates to FTS5 index (Korean text)", () => {
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run("테스트 메모리 한국어 검색");
    const row = db
      .prepare("SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH ?")
      .get("메모리") as { rowid: number } | null;
    expect(row?.rowid).toBe(1);
  });

  test("UPDATE rewrites FTS5 entry", () => {
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run("원본 텍스트");
    db.prepare("UPDATE knowledge_nodes SET content = ? WHERE id = 1").run("새로운 텍스트");

    const stillOriginal = db
      .prepare("SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH ?")
      .get("원본");
    const findsUpdated = db
      .prepare("SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH ?")
      .get("새로운") as { rowid: number } | null;

    expect(stillOriginal).toBeNull();
    expect(findsUpdated?.rowid).toBe(1);
  });

  test("DELETE removes from FTS5 index", () => {
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run("삭제 대상");
    db.prepare("DELETE FROM knowledge_nodes WHERE id = 1").run();
    const row = db
      .prepare("SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH ?")
      .get("삭제");
    expect(row).toBeNull();
  });
});

describe("knowledge_nodes_trgm 보조 색인", () => {
  test("trigram 보조 색인 — '변경이유' 적재 → '변경이유' 부분 매치", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES ('변경이유는 옛 방식이 흠')").run();
    const rows = db.prepare(
      "SELECT rowid FROM knowledge_nodes_trgm WHERE knowledge_nodes_trgm MATCH ?",
    ).all("변경이유") as IdRow[];
    expect(rows.length).toBeGreaterThan(0);
    db.close();
  });

  test("runMigrations 를 다시 돌린 뒤에도 기존 행이 trigram 으로 잡힌다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES ('디스코드봇으로 입력')").run();
    runMigrations(db); // 두 번째 적용 — 새로 할 일이 없고 무해
    const rows = db.prepare(
      "SELECT rowid FROM knowledge_nodes_trgm WHERE knowledge_nodes_trgm MATCH ?",
    ).all("디스코드") as IdRow[];
    expect(rows.length).toBeGreaterThan(0);
    db.close();
  });
});

describe("vec0 KNN", () => {
  let db: Database;
  beforeEach(() => { db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM }); });
  afterEach(() => { db.close(); });

  test("INSERT and KNN search returns nearest neighbor", () => {
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run("A");
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run("B");
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run("C");

    db.prepare("INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)").run(1, makeEmbedding(1));
    db.prepare("INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)").run(2, makeEmbedding(100));
    db.prepare("INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)").run(3, makeEmbedding(1000));

    const query = makeEmbedding(1);
    const rows = db
      .prepare("SELECT node_id, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT 2")
      .all(query) as DistanceRow[];

    expect(rows.length).toBe(2);
    const [nearest, second] = rows as [DistanceRow, DistanceRow];
    expect(nearest.node_id).toBe(1);
    expect(nearest.distance).toBeLessThan(second.distance);
  });

  test("trigger removes vec_nodes row when knowledge_nodes row is deleted", () => {
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run("doomed");
    const inserted = db.prepare("SELECT last_insert_rowid() AS id").get() as IdRow;
    db.prepare("INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)").run(inserted.id, makeEmbedding(42));

    const before = db.prepare("SELECT COUNT(*) AS c FROM vec_nodes WHERE node_id = ?").get(inserted.id) as CountRow;
    expect(before.c).toBe(1);

    db.prepare("DELETE FROM knowledge_nodes WHERE id = ?").run(inserted.id);

    const after = db.prepare("SELECT COUNT(*) AS c FROM vec_nodes WHERE node_id = ?").get(inserted.id) as CountRow;
    expect(after.c).toBe(0);
  });
});

describe("foreign key CASCADE on knowledge_edges", () => {
  let db: Database;
  beforeEach(() => { db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM }); });
  afterEach(() => { db.close(); });

  test("deleting a node deletes connected edges (source side)", () => {
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?), (?)").run("A", "B");
    db.prepare("INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (1, 2, 'links_to', 'system', NULL)").run();

    db.prepare("DELETE FROM knowledge_nodes WHERE id = 1").run();
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM knowledge_edges").get() as CountRow;
    expect(remaining.c).toBe(0);
  });

  test("deleting a node deletes connected edges (target side)", () => {
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?), (?)").run("A", "B");
    db.prepare("INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (1, 2, 'links_to', 'system', NULL)").run();

    db.prepare("DELETE FROM knowledge_nodes WHERE id = 2").run();
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM knowledge_edges").get() as CountRow;
    expect(remaining.c).toBe(0);
  });

  test("unique constraint blocks duplicate (source, target, relation)", () => {
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?), (?)").run("A", "B");
    db.prepare("INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (1, 2, 'links_to', 'system', NULL)").run();

    expect(() =>
      db.prepare("INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (1, 2, 'links_to', 'system', NULL)").run()
    ).toThrow();
  });
});

describe("다시 열기 무해", () => {
  test("runMigrations 를 다시 돌려도 schema_version 행과 스키마 객체가 그대로다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
    const versions = (): unknown[] => db.query("SELECT version FROM schema_version ORDER BY version").all();
    const objects = (): unknown[] => db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const versionsBefore = versions();
    const objectsBefore = objects();
    expect(versionsBefore.length).toBeGreaterThan(0);

    runMigrations(db);
    runMigrations(db);

    expect(versions()).toEqual(versionsBefore);
    expect(objects()).toEqual(objectsBefore);
    db.close();
  });

  test("re-applying schema preserves existing rows", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run("survivor");
    runMigrations(db);
    const row = db.prepare("SELECT content FROM knowledge_nodes WHERE id = 1").get() as { content: string };
    expect(row.content).toBe("survivor");
    db.close();
  });
});

describe("memory_revisions 제약", () => {
  test("revision_type CHECK — 유효한 값은 통과, 모르는 값은 거부", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
    expect(() =>
      db
        .prepare("INSERT INTO memory_revisions (old_node_id, revision_type) VALUES (?, ?)")
        .run(1, "conflict_supersede"),
    ).not.toThrow();
    expect(() =>
      db
        .prepare("INSERT INTO memory_revisions (old_node_id, revision_type) VALUES (?, ?)")
        .run(2, "bogus_type"),
    ).toThrow();
    db.close();
  });
});

describe("메시지 삭제의 수정 이력 조회가 부분 색인을 탄다", () => {
  const REVISIONS = "memory_revisions";
  const SOURCE_MESSAGE_INDEX = "idx_revisions_source_message";

  test("메시지 삭제의 두 조회(플랫폼 없음·있음)가 부분 색인을 탄다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: SOURCES_DIM });
    try {
      const plan = (sql: string): string =>
        (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
      // SQLite 는 "SEARCH ... USING [COVERING ]INDEX <이름> (source_message_id=?)" 로 적는다 — SCAN(전체 훑기)이 아니다.
      const searchesIndex = new RegExp(`^SEARCH ${REVISIONS} USING (COVERING )?INDEX ${SOURCE_MESSAGE_INDEX} `);
      expect(plan(`SELECT id FROM ${REVISIONS} WHERE source_message_id = 'm'`)).toMatch(searchesIndex);
      expect(plan(`SELECT id FROM ${REVISIONS} WHERE source_message_id = 'm' AND source_platform = 'discord'`))
        .toMatch(searchesIndex);
    } finally {
      db.close();
    }
  });
});

describe("memory_node_sources kind CHECK", () => {
  test("kind CHECK 목록 = NODE_SOURCE_KINDS (보관표는 archived_lineage 추가)", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: SOURCES_DIM });
    try {
      const kindsOf = (table: string): string[] => {
        const sql = (db.query("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql: string }).sql;
        const check = sql.match(/kind\s+IN\s*\(([^)]*)\)/)![1]!;
        return [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
      };
      expect(kindsOf("memory_node_sources")).toEqual([...NODE_SOURCE_KINDS]);
      expect(kindsOf("memory_node_sources_archive")).toEqual([...NODE_SOURCE_KINDS, ARCHIVED_LINEAGE_KIND]);
      expect(() =>
        db.run("INSERT INTO knowledge_nodes (id, content) VALUES (1, 'x')"),
      ).not.toThrow();
      expect(() =>
        db.run(`INSERT INTO memory_node_sources (node_id, source_key, kind, created_at)
          VALUES (1, 'lineage:2', 'archived_lineage', '2026-10-01 00:00:00')`),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });
});

describe("project_vocabularies 제약", () => {
  test("복합 PK(project_id, term) 중복 거부", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
    db.prepare("INSERT INTO project_vocabularies (project_id, term, expanded_meaning) VALUES (?,?,?)")
      .run("nest", "cleanup", "활용 X");
    expect(() =>
      db.prepare("INSERT INTO project_vocabularies (project_id, term, expanded_meaning) VALUES (?,?,?)")
        .run("nest", "cleanup", "중복")
    ).toThrow();
    db.close();
  });
});

describe("knowledge_nodes 조회 계획과 기본값", () => {
  test("기존 노드는 event_at=NULL default", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run("사건 시각 없는 메모");
    const row = db
      .prepare("SELECT event_at FROM knowledge_nodes WHERE id = 1")
      .get() as { event_at: string | null };
    expect(row.event_at).toBeNull();
    db.close();
  });

  test("getRecent 의 최신순 조회가 idx_kn_created_at 을 탄다 (전체훑기 아님)", () => {
    // getRecent 쿼리(node-repository.ts) 의 EXPLAIN QUERY PLAN 이 인덱스를 쓰는지.
    // 인덱스가 없으면 SCAN knowledge_nodes + USE TEMP B-TREE FOR ORDER BY 가 잡힌다.
    const db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
    try {
      const plan = db
        .query(
          `EXPLAIN QUERY PLAN
           SELECT * FROM knowledge_nodes
           WHERE source_type NOT IN ('document_chunk', 'llm_extract', 'image_caption')
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(50) as Array<{ detail: string }>;
      const detail = plan.map((r) => r.detail).join(" | ");
      // created_at 인덱스를 타야 한다(이름 명시 확인).
      expect(detail).toContain("idx_kn_created_at");
      // ORDER BY 를 인덱스가 흡수하므로 임시 B-TREE 정렬이 없어야 한다.
      expect(detail).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    } finally {
      db.close();
    }
  });

  test("getProjectMemberNodes 의 프로젝트별 최신순 조회가 idx_kn_project_created 를 탄다", () => {
    // getProjectMemberNodes 쿼리(node-repository.ts) — project_id 등호 필터 + created_at
    // DESC, id DESC 정렬. 복합 인덱스가 필터+정렬을 한 번에 태워야 한다.
    const db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
    try {
      const plan = db
        .query(
          `EXPLAIN QUERY PLAN
           SELECT * FROM knowledge_nodes
           WHERE project_id = ?
             AND source_type NOT IN ('document_chunk', 'llm_extract', 'image_caption')
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all("proj_a", 50) as Array<{ detail: string }>;
      const detail = plan.map((r) => r.detail).join(" | ");
      expect(detail).toContain("idx_kn_project_created");
      expect(detail).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    } finally {
      db.close();
    }
  });

  test("인덱스가 있어도 조회 결과가 바뀌지 않는다 — 최신순 정렬 동작 불변", () => {
    // 인덱스는 성능만 바꾸고 결과는 그대로여야 한다. 같은 초 안 삽입된 두 행이
    // id DESC 로 tie-break 되는지까지 확인(getRecent 계약).
    const db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
    try {
      const insert = db.prepare(
        "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'auto_capture', ?)",
      );
      insert.run("가", "2026-01-01 00:00:00");
      insert.run("나", "2026-01-01 00:00:00"); // 같은 초 — id 로 tie-break
      insert.run("다", "2026-01-02 00:00:00"); // 더 최신
      const rows = db
        .query(
          `SELECT content FROM knowledge_nodes
           WHERE source_type NOT IN ('document_chunk', 'llm_extract', 'image_caption')
           ORDER BY created_at DESC, id DESC LIMIT 10`,
        )
        .all() as Array<{ content: string }>;
      // 최신(다) → 같은 초는 나중 id 가 앞(나 id=2, 가 id=1).
      expect(rows.map((r) => r.content)).toEqual(["다", "나", "가"]);
    } finally {
      db.close();
    }
  });
});
