import { test, expect, afterEach } from "bun:test";
import {
  classifyEntityTypeDeterministic, resetClassifierCache,
  koNameOf, typeForIndicatorKey, isTypeIndicatorKey, displayKindName,
  explicitContentTypeName, explicitDisplayKind,
} from "./entity-type-classifier.ts";
import {
  resetConceptTypeVocabularyCache, setEntityTypeOverride,
  type PlacementTypeName,
} from "./concept-type-vocabulary.ts";
import { getEntityTypeMeta } from "../db/store-internal/entity-type-registry.ts";

afterEach(() => { setEntityTypeOverride([]); resetConceptTypeVocabularyCache(); resetClassifierCache(); });

test("1단 명시 태그 — #작품:주술회전 → work (구체 대상·subcategory 없음)", () => {
  const r = classifyEntityTypeDeterministic("#작품:주술회전 재밌었다");
  expect(r.typeName).toBe("work");
  expect(r.subcategory).toBeNull();
  expect(r.source).toBe("explicit");
  expect(r.confidence).toBe(1.0);
});
test("1단 명시 태그 값이 subcategory — #작품:소설 → work + 소설 진입", () => {
  // 파서 통일(방식 ②·결정 4): 값 경계 = 쉼표/줄바꿈/#/줄 끝. 본문을 바로 붙이면
  // 값이 본문까지 통째로 삼키므로 사용자 실데이터 양식대로 쉼표로 본문을 가른다
  // (spec §3.2 — #키:값, 본문). 그러면 값이 "소설" 로 잘려 subcategory 진입이 산다.
  const r = classifyEntityTypeDeterministic("#작품:소설, 한 권 읽음");
  expect(r.typeName).toBe("work");
  expect(r.subcategory).toBe("소설");
  expect(r.source).toBe("explicit");
});
test("1단 분류 진입 키 — #동물:고양이 → creature + 동물 진입", () => {
  const r = classifyEntityTypeDeterministic("#동물:고양이 키운다");
  expect(r.typeName).toBe("creature");
  expect(r.subcategory).toBe("동물");
  expect(r.source).toBe("explicit");
});
test("1단 속성 키(#장르:액션)는 explicit 아님 — 장르는 attributes", () => {
  const r = classifyEntityTypeDeterministic("#장르:액션 좋아");
  expect(r.source).not.toBe("explicit");
});
test("1단 동의어 키 — #작업:내소설 → project", () => {
  const r = classifyEntityTypeDeterministic("#작업:내소설 진행중");
  expect(r.typeName).toBe("project");
  expect(r.subcategory).toBeNull();
  expect(r.source).toBe("explicit");
});
test("1단 영어 동의어 키 — #work:젤다 → work explicit", () => {
  // 키 "work" 가 영어 synonym 으로 1단에 잡히는 경로를 고정한다.
  // 값 "젤다" 는 work seed 이지만 work subcategory 는 아니라 subcategory:null.
  const r = classifyEntityTypeDeterministic("#work:젤다 클리어");
  expect(r.typeName).toBe("work");
  expect(r.source).toBe("explicit");
});
test("2단 subcategory 단어 — 본문 만화 → work + 만화 진입", () => {
  const r = classifyEntityTypeDeterministic("어제 본 만화 정리");
  expect(r.typeName).toBe("work");
  expect(r.subcategory).toBe("만화");
  expect(r.source).toBe("seed");
  expect(r.confidence).toBe(0.9);
});
test("2단 분류 폴더 경계 매칭 — 게임(work 하위갈래) → work", () => {
  // (2026-06-27 단계1 D2) seeds 제거 후 2단은 분류 폴더 단어(subcategories)만 경계 매칭한다.
  // '게임' 은 work 의 하위갈래라 평면 글에서 work 로 자동 배치된다(source 'seed' 라벨).
  const r = classifyEntityTypeDeterministic("게임 프로토타입");
  expect(r.typeName).toBe("work");
  expect(r.subcategory).toBe("게임");
  expect(r.source).toBe("seed");
});
test("2단 경계 매칭 — 제거된 intake 하위분류 단어는 판정에 끼지 않는다", () => {
  // 음식은 더 이상 intake 하위갈래가 아니다. 동물(creature 하위갈래)만 판정 신호로 남는다.
  const a = classifyEntityTypeDeterministic("동물 음식 봤다");
  const b = classifyEntityTypeDeterministic("음식 동물 봤다");
  expect(a.typeName).toBe("creature");
  expect(b.typeName).toBe("creature");
  expect(a.subcategory).toBe("동물");
  expect(b.subcategory).toBe("동물");
  expect(a.source).toBe("seed");
});
test("충돌 — 명시 태그가 2단 경계 매칭을 이긴다", () => {
  // #작품:타이레놀 의 콜론 사슬(explicit)이 본문 '영화'(work 하위갈래) 2단 경계 매칭을 이긴다.
  const r = classifyEntityTypeDeterministic("#작품:타이레놀 영화");
  expect(r.typeName).toBe("work");
  expect(r.source).toBe("explicit");
});
test("기타 — 아무것도 안 걸리면 none", () => {
  const r = classifyEntityTypeDeterministic("그냥 평범한 하루였다");
  expect(r.typeName).toBeNull();
  expect(r.source).toBe("none");
  expect(r.confidence).toBe(0);
});
test("단어 경계 — 무관 영어 토큰이 2단 경계 매칭에 오매치 안 됨", () => {
  // (2026-06-27 단계1 D2) seeds 제거 후 2단은 분류 폴더 단어만 본다. 무관 영어 변수명은
  // 어느 분류 폴더 단어와도 안 겹쳐 정직한 기타(부분 문자열 오매치 0).
  const r = classifyEntityTypeDeterministic("gptest 라는 변수명을 썼다");
  expect(r.typeName).toBeNull();
});

// ── 콜론 사슬 추적 (2026-06-12 콜론 사슬 자동 배치 C1·C3·C4 + (다) 게이트 신호) ──────

test("사슬 추적 — #작품:소설 #소설:데뷔못... → work·소설·끝 고유명·leaf", () => {
  // 타입+분류 prefix(#작품:소설)를 앞에 더 붙여도 사슬을 타고 내려가 끝 고유명을 잡는다.
  const r = classifyEntityTypeDeterministic(
    "#작품:소설 #소설:데뷔못하면죽는병걸림",
  );
  expect(r.typeName).toBe("work");
  expect(r.subcategory).toBe("소설"); // 사슬이 거쳐 온 마지막 분류 단.
  expect(r.source).toBe("explicit");
  expect(r.matched).toBe("소설:데뷔못하면죽는병걸림"); // 멈춘 태그.
  expect(r.chainStop?.reason).toBe("leaf");
});

test("사슬 추적 회귀 0 — 단일 #소설:데뷔못... 가 사슬 prefix 입력과 동치", () => {
  const single = classifyEntityTypeDeterministic("#소설:데뷔못하면죽는병걸림");
  const chained = classifyEntityTypeDeterministic(
    "#작품:소설 #소설:데뷔못하면죽는병걸림",
  );
  // 핵심 동치 — typeName·subcategory·matched(=candidateName 출처)가 같다.
  expect(single.typeName).toBe(chained.typeName);
  expect(single.subcategory).toBe(chained.subcategory);
  expect(single.matched).toBe(chained.matched);
  // 단일 태그는 첫 걸음에서 즉시 멈춤(leaf·depth 1·현 동작 동치).
  expect(single.chainStop?.reason).toBe("leaf");
  expect(single.chainStop?.depth).toBe(1);
});

test("사슬 추적 — 순환 #A:B #B:A 는 무한 루프 없이 depth-or-cycle 로 멈춘다", () => {
  // 사슬 시작점이 되려면 첫 키가 타입/분류 어휘여야 한다 — 실제 어휘로 순환을 만든다.
  // #작품:소설 #소설:작품 → 소설 의 value '작품' 이 어휘라 한 단 내려가려 하지만 '작품'
  // 키 태그(#작품:소설)는 이미 방문 → depth-or-cycle(무한 루프 차단).
  const r = classifyEntityTypeDeterministic("#작품:소설 #소설:작품");
  expect(r.typeName).toBe("work");
  expect(r.chainStop?.reason).toBe("depth-or-cycle");
  // 방문 경로에 '작품'·'소설' 이 들어 있다(추적이 실제로 돌았다).
  expect(r.chainStop?.visitedKeys).toContain("작품");
  expect(r.chainStop?.visitedKeys).toContain("소설");
});

test("사슬 추적 — 분류에서 끝남(#작품:소설 단독·다음 태그 없음) → ended-in-category·빈 후보", () => {
  const r = classifyEntityTypeDeterministic("#작품:소설");
  expect(r.typeName).toBe("work");
  expect(r.subcategory).toBe("소설"); // 마지막 분류 단.
  expect(r.chainStop?.reason).toBe("ended-in-category");
  // candidateName 출처(matched 콜론 뒤)가 빈 문자열 — 게이트가 빈 이름으로 행을 안 만든다.
  expect(r.matched).toBe("소설:");
});

test("사슬 추적 — 깊이 상한 초과 사슬은 depth-or-cycle 로 멈추고 추적 경로를 담는다 (L3 동결 회귀)", () => {
  // COLON_CHAIN_MAX_DEPTH(6) 보다 긴 사슬을 실제 어휘 키로 길게 잇는다. 어휘 키가
  // 6개를 넘게 서로를 가리키면 상한에 닿아 멈춘다(순환이 먼저 안 걸리도록 키를 다르게).
  // work subcategories(소설·만화·게임·애니·영화·음악·웹툰) 7개를 사슬로 잇는다.
  // L3 동결(2026-06-27): 상한 도달 시 멈춘 값으로 진행 + depth-or-cycle 경고 = 확정 정책.
  // 경고 메시지가 entity-placement-loop·wiring 에서 쓰는 추적 경로(visitedKeys)가 채워지는지
  // 검증한다 — 공허 경고가 아니라 사슬이 거쳐 온 분류 키를 실제로 담아야 한다.
  const r = classifyEntityTypeDeterministic(
    "#작품:소설 #소설:만화 #만화:게임 #게임:애니 #애니:영화 #영화:음악 #음악:웹툰",
  );
  expect(r.typeName).toBe("work");
  // 7 걸음 사슬(작품→소설→만화→…)이 깊이 상한 6 에 닿아 멈춘다(순환 아닌 순수 깊이 상한).
  expect(r.chainStop?.reason).toBe("depth-or-cycle");
  expect(r.chainStop?.depth).toBe(6);
  // 추적 경로 — 사슬이 거쳐 온 키가 순서대로 들어간다(경고 메시지가 이 값을 join 해 노출).
  expect(r.chainStop?.visitedKeys).toContain("작품");
  expect(r.chainStop?.visitedKeys).toContain("영화");
  // 순환이 아니라 깊이로 멈춘 증거 — 방문 키가 전부 서로 다르다(중복 0).
  const keys = r.chainStop!.visitedKeys;
  expect(new Set(keys).size).toBe(keys.length);
});

// ── 단계3 T3: koNameOf·typeIndicatorMap 동적 명부(정적 ∪ DB 새 종류) ─────────

// 새 종류는 PlacementTypeName union 밖이라 컴파일타임에 string 으로 흐른다(의도된 비대칭).
// 테스트가 union 시그니처(koNameOf·typeForIndicatorKey 인자/반환)와 맞물리도록 명시 단언한다.
const VEHICLE = "vehicle" as PlacementTypeName;

test("koNameOf — 정적 종류는 메타/상수, 주입 새 종류는 명부 koName", () => {
  // work koName 은 레지스트리 메타 권위(작품). person·project 는 코드 상수.
  expect(koNameOf("work")).toBe(getEntityTypeMeta("work").koName);
  expect(koNameOf("person")).toBe("사람");
  expect(koNameOf("project")).toBe("프로젝트");
  setEntityTypeOverride([{ typeName: "vehicle", koName: "탈것" }]);
  resetClassifierCache();
  expect(koNameOf(VEHICLE)).toBe("탈것");
});

test("typeIndicatorMap 동적화 — 새 종류 koName 콜론 태그가 explicit 로 잡힌다", () => {
  // 주입 전엔 #탈것:내차 가 어휘 밖이라 explicit 아님(none 또는 seed).
  const before = classifyEntityTypeDeterministic("#탈것:내차 샀다");
  expect(before.source).not.toBe("explicit");

  // 새 종류 vehicle(koName '탈것') 등록 + 2-reset → 같은 태그가 explicit·vehicle 로 잡힌다.
  setEntityTypeOverride([{ typeName: "vehicle", koName: "탈것" }]);
  resetClassifierCache();
  const after = classifyEntityTypeDeterministic("#탈것:내차 샀다");
  expect(after.typeName).toBe(VEHICLE);
  expect(after.source).toBe("explicit");
  expect(typeForIndicatorKey("탈것")).toBe(VEHICLE);
  expect(isTypeIndicatorKey("탈것")).toBe(true);
});

test("2-reset 함정 — setEntityTypeOverride 만 하고 resetClassifierCache 안 하면 화면만 반영(2차 캐시 stale)", () => {
  // 분류기 2차 캐시(keyToType)를 먼저 데워둔다.
  isTypeIndicatorKey("작품");
  // 새 종류 주입만 하고 classifier reset 을 빠뜨리면 typeIndicatorMap 이 stale.
  setEntityTypeOverride([{ typeName: "vehicle", koName: "탈것" }]);
  expect(typeForIndicatorKey("탈것")).toBeNull(); // 2차 캐시가 안 비워져 못 본다.
  // 2-reset 완성 — classifier 캐시까지 비우면 새 종류가 보인다.
  resetClassifierCache();
  expect(typeForIndicatorKey("탈것")).toBe(VEHICLE);
});

test("새 종류 0개 회귀 0 — 정적 10종 type indicator 그대로", () => {
  expect(typeForIndicatorKey("작품")).toBe("work");
  expect(typeForIndicatorKey("관계")).toBe("person");
  expect(typeForIndicatorKey("탈것")).toBeNull(); // 미등록.
});

// ── 정리A: displayKindName — 종류 코드명(영문 typeName) → 화면 표시용 한국어 ──────────

test("displayKindName — 정적 종류 코드명을 한국어 표시명으로 바꾼다", () => {
  // 입력 폼이 보내 저장된 영문 typeName(schedule·intake…)을 화면 배지용 한국어로.
  expect(displayKindName("schedule")).toBe("일정");
  expect(displayKindName("intake")).toBe("섭취");
  expect(displayKindName("work")).toBe(getEntityTypeMeta("work").koName);
  expect(displayKindName("person")).toBe("사람");
  expect(displayKindName("project")).toBe("프로젝트");
});

test("displayKindName — koName 출처 없는 코드명은 원본 그대로(honest degradation·throw 흡수)", () => {
  // 어떤 종류 코드명도 아닌 값(주입 전 새 종류·이미 한국어로 심긴 옛 분류)은 그대로 둔다.
  // koNameOf 의 loud throw 를 흡수해 검색·그래프 응답 전체가 깨지지 않게 하되, 가짜 이름
  // 대신 코드명을 정직하게 노출한다(빈 칸·임의 치환 금지).
  expect(displayKindName("vehicle")).toBe("vehicle"); // 주입 전 새 종류 코드명.
  expect(displayKindName("가계부")).toBe("가계부"); // 한국어로 직접 심긴 옛 종류 이름.
  expect(displayKindName("없는코드명")).toBe("없는코드명");
});

test("displayKindName — 주입된 새 종류는 동적 명부 koName 으로 바뀐다", () => {
  // 주입 전엔 코드명 그대로.
  expect(displayKindName("vehicle")).toBe("vehicle");
  // 새 종류 vehicle(koName '탈것') 등록 + 2-reset → 코드명이 한국어로 바뀐다.
  setEntityTypeOverride([{ typeName: "vehicle", koName: "탈것" }]);
  resetClassifierCache();
  expect(displayKindName("vehicle")).toBe("탈것");
});

// ── Task 2: explicitContentTypeName — 콜론 명시(explicit)만 종류로 인정하는 게이트 ──
//
// "클로드 코드"의 "코드"가 material(자료) 하위 어휘와 겹쳐 평문 글 전체가 자료로
// 자동 분류되던 오작동 수정. classifyEntityTypeDeterministic 은 안 바꾸고(엔티티 배치 등
// 다른 호출처가 seed 판정을 그대로 써야 함) 그 결과를 소비하는 이 얇은 게이트로 좁힌다.

test("explicitContentTypeName — 콜론 명시 #자료:코드 → material typeName 통과", () => {
  const r = explicitContentTypeName("#자료:코드, 정리하다가 발견");
  expect(r).toBe("material");
});

test("explicitContentTypeName — 평문 '클로드 코드' 2단 경계 매칭(seed)은 null(명시 아님)", () => {
  // matchBoundary 는 여전히 이 입력에서 material·코드 를 찾아낸다(분류기 자체는 무변경) —
  // 게이트가 그 seed 산출을 소비 단계에서 null 로 접는다.
  const underlying = classifyEntityTypeDeterministic(
    "나, 주로 사용하는 AI는 클로드 코드, 코덱스",
  );
  expect(underlying.typeName).toBe("material");
  expect(underlying.source).toBe("seed");

  const r = explicitContentTypeName("나, 주로 사용하는 AI는 클로드 코드, 코덱스");
  expect(r).toBeNull();
});

test("explicitContentTypeName — 기타(none) 도 null", () => {
  expect(explicitContentTypeName("그냥 평범한 하루였다")).toBeNull();
});

test("explicitContentTypeName — 콜론 사슬(#일정:치과) 은 그대로 typeName 통과(회귀 0)", () => {
  expect(explicitContentTypeName("#일정:치과, 예약 잡음")).toBe("schedule");
});

// ── Task 3: explicitDisplayKind — 그래프/검색 배지용 한국어 표시명 게이트(P-2) ──
//
// explicitContentTypeName(콜론 명시만 typeName 인정) 위에 displayKindName(한글화)을
// 얹은 배지 전용 헬퍼. graph.ts·search.ts·search-post-process.ts 배지 3곳이 공유한다.

test("explicitDisplayKind — 콜론 명시 #자료:코드 → '자료' 한국어 배지 통과", () => {
  expect(explicitDisplayKind("#자료:코드, 정리하다가 발견")).toBe("자료");
});

test("explicitDisplayKind — 평문 '클로드 코드' 2단 경계 매칭(seed)은 null(배지 없음)", () => {
  expect(explicitDisplayKind("나, 주로 사용하는 AI는 클로드 코드, 코덱스")).toBeNull();
});

test("explicitDisplayKind — 기타(none) 도 null", () => {
  expect(explicitDisplayKind("그냥 평범한 하루였다")).toBeNull();
});

test("explicitDisplayKind — 콜론 사슬(#일정:치과) 은 한국어 '일정' 배지 통과(회귀 0)", () => {
  expect(explicitDisplayKind("#일정:치과, 예약 잡음")).toBe("일정");
});
