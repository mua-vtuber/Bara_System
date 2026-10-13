/**
 * asset-cleanup-log.ts — 코어가 돌려준 첨부 파일 정리 결과(assetCleanup)를 봇 로그 줄로 만든다(WP-B1-20U 설계 17.17).
 *
 * 코어는 메시지 삭제를 먼저 확정하고 같은 쓰기 잠금 안에서 첨부 파일을 지운다. 지우지 못한 파일(권한·잠김 등)이 있어도
 * 기억 삭제는 끝났고 코어가 서버 시작 때 그 파일을 다시 지운다 — 봇은 다시 보내지 않고 파일마다 경고 로그를 남긴다.
 * 메시지 삭제 동기화(index.ts MessageDelete)가 쓴다. index.ts 가 800줄 상한을 넘어 로그 줄 만들기를 이 모듈로 덜어 냈다.
 */

import type { AssetCleanup, DeleteBySourceResult } from "../../memory/src/api-client.ts";

/** 지우지 못한 첨부 파일마다 경고 한 줄(없으면 빈 배열). context = 어떤 삭제였는지(예: "message 123"). */
export function assetCleanupFailureLines(context: string, cleanup: AssetCleanup): string[] {
  return cleanup.failed.map(
    (failure) =>
      `${context}: 첨부 파일을 지우지 못함(기억 삭제는 끝남, 코어가 서버 시작 때 다시 지움) — ` +
      `${failure.sha256} ${failure.path}: ${failure.error}`,
  );
}

/** 메시지 삭제 동기화 결과 로그 — 지운 기억(또는 일치 없음)과, 지우지 못한 첨부 파일마다 경고. */
export function logMessageDeleteSync(prefix: string, messageId: string, result: DeleteBySourceResult): void {
  if (result.deletedCount > 0) {
    console.log(
      `${prefix} synced deletion: message ${messageId} → removed ${result.deletedCount} memory rows (${result.deletedIds.join(", ")})`,
    );
  } else {
    console.log(`${prefix} message ${messageId} deleted on Discord; no matching memory rows`);
  }
  for (const line of assetCleanupFailureLines(`message ${messageId}`, result.assetCleanup)) {
    console.warn(`${prefix} ${line}`);
  }
}
