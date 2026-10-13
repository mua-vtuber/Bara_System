/**
 * asset-disk.ts — Phase 11b T2 (sub-phase 11.10).
 *
 * 자산 디렉토리 (`${BARA_ASSET_DIR}` 또는 settings.assets.dir) 사용량을 측정해
 * 임계 (default 0.80 = 80%) 도달 시점 정직 console.warn 으로 알린다.
 *
 * 두 책임 분리:
 *   - getAssetDirUsage(dir) — 실제 OS 호출 (`du -sb` + statfs) 로 사용량 + 전체 용량 측정.
 *   - checkAssetThreshold(usage, threshold) — 순수 함수, 임계 비교 + 사람 읽는 메시지 생성.
 *
 * 옛 `bara-monitor.timer` (systemd 5분 주기) 흐름에 합류하는 runAssetDiskMonitor 가 한 가지
 * 가동 단위 — `apps/memory/scripts/monitor.ts` 에서 호출한다.
 *
 * 정직 에러 정책 (CLAUDE.md / asset-store.ts 정합):
 *   - `du` 명령 실패 (디렉토리 부재 / 권한 등) = 구체 Error throw, silent 0 대체 X.
 *   - statfs 실패 (디렉토리 부재 등) = 구체 Error throw.
 *   - 임계 미도달 = 조용 (console.warn 호출 X) — 정상 상태에서 journal 빈 단락 자연.
 */

import { exec as execCb } from "node:child_process";
import { statfs } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execCb);

// ─────────────────────────────────────────────────────────────────────────────
// 공개 타입
// ─────────────────────────────────────────────────────────────────────────────

export interface AssetDirUsage {
  /** statfs 안 디스크 전체 용량 (bytes). `f_blocks * f_bsize`. */
  totalBytes: number;
  /** `du -sb` 안 자산 디렉토리 실제 사용량 (bytes). */
  usedBytes: number;
  /** usedBytes / totalBytes — 전체 디스크 기준 비율 0.0 ~ 1.0. totalBytes 가 0 이면 0. */
  percent: number;
}

export interface ThresholdCheckResult {
  /** percent >= threshold 시점 true. 정확 도달도 true (>= 비교). */
  exceeded: boolean;
  /** 한국어 사람 읽는 한 줄 — percent + 임계 + GB 단위 사용량 + 전체 용량. */
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 측정 — 실제 OS 호출
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 자산 디렉토리 사용량 + 디스크 전체 용량 측정.
 *
 * - `du -sb "${dir}"` 호출 — 디렉토리 모든 파일 byte 합. Linux/macOS 가용
 *   (Windows 부재 — 운영 환경 = Linux ARM64 A1, 개발 = WSL2 정합).
 * - `statfs(dir)` 호출 — 마운트된 파일시스템의 block 수 + block 크기. percent 의 분모.
 *
 * 두 호출 모두 실패 시 구체 Error throw — silent fallback / 0 대체 금지 (CLAUDE.md 정합).
 *
 * @param dir 자산 디렉토리 절대 경로 (예: `/home/bara/bara_system/data/assets`)
 * @returns { totalBytes, usedBytes, percent }
 * @throws Error `du` 명령 실패 또는 출력 파싱 실패 시점
 * @throws Error `statfs` 실패 시점
 */
export async function getAssetDirUsage(dir: string): Promise<AssetDirUsage> {
  let stdout: string;
  try {
    const result = await exec(`du -sb "${dir}"`);
    stdout = result.stdout;
  } catch (e) {
    throw new Error(
      `du -sb 호출 실패 — dir=${dir}, cause=${(e as Error).message}`,
    );
  }

  const firstField = stdout.trim().split(/\s+/)[0];
  const usedBytes = Number.parseInt(firstField ?? "", 10);
  if (!Number.isFinite(usedBytes) || usedBytes < 0) {
    throw new Error(
      `du -sb 출력 파싱 실패 — dir=${dir}, stdout=${JSON.stringify(stdout)}`,
    );
  }

  let totalBytes: number;
  try {
    const fs = await statfs(dir);
    totalBytes = fs.blocks * fs.bsize;
  } catch (e) {
    throw new Error(
      `statfs 호출 실패 — dir=${dir}, cause=${(e as Error).message}`,
    );
  }

  const percent = totalBytes > 0 ? usedBytes / totalBytes : 0;

  return { totalBytes, usedBytes, percent };
}

// ─────────────────────────────────────────────────────────────────────────────
// 임계 검증 — 순수 함수
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 사용량 측정값을 임계와 비교해 exceeded + 사람 읽는 message 회신.
 *
 * - `percent >= threshold` 시점 exceeded true (정확 도달도 true).
 * - message 양식 = `자산 디스크 사용량 NN.N% — 임계 NN% 초과/안 안전. 사용량 N.NNGB / 전체 N.NNGB.`
 * - GB 단위 = 1e9 (decimal — `du -sb` 와 정합. GiB 2^30 안 씀 = 운영자 친화).
 *
 * 순수 함수 — IO 0, side-effect 0. 단위 test 가용.
 */
export function checkAssetThreshold(
  usage: AssetDirUsage,
  threshold: number,
): ThresholdCheckResult {
  const exceeded = usage.percent >= threshold;
  const percentStr = (usage.percent * 100).toFixed(1);
  const thresholdStr = (threshold * 100).toFixed(0);
  const usedGB = (usage.usedBytes / 1e9).toFixed(2);
  const totalGB = (usage.totalBytes / 1e9).toFixed(2);

  const message = exceeded
    ? `자산 디스크 사용량 ${percentStr}% — 임계 ${thresholdStr}% 초과. `
      + `사용량 ${usedGB}GB / 전체 ${totalGB}GB.`
    : `자산 디스크 사용량 ${percentStr}% — 임계 ${thresholdStr}% 안 안전. `
      + `사용량 ${usedGB}GB / 전체 ${totalGB}GB.`;

  return { exceeded, message };
}

// ─────────────────────────────────────────────────────────────────────────────
// 가동 단위 — monitor.ts 에서 호출
// ─────────────────────────────────────────────────────────────────────────────

/** threshold default — 80% 도달 시점 경고. plan 권위 (sub-phase 11.10). */
export const DEFAULT_ASSET_THRESHOLD = 0.8;

/**
 * 한 가지 가동 단위 — 측정 + 검증 + 임계 도달 시점 console.warn.
 *
 * - exceeded 시점 = `console.warn('[asset-disk] threshold exceeded: ...')` — stderr 자연.
 * - 미도달 시점 = 조용 (호출 0) — systemd journal 빈 단락 정합.
 * - 측정 실패 (du / statfs) = throw 통과 — 호출자가 정직 에러 받음.
 *
 * @param dir 자산 디렉토리 절대 경로
 * @param threshold default DEFAULT_ASSET_THRESHOLD (0.80)
 */
export async function runAssetDiskMonitor(
  dir: string,
  threshold: number = DEFAULT_ASSET_THRESHOLD,
): Promise<ThresholdCheckResult> {
  const usage = await getAssetDirUsage(dir);
  const result = checkAssetThreshold(usage, threshold);
  if (result.exceeded) {
    console.warn(`[asset-disk] threshold exceeded: ${result.message}`);
  }
  return result;
}
