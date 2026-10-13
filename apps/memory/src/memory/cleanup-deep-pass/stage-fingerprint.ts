/**
 * stage-fingerprint.ts — 깊은 패스 단계별 입력 지문 산출기 (spec 4.A-3).
 *
 * 결과 원장(cleanup_stage_results)의 재처리 조건 한 축이 input_fingerprint 다.
 * 대상 내용·관련 설정이 그대로면 지문이 같아 재과금하지 않고, 바뀌면 지문이 달라져
 * 자연 재평가된다(다른 축 stage_version 은 프롬프트·파서 계약 개정 신호 — B-3a 상수 맵).
 *
 * 결정성 요구:
 *   - 같은 입력이면 언제나 같은 지문. 목록은 순서에 민감하지 않도록 정렬 후 해시한다
 *     (후보 검출 순서가 달라도 같은 대상은 같은 지문이어야 함).
 *   - 필드 경계를 단위 구분자(U+001F)로 끊어 "ab"+"c" 와 "a"+"bc" 가 충돌하지 않게 한다.
 *
 * 해시는 프로젝트 기존 관례(content-hash.ts)와 같이 node:crypto 의 sha256(Bun 내장,
 * 새 의존성 0)을 hex 로 쓴다. 지문은 저렴·결정적이면 충분하고 충돌 저항이 sha256 이면
 * 과분할 만큼 안전하다.
 *
 * 단계별 해시 입력 표(spec 4.A-3):
 *   regex_strengthen    = 노드 content
 *   summary             = 청크 content + atomic 내용 목록
 *   relation_discovery  = 소속 청크 id·content 목록 + 허용 개념 집합 id 목록
 *   person_link         = 노드 content + personCandidates + 사전 필터 top-K personId 목록
 *   lens_draft          = 대상 엔티티 현재 구조화 값 + EntityLens 직렬화 + 근거 노드 id 목록
 *   entity_register     = 메모 본문 + 작성일
 */

import { createHash } from "node:crypto";

/** 필드 경계 구분자 — 인접 필드 값의 우연한 결합 충돌을 막는다(U+001F Unit Separator). */
const FIELD_SEP = "\u001f";
/** 목록 요소 구분자 — 필드 안 목록의 요소 경계(U+001E Record Separator). */
const LIST_SEP = "\u001e";

/** 깊은 패스 단계 식별자 — 원장 stage 칸·지문 도메인 접두. */
export type CleanupStage =
  | "regex_strengthen"
  | "summary"
  | "relation_discovery"
  | "person_link"
  | "lens_draft"
  | "entity_register";

/** regex_strengthen 지문 입력 — 후보 raw 노드의 원문. */
export interface RegexFingerprintInput {
  content: string;
}

/** summary 지문 입력 — 청크 원문 + 그 청크에서 뽑힌 atomic 내용 목록. */
export interface SummaryFingerprintInput {
  chunkContent: string;
  atomics: readonly string[];
}

/** relation_discovery 지문 입력 — 소속 청크(id·content) 목록 + 허용 개념 집합 id 목록. */
export interface RelationDiscoveryFingerprintInput {
  chunks: readonly { id: number; content: string }[];
  allowedConceptIds: readonly string[];
}

/**
 * person_link 지문 입력 — 노드 content + 후보 사람 목록 + top-K personId 목록.
 *
 * topKPersonIds 는 A-7 의 결정적 사전 필터(person-link-prefilter.ts)가 좁힌 노드별 소수
 * 후보다. person_link 사이클이 이 값을 채워 넘긴다 — 사전 필터가 좁힌 대상(사람 명단·별칭
 * 변화 등)이 바뀌면 지문이 달라져 그 노드가 자연 재평가된다(재과금 판정과 짝). 사람이 아직
 * 하나도 없거나 매칭 0 인 노드는 빈 배열이 정상값이다.
 */
export interface PersonLinkFingerprintInput {
  content: string;
  personCandidates: readonly string[];
  topKPersonIds: readonly string[];
}

/** lens_draft 지문 입력 — 엔티티 현재 구조화 값 + 렌즈 직렬화 + 근거 노드 id 목록. */
export interface LensDraftFingerprintInput {
  entityStructuredValue: string;
  lensSerialization: string;
  evidenceNodeIds: readonly number[];
}

/**
 * 필드 배열을 도메인(stage) 접두와 함께 결정적 문자열로 이어 sha256 hex 를 낸다.
 * 목록 필드는 호출부가 정렬해 문자열화한 뒤 하나의 필드로 넘긴다.
 */
function hashFields(stage: CleanupStage, fields: readonly string[]): string {
  const joined = [stage, ...fields].join(FIELD_SEP);
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

/** 문자열 목록을 정렬(순서 비의존) 후 LIST_SEP 로 이어 한 필드 값으로 만든다. */
function listField(values: readonly string[]): string {
  return [...values].sort().join(LIST_SEP);
}

/** regex_strengthen — 노드 content 지문. */
export function regexFingerprint(input: RegexFingerprintInput): string {
  return hashFields("regex_strengthen", [input.content]);
}

/** summary — 청크 content + atomic 목록 지문(atomic 순서 비의존). */
export function summaryFingerprint(input: SummaryFingerprintInput): string {
  return hashFields("summary", [input.chunkContent, listField(input.atomics)]);
}

/**
 * relation_discovery — 소속 청크(id·content) 목록 + 허용 개념 id 목록 지문.
 * 청크는 (id, content) 쌍을 결정적으로 직렬화해 정렬한다 — 같은 문서의 같은 청크
 * 집합이면 검출 순서와 무관하게 같은 지문.
 */
export function relationDiscoveryFingerprint(
  input: RelationDiscoveryFingerprintInput,
): string {
  const chunkField = listField(
    input.chunks.map((c) => `${c.id}${LIST_SEP}${c.content}`),
  );
  return hashFields("relation_discovery", [chunkField, listField(input.allowedConceptIds)]);
}

/** person_link — 노드 content + 후보 사람 + top-K personId 지문(후보·top-K 순서 비의존). */
export function personLinkFingerprint(input: PersonLinkFingerprintInput): string {
  return hashFields("person_link", [
    input.content,
    listField(input.personCandidates),
    listField(input.topKPersonIds),
  ]);
}

/** lens_draft — 엔티티 현재 값 + 렌즈 직렬화 + 근거 노드 id 목록 지문(근거 순서 비의존). */
export function lensDraftFingerprint(input: LensDraftFingerprintInput): string {
  const evidenceField = listField(input.evidenceNodeIds.map((n) => String(n)));
  return hashFields("lens_draft", [
    input.entityStructuredValue,
    input.lensSerialization,
    evidenceField,
  ]);
}

/** entity_register 지문 입력 — 메모 본문 + 작성일만(spec 3장 2번: 기존 항목 목록은 넣지 않는다). */
export interface EntityRegisterFingerprintInput {
  content: string;
  createdAt: string;
}

/**
 * entity_register — 메모 본문 + 작성일 지문. 기존 사람·항목 목록을 넣으면 새 사람 하나가 생길
 * 때마다 모든 메모의 지문이 바뀌어 전체 재처리가 일어나므로 넣지 않는다.
 */
export function entityRegisterFingerprint(input: EntityRegisterFingerprintInput): string {
  return hashFields("entity_register", [input.content, input.createdAt]);
}
