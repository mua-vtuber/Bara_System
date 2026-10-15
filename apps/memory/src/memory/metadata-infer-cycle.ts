/**
 * metadata-infer-cycle.ts — Phase 7 2차 갈래 2(맥락 추론 메타 전파)의 한 사이클 글루.
 *
 * 권위: docs/decisions/2026-06-04-phase7-2nd-active-loop-plan.md Task 6
 *       docs/decisions/2026-06-02-phase7-redesign-design.md 단락 3.7
 *
 * 슬롯 소속(DCL-3, docs/decisions/2026-07-11-cleanup-ai-efficient-operation-spec.md
 * 단락 6.C-1): 이름은 데이터 정리 AI 계열이지만 실행은 의도적으로 extractor 슬롯·
 * 스케줄러를 그대로 탄다 — 얕고 잦은 작업에는 가볍고 무료인 로컬 모델이 맞다.
 * 산출이 cleanup_proposals 로 합류하는 것은 검토 게이트 공유일 뿐 슬롯 공유가 아니다.
 *
 * 이 모듈은 *스케줄러가 아니라* 한 번 호출하면 한 사이클을 도는 함수다. extractor
 * backfill 사이클이 끝나는 지점(scheduler.ts `startBackfillScheduler` 의
 * `onCycleComplete`)에서 index.ts wiring 이 이 함수를 이어서 부른다 — 별도 setInterval·
 * cadence·offset·락 0(extractor 사이클과 순차라 겹침 없음).
 *
 * 한 사이클 흐름:
 *   1. 후보 SQL — 같은 작성자·created_at 순·메타 유무 플래그를 단 노드 조회. 멱등 제외
 *      두 겹 — (a) 이미 metadata_fill 제안이 있는 노드(거절된 것 재생성 차단),
 *      (b) metaInferred=1 마킹이 달린 노드(이미 평가 완료 — 제안 0건이어도 마킹돼
 *      무한 재평가 차단).
 *   2. groupSessions — 노드 시각만으로 세션(간격 G 분)으로 묶기.
 *   3. pickRipeSessions(now) — 마지막 글 + G ≤ now 인 익은(닫힌) 세션만(진행 중 미룸).
 *   4. pickMixedSessions — 메타 있음 ≥1 + 없음 ≥1 인 세션만(LLM 호출 절약).
 *   5. LLM — 섞인 세션 하나씩 "한 사건? 빈 노드에 어느 장소/시각 전파?" 물어 제안 회수.
 *      LLM 이 정상 회신하면(빈 배열 포함) 그 세션 전체 노드에 metaInferred=1 마킹
 *      (제안 0건도 평가 완료 — 재시도 대상 아님). LLM throw 한 세션은 마킹 안 함(재시도).
 *   6. ID 검증 — LLM 이 낸 nodeId 가 그 세션 안 노드인지 확인(환각 차단), 아니면 그
 *      제안 버림(loud console.warn). 이어서 값 출처 검증 — 대상 칸이 비어 있고, 값이
 *      같은 세션 다른 노드의 실제 장소·시각 값과 같을 때만 남긴다(본문 짐작 값 차단).
 *   7. cleanup_proposals insert(kind='metadata_fill', payload 양식 Task 4 정합) +
 *      eventBus.emit("cleanup_proposals_ready", { count })(0건이면 emit 안 함).
 *
 * 자동 적용 0 — 이 사이클은 cleanup_proposals insert 까지만. addClassificationTag/
 * setEventAt 는 *부르지 않는다*(그건 사용자가 approve 한 시점에 Task 4 라우트가).
 *
 * graceful: LLM(llm=null) 미가용 또는 enabled=false → no-op + 사유 로그(잘못된 자동
 * 데이터 0). silent fallback 금지 — 실패·환각은 식별자 담은 loud console.warn.
 */

import type { Database } from "bun:sqlite";
import type { LlmClient } from "../llm/types.ts";
import { LLM_CALL_LABELS } from "../llm/call-labels.ts";
import type { EventPublisher } from "./events/event-contract.ts";
import {
  groupSessions,
  pickMixedSessions,
  pickRipeSessions,
  type Session,
  type SessionNode,
} from "./session-grouping.ts";

// ── 모듈 상수 (하드코딩 금지 — 한곳에 격리) ──────────────────────────────────

/**
 * 갈래 2 가 메타 전파를 고려하는 노드 종류(source_type). 메타(장소·event_at)가
 * 붙는 *실제 메모리* 노드만 본다 — 추출 atomic(llm_extract)·사용자 직접 입력
 * (user_explicit/user_tag) + 정규식 1단 추출. 자식·중간 노드(document_chunk·
 * image_caption)와 raw 원본(auto_capture, 추출되면 자식 atomic 으로 갈음됨)은 뺀다 —
 * 1차 metadata-apply 가 atomic 에 메타를 붙인 흐름과 정합. 인라인 리터럴 회피.
 */
export const META_CANDIDATE_SOURCE_TYPES = [
  "llm_extract",
  "user_explicit",
  "user_tag",
  "regex_l0",
] as const;

/** payload·event 의 metadata_fill 식별 문자열. Task 4 KNOWN_KINDS 와 정합. */
export const METADATA_FILL_KIND = "metadata_fill";

/** 제안 생성 시 emit 하는 이벤트 type. Task 3 EventBus·Task 1 events 큐 정합. */
export const CLEANUP_PROPOSALS_READY_EVENT = "cleanup_proposals_ready";

/** 갈래 2 가 전파하는 메타 칸 — Task 4 approve 분기('place'|'event_at')와 1:1. */
export type MetadataField = "place" | "event_at";

/** LLM 이 회신하는 한 제안. nodeId 는 *그 세션 안* 빈 노드여야 한다(ID 검증 대상). */
export interface InferredProposal {
  /** 빈 칸을 채울 대상 노드 id(세션 안 노드여야 함 — 환각 차단). */
  nodeId: number;
  /** 채울 메타 칸. */
  field: MetadataField;
  /** 채울 값(장소 이름 또는 ISO 시각 문자열). */
  value: string;
  /** 근거 — 어느 노드/문장에서 추론했는지(사용자 판단용 자유 칸). */
  evidence?: string;
}

/**
 * 한 세션을 LLM 에 넘겨 제안 목록을 받는 추론 함수. *실제* ollama 호출 구현은
 * createOllamaInferFn 가 만들고, 테스트는 데이터 fixture 응답을 내는 함수를 주입한다
 * (인터페이스 가짜 구현체가 아니라 함수 인자 — mock 객체 금지 규칙 정합).
 *
 * 회신은 InferredProposal 배열. 빈 배열 = "전파할 것 없음" 의 정직한 결과다.
 * throw 하면 글루가 그 세션을 건너뛰고 식별자 담은 loud console.warn 을 남긴다.
 */
export type SessionInferFn = (
  session: SessionInferInput,
) => Promise<InferredProposal[]>;

/** LLM 판단 입력 — 세션 안 노드의 id·내용·메타 유무·값. */
export interface SessionInferInput {
  nodes: ReadonlyArray<{
    id: number;
    content: string;
    place: string | null;
    eventAt: string | null;
  }>;
}

/** 한 사이클 결과 요약(관측·테스트·로그용). */
export interface MetadataInferCycleSummary {
  /** 후보로 줍힌 노드 수(멱등 제외 후). */
  candidatesFound: number;
  /** 묶인 세션 수. */
  sessionsGrouped: number;
  /** 익은(닫힌) 세션 수. */
  ripeSessions: number;
  /** 섞인(LLM 호출 대상) 세션 수. */
  mixedSessions: number;
  /** insert 된 metadata_fill 제안 수. */
  proposalsInserted: number;
  /** ID·칸·값 검증에서 버린 환각 제안 수(loud warn 동반). */
  rejectedHallucinations: number;
  /** LLM 호출이 throw 해 건너뛴 세션 수. */
  inferFailures: number;
}

// ── 후보 조회 한 행 ──────────────────────────────────────────────────────────

interface CandidateRow {
  id: number;
  author: string;
  content: string;
  created_at: string;
  has_place: number;
  has_event_at: number;
  place_value: string | null;
  event_at_value: string | null;
}

export interface MetadataInferCycleDeps {
  /** 후보·멱등·insert 에 쓰는 raw DB 핸들(store.getRawDb()). */
  db: Database;
  /**
   * LLM 판단 함수. null 이면 graceful no-op(LLM 미가용·enabled=false). 함수 주입
   * 구조라 테스트는 데이터 fixture 응답 함수를 넘긴다(mock 객체 0).
   */
  infer: SessionInferFn | null;
  /** 알림 버스 — 제안 insert 직후 cleanup_proposals_ready emit(0건이면 emit 안 함). */
  eventBus: EventPublisher;
  /** 세션 묶기·익음 판정 간격 G(분). 설정값(하드코딩 0). */
  gapMinutes: number;
  /** 한 사이클 후보 노드 최대 수. 설정값(하드코딩 0). */
  batchSize: number;
  /** 현재 시각 주입(밀리초 epoch). 미주입 시 Date.now — 테스트는 고정값 주입. */
  now?: () => number;
  /** 로그 prefix. 기본 "[metadata-infer]". */
  logPrefix?: string;
}

/**
 * 갈래 2 한 사이클을 실행한다. enabled=false 또는 LLM 미가용(infer=null)이면 no-op +
 * 사유 로그(graceful). 그 외에는 후보 조회 → 세션 묶기 → 익은·섞인 세션 추림 → LLM
 * 판단 → ID 검증 → cleanup_proposals insert → emit 까지 한다.
 *
 * @returns 사이클 요약. no-op 이면 전부 0.
 */
export async function runMetadataInferCycle(
  deps: MetadataInferCycleDeps,
): Promise<MetadataInferCycleSummary> {
  const logPrefix = deps.logPrefix ?? "[metadata-infer]";
  const now = (deps.now ?? (() => Date.now()))();

  const empty: MetadataInferCycleSummary = {
    candidatesFound: 0,
    sessionsGrouped: 0,
    ripeSessions: 0,
    mixedSessions: 0,
    proposalsInserted: 0,
    rejectedHallucinations: 0,
    inferFailures: 0,
  };

  // graceful — LLM 미가용(infer=null). 잘못된 자동 데이터 0, 정직한 비활성 로그.
  if (deps.infer === null) {
    console.log(
      `${logPrefix} LLM 미가용 — 갈래 2 한 사이클 건너뜀(no-op).`,
    );
    return empty;
  }

  // ── 1. 후보 조회(멱등 제외) ────────────────────────────────────────────────
  const candidates = queryCandidates(deps.db, deps.batchSize);
  if (candidates.length === 0) {
    return empty;
  }

  // ── 2. 세션 묶기(노드 시각만) ─────────────────────────────────────────────
  const sessionNodes: SessionNode[] = candidates.map((row) => ({
    id: row.id,
    author: row.author,
    createdAtMs: parseSqliteLocaltimeMs(row.created_at),
    hasPlace: row.has_place === 1,
    hasEventAt: row.has_event_at === 1,
  }));
  const sessions = groupSessions(sessionNodes, deps.gapMinutes);

  // ── 3. 익은(닫힌) 세션만 ──────────────────────────────────────────────────
  const ripe = pickRipeSessions(sessions, deps.gapMinutes, now);

  // ── 4. 섞인 세션만 ────────────────────────────────────────────────────────
  const mixed = pickMixedSessions(ripe);

  // 노드 본문·메타값을 빠르게 찾도록 인덱싱(LLM 입력 + ID 검증 둘 다 쓴다).
  const rowById = new Map<number, CandidateRow>();
  for (const row of candidates) rowById.set(row.id, row);

  let proposalsInserted = 0;
  let rejectedHallucinations = 0;
  let inferFailures = 0;

  // ── 5~7. 세션별 LLM 판단 → ID 검증 → insert ──────────────────────────────
  for (const session of mixed) {
    const allowedIds = new Set(session.nodes.map((n) => n.id));
    const inferInput = buildInferInput(session, rowById);

    let proposals: InferredProposal[];
    try {
      proposals = await deps.infer(inferInput);
    } catch (e) {
      // LLM 호출이 throw 한 세션은 *평가가 안 된* 것 — 마킹하지 않는다(다음
      // 사이클 재시도 정당). 마킹은 LLM 이 정상 회신한(빈 배열 포함) 세션만.
      inferFailures += 1;
      console.warn(
        `${logPrefix} LLM 판단 실패 — 세션 건너뜀(nodeIds=${[...allowedIds].join(",")}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      continue;
    }

    // 평가 완료 마킹(원인 1 차단) — LLM 이 정상 회신했으면 그 세션의 *모든* 후보
    // 노드에 metaInferred=1 을 단다. 제안 0건이어도 마킹한다(빈 배열 = "전파할 것
    // 없음" 의 정직한 결과이지 재시도 대상이 아님). 마킹 없이 두면 제안 안 달린
    // 노드가 멱등 제외되지 않아 같은 세션이 매 사이클 또 평가돼 무한 루프가 된다.
    markSessionEvaluated(deps.db, [...allowedIds]);

    for (const proposal of proposals) {
      // ID 검증 — LLM 이 낸 nodeId 가 *그 세션 안* 노드인가(환각 차단).
      if (!allowedIds.has(proposal.nodeId)) {
        rejectedHallucinations += 1;
        console.warn(
          `${logPrefix} 환각 제안 버림 — nodeId=${proposal.nodeId} 가 세션(${[
            ...allowedIds,
          ].join(",")}) 밖. field=${proposal.field}`,
        );
        continue;
      }
      // 칸 검증 — place|event_at 외 값은 버린다(Task 4 분기 정합).
      if (proposal.field !== "place" && proposal.field !== "event_at") {
        rejectedHallucinations += 1;
        console.warn(
          `${logPrefix} 잘못된 field 제안 버림 — nodeId=${proposal.nodeId} field=${JSON.stringify(
            proposal.field,
          )}`,
        );
        continue;
      }
      // 값 검증 — 비어 있으면 버린다(빈 값 위조 금지).
      const value = typeof proposal.value === "string" ? proposal.value.trim() : "";
      if (!value) {
        rejectedHallucinations += 1;
        console.warn(
          `${logPrefix} 빈 value 제안 버림 — nodeId=${proposal.nodeId} field=${proposal.field}`,
        );
        continue;
      }
      // 값 출처 검증 — 세션 안 다른 노드의 실제 값만 전파한다(본문 짐작 값 차단).
      const valueReject = rejectReasonForValue(session, rowById, proposal, value);
      if (valueReject) {
        rejectedHallucinations += 1;
        console.warn(
          `${logPrefix} 제안 버림(${valueReject}) — nodeId=${proposal.nodeId} field=${proposal.field} value=${JSON.stringify(value)}`,
        );
        continue;
      }

      // insert — kind='metadata_fill', payload 양식 Task 4 정합.
      insertProposal(deps.db, {
        nodeId: proposal.nodeId,
        field: proposal.field,
        value,
        evidence:
          typeof proposal.evidence === "string" ? proposal.evidence : undefined,
      });
      proposalsInserted += 1;
    }
  }

  // ── emit — 0건이면 안 함 ──────────────────────────────────────────────────
  if (proposalsInserted > 0) {
    deps.eventBus.emit(CLEANUP_PROPOSALS_READY_EVENT, {
      count: proposalsInserted,
      kind: METADATA_FILL_KIND,
    });
  }

  const summary: MetadataInferCycleSummary = {
    candidatesFound: candidates.length,
    sessionsGrouped: sessions.length,
    ripeSessions: ripe.length,
    mixedSessions: mixed.length,
    proposalsInserted,
    rejectedHallucinations,
    inferFailures,
  };

  if (proposalsInserted > 0 || rejectedHallucinations > 0 || inferFailures > 0) {
    console.log(
      `${logPrefix} cycle: 후보 ${summary.candidatesFound} / 세션 ${summary.sessionsGrouped} / 익음 ${summary.ripeSessions} / 섞임 ${summary.mixedSessions} → 제안 +${proposalsInserted}, 환각버림 ${rejectedHallucinations}, LLM실패 ${inferFailures}`,
    );
  }

  return summary;
}

// ── 내부 SQL ─────────────────────────────────────────────────────────────────

/**
 * 후보 노드 조회 — 같은 작성자·created_at 순으로 줍되:
 *   - source_type ∈ META_CANDIDATE_SOURCE_TYPES (실제 메모리 노드 한정)
 *   - 멱등 제외 1 (제안 있음) — 그 노드를 대상으로 한 metadata_fill 제안이
 *     cleanup_proposals 에 이미 있으면(pending/approved/rejected 무관) 뺀다.
 *     payload_json->>'$.nodeId' 가 그 노드 id 인 제안이 하나라도 있으면 거른다
 *     (거절된 것 재생성 차단).
 *   - 멱등 제외 2 (평가 완료 마킹) — metadata.metaInferred=1(정수)이 달린 노드는
 *     뺀다. 한 익은 세션을 LLM 에 넘겨 평가하면 *제안 유무와 무관하게* 그 세션의
 *     모든 후보 노드에 markMetaInferred 가 이 플래그를 단다. 제안 0건(빈 배열·파싱
 *     실패·세션 일부만 채움)이면 제안 없음 멱등(제외 1)이 안 걸려, 이 마킹이 없으면
 *     같은 노드가 매 사이클 또 평가돼 같은 LLM 호출이 무한 반복된다(원인 1 차단).
 *   - has_place — 장소가 붙은 노드. 두 경로 OR(후속 M-2): (1) 옛 concept→concept 위계
 *     (추론 addClassificationTag·ckey.name='장소') (2) place-엔티티(직접 입력·콜론 #장소·
 *     잎개념↔place 행 entity_concept_edges role='identity' + entities type_name='place'·
 *     단계4 T4 통합 엣지 이전·옛 place_concept_edges 폐기). ①만 보던 옛 SQL 이 직접/콜론
 *     장소를 has_place=0 으로 오인하던 결함을 닫는다.
 *   - has_event_at — event_at IS NOT NULL.
 *   - place_value — 가장 닮은 장소 값 한 개(LLM 입력 맥락용 / 없으면 NULL). 경로1 우선
 *     COALESCE 경로2(place-엔티티 잎 개념 이름).
 *
 * created_at ASC + id ASC 정렬은 세션 묶기 전제(시간순)와 정합한다. batchSize 로
 * 한 사이클 처리량을 제한한다(하드코딩 0 — 설정값).
 *
 * 멱등 판정에서 nodeId 는 정수라 ->> 가 정수로 회신 — '$.nodeId' = kn.id 정수 비교.
 */
function queryCandidates(db: Database, batchSize: number): CandidateRow[] {
  const placeholders = META_CANDIDATE_SOURCE_TYPES.map(() => "?").join(",");
  const sql = `
    SELECT
      kn.id            AS id,
      kn.author        AS author,
      kn.content       AS content,
      kn.created_at    AS created_at,
      (
        -- 경로1: 옛 concept→concept 위계(추론 addClassificationTag·ckey.name='장소').
        EXISTS(
          SELECT 1 FROM node_concept_edges nce
          JOIN hierarchy_edges he
            ON he.target_id = nce.concept_id AND he.relation = 'parent_of'
          JOIN concept_nodes ckey
            ON ckey.concept_id = he.source_id
           AND ckey.is_classification_key = 1
           AND ckey.name = '장소'
          WHERE nce.node_id = kn.id AND nce.role = 'classification'
        )
        -- 경로2: place-엔티티(직접 입력·콜론 #장소·잎개념↔place 행 identity·후속 M-2).
        -- 분류 단계4 T4 — identity 엣지가 범용 통합 entity_concept_edges 에 모여, place
        -- 종류만 거르려면 entities(type_name='place')로 JOIN 한다(옛 place 전용 테이블은
        -- 구조적으로 place 만 담았으나 통합 테이블은 종류를 안 담으므로 명시 필터).
        OR EXISTS(
          SELECT 1 FROM node_concept_edges nce
          JOIN entity_concept_edges pce
            ON pce.concept_id = nce.concept_id AND pce.role = 'identity'
          JOIN entities pe
            ON pe.entity_id = pce.entity_id AND pe.type_name = 'place'
          WHERE nce.node_id = kn.id AND nce.role = 'classification'
        )
      )                AS has_place,
      (kn.event_at IS NOT NULL) AS has_event_at,
      kn.event_at      AS event_at_value,
      COALESCE(
        -- 경로1 우선(추론 concept→concept).
        (
          SELECT cval.name FROM node_concept_edges nce
          JOIN hierarchy_edges he
            ON he.target_id = nce.concept_id AND he.relation = 'parent_of'
          JOIN concept_nodes ckey
            ON ckey.concept_id = he.source_id
           AND ckey.is_classification_key = 1
           AND ckey.name = '장소'
          JOIN concept_nodes cval ON cval.concept_id = nce.concept_id
          WHERE nce.node_id = kn.id AND nce.role = 'classification'
          LIMIT 1
        ),
        -- 경로2: place-엔티티 잎 개념 이름(후속 M-2·단계4 T4 통합 엣지 + place 종류 필터).
        (
          SELECT cval.name FROM node_concept_edges nce
          JOIN entity_concept_edges pce
            ON pce.concept_id = nce.concept_id AND pce.role = 'identity'
          JOIN entities pe
            ON pe.entity_id = pce.entity_id AND pe.type_name = 'place'
          JOIN concept_nodes cval ON cval.concept_id = nce.concept_id
          WHERE nce.node_id = kn.id AND nce.role = 'classification'
          LIMIT 1
        )
      )                AS place_value
    FROM knowledge_nodes kn
    WHERE kn.source_type IN (${placeholders})
      AND NOT EXISTS(
        SELECT 1 FROM cleanup_proposals cp
        WHERE cp.kind = '${METADATA_FILL_KIND}'
          AND CAST(cp.payload_json ->> '$.nodeId' AS INTEGER) = kn.id
      )
      AND (kn.metadata_json ->> '$.metaInferred' IS NULL
           OR kn.metadata_json ->> '$.metaInferred' != 1)
    ORDER BY kn.author ASC, kn.created_at ASC, kn.id ASC
    LIMIT ?`;
  const rows = db
    .prepare(sql)
    .all(...META_CANDIDATE_SOURCE_TYPES, batchSize) as CandidateRow[];
  return rows;
}

/**
 * 한 metadata_fill 제안을 cleanup_proposals 에 추가한다. payload 양식은 Task 4
 * approve 분기({ nodeId, field, value, evidence? })와 1:1. id 는 'cp_' + uuid.
 * status 는 schema default 'pending'.
 */
function insertProposal(
  db: Database,
  proposal: { nodeId: number; field: MetadataField; value: string; evidence?: string },
): void {
  const payload: Record<string, unknown> = {
    nodeId: proposal.nodeId,
    field: proposal.field,
    value: proposal.value,
  };
  if (proposal.evidence !== undefined) payload.evidence = proposal.evidence;
  const id = `cp_${crypto.randomUUID()}`;
  db
    .prepare(
      "INSERT INTO cleanup_proposals (id, kind, payload_json) VALUES (?, ?, ?)",
    )
    .run(id, METADATA_FILL_KIND, JSON.stringify(payload));
}

/**
 * 한 익은 세션을 LLM 으로 평가한 직후, 그 세션의 모든 후보 노드 metadata 에
 * `metaInferred:1`(정수)을 단다. queryCandidates 의 멱등 제외 2 와 1:1 — 이 마킹이
 * 다음 사이클부터 같은 노드를 후보에서 뺀다(무한 재평가 차단, 원인 1).
 *
 * 계약은 NodeRepository.markNodeExtracted 선례와 동일 — json_set 으로 *정수 1* 만
 * 덧붙여 기존 metadata 칸 유실 0, content·임베딩 불변(metadata 칸만 갱신이라
 * vec_nodes·FTS 재색인 불필요). 정수 1 저장은 ->> '$.metaInferred' != 1 비교가
 * 작동하게 하는 핵심(json('true') 의 TEXT 'true' != 1 항상 참 함정 회피).
 *
 * 한 세션의 여러 노드를 한 트랜잭션으로 묶어 부분 마킹(일부만 마킹된 채 중단)을 막는다.
 */
function markSessionEvaluated(db: Database, nodeIds: readonly number[]): void {
  if (nodeIds.length === 0) return;
  const stmt = db.prepare(
    `UPDATE knowledge_nodes
       SET metadata_json = json_set(
             COALESCE(metadata_json, '{}'),
             '$.metaInferred', 1
           )
     WHERE id = ?`,
  );
  const tx = db.transaction((ids: readonly number[]) => {
    for (const id of ids) stmt.run(id);
  });
  tx(nodeIds);
}

// ── 내부 헬퍼 ─────────────────────────────────────────────────────────────────

/**
 * 한 세션을 LLM 입력 양식으로 환산. 노드 id·본문·메타값(있으면)을 담는다 — LLM 이
 * "빈 칸을 같은 사건의 다른 노드 값으로 채울지" 판단할 자료.
 */
function buildInferInput(
  session: Session,
  rowById: Map<number, CandidateRow>,
): SessionInferInput {
  const nodes = session.nodes.map((n) => {
    const row = rowById.get(n.id);
    return {
      id: n.id,
      content: row?.content ?? "",
      place: n.hasPlace ? (row?.place_value ?? null) : null,
      // 시각 원값을 그대로 넘긴다 — 전파는 "다른 메모에 실제로 있는 값 복사"라,
      // 값을 가리면 LLM 이 본문에서 시각을 지어내는 것 말고는 채울 길이 없다.
      eventAt: n.hasEventAt ? (row?.event_at_value ?? null) : null,
    };
  });
  return { nodes };
}

/**
 * 제안 값 검증 — 갈래 2 는 *전파* 단계라, 채울 값은 같은 세션의 다른 노드에 이미 있는
 * 장소·시각 값과 글자 그대로 같아야 한다. 대상 칸이 이미 차 있으면 버린다.
 * 본문에서 짐작한 값("저장 후" 같은 날짜 아닌 시각, 화면 이름 같은 장소)이 여기서 걸린다.
 * 통과하면 null, 버릴 사유가 있으면 그 사유 문자열을 돌려준다.
 */
function rejectReasonForValue(
  session: Session,
  rowById: Map<number, CandidateRow>,
  proposal: { nodeId: number; field: MetadataField },
  value: string,
): string | null {
  const target = session.nodes.find((n) => n.id === proposal.nodeId);
  const filled = proposal.field === "place" ? target?.hasPlace : target?.hasEventAt;
  if (filled) return "대상 칸이 이미 채워져 있음";

  const sourceValues = new Set<string>();
  for (const n of session.nodes) {
    if (n.id === proposal.nodeId) continue;
    const row = rowById.get(n.id);
    const v = proposal.field === "place" ? row?.place_value : row?.event_at_value;
    if (v) sourceValues.add(v.trim());
  }
  if (!sourceValues.has(value)) return "같은 세션 다른 메모에 없는 값";
  return null;
}

/**
 * SQLite datetime('now','localtime') 양식("YYYY-MM-DD HH:MM:SS")을 밀리초 epoch 로
 * 환산. created_at 은 localtime 으로 적재되므로 Z·offset 없이 로컬로 해석한다 —
 * 세션 묶기는 *상대 간격*만 보므로 절대 시간대 정밀도는 무관하지만, 일관 해석을
 * 위해 'T' 결합 후 Date.parse 한다. 파싱 실패 시 0(loud 하지 않고 0 — 이 노드는
 * 1970 으로 떨어져 다른 노드와 절대 같은 세션이 안 됨 / 단독 세션으로 격리).
 */
function parseSqliteLocaltimeMs(createdAt: string): number {
  const iso = createdAt.includes("T") ? createdAt : createdAt.replace(" ", "T");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

// ── 실제 ollama 판단 함수(index.ts wiring 이 활용) ───────────────────────────

/**
 * LLM 출력 온도 — 추출 흐름(extractor 0.1)보다 약간 더 보수적으로 0.1. 같은 세션
 * 입력에 재현성을 높여 환각·과분할(2.4b 이력)을 줄인다. 인라인 리터럴 회피.
 */
const INFER_TEMPERATURE = 0.1;

/** 한 판단 호출 max 출력 토큰. 제안 몇 줄 JSON 이면 충분 — 하드코딩 격리. */
const INFER_MAX_OUTPUT_TOKENS = 512;

/**
 * 갈래 2 LLM 판단 프롬프트(한국어 보수형). 사용자가 ollama 에서 직접 시도하는
 * 짧은 한국어 톤([[user-feedback-llm-prompt-style]]) — 영어 장황한 RULE 톤 회피.
 *
 * 핵심 제약(환각 차단):
 *   - 세션 안 노드 id 만 쓴다(새 id 지어내기 금지 — ID 검증이 또 걸러내지만 프롬프트에서 먼저).
 *   - 메타가 비어 있는 노드에만 채운다(이미 있는 칸 덮어쓰기 금지).
 *   - 같은 사건이 확실할 때만 전파, 애매하면 빈 배열.
 */
const INFER_SYSTEM_PROMPT = [
  "너는 같은 사람이 비슷한 시간에 적은 메모 묶음을 본다.",
  "이 메모들이 한 사건(같은 자리·같은 때)인지 판단하고,",
  "장소나 시각이 비어 있는 메모에 같은 사건의 다른 메모 값을 채울 제안을 만든다.",
  "",
  "규칙:",
  "- nodeId 는 목록 각 줄 맨 앞 [번호] 의 번호만 쓴다. 없는 번호를 지어내지 마라.",
  "- 이미 장소·시각이 있는 메모는 건드리지 않는다. 비어 있는 칸만 채운다.",
  "- 한 사건이 확실할 때만 채운다. 애매하면 아무것도 만들지 마라.",
  "- 채울 값은 다른 메모의 (장소=…, 시각=…) 괄호 안 값을 글자 그대로 복사한다.",
  "- 본문 내용에서 장소·시각을 새로 짐작해 만들지 마라. 괄호 안에 값이 없으면 채울 수 없다.",
  '- field 는 "place"(장소) 또는 "event_at"(시각) 둘 중 하나.',
  "- evidence 는 사람이 읽을 근거 한 줄이다. 메모 번호는 쓰지 말고, 근거가 된 메모의 내용으로 설명한다.",
  "",
  '회신은 JSON 배열만. 각 원소는 {"nodeId":숫자,"field":"place"|"event_at","value":"값","evidence":"근거 한 줄"}.',
  "채울 게 없으면 빈 배열 [] 만 회신한다.",
].join("\n");

/**
 * LlmClient 를 받아 SessionInferFn 을 만든다. extractor 가 쓰는 *같은* ollama
 * 클라이언트를 재사용한다(새 LLM 통로 0 — index.ts 가 createMemoryApi 의 llm 을 넘김).
 *
 * 응답 파싱은 관대하게 — 모델이 코드펜스(```json)나 앞뒤 잡담을 붙여도 첫 JSON 배열을
 * 추출한다. 파싱 실패는 throw(글루가 그 세션을 loud warn 으로 건너뜀 — silent 0건
 * 위장 금지). 배열 원소 중 형식이 어긋난 것은 거른다(글루 ID·field·value 검증이 또 걸름).
 */
export function createOllamaInferFn(llm: LlmClient): SessionInferFn {
  return async (input: SessionInferInput): Promise<InferredProposal[]> => {
    const userText = renderSessionForPrompt(input);
    const raw = await llm.chat(
      [
        { role: "system", content: INFER_SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
      {
        temperature: INFER_TEMPERATURE,
        maxOutputTokens: INFER_MAX_OUTPUT_TOKENS,
        callLabel: LLM_CALL_LABELS.metadataInfer,
      },
    );
    return parseInferResponse(raw);
  };
}

/** 세션 노드 목록을 프롬프트 본문으로 — id·내용·현재 장소·시각 표시. */
function renderSessionForPrompt(input: SessionInferInput): string {
  const lines = input.nodes.map((n) => {
    const place = n.place ? `장소=${n.place}` : "장소=없음";
    const eventAt = n.eventAt ? `시각=${n.eventAt}` : "시각=없음";
    return `[${n.id}] "${n.content}" (${place}, ${eventAt})`;
  });
  return `메모 묶음:\n${lines.join("\n")}`;
}

/**
 * LLM raw 응답에서 첫 JSON 배열을 추출해 InferredProposal[] 로 환산. 코드펜스·앞뒤
 * 잡담을 허용한다. 배열을 못 찾으면 throw(silent 0건 위장 금지 — 호출자가 loud warn).
 * 원소 중 nodeId(number)·field(string)·value(string) 양식이 어긋난 것은 거른다.
 */
function parseInferResponse(raw: string): InferredProposal[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new Error(
      `LLM 응답에서 JSON 배열을 못 찾음 (앞 80자: ${JSON.stringify(raw.slice(0, 80))})`,
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
  if (!Array.isArray(parsed)) {
    throw new Error("LLM 응답이 배열이 아님");
  }
  const out: InferredProposal[] = [];
  for (const el of parsed) {
    if (typeof el !== "object" || el === null) continue;
    const o = el as Record<string, unknown>;
    const nodeId = o.nodeId;
    const field = o.field;
    const value = o.value;
    if (typeof nodeId !== "number" || !Number.isInteger(nodeId)) continue;
    if (field !== "place" && field !== "event_at") continue;
    if (typeof value !== "string" || value.trim().length === 0) continue;
    out.push({
      nodeId,
      field,
      value: value.trim(),
      evidence: typeof o.evidence === "string" ? o.evidence : undefined,
    });
  }
  return out;
}
