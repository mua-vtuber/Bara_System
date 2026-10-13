/**
 * compute-tab.dom.test.ts — 계산 탭 결과 DOM 렌더 검증 (활용 단계6b T4).
 *
 * happy-dom 실제 DOM 으로 buildComputeResultNodes 의 노드 구조를 검증한다(기존 ui/dom.test.ts
 * 양식·GlobalRegistrator + el 헬퍼). describeComputeResult 의 텍스트 분기는 compute-tab.test.ts
 * 가 fixture 로 검증하고, 여기서는 그 산출이 실제 DOM 노드(헤더·헤드라인·제외/칸부재 안내 줄)로
 * 정확히 조립되는지를 본다 — mock 0(가짜 인터페이스 0·실제 DOM·실제 el).
 */

import { registerHappyDom } from "./test-happy-dom.ts";
registerHappyDom();

import { test, expect, describe } from "bun:test";
import { el } from "./ui/dom.ts";
import { buildComputeResultNodes, COMPUTE_TEXT } from "./compute-tab.js";

function mount(data: unknown): HTMLElement {
  const root = el("div");
  root.replaceChildren(...buildComputeResultNodes(data, el));
  return root;
}

describe("buildComputeResultNodes — 결과 DOM 조립", () => {
  test("개수(count) — 헤더 '개수' + 헤드라인 'N건'", () => {
    const root = mount({ kind: "count", count: 5 });
    expect(root.querySelector(".section-title")?.textContent).toBe(COMPUTE_TEXT.headerByKind.count);
    expect(root.querySelector(".compute-headline")?.textContent).toBe("5건");
    expect(root.querySelectorAll(".compute-note").length).toBe(0);
  });

  test("case1 실합계 — 헤드라인 '15,000' + 제외 안내 0줄", () => {
    const root = mount({
      kind: "sum", count: 2, value: 15000, numericFieldPresent: true, excludedCount: 0,
    });
    expect(root.querySelector(".section-title")?.textContent).toBe("합계");
    expect(root.querySelector(".compute-headline")?.textContent).toBe("15,000");
    expect(root.querySelectorAll(".compute-note").length).toBe(0);
  });

  test("case2 칸 부재 — '수치 데이터 없음' 헤드라인(분모 표기 안 덧씀)", () => {
    const root = mount({
      kind: "avg", count: 0, numericFieldPresent: false, avgDivisor: 0, avgDivisorKind: "day",
    });
    expect(root.querySelector(".section-title")?.textContent).toBe("평균");
    expect(root.querySelector(".section-title")?.textContent).not.toContain("하루");
    expect(root.querySelector(".compute-headline")?.textContent).toBe(COMPUTE_TEXT.numericFieldAbsent);
  });

  test("case3 못 읽는 값 제외 — 합계 + 제외 안내 1줄", () => {
    const root = mount({
      kind: "sum", count: 2, readCount: 1, value: 15000, numericFieldPresent: true, excludedCount: 1,
    });
    expect(root.querySelector(".compute-headline")?.textContent).toBe("15,000");
    const notes = root.querySelectorAll(".compute-note");
    expect(notes.length).toBe(1);
    expect(notes[0]?.textContent).toBe(COMPUTE_TEXT.excludedNote(1));
  });

  test("case3 변형 — 읽힌 값 0건 → '읽을 수 있는 값 없음' + 제외 안내", () => {
    const root = mount({
      kind: "avg", count: 0, value: 0, numericFieldPresent: true, excludedCount: 3,
      avgDivisor: 0, avgDivisorKind: "day",
    });
    expect(root.querySelector(".compute-headline")?.textContent).toBe(COMPUTE_TEXT.noReadableValue);
    expect(root.querySelectorAll(".compute-note")[0]?.textContent).toBe(COMPUTE_TEXT.excludedNote(3));
  });

  test("인라인 색 0 — 노드에 style 속성을 직접 넣지 않는다(theme 토큰 CSS 만)", () => {
    const root = mount({ kind: "sum", count: 1, value: 100, numericFieldPresent: true, excludedCount: 0 });
    for (const node of root.querySelectorAll("*")) {
      expect(node.getAttribute("style")).toBeNull();
    }
  });
});
