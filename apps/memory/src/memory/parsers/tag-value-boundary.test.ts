/**
 * tag-value-boundary.test.ts — `#키:값` 값 경계 단일 출처 단위 검증(방식 ②·결정 4).
 *
 * 경계 규칙 = valueStart 부터 다음 쉼표/줄바꿈/`#`, 없으면 줄 끝. 앞뒤 공백 trim.
 * parseClassificationTags·parseDirectFieldTags 가 한 규칙으로 수렴한다(채널 분기 0).
 * 순수 함수라 fixture(입력→출력)만으로 검증한다.
 */

import { describe, expect, test } from "bun:test";
import {
  extractTagValueForKey,
  extractValueToBoundary,
} from "./tag-value-boundary.ts";

describe("extractValueToBoundary", () => {
  test("쉼표 경계 — 다음 쉼표까지 통째로(띄어쓰기 보존)", () => {
    const text = "#소설:데뷔 못 하면 죽는 병 걸림, 본문";
    const valueStart = text.indexOf(":") + 1;
    expect(extractValueToBoundary(text, valueStart)).toBe("데뷔 못 하면 죽는 병 걸림");
  });

  test("줄바꿈 경계 — 쉼표 없으면 줄 끝까지", () => {
    const text = "#앱:바라 메모리 모듈\n다음 줄";
    const valueStart = text.indexOf(":") + 1;
    expect(extractValueToBoundary(text, valueStart)).toBe("바라 메모리 모듈");
  });

  test("줄 끝 경계 — 쉼표·줄바꿈 둘 다 없으면 문자열 끝까지", () => {
    const text = "#장소:강남 A마트";
    const valueStart = text.indexOf(":") + 1;
    expect(extractValueToBoundary(text, valueStart)).toBe("강남 A마트");
  });

  test("앞뒤 공백 trim", () => {
    const text = "#금액:  28000원  , 끝";
    const valueStart = text.indexOf(":") + 1;
    expect(extractValueToBoundary(text, valueStart)).toBe("28000원");
  });

  test("다음 # 경계 — 띄어쓰기로 나열한 태그가 서로 안 섞인다", () => {
    const text = "#언어:TypeScript #런타임:Bun";
    const valueStart = text.indexOf(":") + 1;
    expect(extractValueToBoundary(text, valueStart)).toBe("TypeScript");
  });

  test("키별 값 추출 — 모든 콜론 태그 값은 쉼표/다음 # 전까지 공백을 보존한다", () => {
    const novel = "#소설:데뷔 못 하면 죽는 병 걸림, 좋았다";
    expect(extractTagValueForKey(novel, novel.indexOf(":") + 1, "소설")).toBe(
      "데뷔 못 하면 죽는 병 걸림",
    );

    const runtime = "#런타임:Bun 오늘 작업, 완료";
    expect(extractTagValueForKey(runtime, runtime.indexOf(":") + 1, "런타임")).toBe(
      "Bun 오늘 작업",
    );
  });
});
