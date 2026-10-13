/**
 * korean-tokenizer 통합 테스트. 실제 Kiwi WASM + 실제 모델 사전으로 검증한다.
 * Mock 없음 — MockTokenizer 같은 인터페이스 가짜 구현을 만들지 않는다.
 *
 * 모델 사전이 assets/kiwi-model/ 에 풀려 있어야 한다(scripts/fetch-kiwi-model.ts).
 */
import { describe, expect, test } from "bun:test";
import { tokenizeKorean, warmUpKoreanTokenizer } from "./korean-tokenizer.ts";

describe("tokenizeKorean — 조사 흡수", () => {
  test("빈 문자열 → 빈 배열", async () => {
    expect(await tokenizeKorean("")).toEqual([]);
  });

  test("조사가 붙은 같은 명사를 한 토큰으로 모은다 (커피를/커피가 → 커피)", async () => {
    const tokens = await tokenizeKorean("커피를 마셨다 커피가 좋다");
    const coffeeCount = tokens.filter((t) => t === "커피").length;
    expect(coffeeCount).toBe(2);
    // 조사 '를'·'가' 는 흡수돼 토큰에 없다.
    expect(tokens).not.toContain("를");
    expect(tokens).not.toContain("가");
    // 조사 붙은 음절 덩어리도 토큰에 없다.
    expect(tokens).not.toContain("커피를");
    expect(tokens).not.toContain("커피가");
  });

  test("다양한 조사가 모두 흡수된다 (을/는/에/와)", async () => {
    const tokens = await tokenizeKorean("커피를 커피는 커피에 커피와");
    expect(tokens.filter((t) => t === "커피").length).toBe(4);
  });
});

describe("tokenizeKorean — 영문·숫자 보존", () => {
  test("영문 토큰을 lowercase 로 보존한다", async () => {
    const tokens = await tokenizeKorean("오늘 React 공부함");
    expect(tokens).toContain("react");
    expect(tokens).toContain("공부");
  });

  test("숫자 토큰을 보존한다", async () => {
    const tokens = await tokenizeKorean("버전 311 출시");
    expect(tokens).toContain("311");
    expect(tokens).toContain("버전");
  });

  test("영문+숫자 혼합 본문에서 영문·숫자가 살아남는다", async () => {
    const tokens = await tokenizeKorean("python 버전 3 설치");
    expect(tokens).toContain("python");
    expect(tokens).toContain("3");
    expect(tokens).toContain("버전");
  });
});

describe("tokenizeKorean — 어미·용언 흡수", () => {
  test("동사·형용사 어간과 어미는 제거되고 명사만 남는다", async () => {
    const tokens = await tokenizeKorean("커피가 좋다");
    // '좋'(형용사 어간)·'다'(어미)는 제거, '커피'(명사)만 남는다.
    expect(tokens).toEqual(["커피"]);
  });

  test("명사+동사화 접사 본문에서 명사 어근을 살린다 (공부함 → 공부)", async () => {
    const tokens = await tokenizeKorean("매일 공부함");
    expect(tokens).toContain("공부");
    // '하'(동사화 접사)·'ㅁ'(명사형 어미)은 제거.
    expect(tokens).not.toContain("하");
  });
});

describe("tokenizeKorean — 초기화 1회·재사용", () => {
  test("warmUp 후 여러 번 호출해도 일관된 결과를 준다 (인스턴스 재사용)", async () => {
    await warmUpKoreanTokenizer();
    const a = await tokenizeKorean("커피를 마셨다");
    const b = await tokenizeKorean("커피를 마셨다");
    expect(a).toEqual(b);
    expect(a).toContain("커피");
  });
});
