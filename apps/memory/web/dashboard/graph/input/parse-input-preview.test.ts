/**
 * parse-input-preview.test.ts — 미리보기 클라이언트 파서 검증(S7·결정 2·5).
 *
 * 검증 축:
 *   - 쉼표/`#` 경계(② 규칙)로 종류·금액·날짜·본문 가름.
 *   - 긴 띄어쓰기 값 통째 보존(잘림 0·S1 동등).
 *   - 띄어쓰기로 나열한 콜론 태그가 `#` 경계에서 각각 잡힘.
 *   - 날짜 `~` 분할 / 못 알아든 값 "못 알아들음"(null·가짜값 0).
 *   - 클라이언트 경계 추출이 서버 extractValueToBoundary 와 동등(드리프트 방지).
 *
 * Mock 0 — 순수 함수에 데이터를 넣어 산출만 검증(인터페이스 가짜 구현 없음).
 */
import { test, expect, describe } from "bun:test";
import {
  parseInputPreview,
  extractValueToBoundary as clientBoundary,
} from "./parse-input-preview.js";
import { extractValueToBoundary as serverBoundary } from "../../../../src/memory/parsers/tag-value-boundary.ts";

describe("parseInputPreview — 쉼표/`#` 경계로 종류·금액·날짜·본문 가름", () => {
  test("AC: `#가계부:미용, #금액:28000원, #날짜:6월 28일, 투블럭`", () => {
    const r = parseInputPreview("#가계부:미용, #금액:28000원, #날짜:6월 28일, 투블럭");
    expect(r.kind).toBe("가계부");
    expect(r.amount).toBe("28000원");
    expect(r.hasAmountTag).toBe(true);
    expect(r.date).toEqual({ start: "6월 28일", end: null });
    expect(r.body).toBe("투블럭");
  });

  test("분류 사슬 — category › value 순서대로(가계부 › 미용)", () => {
    const r = parseInputPreview("#가계부:미용, #미용:머리, 투블럭 컷트");
    expect(r.chain).toEqual([
      { category: "가계부", value: "미용" },
      { category: "미용", value: "머리" },
    ]);
    expect(r.kind).toBe("가계부");
    expect(r.body).toBe("투블럭 컷트");
  });
});

describe("parseInputPreview — 긴 값 보존(잘림 0·S1 동등)", () => {
  test("AC: `#소설:데뷔 못 하면 죽는 병 걸림` → 값 통째로", () => {
    const r = parseInputPreview("#소설:데뷔 못 하면 죽는 병 걸림");
    expect(r.chain.at(-1)?.value).toBe("데뷔 못 하면 죽는 병 걸림");
    expect(r.kind).toBe("소설");
  });

  test("긴 값 뒤 쉼표·본문 — 값은 쉼표까지, 본문은 그 뒤", () => {
    const r = parseInputPreview("#소설:데뷔 못 하면 죽는 병 걸림, 재밌었다");
    expect(r.chain.at(-1)?.value).toBe("데뷔 못 하면 죽는 병 걸림");
    expect(r.body).toBe("재밌었다");
  });
});

describe("parseInputPreview — 띄어쓰기 나열 콜론 태그(`#` 경계로 각각)", () => {
  test("AC: `#언어:TypeScript #런타임:Bun` → 각각 잡힘", () => {
    const r = parseInputPreview("#언어:TypeScript #런타임:Bun");
    expect(r.chain).toEqual([
      { category: "언어", value: "TypeScript" },
      { category: "런타임", value: "Bun" },
    ]);
  });
});

describe("parseInputPreview — 날짜 `~` 분할 + 못 알아들음(null·가짜값 0)", () => {
  test("AC: `#날짜:6월 28일 ~ 6월 30일` → start/end 분할", () => {
    const r = parseInputPreview("#날짜:6월 28일 ~ 6월 30일");
    expect(r.date).toEqual({ start: "6월 28일", end: "6월 30일" });
  });

  test("AC: 값 빈 날짜(`#날짜:`) → date=null(못 알아들음·가짜값 0)", () => {
    const r = parseInputPreview("#날짜:, 본문만");
    expect(r.date).toBeNull();
    expect(r.body).toBe("본문만");
  });

  test("일정시작·일정종료 키도 date 갈래", () => {
    const r = parseInputPreview("#일정시작:6월 28일");
    expect(r.date).toEqual({ start: "6월 28일", end: null });
  });

  test("종류 하나도 없으면 kind=null(못 알아들음)", () => {
    const r = parseInputPreview("그냥 자유 메모");
    expect(r.kind).toBeNull();
    expect(r.chain).toEqual([]);
    expect(r.body).toBe("그냥 자유 메모");
  });
});

describe("parseInputPreview — 장소·금액 라우팅", () => {
  test("`#장소:로즐리 헤어` → place(띄어쓰기 보존)", () => {
    const r = parseInputPreview("#장소:로즐리 헤어, 컷트");
    expect(r.place).toBe("로즐리 헤어");
    expect(r.body).toBe("컷트");
  });

  test("실데이터 96줄 양식 한 줄 — 종류·날짜·장소·금액·본문 동시 가름", () => {
    const r = parseInputPreview(
      "#가계부:미용, #미용:머리, #날짜:6월 28일, #장소:로즐리 헤어, 투블럭 컷트 #금액:28000원,",
    );
    expect(r.kind).toBe("가계부");
    expect(r.date).toEqual({ start: "6월 28일", end: null });
    expect(r.place).toBe("로즐리 헤어");
    expect(r.amount).toBe("28000원");
    expect(r.hasAmountTag).toBe(true);
    expect(r.chain).toEqual([
      { category: "가계부", value: "미용" },
      { category: "미용", value: "머리" },
    ]);
    expect(r.body).toBe("투블럭 컷트");
  });

  test("금액 태그가 없으면 amount=null 이고 hasAmountTag=false", () => {
    const r = parseInputPreview("#소설:데뷔 못 하면 죽는 병 걸림, 재밌었다");
    expect(r.amount).toBeNull();
    expect(r.hasAmountTag).toBe(false);
  });

  test("빈 금액 태그(`#금액:`)는 hasAmountTag=true 로 남긴다", () => {
    const r = parseInputPreview("#가계부:미용, #금액:, 본문");
    expect(r.amount).toBeNull();
    expect(r.hasAmountTag).toBe(true);
    expect(r.body).toBe("본문");
  });

  test("빈 입력 → 전부 비고 kind/date/place/amount null·hasAmountTag false·body 빈문자열", () => {
    const r = parseInputPreview("");
    expect(r).toEqual({
      kind: null,
      chain: [],
      date: null,
      place: null,
      amount: null,
      hasAmountTag: false,
      body: "",
    });
  });
});

describe("parse-input-preview — 클라이언트 경계 추출이 서버 extractValueToBoundary 와 동등(② 규칙·드리프트 방지)", () => {
  const cases = [
    { text: "데뷔 못 하면 죽는 병 걸림", at: 0 },
    { text: "TypeScript #런타임:Bun", at: 0 },
    { text: "미용, 머리", at: 0 },
    { text: "강남 A마트\n다음 줄", at: 0 },
    { text: "값#바로태그", at: 0 },
    { text: "  앞뒤 공백  , 뒤", at: 0 },
    { text: "끝까지 읽힘", at: 3 },
  ];
  for (const { text, at } of cases) {
    test(`동등: ${JSON.stringify(text)} @${at}`, () => {
      expect(clientBoundary(text, at)).toBe(serverBoundary(text, at));
    });
  }
});
