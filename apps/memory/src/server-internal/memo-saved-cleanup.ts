/**
 * server-internal/memo-saved-cleanup.ts — 저장 성공 뒤 "입력할 때마다" 대기열에 메모 id 를 넣는다.
 * 대기열은 cleanupRuns 배선(index.ts)이 on_save 일 때만 둔다. 재사용(cacheHit)·엔티티 패치는 넣지 않는다.
 * 응답을 기다리게 하지 않는다 — enqueue 는 동기 Set 추가뿐이다.
 *
 * 사용자가 보낸 원본 글 저장 경로(REST 입력·덧붙이기·MCP 저장)만 이 함수를 부른다. 정리 단계가 직접 만드는
 * 일정 노드·추출 조각은 이 경로를 지나지 않으므로 정리가 정리를 다시 부르는 고리가 생기지 않는다.
 */
import type { SaveTextInputResult } from "./save-input-types.ts";
import type { MemoryApiDeps } from "./types.ts";

export function notifyMemoSaved(
  deps: Pick<MemoryApiDeps, "cleanupRuns">,
  result: Pick<SaveTextInputResult, "kind" | "originNodeId" | "cacheHit">,
): void {
  if (result.kind !== "memory" || result.originNodeId === null || result.cacheHit) return;
  deps.cleanupRuns?.onMemoSaved?.(result.originNodeId);
}
