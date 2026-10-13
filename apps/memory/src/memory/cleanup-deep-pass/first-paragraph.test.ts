/**
 * 첫 문단 fallback 순수 함수 테스트 — 데이터 입력 fixture 검증 (mock 0).
 *
 * spec §3.3 (첫 문단 fallback) · plan Task 3 정합. DB·LLM 의존 없는 순수 함수라
 * 데이터를 넣고 출력을 본다.
 */

import { describe, expect, it } from "bun:test";
import {
  extractFirstParagraph,
  TRUNCATION_MARKER,
} from "./first-paragraph.ts";

describe("extractFirstParagraph — 문단 경계", () => {
  it("여러 문단이면 첫 문단만 떼낸다 (빈 줄 경계 전까지)", () => {
    const content = "첫 문단입니다.\n\n둘째 문단입니다.\n\n셋째 문단.";
    expect(extractFirstParagraph(content, 200)).toBe("첫 문단입니다.");
  });

  it("빈 줄 경계가 없으면 전체를 첫 문단으로 본다 (한 문단 청크)", () => {
    const content = "경계 없는 짧은 청크 한 줄.\n바로 다음 줄(빈 줄 아님).";
    expect(extractFirstParagraph(content, 200)).toBe(content);
  });

  it("문단 앞뒤 공백·줄바꿈을 trim 한다", () => {
    const content = "   \n  첫 문단 공백 둘러쌈.  \n\n둘째 문단.";
    expect(extractFirstParagraph(content, 200)).toBe("첫 문단 공백 둘러쌈.");
  });

  it("선행 빈 문단(빈 줄 먼저)은 건너뛰고 첫 실제 문단을 떼낸다", () => {
    const content = "\n\n\n실제 첫 문단.\n\n둘째.";
    expect(extractFirstParagraph(content, 200)).toBe("실제 첫 문단.");
  });
});

describe("extractFirstParagraph — 한도 초과 자름 (자른 표시)", () => {
  it("첫 문단이 한도를 넘으면 문장 경계에서 자르고 자른 표시를 붙인다", () => {
    // 두 문장. 첫 문장까지가 한도 안, 둘째 문장을 더하면 초과.
    const content = "첫 문장이다. 둘째 문장은 한도를 넘기는 긴 꼬리를 단다.";
    const maxChars = 12; // "첫 문장이다." = 6자 → 첫 문장 경계에서 멈춤
    const result = extractFirstParagraph(content, maxChars);
    expect(result).toBe("첫 문장이다." + TRUNCATION_MARKER);
    // 자른 표시를 뺀 본문은 원문 접두사여야 한다 (데이터 위조 0).
    const body = result.slice(0, -TRUNCATION_MARKER.length);
    expect(content.startsWith(body)).toBe(true);
  });

  it("문장 경계가 한도 안에 없으면 글자 한도에서 자르고 자른 표시를 붙인다", () => {
    // 경계 부호 없는 한국어 연속 글자.
    const content = "가나다라마바사아자차카타파하거너더러머버서어저처";
    const maxChars = 10;
    const result = extractFirstParagraph(content, maxChars);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
    const body = result.slice(0, -TRUNCATION_MARKER.length);
    expect(body.length).toBe(maxChars);
    expect(content.startsWith(body)).toBe(true);
  });

  it("'다.' 한국어 종결 경계도 문장 경계로 인식한다", () => {
    const content = "오늘 회의를 했다. 다음 일정은 미정이며 긴 설명이 이어진다.";
    const maxChars = 12; // "오늘 회의를 했다." = 10자
    const result = extractFirstParagraph(content, maxChars);
    expect(result).toBe("오늘 회의를 했다." + TRUNCATION_MARKER);
  });

  it("첫 문단이 한도 이하면 자르지 않고 자른 표시도 안 붙인다", () => {
    const content = "짧은 첫 문단.";
    const result = extractFirstParagraph(content, 200);
    expect(result).toBe("짧은 첫 문단.");
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(false);
  });

  it("한도가 정확히 첫 문단 길이와 같으면 자르지 않는다 (경계 포함)", () => {
    const content = "정확히맞는길이"; // 7자
    expect(extractFirstParagraph(content, 7)).toBe("정확히맞는길이");
  });
});

describe("extractFirstParagraph — 빈 입력 (정직한 빈 결과)", () => {
  it("빈 문자열 입력 → 빈 문자열", () => {
    expect(extractFirstParagraph("", 200)).toBe("");
  });

  it("공백·줄바꿈뿐인 입력 → 빈 문자열", () => {
    expect(extractFirstParagraph("   \n\n  \t  \n", 200)).toBe("");
  });

  it("한도가 0 이하면 빈 문자열 (자를 글자 0 — 정직한 빈 결과)", () => {
    expect(extractFirstParagraph("내용이 있다.", 0)).toBe("");
    expect(extractFirstParagraph("내용이 있다.", -5)).toBe("");
  });
});
