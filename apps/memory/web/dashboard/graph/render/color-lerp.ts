// 색 보간 순수 헬퍼 — hex 색 파싱·조립·RGB 선형 보간 (WebGL 없이 테스트 가능)
// nodes.ts 의 starColorForVitality 와 시간축 색 전환 작업이 함께 쓴다(DRY).

/** "#rrggbb" 를 [r,g,b] (0~255) 로 푼다. */
export function parseHex(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

/** 0~255 채널 셋을 "#rrggbb" 로 만든다. */
export function toHex(r: number, g: number, b: number): string {
  const ch = (n: number) =>
    Math.round(Math.max(0, Math.min(255, n)))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

/** 두 hex 색 사이를 RGB 선형 보간한다. t 는 0~1 로 clamp. 순수 함수. */
export function lerpHexColor(a: string, b: string, t: number): string {
  const tt = Math.max(0, Math.min(1, t));
  const [r1, g1, b1] = parseHex(a);
  const [r2, g2, b2] = parseHex(b);
  return toHex(r1 + (r2 - r1) * tt, g1 + (g2 - g1) * tt, b1 + (b2 - b1) * tt);
}
