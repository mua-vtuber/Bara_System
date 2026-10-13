/**
 * ReloadBus — 단순 listener 묶음 (Phase 5.5 / sub-phase 5.5.5 — S9)
 *
 * settings 라우터가 PUT 성공 후 1회 `emit()` 한다. 구독자(향후 evolver
 * 스케줄러 / extractor / embedding factory 등) 는 자기 캐시를 무효화하거나
 * 본인 매일 사용 보호를 위해 *얌전한 재시작* 을 트리거할 수 있다.
 *
 * 본 모듈 코어 패턴 = federation/health-poller.ts 와 동일한 의존성 0
 * 흐름. RxJS·EventEmitter 같은 외부 의존성 없이 Set 1개로 충분.
 */

export type ReloadListener = () => void;

export class ReloadBus {
  private readonly listeners: Set<ReloadListener> = new Set();

  /**
   * 구독 등록. 반환 함수를 호출하면 해지.
   * 본인 listener 가 throw 해도 다른 listener 호출은 막지 않는다 — 한 어댑터의
   * 실수가 전체 reload 흐름을 흔들지 않도록.
   */
  subscribe(fn: ReloadListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 모든 구독자에게 reload 신호 송출. */
  emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        // silent fallback 금지 정신 = console.error 로 surface.
        console.error(
          `[reload-bus] subscriber threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** 테스트 편의 — 현재 구독자 수. */
  get size(): number {
    return this.listeners.size;
  }
}
