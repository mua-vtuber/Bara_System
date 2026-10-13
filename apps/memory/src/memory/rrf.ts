/**
 * memory/rrf.ts — 순수 Reciprocal Rank Fusion (Cormack et al. 2009).
 *
 * 의존 방향 정리(1.1a T2): RRF 순수 함수는 원래 retriever.ts(memory 층)에
 * 있었다. 하지만 db 층의 search-repository.ts 가 듀얼 색인 결과를 RRF 로
 * 합치려면 같은 함수가 필요하고, retriever.ts 는 이미 store.ts(db 층)를
 * import 한다(memory → db). db 층이 retriever.ts 를 가져오면 db → memory → db
 * 순환이 생긴다(설계 원칙 "NO circular dependencies" 위반). 그래서 순수 함수
 * reciprocalRankFusion 과 상수 RRF_K 를 두 층이 같이 의존할 수 있는 이 하층
 * 공용 모듈로 추출했다. 함수·상수·동작은 옛 retriever.ts 와 동일(순수 함수
 * 이동 = 동작 변경 0). retriever.ts 는 여기서 import 후 re-export 한다.
 */

/** Standard RRF dampening constant (Cormack et al. 2009). */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion across `rankings`. Each ranking is an ordered
 * list of node ids; the position (0-based here) feeds `1 / (k + rank)`.
 * Returns a map from node id to accumulated RRF score.
 */
export function reciprocalRankFusion(
  rankings: ReadonlyArray<readonly number[]>,
  k: number = RRF_K,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const id = ranking[i] as number;
      // +1 so the 1st-place hit yields 1/(k+1), matching the literature.
      const contrib = 1 / (k + i + 1);
      out.set(id, (out.get(id) ?? 0) + contrib);
    }
  }
  return out;
}
