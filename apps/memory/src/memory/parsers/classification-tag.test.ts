/**
 * classification-tag.test.ts — Phase 11b T1.
 *
 * `#category:value` colon 양식 정규식 파서 단위 검증. 8 case 는 plan 권위 그대로
 * (parser 단위 — DB·임베딩 의존 0).
 *
 *  (1) 한 가지 colon 양식
 *  (2) 여러 + 평면 해시태그 제외
 *  (3) 영어 + 한국어 섞임
 *  (4) 숫자·언더스코어·하이픈 값
 *  (5) 빈 category 또는 빈 value = 무시
 *  (6) 공백을 값으로 보존
 *  (7) 빈 글자
 *  (8) 해시태그 0개
 */

import { describe, test, expect } from "bun:test";
import { parseClassificationTags } from "./classification-tag.ts";

describe("parseClassificationTags", () => {
  test("한 가지 colon 양식 매치", () => {
    expect(parseClassificationTags("#character:흰머리토끼귀")).toEqual([
      { category: "character", value: "흰머리토끼귀", rawCategory: "character" },
    ]);
  });

  test("여러 colon 양식 매치 + 평면 해시태그 제외(띄어쓰기 나열·방식 ②)", () => {
    // 방식 ②: 값 경계가 다음 `#` 라, 띄어쓰기로 나열한 태그가 서로 안 섞인다.
    // 평면 해시태그(#봄)는 콜론이 없어 키 정규식이 안 잡아 산출에서 빠진다.
    const result = parseClassificationTags(
      "새 그림 #character:흰머리토끼귀 #style:수채화 #봄 #mood:포근함",
    );
    expect(result).toEqual([
      { category: "character", value: "흰머리토끼귀", rawCategory: "character" },
      { category: "style", value: "수채화", rawCategory: "style" },
      { category: "mood", value: "포근함", rawCategory: "mood" },
    ]);
  });

  test("영어 + 한국어 섞임(띄어쓰기 나열·방식 ②)", () => {
    expect(parseClassificationTags("#artist:김작가 #series:NEST")).toEqual([
      { category: "artist", value: "김작가", rawCategory: "artist" },
      { category: "series", value: "NEST", rawCategory: "series" },
    ]);
  });

  test("숫자·언더스코어·하이픈 값(띄어쓰기 나열·방식 ②)", () => {
    // T8: 영어 약식 `char` 는 builtin 동의어 사전 안 'character' 로 정규화.
    // value 는 자연 그대로 보존 — 정규화 X.
    expect(
      parseClassificationTags("#medium:digital_2026 #char:test-char_01"),
    ).toEqual([
      { category: "medium", value: "digital_2026", rawCategory: "medium" },
      { category: "character", value: "test-char_01", rawCategory: "char" },
    ]);
  });

  test("빈 카테고리 또는 빈 값 = 무시(방식 ②)", () => {
    expect(parseClassificationTags("#:흰머리 #character: #:")).toEqual([]);
  });

  test("실데이터 — 띄어쓰기로 나열한 콜론 태그가 각각 잡힌다(방식 ②)", () => {
    const out = parseClassificationTags("#언어:TypeScript #런타임:Bun #프레임워크:Hono");
    expect(out.map((t) => t.value)).toEqual(["TypeScript", "Bun", "Hono"]);
  });

  test("긴 제목 — 쉼표 경계까지 통째로(값 안에 # 없어 안 끊김·방식 ②)", () => {
    const out = parseClassificationTags("#소설:데뷔 못 하면 죽는 병 걸림, 본문");
    expect(out).toEqual([
      { category: "소설", value: "데뷔 못 하면 죽는 병 걸림", rawCategory: "소설" },
    ]);
  });

  test("짧은 속성 값도 쉼표 전까지 공백을 값으로 보존한다", () => {
    const out = parseClassificationTags("#언어:typescript 첫 회의 메모");
    expect(out).toEqual([
      { category: "언어", value: "typescript 첫 회의 메모", rawCategory: "언어" },
    ]);
  });

  test("예약 alias 키도 쉼표 전까지 공백을 값으로 보존한다", () => {
    const out = parseClassificationTags("#닉네임:민짱 자기소개 글");
    expect(out).toEqual([
      { category: "닉네임", value: "민짱 자기소개 글", rawCategory: "닉네임" },
    ]);
  });

  test("쉼표로 구분된 여러 콜론 태그", () => {
    const out = parseClassificationTags("#가계부:미용, #금액:28000원, 투블럭");
    expect(out.map((t) => t.value)).toEqual(["미용", "28000원"]);
  });

  test("빈 글자", () => {
    expect(parseClassificationTags("")).toEqual([]);
  });

  test("해시태그 0개", () => {
    expect(parseClassificationTags("순수 글자만 적은 메시지")).toEqual([]);
  });

  // T8 회귀 — builtin 동의어 사전 안 category 정규화 합류.
  test("T8: 한국어 동의어 category → canonical 정규화", () => {
    expect(parseClassificationTags("#캐릭터:흰머리토끼귀")).toEqual([
      { category: "character", value: "흰머리토끼귀", rawCategory: "캐릭터" },
    ]);
  });

  test("T8: 대소문자 무관 + 동의어 정규화", () => {
    expect(parseClassificationTags("#STYLE:애니풍")).toEqual([
      { category: "style", value: "애니풍", rawCategory: "STYLE" },
    ]);
  });
});
