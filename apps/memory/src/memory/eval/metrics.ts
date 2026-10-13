/**
 * memory/eval/metrics.ts — 검색 평가 metric 순수 함수 (상위 spec 단락 5.8.4).
 *
 * 모든 함수는 데이터 입력 → 점수 출력의 순수 함수다. DB·임베딩·네트워크 의존 0,
 * 부수효과 0. mock 객체·인터페이스 가짜 구현 금지 — 데이터 fixture 로만 검증
 * (CLAUDE.md 테스트 정책 정합).
 *
 * 정답은 그룹 구조 number[][] — 한 그룹 = OR(그룹 안 하나만 충족하면 됨),
 * 그룹들끼리 = AND(모든 그룹이 충족돼야 완전). 예: [[14,15,16],[21]] =
 * (14 또는 15 또는 16) 그리고 21. 한 그룹을 *처음* 충족시키는 결과 1개만
 * 점수를 받고, 같은 그룹의 두 번째 충족 결과는 0(중복).
 */

/** 한 그룹을 처음 충족시키는 ranked 위치(0-based). 없으면 -1. */
function firstHitRank(ranked: readonly number[], group: readonly number[]): number {
  const set = new Set(group);
  for (let i = 0; i < ranked.length; i++) {
    if (set.has(ranked[i]!)) return i;
  }
  return -1;
}

/**
 * nDCG (그룹-최초-충족). 각 정답 그룹의 첫 충족 위치에 DCG gain 을 부여하고,
 * 이상적 배치(모든 그룹이 상위에 충족) IDCG 로 정규화. gradedRel 미지정 시
 * binary(gain=1). 그룹이 0개면 0 반환(정의상 측정 대상 없음).
 */
export function computeNdcg(
  ranked: readonly number[],
  answerGroups: readonly (readonly number[])[],
  gradedRel?: ReadonlyMap<number, number>,
): number {
  if (answerGroups.length === 0) return 0;
  const gains: number[] = [];
  for (const group of answerGroups) {
    const rank = firstHitRank(ranked, group);
    if (rank < 0) continue;
    // 그룹 대표 gain = 그룹 안 graded 최대치(없으면 1).
    let gain = 1;
    if (gradedRel) {
      let g = 0;
      for (const id of group) g = Math.max(g, gradedRel.get(id) ?? 0);
      gain = g > 0 ? g : 1;
    }
    gains.push(gain / Math.log2(rank + 2)); // rank 0 → log2(2)=1
  }
  const dcg = gains.reduce((s, g) => s + g, 0);
  // IDCG = 모든 그룹이 0,1,2,... 위치에 이상 배치.
  const idealGains = answerGroups
    .map((group) => {
      if (!gradedRel) return 1;
      let g = 0;
      for (const id of group) g = Math.max(g, gradedRel.get(id) ?? 0);
      return g > 0 ? g : 1;
    })
    .sort((a, b) => b - a)
    .map((gain, i) => gain / Math.log2(i + 2));
  const idcg = idealGains.reduce((s, g) => s + g, 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

/** recall (그룹 기준) — 충족된 그룹 수 / 전체 그룹 수. */
export function computeRecallByGroup(
  ranked: readonly number[],
  answerGroups: readonly (readonly number[])[],
): number {
  if (answerGroups.length === 0) return 0;
  let hit = 0;
  for (const group of answerGroups) {
    if (firstHitRank(ranked, group) >= 0) hit++;
  }
  return hit / answerGroups.length;
}

/** MRR — 어떤 그룹이든 첫 충족 순위의 역수(전체 그룹 중 가장 이른 충족). */
export function computeMrr(
  ranked: readonly number[],
  answerGroups: readonly (readonly number[])[],
): number {
  let best = Infinity;
  for (const group of answerGroups) {
    const rank = firstHitRank(ranked, group);
    if (rank >= 0) best = Math.min(best, rank);
  }
  return best === Infinity ? 0 : 1 / (best + 1);
}

/**
 * precision (그룹 기준) — 충족된 그룹 수 / ranked 반환 개수. 그룹 최초-충족
 * 결과만 "적중"으로 세고, 같은 그룹의 두 번째 충족은 기여하지 않는다(recall과
 * 동일한 hit 집계, 분모만 ranked.length). ranked 가 0개면 0(정의상 측정 대상 없음).
 */
export function computePrecision(
  ranked: readonly number[],
  answerGroups: readonly (readonly number[])[],
): number {
  if (ranked.length === 0) return 0;
  let hit = 0;
  for (const group of answerGroups) {
    if (firstHitRank(ranked, group) >= 0) hit++;
  }
  return hit / ranked.length;
}

/** F1 — precision 과 recall(그룹 기준)의 조화평균. 둘 다 0이면 0(분모 0 회피). */
export function computeF1(
  ranked: readonly number[],
  answerGroups: readonly (readonly number[])[],
): number {
  const precision = computePrecision(ranked, answerGroups);
  const recall = computeRecallByGroup(ranked, answerGroups);
  if (precision === 0 && recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * MAP(단일 쿼리 average precision) — 각 그룹의 첫 충족 위치에서 "그 위치까지의
 * precision"(이미 충족된 그룹 수 / (rank+1))을 누적해 충족 그룹 수로 나눈다.
 * 여러 쿼리에 걸친 MAP 은 이 함수를 쿼리마다 호출한 뒤 평균 내는 방식으로
 * 계산한다(호출부 harness 의 avgNdcg/avgRecall 과 동일 집계 관례 — 이 파일은
 * 단일-쿼리 순수 함수만 제공). 그룹이 0개면 0 반환.
 */
export function computeMap(
  ranked: readonly number[],
  answerGroups: readonly (readonly number[])[],
): number {
  if (answerGroups.length === 0) return 0;
  const hitRanks: number[] = [];
  for (const group of answerGroups) {
    const rank = firstHitRank(ranked, group);
    if (rank >= 0) hitRanks.push(rank);
  }
  if (hitRanks.length === 0) return 0;
  hitRanks.sort((a, b) => a - b);
  let sum = 0;
  hitRanks.forEach((rank, i) => {
    sum += (i + 1) / (rank + 1);
  });
  return sum / hitRanks.length;
}
