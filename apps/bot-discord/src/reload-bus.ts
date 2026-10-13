/**
 * ReloadBus — 디스코드 봇 어댑터 listener 한 벌 (Phase 5.5.6 / S14)
 *
 * settings 라우터가 PUT 성공 후 1회 `emit()` 한다. 구독자(예: discord.js
 * Client 재로그인 / evolver 폴러 / 메모리 API client 재구성) 가 자기
 * 캐시를 무효화하거나 얌전한 재시작을 트리거할 수 있다.
 *
 * 메모리 코어 `apps/memory/src/settings/reload-bus.ts` (S9) 와 같은 톤 —
 * 외부 의존성 없이 Set 1개로 충분.
 */

export type ReloadListener = () => void;

export class ReloadBus {
  private readonly listeners: Set<ReloadListener> = new Set();

  /**
   * 구독 등록. 반환 함수를 호출하면 해지.
   * 한 listener 가 throw 해도 다른 listener 호출은 막지 않는다 — 한 갈래의
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
          `[bot-discord reload-bus] subscriber threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** 테스트 편의 — 현 구독자 수. */
  get size(): number {
    return this.listeners.size;
  }
}
