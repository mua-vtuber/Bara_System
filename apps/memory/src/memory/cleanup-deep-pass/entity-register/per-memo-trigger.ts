/**
 * entity-register/per-memo-trigger.ts — "입력할 때마다"(spec 7.1 / D4) 대기열. 저장 응답을 막지 않도록
 * 메모 id 만 모았다가 짧게 기다린 뒤 한 회차로 연다. 다른 회차가 돌면 버리지 않고 다시 시도한다.
 *
 * 같은 메모는 대기열에 한 번만 들어간다(Set). 회차가 도는 동안 저장된 메모는 대기열에 남아 그 회차가
 * 끝난 뒤의 회차가 처리한다. 서버가 꺼지면 대기열은 사라지지만, 그 메모는 원장에 처리 기록이 없어
 * 다음 정기 주기나 "지금 정리하기"가 후보로 다시 잡는다.
 */
import type { TryTickResult } from "../../../scheduler.ts";
import { redactSecrets } from "../redact-secrets.ts";

export interface MemoSavedCleanupTrigger {
  enqueue(nodeId: number): void;
  stop(): void;
  pendingCount(): number;
}

export function createMemoSavedCleanupTrigger(opts: {
  isBusy: () => boolean;
  start: (nodeIds: number[]) => TryTickResult;
  debounceMs: number;
  busyRetryMs: number;
  /**
   * 한 회차에 보내는 메모 수 상한. 사람 연결 후보 조회가 nodeIds 를 받아도 LIMIT batchSize 를 그대로
   * 두므로, 그보다 많이 보내면 남는 메모가 그 회차에서 빠진다. 넘치는 메모는 대기열에 남아 다음 회차로 간다.
   * 생략하면 상한 없음.
   */
  maxPerRun?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  logPrefix?: string;
}): MemoSavedCleanupTrigger {
  if (opts.maxPerRun !== undefined && (!Number.isInteger(opts.maxPerRun) || opts.maxPerRun < 1)) {
    throw new Error(`createMemoSavedCleanupTrigger: maxPerRun 은 1 이상 정수여야 한다 (받은 값 ${opts.maxPerRun})`);
  }
  const setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const logPrefix = opts.logPrefix ?? "[entity-register]";
  const pending = new Set<number>();
  let timer: unknown = null;
  let stopped = false;

  const arm = (ms: number) => {
    if (stopped || timer !== null) return;
    timer = setT(flush, ms);
  };
  function flush(): void {
    timer = null;
    if (stopped || pending.size === 0) return;
    if (opts.isBusy()) {
      arm(opts.busyRetryMs);
      return;
    }
    const all = [...pending];
    const ids = opts.maxPerRun === undefined ? all : all.slice(0, opts.maxPerRun);
    let result: TryTickResult;
    try {
      result = opts.start(ids);
    } catch (e) {
      // 타이머 콜백에서 예외가 새면 서버 프로세스 전체가 죽고 대기열도 사라진다. 원인을 오류 로그로 남기고
      // 메모는 대기열에 둔 채 다시 시도한다(회차를 연 뒤의 실패는 start 쪽이 run 기록에 failed + 원인으로 남긴다).
      const cause = redactSecrets(e instanceof Error ? e.message : String(e));
      console.error(`${logPrefix} 입력 직후 정리 회차를 열지 못함 — 메모 ${ids.length}개, ${opts.busyRetryMs}ms 뒤 다시 시도. 원인: ${cause}`);
      arm(opts.busyRetryMs);
      return;
    }
    if (result === "already_running") {
      console.log(`${logPrefix} 입력 직후 정리 — 다른 정리 회차가 도는 중이라 ${ids.length}개 메모를 ${opts.busyRetryMs}ms 뒤 다시 시도.`);
      arm(opts.busyRetryMs);
      return;
    }
    for (const id of ids) pending.delete(id);
    // 상한 때문에 남은 메모 — 방금 연 회차가 도는 동안은 isBusy 가 막아 busyRetryMs 로 다시 미룬다.
    if (pending.size > 0) arm(opts.debounceMs);
  }

  return {
    enqueue(nodeId) {
      if (stopped) return;
      pending.add(nodeId);
      arm(opts.debounceMs);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearT(timer);
      timer = null;
    },
    pendingCount: () => pending.size,
  };
}
