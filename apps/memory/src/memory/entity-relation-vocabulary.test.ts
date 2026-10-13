/**
 * entity-relation-vocabulary.test.ts — 4단계 Task 2 동행 테스트.
 *
 * 순수 함수·상수 검증 + 두 종류의 정합 가드:
 *   (A) 2단계 어휘 정합 — 관계 키가 그 source 타입의 concept_type_vocabulary.yaml
 *       attributes 안에 들어 있는지(없으면 yaml 에 빠진 것·plan 정합 요구).
 *   (B) 칸/라벨/관계 3분법 분할 가드(spec §3) — 한 타입 attributes 가 칸(columnLabels·
 *       registry) ∪ 관계키(RELATION_TAG_KEYS) ∪ 라벨키 로 깨끗이 갈리는지. 겹침 0·
 *       관계 키가 전부 attributes 안에 있음.
 *
 * Mock 0 — 실제 registry·실제 yaml 로더를 읽어 데이터 대조만 한다.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  ENTITY_RELATION_NAMES,
  SEED_RELATION_NAMES,
  RELATION_TAG_KEYS,
  SEED_RELATION_TAG_KEYS,
  assertRelationName,
  lookupRelationTag,
  relationTagKeySet,
  setRelationVocabOverride,
  resetRelationVocabCache,
  type RelationSpec,
} from "./entity-relation-vocabulary.ts";
import {
  loadConceptTypeVocabulary,
  placementTypeNames,
  setEntityTypeOverride,
  resetConceptTypeVocabularyCache,
  type PlacementTypeName,
} from "./concept-type-vocabulary.ts";
import {
  ENTITY_TYPE_METAS,
  type EntityTypeName,
} from "../db/store-internal/entity-type-registry.ts";
import { loadRelationVocabularySeed } from "./relation-vocab/relation-vocab-loader.ts";
import { mergeRelationVocab } from "./relation-vocab/relation-vocab-merge.ts";

// 동적화 케이스가 주입을 얹은 뒤 매번 씨앗 fallback 으로 되돌린다(다른 suite·케이스
// 오염 0). setRelationVocabOverride(null) = 미부팅 거동(씨앗만) 복귀.
afterEach(() => {
  setRelationVocabOverride(null);
  resetRelationVocabCache();
  setEntityTypeOverride([]);
  resetConceptTypeVocabularyCache();
});

describe("ENTITY_RELATION_NAMES — 기본 관계명 7개", () => {
  test("정확히 7개·기본 seed 그대로(새 관계 발명 0)", () => {
    expect([...ENTITY_RELATION_NAMES]).toEqual([
      "created_by",
      "owned_by",
      "related_person",
      "located_at",
      "participated_by",
      "family_of",
      "friend_of",
    ]);
  });

  test("중복 없음", () => {
    expect(new Set(ENTITY_RELATION_NAMES).size).toBe(ENTITY_RELATION_NAMES.length);
  });
});

describe("assertRelationName — unknown 은 loud throw(silent fallback 0)", () => {
  test("허용 관계명은 통과", () => {
    for (const name of ENTITY_RELATION_NAMES) {
      expect(() => assertRelationName(name)).not.toThrow();
    }
  });

  test("unknown 관계명은 식별자 담아 throw", () => {
    expect(() => assertRelationName("invented_relation")).toThrow(/invented_relation/);
  });

  test("빈 문자열도 throw(빈 결과로 위장 0)", () => {
    expect(() => assertRelationName("")).toThrow();
  });
});

describe("RELATION_TAG_KEYS — 한국어 키 → 관계명/타입 매핑(spec §7.2)", () => {
  const cases: Array<{
    key: string;
    relation: string;
    source: PlacementTypeName[];
    target: PlacementTypeName[];
    defaultTarget: PlacementTypeName;
  }> = [
    { key: "창작자", relation: "created_by", source: ["work"], target: ["person"], defaultTarget: "person" },
    { key: "제작자", relation: "created_by", source: ["work"], target: ["person"], defaultTarget: "person" },
    { key: "작가", relation: "created_by", source: ["work"], target: ["person"], defaultTarget: "person" },
    { key: "만든사람", relation: "created_by", source: ["work"], target: ["person"], defaultTarget: "person" },
    { key: "주인", relation: "owned_by", source: ["creature"], target: ["person"], defaultTarget: "person" },
    { key: "참여자", relation: "participated_by", source: ["project"], target: ["person"], defaultTarget: "person" },
    { key: "관련사람", relation: "related_person", source: ["schedule", "usable", "intake"], target: ["person"], defaultTarget: "person" },
    { key: "관련장소", relation: "located_at", source: ["schedule"], target: ["place"], defaultTarget: "place" },
    { key: "가족", relation: "family_of", source: ["person"], target: ["person"], defaultTarget: "person" },
    { key: "친구", relation: "friend_of", source: ["person"], target: ["person"], defaultTarget: "person" },
  ];

  test("정확히 10개 키(기본 7 + 창작자 동의어 3개)", () => {
    expect(Object.keys(RELATION_TAG_KEYS).sort()).toEqual(cases.map((c) => c.key).sort());
  });

  test("창작자·제작자·작가·만든사람 네 키가 같은 RelationSpec 객체를 공유(단일 출처)", () => {
    const shared = RELATION_TAG_KEYS["창작자"];
    expect(RELATION_TAG_KEYS["제작자"]).toBe(shared);
    expect(RELATION_TAG_KEYS["작가"]).toBe(shared);
    expect(RELATION_TAG_KEYS["만든사람"]).toBe(shared);
  });

  for (const c of cases) {
    test(`'${c.key}' → ${c.relation} (${c.source.join("/")}→${c.target.join("/")})`, () => {
      const spec = RELATION_TAG_KEYS[c.key];
      expect(spec).toBeDefined();
      expect(spec!.relation).toBe(c.relation as RelationSpec["relation"]);
      expect([...spec!.sourceTypes].sort()).toEqual([...c.source].sort());
      expect([...spec!.targetTypes].sort()).toEqual([...c.target].sort());
      expect(spec!.defaultTargetType).toBe(c.defaultTarget);
    });
  }

  test("모든 spec.relation 이 허용 관계명에 속함", () => {
    for (const spec of Object.values(RELATION_TAG_KEYS)) {
      expect(() => assertRelationName(spec.relation)).not.toThrow();
    }
  });

  test("defaultTargetType 은 항상 targetTypes 안에 있음(거짓 기본 타입 0)", () => {
    for (const spec of Object.values(RELATION_TAG_KEYS)) {
      expect(spec.targetTypes).toContain(spec.defaultTargetType);
    }
  });

  test("모든 source/target 타입이 배치 가능 타입(registry+person/project)", () => {
    const valid = new Set<string>(placementTypeNames());
    for (const spec of Object.values(RELATION_TAG_KEYS)) {
      for (const t of [...spec.sourceTypes, ...spec.targetTypes]) {
        expect(valid.has(t)).toBe(true);
      }
    }
  });
});

describe("relationTagKeySet — 관계 키 집합", () => {
  test("RELATION_TAG_KEYS 키 10개를 그대로 담음", () => {
    const set = relationTagKeySet();
    expect(set.size).toBe(10);
    for (const k of Object.keys(RELATION_TAG_KEYS)) expect(set.has(k)).toBe(true);
  });

  test("창작자 동의어 세 키가 모두 집합에 포함", () => {
    const set = relationTagKeySet();
    expect(set.has("제작자")).toBe(true);
    expect(set.has("작가")).toBe(true);
    expect(set.has("만든사람")).toBe(true);
  });
});

describe("lookupRelationTag — 소문자 정규화·관계 아니면 null", () => {
  test("관계 키는 RelationSpec 반환", () => {
    expect(lookupRelationTag("창작자")?.relation).toBe("created_by");
    expect(lookupRelationTag("관련장소")?.relation).toBe("located_at");
  });

  test("창작자 동의어(제작자·작가·만든사람)도 created_by work→person 으로 떨어짐", () => {
    for (const key of ["창작자", "제작자", "작가", "만든사람"]) {
      const spec = lookupRelationTag(key);
      expect(spec?.relation).toBe("created_by");
      expect([...(spec?.sourceTypes ?? [])]).toEqual(["work"]);
      expect([...(spec?.targetTypes ?? [])]).toEqual(["person"]);
      expect(spec?.defaultTargetType).toBe("person");
    }
  });

  test("관계 키 아닌 태그(장르·유통기한)는 null", () => {
    expect(lookupRelationTag("장르")).toBeNull();
    expect(lookupRelationTag("유통기한")).toBeNull();
    expect(lookupRelationTag("주소")).toBeNull();
  });

  test("빈 키·공백은 null(거짓 매칭 0)", () => {
    expect(lookupRelationTag("")).toBeNull();
  });

  test("소문자 정규화 — 영어 키는 대소문자 무관(parseTags 정합)", () => {
    // 현재 관계 키는 한국어라 toLowerCase 영향 0 — 한국어 키가 그대로 매칭됨을 가드.
    expect(lookupRelationTag("창작자")).toBe(lookupRelationTag("창작자"));
    // 영어가 섞여도 안전: 등록 안 된 영어 키는 null(거짓 매칭 0).
    expect(lookupRelationTag("CREATOR")).toBeNull();
  });
});

describe("(A) 2단계 어휘 정합 — 관계 키가 source 타입 yaml 어휘(attributes 또는 subcategories)에 있음", () => {
  const vocab = loadConceptTypeVocabulary();

  // 관계 키는 그 source 타입의 yaml 어휘에 정의돼 있어야 한다(없으면 yaml 에 빠진 것).
  // 대부분은 라벨 키라 attributes 에 들어 있지만(창작자·주인…), 가족·친구는 분류
  // 키이면서 관계 키인 의도적 겹침이라 subcategories 에 산다(spec 2026-06-14 §2). 그래서
  // attributes 든 subcategories 든 어느 한쪽에 있으면 "yaml 이 이 관계 키를 안다"가 충족된다.
  for (const [key, spec] of Object.entries(RELATION_TAG_KEYS)) {
    for (const sourceType of spec.sourceTypes) {
      test(`'${key}' 가 '${sourceType}' 어휘(attributes∪subcategories)에 있음`, () => {
        const v = vocab.get(sourceType);
        expect(v).toBeDefined();
        const known = v!.attributes.includes(key) || v!.subcategories.includes(key);
        expect(known).toBe(true);
      });
    }
  }
});

describe("(B) 칸/라벨/관계 3분법 분할 가드 — 겹침 0·관계키 누락 0", () => {
  const vocab = loadConceptTypeVocabulary();
  const metaByType = new Map<EntityTypeName, (typeof ENTITY_TYPE_METAS)[number]>(
    ENTITY_TYPE_METAS.map((m) => [m.typeName, m]),
  );

  // 각 타입의 attributes(yaml) 안에 든 관계 키를 source 기준으로 모아 둔다.
  function relationKeysForType(typeName: PlacementTypeName): Set<string> {
    const out = new Set<string>();
    for (const [key, spec] of Object.entries(RELATION_TAG_KEYS)) {
      if (spec.sourceTypes.includes(typeName)) out.add(key);
    }
    return out;
  }

  test("관계 키는 어느 타입에서도 칸(columnLabels) 과 겹치지 않음", () => {
    for (const meta of ENTITY_TYPE_METAS) {
      const columnKeys = new Set(Object.keys(meta.columnLabels));
      const relationKeys = relationKeysForType(meta.typeName);
      for (const rk of relationKeys) {
        expect(columnKeys.has(rk)).toBe(false);
      }
    }
  });

  // 각 8 타입에서: attributes = columnLabels(칸) ∪ relationKeys(관계) ∪ 라벨키.
  // 칸과 관계는 attributes 안에서도 갈래가 갈리고(겹침 0), 나머지가 라벨키다.
  for (const meta of ENTITY_TYPE_METAS) {
    test(`'${meta.typeName}' attributes 가 칸∪관계∪라벨로 깨끗이 갈림(겹침 0)`, () => {
      const v = vocab.get(meta.typeName)!;
      const attrs = new Set(v.attributes);
      const columnKeys = Object.keys(meta.columnLabels);
      const relationKeys = [...relationKeysForType(meta.typeName)];

      // 칸 키는 attributes 에 들어 있을 수도(유통기한) 없을 수도(주소) 있다 —
      // 칸 권위는 columnLabels 이므로 attributes 포함은 강제하지 않는다.
      // 관계 키는 (A) 가드로 반드시 attributes 안에 있다.
      for (const rk of relationKeys) {
        expect(attrs.has(rk)).toBe(true);
      }

      // 칸 ∩ 관계 = 0 (한 키가 칸이면서 관계인 경우 없음).
      const columnSet = new Set(columnKeys);
      for (const rk of relationKeys) expect(columnSet.has(rk)).toBe(false);

      // 라벨키 = attributes − 칸 − 관계. 음수 없음(관계키는 전부 attributes 안)을 확인.
      const labelKeys = [...attrs].filter(
        (a) => !columnSet.has(a) && !relationKeys.includes(a),
      );
      // 라벨키 개수 = attributes − (attributes∩칸) − 관계키 (셋이 서로 안 겹침).
      const attrsInColumns = columnKeys.filter((c) => attrs.has(c)).length;
      expect(labelKeys.length).toBe(attrs.size - attrsInColumns - relationKeys.length);
    });
  }

  test("metaByType 가 8 타입 전부 덮음(가드 누락 0)", () => {
    expect(metaByType.size).toBe(8);
  });
});

// ── 분류 단계3 T7a: 동결 해제 동적화 케이스 ──────────────────────────────────

describe("동결 해제 — 씨앗 별칭·코드 상수 보존(회귀 0)", () => {
  test("ENTITY_RELATION_NAMES 가 SEED_RELATION_NAMES 와 같은 배열(옛 이름 호환)", () => {
    expect(ENTITY_RELATION_NAMES).toBe(SEED_RELATION_NAMES);
  });

  test("RELATION_TAG_KEYS 가 SEED_RELATION_TAG_KEYS 와 같은 객체(옛 이름 호환)", () => {
    expect(RELATION_TAG_KEYS).toBe(SEED_RELATION_TAG_KEYS);
  });
});

describe("assertRelationName — 동적 화이트리스트(씨앗 7개 ∪ DB)", () => {
  test("주입 전(미부팅) = 씨앗 7개만 통과·미등록 throw(byte 동일 거동)", () => {
    for (const name of SEED_RELATION_NAMES) {
      expect(() => assertRelationName(name)).not.toThrow();
    }
    expect(() => assertRelationName("subscribed_to")).toThrow(/subscribed_to/);
  });

  test("새 관계명 주입 후 그 관계명이 통과한다(동적 합류)", () => {
    const seed = loadRelationVocabularySeed();
    const merged = mergeRelationVocab(seed, [
      {
        relationKey: "구독처",
        relationName: "subscribed_to",
        sourceTypes: ["usable"],
        targetTypes: ["person"],
        defaultTargetType: "person",
      },
    ]);
    setRelationVocabOverride(merged);
    expect(() => assertRelationName("subscribed_to")).not.toThrow();
    // 씨앗 7개도 여전히 통과(추가만·삭제 0).
    for (const name of SEED_RELATION_NAMES) {
      expect(() => assertRelationName(name)).not.toThrow();
    }
    // 여전히 미등록 관계명은 loud throw(silent fallback 0).
    expect(() => assertRelationName("invented_relation")).toThrow(/invented_relation/);
  });

  test("주입을 null 로 되돌리면 씨앗만 통과(미부팅 복귀)", () => {
    const seed = loadRelationVocabularySeed();
    setRelationVocabOverride(
      mergeRelationVocab(seed, [
        { relationKey: "구독처", relationName: "subscribed_to", sourceTypes: ["usable"], targetTypes: ["person"], defaultTargetType: "person" },
      ]),
    );
    setRelationVocabOverride(null);
    expect(() => assertRelationName("subscribed_to")).toThrow(/subscribed_to/);
  });
});

describe("relationTagKeySet / lookupRelationTag — 동적 reader(씨앗 ∪ DB)", () => {
  test("주입 전 = 씨앗 10 키만(byte 동일)", () => {
    const set = relationTagKeySet();
    expect(set.size).toBe(10);
    expect(set.has("구독처")).toBe(false);
  });

  test("새 관계 키 주입 후 relationTagKeySet·lookupRelationTag 가 본다", () => {
    const seed = loadRelationVocabularySeed();
    setRelationVocabOverride(
      mergeRelationVocab(seed, [
        { relationKey: "구독처", relationName: "subscribed_to", sourceTypes: ["usable"], targetTypes: ["person"], defaultTargetType: "person" },
      ]),
    );
    const set = relationTagKeySet();
    expect(set.size).toBe(11);
    expect(set.has("구독처")).toBe(true);
    const spec = lookupRelationTag("구독처");
    expect(spec?.relation).toBe("subscribed_to");
    expect([...(spec?.sourceTypes ?? [])]).toEqual(["usable"]);
    // 씨앗 키도 여전히 조회됨.
    expect(lookupRelationTag("창작자")?.relation).toBe("created_by");
  });

  test("관계 키 아닌 태그는 주입 후에도 null(거짓 매칭 0)", () => {
    const seed = loadRelationVocabularySeed();
    setRelationVocabOverride(
      mergeRelationVocab(seed, [
        { relationKey: "구독처", relationName: "subscribed_to", sourceTypes: ["usable"], targetTypes: ["person"], defaultTargetType: "person" },
      ]),
    );
    expect(lookupRelationTag("장르")).toBeNull();
    expect(lookupRelationTag("")).toBeNull();
  });
});

describe("RelationSpec.source/target 새 종류 합류(D3 정합)", () => {
  test("새 종류를 명부에 주입하면 새 관계의 source 가 새 종류일 수 있다", () => {
    setEntityTypeOverride([{ typeName: "subscription", koName: "구독" }]);
    resetConceptTypeVocabularyCache();
    const seed = loadRelationVocabularySeed();
    const merged = mergeRelationVocab(seed, [
      {
        relationKey: "구독대상",
        relationName: "subscribed_to",
        sourceTypes: ["subscription"],
        targetTypes: ["person"],
        defaultTargetType: "person",
      },
    ]);
    setRelationVocabOverride(merged);
    const spec = lookupRelationTag("구독대상");
    // 새 종류는 PlacementTypeName union 밖이라(동적 명부 비대칭) string 으로 비교한다.
    expect((spec?.sourceTypes ?? []) as readonly string[]).toContain("subscription");
  });
});

describe("(B') 3분법 분할 가드 — 새 관계명 추가 후에도 칸/라벨/관계 겹침 0(D12)", () => {
  test("새 관계명을 주입해도 기존 8 타입의 칸 ∩ 관계 = 0 유지", () => {
    const seed = loadRelationVocabularySeed();
    // 새 관계명(work source)을 더한 병합본을 주입한다.
    setRelationVocabOverride(
      mergeRelationVocab(seed, [
        { relationKey: "출연자", relationName: "performed_by", sourceTypes: ["work"], targetTypes: ["person"], defaultTargetType: "person" },
      ]),
    );

    function relationKeysForType(typeName: PlacementTypeName): Set<string> {
      const out = new Set<string>();
      for (const key of relationTagKeySet()) {
        const spec = lookupRelationTag(key);
        if (spec && spec.sourceTypes.includes(typeName)) out.add(key);
      }
      return out;
    }

    for (const meta of ENTITY_TYPE_METAS) {
      const columnKeys = new Set(Object.keys(meta.columnLabels));
      const relationKeys = relationKeysForType(meta.typeName);
      // 새 관계 키 '출연자'(work)도 칸과 겹치지 않아야 한다.
      for (const rk of relationKeys) {
        expect(columnKeys.has(rk)).toBe(false);
      }
    }
    // work 의 관계 키에 새 '출연자' 가 합류했음을 확인(주입이 실제로 보임).
    expect(relationKeysForType("work").has("출연자")).toBe(true);
  });
});
