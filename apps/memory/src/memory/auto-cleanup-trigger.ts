/**
 * Phase 5.7.3 W3 — 데이터 변동 emit 통로 + N초 throttle queue.
 *
 * 옛 `evolver-scheduler.ts` (setInterval 24시간 cron) 통째 폐기 → 신규 두
 * 시스템 분리 중 *시스템 A* (이벤트 기반). 데이터 변동 시점에 호출처가
 * `trigger.emit(reason)` 으로 신호 한 번 송출 → throttle 윈도우 안 신규
 * emit 다 silent skip → 윈도우 종료 시점에 1회만 `runAutoCleanup` 가동.
 *
 * 호출처 6 지점 (plan §4.2 표):
 *  1. `store.addNode` 끝 → 'raw-memory-added'
 *  2. `MemoryExtractor.extractAndStore` 끝 → 'atomic-memory-added'
 *  3. `store.updateNodeImportance` 끝 → 'node-edited'
 *  4. `applyHashtagWiring` 안 신규 본문 노드 작성 시 → 'hashtag-concept-added'
 *  5. `POST /memories` 라우트 끝 → 'external-sdk-write'
 *  6. `DELETE /memories/:id` 라우트 끝 → 'node-deleted'
 *
 * 호출처는 옵션 객체 안 `trigger?: AutoCleanupTriggerHandle` 형태로 주입
 * 받음. undefined 면 no-op — W3 시점에 가동 라인 추가 X (W6 의존, 옛
 * evolver-scheduler 폐기 commit 안 신규 가동 라인 추가).
 *
 * 디자인 근거: docs/decisions/2026-05-21-memory-auto-cleanup-redesign-plan.md §4
 */

import { runAutoCleanup, type AutoCleanupOptions, type AutoCleanupActivitySummary, type AutoCleanupStore } from "./auto-cleanup-runner.ts";
import { emergeRepeatedWords, type ConceptEmergeStore, type EmergeRepeatedWordsOptions } from "./concept-emergence.ts";
import type { Database } from "bun:sqlite";
import { outsideMemoryMutationContext, withMemoryMutationLock } from "./shared-memory-mutation-lock.ts";

/**
 * 데이터 변동 원인 라벨. 6 형태 — plan §4.2 표 정합.
 */
export type DataChangeReason =
  | "raw-memory-added"
  | "atomic-memory-added"
  | "node-edited"
  | "hashtag-concept-added"
  | "external-sdk-write"
  | "node-deleted";

/**
 * `startAutoCleanupTrigger` 입력. throttle 윈도우 + store + cleanup 옵션 +
 * 가동 토글 (settings.autoCleanup.enabled getter).
 */
export interface AutoCleanupTriggerOptions {
  /** Throttle 윈도우 (밀리초). 마지막 가동 후 N ms 안 emit = silent skip. */
  throttleMs: number;
  /** runAutoCleanup 이 사용할 store (좁힌 표면). */
  store: AutoCleanupStore & { getRawDb?: () => Database };
  /** runAutoCleanup 호출 옵션 (valueThreshold 등). 미지정 시 default. */
  cleanupOptions?: AutoCleanupOptions;
  /**
   * 반복단어 emerge 가 쓰는 store 표면(`getAllNodes` + `findOrCreateConcept`).
   * 종료 1회 사이클 안에서 `runAutoCleanup` 뒤에 `emergeRepeatedWords` 를 같이
   * 부른다 — 입력마다 전체 재집계하는 과부하를 피해, 윈도우가 종료될 때 한 번
   * 만 전체 글을 집계해 docCount ≥ 임계 단어를 개념으로 승격한다(spec §4.3·§4.5).
   * 미주입이면 emerge 단계 no-op — 옛 자동 정리 흐름이 그대로 보존된다.
   */
  emergeStore?: ConceptEmergeStore;
  /** emergeRepeatedWords 호출 옵션(threshold·scanLimit 등). 미지정 시 default. */
  emergeOptions?: EmergeRepeatedWordsOptions;
  /**
   * 그래프 라이브 연출 2d — emerge 가 진짜 개념을 만든/합류시킨 자리에서 부르는
   * 콜백. `runOnce` 가 `emergeRepeatedWords` 결과의 `summary.emerged` 를 순회하며
   * 항목마다 한 번 호출한다(승격 0 이면 0 회 — 추론으로 만들지 않는다). 콜백 안에서
   * `eventBus.emit(GRAPH_EMERGE, signal)` 로 흘리도록 `index.ts` 가 배선한다.
   *
   * trigger 본체가 server-internal(event-bus)에 직접 의존하지 않도록 *콜백* 표면을
   * 쓴다 — 의존 방향이 깔끔해지고(메모리 코어 → 서버층 역참조 회피), 미주입이면
   * no-op 라 옛 자동 정리 흐름이 그대로 보존된다.
   */
  onGraphEmerge?: (signal: { nodeId: string; fromSources: string[] }) => void;
  /** 가동 토글 — settings.autoCleanup.enabled getter 를 그대로 전달한다. */
  enabled: () => boolean;
  /**
   * 시각 제공자. 테스트에서 mock timer 주입용. 미지정 시 Date.now.
   * (Bun mock timer 도입 부담 회피 — 함수 주입 패턴이 옛 코드 패턴 정합.)
   */
  now?: () => number;
  /**
   * setTimeout 대체. 테스트에서 직접 호출 가능 timer 주입용. 미지정 시
   * 전역 setTimeout. (clearTimeout 도 같이 받음.)
   */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** clearTimeout 대체. setTimeout 과 짝. */
  clearTimeout?: (handle: unknown) => void;
}

/**
 * `startAutoCleanupTrigger` 반환 handle.
 */
export interface AutoCleanupTriggerHandle {
  /** 데이터 변동 신호 송출. throttle 윈도우 안 호출 = silent skip. */
  emit(reason: DataChangeReason): void;
  /** 진행 중 timer 정리 + 신규 emit 차단. */
  stop(): Promise<void>;
  /** 마지막 가동 summary. 아직 가동 0 = null. */
  lastSummary(): AutoCleanupActivitySummary | null;
}

/**
 * 데이터 변동 emit 통로 + N초 throttle queue.
 *
 * 동작:
 *  - emit 호출 시점에 (now - lastRunAt) ≥ throttleMs 면 즉시 가동.
 *  - 윈도우 안 호출이면 pending timer 1개만 박음 — 같은 윈도우 안 신규
 *    emit 다 silent skip.
 *  - 가동 1회 끝나면 lastRunAt 갱신 — 다음 윈도우 시작.
 *  - enabled() = false 면 emit 즉시 return (timer 등록 X).
 */
export function startAutoCleanupTrigger(
  options: AutoCleanupTriggerOptions,
): AutoCleanupTriggerHandle {
  const now = options.now ?? (() => Date.now());
  const schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const mutationOwner = options.store.getRawDb ? { db: options.store.getRawDb() } : undefined;

  let lastRunAtMs = 0;
  let pendingTimer: unknown | null = null;
  let running = false;
  let stopped = false;
  let last: AutoCleanupActivitySummary | null = null;

  async function runOnce(): Promise<void> {
    if (running || stopped || !options.enabled()) return;
    running = true;
    // throttle 윈도우 계산은 *가동 시작 시각* 기준 — 가동 끝난 시점이
    // 아니라. 한 사이클 가동에 N ms 가 걸리면 같은 N ms 안 신규 emit 이
    // throttle 정합 안 풀려 또 가동 시도되는 버그 차단.
    lastRunAtMs = now();
    try {
      const run = async () => {
        if (stopped || !options.enabled()) return;
        last = await runAutoCleanup(options.store, options.cleanupOptions);
        // 종료 1회 사이클에 반복단어 emerge 도 같이 가동(spec §4.3·§4.5).
        // emergeStore 미주입이면 건너뛴다 — 옛 자동 정리 흐름 보존.
        if (options.emergeStore) {
          const summary = await emergeRepeatedWords(
            options.emergeStore,
            options.emergeOptions,
          );
          // 그래프 라이브 연출 2d — emerge 가 진짜 승격한 개념마다 신호를 흘린다.
          // summary.emerged 가 비면 0 회(0건이면 발행 안 함 — 추론 0). 콜백 미주입이면
          // 이 줄 자체가 no-op 라 옛 흐름 보존.
          if (options.onGraphEmerge) {
            for (const e of summary.emerged) {
              options.onGraphEmerge({ nodeId: e.nodeId, fromSources: e.fromSources });
            }
          }
        }
      };
      // emit() is detached from the mutation that triggered it. Acquiring outside
      // that mutation's ALS context keeps cleanup from archiving during rewire.
      await outsideMemoryMutationContext(() => mutationOwner
        ? withMemoryMutationLock(mutationOwner, run)
        : run());
    } catch (e) {
      console.error("[auto-cleanup] cycle failed:", e);
    } finally {
      running = false;
    }
  }

  function emit(_reason: DataChangeReason): void {
    if (stopped || !options.enabled()) return;
    const sinceLast = now() - lastRunAtMs;
    if (sinceLast >= options.throttleMs) {
      // 윈도우 종료 — 즉시 가동.
      void runOnce();
      return;
    }
    if (pendingTimer !== null) {
      // 같은 윈도우 안 신규 emit — silent skip.
      return;
    }
    // 윈도우 안 첫 emit — 윈도우 종료 시각에 1회 가동 예약.
    const delay = options.throttleMs - sinceLast;
    pendingTimer = schedule(() => {
      pendingTimer = null;
      void runOnce();
    }, delay);
  }

  return {
    emit,
    async stop() {
      stopped = true;
      if (pendingTimer !== null) {
        cancel(pendingTimer);
        pendingTimer = null;
      }
    },
    lastSummary: () => last,
  };
}
