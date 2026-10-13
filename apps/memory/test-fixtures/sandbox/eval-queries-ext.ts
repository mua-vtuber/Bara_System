/**
 * test-fixtures/sandbox/eval-queries-ext.ts — 손 정답 확장 질문 셋 (T2, spec 5-1).
 *
 * 기존 eval-queries.ts(Q1~Q10 / embedding-corpus.txt)는 *동결*이다. 여러 회귀
 * 테스트가 그 10문항의 실측 수치(flat full-rrf nDCG 0.8882 floor 등)를 기준선으로
 * 삼고 있어서, 거기에 문항을 더하면 기준선이 통째로 흔들린다. 그래서 확장분은
 * 별도 코퍼스(embedding-corpus-ext.txt) + 별도 질문 셋으로 나란히 둔다.
 *
 * 정답 그룹 의미는 기존과 동일하다 — 그룹 하나 = OR(그룹 안 한 줄만 잡으면 충족),
 * 그룹끼리 = AND(모든 그룹이 충족돼야 완전). `groups` 를 직접 적는 이유는 확장분에
 * OR·AND 가 한 문항 안에 섞인 경우(예: EX7 = (회 또는 초밥) 그리고 매운 음식)가
 * 있어서다. 평면 answers + 문항별 단일 mode 로는 그 의미를 못 적는다.
 *
 * kind 는 파이프라인이 실제로 감당해야 하는 질의 성질 분류다. 어느 한 성질에
 * 문항이 쏠리면 baseline 평균이 그 성질만 대변하게 되므로, 분포 자체를 테스트가
 * 검사한다(eval-queries-ext.test.ts).
 */

/** 질의 성질 — baseline 이 한 성질에 쏠리지 않도록 분포를 강제한다. */
export type EvalQueryKind =
  /** 코퍼스 표현과 글자가 겹치는 직접 조회. */
  | "exact-keyword"
  /** 정답 줄과 공유 키워드가 없는 의미 환언 — 벡터 채널 몫. */
  | "semantic-paraphrase"
  /** 특정 대상(사람·기기·프로젝트)에 걸린 사실 회수. */
  | "entity-centric"
  /** 날짜·주기 등 시간 표현 조회. */
  | "temporal"
  /** 선호·결정·태도 회수. */
  | "preference-decision"
  /** 한글-영문 기술 용어 혼용. */
  | "mixed-script-technical"
  /** 코퍼스에 답이 없는 질의 — 0건 정직성 확인용(정답 그룹 0개). */
  | "unanswerable";

export interface EvalQueryExt {
  id: string;
  query: string;
  /**
   * 정답 그룹 — 1-based 줄번호(embedding-corpus-ext.txt).
   * 빈 배열 = 코퍼스에 답 없음(unanswerable). 빈 배열은 metric 정의상 0점이며,
   * 이는 "회수 실패"가 아니라 "측정 대상 없음"이다. baseline 평균에서 이 문항들을
   * 빼고 재는 이유가 그것이다(harness-ext.ts 참조).
   */
  groups: number[][];
  kind: EvalQueryKind;
}

export const EVAL_QUERIES_EXT: EvalQueryExt[] = [
  // ── exact-keyword: 코퍼스 표현과 글자가 겹치는 직접 조회 ──────────────
  {
    id: "EX1",
    query: "회사 워크스테이션 그래픽카드",
    groups: [[1]],
    kind: "exact-keyword",
  },
  {
    id: "EX2",
    query: "의자는 시디즈 T50",
    groups: [[8]],
    kind: "exact-keyword",
  },
  {
    id: "EX3",
    query: "버티컬 마우스",
    groups: [[7]],
    kind: "exact-keyword",
  },
  {
    id: "EX4",
    query: "월세 이체일",
    groups: [[17]],
    kind: "exact-keyword",
  },
  {
    id: "EX5",
    query: "온라인 드로잉 스터디",
    groups: [[18]],
    kind: "exact-keyword",
  },
  {
    id: "EX6",
    query: "인공눈물",
    groups: [[56]],
    kind: "exact-keyword",
  },

  // ── semantic-paraphrase: 정답 줄과 공유 키워드 없는 환언 ──────────────
  {
    id: "EX7",
    query: "혀가 얼얼한 걸 잘 못 견딘다",
    groups: [[44]],
    kind: "semantic-paraphrase",
  },
  {
    id: "EX8",
    query: "밤늦게까지 안 자고 깨어있는 편",
    groups: [[49]],
    kind: "semantic-paraphrase",
  },
  {
    id: "EX9",
    query: "초면에 가벼운 잡담을 이어가기 힘들다",
    groups: [[83]],
    kind: "semantic-paraphrase",
  },
  {
    id: "EX10",
    query: "무서운 장르는 피한다",
    groups: [[60]],
    kind: "semantic-paraphrase",
  },
  {
    id: "EX11",
    query: "돈을 안전하게만 굴린다",
    groups: [[85], [86]],
    kind: "semantic-paraphrase",
  },
  {
    id: "EX12",
    query: "예전보다 몸이 쉽게 지친다고 느낀 순간",
    groups: [[54]],
    kind: "semantic-paraphrase",
  },
  {
    id: "EX13",
    query: "동행 없이 떠나는 쪽이 마음이 놓인다",
    groups: [[75]],
    kind: "semantic-paraphrase",
  },

  // ── entity-centric: 특정 대상에 걸린 사실 회수 ─────────────────────────
  {
    id: "EX14",
    query: "맥북 에어 어떻게 쓰고 있어?",
    groups: [[3, 4]],
    kind: "entity-centric",
  },
  {
    id: "EX15",
    query: "회사 워크스테이션 사양",
    groups: [[1], [2]],
    kind: "entity-centric",
  },
  {
    id: "EX16",
    query: "뺑덕 할멈은 어떻게 지내셔?",
    groups: [[78]],
    kind: "entity-centric",
  },
  {
    id: "EX17",
    query: "심봉사 영감 취미",
    groups: [[77]],
    kind: "entity-centric",
  },
  {
    id: "EX18",
    query: "스위치 게임기",
    groups: [[67]],
    kind: "entity-centric",
  },
  {
    id: "EX19",
    query: "장작 납품 진행 경과",
    groups: [[10], [11], [12]],
    kind: "entity-centric",
  },

  // ── temporal: 날짜·주기 조회 ────────────────────────────────────────────
  {
    id: "EX20",
    query: "2026년 4월에 있는 일정",
    groups: [[12, 13]],
    kind: "temporal",
  },
  {
    id: "EX21",
    query: "자동차 보험 만료일이 언제야?",
    groups: [[14]],
    kind: "temporal",
  },
  {
    id: "EX22",
    query: "향단이네 막내 돌잔치 날짜",
    groups: [[16]],
    kind: "temporal",
  },
  {
    id: "EX23",
    query: "매주 반복되는 일정",
    groups: [[18]],
    kind: "temporal",
  },
  {
    id: "EX24",
    query: "헬스장 언제부터 시작해?",
    groups: [[15]],
    kind: "temporal",
  },
  {
    id: "EX25",
    query: "치과 예약 잡힌 날",
    groups: [[13]],
    kind: "temporal",
  },
  {
    id: "EX26",
    query: "장작 잔금 받은 시점",
    groups: [[12]],
    kind: "temporal",
  },

  // ── preference-decision: 선호·결정·태도 ────────────────────────────────
  {
    id: "EX27",
    query: "커피 얼마나 마셔?",
    groups: [[39]],
    kind: "preference-decision",
  },
  {
    id: "EX28",
    query: "빵이랑 밥 중에 뭘 더 좋아해?",
    groups: [[46]],
    kind: "preference-decision",
  },
  {
    id: "EX29",
    query: "커밋 메시지 작성 방침",
    groups: [[24]],
    kind: "preference-decision",
  },
  {
    id: "EX30",
    query: "브랜치 전략 어떻게 하기로 했지?",
    groups: [[23]],
    kind: "preference-decision",
  },
  {
    id: "EX31",
    query: "작업할 때 듣는 음악 취향",
    groups: [[64]],
    kind: "preference-decision",
  },
  {
    id: "EX32",
    query: "여행 숙소 고르는 기준",
    groups: [[71]],
    kind: "preference-decision",
  },
  {
    id: "EX33",
    query: "회식 참석 원칙",
    groups: [[84]],
    kind: "preference-decision",
  },
  {
    id: "EX34",
    query: "그림 그릴 때 쓰는 툴 선호",
    groups: [[34]],
    kind: "preference-decision",
  },

  // ── mixed-script-technical: 한글-영문 기술 용어 혼용 ───────────────────
  {
    id: "EX35",
    query: "Live2D 파라미터 작업 숙련도",
    groups: [[31]],
    kind: "mixed-script-technical",
  },
  {
    id: "EX36",
    query: "WSL 리눅스 사용 방식",
    groups: [[27]],
    kind: "mixed-script-technical",
  },
  {
    id: "EX37",
    query: "SQLite 데이터베이스 경험",
    groups: [[29]],
    kind: "mixed-script-technical",
  },
  {
    id: "EX38",
    query: "TypeScript 주력 언어인가?",
    groups: [[21]],
    kind: "mixed-script-technical",
  },
  {
    id: "EX39",
    query: "RTX 3060 12GB 어느 장비?",
    groups: [[1]],
    kind: "mixed-script-technical",
  },

  // ── unanswerable: 코퍼스에 답 없음 — 0건 정직성 ────────────────────────
  {
    id: "EX40",
    query: "내 여권 번호가 뭐야?",
    groups: [],
    kind: "unanswerable",
  },
  {
    id: "EX41",
    query: "작년 겨울에 스키장 어디로 갔었지?",
    groups: [],
    kind: "unanswerable",
  },
  {
    id: "EX42",
    query: "내가 다니는 회사 대표 이름",
    groups: [],
    kind: "unanswerable",
  },
];
