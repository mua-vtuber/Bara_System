/**
 * test-fixtures/sandbox/eval-enriched-queries.ts — enriched 코퍼스 전용 질문 셋
 * (공통 인프라 1.1b T1).
 *
 * flat eval-queries.ts 가 줄번호(1-based)로 정답을 라벨링하는 것과 달리, 여기
 * answerKeys 는 enriched-corpus.ts 의 노드 key 를 가리킨다(줄번호 아님). harness
 * 가 적재 시 key→nodeId 매핑을 돌려주므로, answer-map 이 key 그룹을 노드 id 로
 * 옮긴다.
 *
 * 여섯 측정 갈래를 덮는다(DCL-2 — distractor 가 vector 를 일부러 틀리게 함):
 *  - EQ1: 그래프 2-hop 으로만 도달(muryo) — 그래프 채널 순기여 측정.
 *         muryo 는 텍스트·벡터·개념 직접 매칭을 모두 비워, jjk_intro→gojo→muryo
 *         BFS 로만 도달. no-graph 면 muryo 미회수 → 그래프 델타가 양수로 보임.
 *  - EQ2: 개념(#주술회전) 매칭이 답을 보태는 query — 개념 채널 순기여 측정.
 *         query 어휘를 약하게 두어 vector 단독으론 다른 만화 distractor 에 밀리고,
 *         개념 채널이 #주술회전 노드를 끌어올린다.
 *  - EQ3: synonym 어휘(포근 vs 따뜻) — T2 동의어 확장 측정. distractor 디자인
 *         문장들이 vector 를 흔들어, 동의어 확장 전엔 design_warm 이 안 1등.
 *  - EQ4: project 어휘(bara_system) — T3 프로젝트 가르마 측정. 정답은 bara_cleanup
 *         한쪽만. nest_cleanup 은 의도된 distractor(T3 가 demote). T1 baseline 에선
 *         EQ4 가 불완전한 게 정상 — 그게 T3 가 메울 틈이다(DCL-2).
 *  - EQ5: 관계 cue + graph-hop 정답(공통 인프라 1.1c T1). theme_reason 은 query
 *         토큰을 비워 vector·fts·개념으로 직접 안 닿고 theme_change→theme_reason
 *         BFS 로만 도달. graph 가중치 중립(cue-off)이면 좁은 창 밖에 머물러
 *         recall < 1.0 → cue-on(관계 cue 가 graph boost 를 올림)이 창 안으로 끌어올림.
 *  - EQ6: polarity 분별(공통 인프라 1.1c T1). 같은 주제(디자인 선호) 다른 polarity.
 *         polarity=positive 필터가 positive 가족(design_warm·design_cozy)만 회수하고
 *         negative(design_game_dislike)·neutral(design_plain_neutral)을 거른다.
 */

/** enriched 질문 한 줄. answerKeys 는 enriched-corpus 노드 key. */
export interface EnrichedQuery {
  id: string;
  query: string;
  answerKeys: string[];
  groupMode: "or" | "and";
  /** T3 측정용 — 질문이 겨냥한 프로젝트 어휘(선택). */
  project?: string;
  /**
   * 공통 인프라 1.1c T1 — polarity 필터 측정용. 지정 시 polarity-filter variant 가
   * 이 polarity 라벨 노드만 후보로 남긴다(EQ6). 미지정 = 필터 미적용.
   */
  polarity?: "positive" | "negative" | "neutral";
}

export const ENRICHED_QUERIES: EnrichedQuery[] = [
  // EQ1 — muryo 는 그래프 2-hop(jjk_intro→gojo→muryo)으로만 도달하도록 설계.
  // query 에 muryo content 의 기술명 토큰(무량공처 등)을 일부러 비워 직접 매칭을
  // 막고, 그래프 체인이 끊긴 no-graph 에선 muryo 회수 강도가 떨어지게 한다.
  { id: "EQ1", query: "주술회전 최강자의 필살기 이름", answerKeys: ["muryo"], groupMode: "or" },
  // EQ2 — 개념 채널이 답을 보태는 query(실측 선정). "주문과 저주" 어휘는
  // jjk_intro·gojo content 와 직접 안 겹쳐 vector·fts 가 distractor 만화(나루토
  // 등)에 밀린다. 개념 #주술회전 태그가 jjk_intro 를 한정 limit 안으로 끌어올려
  // recall 이 오른다(no-concept 1/2 → +concept 2/2, limit 5 기준 / DCL-2).
  { id: "EQ2", query: "주문과 저주를 쓰는 인물", answerKeys: ["jjk_intro", "gojo"], groupMode: "or" },
  // EQ3 — "포근한" 은 "따뜻한" 의 동의어. T2 동의어 확장 격리 측정(DCL-4).
  // query 를 직접 겹침 토큰 없이 "포근한 느낌" 으로 둔다: design_warm content
  // ("따뜻한 색감의 디자인")에 "포근한"·"느낌" 둘 다 없으므로 동의어 확장 전엔
  // fts-only recall=0, "따뜻한" 동의어가 합류하면 recall=1 — synonym 단독 효과를
  // fts-only 채널로 격리 측정한다. 옛 "포근한 색감 디자인" 은 "색감"·"디자인" 이
  // content 와 직접 겹쳐 확장 전에도 recall=1 이라 효과가 격리 안 됐다(DCL-4 조정).
  { id: "EQ3", query: "포근한 느낌", answerKeys: ["design_warm"], groupMode: "or" },
  // EQ4 — project 필터(T3) 도입 전 기준선. 정답은 bara_cleanup 한쪽만.
  // nest_cleanup 은 의도된 distractor(프로젝트가 다름 — T3 가 demote 대상).
  // T1 에서 EQ4 가 불완전한 게 정상이다 — 그게 T3 가 메울 틈(DCL-2).
  { id: "EQ4", query: "cleanup 작업", answerKeys: ["bara_cleanup"], groupMode: "or", project: "bara_system" },
  // EQ5 — 관계 cue + graph-hop(공통 인프라 1.1c T1). 정답 theme_reason 은
  // theme_change→theme_reason 1-hop 으로만 도달. query 는 "왜·바꿨·테마" 관계 cue
  // 어휘를 담아 theme_change(seed)를 직접 잡지만 theme_reason 은 직접 안 잡는다.
  // cue-off(graph 중립)면 좁은 창 밖 → recall < 1.0 / cue-on 이 창 안으로 끌어올림.
  { id: "EQ5", query: "그 테마로 왜 바꿨더라", answerKeys: ["theme_reason"], groupMode: "or" },
  // EQ6 — polarity 분별(공통 인프라 1.1c T1). polarity=positive 필터가 positive
  // 가족만 남긴다. 정답 그룹은 OR — design_warm·design_cozy 중 한쪽이라도 잡으면
  // 충족(둘 다 positive). polarity-filter variant 가 negative·neutral 을 거른다.
  {
    id: "EQ6",
    query: "포근한 디자인 선호 가족",
    answerKeys: ["design_warm", "design_cozy"],
    groupMode: "or",
    polarity: "positive",
  },
];
