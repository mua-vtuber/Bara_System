/**
 * compute-tab.timeline.test.ts — 검색 탭 시간순 글 목록 렌더 검증 (활용 단계6b T6·(가)).
 *
 * happy-dom 실제 DOM 으로 buildComputeTimelineNodes 의 노드 구조를 검증한다(compute-tab.dom.test.ts
 * 양식·GlobalRegistrator + ./ui/dom.ts 의 el). T6 가 복원하는 stage5 timeline item 렌더(시각·내용)를
 * fixture items 로 본다 — mock 0(가짜 인터페이스 0·실제 DOM·실제 el).
 *
 * 검증 정신(plan T6 Steps):
 *   - 시간순 item = 시각(eventAt 우선·없으면 createdAt) + 내용.
 *   - 검색 카드(renderCard)를 못 쓰는 이유 = /compute 항목이 memoryType·importance 를 안 담음.
 *     따라서 항목은 시각·내용 두 조각만 담는다.
 *   - 빈 목록 = 정직한 빈 상태 한 노드(가짜 행 0).
 */

import { registerHappyDom } from "./test-happy-dom.ts";
registerHappyDom();

import { test, expect, describe } from "bun:test";
import { el } from "./ui/dom.ts";
import { buildComputeTimelineNodes, COMPUTE_TEXT } from "./compute-tab.js";

describe("buildComputeTimelineNodes — 시간순 글 목록 렌더", () => {
  test("시간순 item = 시각(eventAt 우선) + 내용 노드", () => {
    const items = [
      { id: 1, content: "마트에서 우유", createdAt: "2026-06-20T10:00:00Z", eventAt: "2026-06-19T09:00:00Z" },
      { id: 2, content: "약속", createdAt: "2026-06-21T11:00:00Z", eventAt: null },
    ];
    const nodes = buildComputeTimelineNodes(items, el);
    expect(nodes.length).toBe(2);
    // 첫 항목 시각 = eventAt, 둘째 = createdAt(eventAt null).
    expect(nodes[0]?.querySelector(".compute-item-date")?.textContent).toContain("2026-06-19");
    expect(nodes[1]?.querySelector(".compute-item-date")?.textContent).toContain("2026-06-21");
    expect(nodes[0]?.querySelector(".compute-item-content")?.textContent).toBe("마트에서 우유");
    expect(nodes[1]?.querySelector(".compute-item-content")?.textContent).toBe("약속");
  });

  test("eventAt·createdAt 둘 다 없으면 시각 부재 표기(COMPUTE_TEXT.noDate)", () => {
    const items = [{ id: 3, content: "시각 미상 글", createdAt: null, eventAt: null }];
    const nodes = buildComputeTimelineNodes(items, el);
    expect(nodes[0]?.querySelector(".compute-item-date")?.textContent).toBe(COMPUTE_TEXT.noDate);
    expect(nodes[0]?.querySelector(".compute-item-content")?.textContent).toBe("시각 미상 글");
  });

  test("빈 목록 = 정직한 빈 상태 한 노드(가짜 행 0)", () => {
    const nodes = buildComputeTimelineNodes([], el);
    expect(nodes.length).toBe(1);
    expect(nodes[0]?.textContent).toBe(COMPUTE_TEXT.timelineEmpty);
  });

  test("비배열 입력도 정직한 빈 상태 한 노드(가짜 행 0)", () => {
    const nodes = buildComputeTimelineNodes(null, el);
    expect(nodes.length).toBe(1);
    expect(nodes[0]?.textContent).toBe(COMPUTE_TEXT.timelineEmpty);
  });

  test("인라인 색 0 — 노드에 style 속성을 직접 넣지 않는다(theme 토큰 CSS 만)", () => {
    const items = [{ id: 1, content: "글", createdAt: "2026-06-20T10:00:00Z", eventAt: null }];
    const nodes = buildComputeTimelineNodes(items, el);
    for (const node of nodes) {
      expect(node.getAttribute("style")).toBeNull();
      for (const child of node.querySelectorAll("*")) {
        expect(child.getAttribute("style")).toBeNull();
      }
    }
  });
});

describe("COMPUTE_TEXT — 정렬 토글 라벨 중앙화(하드코딩 0)", () => {
  test("정렬 토글 라벨·시각 부재·빈 목록 안내 문자열이 COMPUTE_TEXT 에 있다", () => {
    expect(typeof COMPUTE_TEXT.sortLabel).toBe("string");
    expect(typeof COMPUTE_TEXT.sortRelevance).toBe("string");
    expect(typeof COMPUTE_TEXT.sortTime).toBe("string");
    expect(typeof COMPUTE_TEXT.noDate).toBe("string");
    expect(typeof COMPUTE_TEXT.timelineEmpty).toBe("string");
  });
});
