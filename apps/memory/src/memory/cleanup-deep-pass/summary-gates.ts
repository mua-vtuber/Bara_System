/**
 * summary-gates.ts — 깊은 패스 둘째 단계 "요약" 품질 게이트 + 통합 JSON 파싱
 * (Phase 7 / Task 5). 전부 순수 함수 — DB·LLM 의존 0. Task 6 글루가 import 해서 쓴다.
 *
 * 권위 spec: docs/decisions/2026-06-05-phase7-summary-stage-spec.md 단락 4.3·4.5
 * 권위 plan: docs/decisions/2026-06-05-phase7-summary-stage-plan.md Task 5
 *
 * bara 안전 철학 = "싼 결정적 필터로 좁히고 LLM 은 보강". 강한 LLM 이 청크요약·관계를
 * 발굴하되, 결정적 ID 검증이 환각(존재하지 않는 노드를 잇는 관계)을 막는 방벽이다.
 *
 * 게이트 셋:
 *   (1) validateChunkSummary  — LLM 이 낸 chunk_id 가 입력 묶음에 준 청크 노드 id 집합에
 *       있는지(환각 차단). 없으면 식별자 담은 loud warn 으로 버린다(silent 폐기 금지).
 *   (2) validateRelationSummary — from_concept_id·to_concept_id 둘 다 실재 *개념* 집합
 *       (cpt_/psn_ TEXT)에 있는지. 하나라도 환각이면 그 관계 통째 버림 + loud warn(둘 다
 *       식별자 담음). 청크요약(정수 chunk_id)과 다른 집합으로 검증한다 — 섞지 않는다.
 *   (3) gateRelationEdge — confidence >= 임계면 엣지 승격, 미만이면 엣지 보류. 요약 문장
 *       저장 여부는 판정하지 않는다(요약 문장은 항상 저장 — Task 6 처리). 임계는 인자.
 *
 * ID 검증·loud warn 양식은 metadata-infer-cycle.ts:244 의 allowedIds.has 패턴을 그대로
 * 차용했다(환각이면 식별자 담은 console.warn 으로 버림). JSON 파싱은
 * regex-strengthen-cycle.ts:349 양식 정합 — 코드펜스·앞뒤 잡담 허용(첫 경계~마지막 경계
 * 추출), 형식 어긋난 원소는 거름, 파싱 실패는 throw(글루가 loud warn 으로 그 문서 건너뜀).
 */

import type { StageInferResult } from "./stage-execution.ts";

// ── 결과 타입 ────────────────────────────────────────────────────────────────

/** 게이트 통과 후보 청크요약 한 원소(camelCase 정규화 결과). */
export interface ParsedChunkSummary {
  /** document_chunk 노드 id — 입력 묶음 청크 집합과 결정적 매치 대상. */
  chunkId: number;
  /** 청크 한 문장 요약. */
  summaryText: string;
  /** LLM 자가 평가 신뢰도(0~1). 청크요약은 게이트 0 — 관측·기록용. */
  confidence: number;
}

/** 게이트 통과 후보 관계요약 한 원소(camelCase 정규화 결과). */
export interface ParsedRelationSummary {
  /** 관계 출발 개념 id(cpt_/psn_ TEXT) — 개념 실재 검증 대상. */
  fromConceptId: string;
  /** 관계 도착 개념 id(cpt_/psn_ TEXT) — 개념 실재 검증 대상. */
  toConceptId: string;
  /** 발굴된 관계 이름(라이벌·소속 등). */
  relationName: string;
  /** 관계 요약 문장. */
  summaryText: string;
  /** LLM 자가 평가 신뢰도(0~1) — confidence 게이트 + relation_summaries.confidence 칸. */
  confidence: number;
}

/** parseSummaryResponse 회신 — 두 갈래 배열. */
export interface ParsedSummaryResponse {
  chunkSummaries: ParsedChunkSummary[];
  relationSummaries: ParsedRelationSummary[];
}

/**
 * 통합 호출 응답 함수 타입(mock 0 — 함수 주입). Task 4 글루가 createSummaryInferFn(executor)
 * 으로 실행층을 감싸 주입하고, 테스트는 데이터 fixture 를 회신하는 함수를 넣는다.
 * 입력은 한 문서(청크 묶음)의 프롬프트 본문, 출력은 StageInferResult<string> — ok.parsed 는
 * raw 응답 문자열(파싱은 호출자가 parseSummaryResponse 로 한다). 비-ok 는 실행층 신호를
 * 실어 글루가 원장 상태를 가른다(옛 throw 계약 폐기 — 실패를 결과 값으로 실음).
 */
export type SummaryInferFn = (prompt: string) => Promise<StageInferResult<string>>;

// ── 게이트 (1) 청크요약 ID 검증 ───────────────────────────────────────────────

/**
 * 청크요약 chunk_id 가 입력 묶음에 준 청크 노드 id 집합에 있는지 결정적으로 확인한다.
 * 없으면(환각) false + 식별자(환각 id + 허용 집합) 담은 loud warn(silent 폐기 금지).
 *
 * @param chunkId    LLM 이 낸 청크 id.
 * @param allowedIds 입력 묶음에 준 청크 노드 id 집합.
 * @param logPrefix  로그 앞머리(글루가 사이클 prefix 주입). 생략 시 기본 prefix.
 */
export function validateChunkSummary(
  chunkId: number,
  allowedIds: ReadonlySet<number>,
  logPrefix = DEFAULT_LOG_PREFIX,
): boolean {
  if (allowedIds.has(chunkId)) return true;
  console.warn(
    `${logPrefix} 환각 청크요약 버림 — chunk_id=${chunkId} 가 입력 묶음(${joinIds(
      allowedIds,
    )}) 밖.`,
  );
  return false;
}

// ── 게이트 (2) 관계요약 from·to 개념 실재 검증 ─────────────────────────────────

/**
 * 관계요약 from_concept_id·to_concept_id 가 둘 다 그 문서의 실재 개념 집합(§4.2 — 개념
 * 노드 cpt_ + 사람 노드 psn_, atomic 글 노드 제외)에 있는지 확인한다. 하나라도 환각이거나
 * from·to 가 같은 개념(자기 관계)이면 그 관계 통째 버리고 false + loud warn(from·to·허용
 * 집합 식별자 전부 담음). 청크요약(정수 chunk_id)과 *다른 집합* 으로 검증한다.
 *
 * from===to 자기 관계를 막는 까닭: 자기 자신을 잇는 엣지는 개념 그래프에서 무의미한 자기
 * 루프가 되고, 발굴 가치(개념 *쌍* 의 관계)도 없다.
 *
 * @param from              관계 출발 개념 id(cpt_/psn_ TEXT).
 * @param to                관계 도착 개념 id(cpt_/psn_ TEXT).
 * @param allowedConceptIds 그 문서의 실재 개념 id 집합(§4.2).
 * @param logPrefix         로그 앞머리(글루 주입). 생략 시 기본 prefix.
 */
export function validateRelationSummary(
  from: string,
  to: string,
  allowedConceptIds: ReadonlySet<string>,
  logPrefix = DEFAULT_LOG_PREFIX,
): boolean {
  const fromOk = allowedConceptIds.has(from);
  const toOk = allowedConceptIds.has(to);
  if (fromOk && toOk && from !== to) return true;
  const reason = from === to ? "from·to 가 같은 개념(자기 관계)" : "from·to 중 환각 개념";
  console.warn(
    `${logPrefix} 관계요약 버림(${reason}) — from_concept_id=${from} to_concept_id=${to}, 개념 집합(${joinConceptIds(
      allowedConceptIds,
    )}).`,
  );
  return false;
}

// ── 게이트 (3) confidence 임계 ───────────────────────────────────────────────

/**
 * confidence 임계 게이트. confidence >= threshold 면 "엣지 승격"(true), 미만이면 "엣지
 * 보류"(false). 요약 문장 저장 여부는 판정하지 않는다 — 요약 문장은 항상 저장하고
 * (Task 6), 엣지(llm_relation)만 보류한다. 보류 관계의 confidence 는
 * relation_summaries.confidence 칸에 저장돼, 나중 임계를 내리면 LLM 재호출 0 으로 엣지로
 * 승격할 수 있다(plan 미세 모호 확정).
 *
 * 임계는 인자다 — 하드코딩 0(설정값 cleanupDeepPass.summary.relationConfidenceThreshold).
 */
export function gateRelationEdge(confidence: number, threshold: number): boolean {
  return confidence >= threshold;
}

// ── 통합 JSON 파싱 ───────────────────────────────────────────────────────────

/**
 * LLM raw 응답에서 첫 `{` ~ 마지막 `}` 객체를 추출해 두 갈래 배열로 환산한다. 코드펜스
 * (```json) · 앞뒤 잡담을 허용한다(regex-strengthen-cycle.ts:349 양식 — 거기선 배열이라
 * `[` `]`, 여기선 객체라 `{` `}`). chunkSummaries·relationSummaries 두 키를 읽고 형식
 * 어긋난 원소는 거른다(snake_case·camelCase 둘 다 받아 camelCase 로 정규화). 객체를 못
 * 찾거나 JSON 문법이 깨졌으면 throw — 호출자(글루)가 그 문서를 loud warn 으로 건너뛴다
 * (silent 0건 위장 금지). 두 키가 부재하면 빈 배열로 채운다(정직한 "발굴 0건").
 */
export function parseSummaryResponse(raw: string): ParsedSummaryResponse {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(
      `LLM 응답에서 JSON 객체를 못 찾음 (앞 80자: ${JSON.stringify(raw.slice(0, 80))})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    throw new Error(
      `LLM 응답 JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LLM 응답이 객체가 아님(두 갈래 배열을 담은 객체여야 함)");
  }

  const obj = parsed as Record<string, unknown>;
  const chunkSummaries: ParsedChunkSummary[] = [];
  const relationSummaries: ParsedRelationSummary[] = [];

  const rawChunks = obj.chunkSummaries;
  if (Array.isArray(rawChunks)) {
    for (const el of rawChunks) {
      const c = normalizeChunkSummary(el);
      if (c !== null) chunkSummaries.push(c);
    }
  }

  const rawRelations = obj.relationSummaries;
  if (Array.isArray(rawRelations)) {
    for (const el of rawRelations) {
      const r = normalizeRelationSummary(el);
      if (r !== null) relationSummaries.push(r);
    }
  }

  return { chunkSummaries, relationSummaries };
}

/**
 * 한 청크요약 원소를 정규화. chunk_id(정수)·summary_text(비어있지 않은 문자열)·
 * confidence(0~1 숫자) 가 갖춰져야 통과, 아니면 null(거름). snake_case·camelCase 둘 다.
 */
function normalizeChunkSummary(el: unknown): ParsedChunkSummary | null {
  if (typeof el !== "object" || el === null) return null;
  const o = el as Record<string, unknown>;

  const chunkId = pickInteger(o, "chunk_id", "chunkId");
  const summaryText = pickString(o, "summary_text", "summaryText");
  const confidence = pickConfidence(o, "confidence");

  if (chunkId === null || summaryText === null || confidence === null) return null;
  return { chunkId, summaryText, confidence };
}

/**
 * 한 관계요약 원소를 정규화. from_concept_id·to_concept_id(개념 id cpt_/psn_ — 비어있지
 * 않은 문자열)·relation_name·summary_text(비어있지 않은 문자열)·confidence(0~1) 가 갖춰져야
 * 통과, 아니면 null(거름). 개념 id 는 TEXT 이므로 정수가 오면 거른다(pickString).
 */
function normalizeRelationSummary(el: unknown): ParsedRelationSummary | null {
  if (typeof el !== "object" || el === null) return null;
  const o = el as Record<string, unknown>;

  const fromConceptId = pickString(o, "from_concept_id", "fromConceptId");
  const toConceptId = pickString(o, "to_concept_id", "toConceptId");
  const relationName = pickString(o, "relation_name", "relationName");
  const summaryText = pickString(o, "summary_text", "summaryText");
  const confidence = pickConfidence(o, "confidence");

  if (fromConceptId === null || toConceptId === null) return null;
  if (relationName === null || summaryText === null || confidence === null) return null;
  return { fromConceptId, toConceptId, relationName, summaryText, confidence };
}

// ── 정규화 helper ────────────────────────────────────────────────────────────

/** 기본 로그 앞머리(글루가 사이클별 prefix 주입 시 덮음). */
const DEFAULT_LOG_PREFIX = "[deep-pass:summary]";

/** 청크 id 집합(정수)을 정렬해 쉼표로 잇는다(warn 식별자 표시 — 결정적 순서). */
function joinIds(ids: ReadonlySet<number>): string {
  return [...ids].sort((a, b) => a - b).join(",");
}

/** 개념 id 집합(cpt_/psn_ TEXT)을 정렬해 쉼표로 잇는다(warn 식별자 표시 — 결정적 순서). */
function joinConceptIds(ids: ReadonlySet<string>): string {
  return [...ids].sort((a, b) => a.localeCompare(b)).join(",");
}

/** 객체에서 주어진 키들 중 첫 정수 값을 찾는다(snake/camel 둘 다 허용). */
function pickInteger(o: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isInteger(v)) return v;
  }
  return null;
}

/** 객체에서 주어진 키들 중 첫 비어있지 않은 문자열 값을 찾는다(snake/camel 둘 다). */
function pickString(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/** 객체에서 confidence 를 찾는다 — 0~1 범위 숫자만 통과(밖이거나 비숫자면 null). */
function pickConfidence(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  if (v < 0 || v > 1) return null;
  return v;
}
