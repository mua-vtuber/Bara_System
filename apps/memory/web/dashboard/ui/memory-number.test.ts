/** memory-number.test.ts — 기억 번호 조각·파싱 검증 */

import { registerHappyDom } from "../test-happy-dom.ts";
registerHappyDom();

import { describe, expect, it } from "bun:test";
import { memoryNumberChip, memoryNumberFromNodeKey, parseMemoryNumberQuery } from "./memory-number.ts";
import { fromGraphNode, fromSearchHit } from "./card-view.ts";
import { memoryCard } from "./memory-card.ts";
import { nodeDetail } from "./node-detail.ts";
import { resultRow } from "./result-row.ts";

describe("memoryNumberFromNodeKey", () => {
  it("node:N 키만 번호로 읽는다", () => {
    expect(memoryNumberFromNodeKey("node:87")).toBe(87);
    expect(memoryNumberFromNodeKey("node:0")).toBeUndefined();
    expect(memoryNumberFromNodeKey("node:08")).toBeUndefined();
    expect(memoryNumberFromNodeKey("person:psn_1")).toBeUndefined();
    expect(memoryNumberFromNodeKey("mem:87")).toBeUndefined();
    expect(memoryNumberFromNodeKey(undefined)).toBeUndefined();
  });
});

describe("parseMemoryNumberQuery", () => {
  it("정확히 #숫자 일 때만 번호를 돌려준다", () => {
    expect(parseMemoryNumberQuery("#87")).toBe(87);
    expect(parseMemoryNumberQuery("  #87  ")).toBe(87);
    expect(parseMemoryNumberQuery("#0")).toBeNull();
    expect(parseMemoryNumberQuery("#87 회의")).toBeNull();
    expect(parseMemoryNumberQuery("#회의")).toBeNull();
    expect(parseMemoryNumberQuery("87")).toBeNull();
    expect(parseMemoryNumberQuery("# 87")).toBeNull();
  });
});

describe("memoryNumberChip", () => {
  it("#87 로 보이고 접근 가능한 이름을 가진다", () => {
    const chip = memoryNumberChip(87);
    expect(chip.className).toBe("memory-no");
    expect(chip.textContent).toBe("#87");
    expect(chip.getAttribute("aria-label")).toBe("기억 번호 87");
  });
});

describe("CardView 번호 전달", () => {
  it("검색 hit 은 result.id, 그래프 노드는 node:N 키에서 번호를 얻는다", () => {
    expect(fromSearchHit({ id: 87, content: "글", score: 1, sources: [], components: {} }).memoryId).toBe(87);
    expect(fromGraphNode({ id: "node:12", label: "글" }).memoryId).toBe(12);
    expect(fromGraphNode({ id: "person:psn_1", label: "사람" }).memoryId).toBeUndefined();
  });
});

describe("번호 표시 위치", () => {
  const view = { nodeId: "node:87", memoryId: 87, title: "제목" };
  it("결과 행·카드(list/hover)·상세 배지 줄에 #87 이 보인다", () => {
    expect(resultRow(view, { onPick: () => {} }).querySelector(".memory-no")?.textContent).toBe("#87");
    for (const mode of ["top3", "list", "detail", "hover"] as const) {
      expect(memoryCard(view, mode).querySelector(".memory-no")?.textContent).toBe("#87");
    }
    const detail = nodeDetail(view);
    expect(detail.querySelector(".node-detail__badges .memory-no")?.textContent).toBe("#87");
  });
  it("번호가 없으면 아무것도 그리지 않는다", () => {
    const bare = { nodeId: "x", title: "제목" };
    expect(resultRow(bare, { onPick: () => {} }).querySelector(".memory-no")).toBeNull();
    expect(memoryCard(bare, "list").querySelector(".memory-no")).toBeNull();
    expect(nodeDetail(bare).querySelector(".memory-no")).toBeNull();
  });
});
