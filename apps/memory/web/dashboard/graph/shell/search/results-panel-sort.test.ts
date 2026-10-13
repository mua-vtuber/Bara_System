/**
 * results-panel-sort.test.ts — CardView 전용 결과 정렬 세 함수 검증(함정 B·spec §3.3·§8).
 * 순수 함수 입력→출력 검증(데이터 fixture·인터페이스 mock 0).
 * happy-dom 불필요(DOM 안 건드림) — @huggingface/transformers 와 섞이지 않게 단독 실행 권장.
 */
import { test, expect } from "bun:test";
import { sortCardViews } from "./results-panel-sort.ts";
import type { CardView } from "../../../ui/card-view.ts";

const A: CardView = { nodeId: "n:1", title: "A", date: "2026-05-01", eventAt: "2026-06-10" };
const B: CardView = { nodeId: "n:2", title: "B", date: "2026-05-20" }; // eventAt 없음
const C: CardView = { nodeId: "n:3", title: "C", date: "2026-05-10", eventAt: "2026-06-01" };

test("관련순 — 입력 순서 그대로(재정렬 안 함)", () => {
  expect(sortCardViews([A, B, C], "relevance").map((v) => v.nodeId)).toEqual(["n:1", "n:2", "n:3"]);
});

test("최신등록순 — date 내림차순(최신 위)", () => {
  expect(sortCardViews([A, B, C], "recent").map((v) => v.nodeId)).toEqual(["n:2", "n:3", "n:1"]);
});

test("빠른일정순 — eventAt 오름차순, 없는 글은 맨 뒤(목록에 남김·필터링 안 함)", () => {
  const out = sortCardViews([A, B, C], "event");
  expect(out.map((v) => v.nodeId)).toEqual(["n:3", "n:1", "n:2"]);
  expect(out.length).toBe(3); // B(eventAt 없음)가 빠지지 않고 맨 뒤에 남음
});

test("원본 불변 — 정렬은 새 배열만 돌리고 입력 배열은 그대로", () => {
  const input = [A, B, C];
  sortCardViews(input, "recent");
  sortCardViews(input, "event");
  expect(input.map((v) => v.nodeId)).toEqual(["n:1", "n:2", "n:3"]);
});

// ── 경계: 시각 없음·깨진 시각·동률 안정 정렬 ──────────────────────────────────

test("최신등록순 — date 없는 글은 맨 뒤로(목록엔 남김)", () => {
  const noDate: CardView = { nodeId: "n:9", title: "날짜없음" };
  const out = sortCardViews([noDate, A], "recent");
  // A(2026-05-01) 가 위, date 없는 글은 뒤
  expect(out.map((v) => v.nodeId)).toEqual(["n:1", "n:9"]);
  expect(out.length).toBe(2);
});

test("최신등록순 — 깨진 date 문자열은 뒤로(가짜 0 안 채움)", () => {
  const broken: CardView = { nodeId: "n:8", title: "깨진날짜", date: "not-a-date" };
  const out = sortCardViews([broken, A], "recent");
  expect(out.map((v) => v.nodeId)).toEqual(["n:1", "n:8"]);
});

test("빠른일정순 — eventAt 둘 다 없으면 nodeId 안정 정렬", () => {
  const x: CardView = { nodeId: "n:5", title: "x" };
  const y: CardView = { nodeId: "n:4", title: "y" };
  const out = sortCardViews([x, y], "event");
  // 둘 다 eventAt 없음 → nodeId 오름(n:4 먼저)
  expect(out.map((v) => v.nodeId)).toEqual(["n:4", "n:5"]);
});

test("최신등록순 — 같은 date 면 nodeId 로 안정 정렬", () => {
  const p: CardView = { nodeId: "n:7", title: "p", date: "2026-05-15" };
  const q: CardView = { nodeId: "n:6", title: "q", date: "2026-05-15" };
  const out = sortCardViews([p, q], "recent");
  expect(out.map((v) => v.nodeId)).toEqual(["n:6", "n:7"]);
});

test("빈 배열 — 모드 무관 빈 배열(throw 없음)", () => {
  expect(sortCardViews([], "relevance")).toEqual([]);
  expect(sortCardViews([], "recent")).toEqual([]);
  expect(sortCardViews([], "event")).toEqual([]);
});
