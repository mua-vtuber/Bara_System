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
 *      단 응답이 출력 한도에 잘린 세션은 metaInferTruncatedAt=<한도> 를 달아 같은 한도로는
 *      다시 보내지 않는다(같은 입력·같은 한도는 결정적으로 또 잘림 — 매 주기 CPU 낭비 차단).
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
import type { EventPublisher } from "./events/event-contract.ts";
import {
  groupSessions,
  pickMixedSessions,
  pickRipeSessions,
  type Session,
  type SessionNode,
} from "./session-grouping.ts";
import { MetadataInferOutputTruncatedError } from "./metadata-infer-llm.ts";
import {
  METADATA_INFER_MAX_OUTPUT_TOKENS_KEY,
  metadataInferMaxOutputTokensError,
} from "./metadata-infer-output-limit.ts";

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

/**
 * MCP 로 저장된 기억의 knowledge_nodes.platform 값 — mcp/server.ts MCP_SOURCE 와 같은 값.
 * (mcp/server.ts 를 import 하면 서버·SDK 의존이 끌려와 값만 맞춘다. 정합은 테스트가 지킨다.)
 */
export const MCP_PLATFORM = "mcp";

/** 계보(원문·청크) 조상 탐색 깊이 상한 — 자식→청크→원문 정도면 충분하다. */
const MCP_LINEAGE_MAX_DEPTH = 4;

/** 상수 문자열을 SQL 문자열 리터럴로. 이 모듈의 상수 전용(사용자 입력 금지). */
function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

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
  /** LLM 호출이 throw 해 건너뛴 세션 수(출력 한도 잘림 제외 — 다음 사이클 재시도). */
  inferFailures: number;
  /**
   * 응답이 출력 한도에 잘린 세션 수. 그 세션 메모에 잘린 한도를 적어(metaInferTruncatedAt)
   * 같은 한도로는 다시 보내지 않는다 — inferFailures 와 따로 센다.
   */
  truncatedSessions: number;
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
  /** 이 노드에 붙은 장소 이름 전부(JSON 배열 문자열) — place_value 는 그중 한 개일 뿐이다. */
  place_values: string | null;
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
  /**
   * 지금 쓰는 출력 한도(settings.metadataInfer.maxOutputTokens) — infer 함수를 만든 값과 같아야 한다.
   * 이 한도에 잘렸다고 적힌 메모는 후보에서 뺀다. 한도를 바꾸면 적힌 값과 달라져 다시 후보가 된다.
   */
  maxOutputTokens: number;
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
    truncatedSessions: 0,
  };

  const limitError = metadataInferMaxOutputTokensError(deps.maxOutputTokens);
  if (limitError !== null) throw new Error(limitError);

  // graceful — LLM 미가용(infer=null). 잘못된 자동 데이터 0, 정직한 비활성 로그.
  if (deps.infer === null) {
    console.log(
      `${logPrefix} LLM 미가용 — 갈래 2 한 사이클 건너뜀(no-op).`,
    );
    return empty;
  }

  // ── 1. 후보 조회(멱등 제외) ────────────────────────────────────────────────
  const candidates = queryCandidates(deps.db, deps.batchSize, deps.maxOutputTokens);
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
  let truncatedSessions = 0;

  // ── 5~7. 세션별 LLM 판단 → ID 검증 → insert ──────────────────────────────
  for (const session of mixed) {
    const allowedIds = new Set(session.nodes.map((n) => n.id));
    const inferInput = buildInferInput(session, rowById);

    let proposals: InferredProposal[];
    try {
      proposals = await deps.infer(inferInput);
    } catch (e) {
      // 출력 한도 잘림 — 같은 한도로 다시 보내도 똑같이 잘린다(결정적). 평가 완료(metaInferred)로
      // 마킹하지 않고, 잘린 한도를 세션 메모에 적어 같은 한도에서는 후보에서 뺀다.
      if (e instanceof MetadataInferOutputTruncatedError) {
        if (e.maxOutputTokens !== deps.maxOutputTokens) {
          // infer 함수와 사이클이 다른 한도를 들고 있다 — 적은 값이 후보 제외와 안 맞아 같은 세션이
          // 계속 다시 보내진다. 배선 결함이므로 조용히 넘기지 않고 사이클을 멈춘다.
          throw new Error(
            `${METADATA_INFER_MAX_OUTPUT_TOKENS_KEY} 불일치 — infer 함수 한도 ${e.maxOutputTokens}, 사이클 한도 ${deps.maxOutputTokens}. 같은 설정값으로 둘 다 만들어야 한다`,
          );
        }
        truncatedSessions += 1;
        markSessionTruncated(deps.db, [...allowedIds], e.maxOutputTokens);
        console.warn(
          `${logPrefix} 출력 한도 잘림 — 세션 멈춤(nodeIds=${[...allowedIds].join(",")}, 한도 ${e.maxOutputTokens}). ` +
            `같은 한도로는 다시 보내지 않음 — 설정 ${METADATA_INFER_MAX_OUTPUT_TOKENS_KEY} 를 올리면 다음 주기에 다시 시도: ${e.message}`,
        );
        continue;
      }
      // 그 밖의 실패(네트워크·잘리지 않은 파싱 실패 등)는 *평가가 안 된* 것 — 마킹하지
      // 않는다(다음 사이클 재시도 정당). 마킹은 LLM 이 정상 회신한(빈 배열 포함) 세션만.
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
    truncatedSessions,
  };

  if (
    proposalsInserted > 0 ||
    rejectedHallucinations > 0 ||
    inferFailures > 0 ||
    truncatedSessions > 0
  ) {
    console.log(
      `${logPrefix} cycle: 후보 ${summary.candidatesFound} / 세션 ${summary.sessionsGrouped} / 익음 ${summary.ripeSessions} / 섞임 ${summary.mixedSessions} → 제안 +${proposalsInserted}, 환각버림 ${rejectedHallucinations}, LLM실패 ${inferFailures}, 한도잘림 ${truncatedSessions}`,
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
 *   - 멱등 제외 3 (출력 한도 잘림) — metadata.metaInferTruncatedAt 이 *지금 한도*와 같은 노드는
 *     뺀다. 그 세션은 이 한도로 보내면 응답이 잘린다는 것이 이미 확인됐다(같은 입력·같은 한도는
 *     결정적으로 또 잘림). 한도를 바꾸면 적힌 값과 달라져 자동으로 다시 후보가 된다 — 한도가
 *     실패 지문의 일부(추출 실패 기록 표와 같은 결정).
 *
 *     세션 묶기 영향: 잘린 세션은 *익은(닫힌)* 세션이었다 — 앞뒤 이웃 메모와 각각 간격 G 를
 *     넘게 떨어져 있었다. 그 노드들을 통째로 빼도 앞 이웃 끝 ~ 뒤 이웃 시작 간격은 G 보다 더
 *     벌어질 뿐이라 남은 노드끼리 새로 합쳐지지 않는다(제외 2 의 마킹과 같은 성질).
 *     한 세션의 노드는 한 트랜잭션으로 함께 적혀 일부만 빠지는 경우도 없다.
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
function queryCandidates(
  db: Database,
  batchSize: number,
  maxOutputTokens: number,
): CandidateRow[] {
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
      )                AS place_value,
      -- 제안 값 대조용 — 노드에 붙은 장소 이름 전부(두 경로 합집합). place_value 는 LLM
      -- 입력 맥락용 한 개뿐이라, 장소가 여럿인 노드의 다른 장소를 근거로 쓰려면 이게 필요하다.
      (
        SELECT json_group_array(pname) FROM (
          SELECT cval.name AS pname FROM node_concept_edges nce
          JOIN hierarchy_edges he
            ON he.target_id = nce.concept_id AND he.relation = 'parent_of'
          JOIN concept_nodes ckey
            ON ckey.concept_id = he.source_id
           AND ckey.is_classification_key = 1
           AND ckey.name = '장소'
          JOIN concept_nodes cval ON cval.concept_id = nce.concept_id
          WHERE nce.node_id = kn.id AND nce.role = 'classification'
          UNION
          SELECT cval.name AS pname FROM node_concept_edges nce
          JOIN entity_concept_edges pce
            ON pce.concept_id = nce.concept_id AND pce.role = 'identity'
          JOIN entities pe
            ON pe.entity_id = pce.entity_id AND pe.type_name = 'place'
          JOIN concept_nodes cval ON cval.concept_id = nce.concept_id
          WHERE nce.node_id = kn.id AND nce.role = 'classification'
        )
      )                AS place_values
    FROM knowledge_nodes kn
    WHERE kn.source_type IN (${placeholders})
      AND NOT EXISTS(
        SELECT 1 FROM cleanup_proposals cp
        WHERE cp.kind = '${METADATA_FILL_KIND}'
          AND CAST(cp.payload_json ->> '$.nodeId' AS INTEGER) = kn.id
      )
      AND (kn.metadata_json ->> '$.metaInferred' IS NULL
           OR kn.metadata_json ->> '$.metaInferred' != 1)
      AND (kn.metadata_json ->> '$.metaInferTruncatedAt' IS NULL
           OR kn.metadata_json ->> '$.metaInferTruncatedAt' != ?)
      -- MCP(AI 클라이언트)가 쓴 기억 제외 — 후보로도, 다른 노드의 근거로도 안 쓴다.
      -- AI 클라이언트는 서로 무관한 기술 메모를 짧은 간격으로 연달아 저장해서
      -- "같은 사건 세션" 전제가 깨지고, 엉뚱한 장소(예: "이 pc")가 제안된다.
      -- 표지: knowledge_nodes.platform = ${sqlQuote(MCP_PLATFORM)}(저장 시 args.source=MCP_SOURCE 가
      -- 칼럼에 그대로 박히며 클라이언트 metadata 로는 못 바꾼다). 추출 자식(llm_extract·regex)은
      -- 계보 엣지(자식→원문, merged_into/parent_of)로 조상을 따라가 조상 중 하나라도 MCP 면 뺀다.
      AND COALESCE(kn.platform, '') != ${sqlQuote(MCP_PLATFORM)}
      AND NOT EXISTS(
        WITH RECURSIVE lineage(node_id, depth) AS (
          SELECT ke.target_id, 1 FROM knowledge_edges ke
          WHERE ke.source_id = kn.id AND ke.relation IN ('merged_into', 'parent_of')
          UNION
          SELECT ke.target_id, lineage.depth + 1 FROM lineage
          JOIN knowledge_edges ke
            ON ke.source_id = lineage.node_id AND ke.relation IN ('merged_into', 'parent_of')
          WHERE lineage.depth < ${MCP_LINEAGE_MAX_DEPTH}
        )
        SELECT 1 FROM lineage
        JOIN knowledge_nodes anc ON anc.id = lineage.node_id
        WHERE COALESCE(anc.platform, '') = ${sqlQuote(MCP_PLATFORM)}
      )
    ORDER BY kn.author ASC, kn.created_at ASC, kn.id ASC
    LIMIT ?`;
  const rows = db
    .prepare(sql)
    .all(...META_CANDIDATE_SOURCE_TYPES, maxOutputTokens, batchSize) as CandidateRow[];
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
 * 예전 주기에 남은 잘림 표시(metaInferTruncatedAt)는 평가가 끝났으니 함께 지운다.
 */
function markSessionEvaluated(db: Database, nodeIds: readonly number[]): void {
  if (nodeIds.length === 0) return;
  const stmt = db.prepare(
    `UPDATE knowledge_nodes
       SET metadata_json = json_remove(
             json_set(COALESCE(metadata_json, '{}'), '$.metaInferred', 1),
             '$.metaInferTruncatedAt'
           )
     WHERE id = ?`,
  );
  const tx = db.transaction((ids: readonly number[]) => {
    for (const id of ids) stmt.run(id);
  });
  tx(nodeIds);
}

/**
 * 응답이 출력 한도에 잘린 세션의 모든 후보 노드 metadata 에 `metaInferTruncatedAt:<한도>`(정수)를 단다.
 * queryCandidates 의 멱등 제외 3 과 1:1 — 같은 한도로는 그 세션을 다시 보내지 않는다.
 * metaInferred 는 달지 않는다(평가가 안 됐다 — 한도를 바꾸면 다시 평가해야 한다).
 * markSessionEvaluated 와 같은 json_set·한 트랜잭션 방식이라 기존 metadata 칸 유실 0, 부분 마킹 0.
 */
function markSessionTruncated(
  db: Database,
  nodeIds: readonly number[],
  maxOutputTokens: number,
): void {
  if (nodeIds.length === 0) return;
  const stmt = db.prepare(
    `UPDATE knowledge_nodes
       SET metadata_json = json_set(
             COALESCE(metadata_json, '{}'),
             '$.metaInferTruncatedAt', ?
           )
     WHERE id = ?`,
  );
  const tx = db.transaction((ids: readonly number[]) => {
    for (const id of ids) stmt.run(maxOutputTokens, id);
  });
  tx(nodeIds);
}

// ── 내부 헬퍼 ─────────────────────────────────────────────────────────────────

/** 장소 이름 비교 키 — NFC·trim·소문자. */
function placeKey(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/** 노드 한 행에 붙은 장소 이름 전부(place_values JSON + place_value 보강). */
function placesOf(row: CandidateRow): string[] {
  const out: string[] = [];
  if (row.place_values) {
    try {
      const parsed: unknown = JSON.parse(row.place_values);
      if (Array.isArray(parsed)) {
        for (const v of parsed) if (typeof v === "string") out.push(v);
      }
    } catch {
      // 깨진 JSON — 아래 place_value 만으로 대조(근거 부족이면 제안이 버려질 뿐 안전한 쪽).
    }
  }
  if (row.place_value) out.push(row.place_value);
  return out;
}

/** event_at 비교 — 둘 다 시각으로 파싱되면 같은 순간인지, 아니면 문자열 그대로. */
function sameEventAt(a: string, b: string): boolean {
  const norm = (v: string): string => v.normalize("NFC").trim();
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  const tx = Date.parse(x.includes("T") ? x : x.replace(" ", "T"));
  const ty = Date.parse(y.includes("T") ? y : y.replace(" ", "T"));
  return !Number.isNaN(tx) && !Number.isNaN(ty) && tx === ty;
}

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
 * 장소·시각 값과 같아야 한다. 대상 칸이 이미 차 있으면 버린다.
 * 본문에서 짐작한 값("저장 후" 같은 날짜 아닌 시각, 화면 이름 같은 장소)이 여기서 걸린다.
 *   - 장소: NFC·trim·대소문자 무시로 비교하고, 다른 노드에 붙은 장소 *전부*(place_values)와 대조한다.
 *   - 시각: 같은 순간이면 같은 값으로 본다(표기만 다른 ISO 문자열 허용).
 * 세션에는 MCP 노드가 이미 빠져 있어(queryCandidates) 근거로도 못 쓰인다.
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

  const wantedPlace = placeKey(value);
  for (const n of session.nodes) {
    if (n.id === proposal.nodeId) continue;
    const row = rowById.get(n.id);
    if (!row) continue;
    if (proposal.field === "place") {
      if (placesOf(row).some((p) => placeKey(p) === wantedPlace)) return null;
    } else if (row.event_at_value && sameEventAt(row.event_at_value, value)) {
      return null;
    }
  }
  return "같은 세션 다른 메모에 없는 값";
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

// ── 실제 LLM 판단 함수 — metadata-infer-llm.ts 로 분리(호출처·테스트 import 경로 유지용 재수출) ──

export {
  createOllamaInferFn,
  MetadataInferOutputTruncatedError,
  type MetadataInferFnOptions,
} from "./metadata-infer-llm.ts";
