/**
 * server-internal/event-bus.ts — in-process 이벤트 버스 (Phase 7 2차 Task 3).
 *
 * 권위: docs/decisions/2026-06-04-phase7-2nd-active-loop-plan.md Task 3
 *       docs/decisions/2026-06-02-phase7-redesign-design.md 단락 2(① 알림 토대)
 *
 * 역할: 메모리 안에서 누군가 emit(type, payload) 를 부르면 (1) events 큐(Task 1
 * EventRepository)에 영구 적재하고 (2) 그 순간 열려 있는 모든 SSE 연결(구독자)에게
 * fan-out 한다. SSE 라우트(events.ts)가 subscribe 로 자기 송출 콜백을 등록하고,
 * 연결이 끊기면 unsubscribe 로 뺀다.
 *
 * 핵심 불변 — "알림 유실 0":
 *   - append 를 *먼저* 한다. fan-out 이 한 건도 못 가도 events 큐에는 남으므로,
 *     끊겼던 어댑터가 재연결하면 Last-Event-ID 다음부터 listSince 로 이어받아
 *     하나도 안 놓친다. emit 이 fan-out 단계에서 실패해도 append 는 이미 끝났다.
 *
 * 핵심 불변 — "연결별 격리":
 *   - 한 구독자(끊긴 연결 등)로의 송출이 throw 해도 다른 구독자·호출자를 안 깨뜨린다.
 *     구독자마다 try/catch 로 감싸고, 실패는 silent swallow 가 아니라 console.warn 에
 *     식별자(adapterId)만 남긴다 — 토큰 값·payload 내용은 로그에 넣지 않는다(T2 규칙
 *     계승: 비밀값은 식별자만).
 */

import type { EventRecord, EventRepository } from "../db/store-internal/event-repository.ts";
import type { EventPublisher } from "../memory/events/event-contract.ts";

// EVENT_TYPES 카탈로그·EventType·emit 표면(EventPublisher)은 계층 중립 모듈
// memory/events/event-contract.ts 로 이동했다(G5-b — memory/ 도메인이
// server-internal 을 역방향 import 하지 않도록). 기존 참조처(types.ts·routes/*)를
// 위해 여기서 재export 한다.
export { EVENT_TYPES, type EventType } from "../memory/events/event-contract.ts";

/**
 * SSE 라우트가 등록하는 송출 콜백. emit 시점에 이 콜백으로 한 이벤트가 전달되고,
 * 라우트가 그걸 writeSSE 로 클라이언트에 흘린다. 콜백이 throw 하면 그 구독자만
 * 격리되고 다른 구독자는 영향받지 않는다(아래 fanOut 의 구독자별 try/catch).
 */
export type EventSubscriber = (record: EventRecord) => void;

/**
 * 한 구독을 식별·해제하는 핸들. subscribe 가 회신하고, 연결 종료 시 호출자가
 * unsubscribe 에 그대로 넘긴다.
 */
export interface Subscription {
  /** 진단·격리 로그용 식별자(보통 adapterId). 비밀값 아님. */
  readonly adapterId: string;
  /** 송출 콜백 — fan-out 시 호출. */
  readonly send: EventSubscriber;
}

export class EventBus implements EventPublisher {
  /** 현재 열린 SSE 연결들의 구독 set. emit 시 이 전부에 fan-out. */
  private readonly subscribers = new Set<Subscription>();

  constructor(private readonly events: EventRepository) {}

  /**
   * 이벤트 한 건을 발행한다. events 큐에 *먼저* 적재(유실 0)한 뒤, 그 순간 열린 모든
   * SSE 연결에 fan-out 한다. 적재된 id·created_at 까지 채운 완성 record 를 fan-out
   * 하므로 구독자(SSE 라우트)가 그대로 `id: <eventId>` 형식으로 흘릴 수 있다.
   *
   * append 가 실패하면(DB 오류 등) loud throw — 그건 진짜 실패라 호출자가 알아야
   * 한다(silent fallback 금지). 반대로 fan-out 단계의 한 구독자 실패는 격리되어
   * emit 자체를 깨뜨리지 않는다(append 는 이미 성공).
   *
   * @returns 적재된 이벤트 id(단조 증가 커서).
   */
  emit(type: string, payload: Record<string, unknown>): number {
    // (1) 영구 적재 먼저 — 이 한 줄이 "유실 0" 을 보장한다. fan-out 이 전부 실패해도
    //     큐에 남아 재연결 시 이어받는다.
    const id = this.events.append(type, payload);

    // 적재 직후 완성 record 를 만들어 fan-out — listSince 가 회신하는 형태와 동일.
    // created_at 은 큐가 채우지만 실시간 fan-out 에는 굳이 다시 읽지 않는다(현재
    // 시각으로 충분 — 송출 형식은 id/event/data 만 쓴다). id 단조성이 커서 핵심.
    const record: EventRecord = {
      id,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };

    this.fanOut(record);
    return id;
  }

  /**
   * 한 SSE 연결을 구독에 추가한다. send 콜백은 이후 emit 마다 호출된다.
   * adapterId 는 격리 로그 식별자(토큰 값 아님).
   *
   * @returns unsubscribe 에 넘길 Subscription 핸들.
   */
  subscribe(adapterId: string, send: EventSubscriber): Subscription {
    const sub: Subscription = { adapterId, send };
    this.subscribers.add(sub);
    return sub;
  }

  /**
   * 구독을 해제한다. 연결이 끊기면 SSE 라우트가 onAbort 에서 호출한다. 멱등 —
   * 이미 빠진 핸들을 다시 넘겨도 무해.
   */
  unsubscribe(sub: Subscription): void {
    this.subscribers.delete(sub);
  }

  /** 현재 열린 구독 수(진단·테스트용). */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * 한 record 를 모든 구독자에게 흘린다. 구독자마다 try/catch 로 격리 — 한 연결의
   * 송출이 throw 해도 나머지 구독자·호출자는 영향받지 않는다. 실패는 식별자만
   * console.warn(silent swallow 아님 / 비밀값·payload 내용 미포함).
   */
  private fanOut(record: EventRecord): void {
    for (const sub of this.subscribers) {
      try {
        sub.send(record);
      } catch (err) {
        // 끊긴 연결 등으로 한 구독자 송출이 실패해도 다른 구독자를 막지 않는다.
        // 식별자(adapterId)만 남긴다 — 토큰·payload 내용은 로그에 넣지 않는다.
        console.warn(
          `[event-bus] 구독자 fan-out 실패 — adapterId=${sub.adapterId} type=${record.type}: ${(err as Error).message}`,
        );
      }
    }
  }
}
