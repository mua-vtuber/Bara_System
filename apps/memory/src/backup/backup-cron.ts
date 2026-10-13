/**
 * 백업 cron — 매일 정해진 시각(settings.time.zone 벽시계 기준)에 백업 한 회차를
 * 실행하는 setTimeout 단일 timer 재예약 흐름. (spec D1-b, P4 T3)
 *
 * trash cron(trash-manager.ts startTrashCron)의 stopped/pendingTimer/scheduleNext
 * 골격을 따르되, 다음 가동 시각 계산이 다르다: trash cron 은 시스템 TZ 의
 * `setHours` 방식인데, 백업 시각은 settings.time.zone 의 벽시계로 해석해야
 * 하므로(spec D1-b — 시스템 TZ 방식을 복사하지 않는다) Intl 기반 zone-aware
 * 계산(msUntilNextRunInZone)을 쓴다.
 *
 * 한 사이클 = cleanupIncompleteRounds(반쪽 회차 청소) → runBackupRound(한 회차)
 * → applyRetention(보존일 초과 정리) → recordBackupSuccess. 실패는 loud 로그 +
 * recordBackupFailure 후 다음 주기로 재예약(흐름 끊김 차단).
 */
import {
  applyRetention,
  cleanupIncompleteRounds,
  runBackupRound,
  type BackupRunDeps,
} from "./backup-runner.ts";
import {
  recordBackupFailure,
  recordBackupSuccess,
  recordNextRunAt,
} from "./backup-status.ts";

/** zone 벽시계 부품 — "YYYY-MM-DD HH:MM:SS" (sv-SE) 파싱. */
function wallClockParts(ms: number, zone: string) {
  const s = new Date(ms).toLocaleString("sv-SE", { timeZone: zone, hour12: false });
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`wallClockParts: 예상 밖 포맷 "${s}" (zone=${zone})`);
  return { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +m[4]!, mi: +m[5]!, s: +m[6]! };
}

/** zone 벽시계 (y,mo,d,h,mi) 의 UTC epoch — 오프셋 2회 보정(DST 경계 수렴). */
function epochOfWallClock(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const want = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = wallClockParts(guess, zone);
    guess += want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  }
  return guess;
}

/**
 * cronTime("HH:MM")이 zone 벽시계로 다음에 도래하는 시각까지 남은 ms. 순수 함수 —
 * 시스템 TZ 와 무관하게 zone 인자만 따른다. 잘못된 cronTime 은 loud throw.
 */
export function msUntilNextRunInZone(cronTime: string, zone: string, nowMs: number): number {
  const [hhRaw, mmRaw] = cronTime.split(":");
  const hh = Number(hhRaw); const mm = Number(mmRaw);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error(`startBackupCron: invalid cronTime "${cronTime}" — "HH:MM" (00:00~23:59)`);
  }
  const today = wallClockParts(nowMs, zone);
  let target = epochOfWallClock(today.y, today.mo, today.d, hh, mm, zone);
  if (target <= nowMs) {
    const t = new Date(Date.UTC(today.y, today.mo - 1, today.d + 1)); // 월말 롤오버는 Date.UTC 처리
    target = epochOfWallClock(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), hh, mm, zone);
  }
  return target - nowMs;
}

export interface BackupCronOptions {
  /** "HH:MM" — zone 벽시계 기준. */
  cronTime: string;
  /** settings.time.zone — 이 zone 의 벽시계로 cronTime 을 해석한다. */
  zone: string;
  /** trash cron 관례 — live getter. false 면 그 사이클은 조용히 건너뛰고 재예약. */
  enabled: () => boolean;
  /** 사이클마다 조립 — settings 재로딩 후 값이 다음 사이클에 반영되는 live 조립. */
  runDeps: () => BackupRunDeps;
  retentionDays: number;
  /** 현재 시각(ms) 제공자. 미주입 시 Date.now. */
  now?: () => number;
  /** setTimeout 대체(테스트 mock clock 주입용). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** clearTimeout 대체. setTimeout 과 짝. */
  clearTimeout?: (handle: unknown) => void;
}

export interface BackupCronHandle {
  /** 수동 가동 — cron 주기 무시 + 즉시 한 사이클. 성공 여부 반환. */
  tickNow(): Promise<boolean>;
  /** 진행 중 timer 정리 + 신규 가동 차단 + nextRunAt null. */
  stop(): void;
}

/**
 * 백업 cron 가동. 잘못된 cronTime 은 첫 scheduleNext 의 msUntilNextRunInZone 이
 * 즉시 throw 해 부팅에서 멈춘다(silent fallback 금지).
 */
export function startBackupCron(options: BackupCronOptions): BackupCronHandle {
  const now = options.now ?? (() => Date.now());
  const schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel =
    options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let stopped = false;
  let pendingTimer: unknown | null = null;

  async function runOnce(): Promise<boolean> {
    if (stopped || !options.enabled()) return false;
    try {
      const deps = options.runDeps();
      cleanupIncompleteRounds(deps.backupDir);
      const { roundDir } = await runBackupRound(deps);
      applyRetention(deps.backupDir, options.retentionDays, now());
      recordBackupSuccess(new Date(now()).toISOString(), roundDir);
      return true;
    } catch (e) {
      console.error("[backup-cron] cycle failed:", e);
      recordBackupFailure(
        new Date(now()).toISOString(),
        e instanceof Error ? e.message : String(e),
      );
      return false;
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    const delay = msUntilNextRunInZone(options.cronTime, options.zone, now());
    recordNextRunAt(new Date(now() + delay).toISOString());
    pendingTimer = schedule(() => {
      pendingTimer = null;
      // 가동 → 끝나면 다음 시각으로 재예약. 가동 실패도 다음 주기로
      // 흐름 끊김 차단 — runOnce 안 try/catch 가 흡수 후 false 반환.
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
      recordNextRunAt(null);
    },
  };
}
