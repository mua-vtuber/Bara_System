import { test, expect } from "bun:test";
import { computeTop3CardLayout } from "./top3-layout.ts";

const SIZE = { w: 1200, h: 800 };
const CARD = { w: 268, h: 188 };

test("안 보이는 노드는 hidden", () => {
  const out = computeTop3CardLayout({
    nodePoints: [{ x: 600, y: 400, visible: false }],
    size: SIZE, card: CARD, userPositions: [null],
  });
  expect(out[0]!.hidden).toBe(true);
});

test("사용자 고정 위치를 그대로 쓴다", () => {
  const out = computeTop3CardLayout({
    nodePoints: [{ x: 600, y: 400, visible: true }],
    size: SIZE, card: CARD, userPositions: [{ x: 123, y: 456 }],
  });
  expect(out[0]).toMatchObject({ x: 123, y: 456, hidden: false });
});

test("자동 배치는 화면 안으로 클램프된다", () => {
  const out = computeTop3CardLayout({
    nodePoints: [{ x: 1190, y: 790, visible: true }],
    size: SIZE, card: CARD, userPositions: [null],
  });
  expect(out[0]!.x).toBeGreaterThanOrEqual(12);
  expect(out[0]!.x).toBeLessThanOrEqual(SIZE.w - CARD.w - 12);
  expect(out[0]!.y).toBeGreaterThanOrEqual(80);
  expect(out[0]!.y).toBeLessThanOrEqual(SIZE.h - CARD.h - 132);
});

test("세 카드는 서로 12px 이상 안 겹친다", () => {
  const pts = [
    { x: 600, y: 400, visible: true },
    { x: 610, y: 405, visible: true },
    { x: 590, y: 395, visible: true },
  ];
  const out = computeTop3CardLayout({ nodePoints: pts, size: SIZE, card: CARD, userPositions: [null, null, null] });
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i]!, b = out[j]!;
    const overlap = a.x < b.x + CARD.w + 12 && a.x + CARD.w + 12 > b.x && a.y < b.y + CARD.h + 12 && a.y + CARD.h + 12 > b.y;
    expect(overlap).toBe(false);
  }
});
