/**
 * memory/events/event-contract.ts — 이벤트 계약(계층 중립 모듈).
 *
 * 권위: docs/decisions/2026-07-03-structure-cleanup-spec.md G5-b
 *
 * 역할: memory/(도메인)와 server-internal/(HTTP 서버 내부)이 함께 쓰는 이벤트
 * 계약 — EVENT_TYPES 카탈로그 + emit 표면(EventPublisher) — 을 계층 중립 위치에
 * 둔다. 도메인 사이클(regex-strengthen·summary·metadata-infer·person-link)은
 * 이 모듈만 알고, 실제 구현(큐 적재 + SSE fan-out)은 server-internal/event-bus.ts
 * 의 EventBus 가 EventPublisher 를 implements 한다. server-internal 은
 * EVENT_TYPES·EventType 을 여기서 import 해 재export 하므로 기존 참조처
 * (server-internal/types.ts·routes/*)는 무변경으로 동작한다.
 */

/**
 * 버스를 흐르는 event type 목록(정합 카탈로그). EventBus.emit 자체는 type 을 문자열로
 * 받는 type-agnostic 통로라 여기 enum 강제는 안 한다 — 발행자(사이클)가 자기 옆에
 * 상수를 두고(예 metadata-infer-cycle.ts `CLEANUP_PROPOSALS_READY_EVENT`) 그걸
 * emit 한다. 이 카탈로그는 "어떤 type 이 흐르고, 그게 검토 게이트인지 정보성인지"를
 * 한곳에서 보이게 하는 문서용 묶음이다(Phase 7 요약 단계 Task 9 정합).
 *
 * 두 갈래 구분:
 *   - 검토 게이트 type — 대시보드·봇에 [수락]/[거절] 카드를 띄운다(사용자 결정 필요).
 *     `cleanup_proposals_ready`(metadata_fill 제안 · 정규식 강화 제안 공유).
 *   - 정보성 type — 자동 적용이라 버튼이 없다. 사용자에게 "이런 일이 있었다"만 알린다.
 *     `relations_discovered`(요약 단계 관계 발굴 — llm_relation 엣지 자동 생성).
 */
export const EVENT_TYPES = {
  /** 검토 게이트 — [수락]/[거절] 카드 (metadata_fill · 정규식 강화 제안 공유). */
  CLEANUP_PROPOSALS_READY: "cleanup_proposals_ready",
  /** 정보성 — 요약 단계 관계 발굴(자동 적용, 버튼 0). payload `{ count, relationSummaries }`. */
  RELATIONS_DISCOVERED: "relations_discovered",
  /**
   * 정보성 — 그래프 데이터가 변했다(그래프 라이브 연출 2a). payload `{ reason: string }`.
   * 대시보드가 받으면 overview 를 다시 받아 화면을 가만히 봐도 자란다. reason 은
   * 어느 통로가 글을 더했는지 식별만 한다(예 "memory-added"·"ingested").
   */
  GRAPH_CHANGED: "graph_changed",
  /**
   * 정보성 — 두 개념이 하나로 합쳐졌다(2c). payload `{ from: string, into: string }`.
   * 둘 다 그래프 노드 id(`concept:<conceptId>` — graph.ts 의 conceptKey 와 같은 형식).
   * from = 흡수되어 사라지는 source, into = 남는 target. 대시보드가 흡수 연출을 보인다.
   */
  GRAPH_MERGE: "graph_merge",
  /**
   * 정보성 — 반복단어가 임계를 넘어 개념으로 창발했다(2d).
   * payload `{ nodeId: string, fromSources: string[] }`. nodeId 는 새로 생긴/합류한
   * 개념 노드 id(`concept:<conceptId>`), fromSources 는 그 단어가 등장한 글 id 배열.
   * 대시보드가 출처들에서 한 점으로 모이는 수렴선 + 탄생 번쩍을 보인다.
   */
  GRAPH_EMERGE: "graph_emerge",
} as const;

/** EVENT_TYPES 의 값 union — 발행자가 emit 할 때 type 문자열 정합용(선택). */
export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/**
 * 도메인(사이클)이 의존하는 이벤트 발행 표면 — 단일 메서드 emit.
 * 구현은 server-internal/event-bus.ts 의 EventBus(append 선행 + fan-out 격리).
 * memory/ 쪽은 이 인터페이스만 알면 되므로 server-internal 로의 역방향 import 가
 * 생기지 않는다(계층 규율 — layering.test.ts 가 파일 스캔으로 지킨다).
 */
export interface EventPublisher {
  /**
   * 이벤트 한 건을 발행한다. 구현 계약: events 큐 적재를 *먼저* 하고(유실 0),
   * 적재 실패는 loud throw — silent fallback 금지.
   *
   * @returns 적재된 이벤트 id(단조 증가 커서).
   */
  emit(type: string, payload: Record<string, unknown>): number;
}
