/**
 * memory/eval/answer-map.ts — eval-queries 사용자 라벨(줄번호)을 그룹 구조
 * 정답으로 변환 + corpus 적재 시 줄 → 노드 id 매핑.
 *
 * OR/AND 분류는 사용자 라벨 의미를 보존하는 명시 표(추론 X). 새 정답 체계를
 * 처음부터 작성하지 않는다 — 기존 라벨이 출발점(상위 spec 단락 5.8.3).
 */
import { EVAL_QUERIES, type EvalQuery } from "../../../test-fixtures/sandbox/eval-queries.ts";
import {
  ENRICHED_QUERIES,
  type EnrichedQuery,
} from "../../../test-fixtures/sandbox/eval-enriched-queries.ts";
import {
  EVAL_QUERIES_EXT,
  type EvalQueryExt,
  type EvalQueryKind,
} from "../../../test-fixtures/sandbox/eval-queries-ext.ts";

/** 질문별 OR/AND 의미. 명시 — answers 줄번호를 그룹 number[][] 로 묶는 규칙. */
export type GroupMode = "or" | "and";

/** Q3·Q5 등 multi-fact 는 'and'(모든 줄 필요), 나머지 'or'(한 줄 충족). */
export const QUERY_GROUP_MODE: Record<string, GroupMode> = {
  Q1: "or",  // 장터 당번 점검일 — 한 점검일이라도 잡으면 충족
  Q2: "or",
  Q3: "and", // 메인 컴퓨터 사양 — GPU+RAM+CPU 세 줄 모두
  Q4: "or",
  Q5: "and", // 형제 관계 — multi-hop, 관련 줄 모두
  Q6: "or",
  Q7: "or",
  Q8: "or",
  Q9: "or",
  Q10: "or",
};

/** answers 평면 줄번호 → 그룹 구조. 'or' = 한 그룹 / 'and' = 줄별 단일 그룹. */
export function toAnswerGroups(q: EvalQuery): number[][] {
  const mode = QUERY_GROUP_MODE[q.id] ?? "or";
  return mode === "and" ? q.answers.map((n) => [n]) : [q.answers.slice()];
}

/** 줄번호(1-based) → 노드 id 로 그룹을 변환. lineToNodeId = 적재가 돌려준 매핑. */
export function mapGroupsToNodeIds(
  groups: number[][],
  lineToNodeId: ReadonlyMap<number, number>,
): number[][] {
  return groups.map((g) =>
    g.map((line) => {
      const id = lineToNodeId.get(line);
      if (id === undefined) {
        throw new Error(`answer-map: corpus 줄 ${line} 에 매핑된 노드 id 없음`);
      }
      return id;
    }),
  );
}

export { EVAL_QUERIES };

// ── enriched 코퍼스용 매핑(공통 인프라 1.1b T1) ───────────────────────────
//
// flat 쪽은 줄번호(1-based)로 라벨링하지만 enriched 쪽은 노드 key 로 라벨링한다.
// 그래서 두 단계로 옮긴다: (1) key 그룹 구조 만들기 → (2) key→nodeId 적용.
//
// 공통 인프라 1.1c T1 — EQ5(관계 cue graph-hop) / EQ6(polarity 분별)는 별도
// 매핑 표가 필요 없다. groupMode·answerKeys 만으로 toEnrichedAnswerGroups 가
// 그대로 옮긴다(EQ5 = OR 단일 정답 / EQ6 = OR positive 가족). polarity 라벨은
// harness 가 코퍼스 정의에서 직접 읽어 polarity-filter variant 에 적용한다.

/** answerKeys 를 그룹 구조로. 'or' = 한 그룹 / 'and' = 키별 단일 그룹. */
export function toEnrichedAnswerGroups(q: EnrichedQuery): string[][] {
  return q.groupMode === "and"
    ? q.answerKeys.map((k) => [k])
    : [q.answerKeys.slice()];
}

/**
 * key 그룹 → 노드 id 그룹. keyToNodeId = enriched 적재가 돌려준 매핑.
 * 미존재 key 는 구체 에러를 던진다(silent skip 금지 — corpus 와 질문 셋의
 * 어긋남을 즉시 드러낸다).
 */
export function mapKeyGroupsToNodeIds(
  groups: string[][],
  keyToNodeId: ReadonlyMap<string, number>,
): number[][] {
  return groups.map((g) =>
    g.map((key) => {
      const id = keyToNodeId.get(key);
      if (id === undefined) {
        throw new Error(
          `answer-map: enriched 노드 key "${key}" 에 매핑된 노드 id 없음`,
        );
      }
      return id;
    }),
  );
}

export { ENRICHED_QUERIES };

// ── 확장 손 정답 셋 매핑 (T2 / spec 5-1) ──────────────────────────────────
//
// 기존 Q1~Q10(EVAL_QUERIES + embedding-corpus.txt)은 동결이라 손대지 않는다 —
// 여러 회귀 테스트가 그 수치를 기준선으로 쓰고 있다. 확장분은 별도 코퍼스
// (embedding-corpus-ext.txt) + 별도 질문 셋으로 나란히 두고, 여기서는 줄번호
// 그룹을 노드 id 그룹으로 옮기는 통로만 더한다.
//
// flat 쪽 toAnswerGroups 와 달리 변환이 필요 없다 — EvalQueryExt 는 그룹 구조를
// 이미 명시로 들고 있다(한 문항 안에 OR·AND 가 섞이는 경우를 적을 수 있어야 해서).

/**
 * 확장 문항의 줄번호 그룹 → 노드 id 그룹. mapGroupsToNodeIds 를 그대로 쓰되,
 * 정답 0개(unanswerable) 문항은 빈 배열이 그대로 통과한다 — 빈 그룹은 metric
 * 정의상 "측정 대상 없음"이지 "회수 실패"가 아니다.
 */
export function toExtAnswerGroups(
  q: EvalQueryExt,
  lineToNodeId: ReadonlyMap<number, number>,
): number[][] {
  return mapGroupsToNodeIds(q.groups, lineToNodeId);
}

export { EVAL_QUERIES_EXT };
export type { EvalQueryExt, EvalQueryKind };
