import { test, expect, afterEach } from "bun:test";
import {
  loadConceptTypeVocabulary, getTypeSynonyms, getTypeSubcategories,
  getTypeAttributes, subcategoryToTypeMap,
  resetConceptTypeVocabularyCache, clearConceptVocabularyOverrides, setConceptVocabOverride,
  setColumnTypeOverride, getColumnDataType,
  getCanonicalItemKey, setItemSynonymOverride,
  placementTypeNames, isPlacementType, setEntityTypeOverride,
  userEntityKoNameOf,
  type ConceptTypeVocabulary, type ItemSynonymMap,
} from "./concept-type-vocabulary.ts";
import { typeForIndicatorKey, resetClassifierCache } from "./entity-type-classifier.ts";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

afterEach(() => { setEntityTypeOverride([]); clearConceptVocabularyOverrides(); resetClassifierCache(); });

test("배치 가능 타입 = 레지스트리 8 + person·project = 10", () => {
  expect(placementTypeNames().length).toBe(10);
  expect(placementTypeNames()).toContain("person");
  expect(placementTypeNames()).toContain("project");
  expect(placementTypeNames()).toContain("work");
});
test("운영 yaml 로드 — work 어휘(네 칸)", () => {
  const work = loadConceptTypeVocabulary().get("work")!;
  expect(work.synonyms).toContain("창작물");
  expect(work.subcategories).toContain("소설");
  expect(work.attributes).not.toContain("유형");
  expect(work.attributes).toContain("장르");
});
test("프로젝트 동의어 — 작업·작업물 → project", () => {
  expect(getTypeSynonyms("project")).toContain("작업");
  expect(getTypeSynonyms("project")).toContain("작업물");
  expect(getTypeAttributes("project")).toEqual(["참여자"]);
});
test("생물 — 동물·식물은 동의어가 아니라 하위 분류", () => {
  expect(getTypeSynonyms("creature")).not.toContain("동물");
  expect(getTypeSubcategories("creature")).toContain("동물");
  expect(getTypeSubcategories("creature")).toContain("식물");
  expect(getTypeSubcategories("creature")).not.toContain("반려동물");
});
test("usable 하위분류 — 약은 사용물(섭취 아님)", () => {
  expect(getTypeSubcategories("usable")).toContain("약");
  expect(getTypeSubcategories("usable")).toContain("화장품");
  expect(getTypeSubcategories("usable")).not.toContain("도구");
  expect(getTypeAttributes("usable")).toEqual(["주의사항", "관련사람"]);
  expect(getTypeSubcategories("intake")).not.toContain("약");
});
test("섭취 하위분류 기본값은 비어 있고 유통기한은 속성으로 유지", () => {
  expect(getTypeSubcategories("intake")).toEqual([]);
  expect(getTypeAttributes("intake")).toEqual(["유통기한", "관련사람"]);
});
test("subcategory 역방향 맵 — 동물 → creature, 소설 → work", () => {
  const m = subcategoryToTypeMap();
  expect(m.get("동물")).toBe("creature");
  expect(m.get("소설")).toBe("work");
  expect(m.get("코딩")).toBe("project");
  expect(m.get("앱")).toBe("project");
});
test("material 하위 분류 — 코드·데이터는 material(코딩=project 와 별개 단어로 공존)", () => {
  expect(getTypeSubcategories("material")).toContain("코드");
  expect(getTypeSubcategories("material")).toContain("데이터");
  expect(getTypeAttributes("material")).toEqual([]);
  const m = subcategoryToTypeMap();
  expect(m.get("코드")).toBe("material");
  expect(m.get("데이터")).toBe("material");
  // "코드"(자료)와 "코딩"(project)은 서로 다른 글자라 전역 충돌 없이 갈라진다.
  expect(m.get("코딩")).toBe("project");
});
test("장소 기본 라벨은 비어 있다", () => {
  expect(getTypeAttributes("place")).toEqual([]);
});
test("운영 yaml 정상 로드 — 코드·데이터 추가 후에도 전역 분류 키 충돌 throw 안 함", () => {
  expect(() => loadConceptTypeVocabulary()).not.toThrow();
});
test("person 분류 어휘에 가족·친구가 들어간다", () => {
  const map = subcategoryToTypeMap();
  expect(map.get("가족")).toBe("person");
  expect(map.get("친구")).toBe("person");
});
test("person 어휘 — 관계 synonym + 가족·친구 분류 + 직업·회사 라벨", () => {
  expect(getTypeSynonyms("person")).toContain("관계");
  expect(getTypeSubcategories("person")).toContain("가족");
  expect(getTypeSubcategories("person")).toContain("친구");
  expect(getTypeAttributes("person")).toEqual(["직업", "회사"]);
});
test("관계 키가 person 타입 지시어로 등록된다", () => {
  resetClassifierCache();
  expect(typeForIndicatorKey("관계")).toBe("person");
});
test("모든 배치 타입이 조회 가능 — 빠진 타입은 빈 어휘", () => {
  for (const t of placementTypeNames()) {
    expect(Array.isArray(getTypeSubcategories(t))).toBe(true);
    expect(Array.isArray(getTypeAttributes(t))).toBe(true);
  }
});
test("미등록 타입 키는 구체 에러 throw", () => {
  const p = join(import.meta.dir, `__tmp_vocab_${Date.now()}.yaml`);
  writeFileSync(p, "types:\n  taste:\n    synonyms: []\n    attributes: []\n");
  try { expect(() => loadConceptTypeVocabulary(p)).toThrow(/등록되지 않은 배치 타입|taste/); }
  finally { rmSync(p, { force: true }); }
});
test("synonyms 가 문자열 배열이 아니면 throw", () => {
  const p = join(import.meta.dir, `__tmp_vocab2_${Date.now()}.yaml`);
  writeFileSync(p, "types:\n  work:\n    synonyms: 123\n    subcategories: []\n    attributes: []\n");
  try { expect(() => loadConceptTypeVocabulary(p)).toThrow(/synonyms|문자열 배열/); }
  finally { rmSync(p, { force: true }); }
});
test("한 타입 안 synonyms ∩ subcategories ≠ ∅ 이면 throw", () => {
  const p = join(import.meta.dir, `__tmp_vocab3_${Date.now()}.yaml`);
  writeFileSync(p, "types:\n  creature:\n    synonyms: [동물]\n    subcategories: [동물]\n    attributes: []\n");
  try { expect(() => loadConceptTypeVocabulary(p)).toThrow(/동물|synonyms.*subcategories|겹침/); }
  finally { rmSync(p, { force: true }); }
});
test("두 타입이 같은 subcategory 단어를 쓰면 throw(전역 분류 키 충돌)", () => {
  const p = join(import.meta.dir, `__tmp_vocab4_${Date.now()}.yaml`);
  writeFileSync(p, "types:\n  usable:\n    synonyms: []\n    subcategories: [도구]\n    attributes: []\n" +
    "  thing:\n    synonyms: []\n    subcategories: [도구]\n    attributes: []\n");
  try { expect(() => loadConceptTypeVocabulary(p)).toThrow(/도구|중복|충돌|conflict/); }
  finally { rmSync(p, { force: true }); }
});

// ── Task 3: setConceptVocabOverride 주입 통로 ──────────────────────────────

/** 운영 yaml 을 복제 후 한 칸만 바꿔 병합본을 흉내내는 fixture(소비처 무수정 검증용). */
function operationalCloneWith(
  typeName: ReturnType<typeof placementTypeNames>[number],
  extraSynonym: string,
  extraSubcategory: string,
): ConceptTypeVocabulary {
  const base = loadConceptTypeVocabulary();
  const clone: ConceptTypeVocabulary = new Map();
  for (const t of placementTypeNames()) {
    const v = base.get(t)!;
    clone.set(t, {
      synonyms: [...v.synonyms],
      subcategories: [...v.subcategories],
      attributes: [...v.attributes],
    });
  }
  const target = clone.get(typeName)!;
  target.synonyms.push(extraSynonym);
  target.subcategories.push(extraSubcategory);
  return clone;
}

test("setConceptVocabOverride 주입 후 인자 없는 접근자가 병합본을 반환한다", () => {
  // 운영 yaml 에 없는 단어를 더한 override 를 주입 → 접근자가 그 단어를 본다.
  const overridden = operationalCloneWith("work", "만화책", "라이트노벨");
  setConceptVocabOverride(overridden);
  expect(getTypeSynonyms("work")).toContain("만화책");
  expect(getTypeSubcategories("work")).toContain("라이트노벨");
  expect(loadConceptTypeVocabulary().get("work")!.synonyms).toContain("만화책");
});

test("setConceptVocabOverride 가 subcategoryToTypeMap 을 병합본으로 재빌드한다", () => {
  const overridden = operationalCloneWith("work", "만화책", "라이트노벨");
  setConceptVocabOverride(overridden);
  expect(subcategoryToTypeMap().get("라이트노벨")).toBe("work");
});

test("주입 전(override 미호출) 접근자는 yaml-only 그대로(회귀 0)", () => {
  // afterEach 가 캐시를 비워 다음 테스트는 운영 yaml 로 돌아온다. 여기서 yaml-only 확인.
  expect(getTypeSynonyms("work")).not.toContain("만화책");
  expect(getTypeSubcategories("work")).not.toContain("라이트노벨");
  expect(getTypeSynonyms("work")).toContain("창작물"); // yaml 본체 보존
});

// ── 단계2 Task 3: 항목 동의어 맵 캐시·getCanonicalItemKey·setItemSynonymOverride ──

function itemSynonymMapOf(
  typeName: ReturnType<typeof placementTypeNames>[number],
  pairs: Array<[alias: string, canonical: string]>,
): ItemSynonymMap {
  const perType = new Map<string, string>();
  for (const [alias, canonical] of pairs) perType.set(alias.toLowerCase(), canonical);
  const m: ItemSynonymMap = new Map();
  m.set(typeName, perType);
  return m;
}

test("주입 전 getCanonicalItemKey 는 rawKey 그대로(빈 맵 no-op)", () => {
  expect(getCanonicalItemKey("person", "닉네임")).toBe("닉네임");
  expect(getCanonicalItemKey("person", "별명")).toBe("별명");
});

test("setItemSynonymOverride 주입 후 동의어 키가 대표키로 정규화", () => {
  setItemSynonymOverride(itemSynonymMapOf("person", [["닉네임", "별명"]]));
  expect(getCanonicalItemKey("person", "닉네임")).toBe("별명");
  // 대표키 자체는 그대로.
  expect(getCanonicalItemKey("person", "별명")).toBe("별명");
  // 매칭 없는 키는 입력 그대로(canonicalKinship 양식).
  expect(getCanonicalItemKey("person", "다른키")).toBe("다른키");
});

test("getCanonicalItemKey 는 대소문자 무관 매칭(소문자 정규화)", () => {
  setItemSynonymOverride(itemSynonymMapOf("work", [["genre", "장르"]]));
  expect(getCanonicalItemKey("work", "Genre")).toBe("장르");
  expect(getCanonicalItemKey("work", "GENRE")).toBe("장르");
});

test("타입 다르면 같은 동의어라도 합류 안 함(타입별 맵 분리)", () => {
  setItemSynonymOverride(itemSynonymMapOf("person", [["닉네임", "별명"]]));
  // work 타입엔 그 맵이 없어 입력 그대로.
  expect(getCanonicalItemKey("work", "닉네임")).toBe("닉네임");
});

test("clearConceptVocabularyOverrides 가 항목 동의어 맵도 비운다(주입분 버림)", () => {
  setItemSynonymOverride(itemSynonymMapOf("person", [["닉네임", "별명"]]));
  expect(getCanonicalItemKey("person", "닉네임")).toBe("별명");
  clearConceptVocabularyOverrides();
  // 비운 뒤 빈 맵 → 입력 그대로.
  expect(getCanonicalItemKey("person", "닉네임")).toBe("닉네임");
});

// resetConceptTypeVocabularyCache 는 파생 캐시만 비운다 — 종류 CRUD·관계명 CRUD 가 부르는데,
// 주입분(병합본·항목 동의어·칸 datatype)까지 비우면 사용자 분류 어휘가 재시작 전까지 사라진다.
test("resetConceptTypeVocabularyCache 는 주입한 병합본·항목 동의어·칸 datatype 을 남긴다", () => {
  setConceptVocabOverride(operationalCloneWith("work", "만화책", "라이트노벨"));
  setItemSynonymOverride(itemSynonymMapOf("person", [["닉네임", "별명"]]));
  setColumnTypeOverride(new Map([["equipment", new Map([["무게", "number" as const]])]]));
  expect(subcategoryToTypeMap().get("라이트노벨")).toBe("work");

  resetConceptTypeVocabularyCache();

  expect(getTypeSynonyms("work")).toContain("만화책");
  expect(loadConceptTypeVocabulary().get("work")!.subcategories).toContain("라이트노벨");
  expect(subcategoryToTypeMap().get("라이트노벨")).toBe("work"); // 파생 역방향 맵은 병합본으로 재빌드
  expect(getCanonicalItemKey("person", "닉네임")).toBe("별명");
  expect(getColumnDataType("equipment", "무게")).toBe("number");
});

test("clearConceptVocabularyOverrides 는 병합본·칸 datatype 도 yaml 기본으로 되돌린다", () => {
  setConceptVocabOverride(operationalCloneWith("work", "만화책", "라이트노벨"));
  setColumnTypeOverride(new Map([["equipment", new Map([["무게", "number" as const]])]]));
  clearConceptVocabularyOverrides();
  expect(getTypeSynonyms("work")).not.toContain("만화책");
  expect(subcategoryToTypeMap().get("라이트노벨")).toBeUndefined();
  expect(getColumnDataType("equipment", "무게")).toBe("text");
  expect(getTypeSynonyms("work")).toContain("창작물");
});

// ── 단계3 T3: 종류 화이트리스트 동적화(정적 8+2 ∪ DB 새 종류) ────────────────

test("주입 전 placementTypeNames 는 정적 10종 그대로(byte 동일·회귀 0)", () => {
  expect(placementTypeNames().length).toBe(10);
  expect(placementTypeNames()).not.toContain("vehicle");
});

test("setEntityTypeOverride 주입 후 새 종류가 placementTypeNames 합집합에 합류", () => {
  setEntityTypeOverride([{ typeName: "vehicle", koName: "탈것" }]);
  // 새 종류는 union 밖이라 string[] 으로 본다(동적 명부 비대칭 — 런타임 Set 이 게이트).
  const names = placementTypeNames() as string[];
  expect(names.length).toBe(11);
  expect(names).toContain("vehicle");
  // 정적 10종은 그대로 남는다(합집합 — 새 종류는 추가만).
  expect(names).toContain("work");
  expect(names).toContain("person");
});

test("isPlacementType — 정적 종류·주입 새 종류 둘 다 true, 미등록 false", () => {
  expect(isPlacementType("work")).toBe(true);
  expect(isPlacementType("person")).toBe(true);
  expect(isPlacementType("vehicle")).toBe(false); // 주입 전.
  setEntityTypeOverride([{ typeName: "vehicle", koName: "탈것" }]);
  expect(isPlacementType("vehicle")).toBe(true);
  expect(isPlacementType("없는종류")).toBe(false);
});

test("userEntityKoNameOf — 새 종류 koName 조회, 정적·미등록은 null", () => {
  expect(userEntityKoNameOf("vehicle")).toBeNull(); // 주입 전.
  setEntityTypeOverride([{ typeName: "vehicle", koName: "탈것" }]);
  expect(userEntityKoNameOf("vehicle")).toBe("탈것");
  // 정적 10종은 user 명부에 없어 null(코드 상수 koName 은 별 출처).
  expect(userEntityKoNameOf("work")).toBeNull();
  expect(userEntityKoNameOf("없는종류")).toBeNull();
});

test("새 종류 0개 = placementTypeNames byte 동일(빈 배열 주입도 정적만)", () => {
  const before = [...placementTypeNames()];
  setEntityTypeOverride([]); // 빈 주입 = no-op 복귀.
  expect([...placementTypeNames()]).toEqual(before);
  expect(placementTypeNames().length).toBe(10);
});

test("setEntityTypeOverride 가 종류 캐시를 무효화(추가→삭제 즉시 반영)", () => {
  setEntityTypeOverride([{ typeName: "vehicle", koName: "탈것" }]);
  expect(placementTypeNames() as string[]).toContain("vehicle");
  // 삭제 시뮬레이션 — 빈 명부 재주입이면 새 종류가 빠진다.
  setEntityTypeOverride([]);
  expect(placementTypeNames() as string[]).not.toContain("vehicle");
});

test("새 종류 등록 후 그 종류 yaml/병합 어휘가 미등록 throw 안 남(parseVocabulary 동적 게이트)", () => {
  // 주입 전엔 vehicle 어휘가 미등록 배치 타입이라 throw.
  const p = join(import.meta.dir, `__tmp_vocab_t3_${Date.now()}.yaml`);
  writeFileSync(
    p,
    "types:\n  vehicle:\n    synonyms: [자동차]\n    subcategories: []\n    attributes: []\n",
  );
  try {
    expect(() => loadConceptTypeVocabulary(p)).toThrow(/등록되지 않은 배치 타입|vehicle/);
    // 새 종류 등록 후엔 그 종류 yaml 어휘가 정상 적재(미등록 throw 안 남).
    setEntityTypeOverride([{ typeName: "vehicle", koName: "탈것" }]);
    const vocab = loadConceptTypeVocabulary(p);
    expect(vocab.get("vehicle" as ReturnType<typeof placementTypeNames>[number])!.synonyms).toContain("자동차");
  } finally {
    rmSync(p, { force: true });
  }
});

// ── stage4 T2: 종류 판정 동적 합류 고정(정적 10종 ∪ DB 새 종류) ─────────────────
// 동적 합류 로직(placementTypeNames·isPlacementType·setEntityTypeOverride)은 단계3 T3 에서
// 이미 작성됐다. stage4 T2 는 (a) 정적 10종 전부를 한 번에 단언해 동결 스냅샷을 고정하고,
// (b) DB 새 종류 주입→합류→빈 배열 복귀(정적 10종)를 명시 단언해 후속 T9(전용 테이블 제거)
// 가 동적 통로를 깨지 않았음을 회귀로 잡는다. afterEach 가 전역 캐시를 복귀시킨다(격리).

test("stage4 T2 — 정적 10종(8타입+person+project) 전부 isPlacementType true, 미등록 ghost false", () => {
  // 동결 스냅샷 8타입 + person·project = 정적 10종 전부 배치 가능.
  for (const t of ["work", "creature", "thing", "intake", "usable", "material", "place", "schedule", "person", "project"]) {
    expect(isPlacementType(t)).toBe(true);
  }
  // 미등록 종류는 false(거짓 허용 없음 — 동적 Set 이 진짜 게이트).
  expect(isPlacementType("ghost")).toBe(false);
});

test("stage4 T2 — DB 새 종류 주입 후 reset → 동적 합류, 빈 배열 복귀 시 정적 10종", () => {
  // 주입 전: 정적 10종, vehicle 없음.
  expect(placementTypeNames().length).toBe(10);
  expect(isPlacementType("vehicle")).toBe(false);

  // DB 새 종류 주입 + 캐시 무효화 → placementTypeNames·isPlacementType 동적 합류.
  setEntityTypeOverride([{ typeName: "vehicle", koName: "탈것" }]);
  resetConceptTypeVocabularyCache();
  expect((placementTypeNames() as string[]).includes("vehicle")).toBe(true);
  expect(isPlacementType("vehicle")).toBe(true);

  // 빈 배열 재주입 → 정적 10종 복귀(vehicle 빠짐).
  setEntityTypeOverride([]);
  resetConceptTypeVocabularyCache();
  expect((placementTypeNames() as string[]).includes("vehicle")).toBe(false);
  expect(isPlacementType("vehicle")).toBe(false);
  expect(placementTypeNames().length).toBe(10);
});
