/**
 * test-fixtures/sandbox/lexical-queries.ts — 글자(lexical) 정답 코퍼스 전용 질의
 * 셋 (일치성 검색 재설계 S1).
 *
 * 기존 eval-queries.ts(flat)·eval-enriched-queries.ts(enriched)는 *의미 정답*
 * 코퍼스다 — 질의도 문장이고 정답도 뜻으로 라벨링된다. 이 파일은 정답이 "글자
 * 포함(정확 일치)"으로 정의되는 별개 코퍼스다: 고유명사·긴 문장 속 희귀 토큰·
 * 2글자 이름·흔한 토큰(회귀 방지)·신조어·오탈자 가드 6 케이스.
 *
 * answers 는 lexical-corpus.txt 의 1-based 줄번호(사용자·설계 직접 라벨 — 추론 0).
 * harness 가 적재 시 줄→nodeId 매핑을 돌려주므로, 채점 코드가 줄번호를 노드 id 로
 * 옮긴다(flat answer-map.ts 패턴 답습).
 *
 * imageCaption 이 있는 케이스는 그 캡션 글을 담은 image_asset 노드를 코퍼스에 함께
 * 적재한다(설계 섹션 3 — 캡션은 이미 kn_fts_insert 로 FTS 색인되는 통로라 글 노드와
 * 같은 lexical 신호를 받는다). "글 또는 그림 둘 다 일치"를 측정하기 위한 데이터
 * fixture 이며 mock 객체가 아니다.
 */

/** 글자 정답 질의 한 줄. answers 는 lexical-corpus.txt 줄번호(1-based). */
export interface LexicalQuery {
  id: string;
  query: string;
  /** 1-based line numbers in lexical-corpus.txt (정확-일치 정답 줄). */
  answers: number[];
  /** OR = 한 줄이라도 상위면 충족 / AND = 모든 줄 필요. 대개 or. */
  groupMode: "or" | "and";
  /**
   * 케이스 성격 라벨 — 측정 표에서 케이스별 nDCG 를 성격과 함께 보이기 위한 것.
   *  - proper-noun     : 고유명사 정확일치(케이스 1)
   *  - rare-in-sentence: 긴 문장 속 희귀 토큰(케이스 2 — 곡선이 놓치는 케이스)
   *  - two-char        : 2글자 이름(케이스 3 — 회수 pool 진입 여부가 관건)
   *  - common-only     : 흔한 토큰만(케이스 4 — w=0 회귀 불변 증명)
   *  - neologism       : 신조어(케이스 5 — IDF 최대)
   *  - typo-guard      : 오탈자(케이스 6 — 회수 0 이라 순위 영향 없음)
   */
  kind:
    | "proper-noun"
    | "rare-in-sentence"
    | "two-char"
    | "common-only"
    | "neologism"
    | "typo-guard";
  /**
   * 이 케이스에 함께 적재할 image_asset 캡션 글(선택). 지정 시 harness 가 캡션을
   * content 로 하는 image_asset 노드를 추가하고, 그 노드 id 를 imageNodeId 로
   * 돌려준다. 캡션에 질의의 희귀 토큰이 들어 있어 "그림도 글자 일치로 상위에
   * 오르는가"를 측정한다(설계 섹션 3 — 캡션 FTS 통로).
   */
  imageCaption?: string;
  /**
   * typo-guard 케이스 전용 — 이 토큰이 코퍼스 어디에도 없어야 함을 harness 가
   * 교차 확인한다(오탈자 max-IDF 과반응이 실제 순위 해를 안 끼침을 격리). 미지정
   * 케이스는 검사 안 함.
   */
  absentToken?: string;
}

export const LEXICAL_QUERIES: LexicalQuery[] = [
  // 케이스 1 — 고유명사 정확일치. "노란후드" 정확 포함 줄(1·4·19)이 정답이고,
  // 뜻만 비슷한 "노란 옷을 입은 인물"(줄2)은 하위여야 한다. "노란후드"는 희귀
  // 토큰이라 IDF 가중이 정확일치를 위로 올린다. 이미지도 캡션에 "노란후드"가
  // 있으면 같은 lexical 신호를 받는다.
  {
    id: "LX1",
    query: "노란후드",
    answers: [1, 4, 19],
    groupMode: "or",
    kind: "proper-noun",
    imageCaption: "노란후드 캐릭터 일러스트 이미지 자산",
  },
  // 케이스 2 — 긴 문장 속 희귀 토큰. 질의가 문장이지만 "노란후드"가 희귀해서
  // lexical 가중이 붙어야 한다(곡선 spec 이 어절 수 프록시로 놓치던 핵심 케이스).
  // 정답 줄4 는 "노란후드"를 그대로 담은 회상 문장. 줄10("왜 그때 그 결정을")은
  // "그때" 를 공유하는 distractor.
  {
    id: "LX2",
    query: "그때 노란후드 입은 애가 누구였지",
    answers: [4],
    groupMode: "or",
    kind: "rare-in-sentence",
    imageCaption: "그때 찍은 노란후드 입은 사람 사진",
  },
  // 케이스 3 — 2글자 이름. "바라"는 글 FTS(knowledge_nodes_fts)가 unicode61 이라
  // 잡을 수 있다(entity FTS 의 trigram 2글자 한계는 S5 가 별도 해소). 단 코퍼스
  // 줄6 은 "바라는"(조사 포함)이라 unicode61 term 은 "바라는" 이다 — sanitizeFtsQuery
  // 의 prefix * 가 조사를 흡수해 회수한다. harness 가 이 케이스의 회수 pool 진입을
  // 먼저 확인한다(회수 0 이면 lexical 아닌 회수 문제로 분리 기록 — 설계 회수 경계).
  {
    id: "LX3",
    query: "바라",
    answers: [6],
    groupMode: "or",
    kind: "two-char",
  },
  // 케이스 4 — 흔한 토큰만(회귀 방지). 질의의 모든 토큰이 코퍼스에 흔하게 등장해
  // 희귀 토큰이 없다 → rarity 낮음 → w=0 → 현행(의미 검색만)과 동일. 정답 줄10 은
  // 의미로 맞는 줄. 이 케이스의 nDCG 가 wMax=0 과 wMax>0 에서 같아야(구조적 불변)
  // "글자 가중이 의미 코퍼스를 안 건드림"이 증명된다.
  {
    id: "LX4",
    query: "왜 그때 그 결정을 했지",
    answers: [10],
    groupMode: "or",
    kind: "common-only",
  },
  // 케이스 5 — 신조어. "푹신쿠션"은 코퍼스에 딱 한 번(줄13) 등장하는 조어라 IDF
  // 최대 — 정확일치가 최우선으로 올라와야 한다.
  {
    id: "LX5",
    query: "푹신쿠션",
    answers: [13],
    groupMode: "or",
    kind: "neologism",
  },
  // 케이스 6 — 오탈자 가드(반대 케이스). "노란훗드"는 코퍼스 어디에도 없다 →
  // fts 회수 0 → 순위에 영향 없음(max IDF 가 존재하지 않는 term 에 최대값을 줘도
  // 회수 pool 이 비어 실제 해가 없음을 격리). harness 가 회수 0 을 단언한다.
  {
    id: "LX6",
    query: "노란훗드",
    answers: [],
    groupMode: "or",
    kind: "typo-guard",
    absentToken: "노란훗드",
  },
];
