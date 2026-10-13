/**
 * person-link-candidate-query.ts — person_link 후보 프롤로그 (사이클·dryRun·외부 표면 공유).
 *
 * runPersonLinkInferCycle 과 detectPersonLinkDryRun 에 2벌로 중복돼 있던 후보 검출
 * 프롤로그(사람 로드 → SQL 후보 → 언급/후보 필터 → 결정적 top-K 사전 필터 → 지문 산출
 * → 결과 원장 2차 제외 → existingPersonIds 조회)를 조회 가능한 단일 함수로 추출한다
 * (spec 6.1). person-link-infer-cycle.ts 는 여기서 import 해 옛 공개 이름을 re-export 하고
 * (import 경로 무변경 — person-link-infer-prompt.ts 분리 선례), 외부 표면 공유층
 * (server-internal/cleanup-external/candidates.ts)이 collectPersonLinkCandidates 로 같은
 * 후보를 REST/MCP 로 노출한다.
 *
 * 이 모듈은 LLM 을 절대 부르지 않는다(순수 조회 + 직렬화). 계층: src/memory/ 도메인 층이라
 * server-internal 을 import 하지 않는다(layering.test.ts 가 지킨다).
 */

import type { Database } from "bun:sqlite";
import type { Person } from "./types.ts";
import { personLinkFingerprint } from "./cleanup-deep-pass/stage-fingerprint.ts";
import {
  prefilterPersonCandidates,
  type PrefilterNode,
  type PrefilterPerson,
} from "./person-link-prefilter.ts";
import { filterCandidatesByLedger } from "./cleanup-deep-pass/stage-results-ledger.ts";
import { cleanupStageLlmLimitsOf } from "./cleanup-deep-pass/stage-constants.ts";

export const PERSON_LINK_KIND = "person_link";

/**
 * top-K 사전 필터 default 상한(spec 5.B-3 person_link prefilterTopK, 상수 맵 단일 출처).
 * 순환 import 를 피해 cleanupStageLlmLimitsOf("person_link").prefilterTopK! 를 이 모듈에서
 * 직접 읽는다 — person-link-infer-cycle.ts 가 이 상수를 re-export 한다.
 */
export const PERSON_LINK_PREFILTER_TOP_K =
  cleanupStageLlmLimitsOf("person_link").prefilterTopK!;

export const PERSON_LINK_CANDIDATE_SOURCE_TYPES = [
  "llm_extract",
  "user_explicit",
  "user_tag",
  "regex_l0",
] as const;

export interface PersonLinkPersonContext {
  personId: string;
  displayName: string;
  aliases: string[];
  facts: {
    birthday: string | null;
    address: string | null;
    gender: string | null;
  };
  attributes: Array<{ name: string; category: string | null }>;
}

export interface PersonLinkNodeContext {
  id: number;
  content: string;
  personCandidates: string[];
  existingPersonIds: string[];
  /**
   * 결정적 top-K 사전 필터(spec 4.A-7)가 좁힌 노드별 후보 personId 목록. LLM 프롬프트에는
   * 200명 전 명단이 아니라 노드별 이 소수만 싣는다. 이 목록은 fingerprint 에도 실려(좁힌
   * 대상이 바뀌면 지문이 달라져 재평가) 원장 재과금 판정과 짝을 이룬다.
   */
  topKPersonIds: string[];
}

export interface PersonLinkCycleStore {
  listPersons(options?: { limit?: number }): Promise<Person[]>;
  listPersonAttributeConcepts(
    personId: string,
  ): Promise<Array<{ conceptId: string; name: string; category: string | null }>>;
  addNodePersonEdge(
    nodeId: number,
    personId: string,
    relation: "mentions",
    provenance: "llm_extract",
    sourceNodeId: number,
  ): Promise<boolean>;
}

/** SQL 1차 후보 raw 한 행. */
interface CandidateRow {
  id: number;
  content: string;
  metadata_json: string;
}

/** collectPersonLinkCandidates 산출 한 행 — 노드 컨텍스트 + 원장 대조 키(지문 동반). */
export interface PersonLinkCandidateRow {
  id: number;
  content: string;
  personCandidates: string[];
  existingPersonIds: string[];
  topKPersonIds: string[];
  targetKey: string;
  inputFingerprint: string;
  stageVersion: number;
}

/** collectPersonLinkCandidates 의존 — 사이클·dryRun·외부 표면이 공유. */
export interface CollectPersonLinkCandidatesDeps {
  db: Database;
  store: PersonLinkCycleStore;
  batchSize: number;
  stageVersion: number;
  personLimit?: number;
  prefilterTopK?: number;
  /** 이 메모들만 후보로(입력 직후 정리·펫 바로 정리). 없으면 전체에서 batchSize 개. */
  nodeIds?: readonly number[];
}

/**
 * 사이클·dryRun·외부 표면이 공유하는 후보 프롤로그 — 사람 로드 → SQL 후보 → 언급/후보
 * 필터 → top-K → 지문 → 원장 2차 제외. LLM 미호출.
 *
 * 현행 사이클과 같은 계산 시점을 유지한다: 원장 필터(filterCandidatesByLedger)를 먼저
 * 적용하고, 남은 행에만 existingPersonIds DB 조회를 붙인다(탈락 행에 조회를 돌리지
 * 않는다 — 관측 가능한 동작 불변). 사람 0명(연결 대상 없음)이면 rows [].
 */
export async function collectPersonLinkCandidates(
  deps: CollectPersonLinkCandidatesDeps,
): Promise<{ people: PersonLinkPersonContext[]; rows: PersonLinkCandidateRow[] }> {
  const people = await loadPeople(deps.store, deps.personLimit ?? 200);
  if (people.length === 0) return { people, rows: [] };

  const tokens = knownPersonTokens(people);
  const rawRows = queryCandidates(deps.db, deps.batchSize, deps.nodeIds);
  const filteredRows = rawRows.filter((row) => {
    const candidates = readPersonCandidates(row.metadata_json);
    return candidates.length > 0 || textMentionsKnownPerson(row.content, tokens);
  });

  const prefilterPeople: PrefilterPerson[] = people.map((p) => ({
    personId: p.personId,
    displayName: p.displayName,
    aliases: p.aliases,
    labels: p.attributes.map((a) => a.name),
  }));
  const prefilterNodes: PrefilterNode[] = filteredRows.map((row) => ({
    id: row.id,
    content: row.content,
    personCandidates: readPersonCandidates(row.metadata_json),
  }));
  const topK = deps.prefilterTopK ?? PERSON_LINK_PREFILTER_TOP_K;
  const topKByNode = prefilterPersonCandidates(prefilterNodes, prefilterPeople, topK);

  const withFp = filteredRows.map((row) => ({
    id: row.id,
    content: row.content,
    personCandidates: readPersonCandidates(row.metadata_json),
    topKPersonIds: topKByNode.get(row.id) ?? [],
    targetKey: String(row.id),
    inputFingerprint: personLinkFingerprint({
      content: row.content,
      personCandidates: readPersonCandidates(row.metadata_json),
      topKPersonIds: topKByNode.get(row.id) ?? [],
    }),
    stageVersion: deps.stageVersion,
  }));

  // 현행 사이클과 같은 계산 시점 — 원장 필터를 먼저 적용하고, 남은 행에만
  // existingPersonIds DB 조회를 붙인다(탈락 행에 조회를 돌리지 않는다 — 동작 불변).
  const kept = filterCandidatesByLedger(deps.db, "person_link", withFp);
  const rows: PersonLinkCandidateRow[] = kept.map((row) => ({
    ...row,
    existingPersonIds: listExistingMentionPersonIds(deps.db, row.id),
  }));
  return { people, rows };
}

export async function loadPeople(
  store: PersonLinkCycleStore,
  limit: number,
): Promise<PersonLinkPersonContext[]> {
  const persons = await store.listPersons({ limit });
  const out: PersonLinkPersonContext[] = [];
  for (const person of persons) {
    const attributes = await store.listPersonAttributeConcepts(person.personId);
    out.push({
      personId: person.personId,
      displayName: person.displayName,
      aliases: person.aliases,
      facts: {
        birthday: person.birthday,
        address: person.address,
        gender: person.gender,
      },
      attributes: attributes.map((a) => ({
        name: a.name,
        category: a.category,
      })),
    });
  }
  return out;
}

export function queryCandidates(
  db: Database,
  batchSize: number,
  nodeIds?: readonly number[],
): CandidateRow[] {
  if (nodeIds !== undefined && nodeIds.length === 0) return [];
  const placeholders = PERSON_LINK_CANDIDATE_SOURCE_TYPES.map(() => "?").join(",");
  const nodeFilter =
    nodeIds !== undefined ? `AND kn.id IN (${nodeIds.map(() => "?").join(",")})` : "";
  return db
    .prepare(
      `SELECT kn.id, kn.content, kn.metadata_json
         FROM knowledge_nodes kn
        WHERE kn.source_type IN (${placeholders})
          AND NOT EXISTS(
            SELECT 1 FROM cleanup_proposals cp
             WHERE cp.kind = '${PERSON_LINK_KIND}'
               AND CAST(cp.payload_json ->> '$.nodeId' AS INTEGER) = kn.id
          )
          -- 노드 단위 완료 판정은 이제 결과 원장(cleanup_stage_results)이 맡는다(A-7). 아래
          -- personLinkInferred 필터는 A-7 이전 일괄 마킹으로 이미 완료된 옛 설치 노드를 계속
          -- 제외하는 legacy 게이트일 뿐(새 코드는 이 플래그를 더는 쓰지 않는다).
          AND (kn.metadata_json ->> '$.personLinkInferred' IS NULL
               OR kn.metadata_json ->> '$.personLinkInferred' != 1)
          ${nodeFilter}
        ORDER BY kn.created_at ASC, kn.id ASC
        LIMIT ?`,
    )
    .all(
      ...PERSON_LINK_CANDIDATE_SOURCE_TYPES,
      ...(nodeIds ?? []),
      batchSize,
    ) as CandidateRow[];
}

export function readPersonCandidates(metadataJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson || "{}");
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const meta = parsed as Record<string, unknown>;
  const keys = [
    "personCandidates",
    "llmPersonCandidates",
    "extractedPersonCandidates",
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const value = meta[key];
    if (!Array.isArray(value)) continue;
    for (const raw of value) {
      if (typeof raw !== "string") continue;
      const name = raw.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export function knownPersonTokens(people: PersonLinkPersonContext[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const person of people) {
    for (const raw of [person.displayName, ...person.aliases]) {
      const token = raw.trim();
      if (token.length < 2 || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

export function textMentionsKnownPerson(
  content: string,
  tokens: readonly string[],
): boolean {
  return tokens.some((token) => content.includes(token));
}

export function listExistingMentionPersonIds(db: Database, nodeId: number): string[] {
  const rows = db
    .prepare(
      `SELECT person_id FROM node_person_edges
        WHERE node_id = ? AND relation = 'mentions'
        ORDER BY person_id ASC`,
    )
    .all(nodeId) as Array<{ person_id: string }>;
  return rows.map((r) => r.person_id);
}
