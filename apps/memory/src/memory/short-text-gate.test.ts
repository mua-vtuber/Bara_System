/**
 * 짧은 단일 의미 스킵 판정 (2026-06-02 Q2) 단위 테스트.
 *
 * 순수 함수 검증 — LLM·DB 없이 입력→출력만 본다(mock 0, fixture 데이터만).
 * 핵심 불변식: 짧고 의미가 하나인 메모는 스킵(true), 절 접속·여러 종결·긴
 * 글은 스킵 안 함(false).
 */

import { describe, expect, test } from "bun:test";
import {
  SHORT_TEXT_MAX_CHARS,
  hasClauseConnector,
  hasListOrMultiFactSignal,
  shouldSkipExtraction,
  terminatorCount,
} from "./short-text-gate.ts";

describe("SHORT_TEXT_MAX_CHARS — 임계 상수 한 곳 모음", () => {
  test("측정 시작값 40 (코드 상수, settings 노출 Deferred)", () => {
    expect(SHORT_TEXT_MAX_CHARS).toBe(40);
  });
});

describe("shouldSkipExtraction — 짧은 단일 의미는 스킵", () => {
  test("짧은 단일 사실 메모 → 스킵(true)", () => {
    // 증상2·4 대표 — 짧고 종결 하나, 절 접속 없음.
    expect(shouldSkipExtraction("6월 4일 목요일은 장터 당번 5차 마감이다")).toBe(
      true,
    );
  });

  test("명사구 위주 짧은 사건 메모(체언 종결) → 스킵(true)", () => {
    // 증상3 대표 — 키워드 흩뜨림 차단. '받음' 한 종결, 절 접속 없음.
    expect(
      shouldSkipExtraction("5월 12일 무지개의원에서 보습 관리 받음"),
    ).toBe(true);
  });

  test("태그 제거된 짧은 사실 메모 → 스킵(true)", () => {
    // Q1 후 LLM 이 보는 형태(태그 이미 제거됨).
    expect(shouldSkipExtraction("Bara System은 RAG 메모리 시스템이다")).toBe(
      true,
    );
  });

  test("긴 단일 사실 메모 → 길이가 40자를 넘어도 스킵(true)", () => {
    const text =
      "주로 사용하는 작업 컴퓨터의 프로세서는 AMD Ryzen 9 7950X3D 16-Core Processor (4.20 GHz)";
    expect(text.length).toBeGreaterThan(SHORT_TEXT_MAX_CHARS);
    expect(shouldSkipExtraction(text)).toBe(true);
  });
});

describe("shouldSkipExtraction — 분할 가치 있으면 스킵 안 함", () => {
  test("절 접속('~지만') 있는 짧은 글 → 스킵 안 함(false)", () => {
    expect(shouldSkipExtraction("커피는 좋아하지만 우유는 싫다")).toBe(false);
  });

  test("절 접속('~해서') 있는 짧은 글 → 스킵 안 함(false)", () => {
    expect(shouldSkipExtraction("비가 와서 우산을 챙겼다")).toBe(false);
  });

  test("절 접속('-고 ') 있는 짧은 글 → 스킵 안 함(false)", () => {
    expect(
      shouldSkipExtraction("금요일에 비타민을 샀고 영수증은 버렸다"),
    ).toBe(false);
  });

  test("종결 신호 2개(문장 둘) → 스킵 안 함(false)", () => {
    expect(shouldSkipExtraction("밥을 먹었다. 잠을 잤다.")).toBe(false);
  });

  test("긴 글(임계 초과) → 스킵 안 함(false)", () => {
    const long =
      "오늘은 아침부터 비가 내려 우산을 챙겨 나갔는데 버스가 늦게 와서 한참을 기다렸다";
    expect(long.length).toBeGreaterThan(SHORT_TEXT_MAX_CHARS);
    expect(shouldSkipExtraction(long)).toBe(false);
  });

  test("쉼표 열거 신호 → 길이가 짧아도 스킵 안 함(false)", () => {
    expect(shouldSkipExtraction("CPU는 빠르고, GPU는 조용하다")).toBe(false);
  });

  test("실제 사람 다중 언급 가능성이 있는 조사 열거 → 스킵 안 함(false)", () => {
    expect(shouldSkipExtraction("민수랑 지영을 만났다")).toBe(false);
  });
});

describe("shouldSkipExtraction — 빈 입력은 막지 않음", () => {
  test("빈 문자열 → false(상위 가드가 처리)", () => {
    expect(shouldSkipExtraction("")).toBe(false);
    expect(shouldSkipExtraction("   ")).toBe(false);
  });
});

describe("hasClauseConnector — 절 접속어미 검출", () => {
  test("연결어미 있으면 true", () => {
    expect(hasClauseConnector("좋아하지만 무섭다")).toBe(true);
    expect(hasClauseConnector("공사해서 시끄럽다")).toBe(true);
    expect(hasClauseConnector("밥을 먹으며 본다")).toBe(true);
    expect(hasClauseConnector("가는데 막혔다")).toBe(true);
    expect(hasClauseConnector("샀고 버렸다")).toBe(true);
  });

  test("연결어미 없으면 false", () => {
    expect(hasClauseConnector("비타민을 샀다")).toBe(false);
    expect(hasClauseConnector("보습 관리 받음")).toBe(false);
  });

  test("명사 '사고' 같은 어휘를 절 접속으로 오탐하지 않는다", () => {
    // '-고 ' 는 뒤 공백을 요구하므로 명사 '사고'(공백 없음)는 안 잡힌다.
    expect(hasClauseConnector("교통사고가 났다")).toBe(false);
  });

  test("인용/생각 구문 '-다고 '는 나열 접속으로 오탐하지 않는다", () => {
    expect(hasClauseConnector("스스로 그림을 꽤 잘 그린다고 생각한다")).toBe(false);
    expect(shouldSkipExtraction("스스로 그림을 꽤 잘 그린다고 생각한다")).toBe(
      true,
    );
  });
});

describe("hasListOrMultiFactSignal — 열거/다중 사실 신호", () => {
  test("쉼표·명시 접속 부사를 잡는다", () => {
    expect(hasListOrMultiFactSignal("CPU는 빠르고, GPU는 조용하다")).toBe(true);
    expect(hasListOrMultiFactSignal("비타민을 샀다 그리고 영수증은 버렸다")).toBe(
      true,
    );
    expect(hasListOrMultiFactSignal("민수랑 지영을 만났다")).toBe(true);
  });

  test("단일 기술 사실은 열거로 보지 않는다", () => {
    expect(
      hasListOrMultiFactSignal(
        "주로 사용하는 작업 컴퓨터의 프로세서는 AMD Ryzen 9 7950X3D 16-Core Processor (4.20 GHz)",
      ),
    ).toBe(false);
  });
});

describe("terminatorCount — 종결 신호 개수 근사", () => {
  test("종결부호 개수를 센다", () => {
    expect(terminatorCount("밥을 먹었다. 잠을 잤다.")).toBe(2);
    expect(terminatorCount("정말? 그래!")).toBe(2);
  });

  test("부호 없는 한국어 종결 어말은 1로 센다", () => {
    expect(terminatorCount("비타민을 샀다")).toBe(1);
    expect(terminatorCount("보습 관리 받음")).toBe(1);
  });

  test("종결 신호 없으면 0", () => {
    expect(terminatorCount("빨간 자동차")).toBe(0);
    expect(terminatorCount("")).toBe(0);
  });
});
