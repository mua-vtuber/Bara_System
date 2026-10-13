/**
 * mention-boundary.test.ts — 언급 검출 단어 경계 순수함수 단위 검증.
 *
 * findMentionedConcepts 가 순수 substring(String.includes) 대신 이 경계
 * 매칭을 쓰도록 바뀐다(Task 1 · 2b). 규칙:
 *   - 왼쪽 경계는 항상 요구한다(needle 시작 직전이 문자/숫자면 미매칭) —
 *     '김철수' 속의 '철수'가 안 걸리게 한다.
 *   - 오른쪽 경계는 ASCII needle 에만 요구한다 — 'codex' 속 'code' 오매칭을
 *     막되, 한국어는 조사가 뒤에 바로 붙으므로('둘째가'·'김철수가') 오른쪽은
 *     열어 둔다(형태소 분석은 범위 밖).
 * 순수 함수라 데이터 fixture(입력→출력)만으로 검증한다(Mock 클래스 없음).
 */

import { describe, expect, test } from "bun:test";
import { conceptNameMentioned } from "./mention-boundary.ts";

describe("conceptNameMentioned", () => {
  test("빈 needle · 빈 haystack — 미매칭", () => {
    expect(conceptNameMentioned("어제 만화를 봤다", "")).toBe(false);
    expect(conceptNameMentioned("어제 만화를 봤다", "   ")).toBe(false);
    expect(conceptNameMentioned("", "만화")).toBe(false);
  });

  test("일반 한국어 단어 — 양쪽이 문장부호/공백이면 매칭", () => {
    expect(conceptNameMentioned("어제 만화를 봤다", "만화")).toBe(true);
  });

  test("한국어 왼쪽 경계 — '김철수' 속 '철수'는 미매칭(다른 단어 속 파편)", () => {
    expect(conceptNameMentioned("김철수가 왔다", "철수")).toBe(false);
  });

  test("한국어 오른쪽 경계 생략 — 조사가 바로 붙어도 매칭('둘째가'·'김철수가')", () => {
    expect(conceptNameMentioned("둘째가 좋다", "둘째")).toBe(true);
    expect(conceptNameMentioned("김철수가 키우는 고양이", "김철수")).toBe(true);
  });

  test("ASCII 오른쪽 경계 — 'codex' 안의 'code' 는 미매칭", () => {
    expect(conceptNameMentioned("codex 는 편리하다", "code")).toBe(false);
  });

  test("ASCII 왼쪽 경계 — 'xcode' 안의 'code' 는 미매칭", () => {
    expect(conceptNameMentioned("xcode 를 켰다", "code")).toBe(false);
  });

  test("ASCII 온전한 단어 — 앞뒤가 공백/문장부호면 매칭", () => {
    expect(conceptNameMentioned("오늘도 code 를 짰다", "code")).toBe(true);
    expect(conceptNameMentioned("code, 리뷰 완료", "code")).toBe(true);
  });

  test("여러 등장 중 하나라도 경계를 만족하면 매칭", () => {
    // 첫 등장(xcode 안)은 경계 실패, 두 번째 등장(온전한 단어)은 성공.
    expect(conceptNameMentioned("xcode 대신 code 를 썼다", "code")).toBe(true);
  });

  test("문자열 시작 · 끝 경계 — 경계 밖(문자열 끝)도 정상 인식", () => {
    expect(conceptNameMentioned("code", "code")).toBe(true);
    expect(conceptNameMentioned("만화", "만화")).toBe(true);
  });

  test("대소문자 무시 — needle 대문자라도 매칭(lowerText 기준)", () => {
    expect(conceptNameMentioned("오늘도 code 를 짰다", "Code")).toBe(true);
  });

  test("불일치 — 아예 등장하지 않으면 미매칭", () => {
    expect(conceptNameMentioned("어제 만화를 봤다", "게임")).toBe(false);
  });
});
