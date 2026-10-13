/**
 * Phase 5.7.3 W4 — 휴지통 시간 단계 (옛 evolver 단계 4 분리).
 *
 * 옛 `evolver.evolve()` 안 단계 4 (purgeOldArchive + getArchiveSoonToPurge)
 * 분리. W2 의 `auto-cleanup-runner.ts` 가 활동 단계 (단계 1+2+3+5) 라면 본
 * 파일은 시간 단계 — 매일 새벽 cron 한 번 가동. 두 시스템은 DB 안 휴지통
 * 테이블 공유 외 함수 호출 결합 0.
 *
 * 동작 순서:
 *  1. `store.purgeOldArchive(retentionDays)` 호출 — N일+ archive 영구 삭제. 저장소가 쓰기 잠금 안에서
 *     그 노드들이 주인인 첨부 기록·파일까지 지우고 결과를 assetCleanup 으로 돌려준다(WP-B1-20U 설계 17.17).
 *     지우지 못한 파일은 요약에 담고 파일마다 오류 로그를 남긴다(행은 대기로 남아 서버 시작 때 다시 지운다).
 *  2. `store.getArchiveSoonToPurge(warningDays, retentionDays)` 호출 — 7일 안
 *     영구 삭제 임박 노드 목록 산출 (어댑터 polling 통로의 GET 라우트가 같은
 *     함수 직접 호출)
 *  3. `store.logTrashActivity(summary)` 활동 요약 DB 로그
 *
 * cron 흐름:
 *  - `cronTime = "HH:MM"` (KST) — A1 systemd Environment=TZ=Asia/Seoul 가정
 *  - `setTimeout` 기반 — 다음 가동 시각까지 한 번에 등록한 단일 timer.
 *    가동 끝나면 다음 24h 후 시각으로 재예약 (옛 `setInterval` 24h 흐름
 *    재현하되 매일 같은 시각 가동 보장).
 *  - 테스트성 = `now()` + `setTimeout` + `timeSource()` 함수 주입 (W3 trigger
 *    패턴 정합).
 *
 * 디자인 근거: docs/decisions/2026-05-21-memory-auto-cleanup-redesign-spec.md §4.2
 *            + docs/decisions/2026-05-21-memory-auto-cleanup-redesign-plan.md §5
 */

import type { ArchivedNode } from "./types.ts";
import type { EventsPurgeResult } from "../db/store-internal/event-repository.ts";
import type { PurgeOldArchiveResult } from "../db/store-internal/stats-repository.ts";
import type { AssetCleanup } from "../assets/released-asset-files.ts";

/**
 * `runTrashManagement` 의존 store 표면 (좁힘). SqliteMemoryStore 가 실 구현.
 *
 * W2 의 `AutoCleanupStore` 와 의도적으로 분리 — 두 시스템 표면 결합 0,
 * 옛 evolver-scheduler 의 한 사이클 5단계 통합 흐름 분해 정신 정합.
 */
export interface TrashManagementStore {
  purgeOldArchive(maxAgeDays: number): Promise<PurgeOldArchiveResult>;
  getArchiveSoonToPurge(
    warnDays: number,
    maxAgeDays: number,
  ): Promise<readonly ArchivedNode[]>;
  logTrashActivity(summary: {
    nodesPurged: number;
    soonToPurgeCount: number;
  }): Promise<void>;
}

/**
 * P3 G3-c — events 보존 정리 표면 (좁힘). EventRepository 가 실 구현. archive 정리와
 * 같은 trash cron 박자에 합류하되(사용자 결정 — 별 주기 아님), archive store 와
 * 별 인스턴스라 표면을 나눠 결합을 낮춘다. 미주입(undefined)이면 events 정리를
 * 건너뛴다 — events 정리 없는 옛 경로(테스트·부분 배선)와 정합.
 */
export interface EventsRetentionStore {
  /**
   * retentionDays 지난 events 삭제. protectAfterId 이후는 재연결 이어받기 보호로
   * 남긴다. 결과에 삭제 개수·무제한 skip·커서 침범 여부를 담아 회신한다.
   */
  purgeOldEvents(
    retentionDays: number,
    protectAfterId?: number,
  ): EventsPurgeResult;
}

export interface TrashManagementOptions {
  /** N일+ archive 노드 영구 삭제. */
  retentionDays: number;
  /** 영구 삭제 N일 전 알림 목록 산출. */
  warningDays: number;
  /**
   * P3 G3-c — events 큐 보존일. events 정리를 archive 정리와 같은 cron 사이클에
   * 합류시킨다. EVENTS_RETENTION_UNLIMITED(-1)면 무제한(삭제 안 함). 미지정 시
   * events 정리 자체를 건너뛴다(eventsStore 미주입 경로 정합).
   */
  eventsRetentionDays?: number;
}

export interface TrashActivitySummary {
  /** ISO 8601 UTC 시각 (가동 시작 시점). */
  startedAt: string;
  /** 한 사이클 가동 시간 (밀리초). */
  durationMs: number;
  /** 본 사이클에 영구 삭제된 노드 수. */
  nodesPurged: number;
  /**
   * WP-B1-20U 설계 17.17 — 본 사이클에 영구 삭제된 노드가 주인이던 문서 기록, 지운 첨부 파일, 이미 없던 파일, 지우지
   * 못한 파일(경로·원인 — asset_files 행은 대기로 남아 서버 시작 때 다시 지운다).
   */
  assetCleanup: AssetCleanup;
  /** 본 사이클 시점에 영구 삭제 임박 노드 수. */
  soonToPurgeCount: number;
  /**
   * P3 G3-c — 본 사이클에 영구 삭제된 events 수. eventsStore 미주입이거나
   * retentionDays 미지정이면 0(events 정리 미가동).
   */
  eventsPurged: number;
  /**
   * P3 G3-c — events 보존 창이 재연결 이어받기 커서를 침범해 일부 오래된 events 를
   * 커서 보호로 남긴 경우 true. retentionDays 가 너무 짧다는 신호(호출자가 경고).
   */
  eventsClampedToCursor: boolean;
}

/**
 * 휴지통 한 사이클 가동 — 영구 삭제 + 임박 노드 계산 + 활동 로그.
 *
 * 옛 evolver.evolve() 안 단계 4 분리. 호출자는 `startTrashCron` 의 timer
 * 또는 수동 (대시보드 / CLI) — 둘 다 throttle X (cron 주기가 이미 24h).
 *
 * P3 G3-c — eventsStore 가 주어지고 options.eventsRetentionDays 가 지정되면 같은
 * 사이클에 events 보존 정리도 잇는다. events 정리는 archive 정리와 결합 0 (다른
 * 테이블·다른 표면)이라, 한쪽 실패가 다른 쪽을 막지 않도록 순차로 각각 돌린다.
 */
export async function runTrashManagement(
  store: TrashManagementStore,
  options: TrashManagementOptions,
  eventsStore?: EventsRetentionStore,
): Promise<TrashActivitySummary> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const { nodesPurged, assetCleanup } = await store.purgeOldArchive(options.retentionDays);
  // WP-B1-20U 설계 17.17 — 보관 노드 삭제는 이미 커밋됐다. 지우지 못한 첨부 파일을 조용히 넘기지 않는다.
  for (const failure of assetCleanup.failed) {
    console.error(
      "[trash-cron] 보관 만료로 지운 기억의 첨부 파일을 지우지 못함(asset_files 행은 대기로 남아 서버 시작 때 다시 지움): " +
        `${failure.sha256} ${failure.path} — ${failure.error}`,
    );
  }
  const soonToPurge = await store.getArchiveSoonToPurge(
    options.warningDays,
    options.retentionDays,
  );

  // P3 G3-c — events 보존 정리. eventsStore 미주입 또는 retentionDays 미지정이면
  // 건너뛴다(events 정리 없는 옛 경로). 커서 침범 시 경고는 여기서 loud 하게 남긴다
  // (retentionDays 가 재연결 윈도우를 침범 — silent 통과 금지).
  let eventsPurged = 0;
  let eventsClampedToCursor = false;
  if (eventsStore && options.eventsRetentionDays !== undefined) {
    const eventsResult = eventsStore.purgeOldEvents(options.eventsRetentionDays);
    eventsPurged = eventsResult.deleted;
    eventsClampedToCursor = eventsResult.clampedToCursor;
    if (eventsResult.clampedToCursor) {
      console.warn(
        "[trash-cron] events 보존 창이 재연결 이어받기 커서를 침범 — 커서 이후 이벤트를 보호로 남김. " +
          `settings.events.retentionDays(${options.eventsRetentionDays})가 SSE 재연결 윈도우보다 짧다.`,
      );
    }
  }

  const summary: TrashActivitySummary = {
    startedAt,
    durationMs: Date.now() - startedAtMs,
    nodesPurged,
    assetCleanup,
    soonToPurgeCount: soonToPurge.length,
    eventsPurged,
    eventsClampedToCursor,
  };

  await store.logTrashActivity({
    nodesPurged: summary.nodesPurged,
    soonToPurgeCount: summary.soonToPurgeCount,
  });

  return summary;
}

/**
 * `startTrashCron` 입력. cronTime + store + 가동 토글 + 시각/timer 주입.
 */
export interface TrashCronOptions {
  /** 가동 시각 "HH:MM" (KST). 예: "03:00". */
  cronTime: string;
  store: TrashManagementStore;
  managementOptions: TrashManagementOptions;
  /**
   * P3 G3-c — events 보존 정리 표면(선택). 주입되면 매 사이클 archive 정리 뒤
   * events 정리도 같이 돈다(managementOptions.eventsRetentionDays 기준). 미주입 시
   * events 정리 미가동(옛 archive-만 경로 정합).
   */
  eventsStore?: EventsRetentionStore;
  /** 가동 토글 — settings.trashManagement.enabled getter 를 그대로 전달한다. */
  enabled: () => boolean;
  /**
   * 현재 시각 (밀리초). 미주입 시 Date.now. 테스트에서 mock clock 주입용.
   */
  now?: () => number;
  /** setTimeout 대체. 미주입 시 전역 setTimeout. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** clearTimeout 대체. setTimeout 과 짝. */
  clearTimeout?: (handle: unknown) => void;
  /**
   * 다음 가동 시각 계산용 Date 인스턴스 제공자. 미주입 시 `new Date()`.
   * 테스트에서 mock clock 의 nowMs 를 Date 로 감싸 주입 — cron 의 hh/mm
   * 계산이 시스템 TZ 따름 정합 유지.
   */
  timeSource?: () => Date;
}

/**
 * `startTrashCron` 반환 handle.
 */
export interface TrashCronHandle {
  /** 수동 가동 — cron 주기 무시 + 즉시 runTrashManagement 호출. */
  tickNow(): Promise<TrashActivitySummary | null>;
  /** 진행 중 timer 정리 + 신규 가동 차단. */
  stop(): void;
}

/**
 * 매일 정해진 시각에 가동되는 cron — setTimeout 단일 timer 재예약 흐름.
 *
 * cronTime = "HH:MM" KST. 한 사이클 가동 후 다음 가동 시각 = 다음 cronTime
 * 도달 시점 (= 다음 날 같은 시각 또는 같은 날 미래 시각).
 */
export function startTrashCron(options: TrashCronOptions): TrashCronHandle {
  const now = options.now ?? (() => Date.now());
  const schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel =
    options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const dateNow = options.timeSource ?? (() => new Date(now()));

  const [hhRaw, mmRaw] = options.cronTime.split(":");
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (
    !Number.isFinite(hh) ||
    !Number.isFinite(mm) ||
    hh < 0 || hh > 23 ||
    mm < 0 || mm > 59
  ) {
    throw new Error(
      `startTrashCron: invalid cronTime "${options.cronTime}" — must match "HH:MM" (00:00~23:59)`,
    );
  }

  let stopped = false;
  let pendingTimer: unknown | null = null;

  function msUntilNextRun(): number {
    const present = dateNow();
    const next = new Date(present);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= present.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime() - present.getTime();
  }

  async function runOnce(): Promise<TrashActivitySummary | null> {
    if (stopped || !options.enabled()) return null;
    try {
      return await runTrashManagement(
        options.store,
        options.managementOptions,
        options.eventsStore,
      );
    } catch (e) {
      console.error("[trash-cron] cycle failed:", e);
      return null;
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    const delay = msUntilNextRun();
    pendingTimer = schedule(() => {
      pendingTimer = null;
      // 가동 → 끝나면 다음 시각으로 재예약. 가동 실패도 다음 주기로
      // 흐름 끊김 차단 — runOnce 안 try/catch 가 흡수 후 null 반환.
      void runOnce().then(() => scheduleNext());
    }, delay);
  }

  scheduleNext();

  return {
    tickNow: () => runOnce(),
    stop: () => {
      stopped = true;
      if (pendingTimer !== null) {
        cancel(pendingTimer);
        pendingTimer = null;
      }
    },
  };
}
