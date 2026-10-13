import { test, expect } from "bun:test";
import { NodeWindowManager, resolveNodeClickAction } from "./node-window";

test("MAX=1 — 새 창이 기존을 교체", () => {
  const m = new NodeWindowManager(1);
  m.open("node:1"); m.open("node:2");
  expect(m.list().map((w) => w.nodeId)).toEqual(["node:2"]);
});
test("focus — z-index 최상단", () => {
  const m = new NodeWindowManager(4);
  m.open("node:1"); m.open("node:2"); m.focus("node:1");
  const top = m.list().reduce((a, b) => (a.z > b.z ? a : b));
  expect(top.nodeId).toBe("node:1");
});
test("MAX=4 — 동시 4개(다중 상정 증명)", () => {
  const m = new NodeWindowManager(4);
  for (const id of ["1", "2", "3", "4", "5"]) m.open(`node:${id}`);
  expect(m.list()).toHaveLength(4);
  expect(m.list().map((w) => w.nodeId)).not.toContain("node:1");
});
test("move — 위치 갱신", () => {
  const m = new NodeWindowManager(4);
  m.open("node:1"); m.move("node:1", { x: 10, y: 20 });
  expect(m.list().find((w) => w.nodeId === "node:1")!.pos).toEqual({ x: 10, y: 20 });
});
test("close — 창 제거", () => {
  const m = new NodeWindowManager(4);
  m.open("node:1"); m.close("node:1");
  expect(m.list()).toHaveLength(0);
});

test("창 없으면 open", () => {
  expect(resolveNodeClickAction([], "a")).toBe("open");
});
test("최상위 z 창은 close, 묻힌 창은 focus", () => {
  const m = new NodeWindowManager(4);
  m.open("a"); m.open("b");
  expect(resolveNodeClickAction(m.list(), "b")).toBe("close");
  expect(resolveNodeClickAction(m.list(), "a")).toBe("focus");
});
test("focus 후 최상위가 바뀌면 close 대상도 바뀐다", () => {
  const m = new NodeWindowManager(4);
  m.open("a"); m.open("b"); m.focus("a");
  expect(resolveNodeClickAction(m.list(), "a")).toBe("close");
  expect(m.frontNodeId()).toBe("a");
});
test("MAX 4 초과 시 가장 오래된 창이 밀린다", () => {
  const m = new NodeWindowManager(4);
  for (const id of ["a", "b", "c", "d", "e"]) m.open(id);
  expect(m.list().map((w) => w.nodeId)).toEqual(["b", "c", "d", "e"]);
});
