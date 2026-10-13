/**
 * store-internal/extraction-state-sql.ts — 백필 추출 상태 판정의 단일 출처(표시 값·SQL 조각).
 *
 * "이 노드의 현재 본문 주장을 아직 추출하지 않았는가"를 한 곳에서 정한다. 백필 후보 목록
 * (getBackfillCandidates)·단건 재확인(isBackfillCandidateEligible)·편집 뒤 재청크 판단
 * (getOriginChunkState)이 같은 조각을 쓴다.
 *
 * metadata.extracted 표시(서버 관리 칸 — SA-0):
 *   1 (EXTRACTION_DONE)    현재 본문 주장을 추출했다. extractedTo 에 그때 만든 자식 id.
 *                          markNodeExtracted·즉시 추출이 쓰는 정수 1과 같은 값이다.
 *   0 (EXTRACTION_PENDING) 본문 주장이 바뀌어 추출을 다시 기다린다. 편집 트랜잭션이 기록하고
 *                          extractedTo 는 지운다. 그 전의 계보 엣지는 이전 주장의 기록이라 보지 않는다.
 *   없음                   추출 기록이 없다. 옛 immediate 행처럼 extractedTo 만 있어도 기록으로 본다.
 *
 * 계보 무효화: 원문 편집·철회가 invalidateSharedMemoryDerivatives 로 파생 기억을 철회하면
 * sharedMemory 에 status 'retracted' 와 invalidatedBy 를 남긴다(TS 판정은
 * isLineageInvalidated). 이런 자식만 "원문의 추출이 무효가 됐다"는 신호로 쓴다. 사용자가 직접
 * 철회·대체한 기억(invalidatedBy 없음)과 충돌 후보(disputed)는 처리된 추출로 남긴다 — 그
 * 원문을 다시 추출하면 사용자가 거둔 주장이 되살아나거나 같은 충돌 후보가 반복해 생긴다.
 *
 * 긴 글 판정(토큰 수 > chunking.tokenCap)은 SQL 로 할 수 없다. 그래서 SQL 은 "살아 있는(active)
 * 청크가 없고, 추출 대기이거나 청크가 없거나 계보 무효화된 청크만 남은 원문"까지 후보로 올리고,
 * 긴 글 판정은 백필이 TS 에서 한다(memory/backfill-extraction.ts). 청크가 추출 단위라(spec §4 D5,
 * 통째 추출은 LLM 컨텍스트를 넘는다) 백필은 긴 원문을 LLM 에 보내지 않고 쓰기 잠금 안에서 재청크한다.
 * 재청크가 청크를 만들면 원문은 active 청크를 가져 후보에서 빠지고 청크가 후보가 된다. 짧은 원문은
 * 직접 추출되어 추출 기록이 생기므로 다시 후보가 되지 않는다(WP-B1-31).
 *   - 대기 원문: 편집 직후 재청크(rechunkEditedOrigin)가 실패하면 청크 없이 대기로 남는다.
 *   - 계보 무효화된 청크만 남은 원문: WP-B1-06 이전의 편집이 청크만 거두고 대기 표시를 남기지 않았다.
 * 사용자가 직접 철회한 청크(invalidatedBy 없음)만 남은 원문은 후보가 아니다 — 거둔 청크를 되살리지 않는다.
 */

import type { EdgeRelation, SourceType } from "../../memory/types.ts";
import type { SharedMemoryState } from "../../memory/shared-memory-contract.ts";
import { OCR_INCOMPLETE_PARSE_STATUSES } from "../../memory/document-parse-status.ts";

/**
 * metadata.extracted — 현재 본문 주장을 추출했다. 표시 값은 정수로 저장·비교한다(옛 json('true')
 * 저장은 ->> 가 TEXT 'true' 를 돌려 정수 비교가 늘 어긋났다 — Task 5 리뷰 fix).
 */
export const EXTRACTION_DONE = 1;
/** metadata.extracted — 본문 주장이 바뀌어 추출을 다시 기다린다. */
export const EXTRACTION_PENDING = 0;

/** 추출 기록 칸의 metadata 키와 JSON 경로. */
export const EXTRACTED_KEY = "extracted";
export const EXTRACTED_TO_KEY = "extractedTo";
export const EXTRACTED_PATH = `$.${EXTRACTED_KEY}`;
export const EXTRACTED_TO_PATH = `$.${EXTRACTED_TO_KEY}`;

/** 백필이 추출하는 종류 — 짧은 원문과 긴 글·문서의 청크. */
export const BACKFILL_SOURCE_TYPES = [
  "auto_capture", "document_chunk",
] as const satisfies readonly SourceType[];
export type BackfillSourceType = (typeof BACKFILL_SOURCE_TYPES)[number];

export function isBackfillSourceType(sourceType: string): sourceType is BackfillSourceType {
  return (BACKFILL_SOURCE_TYPES as readonly string[]).includes(sourceType);
}

const CHUNK_SOURCE_TYPE: BackfillSourceType = "document_chunk";
/** 청크 → 원문. */
const CHUNK_RELATION = "parent_of" satisfies EdgeRelation;
/** 추출 자식(LLM atomic·regex atomic) → 원문·청크. */
const EXTRACTION_RELATION = "merged_into" satisfies EdgeRelation;
const ACTIVE: SharedMemoryState["status"] = "active";
const RETRACTED: SharedMemoryState["status"] = "retracted";

/**
 * 편집 트랜잭션이 원문 metadata 객체에 "추출 대기"를 기록한다. extractedTo 는 이전 주장에서
 * 만든 자식 목록이라 지운다(그 자식들은 merged_into 엣지와 invalidatedBy 로 계보가 남는다).
 */
export function markExtractionPendingInMetadata(metadata: Record<string, unknown>): void {
  metadata[EXTRACTED_KEY] = EXTRACTION_PENDING;
  delete metadata[EXTRACTED_TO_KEY];
}

/**
 * 원문의 추출 기록 칸을 뺀 metadata. 추출 자식이 원문 metadata 를 물려받을 때 쓴다 — 기록은
 * 원문의 상태이지 자식의 상태가 아니며, extractedTo 는 가시성·무효화가 계보로 읽는 칸이다.
 */
export function withoutExtractionRecord(metadata: Record<string, unknown>): Record<string, unknown> {
  const { [EXTRACTED_KEY]: _extracted, [EXTRACTED_TO_KEY]: _extractedTo, ...rest } = metadata;
  return rest;
}

/** 상수 문자열을 SQL 문자열 리터럴로 쓴다(값은 이 모듈의 상수뿐이다). */
function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function metadataValue(alias: string, path: string): string {
  return `${alias}.metadata_json ->> ${sqlText(path)}`;
}

/**
 * 행이 계보 무효화로 철회됐다. 추출 상태 판정 외에 같은 본문 흡수(addNodeIdempotent)도
 * 이 조건의 행을 흡수 대상에서 뺀다 — 그 행은 더 이상 어떤 주장도 대표하지 않는다.
 */
export function lineageInvalidatedSql(child: string): string {
  return `(${metadataValue(child, "$.sharedMemory.status")} IS ${sqlText(RETRACTED)}`
    + ` AND ${metadataValue(child, "$.sharedMemory.invalidatedBy")} IS NOT NULL)`;
}

/**
 * 행 자신이 active 다(sharedMemory 가 없으면 active — readSharedMemory 기본값). lineageChildSql
 * 을 통해 "자식이 active 다"로도 쓰고(activeChunkSql), 문서 추출 진행 집계처럼 청크 행 자신의
 * active 여부를 직접 물을 때도 쓴다(WP-B1-24 — totalChunks 는 active 청크 수).
 */
export function activeSql(alias: string): string {
  return `(COALESCE(${metadataValue(alias, "$.sharedMemory.status")}, ${sqlText(ACTIVE)}) IS ${sqlText(ACTIVE)})`;
}

/** node 를 target 으로 하는 relation 엣지의 자식(source) 중 조건을 만족하는 행이 있다. */
function lineageChildSql(node: string, relation: string, childCondition: (child: string) => string | null): string {
  const condition = childCondition("lineage_child");
  return `EXISTS (SELECT 1 FROM knowledge_edges lineage_edge`
    + ` JOIN knowledge_nodes lineage_child ON lineage_child.id = lineage_edge.source_id`
    + ` WHERE lineage_edge.target_id = ${node}.id AND lineage_edge.relation = ${sqlText(relation)}`
    + `${condition === null ? "" : ` AND ${condition}`})`;
}

/** 대기 표시(extracted = 0)가 있다. */
export function extractionPendingSql(node: string): string {
  return `(${metadataValue(node, EXTRACTED_PATH)} IS ${EXTRACTION_PENDING})`;
}

/** 추출 기록이 있다(대기가 아니고 extracted = 1 이거나 extractedTo 가 있다). */
function extractionRecordedSql(node: string): string {
  return `(NOT ${extractionPendingSql(node)} AND (${metadataValue(node, EXTRACTED_PATH)} IS ${EXTRACTION_DONE}`
    + ` OR ${metadataValue(node, EXTRACTED_TO_PATH)} IS NOT NULL))`;
}

/** 추출 기록이 전혀 없다(옛 판정 "(extracted 가 1 이 아님) AND extractedTo 없음"에서 대기를 뺀 것). */
function extractionUnrecordedSql(node: string): string {
  return `(NOT ${extractionPendingSql(node)} AND NOT (${metadataValue(node, EXTRACTED_PATH)} IS ${EXTRACTION_DONE})`
    + ` AND ${metadataValue(node, EXTRACTED_TO_PATH)} IS NULL)`;
}

/**
 * 추출 기록이 무효다 — extractedTo 가 비어 있지 않고 그 자식이 모두 계보 무효화로 철회됐다.
 * 이 수정 이전의 편집(태그만 바뀐 편집 포함)이나 철회 뒤 같은 본문으로 되살린 원문이 여기 해당한다.
 * 저장 행은 고치지 않는다: 백필이 다시 추출하면 markNodeExtracted 가 새 자식으로 기록을 덮는다.
 */
function extractionRecordVoidSql(node: string): string {
  return `(${extractionRecordedSql(node)}`
    + ` AND json_type(${node}.metadata_json, ${sqlText(EXTRACTED_TO_PATH)}) IS 'array'`
    + ` AND json_array_length(${node}.metadata_json, ${sqlText(EXTRACTED_TO_PATH)}) > 0`
    + ` AND NOT EXISTS (SELECT 1 FROM json_each(${node}.metadata_json, ${sqlText(EXTRACTED_TO_PATH)}) listed`
    + ` WHERE NOT EXISTS (SELECT 1 FROM knowledge_nodes listed_child`
    + ` WHERE listed_child.id = listed.value AND ${lineageInvalidatedSql("listed_child")})))`;
}

/** 추출 자식(merged_into) 가운데 계보 무효화되지 않은 것이 있다 — 옛 W5 중복 방지 판정. */
function liveExtractionChildSql(node: string): string {
  return lineageChildSql(node, EXTRACTION_RELATION, (child) => `NOT ${lineageInvalidatedSql(child)}`);
}

/** 청크 자식(parent_of)이 하나라도 있다. */
function anyChunkSql(node: string): string {
  return lineageChildSql(node, CHUNK_RELATION, () => null);
}

/** active 청크 자식이 있다. */
export function activeChunkSql(node: string): string {
  return lineageChildSql(node, CHUNK_RELATION, activeSql);
}

/** 계보 무효화로 철회된 청크 자식이 있다. */
export function lineageInvalidatedChunkSql(node: string): string {
  return lineageChildSql(node, CHUNK_RELATION, lineageInvalidatedSql);
}

/**
 * 현재 본문 주장을 아직 추출하지 않았다 — 대기, 무효 기록, 또는 기록도 살아 있는 추출
 * 자식도 없는 경우. 청크 규칙과 문서 파싱 상태는 보지 않는다(문서 추출 진행 집계가 청크에 쓴다).
 */
export function claimAwaitsExtractionSql(node: string): string {
  return `(${extractionPendingSql(node)} OR ${extractionRecordVoidSql(node)}`
    + ` OR (${extractionUnrecordedSql(node)} AND NOT ${liveExtractionChildSql(node)}))`;
}

/** 문서 청크라면 그 문서의 파싱·OCR 이 끝났다(미완료 문서의 청크는 자동 추출하지 않는다). */
function chunkDocumentReadySql(node: string): string {
  return `(${node}.source_type != ${sqlText(CHUNK_SOURCE_TYPE)} OR NOT EXISTS (`
    + `SELECT 1 FROM documents chunk_document`
    + ` WHERE chunk_document.document_id = ${metadataValue(node, "$.parentId")}`
    + ` AND chunk_document.source_metadata ->> '$.parse.status'`
    + ` IN (${OCR_INCOMPLETE_PARSE_STATUSES.map(sqlText).join(", ")})))`;
}

/**
 * 백필 후보의 구조 조건(가시성·since·minImportance 는 호출자 몫). 현재 본문 주장을 아직 추출하지
 * 않았고, active 청크가 없으며, 다음 중 하나다. 긴 글이면 백필이 추출 대신 재청크한다(머리 주석).
 *   - 추출 대기(편집으로 주장이 바뀌었다 — 짧은 본문, 또는 재청크 전·재청크 실패 뒤).
 *   - 청크 자식이 없다.
 *   - 계보 무효화된 청크가 있다(WP-B1-06 이전 편집이 청크만 거둔 원문 — 재청크 복구 대상).
 */
export function backfillEligibilitySql(node: string): string {
  return `(${node}.source_type IN (${BACKFILL_SOURCE_TYPES.map(sqlText).join(", ")})`
    + ` AND ${chunkDocumentReadySql(node)}`
    + ` AND ${claimAwaitsExtractionSql(node)}`
    // 청크가 없으면 active 청크도 없다 — 흔한 짧은 원문은 EXISTS 한 번으로 끝낸다.
    + ` AND (NOT ${anyChunkSql(node)}`
    + ` OR ((${extractionPendingSql(node)} OR ${lineageInvalidatedChunkSql(node)}) AND NOT ${activeChunkSql(node)})))`;
}
