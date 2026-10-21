/**
 * summary-candidate-query.test.ts — 요약 단계 후보 검출 통합 검증 (Task 4).
 *
 * 실 `:memory:` SQLite(실 기준 스키마 · sqlite-vec 로드) 로 돈다 —
 * mock 객체 0. document_chunk 노드 · merged_into llm_extract 자식 · chunk_summaries /
 * relation_summaries 행은 raw SQL 로 직접 삽입한다(데이터 fixture 만 / 인터페이스 가짜
 * 구현체 0).
 *
 * 검증:
 *   - 청크요약 후보 = source_type='document_chunk' + atomic(merged_into llm_extract 자식)
 *     수 ≥ atomicThreshold + chunk_summaries 행 아직 없음. atomic 4건 포함 · 3건 제외.
 *   - 멱등 = chunk_summaries 행 생기면 다음 호출에서 제외.
 *   - batchSize 제한 + 사용 이력 소비 정렬(spec 5-5 — candidate-query.ts 와 동일 공식).
 *   - 각 후보에 atomics(LLM 입력 닻) + content + parentId(문서 id) + chunkIndex 를 단다.
 *   - 호출 묶음(planSummaryCalls) = parentId(문서) 별 + 한 호출 청크 수 상한씩 자르기.
 *   - 각 묶음의 허용 개념 집합(relationConcepts)은 *그 묶음 청크* 의 atomic 에서 닿는 개념만
 *     (2026-10-19 — 같은 문서의 묶음 밖 청크 개념은 넣지 않는다). 2개 미만이면 null(관계 skip).
 *   - 관계 발굴 멱등은 청크 묶음 단위 — 문서에 relation_summaries 행이 있어도 새 청크 묶음은
 *     관계 발굴을 받는다(옛 문서 단위 영구 마감 폐기). 같은 문서 기존 쌍은
 *     listRelationPairsForDocument 로 가른다(방향 무관 relationPairKey).
 *   - collectChunkSetConcepts = 청크→atomic→node_concept_edges(개념) ∪
 *     node_person_edges(사람) UNION. DISTINCT.
 */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import {
  collectChunkSetConcepts,
  findChunkSummaryCandidates,
  listRelationPairsForDocument,
  planSummaryCalls,
  relationPairKey,
} from "./summary-candidate-query.ts";

/** 테스트용 호출 청크 수 상한 — 자르기를 따로 보는 테스트 밖에서는 넉넉히 둬 문서당 한 묶음. */
const ROOMY_MAX_CHUNKS_PER_CALL = 50;

/** 실 기준 스키마를 적용한 :memory: DB(sqlite-vec 로드 포함). */
function makeSchemaDb(): Database {
  return openMemoryDatabase(":memory:", { embeddingDim: 384 });
}

/**
 * document_chunk 노드 한 개 삽입 후 id 반환. metadata 에 parentId(문서 id) + chunkIndex
 * 를 담는다 — ingest-document.ts 가 만드는 실제 청크 노드 양식 정합(권위 = metadata.parentId).
 */
function insertChunk(
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
 * 청크의 atomic 자식 한 개 + merged_into 엣지(child→chunk) 삽입.
 * 스케줄러 addEdge 방향(sourceId=childId, targetId=chunk, relation='merged_into') 정합.
 */
function insertAtomic(db: Database, chunkId: number, content: string): number {
  const info = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'llm_extract', '2026-06-05 10:00:01')",
    )
    .run(content);
  const childId = Number(info.lastInsertRowid);
  db.prepare(
    "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (?, ?, 'merged_into', 'user_input', NULL)",
  ).run(childId, chunkId);
  return childId;
}

/**
 * document_chunk 노드를 memory_type 지정해 삽입(선호 트랙 배제 검증 fixture 전용).
 * insertChunk 와 달리 memory_type 칸을 명시한다(기본값 'fact' 대신). 실 저장 경로는
 * 청크에 memoryType 을 넘기지 않아 항상 'fact' 로 찍히지만(save-input-plain.ts
 * saveChunks), 이 테스트는 SQL WHERE 절 자체의 배제 로직을 직접 검증한다 —
 * 미래에 청크 생성 경로가 memoryType 을 물려받게 바뀌어도 안전망이 이미 있음을 보장.
 */
function insertChunkWithMemoryType(
  db: Database,
  content: string,
  parentDocId: string,
  chunkIndex: number,
  memoryType: string,
  createdAt = "2026-06-05 10:00:00",
): number {
  const meta = JSON.stringify({ parentId: parentDocId, chunkIndex });
  const info = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, memory_type, metadata_json, created_at) VALUES (?, 'document_chunk', ?, ?, ?)",
    )
    .run(content, memoryType, meta, createdAt);
  return Number(info.lastInsertRowid);
}

/** atomic N개를 한 청크에 단다(내용은 자동 번호) — 생성된 atomic id 목록 반환. */
function attachAtomics(db: Database, chunkId: number, count: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(insertAtomic(db, chunkId, `atomic-${chunkId}-${i}`));
  }
  return ids;
}

/**
 * documents 행 한 개 삽입(FK 충족 — chunk_summaries.parent_document_id REFERENCES
 * documents · documents.asset_sha256 REFERENCES asset_files). foreign_keys = ON 이라
 * asset_files → documents 순서로 FK 사슬을 전부 채운다.
 */
function insertDocument(db: Database, docId: string): void {
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

/** chunk_summaries 행 한 개 직접 삽입(멱등 제외 fixture). */
function insertChunkSummaryRow(
  db: Database,
  summaryId: string,
  chunkId: number,
  docId: string,
): void {
  db.prepare(
    `INSERT INTO chunk_summaries (summary_id, parent_chunk_id, parent_document_id, summary_text, generated_by)
     VALUES (?, ?, ?, '요약 한 문장', 'llm')`,
  ).run(summaryId, chunkId, docId);
}

/**
 * relation_summaries 행 한 개 직접 삽입(문서 단위 관계 멱등 제외 fixture). Task 11
 * 스키마 — from/to 는 개념 id(TEXT) · 멱등 판정 권위는 source_document_id 다.
 */
function insertRelationSummaryRow(
  db: Database,
  summaryId: string,
  fromConceptId: string,
  toConceptId: string,
  sourceDocId: string,
): void {
  db.prepare(
    `INSERT INTO relation_summaries (summary_id, from_concept_id, to_concept_id, relation_name, summary_text, confidence, generated_by, source_document_id)
     VALUES (?, ?, ?, '연관', '관계 한 문장', 0.8, 'llm', ?)`,
  ).run(summaryId, fromConceptId, toConceptId, sourceDocId);
}

/** concept_nodes 행 한 개 삽입 후 concept_id 반환('cpt_' 접두사). */
function insertConcept(db: Database, name: string): string {
  const conceptId = `cpt_${name}`;
  db.prepare(
    "INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)",
  ).run(conceptId, name);
  return conceptId;
}

/** persons 행 한 개 삽입 후 person_id 반환('psn_' 접두사). */
function insertPerson(db: Database, displayName: string): string {
  const personId = `psn_${displayName}`;
  db.prepare(
    "INSERT INTO persons (person_id, display_name) VALUES (?, ?)",
  ).run(personId, displayName);
  return personId;
}

/** atomic 노드 → 개념 엣지(node_concept_edges) 한 줄. role 무관. */
function linkConcept(db: Database, atomicId: number, conceptId: string, role = "mention"): void {
  db.prepare(
    "INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, ?, 'user_input', NULL)",
  ).run(atomicId, conceptId, role);
}

/** atomic 노드 → 사람 엣지(node_person_edges) 한 줄. relation 무관. */
function linkPerson(db: Database, atomicId: number, personId: string, relation = "mentions"): void {
  db.prepare(
    "INSERT INTO node_person_edges (node_id, person_id, relation, provenance, source_node_id) VALUES (?, ?, ?, 'user_input', NULL)",
  ).run(atomicId, personId, relation);
}

test("atomic ≥ 임계인 document_chunk 만 청크요약 후보(4건 포함 · 3건 제외)", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-a");
  // ⓐ atomic 4건 청크 — 포함.
  const four = insertChunk(db, "긴 문서 첫 조각", "doc-a", 0, "2026-06-05 10:00:00");
  attachAtomics(db, four, 4);
  // ⓑ atomic 3건 청크 — 임계 미만 제외.
  const three = insertChunk(db, "짧은 조각", "doc-a", 1, "2026-06-05 10:01:00");
  attachAtomics(db, three, 3);

  const got = findChunkSummaryCandidates(db, 4, 50);
  expect(got.map((c) => c.chunkId)).toEqual([four]);
  expect(got[0]?.content).toBe("긴 문서 첫 조각");
  expect(got[0]?.parentId).toBe("doc-a");
  expect(got[0]?.chunkIndex).toBe(0);
  expect(got[0]?.atomics.sort()).toEqual(
    ["atomic-" + four + "-0", "atomic-" + four + "-1", "atomic-" + four + "-2", "atomic-" + four + "-3"].sort(),
  );
  db.close();
});

test("document_chunk 아닌 노드는 청크요약 후보 아님(auto_capture atomic 4건도 제외)", () => {
  const db = makeSchemaDb();
  // auto_capture 글에 atomic 4건 — source_type 이 document_chunk 가 아니라 제외.
  const raw = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES ('평범한 회상', 'auto_capture', '2026-06-05 10:00:00')",
    )
    .run();
  attachAtomics(db, Number(raw.lastInsertRowid), 4);

  expect(findChunkSummaryCandidates(db, 4, 50)).toEqual([]);
  db.close();
});

test("OCR 미완료 문서 청크는 atomic 이 충분해도 청크요약 후보 아님", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-needs-ocr");
  db.prepare("UPDATE documents SET source_metadata = ? WHERE document_id = ?").run(
    JSON.stringify({
      parse: {
        status: "needs_ocr",
        method: "tier1",
        originalAssetSha256: "sha_doc-needs-ocr",
        warnings: [],
      },
    }),
    "doc-needs-ocr",
  );
  const chunk = insertChunk(db, "OCR 전 문서 조각", "doc-needs-ocr", 0);
  attachAtomics(db, chunk, 5);

  expect(findChunkSummaryCandidates(db, 4, 50)).toEqual([]);
  db.close();
});

test("이미 chunk_summaries 행 있는 청크는 멱등 제외(다음 호출 0)", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-a");
  const chunk = insertChunk(db, "긴 문서 조각", "doc-a", 0);
  attachAtomics(db, chunk, 5);

  // 첫 호출 — 후보로 잡힘.
  expect(findChunkSummaryCandidates(db, 4, 50).map((c) => c.chunkId)).toEqual([chunk]);

  // chunk_summaries 행 생성 → 다음 호출에서 제외.
  insertChunkSummaryRow(db, "cs_1", chunk, "doc-a");
  expect(findChunkSummaryCandidates(db, 4, 50)).toEqual([]);
  db.close();
});

test("batchSize 제한 + last_accessed_at ASC 정렬(access_count 0 · 미접근 동률)", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-a");
  // 세 후보를 created_at 역순으로 삽입 — access_count 가 전부 0(미접근)일 때는
  // COALESCE(last_accessed_at, created_at) 가 곧 created_at 이라 시각순(ASC) 정렬로
  // 귀결되는지 본다.
  const c3 = insertChunk(db, "셋째", "doc-a", 2, "2026-06-05 12:00:00");
  attachAtomics(db, c3, 4);
  const c1 = insertChunk(db, "첫째", "doc-a", 0, "2026-06-05 10:00:00");
  attachAtomics(db, c1, 4);
  const c2 = insertChunk(db, "둘째", "doc-a", 1, "2026-06-05 11:00:00");
  attachAtomics(db, c2, 4);
  db.prepare("UPDATE knowledge_nodes SET last_accessed_at = created_at WHERE id IN (?, ?, ?)").run(c1, c2, c3);

  // batchSize 2 → 가장 이른 두 개만(c1, c2), 시각순.
  const got = findChunkSummaryCandidates(db, 2 /* 임계는 낮춰도 정렬 검증 영향 0 */, 2);
  expect(got.map((c) => c.chunkId)).toEqual([c1, c2]);
  db.close();
});

test("자주 열어본 청크는 access_count damping 으로 뒤로 밀림(spec 5-5)", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-a");
  // old = 더 오래전 생성·접근이지만 access_count 50 이라 정렬 키가 뒤로 밀린다.
  // recent = 더 최근 생성·접근이지만 access_count 0(미접근)이라 그대로.
  const old = insertChunk(db, "오래된 조각", "doc-a", 0, "2026-06-05 10:00:00");
  attachAtomics(db, old, 4);
  const recent = insertChunk(db, "최근 조각", "doc-a", 1, "2026-06-05 10:30:00");
  attachAtomics(db, recent, 4);
  db.prepare(
    "UPDATE knowledge_nodes SET last_accessed_at = '2026-06-05 10:05:00', access_count = 50 WHERE id = ?",
  ).run(old);
  db.prepare(
    "UPDATE knowledge_nodes SET last_accessed_at = '2026-06-05 10:30:00', access_count = 0 WHERE id = ?",
  ).run(recent);

  const got = findChunkSummaryCandidates(db, 4, 50);
  expect(got.map((c) => c.chunkId)).toEqual([recent, old]);
  db.close();
});

test("last_accessed_at 는 스키마가 NOT NULL 로 강제 — COALESCE 방어는 미래 대비(정직 가드 근거 확인)", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-a");
  // candidate-query.test.ts 동일 테스트 참조 — ACCESS_ORDER_EXPR 의 COALESCE 는 미래에
  // 컬럼이 nullable 로 바뀌는 경우에 대한 방어다. document_chunk 도 같은
  // knowledge_nodes 테이블이라 동일하게 NOT NULL 제약을 받는다(raw UPDATE 로도
  // NULL 주입이 SQLiteError 로 거부됨을 확인).
  const chunk = insertChunk(db, "널 조각", "doc-a", 0, "2026-06-05 09:00:00");
  expect(() => {
    db.prepare("UPDATE knowledge_nodes SET last_accessed_at = NULL WHERE id = ?").run(chunk);
  }).toThrow(/NOT NULL constraint failed: knowledge_nodes\.last_accessed_at/);
  db.close();
});

test("선호(memory_type='preference') document_chunk 는 atomic 임계 충족해도 후보 제외 — 사실(fact) 청크는 포함(spec H 후반)", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-a");
  // 선호 청크 — atomic 4건으로 다른 조건은 전부 충족한다.
  const pref = insertChunkWithMemoryType(db, "선호 조각", "doc-a", 0, "preference", "2026-06-05 10:00:00");
  attachAtomics(db, pref, 4);
  // 대조군 — 같은 조건의 사실(fact) 청크는 그대로 후보에 남는다.
  const fact = insertChunkWithMemoryType(db, "사실 조각", "doc-a", 1, "fact", "2026-06-05 10:01:00");
  attachAtomics(db, fact, 4);

  const got = findChunkSummaryCandidates(db, 4, 50);
  expect(got.map((c) => c.chunkId)).toEqual([fact]);
  db.close();
});

test("collectChunkSetConcepts = 청크→atomic→개념 ∪ 사람 UNION · DISTINCT", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-a");
  // 청크 2개 · 각 atomic 2건. 한 atomic 은 개념 둘, 다른 atomic 은 사람 하나.
  const c0 = insertChunk(db, "A 첫 조각", "doc-a", 0, "2026-06-05 10:00:00");
  const [a00, a01] = attachAtomics(db, c0, 2);
  const c1 = insertChunk(db, "A 둘째 조각", "doc-a", 1, "2026-06-05 10:01:00");
  const [a10] = attachAtomics(db, c1, 1);

  const kotlin = insertConcept(db, "코틀린");
  const compose = insertConcept(db, "컴포즈");
  const sumin = insertPerson(db, "수민");
  // a00 → 코틀린(tag) · 컴포즈(mention). a01 → 코틀린(role 다름 — DISTINCT 로 1건).
  linkConcept(db, a00!, kotlin, "tag");
  linkConcept(db, a00!, compose, "mention");
  linkConcept(db, a01!, kotlin, "mention");
  // a10 → 사람 수민(mentions).
  linkPerson(db, a10!, sumin, "mentions");

  const got = collectChunkSetConcepts(db, [c0, c1]);
  // 개념 2(코틀린·컴포즈) + 사람 1(수민) = 3건. 코틀린은 role 다른 두 엣지여도 1건.
  expect(got.map((x) => x.conceptId).sort()).toEqual(
    [kotlin, compose, sumin].sort(),
  );
  const byId = new Map(got.map((x) => [x.conceptId, x.name]));
  expect(byId.get(kotlin)).toBe("코틀린");
  expect(byId.get(compose)).toBe("컴포즈");
  expect(byId.get(sumin)).toBe("수민");
  db.close();
});

test("collectChunkSetConcepts 는 atomic 자체를 개념으로 세지 않고, 묶음 밖 청크 개념(같은 문서 포함)도 넣지 않는다", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-a");
  insertDocument(db, "doc-b");
  const a0 = insertChunk(db, "A 첫 조각", "doc-a", 0);
  const [a0Atom] = attachAtomics(db, a0, 1);
  const a1 = insertChunk(db, "A 둘째 조각", "doc-a", 1);
  const [a1Atom] = attachAtomics(db, a1, 1);
  const b0 = insertChunk(db, "B 조각", "doc-b", 0);
  const [bAtom] = attachAtomics(db, b0, 1);
  const cA0 = insertConcept(db, "doc-a-첫청크-개념");
  const cA1 = insertConcept(db, "doc-a-둘째청크-개념");
  const cB = insertConcept(db, "doc-b-개념");
  linkConcept(db, a0Atom!, cA0);
  linkConcept(db, a1Atom!, cA1);
  linkConcept(db, bAtom!, cB);

  // a0 만 실은 묶음 — 같은 문서 a1 의 개념도, 다른 문서 개념도 없다. atomic 노드 id 도 없다.
  expect(collectChunkSetConcepts(db, [a0]).map((x) => x.conceptId)).toEqual([cA0]);
  // 청크가 없으면 개념도 없다.
  expect(collectChunkSetConcepts(db, [])).toEqual([]);
  db.close();
});

test("호출 묶음 = parentId 별 그룹핑 + 각 묶음에 그 묶음 청크의 허용 개념 집합(relationConcepts)", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-a");
  insertDocument(db, "doc-b");
  // doc-a 청크 2개(개념 2건) + doc-b 청크 1개(개념 2건) — 둘 다 쌍 성립.
  const a0 = insertChunk(db, "A 첫 조각", "doc-a", 0, "2026-06-05 10:00:00");
  const [a0Atom] = attachAtomics(db, a0, 4);
  const a1 = insertChunk(db, "A 둘째 조각", "doc-a", 1, "2026-06-05 10:01:00");
  attachAtomics(db, a1, 4);
  const b0 = insertChunk(db, "B 첫 조각", "doc-b", 0, "2026-06-05 10:02:00");
  const [b0Atom] = attachAtomics(db, b0, 4);

  const kotlin = insertConcept(db, "코틀린");
  const sumin = insertPerson(db, "수민");
  const java = insertConcept(db, "자바");
  const minsu = insertPerson(db, "민수");
  linkConcept(db, a0Atom!, kotlin);
  linkPerson(db, a0Atom!, sumin);
  linkConcept(db, b0Atom!, java);
  linkPerson(db, b0Atom!, minsu);

  const candidates = findChunkSummaryCandidates(db, 4, 50);
  const groups = planSummaryCalls(candidates, db, ROOMY_MAX_CHUNKS_PER_CALL);

  // 두 문서 묶음. doc-a 청크 2개·개념 2건, doc-b 청크 1개·개념 2건.
  expect(groups.map((g) => g.documentId).sort()).toEqual(["doc-a", "doc-b"]);
  const docA = groups.find((g) => g.documentId === "doc-a")!;
  expect(docA.chunks.map((c) => c.chunkId).sort((x, y) => x - y)).toEqual([a0, a1].sort((x, y) => x - y));
  expect(docA.relationConcepts!.map((x) => x.conceptId).sort()).toEqual([kotlin, sumin].sort());
  const docB = groups.find((g) => g.documentId === "doc-b")!;
  expect(docB.chunks.map((c) => c.chunkId)).toEqual([b0]);
  expect(docB.relationConcepts!.map((x) => x.conceptId).sort()).toEqual([java, minsu].sort());
  db.close();
});

test("개념 2개 미만 묶음은 relationConcepts=null(쌍 성립 불가 — 정직한 skip), 청크요약 묶음은 그대로", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-a");
  insertDocument(db, "doc-b");
  // doc-a 개념 2건(관계 가능) / doc-b 개념 1건(관계 skip).
  const a0 = insertChunk(db, "A 조각", "doc-a", 0, "2026-06-05 10:00:00");
  const [a0Atom] = attachAtomics(db, a0, 4);
  const b0 = insertChunk(db, "B 조각", "doc-b", 0, "2026-06-05 10:01:00");
  const [b0Atom] = attachAtomics(db, b0, 4);

  const kotlin = insertConcept(db, "코틀린");
  const java = insertConcept(db, "자바");
  const lone = insertConcept(db, "외톨이");
  linkConcept(db, a0Atom!, kotlin);
  linkConcept(db, a0Atom!, java);
  linkConcept(db, b0Atom!, lone);

  const candidates = findChunkSummaryCandidates(db, 4, 50);
  const groups = planSummaryCalls(candidates, db, ROOMY_MAX_CHUNKS_PER_CALL);
  // 두 문서 다 호출 묶음은 남는다(청크요약은 해야 하므로). doc-b 만 관계 갈래 skip.
  expect(groups.map((g) => g.documentId)).toEqual(["doc-a", "doc-b"]);
  expect(groups[0]!.relationConcepts).not.toBeNull();
  expect(groups[1]!.relationConcepts).toBeNull();
  db.close();
});

test("한 호출 청크 수 상한을 넘는 문서는 입력 순서대로 잘리고, 각 묶음 개념은 그 묶음 청크에서만 나온다", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-a");
  // 청크 3개 — 상한 2 이면 [c0, c1] / [c2] 두 묶음.
  const c0 = insertChunk(db, "첫 조각", "doc-a", 0, "2026-06-05 10:00:00");
  const [c0Atom] = attachAtomics(db, c0, 4);
  const c1 = insertChunk(db, "둘째 조각", "doc-a", 1, "2026-06-05 10:01:00");
  const [c1Atom] = attachAtomics(db, c1, 4);
  const c2 = insertChunk(db, "셋째 조각", "doc-a", 2, "2026-06-05 10:02:00");
  const [c2Atom] = attachAtomics(db, c2, 4);
  const front1 = insertConcept(db, "앞개념1");
  const front2 = insertConcept(db, "앞개념2");
  const back1 = insertConcept(db, "뒤개념1");
  const back2 = insertConcept(db, "뒤개념2");
  linkConcept(db, c0Atom!, front1);
  linkConcept(db, c1Atom!, front2);
  linkConcept(db, c2Atom!, back1);
  linkConcept(db, c2Atom!, back2);

  const candidates = findChunkSummaryCandidates(db, 4, 50);
  const groups = planSummaryCalls(candidates, db, 2);
  expect(groups.map((g) => g.chunks.map((c) => c.chunkId))).toEqual([[c0, c1], [c2]]);
  expect(groups[0]!.relationConcepts!.map((x) => x.conceptId).sort()).toEqual([front1, front2].sort());
  expect(groups[1]!.relationConcepts!.map((x) => x.conceptId).sort()).toEqual([back1, back2].sort());
  expect(() => planSummaryCalls(candidates, db, 0)).toThrow(/청크 수 상한/);
  db.close();
});

test("문서에 이미 relation_summaries 행이 있어도 새 청크 묶음은 관계 발굴 대상(옛 문서 단위 영구 마감 폐기)", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-a");
  // 앞 묶음이 이미 관계 하나를 저장한 문서 — 뒤쪽 새 청크는 여전히 관계 개념을 받는다.
  const a0 = insertChunk(db, "A 뒤쪽 조각", "doc-a", 5, "2026-06-05 10:00:00");
  const [a0Atom] = attachAtomics(db, a0, 4);
  const swift = insertConcept(db, "스위프트");
  const rust = insertConcept(db, "러스트");
  linkConcept(db, a0Atom!, swift);
  linkConcept(db, a0Atom!, rust);
  insertRelationSummaryRow(db, "rs_1", "cpt_앞개념", "cpt_다른앞개념", "doc-a");

  const candidates = findChunkSummaryCandidates(db, 4, 50);
  const groups = planSummaryCalls(candidates, db, ROOMY_MAX_CHUNKS_PER_CALL);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.relationConcepts!.map((x) => x.conceptId).sort()).toEqual([swift, rust].sort());
  db.close();
});

test("listRelationPairsForDocument = 그 문서 관계요약 개념 쌍(방향 무관), 다른 문서 쌍은 없음", () => {
  const db = makeSchemaDb();
  insertDocument(db, "doc-a");
  insertDocument(db, "doc-b");
  insertRelationSummaryRow(db, "rs_a", "cpt_가", "cpt_나", "doc-a");
  insertRelationSummaryRow(db, "rs_b", "cpt_다", "cpt_라", "doc-b");

  const pairs = listRelationPairsForDocument(db, "doc-a");
  expect(pairs.size).toBe(1);
  // 저장 방향(가→나)과 반대 방향(나→가) 모두 같은 쌍.
  expect(pairs.has(relationPairKey("cpt_가", "cpt_나"))).toBe(true);
  expect(pairs.has(relationPairKey("cpt_나", "cpt_가"))).toBe(true);
  expect(pairs.has(relationPairKey("cpt_다", "cpt_라"))).toBe(false);
  expect(listRelationPairsForDocument(db, "doc-none").size).toBe(0);
  db.close();
});
