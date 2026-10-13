export interface EvalQuery {
  id: string;
  query: string;
  /** 1-based line numbers in embedding-corpus.txt (사용자 직접 라벨링) */
  answers: number[];
}

export const EVAL_QUERIES: EvalQuery[] = [
  { id: "Q1", query: "장터 당번 점검일 마감은 언제?", answers: [14, 15, 16, 17, 18, 21, 22] },
  { id: "Q2", query: "디롱이 외형은?", answers: [58] },
  { id: "Q3", query: "내 메인 컴퓨터 사양", answers: [30, 31, 32] },
  { id: "Q4", query: "내가 키우는 식물은?", answers: [38, 39, 40] },
  { id: "Q5", query: "내 형제 관계", answers: [71, 92, 93, 94] },
  { id: "Q6", query: "주로 쓰는 AI 도구", answers: [53] },
  { id: "Q7", query: "인형극 캐릭터 정보", answers: [25, 26, 34, 48, 69] },
  { id: "Q8", query: "내 직업은?", answers: [54, 55] },
  { id: "Q9", query: "내가 좋아하거나 싫어하는 음식", answers: [27, 64, 106, 107] },
  { id: "Q10", query: "히로아카 관련", answers: [98, 101] },
];

export interface QualitativeCase {
  label: string;
  /** 1-based line numbers */
  a: number;
  b: number;
  expectedRelation: "identical" | "very-similar" | "same-entity" | "same-domain" | "unrelated";
}

export const QUALITATIVE_CASES: QualitativeCase[] = [
  { label: "완전 동일 문장 (낯가림이 심하다)", a: 37, b: 46, expectedRelation: "identical" },
  { label: "의미 동일 표현 차이 (스파인 포폴)", a: 29, b: 70, expectedRelation: "very-similar" },
  { label: "같은 entity 직접 연관 (네스트 기획 vs 설명)", a: 11, b: 12, expectedRelation: "very-similar" },
  { label: "같은 entity 다른 fact (디롱이 외형 vs 정체성)", a: 58, b: 59, expectedRelation: "same-entity" },
  { label: "같은 entity 다른 측면 (Bara 정의 vs 어원)", a: 1, b: 5, expectedRelation: "same-entity" },
  { label: "같은 entity 다른 측면 (동글이 인형극 캐릭터 vs 비밀)", a: 25, b: 26, expectedRelation: "same-entity" },
  { label: "같은 entity 다른 측면 (곱창 좋아함 vs 배탈 걱정)", a: 27, b: 64, expectedRelation: "same-entity" },
  { label: "같은 도메인 다른 entity (주 컴 GPU vs 보조 컴 GPU)", a: 30, b: 33, expectedRelation: "same-domain" },
  { label: "같은 시리즈 다른 회차 (점검일 5차 vs 6차)", a: 14, b: 15, expectedRelation: "same-domain" },
  { label: "완전 무관 (4080S vs 날씨 덥다)", a: 30, b: 67, expectedRelation: "unrelated" },
];
