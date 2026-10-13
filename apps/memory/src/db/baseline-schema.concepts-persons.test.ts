/**
 * baseline-schema.concepts-persons.test.ts — 기준 스키마 중 개념·사람 묶음(concept_nodes ~ person_vec,
 * 기준 SQL 파일 02-concepts-persons.sql 의 범위)의 동작 시험.
 *
 * 표·칸·색인이 있는지, DDL 글자가 어떤지는 보지 않는다 — schema-snapshot.test.ts 가 글자까지 고정한다.
 * 여기서는 PK·UNIQUE 제약, 외래 키 CASCADE, FTS5 trigram·vec0 동기 트리거, KNN, 양 끝에 외래 키가
 * 없는 concept_edges, 다시 열기 무해를 본다.
 *
 * 옛 migrations.test.ts(Wave 1.0b·1.1a·v10·v14·1.2 묶음)에서 옮겼다. 이 파일은 openMemoryDatabase·
 * runMigrations 만 쓰므로 마이그레이션 압축 전후 모두 통과한다.
 *
 * Mock 0: 실제 bun:sqlite + sqlite-vec. 행은 원시 INSERT 데이터 fixture.
 */
import { describe, expect, test } from "bun:test";
import { openMemoryDatabase, runMigrations } from "./migrations.ts";

type CountRow = { c: number };

const TEXT_DIM = 384;
const SIGLIP_DIM = 768;

describe("concept_nodes 제약", () => {
  test("name UNIQUE — 같은 이름 둘째 개념 거부", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)").run("cpt_a", "만화");
    expect(() =>
      db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)").run("cpt_b", "만화"),
    ).toThrow();
    db.close();
  });
});

describe("개념·사람 엣지 제약과 CASCADE", () => {
  test("node_concept_edges — 복합 PK 중복 거부, role 별 별 edge", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES ('글')").run();
    const nodeId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_x', '만화')").run();

    db.prepare("INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, 'cpt_x', 'tag', 'hashtag', ?)").run(nodeId, nodeId);
    db.prepare("INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, 'cpt_x', 'classification', 'hashtag', ?)").run(nodeId, nodeId);
    expect(() =>
      db.prepare("INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, 'cpt_x', 'tag', 'hashtag', ?)").run(nodeId, nodeId),
    ).toThrow();
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM node_concept_edges WHERE node_id = ?").get(nodeId) as { c: number }).c;
    expect(cnt).toBe(2);
    db.close();
  });

  test("node_concept_edges FK CASCADE — 자산 글 삭제 시 엣지 동반 삭제", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES ('글')").run();
    const nodeId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_y', '봄톤')").run();
    db.prepare("INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, 'cpt_y', 'tag', 'hashtag', ?)").run(nodeId, nodeId);
    db.prepare("DELETE FROM knowledge_nodes WHERE id = ?").run(nodeId);
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM node_concept_edges").get() as { c: number }).c;
    expect(cnt).toBe(0);
    db.close();
  });

  test("concept_edges — 다중 부모(같은 source, 다른 target) 허용 + weight default 0.3", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_c', '주술회전')").run();
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_m', '만화')").run();
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_a', '액션')").run();
    db.prepare("INSERT INTO concept_edges (source_concept_id, target_concept_id, relation, provenance, source_node_id) VALUES ('cpt_c', 'cpt_m', 'parent_of', 'hashtag', NULL)").run();
    db.prepare("INSERT INTO concept_edges (source_concept_id, target_concept_id, relation, provenance, source_node_id) VALUES ('cpt_c', 'cpt_a', 'parent_of', 'hashtag', NULL)").run();
    const rows = db.prepare("SELECT weight FROM concept_edges WHERE source_concept_id = 'cpt_c'").all() as Array<{ weight: number }>;
    expect(rows.length).toBe(2);
    expect(rows[0]!.weight).toBeCloseTo(0.3);
    db.close();
  });

  test("node_person_edges + persons FK CASCADE", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES ('글')").run();
    const nodeId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    db.prepare("INSERT INTO persons (person_id, display_name) VALUES ('psn_1', '사용자')").run();
    db.prepare("INSERT INTO node_person_edges (node_id, person_id, relation, provenance, source_node_id) VALUES (?, 'psn_1', 'authored_by', 'user_input', ?)").run(nodeId, nodeId);
    db.prepare("DELETE FROM persons WHERE person_id = 'psn_1'").run();
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM node_person_edges").get() as { c: number }).c;
    expect(cnt).toBe(0);
    db.close();
  });

  test("concept_edges 양 끝에는 외래 키가 없다 — psn_ 끝과 없는 개념 id 도 INSERT 통과", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO persons (person_id, display_name) VALUES ('psn_a', '사람A')").run();
    expect(() =>
      db.prepare(
        "INSERT INTO concept_edges (source_concept_id, target_concept_id, relation, provenance, source_node_id, weight) VALUES ('psn_a', 'cpt_nope', 'related_to', 'migration', NULL, 0.3)",
      ).run(),
    ).not.toThrow();
    db.close();
  });
});

describe("persons_fts 트리거", () => {
  test("person_fts 트리거가 display_name + birthday 를 합성 색인한다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    // trigram(3-gram) 색인이라 검색어는 3글자 이상이라야 매치된다(concept_nodes_fts
    // 와 동일 특성 / DCL-1 한국어 2글자 보호는 본색인 unicode61 이 담당).
    db.prepare("INSERT INTO persons (person_id, display_name, birthday) VALUES ('psn_b', '김민수', '1990-03-15')").run();
    const byName = db.prepare("SELECT person_id FROM persons_fts WHERE persons_fts MATCH '김민수'").get() as { person_id: string } | null;
    expect(byName?.person_id).toBe("psn_b");
    const byBirthday = db.prepare("SELECT person_id FROM persons_fts WHERE persons_fts MATCH '1990'").get() as { person_id: string } | null;
    expect(byBirthday?.person_id).toBe("psn_b");
    db.close();
  });
});

describe("concept_nodes 검색 색인 트리거", () => {
  test("concept_nodes_fts trigram + INSERT 트리거 동기화", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO concept_nodes (concept_id, name, ko_name) VALUES ('cpt_a','jujutsu','주술회전')").run();
    // trigram(3-gram) 색인이라 검색어는 3글자 이상이라야 매치된다. "주술회" 는
    // ko_name "주술회전" 의 부분 매치 — INSERT 트리거가 name+ko_name 합성 본문을
    // concept_nodes_fts 에 적재했음을 확인한다(2글자 "주술" 은 trigram 본질상 매치
    // 0건 — knowledge_nodes_trgm 과 동일 특성).
    const hits = db.prepare(
      "SELECT concept_id FROM concept_nodes_fts WHERE concept_nodes_fts MATCH ?",
    ).all("주술회") as Array<{ concept_id: string }>;
    expect(hits.map((h) => h.concept_id)).toContain("cpt_a");
    db.close();
  });

  test("concept_nodes DELETE → fts·vec 트리거 정리", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_x','만화')").run();
    const rowid = (db.prepare("SELECT rowid FROM concept_nodes WHERE concept_id='cpt_x'").get() as { rowid: number }).rowid;
    // 테스트용 384-dim Float32Array 바인딩(데이터 fixture).
    db.prepare("INSERT INTO concept_vec(concept_rowid, embedding) VALUES (?, ?)").run(rowid, new Float32Array(TEXT_DIM));
    db.prepare("DELETE FROM concept_nodes WHERE concept_id='cpt_x'").run();
    const ftsLeft = db.prepare("SELECT COUNT(*) AS c FROM concept_nodes_fts").get() as { c: number };
    const vecLeft = db.prepare("SELECT COUNT(*) AS c FROM concept_vec").get() as { c: number };
    expect(ftsLeft.c).toBe(0);
    expect(vecLeft.c).toBe(0);
    db.close();
  });
});

describe("concept_siglip_vec (768 차원 SigLIP 공간)", () => {
  // 글 모델 차원(384)과 무관하게 항상 768 이다.
  function makeSiglipEmbedding(seed: number): Float32Array {
    const v = new Float32Array(SIGLIP_DIM);
    for (let i = 0; i < v.length; i++) v[i] = Math.sin(seed + i * 0.001);
    return v;
  }

  test("768-dim INSERT/SELECT 가동", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_sg', '봄톤')").run();
    const rowid = (db.prepare("SELECT rowid FROM concept_nodes WHERE concept_id='cpt_sg'").get() as { rowid: number }).rowid;

    const embedding = new Float32Array(SIGLIP_DIM);
    for (let i = 0; i < SIGLIP_DIM; i++) embedding[i] = Math.sin(i * 0.01);
    db.prepare("INSERT INTO concept_siglip_vec (concept_rowid, embedding) VALUES (?, ?)").run(rowid, embedding);

    const row = db
      .prepare("SELECT concept_rowid FROM concept_siglip_vec WHERE concept_rowid=?")
      .get(rowid) as { concept_rowid: number } | null;
    expect(row?.concept_rowid).toBe(rowid);
    db.close();
  });

  test("KNN 검색 — 768-dim 가장 가까운 이웃 정합", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    for (let i = 1; i <= 3; i++) {
      db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)").run(`cpt_k${i}`, `개념${i}`);
    }
    const rowids = (db.prepare("SELECT rowid FROM concept_nodes ORDER BY rowid").all() as Array<{ rowid: number }>).map((r) => r.rowid);
    db.prepare("INSERT INTO concept_siglip_vec (concept_rowid, embedding) VALUES (?, ?)").run(rowids[0]!, makeSiglipEmbedding(1));
    db.prepare("INSERT INTO concept_siglip_vec (concept_rowid, embedding) VALUES (?, ?)").run(rowids[1]!, makeSiglipEmbedding(100));
    db.prepare("INSERT INTO concept_siglip_vec (concept_rowid, embedding) VALUES (?, ?)").run(rowids[2]!, makeSiglipEmbedding(1000));

    const query = makeSiglipEmbedding(1);
    const rows = db
      .prepare("SELECT concept_rowid, distance FROM concept_siglip_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 2")
      .all(query) as Array<{ concept_rowid: number; distance: number }>;
    expect(rows.length).toBe(2);
    expect(rows[0]!.concept_rowid).toBe(rowids[0]!);
    expect(rows[0]!.distance).toBeLessThan(rows[1]!.distance);
    db.close();
  });

  test("concept_nodes DELETE → concept_siglip_vec 트리거 정리 (고아 방지)", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_del', '삭제대상')").run();
    const rowid = (db.prepare("SELECT rowid FROM concept_nodes WHERE concept_id='cpt_del'").get() as { rowid: number }).rowid;
    db.prepare("INSERT INTO concept_siglip_vec(concept_rowid, embedding) VALUES (?, ?)").run(rowid, new Float32Array(SIGLIP_DIM));
    expect((db.prepare("SELECT COUNT(*) AS c FROM concept_siglip_vec").get() as CountRow).c).toBe(1);

    db.prepare("DELETE FROM concept_nodes WHERE concept_id='cpt_del'").run();
    expect((db.prepare("SELECT COUNT(*) AS c FROM concept_siglip_vec").get() as CountRow).c).toBe(0);
    db.close();
  });
});

describe("다시 열기 무해", () => {
  test("runMigrations 를 다시 돌려도 concept_edges 행이 그대로다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO persons (person_id, display_name) VALUES ('psn_a', '사람A')").run();
    db.prepare(
      "INSERT INTO concept_edges (source_concept_id, target_concept_id, relation, provenance, source_node_id, weight) VALUES ('psn_a', 'cpt_x', 'related_to', 'migration', NULL, 0.3)",
    ).run();
    runMigrations(db); // 다시 실행 — 새로 할 일이 없다.
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM concept_edges").get() as CountRow).c;
    expect(cnt).toBe(1);
    db.close();
  });
});
