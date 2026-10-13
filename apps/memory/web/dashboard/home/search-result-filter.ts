/**
 * home/search-result-filter.ts
 *
 * 기억을 휴지통으로 이동한 뒤 검색 결과 목록에서 정직성을 지키기 위한 순수 필터.
 * 개별 삭제 spec T4 fix — final whole-branch review Medium 처리.
 *
 * 배경: 삭제 성공 후 refreshCoreData 는 stats/latest/schedule/graph 만 재조회하고
 * state.search 는 건드리지 않는다. 검색 결과가 떠 있는 상태에서 그 안의 항목을 지우면
 * 화면 왼쪽 목록에 삭제된 행이 그대로 남고, 클릭하면 GET /memories/:id 가 404 를
 * 돌려줘 "삭제했다고 방금 알렸는데 화면은 아직 있다고 우기는" 정직성 위반이 된다.
 *
 * 처리 방식은 재검색이 아니라 로컬 필터다 — 자동 재검색은 사용자가 보던 결과 집합의
 * 순서·구성을 조용히 바꿀 수 있어(다른 결과가 새로 끼어들거나 순위가 밀림) 오히려
 * 예측 불가능한 화면 변화를 만든다. 이미 지운 것으로 확인된 id 만 제거하는 쪽이
 * 최소하고 정직한 갱신이다.
 */

import type { SearchResponse, SearchResult } from "./types.ts";

/**
 * 검색 결과에서 방금 휴지통으로 이동한 원문 id + cascade 자식 id 를 제거한다.
 * search 가 없으면(검색 중이 아니면) null 을 그대로 돌려준다(no-op).
 * count 필드는 실제 남은 results 길이에 맞춰 다시 계산해 목록·헤더 표시가 서로 어긋나지
 * 않게 한다.
 */
export function removeTrashedFromSearch(
  search: SearchResponse | null,
  trashedId: number,
  cascadeIds: readonly number[],
): SearchResponse | null {
  if (!search) return null;

  const removed = new Set<number>([trashedId, ...cascadeIds]);
  const hasRemoved = search.results.some((r) => removed.has(r.id));
  if (!hasRemoved) return search;

  const results: SearchResult[] = search.results.filter((r) => !removed.has(r.id));
  return { ...search, results, count: results.length };
}
