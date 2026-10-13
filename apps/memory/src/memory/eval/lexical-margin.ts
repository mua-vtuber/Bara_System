/**
 * memory/eval/lexical-margin.ts — margin 지표 순수 함수 (일치성 검색 재설계 GM).
 *
 * nDCG(computeNdcg / metrics.ts)는 group-first-hit 이라 정답이 1위면 nDCG=1.0 으로
 * 포화한다 — 정답과 top-distractor 의 점수 격차를 못 본다. GB(글 회귀 감시)·IM(그림
 * 글자항 값어치)은 미세 순위/격차 변화를 재야 하므로, 최종 score 격차를 직접 보는
 * margin 지표를 추가한다. nDCG 는 회수 게이트(정답이 pool 에 드는가)용으로 남는다.
 *
 * margin = (정답 노드 최고 score) − (top-distractor score)
 *  - margin > 0 : 정답이 최상위 오답보다 위(보장). 값이 클수록 여유.
 *  - margin = 0 : 정답과 최상위 오답이 동점(경계 — 아슬아슬).
 *  - margin < 0 : 정답이 최상위 오답보다 아래(회귀).
 *
 * 경계 신호(수치로 정직히 구분):
 *  - 정답 미회수(결과에 정답 id 없음) → -Infinity. 이는 순위(margin)가 아니라 회수
 *    문제다(설계 회수 경계) — 0 이나 낮은 양수로 뭉개지 않고 확실한 실패 신호를 준다.
 *  - distractor 없음(전부 정답이거나 지정 distractor 미회수) → +Infinity. 비교 대상이
 *    없어 margin 이 정의되지 않는다 — 가짜 0 대신 "비교 불가"를 명시한다.
 *
 * 순수 함수 — retrieve 결과 배열(node.id + score) + id 집합 입력, 부작용 0. DB·임베딩·
 * 네트워크 의존 0. mock 객체·인터페이스 가짜 구현 금지 — 데이터 fixture 로만 검증
 * (CLAUDE.md 테스트 정책 / metrics.ts 정합).
 */

/**
 * margin 계산에 필요한 최소 결과 형태 — RetrievalResult 의 부분집합(node.id + score).
 * retriever.retrieve() 결과를 그대로 넣을 수 있고, 테스트는 이 형태의 데이터 fixture 로
 * 검증한다(RetrievalResult 전체를 요구하지 않아 순수 함수 테스트가 가볍다).
 */
export interface MarginScorable {
  node: { id: number };
  score: number;
}

/**
 * 정답 노드 최고 score 와 top-distractor score 의 격차를 잰다.
 *
 * @param results        retrieve 결과 배열(정렬 순서 무관 — 내부에서 최고값을 찾는다).
 * @param answerIds      정답 노드 id 집합. 이 중 결과에 든 노드의 최고 score 가 정답 대표.
 * @param distractorIds  (선택) top-distractor 를 이 집합으로 한정. 미지정이면 정답이
 *                       아닌 모든 결과 노드를 distractor 로 본다.
 * @returns              margin. 정답 미회수 → -Infinity. distractor 없음 → +Infinity.
 */
export function scoreMargin(
  results: readonly MarginScorable[],
  answerIds: ReadonlySet<number>,
  distractorIds?: ReadonlySet<number>,
): number {
  let bestAnswer = -Infinity;
  let bestDistractor = -Infinity;

  for (const r of results) {
    const isAnswer = answerIds.has(r.node.id);
    if (isAnswer) {
      if (r.score > bestAnswer) bestAnswer = r.score;
      continue;
    }
    // distractor 판정 — distractorIds 지정 시 그 집합만, 미지정이면 정답 아닌 전부.
    const isDistractor =
      distractorIds === undefined ? true : distractorIds.has(r.node.id);
    if (isDistractor && r.score > bestDistractor) bestDistractor = r.score;
  }

  // 정답이 결과에 하나도 없으면 회수 실패 — 순위 문제가 아니라 회수 문제 신호.
  if (bestAnswer === -Infinity) return -Infinity;
  // 비교할 distractor 가 없으면 margin 정의 불가 — 가짜 0 대신 "비교 불가" 명시.
  if (bestDistractor === -Infinity) return Infinity;
  return bestAnswer - bestDistractor;
}
