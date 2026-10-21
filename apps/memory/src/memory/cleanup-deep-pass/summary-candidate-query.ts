/**
 * summary-candidate-query.ts — 깊은 패스 둘째 단계 "요약" 후보 검출 (Phase 7 / Task 4).
 *
 * 권위 spec: docs/decisions/2026-06-05-phase7-summary-stage-spec.md 단락 3.1·4.4
 * 권위 plan: docs/decisions/2026-06-05-phase7-summary-stage-plan.md Task 4
 *
 * 무엇을 줍나:
 *   (1) 청크요약 후보 — atomic 이 임계(default 4) 이상으로 쪼개진 긴 문서 청크
 *       (source_type='document_chunk'). 짧은 디스코드 글은 atomic 1~2 라 자연 제외된다.
 *       멱등 = chunk_summaries 에 그 청크 행이 아직 없을 때만(별 테이블 행 존재로 판정 —
 *       has_summary 플래그 칸을 따로 두지 않는다).
 *   (2) 호출 묶음 — (1) 후보들을 부모 문서(metadata.parentId) 별로 모으고, 한 호출 청크 수
 *       상한(출력 한도 맵 stage-constants summary 에서 계산)씩 나눈다(planSummaryCalls). 사이클은
 *       호출당 입력 상한도 함께 보는 planSummaryCallsUnderCap 을 쓴다. 한
 *       묶음 = LLM 한 호출(청크요약 + 관계 발굴). 묶음은 문서 전체가 아니라 *일부* 청크일 수
 *       있다 — 후보는 LIMIT batchSize 로 잘리고 요약이 아직 없는 청크만 줍기 때문이다.
 *       관계 발굴 *허용 개념 집합*(개념/사람 id + 이름)은 그 묶음 청크의 atomic 에서 닿는
 *       개념만 모은다(2026-10-19 — 옛 "문서 전 청크 개념" 은 모델이 본 적 없는 글의 개념끼리
 *       관계를 만들게 했다). 개념이 2개 미만인 묶음은 관계 쌍이 성립하지 않아 관계 갈래를
 *       건너뛴다(정직한 skip — 가짜 관계 0, 청크요약은 그대로).
 *       관계 발굴 멱등 = 청크 단위. 청크는 요약이 생기거나(chunk_summaries 행) 원장이 완료로
 *       닫히면 다시 후보가 되지 않으므로, 각 청크 묶음은 자기 요약 호출에서 관계 발굴을 한 번
 *       받는다. 옛 문서 단위 영구 마감("그 문서에 relation_summaries 행이 하나라도 있으면 관계
 *       발굴 통째 제외")은 폐기 — 문서 앞부분 묶음에서 관계가 하나 저장되면 같은 문서 뒤쪽
 *       청크들은 영영 관계 발굴을 못 받았다. 같은 문서에 이미 있는 개념 쌍을 뒤 묶음이 또
 *       만드는 중복은 summary-cycle 이 listRelationPairsForDocument 로 막는다(스키마 변경 0).
 *
 * 부모 문서 참조 권위(Task 4 실측 결과):
 *   document_chunk 청크가 부모 문서를 가리키는 권위는 metadata.parentId(문자열
 *   document_id) 다 — ingest-document.ts:90 이 parentId: args.documentId 로 채우고,
 *   search.ts·getNeighborChunks 가 전부 node.metadata.parentId 로 그룹핑한다. parent_of
 *   엣지는 image_caption→image_asset 관계의 권위일 뿐 document_chunk 부모에는 안 쓴다.
 *   그래서 여기서도 metadata_json->>'$.parentId' 단일 출처로 그룹핑한다(검색·열람 정합).
 *
 * atomic 자식 조회는 candidate-query.ts readAtomics 양식 재사용(merged_into child→부모,
 * child.source_type='llm_extract'). 멱등 NOT EXISTS 판정은 metadata-infer-cycle.ts /
 * candidate-query.ts 의 행 존재 판정 양식 정합.
 *
 * 선호(memory_type='preference') 배제(spec H 후반): 선호는 원문 보존 트랙(openhuman
 * memory_protocol.rs:81-90 선례)이라 청크요약 후보 검출 대상이 아니다. 1차 SQL 이
 * memory_type != 'preference' 로 미리 거른다. 주의: 현 시점 이 조건은 방어적
 * 안전망이다 — 청크 저장 경로(save-input-plain.ts saveChunks)가 memoryType 을
 * 넘기지 않아 청크는 원본이 선호여도 항상 'fact'(schema DEFAULT)로 저장되므로,
 * 오늘은 preference 청크 자체가 생기지 않는다(T28 qa 정정). 미래에 청크가 원본
 * memory_type 을 물려받도록 바뀌면 그때부터 이 필터가 실효를 갖는다.
 *
 * 사용 이력 소비 정렬(spec 5-5): 청크요약 후보(findChunkSummaryCandidates)도 문서
 * 유입량이 batchSize 를 넘길 수 있는 stage 라 ordering 이 실제로 의미를 갖는다. "오래
 * 안 열어본 청크일수록 먼저" + "자주 열어본 청크일수록 뒤로 미룸" 조합은
 * candidate-query.ts ACCESS_ORDER_EXPR 과 동일 공식을 쓴다(두 모듈이 서로 import 하지
 * 않는 독립 후보 검출기라 상수를 공유하지 않고 각자 정의 — EXCLUDED_MEMORY_TYPE 과
 * 같은 관례). 호출 묶음(planSummaryCalls)은 이 정렬을 그대로
 * 물려받되 별도 재정렬을 하지 않는다 — 묶음은 "부모 문서별 그룹핑 + 호출 크기 자르기" 가 목적이라 문서
 * 안 청크 순서(chunk index 순)가 사용성 근거지, 접근 이력은 청크 단위 개별 처리
 * 우선순위(findChunkSummaryCandidates)에서만 의미가 있다.
 */

import type { Database } from "bun:sqlite";
import { listRelationEdges } from "../relation-reader.ts";
import type { MemoryType } from "../types.ts";
import { splitIntoMicrobatches } from "./input-estimate.ts";

/**
 * 선호 트랙 배제 값(spec H 후반 / openhuman memory_protocol.rs:81-90 선례) —
 * 선호는 원문 보존 트랙이라 요약(원문 압축) 후보의 대상이 아니다. candidate-query.ts
 * 와 같은 상수 정의를 공유하지 않는 이유 = 두 모듈이 서로 import 하지 않는 독립
 * 후보 검출기라, 값만 같고 참조는 각자 `MemoryType` 합집합에서 가져온다(하드코딩
 * 리터럴 오기 방지 목적은 candidate-query.ts 와 동일).
 */
const EXCLUDED_MEMORY_TYPE: MemoryType = "preference";

/**
 * 사용 이력 소비 정렬 키(spec 5-5) — candidate-query.ts ACCESS_ORDER_EXPR 과 동일 공식
 * (독립 상수로 각자 보유 — 두 모듈이 서로 import 하지 않는 관례는 EXCLUDED_MEMORY_TYPE
 * 과 동일). 공식·COALESCE·damping 근거는 candidate-query.ts 쪽 주석 참조.
 */
const ACCESS_ORDER_EXPR =
  "strftime('%s', COALESCE(kn.last_accessed_at, kn.created_at)) + kn.access_count * 86400";

/** 한 청크요약 후보 — 청크 노드 + 부모 문서 좌표 + atomic 내용(LLM 입력 닻). */
export interface ChunkSummaryCandidate {
  /** document_chunk 노드 id(knowledge_nodes.id). */
  chunkId: number;
  /** 청크 원문(요약 대상 + 첫 문단 fallback 재료). */
  content: string;
  /** 부모 문서 id(metadata.parentId — documents.document_id). */
  parentId: string;
  /** 문서 안 청크 순번(metadata.chunkIndex). */
  chunkIndex: number;
  /** 이 청크에서 추출된 llm_extract atomic 내용 목록(LLM 입력 닻). */
  atomics: string[];
}

/** 한 문서의 허용 개념 집합 한 원소 — 개념(cpt_) 또는 사람(psn_) id + 표시 이름. */
export interface DocumentConcept {
  /** concept_nodes.concept_id('cpt_') 또는 persons.person_id('psn_'). */
  conceptId: string;
  /** concept_nodes.name 또는 persons.display_name(LLM 입력 노출용 이름). */
  name: string;
}

/** LLM 한 호출 묶음 — 한 문서의 청크 일부(또는 전부) + 그 청크들의 관계 발굴 허용 개념 집합. */
export interface SummaryCallGroup {
  /** 부모 문서 id(metadata.parentId). */
  documentId: string;
  /** 이 호출에 싣는 청크요약 후보들(같은 문서, 한 호출 청크 수 상한 이하, 입력 순서 보존). */
  chunks: ChunkSummaryCandidate[];
  /**
   * 이 묶음 청크의 atomic 에서 닿는 허용 개념 집합(개념 id + 이름) — LLM 이 이 안에서만 관계를
   * 고르고, ID 검증(Task 13)이 from/to 가 이 집합 안에 있는지 결정적으로 확인한다(spec §4.2).
   * 2건 미만이면 null(관계 쌍 불가 → 관계 갈래 건너뜀, 청크요약만).
   */
  relationConcepts: DocumentConcept[] | null;
}

interface ChunkRow {
  chunk_id: number;
  content: string;
  parent_id: string;
  chunk_index: number;
}

interface ConceptRow {
  concept_id: string;
  name: string;
}

interface AtomicRow {
  id: number;
  content: string;
}

/**
 * 청크요약 후보를 줍는다 — source_type='document_chunk' 중 (a) merged_into llm_extract
 * 자식 수 ≥ atomicThreshold 이고 (b) chunk_summaries 에 그 청크 행이 아직 없는 것.
 * batchSize 로 한 패스 처리량을 제한한다.
 *
 * 정렬(spec 5-5): ACCESS_ORDER_EXPR ASC, kn.id ASC — 문서 유입량이 batchSize 를 넘길
 * 수 있는 stage 라 ordering 이 실제로 "이번 패스에 뭐가 들어가는가" 를 가른다. 오래
 * 안 열어본 청크부터 요약 대상으로 우선 처리한다.
 *
 * parentId·chunkIndex 가 metadata 에 온전치 않은 청크는 후보에서 제외한다(묶을 문서
 * 좌표가 없는 글 — 정직한 제외, 가짜 문서 id 를 만들지 않는다).
 *
 * @param db              실 SQLite 핸들(store.getRawDb()).
 * @param atomicThreshold 청크요약 대상이 되는 최소 atomic 수(설정값 — 하드코딩 0).
 * @param batchSize       한 패스 후보 최대 수(설정값 — 하드코딩 0).
 */
export function findChunkSummaryCandidates(
  db: Database,
  atomicThreshold: number,
  batchSize: number,
): ChunkSummaryCandidate[] {
  // document_chunk 노드 중 atomic(merged_into llm_extract 자식) 수가 임계 이상이고
  // chunk_summaries 행이 아직 없는 것. atomic 수는 상관 서브쿼리 COUNT 로 센다 — 엣지
  // 방향은 scheduler addEdge 정합(child 가 source_id, 청크가 target_id).
  // 이 COUNT 게이트는 후보 처리량을 SQL 단계에서 줄이는 threshold 조건이라
  // relation-reader 로 풀어낸 뒤 세지 않는다(후속 readAtomics/개념 수집만 reader 사용).
  // 멱등 NOT EXISTS = chunk_summaries.parent_chunk_id 행 존재로 판정(candidate-query.ts
  // 행 존재 판정 양식 정합). parentId·chunkIndex 는 metadata_json->> 로 뽑아 NULL(부재)
  // 청크는 WHERE 에서 제외한다.
  const rows = db
    .prepare(
      `SELECT kn.id AS chunk_id,
              kn.content AS content,
              kn.metadata_json ->> '$.parentId' AS parent_id,
              kn.metadata_json ->> '$.chunkIndex' AS chunk_index
       FROM knowledge_nodes kn
       WHERE kn.source_type = 'document_chunk'
         AND kn.memory_type != ?
         AND kn.metadata_json ->> '$.parentId' IS NOT NULL
         AND kn.metadata_json ->> '$.chunkIndex' IS NOT NULL
         AND NOT EXISTS(
           SELECT 1 FROM documents d
           WHERE d.document_id = kn.metadata_json ->> '$.parentId'
             AND d.source_metadata ->> '$.parse.status'
               IN ('needs_ocr', 'password_required', 'parse_failed', 'ocr_failed')
         )
         AND (
           SELECT COUNT(*) FROM knowledge_edges e
           JOIN knowledge_nodes child ON child.id = e.source_id
           WHERE e.target_id = kn.id
             AND e.relation = 'merged_into'
             AND child.source_type = 'llm_extract'
         ) >= ?
         AND NOT EXISTS(
           SELECT 1 FROM chunk_summaries cs
           WHERE cs.parent_chunk_id = kn.id
         )
       ORDER BY ${ACCESS_ORDER_EXPR} ASC, kn.id ASC
       LIMIT ?`,
    )
    .all(EXCLUDED_MEMORY_TYPE, atomicThreshold, batchSize) as ChunkRow[];

  return rows.map((r) => ({
    chunkId: r.chunk_id,
    content: r.content,
    parentId: r.parent_id,
    chunkIndex: r.chunk_index,
    atomics: readAtomics(db, r.chunk_id),
  }));
}

/**
 * 청크요약 후보들을 LLM 호출 묶음으로 나눈다 — 부모 문서(parentId) 별로 모은 뒤 문서마다
 * maxChunksPerCall 개씩 자른다. 한 문서의 청크는 한 호출 출력 한도에 맞춰 여러 호출로 나뉠 수
 * 있다(출력이 청크 수에 비례 — stage-constants summary). 각 묶음에 그 묶음 청크의 허용 개념
 * 집합(collectChunkSetConcepts)을 단다 — 2건 미만이면 null(관계 쌍 불가, 정직한 skip).
 *
 * 후보 입력은 findChunkSummaryCandidates 의 정렬 순서(ACCESS_ORDER_EXPR ASC — spec 5-5)
 * 를 그대로 보존한다 — 먼저 등장한 문서가 결과 묶음에서도 앞에 오고(문서별 첫 청크 등장 순),
 * 한 문서 안 청크들도 입력 순서 그대로 잘린다(재정렬하지 않음).
 *
 * @param candidates       findChunkSummaryCandidates 회신(원장 2차 제외 뒤 목록 포함).
 * @param db               개념 집합 조회용 실 SQLite 핸들.
 * @param maxChunksPerCall 한 호출 청크 수 상한(cleanupStageMaxItemsPerCall("summary")).
 */
export function planSummaryCalls(
  candidates: readonly ChunkSummaryCandidate[],
  db: Database,
  maxChunksPerCall: number,
): SummaryCallGroup[] {
  // 입력 상한 없이 청크 수만으로 자른다(상한 무한대 — 어떤 청크도 상한 초과가 되지 않는다).
  return planSummaryCallsUnderCap(candidates, db, {
    maxChunksPerCall,
    perCallInputCap: Number.POSITIVE_INFINITY,
    fixedOverheadTokens: () => 0,
    chunkTokens: () => 0,
  }).groups;
}

/** planSummaryCallsUnderCap 회신 — 호출 묶음 + 청크 하나만으로도 호출당 입력 상한을 넘는 청크. */
export interface SummaryCallPlan {
  groups: SummaryCallGroup[];
  /** 지시문 + 청크 하나만으로도 상한 초과 — 호출 없이 원장 terminal(input_over_cap) 대상. */
  overCap: ChunkSummaryCandidate[];
}

/**
 * planSummaryCalls 의 호출당 입력 상한(spec 4.A-6) 판. 문서별로 모은 뒤, 청크 수 상한과 함께 추정
 * 입력 토큰 합(문서 고정 몫 + 청크 몫 합)이 perCallInputCap 안에 들도록 그리디로 자른다(입력 순서
 * 보존 — splitIntoMicrobatches). 청크 하나만으로도 넘으면 overCap 으로 뺀다(본문을 자르지 않는다).
 *
 * @param opts.fixedOverheadTokens 문서 묶음마다 붙는 몫(지시문·머리 줄 — 글루가 프롬프트 모듈로 잰다).
 * @param opts.chunkTokens 청크 한 개의 몫(청크 블록 + 그 청크의 개념 줄 — 글루가 잰다).
 */
export function planSummaryCallsUnderCap(
  candidates: readonly ChunkSummaryCandidate[],
  db: Database,
  opts: {
    maxChunksPerCall: number;
    perCallInputCap: number;
    fixedOverheadTokens: (documentId: string) => number;
    chunkTokens: (chunk: ChunkSummaryCandidate) => number;
  },
): SummaryCallPlan {
  const { maxChunksPerCall } = opts;
  if (!Number.isInteger(maxChunksPerCall) || maxChunksPerCall < 1) {
    throw new Error(
      `요약 호출 묶음: 한 호출 청크 수 상한은 1 이상 정수여야 함 (받은 값: ${maxChunksPerCall})`,
    );
  }
  // parentId 별로 묶되 첫 등장 문서 순서를 보존한다(Map insertion order).
  const byDocument = new Map<string, ChunkSummaryCandidate[]>();
  for (const c of candidates) {
    const bucket = byDocument.get(c.parentId);
    if (bucket) bucket.push(c);
    else byDocument.set(c.parentId, [c]);
  }

  const plan: SummaryCallPlan = { groups: [], overCap: [] };
  for (const [documentId, docChunks] of byDocument) {
    const { batches, oversized } = splitIntoMicrobatches(docChunks, {
      fixedOverheadTokens: opts.fixedOverheadTokens(documentId),
      perCallCap: opts.perCallInputCap,
      tokensOf: opts.chunkTokens,
      maxItemsPerBatch: maxChunksPerCall,
    });
    plan.overCap.push(...oversized);
    for (const chunks of batches) {
      const concepts = collectChunkSetConcepts(db, chunks.map((c) => c.chunkId));
      plan.groups.push({
        documentId,
        chunks,
        relationConcepts: concepts.length >= 2 ? concepts : null,
      });
    }
  }
  return plan;
}

/**
 * 청크 묶음의 허용 개념 집합을 모은다(spec §4.2 — 관계 발굴 allowedIds). 경로:
 *   주어진 document_chunk 청크들
 *     → merged_into atomic 자식(child.source_type='llm_extract')
 *       → atomic 이 가리킨 node_concept_edges.concept_id(role 무관 / concept_nodes.name)
 *       ∪ node_person_edges.person_id(relation 무관 / persons.display_name).
 *
 * 문서 입력 자체는 청크 노드에 개념을 안 붙인다 — 개념은 추출기가 atomic 에 붙인다
 * (extractor.ts autoLinkMentions·linkAuthorPerson). 그래서 청크가 아니라 그 atomic
 * 자식들을 거쳐 개념을 모은다. atomic 노드 자체는 개념이 아니므로(글 노드) 결과에 안
 * 든다. 같은 개념이 여러 atomic·role 로 걸려도 한 번만 회신한다. 묶음 밖 청크(같은 문서의
 * 다른 청크 포함)의 개념은 넣지 않는다 — 모델이 그 글을 보지 못했기 때문이다.
 *
 * @param db       실 SQLite 핸들.
 * @param chunkIds 이 호출에 싣는 document_chunk 노드 id 목록.
 */
export function collectChunkSetConcepts(
  db: Database,
  chunkIds: readonly number[],
): DocumentConcept[] {
  const atomicIds = listLlmExtractChildren(db, [...chunkIds]).map((r) => r.id);
  if (atomicIds.length === 0) return [];
  const atomicIdSet = new Set(atomicIds.map(String));
  const conceptIds = new Set<string>();
  const personIds = new Set<string>();

  for (const edge of listRelationEdges(db, { tableName: "node_concept_edges" })) {
    if (atomicIdSet.has(edge.sourceId)) conceptIds.add(edge.targetId);
  }
  for (const edge of listRelationEdges(db, { tableName: "node_person_edges" })) {
    if (atomicIdSet.has(edge.sourceId)) personIds.add(edge.targetId);
  }

  return [
    ...loadConceptNames(db, conceptIds),
    ...loadPersonNames(db, personIds),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 한 raw/청크의 llm_extract atomic 자식 내용 목록을 읽는다(merged_into child→부모).
 * candidate-query.ts readAtomics 양식 정합 — Task 5 가 이 atomics 를 "이 청크는 의미가
 * 이만큼 쪼개졌다" 는 LLM 입력 닻으로 쓴다(요약·관계 발굴 근거).
 */
function readAtomics(db: Database, chunkId: number): string[] {
  return listLlmExtractChildren(db, [chunkId]).map((x) => x.content);
}

function listLlmExtractChildren(db: Database, parentIds: number[]): AtomicRow[] {
  if (parentIds.length === 0) return [];
  const parentIdSet = new Set(parentIds.map(String));
  const childIds = listRelationEdges(db, {
    tableName: "knowledge_edges",
    relation: "merged_into",
  })
    .filter((edge) => parentIdSet.has(edge.targetId))
    .map((edge) => Number(edge.sourceId))
    .filter((id) => Number.isInteger(id));
  return loadAtomicRows(db, childIds);
}

function loadAtomicRows(db: Database, nodeIds: number[]): AtomicRow[] {
  const ids = uniqueNumbers(nodeIds);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, content
       FROM knowledge_nodes
       WHERE source_type = 'llm_extract'
         AND id IN (${placeholders})
       ORDER BY id ASC`,
    )
    .all(...ids) as AtomicRow[];
  return rows;
}

function loadConceptNames(db: Database, conceptIds: Iterable<string>): DocumentConcept[] {
  const ids = uniqueStrings(conceptIds);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT concept_id, name
       FROM concept_nodes
       WHERE concept_id IN (${placeholders})`,
    )
    .all(...ids) as ConceptRow[];
  return rows.map((r) => ({ conceptId: r.concept_id, name: r.name }));
}

function loadPersonNames(db: Database, personIds: Iterable<string>): DocumentConcept[] {
  const ids = uniqueStrings(personIds);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT person_id AS concept_id, display_name AS name
       FROM persons
       WHERE person_id IN (${placeholders})`,
    )
    .all(...ids) as ConceptRow[];
  return rows.map((r) => ({ conceptId: r.concept_id, name: r.name }));
}

function uniqueNumbers(values: Iterable<number>): number[] {
  return [...new Set([...values].filter((value) => Number.isInteger(value)))];
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))];
}

/** 개념 쌍 열쇠의 두 id 구분자 — id 에 나오지 않는 제어 문자(U+001F, 원장 targetKey 구분자 관례). */
const PAIR_KEY_SEPARATOR = String.fromCharCode(0x1f);

/**
 * 개념 쌍 열쇠 — 방향 무관(A→B 와 B→A 를 같은 쌍으로 본다). 같은 문서의 뒤 묶음이 앞 묶음이
 * 이미 만든 쌍을 또 만드는 중복을 가르는 데 쓴다.
 */
export function relationPairKey(conceptA: string, conceptB: string): string {
  return conceptA < conceptB
    ? `${conceptA}${PAIR_KEY_SEPARATOR}${conceptB}`
    : `${conceptB}${PAIR_KEY_SEPARATOR}${conceptA}`;
}

/**
 * 이 문서에 이미 저장된 관계요약의 개념 쌍(relationPairKey) 집합. 관계 발굴 멱등을 문서 단위
 * 영구 마감에서 청크 묶음 단위로 바꾼 뒤(planSummaryCalls 주석), 같은 문서의 다른 청크 묶음이
 * 같은 쌍을 다시 저장하지 않게 summary-cycle 이 저장 전에 대조한다. relation_summaries 에
 * 쌍 고유 제약이 없어 코드에서 가른다(스키마 변경 0).
 */
export function listRelationPairsForDocument(db: Database, documentId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT from_concept_id, to_concept_id
       FROM relation_summaries
       WHERE source_document_id = ?`,
    )
    .all(documentId) as Array<{ from_concept_id: string; to_concept_id: string }>;
  return new Set(rows.map((r) => relationPairKey(r.from_concept_id, r.to_concept_id)));
}
