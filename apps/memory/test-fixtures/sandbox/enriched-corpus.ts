/**
 * test-fixtures/sandbox/enriched-corpus.ts — 그래프·개념 채널 측정용 결정적
 * 구조화 코퍼스(공통 인프라 1.1b T1 / DCL-2).
 *
 * flat corpus(embedding-corpus.txt)는 노드만 있고 엣지·개념이 0이라 그래프·
 * 개념 채널의 순효과를 못 잰다. 이 코퍼스는 자산 노드 + #태그 개념 + node↔node
 * 엣지를 함께 정의해, harness 가 그래프 도달과 개념 매칭 기여를 분리 측정한다.
 *
 * DCL-2 — 분별력 확보: 의미 있는 핵심 노드 + 정답과 의미상 가깝지만 오답인
 * distractor 노드를 함께 둔다. distractor 가 vector 검색을 일부러 일부 틀리게
 * 만들어(vector-only avgNdcg < 1.0), 그래프·개념·동의어 채널이 메울 틈을 낸다.
 * distractor 가 없으면 9노드 코퍼스에서 vector 가 전부 회수해 모든 채널이 1.0 →
 * 측정 토대가 무의미해진다(DCL-2 결정 근거).
 *
 * 이건 mock 이 아니라 순수 데이터 fixture 다(CLAUDE.md "데이터 fixture는 허용").
 * 인터페이스 가짜 구현체(MockStore 류)는 만들지 않는다 — 실제 store 에 이 데이터를
 * 적재해 실제 retriever 로 측정한다.
 *
 * LLM 호출 0 / 외부 의존 0 / 임의 난수 0 — 같은 입력이면 항상 같은 그래프.
 */

/** 자산 노드 한 줄. key 는 질문 answerKeys 와 엣지 source/target 가 참조한다. */
export interface EnrichedNode {
  key: string;
  content: string;
  projectId?: string;
  tags?: string[];
  /**
   * D7 polarity 라벨(공통 인프라 1.1c T1). 미지정 = NULL(라벨 없음). EQ6 polarity
   * 필터가 이 값으로 후보를 거른다 — positive 만 회수 / negative·neutral·NULL 제외.
   */
  polarity?: "positive" | "negative" | "neutral";
}

/**
 * node↔node 엣지 한 줄. relation 은 1.0b 이후 실제 EdgeRelation 으로 한정한다.
 *
 * DCL-1: 1.0b 분리 후 mentions 는 PersonRelation(사람 엣지), parent_of 는
 * ConceptEdgeRelation(개념↔개념 엣지)으로 옮겨 갔다. node↔node knowledge_edges
 * 가 가질 수 있는 값은 related_to / links_to / supersedes / merged_into /
 * contradicts 뿐이다. 그래프 채널(graph) BFS 는 knowledge_edges 만 따라가므로,
 * 측정 토대인 이 코퍼스의 노드 연결은 related_to / supersedes 로 표현한다.
 */
export interface EnrichedEdge {
  source: string;
  target: string;
  relation: "related_to" | "links_to" | "supersedes";
  weight: number;
}

/**
 * 핵심 노드(정답 후보) + distractor(의미상 가깝지만 오답). key 접두 cor_ = 핵심,
 * dst_ = distractor 로 읽기 쉽게 구분했다(질문 answerKeys 는 핵심 key 만 가리킴).
 *
 * EQ1 그래프 델타 설계: muryo content 는 "무량공처" 위주로 두고 "주술회전"·
 * "필살기"·"기술" 같은 query 근접 어휘와 #주술회전 태그를 모두 비웠다. 그래야
 * query "주술회전 최강자의 필살기 이름" 이 muryo 에 텍스트·벡터·개념으로 직접
 * 안 닿고, jjk_intro→gojo→muryo 2-hop BFS 로만 도달된다(no-graph 면 muryo 미회수).
 */
export const ENRICHED_NODES: EnrichedNode[] = [
  // ── 핵심: 주술회전 그래프 체인 ──────────────────────────────────────
  { key: "jjk_intro", content: "주술회전은 내가 가장 좋아하는 만화다", tags: ["만화", "주술회전"] },
  { key: "gojo", content: "고죠 사토루는 주술회전의 최강 주술사", tags: ["주술회전"] },
  // muryo — 주술회전/필살기 토큰·태그 비움. 그래프 2-hop 으로만 도달되게.
  { key: "muryo", content: "무량공처라는 무한의 결계로 상대를 완전히 가둔다" },

  // ── 핵심: 만화(개념 #만화) ─────────────────────────────────────────
  { key: "onepiece", content: "원피스도 오래 본 만화 시리즈", tags: ["만화", "원피스"] },

  // ── 핵심: 디자인 취향(동의어 측정 + polarity 측정) ───────────────────
  // design_warm 은 EQ3(동의어) 정답이자 EQ6(polarity) positive 가족의 한 노드다.
  // polarity 라벨은 content·tag 와 독립이라 EQ3 동의어 측정에 영향이 없다.
  { key: "design_warm", content: "따뜻한 색감의 디자인을 선호한다", tags: ["디자인"], polarity: "positive" },

  // ── 핵심: polarity 분별 가족(공통 인프라 1.1c T1 / EQ6) ────────────────
  // 같은 주제(디자인 선호) · 다른 polarity. positive 두 노드(선호 가족) +
  // negative 한 노드 + neutral 한 노드. EQ6 polarity=positive 필터가 positive
  // 두 노드만 회수하고 negative·neutral 을 거른다(분별력 측정 토대).
  { key: "design_cozy", content: "포근하고 아늑한 톤의 화면 배색을 가장 좋아한다", tags: ["디자인"], polarity: "positive" },
  { key: "design_game_dislike", content: "게임처럼 화려하고 요란한 디자인은 별로 안 좋아한다", tags: ["디자인"], polarity: "negative" },
  { key: "design_plain_neutral", content: "기본 흰 배경 디자인은 그냥 무난하다고 느낀다", tags: ["디자인"], polarity: "neutral" },

  // ── 핵심: cleanup(프로젝트 가르마 — EQ4 / T3 가 메울 틈) ─────────────
  { key: "bara_cleanup", content: "cleanup 으로 메모리 정리 AI 를 돌렸다", projectId: "bara_system", tags: ["바라"] },

  // ── 핵심: CPU supersedes 체인 ──────────────────────────────────────
  { key: "cpu_old", content: "예전 메인 컴퓨터 CPU 는 라이젠 5600X 였다" },
  { key: "cpu_new", content: "지금 메인 컴퓨터 CPU 는 라이젠 9 7950X3D" },

  // ── 핵심: 관계 cue graph-hop 체인(공통 인프라 1.1c T1 / EQ5) ───────────
  // muryo 2-hop 패턴 재활용(DCL-1). theme_change 는 query 어휘("테마"·"바꿨")를
  // 담아 vector·fts 로 직접 잡히는 seed 다. theme_reason 은 *변경 이유* 를 담되
  // query 토큰(왜·테마·바꿨·디자인)을 모두 비워, vector·fts·개념으로 직접 안
  // 닿고 theme_change→theme_reason 1-hop BFS 로만 도달된다. graph 채널 가중치가
  // 중립(cue-off)이면 theme_reason 이 retrieval 창 밖에 머물러 recall < 1.0 →
  // cue-on(관계 cue 가 graph boost 를 올림)이 창 안으로 끌어올린다(측정 틈).
  { key: "theme_change", content: "메인 작업 테마를 새 배색으로 교체했다" },
  { key: "theme_reason", content: "오래 들여다봐도 눈이 덜 시린 차분한 색이 필요했기 때문이다" },

  // ── distractor: EQ4 프로젝트 혼동(T3 가 demote 할 대상) ──────────────
  // nest_cleanup 은 bara_cleanup 과 의미상 거의 동일("cleanup")하지만 프로젝트가
  // 다르다. T1 baseline 에선 EQ4 가 이걸 못 가려 불완전한 게 정상(T3 측정 틈).
  { key: "nest_cleanup", content: "cleanup 작업으로 캐릭터 관계 그래프를 정리했다", projectId: "nest", tags: ["둥지"] },

  // ── distractor: 다른 만화(EQ1·EQ2 vector 혼동 유발 / #만화 아님 또는 다른 태그) ─
  { key: "dst_naruto", content: "나루토는 닌자들이 싸우는 액션 만화 시리즈", tags: ["만화", "나루토"] },
  { key: "dst_bleach", content: "블리치는 사신과 호로가 싸우는 만화", tags: ["만화", "블리치"] },
  { key: "dst_chainsaw", content: "체인소맨은 악마와 계약한 주인공의 만화", tags: ["만화", "체인소맨"] },
  { key: "dst_naruto_tech", content: "나선환은 나루토가 쓰는 회전 차크라 기술", tags: ["나루토"] },
  { key: "dst_bleach_tech", content: "반카이는 블리치 사신이 펼치는 최종 해방 능력", tags: ["블리치"] },
  { key: "dst_hero", content: "히로아카는 개성을 가진 히어로 지망생들의 만화", tags: ["만화", "히로아카"] },

  // ── distractor: 다른 디자인 취향(EQ3 vector 혼동 유발) ────────────────
  { key: "dst_design_cool", content: "차가운 톤의 미니멀 디자인도 종종 끌린다", tags: ["디자인"] },
  { key: "dst_design_dark", content: "어두운 다크모드 배색을 작업할 때 자주 쓴다", tags: ["디자인"] },
  { key: "dst_design_retro", content: "레트로 픽셀 감성의 폰트를 모으는 취미가 있다", tags: ["디자인"] },

  // ── distractor: 다른 CPU·GPU 사양(EQ vector 혼동 / supersedes 체인 분리) ─
  { key: "dst_cpu_laptop", content: "노트북 CPU 는 인텔 코어 i7 13세대를 쓴다" },
  { key: "dst_cpu_server", content: "홈서버 CPU 는 라이젠 5700G 로 맞췄다" },
  { key: "dst_gpu_main", content: "메인 컴퓨터 GPU 는 RTX 4080 SUPER 다" },
  { key: "dst_gpu_old", content: "예전에 쓰던 GPU 는 GTX 1660 Ti 였다" },
  { key: "dst_ram", content: "메인 컴퓨터 램은 DDR5 96GB 로 늘렸다" },

  // ── distractor: 다른 프로젝트 메모(cleanup·정리 어휘 근처) ──────────────
  { key: "dst_proj_backup", content: "둥지 프로젝트는 회의록 자동 백업을 추가했다", projectId: "nest", tags: ["둥지"] },
  { key: "dst_proj_deploy", content: "바라 프로젝트는 A1 서버에 새 빌드를 배포했다", projectId: "bara_system", tags: ["바라"] },
  { key: "dst_proj_index", content: "검색 색인을 다시 만드는 작업을 어제 돌렸다", projectId: "bara_system" },

  // ── distractor: 주제 무관 일상(전 채널 노이즈 바닥) ────────────────────
  { key: "dst_weather", content: "오늘은 날씨가 더워서 에어컨을 종일 틀었다" },
  { key: "dst_food", content: "점심으로 김치찌개를 먹었는데 맛있었다" },
  { key: "dst_walk", content: "저녁에 한강을 따라 가볍게 산책을 했다" },
  { key: "dst_coffee", content: "아침마다 핸드드립으로 원두를 직접 내려 마신다" },
  { key: "dst_book", content: "요즘 자기 전에 추리 소설을 한 챕터씩 읽는다" },
  { key: "dst_music", content: "작업할 때는 가사 없는 로파이 음악을 자주 듣는다" },
  { key: "dst_plant", content: "거실 창가에서 몬스테라 화분을 키우고 있다" },
  { key: "dst_game", content: "주말에는 협동 생존 게임을 친구들과 한다" },
];

/**
 * node↔node 엣지. 무방향 BFS(getConnectedNodes: source_id IN OR target_id IN)
 * 이므로 source/target 방향과 무관하게 양끝에서 탐색된다 — 그래도 의미상
 * 자연스러운 방향으로 적었다.
 *
 * 핵심 그래프 델타: jjk_intro→gojo→muryo 체인이 muryo 를 2-hop 으로 잇는다.
 * muryo 는 텍스트·벡터·개념으로 직접 안 닿게 설계했으므로, 이 엣지가 없으면
 * (no-graph) muryo 가 회수되지 않는다 → 그래프 채널의 순기여가 측정된다.
 */
export const ENRICHED_EDGES: EnrichedEdge[] = [
  // DCL-1: 1.0b 이후 mentions/parent_of 는 node↔node 엣지가 아니므로 related_to 로.
  { source: "jjk_intro", target: "gojo", relation: "related_to", weight: 0.8 },
  { source: "gojo", target: "muryo", relation: "related_to", weight: 0.8 },
  { source: "jjk_intro", target: "onepiece", relation: "related_to", weight: 0.5 },
  { source: "cpu_new", target: "cpu_old", relation: "supersedes", weight: 1.0 },
  // EQ5 관계 cue graph-hop — theme_reason 은 이 엣지로만 도달된다(muryo 패턴).
  { source: "theme_change", target: "theme_reason", relation: "related_to", weight: 0.8 },
];

// ── 칸·라벨·관계 적재용 엔티티 fixture (감사 H1 / 단계2 T7) ──────────────────
//
// 옛 enriched 코퍼스는 노드 + #태그 + node↔node 엣지만 적재해 7채널 중 칸(전용
// 물리 컬럼)·라벨(has_attribute)·엔티티 관계(entity_relation_edges)를 한 번도 안
// 넣었다(spec §13.1 H1). 아래 fixture 가 그 셋을 실 wiring/저장소로 적재해 동등성
// 측정 토대를 칸·라벨·관계와 함께 세운다. EQ1~EQ6 점수에는 영향이 없다(별 엔티티
// 행이라 기존 답 노드·answerKeys 와 분리) — 칸·라벨·관계가 *적재되는지* 와 그 적재가
// 검색 경로에 닿는 baseline 숫자를 드러내는 게 목표(운영 default·점수식 변경 0).

/** 칸이 채워진(또는 0칸인) 엔티티 행 한 줄 — 전용 물리 컬럼(정렬·필터 가능) 적재용. */
export interface EnrichedEntityRow {
  /**
   * 칸 적재 baseline 을 재는 종류. place·intake·usable 은 전용 칸을 가진다.
   * schedule 은 0칸 종류(2026-06-28 a8a30a3·전용 날짜 칸 제거)라 columns=[] 로만 둔다 —
   * 일정 날짜는 글 event_at 으로 모은다. 유니온에 schedule 을 남기는 건 0칸 행 한 줄
   * (월말 회의)을 그대로 두기 위함이고, 칸을 채우면 loadEnrichedCorpus 가 throw 한다.
   */
  typeName: "schedule" | "place" | "intake" | "usable";
  /** 엔티티 이름(findOrCreate<Type> 키). */
  name: string;
  /** 칸 태그 — `#키:값`(applyEntityAttributes 가 칸 어휘면 전용 컬럼에 채운다). */
  columns: Array<{ key: string; value: string }>;
}

/** 라벨(has_attribute) 한 줄 — 색인 없는 꼬리표. */
export interface EnrichedLabelAttr {
  typeName: "work" | "creature" | "schedule" | "place" | "intake" | "usable";
  name: string;
  /** 라벨 태그 — `#키:값`(라벨 어휘면 has_attribute 개념 엣지로). */
  labels: Array<{ key: string; value: string }>;
}

/** 엔티티 관계(entity_relation_edges) 한 줄 — 작품→사람 created_by 등. */
export interface EnrichedRelation {
  sourceType: "work";
  sourceName: string;
  targetType: "person";
  targetName: string;
  relation: "created_by";
}

/**
 * 칸이 채워진 엔티티 행 — 장소 주소 칸·섭취 유통기한 칸(전용 물리 컬럼).
 * applyEntityAttributes 가 columnLabels(칸 어휘) 키를 전용 컬럼에 채운다(정렬·필터 가능).
 *
 * 일정(schedule)은 전용 칸이 없는 0칸 종류라 칸이 빈 행이다(2026-06-28 a8a30a3·옵션 B).
 * 옛 코퍼스는 schedule 에 `날짜` 칸을 채웠으나, 그 칸은 글 event_at 과 연동 안 돼
 * entity_attributes 에 갇히는 함정이라 registry·yaml 에서 schedule 전용 날짜 칸을 뺐다
 * (spec 2026-06-28-schedule-date-column-removal). 일정 날짜의 정상 통로는 글 event_at
 * 하나(달력 위젯·본문 #날짜: reserved key node_field)다. 그래서 여기 schedule 행은 칸을
 * 안 채우고 columns=[] 로 둔다 — applyEntityAttributes 에 schedule `날짜` 를 넘기면
 * 칸도 라벨도 아니라 정직한 skip 으로 떨어져 loadEnrichedCorpus 가 throw 한다(0칸 정의 정합).
 */
export const ENRICHED_ENTITY_ROWS: EnrichedEntityRow[] = [
  { typeName: "schedule", name: "월말 회의", columns: [] },
  { typeName: "place", name: "강남 사무실", columns: [{ key: "주소", value: "서울시 강남구 테헤란로 1" }] },
  { typeName: "intake", name: "우유", columns: [{ key: "유통기한", value: "2026-07-10" }] },
];

/**
 * 라벨(has_attribute) — 작품 장르 등 색인 없는 꼬리표.
 *
 * 옛 코퍼스는 생물(creature) "보리" 에 `종류:강아지` 라벨을 줬으나, 생물 어휘 정의
 * (concept_type_vocabulary.yaml: attributes [주인]·subcategories [동물,식물,반려동물])
 * 에 `종류` 라벨 키가 없어 applyEntityAttributes 가 칸도 라벨도 아니라 정직한 skip 으로
 * 떨궜다 — loadEnrichedCorpus 가 라벨 적재 불완전으로 throw 했다. 코퍼스를 어휘 정의에
 * 맞춰(안 쓸 라벨 제거) 생물 라벨 행을 뺐다. 제품 어휘·registry 는 무접촉(eval 코퍼스 한정).
 */
export const ENRICHED_LABEL_ATTRS: EnrichedLabelAttr[] = [
  { typeName: "work", name: "데못죽", labels: [{ key: "장르", value: "판타지" }] },
];

/** 엔티티 관계(entity_relation_edges) — 작품→사람 created_by. */
export const ENRICHED_RELATIONS: EnrichedRelation[] = [
  { sourceType: "work", sourceName: "데못죽", targetType: "person", targetName: "아쿠타미", relation: "created_by" },
];
