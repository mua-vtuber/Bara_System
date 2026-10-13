#!/usr/bin/env bun
/**
 * monitor.ts — Phase 11b T2 (sub-phase 11.10).
 *
 * 자산 디렉토리 사용량 임계 (default 0.80 = 80%) 도달 시점 정직 console.warn 으로 알린다.
 *
 * 가동 양식:
 *   bun run apps/memory/scripts/monitor.ts
 *
 * 옛 `bara-monitor.timer`·`monitor.sh` 는 2026-10-08 펫 방식 단일 배포로 바뀌며 삭제됐다.
 * 지금은 운영자가 직접 가동한다 (본 script 자체는 한 가지 책임 가동만 담당).
 *
 * settings 로드 양식 = `server.ts` 부트 흐름 정합:
 *   1. process.env BARA_ASSET_DIR 우선 (env override)
 *   2. settings.assets.dir fallback (default "data/assets")
 *
 * exit code:
 *   - 0 = 정상 가동 (임계 도달 여부 무관 — 도달 시 console.warn 으로 알림, 종료 코드 0)
 *   - 1 = 측정 실패 (du / statfs 호출 실패 또는 settings 로드 실패)
 *
 * silent fallback 금지 (CLAUDE.md 정합):
 *   - 측정 실패 = console.error + exit 1 (조용히 0 회신 X)
 *   - 디렉토리 부재 = 측정 자체가 throw — 호출자 (systemd journal) 가 정직 에러 받음
 */

import { getMemorySettings, resolveSettingsFilePaths } from "../src/settings/memory-settings.ts";
import {
  DEFAULT_ASSET_THRESHOLD,
  runAssetDiskMonitor,
} from "../src/memory/monitoring/asset-disk.ts";

async function main(): Promise<void> {
  const { settingsPath, secretsPath } = resolveSettingsFilePaths(process.env);
  const settings = getMemorySettings(settingsPath, secretsPath);
  const assetDir = process.env.BARA_ASSET_DIR?.trim() || settings.assets.dir;

  // 임계 = env BARA_ASSET_THRESHOLD override 가용 (운영자 가동 시점 조정).
  // 없으면 DEFAULT_ASSET_THRESHOLD (0.80) 자연.
  const thresholdEnv = process.env.BARA_ASSET_THRESHOLD?.trim();
  const threshold = thresholdEnv ? Number.parseFloat(thresholdEnv) : DEFAULT_ASSET_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error(
      `BARA_ASSET_THRESHOLD 잘못된 값 = ${JSON.stringify(thresholdEnv)} `
      + `— 0 초과 1 이하 소수 (예: 0.80) 정합.`,
    );
  }

  const result = await runAssetDiskMonitor(assetDir, threshold);

  // 미도달 = 조용 정합 (journal 빈 단락). exceeded 안 warn 은 runAssetDiskMonitor 내부.
  // 명시 INFO 한 줄 = exit code 0 확인용 — systemd 진단 가용.
  if (!result.exceeded) {
    console.log(`[asset-disk] OK ${assetDir} — ${result.message}`);
  }
}

main().catch((e) => {
  console.error(`[asset-disk] 측정 실패: ${(e as Error).message}`);
  process.exit(1);
});
