/**
 * web/dashboard/ui/badges.eventtime.test.ts
 * eventTimeChip · kindBadge · componentChips 단위 테스트 — happy-dom 실제 DOM 구현 사용.
 */
import { registerHappyDom } from "../test-happy-dom.ts";
registerHappyDom();

import { test, expect } from "bun:test";
import { componentChips, eventTimeChip, kindBadge, scheduleLineText } from "./badges.ts";

test("eventTimeChip 단일 시점 — 시작만 표기", () => {
  const c = eventTimeChip("2026-06-25T14:00:00.000Z");
  expect(c.className).toContain("chip--eventtime");
  expect(c.textContent).toContain("6/25");
  expect(c.textContent).not.toContain("–");
});

test("eventTimeChip 기간 — 시작–종료 표기", () => {
  const c = eventTimeChip("2026-06-01T00:00:00.000Z", "2026-06-05T00:00:00.000Z");
  expect(c.textContent).toContain("6/1");
  expect(c.textContent).toContain("6/5");
  expect(c.textContent).toContain("–");
});

test("eventTimeChip .chip 클래스도 포함", () => {
  const c = eventTimeChip("2026-06-25T14:00:00.000Z");
  expect(c.className).toContain("chip");
});

test("kindBadge — 종류명 + .badge--kind 클래스(인라인 색 0)", () => {
  const b = kindBadge("일정");
  expect(b.className).toContain("badge--kind");
  expect(b.textContent).toBe("일정");
  expect(b.getAttribute("style")).toBeNull();
});

test("kindBadge .badge 클래스도 포함", () => {
  const b = kindBadge("가계부");
  expect(b.className).toContain("badge");
});

test("componentChips — 큰 값부터 최대 3개 렌더링", () => {
  const chips = componentChips({ fts: 0.2, vector: 0.7, graph: 0.4, image: 0.1 });
  expect(chips.length).toBe(3);
  expect(chips[0]?.textContent).toBe("의미 70%");
  expect(chips[1]?.textContent).toBe("그래프 40%");
  expect(chips[2]?.textContent).toBe("글자 20%");
});

test("componentChips — 숫자가 아니면 생략하고 인라인 색 0", () => {
  const chips = componentChips({ fts: Number.NaN, graph: 1.25 });
  expect(chips.length).toBe(1);
  expect(chips[0]?.className).toContain("chip--component");
  expect(chips[0]?.textContent).toBe("그래프 1.25");
  expect(chips[0]?.getAttribute("style")).toBeNull();
});

test("componentChips — 중립 보정값은 근거 칩에서 숨긴다", () => {
  const chips = componentChips({
    recency: 0.8,
    supersedePenalty: 1.0,
    cueGraphBoost: 1.0,
    mentionBoost: 0,
  });
  expect(chips.map((c) => c.textContent)).toEqual(["최근성 80%"]);
});

test("componentChips — 실제 감점·가산은 한국어 근거로 표시한다", () => {
  const chips = componentChips({
    supersedePenalty: 0.5,
    cueGraphBoost: 1.12,
  });
  expect(chips.map((c) => c.textContent)).toEqual([
    "옛기억 감점 -50%",
    "관계질문 가산 +12%",
  ]);
  expect(chips[0]?.getAttribute("title")).toContain("대체된 옛 기억");
});

test("eventTimeChip 종료 빈 문자열 — 단일 시점으로 처리", () => {
  const c = eventTimeChip("2026-06-10T00:00:00.000Z", "");
  expect(c.textContent).not.toContain("–");
  expect(c.textContent).toContain("6/10");
});

test("eventTimeChip 순수 날짜 문자열(YYYY-MM-DD) — 앞자리 0 떼고 'M/D'", () => {
  expect(eventTimeChip("2026-12-31").textContent).toBe("12/31");
  expect(eventTimeChip("2026-01-01").textContent).toBe("1/1");
});

test("eventTimeChip — 날짜 부분을 직접 뽑아 뷰어 시간대에 흔들리지 않는다", () => {
  // 옛 로직은 new Date("2026-12-31T23:59:59.000Z") 를 KST(+9)에서 파싱해
  // 다음날이 되어 "1/1" 을 냈다. 새 로직은 앞 YYYY-MM-DD 만 읽어 시간대와 무관.
  const c = eventTimeChip("2026-12-31T23:59:59.000Z");
  expect(c.textContent).toBe("12/31");
});

test("scheduleLineText 종료 있음 — '일정: 시작 → 종료' (날짜만)", () => {
  const text = scheduleLineText("2026-06-01T00:00:00.000Z", "2026-06-05T09:30:00.000Z");
  expect(text).toBe("일정: 2026-06-01 → 2026-06-05");
});

test("scheduleLineText 종료 없음(undefined) — '일정: 시작'", () => {
  const text = scheduleLineText("2026-06-01T14:00:00.000Z");
  expect(text).toBe("일정: 2026-06-01");
});

test("scheduleLineText 종료 null — '일정: 시작' (단일 시점)", () => {
  const text = scheduleLineText("2026-06-01T14:00:00.000Z", null);
  expect(text).toBe("일정: 2026-06-01");
});
