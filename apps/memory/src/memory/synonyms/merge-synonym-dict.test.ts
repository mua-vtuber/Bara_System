/**
 * merge-synonym-dict.test.ts — 순수 병합 헬퍼 검증 (웨이브3 항목12 B2).
 *
 * 데이터 fixture(Map + 행 배열)만 사용 — mock 객체 없음(CLAUDE.md "테스트 정책").
 * 핵심: 원본 yaml Map 불변 + user 행 합류(새 term·기존 term 보강·중복 제거).
 */
import { describe, expect, test } from "bun:test";
import { mergeSynonymDict, type SynonymUserEntryLike } from "./merge-synonym-dict.ts";
import type { SynonymDictionary } from "../synonym-dictionary.ts";

function dict(entries: Record<string, string[]>): SynonymDictionary {
  return new Map(Object.entries(entries));
}

describe("mergeSynonymDict", () => {
  test("빈 user 행 — yaml 사전과 같은 내용을 돌려준다", () => {
    const yaml = dict({ 고양이: ["냥이", "야옹이"] });
    const merged = mergeSynonymDict(yaml, []);
    expect(merged.get("고양이")).toEqual(["냥이", "야옹이"]);
    expect(merged.size).toBe(1);
  });

  test("새 term — yaml 에 없던 키를 추가한다", () => {
    const yaml = dict({ 고양이: ["냥이"] });
    const entries: SynonymUserEntryLike[] = [
      { term: "강아지", synonym: "멍멍이", lang: "ko" },
    ];
    const merged = mergeSynonymDict(yaml, entries);
    expect(merged.get("강아지")).toEqual(["멍멍이"]);
    expect(merged.get("고양이")).toEqual(["냥이"]);
    expect(merged.size).toBe(2);
  });

  test("기존 term 보강 — 같은 키 배열에 user synonym 을 더한다", () => {
    const yaml = dict({ 고양이: ["냥이"] });
    const entries: SynonymUserEntryLike[] = [
      { term: "고양이", synonym: "야옹이", lang: "ko" },
    ];
    const merged = mergeSynonymDict(yaml, entries);
    expect(merged.get("고양이")).toEqual(["냥이", "야옹이"]);
  });

  test("중복 제거 — yaml 에 이미 있는 synonym 은 다시 안 들어간다", () => {
    const yaml = dict({ 고양이: ["냥이"] });
    const entries: SynonymUserEntryLike[] = [
      { term: "고양이", synonym: "냥이", lang: "ko" },
    ];
    const merged = mergeSynonymDict(yaml, entries);
    expect(merged.get("고양이")).toEqual(["냥이"]);
  });

  test("같은 user 행 중복 입력 — 한 번만 들어간다", () => {
    const yaml = dict({});
    const entries: SynonymUserEntryLike[] = [
      { term: "강아지", synonym: "멍멍이", lang: "ko" },
      { term: "강아지", synonym: "멍멍이", lang: "ko" },
    ];
    const merged = mergeSynonymDict(yaml, entries);
    expect(merged.get("강아지")).toEqual(["멍멍이"]);
  });

  test("원본 yaml Map 불변 — 키 배열까지 복제(병합이 원본을 안 건드린다)", () => {
    const yamlArr = ["냥이"];
    const yaml: SynonymDictionary = new Map([["고양이", yamlArr]]);
    mergeSynonymDict(yaml, [{ term: "고양이", synonym: "야옹이", lang: "ko" }]);
    // 원본 Map 의 배열은 그대로 길이 1.
    expect(yaml.get("고양이")).toEqual(["냥이"]);
    expect(yamlArr).toEqual(["냥이"]);
  });
});
