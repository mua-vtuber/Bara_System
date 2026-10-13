/**
 * baseline-schema.assets-cleanup.test.ts — 기준 스키마 중 첨부·정리 묶음(regex_user_patterns ~
 * schema_version, 기준 SQL 파일 04-assets-cleanup.sql 의 범위)의 동작 시험.
 *
 * 표·칸·색인이 있는지, DDL 글자가 어떤지는 보지 않는다 — schema-snapshot.test.ts 가 글자까지 고정한다.
 * 여기서는 PK·UNIQUE·CHECK·기본값, 외래 키 거부와 CASCADE, 이미지·요약 vec0 동기 트리거와 KNN,
 * 외래 키 없는 표, 색인을 타는 쿼리 계획을 본다.
 *
 * 옛 migrations.test.ts(Phase 6a·6b·11a·11b·14a·v10·v12·v13·v16 묶음), cleanup-runs-migration.test.ts,
 * cleanup-stage-results-migration.test.ts, document-record-owners-migration.test.ts,
 * asset-folder-pairing-migration.test.ts 에서 옮겼다. 이 파일은 openMemoryDatabase 만 쓰므로
 * 마이그레이션 압축 전후 모두 통과한다.
 *
 * Mock 0: 실제 bun:sqlite + sqlite-vec. 행은 원시 INSERT 데이터 fixture.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "./migrations.ts";

type CountRow = { c: number };
type IdRow = { id: number };
type DistanceRow = { node_id: number; distance: number };

const TEXT_DIM = 384;
const SIGLIP_DIM = 768;

function open(): Database {
  return openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
}

// 384 차원 임베딩 — 글 모델 vec0 표(chunk_summary_vec 등)용 데이터 fixture.
function makeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(TEXT_DIM);
  for (let i = 0; i < v.length; i++) {
    v[i] = Math.sin(seed + i * 0.001);
  }
  return v;
}

/** asset_files 한 행 + 그것을 가리키는 documents 한 행(외래 키 충족용). */
function seedDocument(db: Database, sha256: string, documentId: string): void {
  db.prepare(
    "INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at) VALUES (?,'text',?,10,1000)",
  ).run(sha256, `/x/${sha256}.md`);
  db.prepare(
    "INSERT INTO documents (document_id, asset_sha256, title, document_type, created_at, updated_at) VALUES (?,?,'제목','free',1000,1000)",
  ).run(documentId, sha256);
}

/** 문서 청크 노드 한 행을 넣고 id 를 돌려준다. */
function seedChunkNode(db: Database): number {
  db.prepare("INSERT INTO knowledge_nodes (content, source_type) VALUES (?, 'document_chunk')").run("청크 원문");
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as IdRow).id;
}

function insertChunkSummary(db: Database, summaryId: string, chunkId: number, documentId: string): void {
  db.prepare(
    "INSERT INTO chunk_summaries (summary_id, parent_chunk_id, parent_document_id, summary_text, generated_by) VALUES (?,?,?,?,?)",
  ).run(summaryId, chunkId, documentId, "요약", "llm");
}

function insertRelationSummary(db: Database, summaryId: string, from: string, to: string, documentId: string): void {
  db.prepare(
    "INSERT INTO relation_summaries (summary_id, from_concept_id, to_concept_id, relation_name, summary_text, confidence, generated_by, source_document_id) VALUES (?,?,?,?,?,?,?,?)",
  ).run(summaryId, from, to, "라이벌", "A 와 B 는 라이벌", 0.9, "llm", documentId);
}

describe("regex 사용자 양식·booster 표", () => {
  test("regex_user_boosters UNIQUE (word, lang) 중복 거부 + 다른 lang 허용", () => {
    const db = open();
    const insert = db.prepare(
      "INSERT INTO regex_user_boosters (booster_id, word, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("rbst_user_1", "결정", 3, 1000, 1000);
    expect(() => insert.run("rbst_user_2", "결정", 2, 2000, 2000)).toThrow();
    // 같은 word 라도 다른 lang 이면 통과한다.
    db.prepare(
      "INSERT INTO regex_user_boosters (booster_id, word, score, lang, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("rbst_user_3", "결정", 1, "en", 3000, 3000);
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM regex_user_boosters").get() as CountRow).c;
    expect(cnt).toBe(2);
    db.close();
  });

  test("default 칸 값 — lang='ko' / enabled=1 / match_count=0 / hit_count=0", () => {
    const db = open();
    db.prepare(
      "INSERT INTO regex_user_patterns (pattern_id, pattern_text, score, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("rpat_user_1", "결정.*했다", 3, "decision", 1000, 1000);
    const prow = db.prepare("SELECT lang, enabled, match_count FROM regex_user_patterns WHERE pattern_id='rpat_user_1'")
      .get() as { lang: string; enabled: number; match_count: number };
    expect(prow.lang).toBe("ko");
    expect(prow.enabled).toBe(1);
    expect(prow.match_count).toBe(0);

    db.prepare(
      "INSERT INTO regex_user_boosters (booster_id, word, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("rbst_user_x", "확정", 2, 1000, 1000);
    const brow = db.prepare("SELECT lang, enabled, hit_count FROM regex_user_boosters WHERE booster_id='rbst_user_x'")
      .get() as { lang: string; enabled: number; hit_count: number };
    expect(brow.lang).toBe("ko");
    expect(brow.enabled).toBe(1);
    expect(brow.hit_count).toBe(0);
    db.close();
  });
});

describe("concept_alias_suggestions 제약", () => {
  const insertSuggestion = (db: Database) => db.prepare(
    "INSERT INTO concept_alias_suggestions (suggestion_id, new_concept_id, candidate_concept_id, cosine, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );

  test("UNIQUE (new_concept_id, candidate_concept_id) 같은 쌍 중복 제안 거부", () => {
    const db = open();
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_new', '갈비')").run();
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_cand', 'rib')").run();
    const insert = insertSuggestion(db);
    insert.run("sug_1", "cpt_new", "cpt_cand", 0.97, "pending", "2026-05-27 00:00:00");
    expect(() =>
      insert.run("sug_2", "cpt_new", "cpt_cand", 0.96, "pending", "2026-05-27 00:01:00"),
    ).toThrow();
    db.close();
  });

  test("status default = 'pending' / resolved_at default NULL", () => {
    const db = open();
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_n2', '갈비')").run();
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_c2', 'rib')").run();
    db.prepare(
      "INSERT INTO concept_alias_suggestions (suggestion_id, new_concept_id, candidate_concept_id, cosine, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("sug_d", "cpt_n2", "cpt_c2", 0.97, "2026-05-27 00:00:00");
    const row = db
      .prepare("SELECT status, resolved_at FROM concept_alias_suggestions WHERE suggestion_id='sug_d'")
      .get() as { status: string; resolved_at: string | null };
    expect(row.status).toBe("pending");
    expect(row.resolved_at).toBeNull();
    db.close();
  });

  test("status CHECK 제약 — pending/merged/rejected 만 허용", () => {
    const db = open();
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_n3', '갈비')").run();
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_c3', 'rib')").run();
    const insert = insertSuggestion(db);
    for (const s of ["pending", "merged", "rejected"]) {
      // candidate FK 충족을 위해 후보 노드를 먼저 만든 뒤 제안을 적재한다.
      db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)").run(`cpt_c3_${s}`, `rib_${s}`);
      expect(() =>
        insert.run(`sug_${s}`, "cpt_n3", `cpt_c3_${s}`, 0.97, s, "2026-05-27 00:00:00"),
      ).not.toThrow();
    }
    // CHECK 위반 — 모르는 status. candidate FK 는 충족시켜 CHECK 만 단독 검증.
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_cbad', 'rib_bad')").run();
    expect(() =>
      insert.run("sug_bad", "cpt_n3", "cpt_cbad", 0.97, "bogus", "2026-05-27 00:00:00"),
    ).toThrow();
    db.close();
  });

  test("FK CASCADE — 새 개념 삭제 시 제안 동반 삭제", () => {
    const db = open();
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_nf', '갈비')").run();
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_cf', 'rib')").run();
    insertSuggestion(db).run("sug_fk", "cpt_nf", "cpt_cf", 0.97, "pending", "2026-05-27 00:00:00");
    db.prepare("DELETE FROM concept_nodes WHERE concept_id='cpt_nf'").run();
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM concept_alias_suggestions").get() as CountRow).c;
    expect(cnt).toBe(0);
    db.close();
  });
});

describe("asset_files · asset_file_imports · documents", () => {
  test("asset_file_imports — 같은 자산 두 import row 허용, 없는 자산 참조는 FK 가 거부", () => {
    const db = open();
    db.prepare("INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at) VALUES (?,?,?,?,?)")
      .run("abc", "text", "/x/abc.md", 10, 1000);
    const insImp = db.prepare(
      "INSERT INTO asset_file_imports (import_id, asset_sha256, source, original_name, imported_at, author, user_id) VALUES (?,?,?,?,?,?,?)",
    );
    insImp.run("imp_1", "abc", "discord", "a.md", 1000, "user", "u1");
    insImp.run("imp_2", "abc", "notion", "a.md", 2000, "user", "u1");
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM asset_file_imports WHERE asset_sha256='abc'").get() as CountRow).c;
    expect(cnt).toBe(2);
    // FK 위반 — 없는 자산 참조는 거부
    expect(() => insImp.run("imp_x", "nope", "discord", "a.md", 3000, "user", "u1")).toThrow();
    db.close();
  });

  test("documents default — chunk_count=0 / has_summary=0 / has_extracted=0 / source_metadata='{}'", () => {
    const db = open();
    seedDocument(db, "s1", "doc_1");
    const row = db.prepare("SELECT chunk_count, has_summary, has_extracted, source_metadata FROM documents WHERE document_id='doc_1'")
      .get() as { chunk_count: number; has_summary: number; has_extracted: number; source_metadata: string };
    expect(row.chunk_count).toBe(0);
    expect(row.has_summary).toBe(0);
    expect(row.has_extracted).toBe(0);
    expect(row.source_metadata).toBe("{}");
    db.close();
  });
});

describe("document_record_owners", () => {
  const OWNERS = "document_record_owners";
  const OWNER_NODE_INDEX = "idx_document_record_owners_node";
  const SOURCE_REF_INDEX = "idx_asset_file_imports_source_ref";

  test("해제의 두 조회(지운 노드 id → 주인 행, 원장 source_ref)가 색인을 타고, 기록을 지우면 주인 행이 CASCADE 로 지워진다", () => {
    const db = open();
    try {
      const plan = (sql: string): string =>
        (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
      expect(plan(`SELECT document_id FROM ${OWNERS} WHERE node_id IN (1, 2)`))
        .toMatch(new RegExp(`^SEARCH ${OWNERS} USING (COVERING )?INDEX ${OWNER_NODE_INDEX} `));
      expect(plan("DELETE FROM asset_file_imports WHERE source_ref IN ('document:a', 'image:1')"))
        .toMatch(new RegExp(`^SEARCH asset_file_imports USING (COVERING )?INDEX ${SOURCE_REF_INDEX} `));

      seedDocument(db, "sha_1", "doc_1");
      db.run(`INSERT INTO ${OWNERS} (document_id, node_id, created_at) VALUES ('doc_1', 7, '2026-10-02 00:00:00')`);
      expect(() => db.run(
        `INSERT INTO ${OWNERS} (document_id, node_id, created_at) VALUES ('doc_missing', 7, '2026-10-02 00:00:00')`,
      )).toThrow(/FOREIGN KEY constraint failed/);
      db.run("DELETE FROM documents WHERE document_id = 'doc_1'");
      expect((db.query(`SELECT COUNT(*) AS c FROM ${OWNERS}`).get() as CountRow).c).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("asset_folder_pairing CHECK", () => {
  const X = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  test("id 는 1 만 허용 — CHECK (id = 1)", () => {
    const db = open();
    try {
      expect(() => db.run(
        "INSERT INTO asset_folder_pairing (id, pairing_id, created_at) VALUES (2, ?, ?)", [X, "2026-10-02 09:00:00"],
      )).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });
});

describe("images · image_vec", () => {
  test("images default 칸 — is_animated=0 / warnings_json='[]' / created_at datetime", () => {
    const db = open();
    // FK 충족 — asset_files 안 dummy 자산 한 행 추가
    db.prepare(
      "INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at) VALUES (?,?,?,?,?)",
    ).run("img_sha_1", "image", "/x/img_sha_1.png", 100, 1000);

    db.prepare(
      "INSERT INTO images (asset_sha256, width, height, mime, preserve_mode) VALUES (?,?,?,?,?)",
    ).run("img_sha_1", 50, 50, "image/png", "smart");

    const row = db
      .prepare("SELECT is_animated, warnings_json, created_at FROM images WHERE asset_sha256='img_sha_1'")
      .get() as { is_animated: number; warnings_json: string; created_at: string };
    expect(row.is_animated).toBe(0);
    expect(row.warnings_json).toBe("[]");
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    db.close();
  });

  test("images FK — 없는 자산 참조는 거부", () => {
    const db = open();
    expect(() =>
      db
        .prepare("INSERT INTO images (asset_sha256, width, height, mime, preserve_mode) VALUES (?,?,?,?,?)")
        .run("missing_sha", 10, 10, "image/png", "smart"),
    ).toThrow();
    db.close();
  });

  test("image_vec 768-dim INSERT/SELECT 가동", () => {
    const db = open();
    db.prepare("INSERT INTO knowledge_nodes (content, source_type) VALUES (?, 'image_asset')")
      .run("이미지 자산 dummy");
    const nodeId = (db.prepare("SELECT last_insert_rowid() AS id").get() as IdRow).id;

    const embedding = new Float32Array(SIGLIP_DIM);
    for (let i = 0; i < SIGLIP_DIM; i++) embedding[i] = Math.sin(i * 0.01);
    db.prepare("INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)").run(nodeId, embedding);

    const row = db
      .prepare("SELECT node_id FROM image_vec WHERE node_id=?")
      .get(nodeId) as { node_id: number } | null;
    expect(row?.node_id).toBe(nodeId);
    db.close();
  });

  test("image_vec KNN 검색 — 768-dim 가장 가까운 이웃 정합", () => {
    const db = open();
    // 노드 3개 + 임베딩 3개 (서로 다른 seed)
    function makeImageEmbedding(seed: number): Float32Array {
      const v = new Float32Array(SIGLIP_DIM);
      for (let i = 0; i < v.length; i++) v[i] = Math.sin(seed + i * 0.001);
      return v;
    }
    for (let i = 1; i <= 3; i++) {
      db.prepare("INSERT INTO knowledge_nodes (content, source_type) VALUES (?, 'image_asset')")
        .run(`이미지 ${i}`);
    }
    db.prepare("INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)").run(1, makeImageEmbedding(1));
    db.prepare("INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)").run(2, makeImageEmbedding(100));
    db.prepare("INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)").run(3, makeImageEmbedding(1000));

    const query = makeImageEmbedding(1);
    const rows = db
      .prepare("SELECT node_id, distance FROM image_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 2")
      .all(query) as DistanceRow[];

    expect(rows.length).toBe(2);
    const [nearest, second] = rows as [DistanceRow, DistanceRow];
    expect(nearest.node_id).toBe(1);
    expect(nearest.distance).toBeLessThan(second.distance);
    db.close();
  });

  test("knowledge_nodes 삭제 시 image_vec row 동기 삭제 (트리거 정합)", () => {
    const db = open();
    db.prepare("INSERT INTO knowledge_nodes (content, source_type) VALUES (?, 'image_asset')")
      .run("삭제 대상 이미지");
    const nodeId = (db.prepare("SELECT last_insert_rowid() AS id").get() as IdRow).id;
    db.prepare("INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)")
      .run(nodeId, new Float32Array(SIGLIP_DIM));

    const before = (db.prepare("SELECT COUNT(*) AS c FROM image_vec WHERE node_id=?").get(nodeId) as CountRow).c;
    expect(before).toBe(1);

    db.prepare("DELETE FROM knowledge_nodes WHERE id=?").run(nodeId);
    const after = (db.prepare("SELECT COUNT(*) AS c FROM image_vec WHERE node_id=?").get(nodeId) as CountRow).c;
    expect(after).toBe(0);
    db.close();
  });
});

describe("cleanup 표 제약", () => {
  test("cleanup_proposals default 칸 — status='pending' / created_at datetime", () => {
    const db = open();
    db.prepare("INSERT INTO cleanup_proposals (id, kind, payload_json) VALUES (?,?,?)")
      .run("cp_test_1", "merge_candidate", "{}");
    const row = db
      .prepare("SELECT status, created_at, resolved_at FROM cleanup_proposals WHERE id='cp_test_1'")
      .get() as { status: string; created_at: string; resolved_at: string | null };
    expect(row.status).toBe("pending");
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(row.resolved_at).toBeNull();
    db.close();
  });

  test("cleanup_stage_results PK 두 칸 — (stage, target_key)", () => {
    const db = open();
    const pkOrder = (db.query("PRAGMA table_info(cleanup_stage_results)").all() as Array<{
      name: string;
      pk: number;
    }>)
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name);
    expect(pkOrder).toEqual(["stage", "target_key"]);
    db.close();
  });

  test("cleanup_stage_results status CHECK — 네 값만 허용, 그 밖은 거부", () => {
    const db = open();
    const insert = (status: string) =>
      db
        .prepare(
          `INSERT INTO cleanup_stage_results (stage, target_key, status, input_fingerprint, stage_version)
           VALUES ('regex_strengthen', ?, ?, 'fp', 1)`,
        )
        .run(`k_${status}`, status);
    for (const ok of ["completed", "completed_noop", "retryable_failure", "terminal_failure"]) {
      expect(() => insert(ok)).not.toThrow();
    }
    expect(() => insert("bogus")).toThrow();
    db.close();
  });

  test("cleanup_runs PK 한 칸 — run_id", () => {
    const db = open();
    const pkOrder = (db.query("PRAGMA table_info(cleanup_runs)").all() as Array<{
      name: string;
      pk: number;
    }>)
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name);
    expect(pkOrder).toEqual(["run_id"]);
    db.close();
  });

  test("cleanup_runs status CHECK — 네 값만 허용, 그 밖은 거부", () => {
    const db = open();
    const insert = (status: string) =>
      db
        .prepare(
          `INSERT INTO cleanup_runs (run_id, trigger, status) VALUES (?, 'manual', ?)`,
        )
        .run(`r_${status}`, status);
    for (const ok of ["running", "completed", "cancelled", "failed"]) {
      expect(() => insert(ok)).not.toThrow();
    }
    expect(() => insert("bogus")).toThrow();
    db.close();
  });

  test("cleanup_runs trigger CHECK — manual/scheduled 만 허용", () => {
    const db = open();
    const insert = (trigger: string) =>
      db
        .prepare(
          `INSERT INTO cleanup_runs (run_id, trigger, status) VALUES (?, ?, 'running')`,
        )
        .run(`r_${trigger}`, trigger);
    for (const ok of ["manual", "scheduled"]) {
      expect(() => insert(ok)).not.toThrow();
    }
    expect(() => insert("cron")).toThrow();
    db.close();
  });

  test("cleanup_runs idempotency_key UNIQUE — 같은 키 두 행 거부, NULL 은 다중 허용", () => {
    const db = open();
    const insert = (runId: string, key: string | null) =>
      db
        .prepare(
          `INSERT INTO cleanup_runs (run_id, trigger, status, idempotency_key) VALUES (?, 'manual', 'running', ?)`,
        )
        .run(runId, key);
    insert("r1", "k1");
    // 같은 idempotency_key = UNIQUE 위반.
    expect(() => insert("r2", "k1")).toThrow();
    // NULL 키는 SQLite UNIQUE 에서 서로 충돌하지 않는다 — 키 없는 run 다중 생성 허용.
    expect(() => insert("r3", null)).not.toThrow();
    expect(() => insert("r4", null)).not.toThrow();
    db.close();
  });
});

describe("events · tag_reflow_log", () => {
  test("events append/조회 round-trip — id 단조 증가 + id 초과 이어받기", () => {
    const db = open();
    const id1 = (db
      .prepare("INSERT INTO events (type, payload_json) VALUES (?, ?)")
      .run("cleanup_proposals_ready", JSON.stringify({ count: 2 }))
      .lastInsertRowid) as number;
    const id2 = (db
      .prepare("INSERT INTO events (type, payload_json) VALUES (?, ?)")
      .run("cleanup_proposals_ready", JSON.stringify({ count: 1 }))
      .lastInsertRowid) as number;
    expect(Number(id2)).toBeGreaterThan(Number(id1));

    const since = db
      .prepare("SELECT id, type FROM events WHERE id > ? ORDER BY id ASC")
      .all(id1) as Array<{ id: number; type: string }>;
    expect(since.map((r) => r.id)).toEqual([Number(id2)]);
    db.close();
  });

  test("tag_reflow_log INSERT 가동 (FK 없음 — 임의 node_id·concept_id 허용)", () => {
    const db = open();
    expect(() =>
      db.prepare(
        "INSERT INTO tag_reflow_log (log_id, node_id, parent_concept_id, trigger_hierarchy, detached_at) VALUES (?,?,?,?,?)",
      ).run("trl_x", 999999, "cpt_없는개념", "category→value", "2026-06-07 10:00:00"),
    ).not.toThrow();
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM tag_reflow_log").get() as CountRow).c;
    expect(cnt).toBe(1);
    db.close();
  });
});

describe("chunk_summaries · relation_summaries", () => {
  test("chunk_summaries default — has_embedding=0 + generated_at datetime", () => {
    const db = open();
    // FK 충족: knowledge_nodes 청크 노드 + documents(asset_files FK)
    const chunkId = seedChunkNode(db);
    seedDocument(db, "d1", "doc_1");
    insertChunkSummary(db, "cs_1", chunkId, "doc_1");
    const row = db
      .prepare("SELECT has_embedding, generated_at FROM chunk_summaries WHERE summary_id='cs_1'")
      .get() as { has_embedding: number; generated_at: string };
    expect(row.has_embedding).toBe(0);
    expect(row.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    db.close();
  });

  test("chunk_summaries FK cascade — 청크 노드 삭제 시 요약 동반 삭제", () => {
    const db = open();
    const chunkId = seedChunkNode(db);
    seedDocument(db, "d2", "doc_2");
    insertChunkSummary(db, "cs_fk", chunkId, "doc_2");

    db.prepare("DELETE FROM knowledge_nodes WHERE id = ?").run(chunkId);
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM chunk_summaries").get() as CountRow).c;
    expect(cnt).toBe(0);
    db.close();
  });

  test("chunk_summaries FK cascade — 문서 삭제 시 요약 동반 삭제", () => {
    const db = open();
    const chunkId = seedChunkNode(db);
    seedDocument(db, "d3", "doc_3");
    insertChunkSummary(db, "cs_fk2", chunkId, "doc_3");

    db.prepare("DELETE FROM documents WHERE document_id = 'doc_3'").run();
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM chunk_summaries").get() as CountRow).c;
    expect(cnt).toBe(0);
    db.close();
  });

  test("relation_summaries FK cascade — 출처 문서 삭제 시 관계요약 동반 삭제", () => {
    // from/to 가 개념 id(TEXT)라 FK 를 안 검는다. cascade 는 source_document_id(documents)
    // 기준 — 문서가 삭제되면 그 발굴 산출이 정리된다.
    const db = open();
    seedDocument(db, "rsd", "doc_rs");
    insertRelationSummary(db, "rs_1", "cpt_a", "cpt_b", "doc_rs");

    db.prepare("DELETE FROM documents WHERE document_id = 'doc_rs'").run();
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM relation_summaries").get() as CountRow).c;
    expect(cnt).toBe(0);
    db.close();
  });

  test("relation_summaries — 개념 id(cpt_/psn_)와 사람 id 를 from/to 에 함께 저장(FK 안 검음)", () => {
    // 개념·사람 두 부모를 한 TEXT 칸이 담는다 — 존재하지 않는 개념 id 라도 INSERT 통과
    // (실재 검증은 애플리케이션 게이트). 여기선 스키마가 FK 로 막지 않음만 확인.
    const db = open();
    seedDocument(db, "rsd2", "doc_rs2");
    expect(() => insertRelationSummary(db, "rs_mix", "cpt_x", "psn_y", "doc_rs2")).not.toThrow();
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM relation_summaries").get() as CountRow).c;
    expect(cnt).toBe(1);
    db.close();
  });

  test("chunk_summary_vec INSERT/KNN round-trip (384)", () => {
    const db = open();
    const chunkId = seedChunkNode(db);
    seedDocument(db, "dv", "doc_v");
    insertChunkSummary(db, "cs_v", chunkId, "doc_v");
    const sumRowid = (db.prepare("SELECT rowid FROM chunk_summaries WHERE summary_id='cs_v'").get() as { rowid: number }).rowid;

    db.prepare("INSERT INTO chunk_summary_vec (summary_rowid, embedding) VALUES (?, ?)")
      .run(sumRowid, makeEmbedding(7));
    const row = db
      .prepare("SELECT summary_rowid FROM chunk_summary_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 1")
      .get(makeEmbedding(7)) as { summary_rowid: number } | null;
    expect(row?.summary_rowid).toBe(sumRowid);
    db.close();
  });

  test("chunk_summary_vec 정리 트리거 — 요약 행 삭제 시 vec 행 정리", () => {
    const db = open();
    const chunkId = seedChunkNode(db);
    seedDocument(db, "dt", "doc_t");
    insertChunkSummary(db, "cs_t", chunkId, "doc_t");
    const sumRowid = (db.prepare("SELECT rowid FROM chunk_summaries WHERE summary_id='cs_t'").get() as { rowid: number }).rowid;
    db.prepare("INSERT INTO chunk_summary_vec (summary_rowid, embedding) VALUES (?, ?)").run(sumRowid, makeEmbedding(1));
    expect((db.prepare("SELECT COUNT(*) AS c FROM chunk_summary_vec").get() as CountRow).c).toBe(1);

    // 요약 행 직접 삭제 → 정리 트리거가 vec 행 정리.
    db.prepare("DELETE FROM chunk_summaries WHERE summary_id='cs_t'").run();
    expect((db.prepare("SELECT COUNT(*) AS c FROM chunk_summary_vec").get() as CountRow).c).toBe(0);
    db.close();
  });

  test("relation_summary_vec 정리 트리거 — 요약 행 삭제(문서 cascade) 시 vec 행 정리", () => {
    // vec 트리거는 relation_summaries.rowid 기준이라 from/to 칸 변경에 영향 0 —
    // 삭제 경로만 source_document_id(documents) cascade 다.
    const db = open();
    seedDocument(db, "rvt", "doc_rvt");
    insertRelationSummary(db, "rs_t", "cpt_a", "cpt_b", "doc_rvt");
    const sumRowid = (db.prepare("SELECT rowid FROM relation_summaries WHERE summary_id='rs_t'").get() as { rowid: number }).rowid;
    db.prepare("INSERT INTO relation_summary_vec (summary_rowid, embedding) VALUES (?, ?)").run(sumRowid, makeEmbedding(2));
    expect((db.prepare("SELECT COUNT(*) AS c FROM relation_summary_vec").get() as CountRow).c).toBe(1);

    // 출처 문서 삭제 → relation_summaries cascade 삭제 → 정리 트리거가 vec 행 정리.
    db.prepare("DELETE FROM documents WHERE document_id = 'doc_rvt'").run();
    expect((db.prepare("SELECT COUNT(*) AS c FROM relation_summaries").get() as CountRow).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM relation_summary_vec").get() as CountRow).c).toBe(0);
    db.close();
  });
});
