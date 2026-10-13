/**
 * store-internal/id-batches.ts — 노드 id 목록을 SQL `IN (...)` 한 번에 넣을 크기로 나누는 도우미.
 *
 * 출처 표 저장소(node-source-repository.ts), 제거 계획(memory/lineage-removal.ts), 보관 이동
 * (stats-repository.ts), 수정 이력 정리(revision-repository.ts)가 같은 묶음 크기를 쓴다.
 */

/** IN 목록 한 번에 넣는 id 수(WP-B1-20T 설계 6.1). SQLite 변수 상한보다 충분히 작다. */
export const ID_BATCH_SIZE = 500;

/** items 를 ID_BATCH_SIZE 개씩 나눈 묶음 목록(순서 유지). 빈 입력이면 빈 목록. */
export function inIdBatches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += ID_BATCH_SIZE) {
    out.push(items.slice(start, start + ID_BATCH_SIZE));
  }
  return out;
}

/** 자리표시자 `?, ?, ...` count 개. */
export function sqlPlaceholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}
