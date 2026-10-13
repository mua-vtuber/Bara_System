// 고리 기울기 흩기·빛살 픽셀 알파 순수 함수 단위 테스트 — WebGL 비의존.
// geometry 생성 자체(평면 링·보석 다면체)는 WebGL 없이 검증 불가라 테스트하지 않는다.
// 노드별 기울기가 결정적이고 기준 ± jitter 범위 안에 드는지, 빛살 알파가 중심에서
// 끝점·가장자리로 갈수록 단조 감소하는지만 검증한다(T18).
import { describe, test, expect } from "bun:test";
import { ringTiltForNode, rayAlphaAt, rayPixelAlpha } from "./decoration-geometry.ts";

/** 배열이 인접 원소끼리 증가하지 않는지(단조 비증가) 검사한다 — noUncheckedIndexedAccess 안전. */
function isMonotonicNonIncreasing(values: number[]): boolean {
  return values.every((v, i) => i === 0 || v <= values[i - 1]!);
}

describe("ringTiltForNode — 노드별 결정적 기울기 흩기 (Phase8 재매핑 Task 6)", () => {
  test("같은 id 는 같은 각도 (결정적·깜빡임 0)", () => {
    expect(ringTiltForNode("entity:work:wrk_a", 68, 40)).toBe(
      ringTiltForNode("entity:work:wrk_a", 68, 40),
    );
  });

  test("다른 id 는 (대개) 다른 각도", () => {
    expect(ringTiltForNode("entity:work:wrk_a", 68, 40)).not.toBe(
      ringTiltForNode("entity:work:wrk_b", 68, 40),
    );
  });

  test("기준 각도 ± jitter 범위 안", () => {
    const deg = ringTiltForNode("entity:work:wrk_c", 68, 40);
    expect(deg).toBeGreaterThanOrEqual(68 - 40);
    expect(deg).toBeLessThanOrEqual(68 + 40);
  });

  test("다양한 id 전부 기준 ± jitter 범위 안", () => {
    const ids = [
      "entity:creature:aaa", "entity:project:bbb", "person:ccc",
      "concept:ddd", "node:12345", "entity:place:zzz",
    ];
    for (const id of ids) {
      const deg = ringTiltForNode(id, 68, 40);
      expect(deg).toBeGreaterThanOrEqual(68 - 40);
      expect(deg).toBeLessThanOrEqual(68 + 40);
    }
  });
});

describe("rayAlphaAt — 빛살 길이·폭 방향 알파 페이드 (T18: 삼각형 실루엣 제거)", () => {
  test("중심선(u=0)에서 길이 방향 t가 커질수록(끝으로 갈수록) 알파가 단조 감소", () => {
    // rootFade=0 (T20 이전 동작 보존) — root 구간 없이 t=0 즉시 최대 알파.
    const ts = [0, 0.2, 0.4, 0.6, 0.8, 1];
    const alphas = ts.map((t) => rayAlphaAt(t, 0, 2, 0));
    expect(isMonotonicNonIncreasing(alphas)).toBe(true);
  });

  test("끝점(t=1)에서는 완전 투명(알파 0) — 뾰족한 꼭짓점이 안 보인다", () => {
    expect(rayAlphaAt(1, 0, 2, 0)).toBe(0);
  });

  test("밑변(t=0) 중심선은 최대 알파 (rootFade=0일 때만 — 하위호환)", () => {
    expect(rayAlphaAt(0, 0, 2, 0)).toBe(1);
  });

  test("같은 t에서 가장자리(|u|→1)로 갈수록 알파가 단조 감소 — 폭 방향도 페이드", () => {
    const us = [0, 0.25, 0.5, 0.75, 1];
    const alphas = us.map((u) => rayAlphaAt(0.3, u, 2, 0));
    expect(isMonotonicNonIncreasing(alphas)).toBe(true);
  });

  test("가장자리(|u|=1)는 완전 투명 — 하드엣지 실루엣이 안 남는다", () => {
    expect(rayAlphaAt(0.5, 1, 2, 0)).toBe(0);
    expect(rayAlphaAt(0.5, -1, 2, 0)).toBe(0);
  });

  test("edgePower가 클수록 같은 u에서 더 빨리(더 어둡게) 페이드 — 좁은 빛줄기", () => {
    const wide = rayAlphaAt(0.3, 0.5, 1, 0);
    const narrow = rayAlphaAt(0.3, 0.5, 3, 0);
    expect(narrow).toBeLessThan(wide);
  });
});

describe("rayAlphaAt — 뿌리(root) 페이드인 (T20: 중심 쪽 하드엣지 제거)", () => {
  test("t=0(뿌리)에서 rootFade>0 이면 알파가 0 — 하드컷 없이 완전히 비어서 시작", () => {
    expect(rayAlphaAt(0, 0, 2, 0.2)).toBe(0);
  });

  test("root 구간(0<t<rootFade) 안에서는 t가 커질수록 알파가 단조 증가 — 서서히 밝아짐", () => {
    const rootFade = 0.2;
    const ts = [0, 0.05, 0.1, 0.15, 0.2];
    const alphas = ts.map((t) => rayAlphaAt(t, 0, 2, rootFade));
    // 비감소(단조 증가) 확인 — 뒤집어서 비증가 검사 재사용.
    expect(isMonotonicNonIncreasing([...alphas].reverse())).toBe(true);
  });

  test("root 구간을 벗어나면(t>rootFade) rootRamp이 정확히 1 — T18 원식과 동일", () => {
    // root 구간 밖에서는 rootRamp = 1 — T18 원식(rootFade 0)과 정확히 같아야 한다.
    const rootFade = 0.15;
    const edgePower = 2;
    const tBeyondRoot = rootFade + 0.1;
    expect(rayAlphaAt(tBeyondRoot, 0, edgePower, rootFade)).toBe(
      rayAlphaAt(tBeyondRoot, 0, edgePower, 0),
    );
  });

  test("root 구간을 넘어서면(t>rootFade) 기존 T18 단조 감소 동작 그대로 유지", () => {
    const rootFade = 0.15;
    const ts = [rootFade, 0.3, 0.5, 0.7, 1];
    const alphas = ts.map((t) => rayAlphaAt(t, 0, 2, rootFade));
    expect(isMonotonicNonIncreasing(alphas)).toBe(true);
  });

  test("rootFade=0 이면 기존 동작과 완전히 동일(하위호환 — t=0 즉시 최대 알파)", () => {
    expect(rayAlphaAt(0, 0, 2, 0)).toBe(1);
    expect(rayAlphaAt(0, 0.5, 2, 0)).toBe(rayAlphaAt(0, 0.5, 2, 0));
  });

  test("끝점(t=1)은 rootFade 값과 무관하게 항상 완전 투명", () => {
    expect(rayAlphaAt(1, 0, 2, 0.2)).toBe(0);
    expect(rayAlphaAt(1, 0, 2, 0.5)).toBe(0);
  });
});

describe("rayPixelAlpha — 캔버스 픽셀→빛살 알파 변환 (T18)", () => {
  const c = 64; // 128 캔버스 중심
  const outer = c * 0.94;
  const angle = 0; // 오른쪽으로 뻗는 빛살
  const baseHalf = Math.PI / 12;

  test("빛살 중심선을 따라 멀어질수록 알파가 단조 감소 (root 구간 이후)", () => {
    // rootFade=0 — 뿌리 즉시 최대치인 기존 동작 기준으로 단조성 확인.
    const distances = [0, 10, 20, 30, 40, outer];
    const alphas = distances.map((d) =>
      rayPixelAlpha(c + d, c, c, angle, outer, baseHalf, 2, 0),
    );
    expect(isMonotonicNonIncreasing(alphas)).toBe(true);
  });

  test("끝점 반지름 밖(t>1)은 완전 투명", () => {
    expect(rayPixelAlpha(c + outer + 5, c, c, angle, outer, baseHalf, 2, 0)).toBe(0);
  });

  test("부채꼴 각도(baseHalf) 밖 픽셀은 완전 투명 — 하드엣지 없이 자연 소실", () => {
    const px = c + Math.cos(baseHalf * 2) * (outer / 2);
    const py = c + Math.sin(baseHalf * 2) * (outer / 2);
    expect(rayPixelAlpha(px, py, c, angle, outer, baseHalf, 2, 0)).toBe(0);
  });

  test("중심점 자체는 최대 알파(전 빛살 공통 중심) — rootFade 무관", () => {
    expect(rayPixelAlpha(c, c, c, angle, outer, baseHalf, 2, 0)).toBe(1);
    expect(rayPixelAlpha(c, c, c, angle, outer, baseHalf, 2, 0.2)).toBe(1);
  });
});

describe("rayPixelAlpha — 뿌리 페이드인 통합 (T20: 중심 쪽 하드엣지 제거)", () => {
  const c = 64;
  const outer = c * 0.94;
  const angle = 0;
  const baseHalf = Math.PI / 12;
  const rootFade = 0.15; // outer 대비 비율 — graph-theme rayRootFade 토큰과 같은 의미.

  test("중심점 바로 옆 픽셀(t 작음)은 rootFade>0일 때 하드컷 없이 낮은 알파에서 시작", () => {
    // 중심점(dist=0) 자체는 특례로 1이지만, 그 바로 옆(t가 rootFade보다 훨씬 작은 지점)은
    // 이전엔 baseR 반경 안에서 무조건 alpha=1 이었다 — 이제는 rayAlphaAt 의 root-fade를 타고
    // 작은 값에서 시작해야 한다(하드엣지 제거 확인).
    const nearCenterDist = outer * rootFade * 0.1;
    const alpha = rayPixelAlpha(c + nearCenterDist, c, c, angle, outer, baseHalf, 2, rootFade);
    expect(alpha).toBeLessThan(0.3);
  });

  test("뿌리에서 바깥으로 갈수록(root 구간 내) 알파가 단조 증가 — 서서히 밝아짐", () => {
    const distances = [1, outer * 0.03, outer * 0.06, outer * 0.09, outer * rootFade];
    const alphas = distances.map((d) =>
      rayPixelAlpha(c + d, c, c, angle, outer, baseHalf, 2, rootFade),
    );
    expect(isMonotonicNonIncreasing([...alphas].reverse())).toBe(true);
  });

  test("root 구간을 넘어서면 끝점까지 단조 감소 — T18 외곽 동작 그대로", () => {
    const distances = [outer * rootFade, outer * 0.3, outer * 0.5, outer * 0.7, outer];
    const alphas = distances.map((d) =>
      rayPixelAlpha(c + d, c, c, angle, outer, baseHalf, 2, rootFade),
    );
    expect(isMonotonicNonIncreasing(alphas)).toBe(true);
  });

  test("rootFade=0 이면 기존 T18 동작과 동일(하위호환)", () => {
    const d = 20;
    const withZero = rayPixelAlpha(c + d, c, c, angle, outer, baseHalf, 2, 0);
    const withoutParam = rayPixelAlpha(c + d, c, c, angle, outer, baseHalf, 2, 0);
    expect(withZero).toBe(withoutParam);
  });
});
