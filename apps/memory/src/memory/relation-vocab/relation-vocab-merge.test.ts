/**
 * relation-vocab-merge.test.ts — 관계명 yaml 씨앗 + DB 병합 + 3분법 가드 동행 테스트
 * (분류 단계3 T7a · D11·D12).
 *
 * Mock 0 — 실제 yaml 로더 씨앗 + 데이터 fixture(DB 행 모양)로 순수 병합 함수를 본다.
 * 새 종류 source/target 합류는 setEntityTypeOverride 로 동적 명부를 주입해 검증한다.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  mergeRelationVocab,
  mergeRelationVocabSkippingOrphans,
  partitionOrphanRelationEntries,
  checkRelationKeyTrichotomyConflict,
  type RelationNameUserEntryLike,
} from "./relation-vocab-merge.ts";
import { loadRelationVocabularySeed } from "./relation-vocab-loader.ts";
import {
  SEED_RELATION_TAG_KEYS,
  SEED_RELATION_NAMES,
} from "../entity-relation-vocabulary.ts";
import {
  setEntityTypeOverride,
  resetConceptTypeVocabularyCache,
} from "../concept-type-vocabulary.ts";

const seed = loadRelationVocabularySeed();

afterEach(() => {
  // 새 종류 주입을 매 테스트 뒤 비워 다른 suite 오염 0(빈 명부 복귀).
  setEntityTypeOverride([]);
  resetConceptTypeVocabularyCache();
});

describe("mergeRelationVocab — 빈 DB = 씨앗 그대로(byte 동일·회귀 0)", () => {
  test("DB 0개면 씨앗 10 키 그대로", () => {
    const merged = mergeRelationVocab(seed, []);
    expect(Object.keys(merged).sort()).toEqual(Object.keys(SEED_RELATION_TAG_KEYS).sort());
  });

  test("씨앗 각 키의 spec 이 코드 상수와 동일(병합이 안 바꿈)", () => {
    const merged = mergeRelationVocab(seed, []);
    for (const [key, codeSpec] of Object.entries(SEED_RELATION_TAG_KEYS)) {
      const m = merged[key];
      expect(m).toBeDefined();
      expect(m!.relation).toBe(codeSpec.relation);
      expect([...m!.sourceTypes].sort()).toEqual([...codeSpec.sourceTypes].sort());
      expect([...m!.targetTypes].sort()).toEqual([...codeSpec.targetTypes].sort());
      expect(m!.defaultTargetType).toBe(codeSpec.defaultTargetType);
    }
  });

  test("씨앗이 만드는 관계명 == SEED_RELATION_NAMES 7개", () => {
    const merged = mergeRelationVocab(seed, []);
    const names = new Set(Object.values(merged).map((s) => s.relation));
    expect([...names].sort()).toEqual([...SEED_RELATION_NAMES].sort());
  });
});

describe("mergeRelationVocab — DB 새 관계명 합류(기존 종류 source/target)", () => {
  test("새 관계 키가 씨앗 옆에 합류한다", () => {
    const userEntries: RelationNameUserEntryLike[] = [
      {
        relationKey: "출연자",
        relationName: "performed_by",
        sourceTypes: ["work"],
        targetTypes: ["person"],
        defaultTargetType: "person",
      },
    ];
    const merged = mergeRelationVocab(seed, userEntries);
    expect(merged["출연자"]).toBeDefined();
    expect(merged["출연자"]!.relation).toBe("performed_by");
    expect([...merged["출연자"]!.sourceTypes]).toEqual(["work"]);
    // 씨앗도 여전히 살아 있다(추가만·삭제 0).
    expect(merged["창작자"]).toBeDefined();
  });

  test("새 관계 키가 씨앗 키와 겹치면 충돌 throw(씨앗 재정의 금지)", () => {
    const userEntries: RelationNameUserEntryLike[] = [
      {
        relationKey: "창작자",
        relationName: "made_by",
        sourceTypes: ["work"],
        targetTypes: ["person"],
        defaultTargetType: "person",
      },
    ];
    expect(() => mergeRelationVocab(seed, userEntries)).toThrow(/창작자/);
  });

  test("미등록 source/target 타입은 throw(식별자 담음·silent skip 0)", () => {
    const userEntries: RelationNameUserEntryLike[] = [
      {
        relationKey: "키",
        relationName: "rel_x",
        sourceTypes: ["nonexistent_type"],
        targetTypes: ["person"],
        defaultTargetType: "person",
      },
    ];
    expect(() => mergeRelationVocab(seed, userEntries)).toThrow(/nonexistent_type/);
  });

  test("defaultTargetType 가 targetTypes 밖이면 throw(거짓 기본 타입)", () => {
    const userEntries: RelationNameUserEntryLike[] = [
      {
        relationKey: "키",
        relationName: "rel_x",
        sourceTypes: ["work"],
        targetTypes: ["person"],
        defaultTargetType: "place",
      },
    ];
    expect(() => mergeRelationVocab(seed, userEntries)).toThrow(/defaultTargetType/);
  });

  test("빈 source/target 는 throw", () => {
    expect(() =>
      mergeRelationVocab(seed, [
        { relationKey: "키", relationName: "r", sourceTypes: [], targetTypes: ["person"], defaultTargetType: "person" },
      ]),
    ).toThrow(/sourceTypes/);
    expect(() =>
      mergeRelationVocab(seed, [
        { relationKey: "키", relationName: "r", sourceTypes: ["work"], targetTypes: [], defaultTargetType: "person" },
      ]),
    ).toThrow(/targetTypes/);
  });
});

describe("mergeRelationVocab — 새 종류(entity_types) source/target 합류(D3 정합)", () => {
  test("새 종류를 명부에 주입하면 그 종류가 source/target 로 통과한다", () => {
    setEntityTypeOverride([{ typeName: "subscription", koName: "구독" }]);
    resetConceptTypeVocabularyCache();
    const userEntries: RelationNameUserEntryLike[] = [
      {
        relationKey: "구독대상",
        relationName: "subscribed_to",
        sourceTypes: ["subscription"],
        targetTypes: ["person", "work"],
        defaultTargetType: "person",
      },
    ];
    const merged = mergeRelationVocab(seed, userEntries);
    // 새 종류는 PlacementTypeName union 밖이라(동적 명부 비대칭) string 으로 비교한다.
    expect(merged["구독대상"]!.sourceTypes as readonly string[]).toContain("subscription");
  });

  test("명부에 없는 새 종류 이름은 여전히 throw(주입 전)", () => {
    // 주입 안 함 — 'subscription' 은 미등록이라 막힌다.
    const userEntries: RelationNameUserEntryLike[] = [
      {
        relationKey: "구독대상",
        relationName: "subscribed_to",
        sourceTypes: ["subscription"],
        targetTypes: ["person"],
        defaultTargetType: "person",
      },
    ];
    expect(() => mergeRelationVocab(seed, userEntries)).toThrow(/subscription/);
  });
});

describe("checkRelationKeyTrichotomyConflict — 칸/라벨/항목 동의어 겹침 검사(D12)", () => {
  test("칸 키와 겹치면 column 충돌", () => {
    const conflict = checkRelationKeyTrichotomyConflict("주소", ["주소", "날짜"], [], []);
    expect(conflict?.kind).toBe("column");
    expect(conflict?.message).toContain("칸");
  });

  test("라벨 키와 겹치면 label 충돌", () => {
    const conflict = checkRelationKeyTrichotomyConflict("장르", [], ["장르", "유형"], []);
    expect(conflict?.kind).toBe("label");
  });

  test("항목 동의어 키와 겹치면 item_synonym 충돌", () => {
    const conflict = checkRelationKeyTrichotomyConflict("라면", [], [], ["라면", "신라면"]);
    expect(conflict?.kind).toBe("item_synonym");
  });

  test("어느 갈래와도 안 겹치면 null(정직한 통과)", () => {
    expect(checkRelationKeyTrichotomyConflict("출연자", ["주소"], ["장르"], ["라면"])).toBeNull();
  });

  test("대소문자만 다른 충돌도 잡음(소문자 정규화)", () => {
    const conflict = checkRelationKeyTrichotomyConflict("Genre", [], ["genre"], []);
    expect(conflict?.kind).toBe("label");
  });

  test("빈 키는 null", () => {
    expect(checkRelationKeyTrichotomyConflict("  ", ["주소"], [], [])).toBeNull();
  });
});

describe("고아 관계명 행 — 읽기는 관용·쓰기(엄격 병합)는 그대로", () => {
  const ok: RelationNameUserEntryLike = {
    relationKey: "정상관계", relationName: "ok_rel",
    sourceTypes: ["work"], targetTypes: ["person"], defaultTargetType: "person",
  };
  const orphanSrc: RelationNameUserEntryLike = {
    relationKey: "고아출발", relationName: "ghost_src",
    sourceTypes: ["ghost"], targetTypes: ["person"], defaultTargetType: "person",
  };
  const orphanDst: RelationNameUserEntryLike = {
    relationKey: "고아도착", relationName: "ghost_dst",
    sourceTypes: ["work"], targetTypes: ["person", "ghost"], defaultTargetType: "person",
  };

  test("partitionOrphanRelationEntries 가 source/target 의 미등록 종류를 가려낸다", () => {
    const out = partitionOrphanRelationEntries([ok, orphanSrc, orphanDst]);
    expect(out.entries).toEqual([ok]);
    expect(out.orphans.map((o) => [o.entry.relationKey, o.missingTypes])).toEqual([
      ["고아출발", ["ghost"]],
      ["고아도착", ["ghost"]],
    ]);
  });

  test("엄격 mergeRelationVocab 은 고아에 여전히 throw 한다", () => {
    expect(() => mergeRelationVocab(seed, [ok, orphanSrc])).toThrow("등록되지 않은 배치 타입");
  });

  test("mergeRelationVocabSkippingOrphans 는 고아를 건너뛰고 경고하며 정상 행은 합류시킨다", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const merged = mergeRelationVocabSkippingOrphans(seed, [ok, orphanSrc, orphanDst]);
      expect(merged["정상관계"]?.relation).toBe("ok_rel");
      expect(merged["고아출발"]).toBeUndefined();
      expect(merged["고아도착"]).toBeUndefined();
      expect(Object.keys(merged)).toHaveLength(Object.keys(mergeRelationVocab(seed, [])).length + 1);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]![0])).toContain("'고아출발'");
      expect(String(warn.mock.calls[0]![0])).toContain("'ghost'");
    } finally {
      warn.mockRestore();
    }
  });

  test("고아가 아닌 다른 결함(거짓 기본 타입)은 관용하지 않고 그대로 throw", () => {
    const bad: RelationNameUserEntryLike = { ...ok, relationKey: "나쁜관계", defaultTargetType: "work" };
    expect(() => mergeRelationVocabSkippingOrphans(seed, [bad])).toThrow("거짓 기본 타입");
  });
});
