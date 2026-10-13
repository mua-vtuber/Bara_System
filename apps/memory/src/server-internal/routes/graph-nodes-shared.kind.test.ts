import { test, expect } from "bun:test";
import { toGraphNode, type GraphNode } from "./graph-nodes-shared.ts";
import type { MemoryNode } from "../../memory/types.ts";

function fixtureNode(over: Partial<MemoryNode>): MemoryNode {
  return {
    id: 1,
    content: "회의",
    memoryType: "episode",
    sourceType: "user_explicit",
    author: "",
    platform: "test",
    importance: 0.5,
    confidence: 0.8,
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: null,
    lastAccessedAt: "2026-06-25T00:00:00.000Z",
    eventAt: null,
    eventUntil: null,
    accessCount: 0,
    mentionCount: 0,
    lastMentionedAt: null,
    metadata: {},
    polarity: null,
    projectId: null,
    ...over,
  };
}

test("GraphNode 에 kind 칸이 있다", () => {
  // 타입 검사 — kind 를 optional string 으로 할당 가능한지 컴파일 단계에서 보장.
  const g: GraphNode = toGraphNode(fixtureNode({}));
  // GraphNode 의 kind 타입 칸이 존재하지 않으면 이 할당에서 tsc 가 에러를 낸다.
  g.kind = "가계부";
  expect(g.kind).toBe("가계부");
});

test("toGraphNode 는 kind 를 채우지 않는다(라우트 enrich 전·undefined 가 정상)", () => {
  const g: GraphNode = toGraphNode(fixtureNode({}));
  expect(g.kind).toBeUndefined();
});
