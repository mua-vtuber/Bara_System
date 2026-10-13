/**
 * merge-classify-vocab.test.ts — mergeConceptVocab 순수 병합 검증 (분류 어휘 DB 단계1 Task 2).
 *
 * yaml 어휘 Map + user 행을 합친 새 Map 을 만든다. 검증 가족:
 *   (a) 빈 user → yaml byte 동일 복제(원본 불변).
 *   (b) synonyms·subcategories push / 중복 skip(소문자 정규화).
 *   (c) 등록 안 된 type_name·무효 slot 행 → 명시 에러 throw(silent skip 금지).
 *   (d) 병합 결과가 불변식(synonyms↔subcategories 중복·subcategory 전역 중복) 위반 →
 *       그 위반 단어를 담은 명시 에러 throw.
 *   (e) 원본 yaml Map·내부 배열 불변(키 배열까지 복제).
 *
 * mergeSynonymDict 미러 + parseVocabulary 불변식 재사용. mock 0 — data fixture(Map)만.
 */
import { describe, test, expect } from "bun:test";
import {
  type ConceptTypeVocabulary,
  type PlacementTypeName,
  placementTypeNames,
} from "../concept-type-vocabulary.ts";
import {
  mergeConceptVocab,
  buildItemSynonymMap,
  partitionOrphanClassifyRows,
  type ClassifyVocabUserEntryLike,
} from "./merge-classify-vocab.ts";

/** 모든 배치 타입을 빈 어휘로 채운 yaml fixture Map(운영 yaml 구조 동형). */
function emptyVocab(): ConceptTypeVocabulary {
  const m: ConceptTypeVocabulary = new Map();
  for (const t of placementTypeNames()) {
    m.set(t, { synonyms: [], subcategories: [], attributes: [] });
  }
  return m;
}

function withVocab(
  overrides: Partial<Record<PlacementTypeName, { synonyms?: string[]; subcategories?: string[] }>>,
): ConceptTypeVocabulary {
  const m = emptyVocab();
  for (const [t, v] of Object.entries(overrides)) {
    const cur = m.get(t as PlacementTypeName)!;
    m.set(t as PlacementTypeName, {
      synonyms: v?.synonyms ?? cur.synonyms,
      subcategories: v?.subcategories ?? cur.subcategories,
      attributes: cur.attributes,
    });
  }
  return m;
}

function withVocabAttributes(
  overrides: Partial<Record<PlacementTypeName, string[]>>,
): ConceptTypeVocabulary {
  const m = emptyVocab();
  for (const [t, attributes] of Object.entries(overrides)) {
    const cur = m.get(t as PlacementTypeName)!;
    m.set(t as PlacementTypeName, { ...cur, attributes: [...(attributes ?? [])] });
  }
  return m;
}

describe("mergeConceptVocab — 순수 병합", () => {
  test("빈 user → yaml 와 동형(원본 불변)", () => {
    const yaml = withVocab({ work: { synonyms: ["창작물"], subcategories: ["소설"] } });
    const merged = mergeConceptVocab(yaml, []);
    expect(merged.get("work")!.synonyms).toEqual(["창작물"]);
    expect(merged.get("work")!.subcategories).toEqual(["소설"]);
    // 원본 불변 — 다른 인스턴스.
    expect(merged).not.toBe(yaml);
    expect(merged.get("work")).not.toBe(yaml.get("work"));
  });

  test("synonyms user 행을 해당 타입 칸에 push", () => {
    const yaml = withVocab({ work: { synonyms: ["창작물"] } });
    const entries: ClassifyVocabUserEntryLike[] = [
      { typeName: "work", slot: "synonyms", value: "만화책" },
    ];
    const merged = mergeConceptVocab(yaml, entries);
    expect(merged.get("work")!.synonyms).toContain("창작물");
    expect(merged.get("work")!.synonyms).toContain("만화책");
    // 원본 yaml 배열은 안 늘어난다.
    expect(yaml.get("work")!.synonyms).toEqual(["창작물"]);
  });

  test("subcategories user 행을 해당 타입 칸에 push", () => {
    const yaml = emptyVocab();
    const merged = mergeConceptVocab(yaml, [
      { typeName: "work", slot: "subcategories", value: "라이트노벨" },
    ]);
    expect(merged.get("work")!.subcategories).toContain("라이트노벨");
  });

  test("이미 있는 값은 skip(소문자 정규화 비교)", () => {
    const yaml = withVocab({ work: { synonyms: ["Novel"] } });
    const merged = mergeConceptVocab(yaml, [
      { typeName: "work", slot: "synonyms", value: "novel" },
    ]);
    // 대소문자만 다른 중복은 한 번만(소문자 정규화 = 로더 매칭 정합).
    expect(merged.get("work")!.synonyms.filter((s) => s.toLowerCase() === "novel").length).toBe(1);
  });

  test("등록 안 된 type_name 행은 명시 에러 throw(silent skip 금지)", () => {
    const yaml = emptyVocab();
    expect(() =>
      mergeConceptVocab(yaml, [
        { typeName: "nonexistent_type", slot: "synonyms", value: "x" } as ClassifyVocabUserEntryLike,
      ]),
    ).toThrow(/nonexistent_type|등록되지 않은/);
  });

  test("무효 slot 행은 명시 에러 throw", () => {
    const yaml = emptyVocab();
    expect(() =>
      mergeConceptVocab(yaml, [
        { typeName: "work", slot: "bogus_slot", value: "x" } as unknown as ClassifyVocabUserEntryLike,
      ]),
    ).toThrow(/slot|bogus_slot/);
  });

  // (2026-06-27 콜론 사슬 구조 배치 spec §6-B·단계1 D2) 옛 seeds slot 은 제거됐다 —
  // 자유 어휘 push·멱등·전역 중복 무관 검증은 살아남은 attributes slot 으로 옮긴다.
  test("attributes user 행을 해당 타입 칸에 push(단계2 4-slot)", () => {
    const yaml = emptyVocab();
    const merged = mergeConceptVocab(yaml, [
      { typeName: "work", slot: "attributes", value: "장르" } as ClassifyVocabUserEntryLike,
    ]);
    expect(merged.get("work")!.attributes).toContain("장르");
  });

  test("attributes 는 자유 어휘 — subcategory 전역 중복 불변식과 무관", () => {
    // 두 타입이 같은 attributes 단어를 써도 불변식(subcategory 전역 중복)을 안 깬다.
    const yaml = emptyVocab();
    expect(() =>
      mergeConceptVocab(yaml, [
        { typeName: "work", slot: "attributes", value: "겹침" } as ClassifyVocabUserEntryLike,
        { typeName: "thing", slot: "attributes", value: "겹침" } as ClassifyVocabUserEntryLike,
      ]),
    ).not.toThrow();
  });

  test("attributes 중복 단어는 소문자 skip(멱등)", () => {
    const yaml = withVocabAttributes({ intake: ["사과"] });
    const merged = mergeConceptVocab(yaml, [
      { typeName: "intake", slot: "attributes", value: "사과" } as ClassifyVocabUserEntryLike,
    ]);
    expect(merged.get("intake")!.attributes.filter((s) => s === "사과").length).toBe(1);
  });

  test("무효 slot — 제거된 seeds slot 은 명시 에러 throw(D2)", () => {
    const yaml = emptyVocab();
    expect(() =>
      mergeConceptVocab(yaml, [
        { typeName: "intake", slot: "seeds", value: "사과" } as unknown as ClassifyVocabUserEntryLike,
      ]),
    ).toThrow(/slot|seeds/);
  });

  test("불변식 위반 — synonyms↔subcategories 한 타입 내 중복이면 throw", () => {
    // yaml 에 work.synonyms=[창작물], user 가 work.subcategories 에 창작물 추가 → 한 타입
    // 안 같은 단어가 양쪽에. parseVocabulary 와 같은 불변식이라 throw.
    const yaml = withVocab({ work: { synonyms: ["창작물"] } });
    expect(() =>
      mergeConceptVocab(yaml, [{ typeName: "work", slot: "subcategories", value: "창작물" }]),
    ).toThrow(/창작물/);
  });

  test("불변식 위반 — subcategory 전역 중복(두 타입)이면 throw", () => {
    const yaml = withVocab({ work: { subcategories: ["도구"] } });
    expect(() =>
      mergeConceptVocab(yaml, [{ typeName: "thing", slot: "subcategories", value: "도구" }]),
    ).toThrow(/도구/);
  });

  test("원본 yaml Map·배열 불변 — 병합 후에도 yaml 그대로", () => {
    const yaml = withVocab({ work: { synonyms: ["창작물"], subcategories: ["소설"] } });
    const beforeSyn = [...yaml.get("work")!.synonyms];
    const beforeSub = [...yaml.get("work")!.subcategories];
    mergeConceptVocab(yaml, [
      { typeName: "work", slot: "synonyms", value: "만화책" },
      { typeName: "work", slot: "subcategories", value: "수필" },
    ]);
    expect(yaml.get("work")!.synonyms).toEqual(beforeSyn);
    expect(yaml.get("work")!.subcategories).toEqual(beforeSub);
  });

  test("item_synonym 행은 어휘 칸에 안 들어감(맵 입력 — 병합 칸 byte 동일)", () => {
    const yaml = withVocab({ person: { synonyms: ["사람"] } });
    const merged = mergeConceptVocab(yaml, [
      { typeName: "person", slot: "item_synonym", value: "별명\t닉네임" } as ClassifyVocabUserEntryLike,
    ]);
    // item_synonym 은 네 칸 어디에도 안 들어간다.
    expect(merged.get("person")!.synonyms).toEqual(["사람"]);
    expect(merged.get("person")!.subcategories).toEqual([]);
    expect(merged.get("person")!.attributes).toEqual([]);
  });

  // ── 단계3 T8 — columns slot 병합·빈 배열 default(D15) ──────────────────────

  test("columns 빈 배열 default — 빈 user 면 모든 타입 columns=[](byte 동일)", () => {
    const yaml = withVocab({ work: { synonyms: ["창작물"] } });
    const merged = mergeConceptVocab(yaml, []);
    // columns 가 yaml 에 없어도 병합본은 빈 배열로 채운다(getTypeColumns 가 []을 본다).
    expect(merged.get("work")!.columns).toEqual([]);
    expect(merged.get("person")!.columns).toEqual([]);
  });

  test("columns user 행을 해당 타입 칸에 push", () => {
    const yaml = emptyVocab();
    const merged = mergeConceptVocab(yaml, [
      { typeName: "work", slot: "columns", value: "구입일" } as ClassifyVocabUserEntryLike,
    ]);
    expect(merged.get("work")!.columns).toContain("구입일");
    // 다른 칸(attributes)엔 안 들어간다(칸≠라벨 분리).
    expect(merged.get("work")!.attributes).not.toContain("구입일");
  });

  test("columns 중복 단어는 소문자 skip(멱등)", () => {
    const yaml = emptyVocab();
    const merged = mergeConceptVocab(yaml, [
      { typeName: "work", slot: "columns", value: "구입일" } as ClassifyVocabUserEntryLike,
      { typeName: "work", slot: "columns", value: "구입일" } as ClassifyVocabUserEntryLike,
    ]);
    expect(merged.get("work")!.columns!.filter((s) => s === "구입일").length).toBe(1);
  });

  test("columns 는 자유 어휘 — subcategory 전역 중복 불변식과 무관(두 타입 같은 칸 OK)", () => {
    const yaml = emptyVocab();
    expect(() =>
      mergeConceptVocab(yaml, [
        { typeName: "work", slot: "columns", value: "구입일" } as ClassifyVocabUserEntryLike,
        { typeName: "thing", slot: "columns", value: "구입일" } as ClassifyVocabUserEntryLike,
      ]),
    ).not.toThrow();
  });
});

describe("buildItemSynonymMap — 항목 동의어 정규화 맵", () => {
  test("빈 user → 빈 맵(no-op)", () => {
    const map = buildItemSynonymMap([]);
    expect(map.size).toBe(0);
  });

  test("item_synonym 행 → Map<typeName, Map<동의어소문자, 대표키>>", () => {
    const map = buildItemSynonymMap([
      { typeName: "person", slot: "item_synonym", value: "별명\t닉네임" },
    ]);
    expect(map.get("person")!.get("닉네임")).toBe("별명");
  });

  test("동의어 키는 소문자 정규화 — Alias 두 표기 한 항목으로", () => {
    const map = buildItemSynonymMap([
      { typeName: "work", slot: "item_synonym", value: "장르\tGenre" },
    ]);
    expect(map.get("work")!.get("genre")).toBe("장르");
  });

  test("한 대표키에 동의어 여럿 = 행 여럿 → 같은 대표키로 모임", () => {
    const map = buildItemSynonymMap([
      { typeName: "person", slot: "item_synonym", value: "별명\t닉네임" },
      { typeName: "person", slot: "item_synonym", value: "별명\t별칭" },
    ]);
    expect(map.get("person")!.get("닉네임")).toBe("별명");
    expect(map.get("person")!.get("별칭")).toBe("별명");
  });

  test("attributes·subcategories·synonyms 행은 무시(item_synonym 만 본다)", () => {
    const map = buildItemSynonymMap([
      { typeName: "work", slot: "attributes", value: "장르" },
      { typeName: "intake", slot: "subcategories", value: "음식" },
    ]);
    expect(map.size).toBe(0);
  });

  test("동의어가 두 대표키를 가리키면(충돌) 위반 단어 담은 throw(silent skip 금지)", () => {
    expect(() =>
      buildItemSynonymMap([
        { typeName: "person", slot: "item_synonym", value: "별명\t닉네임" },
        { typeName: "person", slot: "item_synonym", value: "애칭\t닉네임" },
      ]),
    ).toThrow(/닉네임/);
  });

  test("타입 다르면 같은 동의어라도 충돌 아님(타입별 맵 분리)", () => {
    const map = buildItemSynonymMap([
      { typeName: "person", slot: "item_synonym", value: "별명\t닉네임" },
      { typeName: "work", slot: "item_synonym", value: "애칭\t닉네임" },
    ]);
    expect(map.get("person")!.get("닉네임")).toBe("별명");
    expect(map.get("work")!.get("닉네임")).toBe("애칭");
  });

  test("등록 안 된 typeName item_synonym 행은 명시 에러 throw", () => {
    expect(() =>
      buildItemSynonymMap([
        { typeName: "nonexistent_type", slot: "item_synonym", value: "별명\t닉네임" } as ClassifyVocabUserEntryLike,
      ]),
    ).toThrow(/nonexistent_type|등록되지 않은/);
  });

  test("tab 없는 item_synonym value 는 명시 에러 throw", () => {
    expect(() =>
      buildItemSynonymMap([
        { typeName: "person", slot: "item_synonym", value: "별명닉네임" },
      ]),
    ).toThrow(/item_synonym|대표키|동의어|tab/i);
  });
});

describe("mergeConceptVocab — 가림표 차감(S5 tombstone)", () => {
  test("끈 yaml 동의어가 병합 결과에서 빠진다 + 되살리면(가림표 없음) 다시 나온다", () => {
    const yaml = withVocab({ work: { synonyms: ["창작물", "소설"] } });

    // 끄기 전 — 둘 다 있다.
    const before = mergeConceptVocab(yaml, [], []);
    expect(before.get("work")!.synonyms).toEqual(["창작물", "소설"]);

    // '창작물' 끄기 — 가림표 차감 후 '소설' 만 남는다.
    const withTombstone = mergeConceptVocab(yaml, [], [
      { typeName: "work", slot: "synonyms", value: "창작물" },
    ]);
    expect(withTombstone.get("work")!.synonyms).toEqual(["소설"]);

    // 되살리기 = 가림표 없는 병합 — 다시 둘 다 나온다(소급 0·원본 yaml 불변).
    const restored = mergeConceptVocab(yaml, [], []);
    expect(restored.get("work")!.synonyms).toEqual(["창작물", "소설"]);
  });

  test("차감은 대소문자 무관(소문자 정규화 — push 매칭과 정합)", () => {
    const yaml = withVocab({ work: { synonyms: ["Manga"] } });
    const merged = mergeConceptVocab(yaml, [], [
      { typeName: "work", slot: "synonyms", value: "manga" },
    ]);
    expect(merged.get("work")!.synonyms).toEqual([]);
  });

  test("subcategories·attributes 칸도 끈다(세 칸 모두 차감 대상)", () => {
    const yaml = withVocab({ work: { subcategories: ["소설", "만화"] } });
    const yamlAttr = withVocabAttributes({ creature: ["품종", "서식지"] });

    const sub = mergeConceptVocab(yaml, [], [
      { typeName: "work", slot: "subcategories", value: "만화" },
    ]);
    expect(sub.get("work")!.subcategories).toEqual(["소설"]);

    const attr = mergeConceptVocab(yamlAttr, [], [
      { typeName: "creature", slot: "attributes", value: "품종" },
    ]);
    expect(attr.get("creature")!.attributes).toEqual(["서식지"]);
  });

  test("끌 값이 마침 없으면 no-op(throw 안 함 — 빼기라 대상 부재가 정상)", () => {
    const yaml = withVocab({ work: { synonyms: ["창작물"] } });
    expect(() =>
      mergeConceptVocab(yaml, [], [
        { typeName: "work", slot: "synonyms", value: "없는동의어" },
      ]),
    ).not.toThrow();
    const merged = mergeConceptVocab(yaml, [], [
      { typeName: "work", slot: "synonyms", value: "없는동의어" },
    ]);
    expect(merged.get("work")!.synonyms).toEqual(["창작물"]);
  });

  test("등록 안 된 typeName 가림표는 명시 에러 throw(방어)", () => {
    const yaml = withVocab({ work: { synonyms: ["창작물"] } });
    expect(() =>
      mergeConceptVocab(yaml, [], [
        { typeName: "nonexistent_type", slot: "synonyms", value: "x" } as never,
      ]),
    ).toThrow(/nonexistent_type|등록되지 않은/);
  });

  test("사용자 행도 끌 수 있다(가림표는 합본 후 차감 — push 된 값도 뺀다)", () => {
    // 라우트가 사용자 직접 추가 값 끄기를 막지만(직접 삭제가 정상 경로), 순수 병합 함수는
    // 합본 후 차감이라 push 된 값도 대상이 된다 — 라우트 가드는 정책, 함수는 기계 차감.
    const yaml = withVocab({ work: { synonyms: ["창작물"] } });
    const merged = mergeConceptVocab(
      yaml,
      [{ typeName: "work", slot: "synonyms", value: "만화책" }],
      [{ typeName: "work", slot: "synonyms", value: "만화책" }],
    );
    expect(merged.get("work")!.synonyms).toEqual(["창작물"]);
  });

  test("불변식 증명 — 차감 후에도 두 불변식 통과(충돌 풀기는 OK·새로 깨지지 않음)", () => {
    // (1) synonyms↔subcategories 충돌이 가림표로 풀리는 경우: 같은 단어가 두 칸에 있어
    //     원래라면 불변식 1 위반이지만, 한 칸을 끄면 충돌이 풀려 병합이 성공해야 한다.
    const conflicting: ConceptTypeVocabulary = new Map();
    for (const t of placementTypeNames()) {
      conflicting.set(t, { synonyms: [], subcategories: [], attributes: [] });
    }
    conflicting.set("work", { synonyms: ["겹침"], subcategories: ["겹침"], attributes: [] });
    // 가림표 없이는 불변식 1 위반으로 throw.
    expect(() => mergeConceptVocab(conflicting, [], [])).toThrow(/synonyms 와 subcategories/);
    // subcategories 쪽 '겹침' 을 끄면 충돌이 풀려 통과(차감이 불변식 검사 앞이라).
    const fixed = mergeConceptVocab(conflicting, [], [
      { typeName: "work", slot: "subcategories", value: "겹침" },
    ]);
    expect(fixed.get("work")!.synonyms).toEqual(["겹침"]);
    expect(fixed.get("work")!.subcategories).toEqual([]);

    // (2) 정상 어휘를 끄는 평범한 경우도 불변식이 새로 깨지지 않는다 — 빼기는 단어 수를
    //     줄일 뿐 두 칸 교집합·전역 중복을 새로 만들 수 없다(증명: 차감은 추가가 아님).
    const normal = withVocab({
      work: { synonyms: ["창작물"], subcategories: ["소설"] },
      creature: { synonyms: ["생물"], subcategories: ["포유류"] },
    });
    expect(() =>
      mergeConceptVocab(normal, [], [
        { typeName: "work", slot: "synonyms", value: "창작물" },
        { typeName: "creature", slot: "subcategories", value: "포유류" },
      ]),
    ).not.toThrow();
  });

  test("3번째 인자 생략 시 차감 0(기존 호출 호환)", () => {
    const yaml = withVocab({ work: { synonyms: ["창작물"] } });
    const merged = mergeConceptVocab(yaml, []);
    expect(merged.get("work")!.synonyms).toEqual(["창작물"]);
  });
});

describe("partitionOrphanClassifyRows — 읽기 관용의 이음매(엄격 병합은 그대로)", () => {
  const entries: ClassifyVocabUserEntryLike[] = [
    { typeName: "work", slot: "synonyms", value: "정상" },
    { typeName: "ghost", slot: "synonyms", value: "고아1" },
    { typeName: "ghost", slot: "item_synonym", value: "대표\t별칭" },
    { typeName: "phantom", slot: "columns", value: "칸" },
  ];
  const tombstones = [
    { typeName: "ghost", slot: "synonyms" as const, value: "끈값" },
    { typeName: "work", slot: "synonyms" as const, value: "창작물" },
  ];

  test("미등록 종류 행·가림표를 걸러 내고 종류별 개수를 센다(입력 불변)", () => {
    const out = partitionOrphanClassifyRows(entries, tombstones);
    expect(out.entries).toEqual([entries[0]!]);
    expect(out.tombstones).toEqual([tombstones[1]!]);
    expect(out.orphans.get("ghost")).toEqual({ entries: 2, tombstones: 1 });
    expect(out.orphans.get("phantom")).toEqual({ entries: 1, tombstones: 0 });
    expect(entries).toHaveLength(4);
  });

  test("걸러 낸 입력은 병합이 통과하고, 거르기 전 입력은 여전히 엄격하게 throw 한다(쓰기 검증 유지)", () => {
    const yaml = withVocab({});
    expect(() => mergeConceptVocab(yaml, entries, tombstones)).toThrow("등록되지 않은 배치 타입");
    expect(() => buildItemSynonymMap(entries)).toThrow("등록되지 않은 배치 타입");
    const out = partitionOrphanClassifyRows(entries, tombstones);
    expect(() => mergeConceptVocab(yaml, out.entries, out.tombstones)).not.toThrow();
    expect(() => buildItemSynonymMap(out.entries)).not.toThrow();
  });
});
