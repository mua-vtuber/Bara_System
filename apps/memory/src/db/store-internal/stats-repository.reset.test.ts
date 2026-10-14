/**
 * stats-repository.reset.test.ts — resetAllMemory(데이터 초기화)가 정리 작업 표와 사용자 사전을 비우고,
 * 코드 상수 종류·정규식 학습 자산·짝 표·스키마 버전은 남기는지, 그리고 스키마의 모든 표가 "비움 / 연쇄 삭제 /
 * 보존 / 색인 미러" 넷 중 하나로 분류돼 있는지(새 표를 조용히 빠뜨리지 못하게) 확인한다.
 *
 * Mock 0: 실제 임시 SQLite 파일(openMemoryDatabase 기준 스키마) + 실제 저장소·사전 repo. 모델 적재가
 * 필요 없다 — resetAllMemory 는 임베딩을 쓰지 않으므로 적재 안 한 실제 Bgem3Embedder 를 넘긴다.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ClassifyVocabOverrideRepo } from "../../memory/classify-vocab/classify-vocab-override-repo.ts";
import { ClassifyVocabUserRepo } from "../../memory/classify-vocab/classify-vocab-user-repo.ts";
import { RelationNameUserRepo } from "../../memory/relation-vocab/relation-name-user-repo.ts";
import { SynonymUserRepo } from "../../memory/synonyms/synonym-user-repo.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { EntityTypeRegistryDb } from "./entity-type-registry-db.ts";
import { StatsRepository } from "./stats-repository.ts";

const DIM = 1024;

let dir: string;
let db: Database;
let repo: StatsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-reset-"));
  db = openMemoryDatabase(join(dir, "memory.db"), { embeddingDim: DIM });
  repo = new StatsRepository(db, new Bgem3Embedder());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function count(table: string): number {
  return (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

/** 정리 작업 표 셋에 한 행씩 채운다(원시 INSERT fixture — 실제 정리 실행 없이 표 내용만 검증). */
function seedCleanupTables(): void {
  db.run(
    `INSERT INTO cleanup_proposal_item_journal (proposal_id, item_key, status, detail)
     VALUES ('prop-1', 'columns:가격', 'applied', '적용 상세')`,
  );
  db.run(
    `INSERT INTO cleanup_stage_results
       (stage, target_key, status, input_fingerprint, stage_version, attempt_count, last_error)
     VALUES ('regex_strengthen', '1', 'terminal_failure', 'fp-old', 1, 3, '옛 오류 메시지')`,
  );
  db.run(
    `INSERT INTO cleanup_runs (run_id, trigger, status, options_json, aggregates_json, idempotency_key)
     VALUES ('run-1', 'manual', 'completed', '{"stages":["summary"]}', '{"summary":{"processed":1}}', 'idem-1')`,
  );
}

/** 사용자 사전 다섯 표에 한 행씩 채운다 — 실제 repo 로 넣는다. */
function seedUserVocabulary(): void {
  new SynonymUserRepo(db).addEntry({ term: "고양이", synonym: "냥이", lang: "ko" });
  new ClassifyVocabUserRepo(db).addEntry({ typeName: "work", slot: "synonyms", value: "창작물" });
  new ClassifyVocabOverrideRepo(db).addOverride({
    typeName: "work",
    slot: "synonyms",
    value: "기본단어",
  });
  new RelationNameUserRepo(db).addEntry({
    relationKey: "구독처",
    relationName: "subscribed_to",
    sourceTypes: ["work"],
    targetTypes: ["person"],
    defaultTargetType: "person",
  });
  new EntityTypeRegistryDb(db).addEntityType({
    typeName: "vehicle",
    koName: "탈것",
    idPrefix: "veh_",
  });
}

/** 보존 표(정규식 학습 자산·짝 표)에 한 행씩 채운다. schema_version·memory_visibility_state 는 스키마가 이미 채운다. */
function seedKeptTables(): void {
  db.run(
    `INSERT INTO regex_user_patterns (pattern_id, pattern_text, score, category, created_at, updated_at)
     VALUES ('rpat_user_1', '결정했다', 3, 'decision', '2026-09-01 00:00:00', '2026-09-01 00:00:00')`,
  );
  db.run(
    `INSERT INTO regex_user_boosters (booster_id, word, score, created_at, updated_at)
     VALUES ('rbst_user_1', '확정', 2, '2026-09-01 00:00:00', '2026-09-01 00:00:00')`,
  );
  db.run(
    `INSERT INTO asset_folder_pairing (id, pairing_id, created_at)
     VALUES (1, 'pair-1', '2026-09-01 00:00:00')`,
  );
}

describe("resetAllMemory — 정리 작업 표와 사용자 사전", () => {
  test("정리 작업 표 셋이 비워지고 boundary 에 센다", () => {
    seedCleanupTables();
    db.run(
      `INSERT INTO cleanup_proposals (id, kind, payload_json) VALUES ('prop-1', 'lens_draft', '{}')`,
    );

    const counts = repo.resetAllMemory();

    expect(count("cleanup_proposal_item_journal")).toBe(0);
    expect(count("cleanup_stage_results")).toBe(0);
    expect(count("cleanup_runs")).toBe(0);
    expect(count("cleanup_proposals")).toBe(0);
    // 제안 1 + 원장 1 + 단계 결과 1 + 실행 1.
    expect(counts.boundary).toBe(4);
    expect(counts.userVocabulary).toBe(0);
    expect(counts.totalRowsDeleted).toBe(4);
  });

  test("사용자 사전 다섯 표가 비워지고 userVocabulary 에 센다", () => {
    seedUserVocabulary();
    expect(count("synonym_user_entries")).toBe(1);
    expect(count("classify_vocab_user_entries")).toBe(1);
    expect(count("classify_vocab_overrides")).toBe(1);
    expect(count("relation_name_user_entries")).toBe(1);
    expect(count("entity_types")).toBe(1);

    const counts = repo.resetAllMemory();

    expect(count("synonym_user_entries")).toBe(0);
    expect(count("classify_vocab_user_entries")).toBe(0);
    expect(count("classify_vocab_overrides")).toBe(0);
    expect(count("relation_name_user_entries")).toBe(0);
    expect(count("entity_types")).toBe(0);
    expect(counts.userVocabulary).toBe(5);
    expect(counts.totalRowsDeleted).toBe(5);
    // 앱이 읽는 길로도 비어 있다.
    expect(new EntityTypeRegistryDb(db).listUserEntityTypes()).toEqual([]);
    expect(new SynonymUserRepo(db).listEntries()).toEqual([]);
  });

  test("entity_types — 사용자 종류만 지우고 코드 상수 이름의 행은 남긴다", () => {
    const registry = new EntityTypeRegistryDb(db);
    registry.addEntityType({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
    registry.addEntityType({ typeName: "recipe", koName: "요리법", idPrefix: "rcp_" });
    // 앱은 코드 상수 종류를 이 표에 넣지 않는다(addEntityType 이 막는다). 방어선만 확인하려고 원시 INSERT.
    db.run(
      `INSERT INTO entity_types (type_name, ko_name, id_prefix) VALUES ('work', '작품', 'wrk_')`,
    );

    const counts = repo.resetAllMemory();

    const left = db.query("SELECT type_name FROM entity_types").all() as { type_name: string }[];
    expect(left.map((r) => r.type_name)).toEqual(["work"]);
    expect(counts.userVocabulary).toBe(2);
  });

  test("정규식 학습 자산·짝 표·schema_version·가시성 번호 행은 남는다", () => {
    seedKeptTables();
    seedUserVocabulary();
    const versionBefore = db.query("SELECT MAX(version) AS v FROM schema_version").get();

    repo.resetAllMemory();

    expect(count("regex_user_patterns")).toBe(1);
    expect(count("regex_user_boosters")).toBe(1);
    expect(count("asset_folder_pairing")).toBe(1);
    expect(db.query("SELECT MAX(version) AS v FROM schema_version").get()).toEqual(versionBefore);
    expect(count("memory_visibility_state")).toBe(1);
  });

  test("모든 칸이 채워진 DB — 개수 합과 totalRowsDeleted 가 맞고 전부 비워진다", () => {
    db.run("INSERT INTO knowledge_nodes (id, content) VALUES (1, '기억 하나')");
    seedCleanupTables();
    seedUserVocabulary();
    seedKeptTables();

    const counts = repo.resetAllMemory();

    expect(counts.knowledgeNodes).toBe(1);
    expect(counts.boundary).toBe(3);
    expect(counts.userVocabulary).toBe(5);
    expect(counts.totalRowsDeleted).toBe(1 + 3 + 5);
  });

  test("초기화 뒤 번호가 1 부터 다시 쓰여도 옛 단계 결과 행이 남아 있지 않다", () => {
    db.run("INSERT INTO knowledge_nodes (id, content) VALUES (1, '초기화 전 기억')");
    seedCleanupTables(); // target_key '1' — 초기화 뒤 새 기억의 번호와 같다.

    repo.resetAllMemory();
    db.run("INSERT INTO knowledge_nodes (content) VALUES ('초기화 뒤 첫 기억')");

    const newId = (db.query("SELECT MAX(id) AS id FROM knowledge_nodes").get() as { id: number }).id;
    expect(newId).toBe(1);
    expect(
      db.query("SELECT 1 FROM cleanup_stage_results WHERE target_key = ?").get(String(newId)),
    ).toBeNull();
  });
});

/**
 * 스키마 표 분류 가드 — 새 표가 생기면 이 목록에 넣어야 통과한다. 넣는 순간 "초기화가 비우는가, 부모를
 * 따라 지워지는가, 일부러 남기는가" 중 하나를 골라야 하므로 사용자 내용이 담긴 표를 조용히 빠뜨릴 수 없다.
 */
describe("스키마 표 분류 가드", () => {
  /** resetAllMemory 가 명시 DELETE 로 비우는 표 — 소스의 wipe("…")·DELETE FROM 과 아래에서 대조한다. */
  const WIPED_EXPLICIT = [
    "asset_file_imports",
    "asset_files",
    "backfill_attempts",
    "chunk_summaries",
    "classify_vocab_overrides",
    "classify_vocab_user_entries",
    "cleanup_proposal_item_journal",
    "cleanup_proposals",
    "cleanup_runs",
    "cleanup_stage_results",
    "concept_alias_suggestions",
    "concept_edges",
    "concept_nodes",
    "document_ocr_daily_usage",
    "document_ocr_page_results",
    "document_record_owners",
    "documents",
    "entities",
    "entity_concept_edges",
    "entity_register_ignores",
    "entity_register_records",
    "entity_relation_edges",
    "entity_types", // 사용자 종류 행만 — 코드 상수 이름 행은 남긴다.
    "events",
    "evolver_activity",
    "hierarchy_edges",
    "images",
    "knowledge_edges",
    "knowledge_nodes",
    "knowledge_nodes_archive",
    "memory_revisions",
    "node_concept_edges",
    "node_person_edges",
    "persons",
    "project_vocabularies",
    "relation_name_user_entries",
    "relation_summaries",
    "synonym_user_entries",
    "tag_reflow_log",
  ];

  /** 부모 삭제 때 ON DELETE CASCADE 로 따라 지워지는 표(자식 → 연쇄 부모는 PRAGMA 로 확인). */
  const CASCADED = [
    "entity_attributes",
    "memory_mutations",
    "memory_node_sources",
    "memory_node_sources_archive",
    "memory_source_events",
  ];

  /** 일부러 남기는 표와 그 이유. */
  const KEPT: Record<string, string> = {
    schema_version: "시작 때 버전 판정을 통과하려면 기록이 있어야 한다",
    regex_user_patterns: "사용자가 길들인 정규식 학습 자산",
    regex_user_boosters: "사용자가 길들인 정규식 학습 자산",
    asset_folder_pairing: "첨부 폴더 표시 파일과 같은 번호 — 지우면 DB 와 폴더 짝이 깨진다",
    memory_visibility_state: "스키마가 시드한 한 줄짜리 가시성 세대 번호(글 삭제 트리거가 올린다)",
  };

  function schemaTables(): { plain: string[]; virtual: string[] } {
    const rows = db
      .query("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string; sql: string | null }[];
    const virtual = rows
      .filter((r) => /^CREATE VIRTUAL TABLE/i.test(r.sql ?? ""))
      .map((r) => r.name);
    // 가상 표의 그림자 표(<이름>_data·_config·_chunks …)는 가상 표가 관리하는 내부 구조라 분류 대상이 아니다.
    const isShadow = (name: string): boolean => virtual.some((v) => name.startsWith(`${v}_`));
    const plain = rows
      .map((r) => r.name)
      .filter((n) => n !== "sqlite_sequence" && !virtual.includes(n) && !isShadow(n));
    return { plain, virtual };
  }

  test("모든 일반 표가 비움·연쇄·보존 중 정확히 하나에 들어 있다", () => {
    const { plain } = schemaTables();
    const classified = [...WIPED_EXPLICIT, ...CASCADED, ...Object.keys(KEPT)];

    // 중복 분류 없음.
    expect(new Set(classified).size).toBe(classified.length);
    // 분류에 없는 표(새 표) / 스키마에 없는 이름(없어진 표) 둘 다 실패.
    expect(plain.filter((t) => !classified.includes(t))).toEqual([]);
    expect(classified.filter((t) => !plain.includes(t))).toEqual([]);
  });

  test("WIPED_EXPLICIT 가 resetAllMemory 소스의 실제 삭제 대상과 같다", () => {
    const source = readFileSync(new URL("./stats-repository.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("  resetAllMemory(): ResetMemoryCounts {"));
    const end = body.indexOf("    tx();");
    const fn = body.slice(0, end);
    const targets = new Set<string>();
    for (const m of fn.matchAll(/wipe\("([a-z_]+)"\)/g)) targets.add(m[1]!);
    for (const m of fn.matchAll(/DELETE FROM ([a-z_]+)/g)) targets.add(m[1]!);
    targets.delete("sqlite_sequence");
    expect([...targets].sort()).toEqual([...WIPED_EXPLICIT].sort());
  });

  test("연쇄 표는 비워지는 부모를 ON DELETE CASCADE 로 참조한다", () => {
    const wiped = new Set(WIPED_EXPLICIT);
    for (const table of CASCADED) {
      const fks = db.query(`PRAGMA foreign_key_list(${table})`).all() as {
        table: string;
        on_delete: string;
      }[];
      const cascadesFromWiped = fks.some((fk) => fk.on_delete === "CASCADE" && wiped.has(fk.table));
      expect({ table, cascadesFromWiped }).toEqual({ table, cascadesFromWiped: true });
    }
  });

  test("색인 미러(FTS·vec0)는 모두 부모 삭제 트리거가 정리한다 — 초기화 뒤 0 행", () => {
    db.run("INSERT INTO knowledge_nodes (id, content) VALUES (1, '검색 미러 확인')");
    repo.resetAllMemory();
    const { virtual } = schemaTables();
    expect(virtual.length).toBeGreaterThan(0);
    for (const name of virtual) {
      const table = db.query(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number };
      expect({ name, rows: table.c }).toEqual({ name, rows: 0 });
    }
  });
});
