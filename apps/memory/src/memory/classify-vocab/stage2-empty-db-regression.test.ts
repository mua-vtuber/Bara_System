/**
 * stage2-empty-db-regression.test.ts — 단계2 빈 DB 분류·라벨 보존 회귀 게이트 (단계2 T8).
 *
 * 단계2 가 더한 통로(attributes·item_synonym slot·항목 동의어 정규화 맵·로더 주입)가
 * *어휘 추가 전*(user 행 0건)에는 yaml-only 거동을 byte 동일하게 보존하는지 확정한다.
 * 사용자가 어떤 분류 어휘도 추가하지 않은 상태 = 운영 yaml 그대로여야 한다.
 * (2026-06-27 단계1 D2 — 옛 seeds slot 은 제거됐다.)
 *
 * 세 갈래로 본다:
 *   (a) mergeConceptVocab(yaml, []) 가 yaml 세 칸을 byte 동일 복제(원본 불변).
 *   (b) buildItemSynonymMap([]) 가 빈 맵(no-op).
 *   (c) 항목 동의어 override 미주입 시 getCanonicalItemKey 가 입력 그대로(no-op) →
 *       applyEntityAttributes 라벨 합류가 단계1 거동과 같다(동의어 미등록 = 변화 0).
 *
 * mock 0 — 운영 yaml + 데이터 fixture(Map)만. DB 의존 없음(순수 함수 검증).
 */
import { test, expect, afterEach } from "bun:test";
import {
  loadConceptTypeVocabulary,
  getCanonicalItemKey,
  clearConceptVocabularyOverrides,
  placementTypeNames,
} from "../concept-type-vocabulary.ts";
import {
  mergeConceptVocab,
  buildItemSynonymMap,
} from "./merge-classify-vocab.ts";

afterEach(() => {
  clearConceptVocabularyOverrides();
});

test("빈 user → mergeConceptVocab 가 yaml 세 칸을 byte 동일 복제(원본 불변)", () => {
  const yaml = loadConceptTypeVocabulary();
  const merged = mergeConceptVocab(yaml, []);
  for (const t of placementTypeNames()) {
    const a = yaml.get(t)!;
    const b = merged.get(t)!;
    expect(b.synonyms).toEqual(a.synonyms);
    expect(b.subcategories).toEqual(a.subcategories);
    expect(b.attributes).toEqual(a.attributes);
  }
  // 원본 Map·내부 배열 불변(다른 인스턴스).
  expect(merged).not.toBe(yaml);
});

test("빈 user → buildItemSynonymMap 가 빈 맵(no-op)", () => {
  expect(buildItemSynonymMap([]).size).toBe(0);
});

test("항목 동의어 override 미주입 → getCanonicalItemKey 가 입력 그대로(라벨 합류 no-op)", () => {
  // 어휘 추가 전 = 동의어 맵 비어 있음 → 모든 키가 입력 그대로(단계1 거동 보존).
  for (const t of placementTypeNames()) {
    expect(getCanonicalItemKey(t, "닉네임")).toBe("닉네임");
    expect(getCanonicalItemKey(t, "장르")).toBe("장르");
  }
});

test("item_synonym 행이 있어도 mergeConceptVocab 어휘 세 칸은 안 건드림(맵 입력일 뿐)", () => {
  const yaml = loadConceptTypeVocabulary();
  const merged = mergeConceptVocab(yaml, [
    { typeName: "person", slot: "item_synonym", value: "별명\t닉네임" },
  ]);
  // item_synonym 은 어휘 칸이 아니라 정규화 맵 입력 — person 어휘 세 칸은 yaml 그대로.
  const a = yaml.get("person")!;
  const b = merged.get("person")!;
  expect(b.synonyms).toEqual(a.synonyms);
  expect(b.subcategories).toEqual(a.subcategories);
  expect(b.attributes).toEqual(a.attributes);
});
