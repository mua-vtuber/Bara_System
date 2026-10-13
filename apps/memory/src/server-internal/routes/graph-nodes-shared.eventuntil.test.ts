import { test, expect } from "bun:test";
import { toGraphNode } from "./graph-nodes-shared.ts";
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

test("toGraphNode 가 eventAt·eventUntil 둘 다 전파한다", () => {
  const g = toGraphNode(
    fixtureNode({ eventAt: "2026-06-25T00:00:00.000Z", eventUntil: "2026-06-30T00:00:00.000Z" }),
  );
  expect(g.eventAt).toBe("2026-06-25T00:00:00.000Z");
  expect(g.eventUntil).toBe("2026-06-30T00:00:00.000Z");
});

test("event_at·event_until 없으면 undefined 로 접힌다(빈 문자열 금지)", () => {
  const g = toGraphNode(fixtureNode({ eventAt: null, eventUntil: null }));
  expect(g.eventAt).toBeUndefined();
  expect(g.eventUntil).toBeUndefined();
});
