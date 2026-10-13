/**
 * category-synonyms.test.ts — Phase 11b T8.
 *
 * builtin yaml 사전 + recognizeCategorySynonym 정규화 단위 검증.
 * 사이드카 acceptance 5 항목 한 묶음:
 *   (1) 한국어 동의어 → canonical
 *   (2) canonical 자체 passthrough
 *   (3) 매치 없음 = 원래 값 그대로 (silent X)
 *   (4) 대소문자 무관
 *   (5) 6 카테고리 모두 한국어 가족 매치
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  recognizeCategorySynonym,
  resetCategorySynonymCache,
} from "./category-synonyms.ts";

describe("recognizeCategorySynonym", () => {
  beforeEach(() => {
    resetCategorySynonymCache();
  });

  test("한국어 동의어 → canonical character", () => {
    expect(recognizeCategorySynonym("캐릭터")).toBe("character");
  });

  test("canonical 자체 passthrough", () => {
    expect(recognizeCategorySynonym("character")).toBe("character");
  });

  test("매치 없음 = 원래 값 그대로 (정직한 passthrough)", () => {
    expect(recognizeCategorySynonym("unknown_key")).toBe("unknown_key");
    expect(recognizeCategorySynonym("zzzzz")).toBe("zzzzz");
  });

  test("대소문자 무관", () => {
    expect(recognizeCategorySynonym("Character")).toBe("character");
    expect(recognizeCategorySynonym("CHARACTER")).toBe("character");
    expect(recognizeCategorySynonym("STYLE")).toBe("style");
  });

  test("6 카테고리 모두 한국어 가족 매치", () => {
    expect(recognizeCategorySynonym("캐릭터")).toBe("character");
    expect(recognizeCategorySynonym("스타일")).toBe("style");
    expect(recognizeCategorySynonym("그림체")).toBe("style");
    expect(recognizeCategorySynonym("작가")).toBe("artist");
    expect(recognizeCategorySynonym("아티스트")).toBe("artist");
    expect(recognizeCategorySynonym("매체")).toBe("medium");
    expect(recognizeCategorySynonym("분위기")).toBe("mood");
    expect(recognizeCategorySynonym("감성")).toBe("mood");
    expect(recognizeCategorySynonym("시리즈")).toBe("series");
    expect(recognizeCategorySynonym("작품")).toBe("series");
  });

  test("영어 약식 char / cha → character", () => {
    expect(recognizeCategorySynonym("char")).toBe("character");
    expect(recognizeCategorySynonym("cha")).toBe("character");
  });

  test("빈 문자열 = 빈 문자열 그대로", () => {
    expect(recognizeCategorySynonym("")).toBe("");
  });
});
