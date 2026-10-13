/**
 * entity-type-classifier-guards.test.ts — 2단계(타입 자동 배치) 종합 가드.
 *
 * 새 코어를 거의 만들지 않고 2단계 전체를 한데 동결한다. 엣지 입력(빈·공백·undefined·
 * 평면 해시태그·속성 키 태그), 어휘 사전↔PLACEMENT_TYPE_NAMES↔파서 판정 타입 세 곳 정합,
 * subcategory 역방향 맵 타입 정합, 한 타입 안 subcategory 와 attributes 가 안 겹침,
 * cache reset 후 재분류 동일을 검증한다. 순수 함수·정합 검증이라 fixture·Mock 불필요.
 */
import { test, expect, afterEach } from "bun:test";
import {
  classifyEntityTypeDeterministic,
  resetClassifierCache,
} from "./entity-type-classifier.ts";
import {
  placementTypeNames,
  resetConceptTypeVocabularyCache,
  loadConceptTypeVocabulary,
  subcategoryToTypeMap,
  getTypeSubcategories,
  getTypeAttributes,
} from "./concept-type-vocabulary.ts";

afterEach(() => {
  resetConceptTypeVocabularyCache();
  resetClassifierCache();
});

test("빈/공백/undefined 입력 → 기타, throw 안 함", () => {
  for (const input of ["", "   ", undefined as unknown as string]) {
    const r = classifyEntityTypeDeterministic(input);
    expect(r.typeName).toBeNull();
    expect(r.subcategory).toBeNull();
    expect(r.source).toBe("none");
  }
});

test("평면 해시태그만 → 1단 안 걸림", () => {
  const r = classifyEntityTypeDeterministic("#봄 날씨 좋다");
  expect(r.source).not.toBe("explicit");
});

test("평면 해시태그가 분류 폴더 단어와 무관하면 → 기타", () => {
  // #봄·날씨 어느 것도 타입 지시·하위 분류에 없다 → 2단도 안 걸려 정직한 기타.
  // (2026-06-27 단계1 D2) seeds 제거로 일반명사 자동 배치 통로가 사라졌다.
  const r = classifyEntityTypeDeterministic("#봄 날씨 좋다");
  expect(r.typeName).toBeNull();
  expect(r.source).toBe("none");
});

test("속성 키 태그(#장르:액션)는 타입 지시·subcategory 아님 → explicit 안 됨", () => {
  const r = classifyEntityTypeDeterministic("#장르:액션 좋아");
  expect(r.source).not.toBe("explicit");
});

test("정합 — 어휘 사전 타입 키 == PLACEMENT_TYPE_NAMES", () => {
  const vocab = loadConceptTypeVocabulary();
  expect([...vocab.keys()].sort()).toEqual([...placementTypeNames()].sort());
});

test("정합 — subcategory 역방향 맵의 타입이 모두 PLACEMENT_TYPE_NAMES 안", () => {
  const names = new Set<string>(placementTypeNames());
  for (const t of subcategoryToTypeMap().values()) expect(names.has(t)).toBe(true);
});

test("정합 — 운영 yaml 에서 한 타입의 subcategory ∩ attributes = ∅", () => {
  for (const t of placementTypeNames()) {
    const subs = new Set(getTypeSubcategories(t).map((s) => s.toLowerCase()));
    for (const a of getTypeAttributes(t)) expect(subs.has(a.toLowerCase())).toBe(false);
  }
});

test("정합 — 모든 subcategory 가 하나의 타입에만 — 전역 충돌 0", () => {
  // 한 단어가 두 타입의 하위 분류에 동시에 들면 위계 부모가 둘이 돼 판정이 갈린다.
  // 로더가 이미 충돌을 throw 하지만, 운영 yaml 이 충돌 없이 로드된다는 사실을 가드로 동결.
  const owner = new Map<string, string>();
  for (const t of placementTypeNames()) {
    for (const w of getTypeSubcategories(t)) {
      const key = w.toLowerCase();
      const prev = owner.get(key);
      if (prev) expect(prev).toBe(t);
      owner.set(key, t);
    }
  }
});

test("명시 태그 — #작품:소설 → work·하위 분류 소설, explicit 확정", () => {
  // 1단 explicit 경로가 살아 있음을 동결. work 의 하위 분류 소설을 그대로 집는다.
  // 파서 통일(방식 ②·결정 4): 값 경계가 쉼표/줄바꿈/#/줄 끝이라 본문을 바로 붙이면
  // 값이 본문까지 삼킨다. 사용자 실데이터 양식대로 쉼표로 본문을 가른다(spec §3.2).
  const r = classifyEntityTypeDeterministic("#작품:소설, 재밌다");
  expect(r.typeName).toBe("work");
  expect(r.subcategory).toBe("소설");
  expect(r.source).toBe("explicit");
});

test("2단 분류 폴더 경계 매칭 — 폴더 단어가 평면 글에 등장 → seed 출처 판정(LLM 0)", () => {
  // 소설 은 work 의 분류 폴더 단어(subcategory). 명시 태그 없이 글 어절 경계로 잡혀
  // 평면 글 종류 자동 배치(source 'seed' 라벨)로 확정. (2026-06-27 단계1 D2 — seeds 제거
  // 후에도 subcategory 경계 매칭은 D3 첫 등장 단축으로 보존.)
  const r = classifyEntityTypeDeterministic("오늘 소설 읽었다");
  expect(r.typeName).toBe("work");
  expect(r.subcategory).toBe("소설");
  expect(r.source).toBe("seed");
});

test("삭제된 intake 하위분류 단어만 적힌 평면 글은 분류 안 됨 — 기타", () => {
  // 음식·음료·식재료는 더 이상 intake 하위분류가 아니다. 평면 글 자동 배치 신호가 없어
  // 정직한 기타로 남는다.
  const r = classifyEntityTypeDeterministic("오늘 음식 먹었다");
  expect(r.typeName).toBeNull();
  expect(r.source).toBe("none");
});

test("명시 태그가 2단 경계 매칭을 이긴다 — #장소:집 + 음식 같이 적힘", () => {
  // 1단 명시 태그(장소)가 먼저 확정되고, 음식은 이제 intake 하위분류가 아니라 2단 신호가 아니다.
  const r = classifyEntityTypeDeterministic("#장소:집 에서 음식");
  expect(r.typeName).toBe("place");
  expect(r.source).toBe("explicit");
});

test("cache reset 후 재분류 동일", () => {
  const a = classifyEntityTypeDeterministic("#작품:소설");
  resetConceptTypeVocabularyCache();
  resetClassifierCache();
  const b = classifyEntityTypeDeterministic("#작품:소설");
  expect(b.typeName).toBe(a.typeName);
  expect(b.subcategory).toBe(a.subcategory);
  expect(b.source).toBe(a.source);
});

test("cache reset 후 삭제된 intake 단어 재분류도 동일 — 역방향 맵·indicator 둘 다 새로 빌드", () => {
  const a = classifyEntityTypeDeterministic("음료 한 잔");
  resetConceptTypeVocabularyCache();
  resetClassifierCache();
  const b = classifyEntityTypeDeterministic("음료 한 잔");
  expect(b.typeName).toBe(a.typeName);
  expect(b.typeName).toBeNull();
  expect(b.source).toBe(a.source);
});
