/**
 * summary-cycle.test-helpers.ts — 요약 사이클 테스트 공용 데이터 fixture 헬퍼.
 *
 * summary-cycle.test.ts 와 summary-cycle-partial-document.test.ts 가 같이 쓴다(파일 크기 상한
 * 800줄 정합으로 테스트를 나누며 헬퍼를 한곳에 모음). 전부 raw SQL 데이터 삽입·실 store 조립
 * 함수다 — 인터페이스 가짜 구현체(mock 클래스)는 없다. 실 bge-m3 임베더는 각 테스트 파일이
 * beforeAll 에서 올려 makeFixture 에 넘긴다.
 */

import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import type { Embedder } from "../../embedding/types.ts";
import type { SummaryCycleDeps } from "./summary-cycle.ts";
import type { SummaryInferFn } from "./summary-gates.ts";
import type { StageInferResult } from "./stage-execution.ts";

/** 실 bge-m3 모델 첫 로드 대기 상한(두 테스트 파일 공용). */
export const MODEL_LOAD_TIMEOUT_MS = 180_000;

/** 기본 deps 의 호출당 입력 상한 — 테스트 글이 상한에 닿지 않게 넉넉히(상한 동작은 따로 시험한다). */
export const ROOMY_PER_CALL_INPUT_CAP = 1_000_000;

/** 요약 raw 응답을 ok StageInferResult 로 감싸는 fixture 헬퍼(실행층 경유 계약). */
export function ok(json: string): StageInferResult<string> {
  return { kind: "ok", parsed: json };
}

/** 실 기준 스키마 + 실 embedder 로 store + raw db + eventBus 한 묶음. */
export interface SummaryCycleFixture {
  db: Database;
  store: SqliteMemoryStore;
  eventBus: SummaryCycleDeps["eventBus"];
  embedder: Embedder;
}

/**
 * 실 EventBus 는 server-internal 에 있어 이 비-test 파일이 직접 import 하면 계층 규율(G5-b,
 * events/layering.test.ts)에 걸린다 — 각 .test.ts 가 만들어 makeEventBus 로 넘긴다.
 */
export function makeFixture(
  embedder: Embedder,
  makeEventBus: (db: Database) => SummaryCycleDeps["eventBus"],
): SummaryCycleFixture {
  // bge-m3 1024 차원에 맞춘 vec0(요약 임베딩 테이블).
  // 가 깔려 임베딩 INSERT 가 차원 불일치로 throw 한다.
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const eventBus = makeEventBus(db);
  return { db, store, eventBus, embedder };
}

/** documents 행 한 개 삽입(FK 사슬 asset_files → documents). */
export function insertDocument(db: Database, docId: string): void {
  const sha = `sha_${docId}`;
  db.prepare(
    `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at)
     VALUES (?, 'text', ?, 10, 0)`,
  ).run(sha, `/tmp/${sha}.md`);
  db.prepare(
    `INSERT INTO documents (document_id, asset_sha256, title, document_type, chunk_count, created_at, updated_at)
     VALUES (?, ?, ?, 'text', 0, 0, 0)`,
  ).run(docId, sha, `doc ${docId}`);
}

/** document_chunk 노드 한 개 삽입(metadata.parentId + chunkIndex). */
export function insertChunk(
  db: Database,
  content: string,
  parentDocId: string,
  chunkIndex: number,
  createdAt = "2026-06-05 10:00:00",
): number {
  const meta = JSON.stringify({ parentId: parentDocId, chunkIndex });
  const info = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, metadata_json, created_at) VALUES (?, 'document_chunk', ?, ?)",
    )
    .run(content, meta, createdAt);
  return Number(info.lastInsertRowid);
}

/**
 * 청크에 atomic 자식 N건 + merged_into 엣지(child→chunk) 삽입(임계 충족). 회신은 만든
 * atomic 노드 id 목록 — 호출자가 이 atomic 에 개념·사람 엣지를 달아 허용 개념 집합을
 * 만든다(extractor 가 atomic 에 개념을 붙이는 실 흐름 정합).
 */
export function attachAtomics(db: Database, chunkId: number, count: number): number[] {
  const atomicIds: number[] = [];
  for (let i = 0; i < count; i++) {
    const info = db
      .prepare(
        "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'llm_extract', '2026-06-05 10:00:01')",
      )
      .run(`atomic-${chunkId}-${i}`);
    const atomicId = Number(info.lastInsertRowid);
    db.prepare(
      "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (?, ?, 'merged_into', 'user_input', NULL)",
    ).run(atomicId, chunkId);
    atomicIds.push(atomicId);
  }
  return atomicIds;
}

/** 개념 노드(cpt_) 한 개 삽입 후 그 concept_id 회신. */
export function insertConcept(db: Database, conceptId: string, name: string): string {
  db.prepare(
    "INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)",
  ).run(conceptId, name);
  return conceptId;
}

/** atomic 노드 → 개념(node_concept_edges, role='mention'). */
export function linkConcept(db: Database, atomicId: number, conceptId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, 'mention', 'user_input', NULL)",
  ).run(atomicId, conceptId);
}

/** 사람 노드(psn_) 한 개 삽입 후 person_id 회신. */
export function insertPerson(db: Database, personId: string, displayName: string): string {
  db.prepare(
    "INSERT INTO persons (person_id, display_name) VALUES (?, ?)",
  ).run(personId, displayName);
  return personId;
}

/** atomic 노드 → 사람(node_person_edges, relation='mentions'). collectChunkSetConcepts 의
 *  node_person_edges UNION 갈래로 그 묶음 허용 개념 집합에 psn_ 가 들어간다. */
export function linkPerson(db: Database, atomicId: number, personId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO node_person_edges (node_id, person_id, relation, provenance, source_node_id) VALUES (?, ?, 'mentions', 'user_input', NULL)",
  ).run(atomicId, personId);
}

/** chunk_summaries 행 직접 삽입 — "이미 요약이 끝난 같은 문서 청크" fixture(후보에서 빠진다). */
export function insertChunkSummaryRow(db: Database, chunkId: number, docId: string): void {
  db.prepare(
    `INSERT INTO chunk_summaries (summary_id, parent_chunk_id, parent_document_id, summary_text, generated_by)
     VALUES (?, ?, ?, '이미 끝난 요약', 'llm')`,
  ).run(`cs_fixture_${chunkId}`, chunkId, docId);
}

/** relation_summaries 행 직접 삽입 — 앞선 묶음이 이미 저장한 관계 fixture(임베딩 없이 표만). */
export function insertRelationSummaryRow(
  db: Database,
  fromConceptId: string,
  toConceptId: string,
  docId: string,
): void {
  db.prepare(
    `INSERT INTO relation_summaries (summary_id, from_concept_id, to_concept_id, relation_name, summary_text, confidence, generated_by, source_document_id)
     VALUES (?, ?, ?, '앞선 관계', '앞선 관계 한 문장', 0.9, 'llm', ?)`,
  ).run(`rs_fixture_${fromConceptId}_${toConceptId}`, fromConceptId, toConceptId, docId);
}

/** atomicThreshold=4·batchSize=50·임계 0.6·firstParagraphMaxChars=300 기본 deps. */
export function baseDeps(
  fx: SummaryCycleFixture,
  infer: SummaryInferFn | null,
): SummaryCycleDeps {
  return {
    db: fx.db,
    store: fx.store,
    embedder: fx.embedder,
    infer,
    eventBus: fx.eventBus,
    atomicThreshold: 4,
    batchSize: 50,
    relationConfidenceThreshold: 0.6,
    firstParagraphMaxChars: 300,
    stageVersion: 1,
    maxAttemptsPerTarget: 3,
    perCallInputCap: ROOMY_PER_CALL_INPUT_CAP,
  };
}
