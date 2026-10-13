import { describe, test, expect } from "bun:test";
import * as THREE from "three";
import {
  edgeKind,
  edgeColorForKind,
  edgeColorAlpha,
  edgeDepthFadeMultiplier,
  edgeFocusOverlayWidth,
  edgeGrowProgress,
  edgeLineWidth,
  edgeSegmentRatios,
  edgeStateAlpha,
  edgeWidthBucket,
  edgeWidthBucketIndex,
  mergeEdgeGrowWindows,
  OWNS_MEMORY_EDGE_TYPE,
  pruneFinishedEdgeGrowWindows,
} from "./edges.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";

describe("edgeKind — 연결 종류 4분기 (시각효과 Task 2·D5)", () => {
  test("엔티티 관계명은 entity_relation 이다", () => {
    expect(edgeKind("created_by")).toBe("entity_relation");
    expect(edgeKind("located_at")).toBe("entity_relation");
    expect(edgeKind("friend_of")).toBe("entity_relation");
  });

  test("서버가 entity_relation_edges 출처 메타를 실으면 새 관계명도 entity_relation 이다", () => {
    expect(
      edgeKind({
        id: "r",
        from: "entity:work:a",
        to: "person:p",
        type: "directed_by",
        weight: 0.75,
        meta: { edgeKind: "entity_relation", source: "entity_relation_edges" },
      }),
    ).toBe("entity_relation");
  });

  test("묶음 소속선(member_of)은 membership 이다", () => {
    expect(edgeKind("member_of")).toBe("membership");
  });

  test("프로젝트 소유선(owns_memory)은 project_ownership 이다 (D5)", () => {
    expect(edgeKind("owns_memory")).toBe("project_ownership");
    expect(edgeKind(OWNS_MEMORY_EDGE_TYPE)).toBe("project_ownership");
  });

  test("그 외 글 연결선은 memory_link 이다", () => {
    expect(edgeKind("contains_chunk")).toBe("memory_link");
    expect(edgeKind("classified_as")).toBe("memory_link");
    expect(edgeKind("")).toBe("memory_link");
    expect(edgeKind("unknown_type")).toBe("memory_link");
  });
});

describe("OWNS_MEMORY_EDGE_TYPE — web 단일 출처 (D5·spec 5.2)", () => {
  test("서버 owns_memory 와 같은 문자열을 web 에 직접 둔다", () => {
    expect(OWNS_MEMORY_EDGE_TYPE).toBe("owns_memory");
  });
});

describe("edgeColorForKind — 종류별 전용 색 (D5·spec 6.2)", () => {
  test("project_ownership 은 edgeProjectOwnership 토큰 색(진한 청록 #00b8d9)을 돌려준다", () => {
    const color = edgeColorForKind("project_ownership");
    expect(color).not.toBeNull();
    const expected = new THREE.Color(GRAPH_RENDER_THEME.edgeProjectOwnership);
    expect(color!.getHexString()).toBe(expected.getHexString());
    expect(color!.getHexString()).toBe("00b8d9");
  });

  test("프로젝트 소유선 색은 관계선·소속선과 다르다", () => {
    const ownership = edgeColorForKind("project_ownership")!;
    const relation = edgeColorForKind("entity_relation")!;
    const membership = edgeColorForKind("membership")!;
    expect(ownership.getHexString()).not.toBe(relation.getHexString());
    expect(ownership.getHexString()).not.toBe(membership.getHexString());
  });

  test("프로젝트 소유선 색은 글↔글(memory_link 그라디언트 양 끝)과 다르다", () => {
    const ownership = edgeColorForKind("project_ownership")!.getHexString();
    expect(ownership).not.toBe(
      new THREE.Color(GRAPH_RENDER_THEME.edgeLow).getHexString(),
    );
    expect(ownership).not.toBe(
      new THREE.Color(GRAPH_RENDER_THEME.edgeHigh).getHexString(),
    );
  });

  test("memory_link(글↔글)는 종류 전용 색이 없어 null 을 돌려준다", () => {
    expect(edgeColorForKind("memory_link")).toBeNull();
  });

  test("clone 을 돌려줘 호출처 변형이 토큰 색에 새지 않는다", () => {
    const a = edgeColorForKind("project_ownership")!;
    const b = edgeColorForKind("project_ownership")!;
    a.setRGB(0, 0, 0);
    expect(b.getHexString()).toBe("00b8d9");
  });
});

describe("entity relation edge visibility — 관계선 별도 표현", () => {
  test("관계선은 같은 weight 의 일반선보다 굵다", () => {
    const relation = { id: "r", from: "work:a", to: "person:p", type: "created_by", weight: 0.75 };
    const memory = { id: "m", from: "node:1", to: "node:2", type: "related_to", weight: 0.75 };

    expect(edgeLineWidth(relation)).toBeGreaterThan(edgeLineWidth(memory));
  });

  test("새 관계명도 entity_relation_edges 메타가 있으면 굵은 점선으로 그린다", () => {
    const relation = {
      id: "r",
      from: "work:a",
      to: "person:p",
      type: "directed_by",
      weight: 0.75,
      meta: { edgeKind: "entity_relation", source: "entity_relation_edges" },
    };
    const memory = { id: "m", from: "node:1", to: "node:2", type: "directed_by", weight: 0.75 };

    expect(edgeLineWidth(relation)).toBeGreaterThan(edgeLineWidth(memory));
    expect(edgeSegmentRatios(relation, 8).length).toBeGreaterThan(1);
    expect(edgeSegmentRatios(memory, 8)).toEqual([{ start: 0, end: 1 }]);
  });

  test("관계선은 여러 segment 로 나뉘어 점선처럼 그려진다", () => {
    const relation = { id: "r", from: "work:a", to: "person:p", type: "created_by", weight: 0.75 };
    const segments = edgeSegmentRatios(relation, 8);

    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]).toMatchObject({ start: 0 });
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.start).toBeGreaterThan(segments[i - 1]!.end);
    }
    expect(segments.at(-1)!.end).toBeLessThanOrEqual(1);
  });

  test("일반선은 하나의 실선 segment 로 유지된다", () => {
    const memory = { id: "m", from: "node:1", to: "node:2", type: "related_to", weight: 0.75 };

    expect(edgeSegmentRatios(memory, 8)).toEqual([{ start: 0, end: 1 }]);
  });

  test("관계선 ambient 밝기는 일반 ambient fade 보다 낮아지지 않는다", () => {
    const relation = { id: "r", from: "work:a", to: "person:p", type: "created_by", weight: 0.75 };
    const memory = { id: "m", from: "node:1", to: "node:2", type: "related_to", weight: 0.75 };

    expect(edgeColorAlpha(relation, "ambient", 1)).toBeGreaterThan(
      edgeColorAlpha(memory, "ambient", 1),
    );
    expect(edgeColorAlpha(relation, "ambient", 1)).toBeGreaterThanOrEqual(0.72);
  });
});

describe("edgeStateAlpha — focus/ambient/dim 밝기 단계", () => {
  test("focus 는 ambient 보다, ambient 는 dim 보다 선명하다", () => {
    expect(edgeStateAlpha("focus")).toBeGreaterThan(edgeStateAlpha("ambient"));
    expect(edgeStateAlpha("ambient")).toBeGreaterThan(edgeStateAlpha("dim"));
  });

  test("값은 그래프 렌더 토큰을 따른다", () => {
    expect(edgeStateAlpha("focus")).toBe(GRAPH_RENDER_THEME.edgeFocusAlpha);
    expect(edgeStateAlpha("ambient")).toBe(GRAPH_RENDER_THEME.edgeAmbientAlpha);
    expect(edgeStateAlpha("dim")).toBe(GRAPH_RENDER_THEME.edgeDimAlpha);
  });
});

describe("edgeDepthFadeMultiplier — 화면 깊이 순위 fade", () => {
  test("ambient 는 앞쪽에서는 유지되고 뒤쪽에서는 floor 까지만 흐려진다", () => {
    expect(edgeDepthFadeMultiplier("ambient", 0)).toBe(1);
    expect(edgeDepthFadeMultiplier("ambient", GRAPH_RENDER_THEME.edgeAmbientDepthFadeStart / 2)).toBe(1);
    expect(edgeDepthFadeMultiplier("ambient", 1)).toBeCloseTo(
      GRAPH_RENDER_THEME.edgeAmbientDepthFadeFloor,
      5,
    );
  });

  test("ambient 중간 깊이는 floor 와 1 사이의 배율을 받는다", () => {
    const mid = edgeDepthFadeMultiplier("ambient", 0.7);
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(GRAPH_RENDER_THEME.edgeAmbientDepthFadeFloor);
  });

  test("focus 와 dim 은 화면 깊이 fade 를 받지 않는다", () => {
    expect(edgeDepthFadeMultiplier("focus", 1)).toBe(1);
    expect(edgeDepthFadeMultiplier("dim", 1)).toBe(1);
  });
});

describe("edgeWidthBucketIndex — 강도→버킷 색인 (시각효과 Task 2)", () => {
  const steps = GRAPH_RENDER_THEME.edgeWidthSteps.length;

  test("약한 연결은 낮은 색인, 강한 연결은 높은 색인이다", () => {
    expect(edgeWidthBucketIndex(0.1)).toBeLessThan(edgeWidthBucketIndex(0.9));
  });

  test("weight 는 0~1 로 clamp 된다", () => {
    expect(edgeWidthBucketIndex(-1)).toBe(edgeWidthBucketIndex(0));
    expect(edgeWidthBucketIndex(5)).toBe(edgeWidthBucketIndex(1));
  });

  test("색인은 steps 범위를 벗어나지 않는다", () => {
    expect(edgeWidthBucketIndex(0)).toBeGreaterThanOrEqual(0);
    expect(edgeWidthBucketIndex(1)).toBe(steps - 1);
    expect(edgeWidthBucketIndex(0.999)).toBeLessThanOrEqual(steps - 1);
  });
});

describe("edgeWidthBucket — 강도→굵기 값 (시각효과 Task 2)", () => {
  test("약한 연결이 강한 연결보다 가늘다", () => {
    expect(edgeWidthBucket(0.1)).toBeLessThan(edgeWidthBucket(0.9));
  });

  test("weight 는 0~1 로 clamp 된다", () => {
    expect(edgeWidthBucket(-1)).toBe(edgeWidthBucket(0));
    expect(edgeWidthBucket(5)).toBe(edgeWidthBucket(1));
  });

  test("반환 굵기는 토큰 edgeWidthSteps 의 값 가운데 하나다", () => {
    const steps = GRAPH_RENDER_THEME.edgeWidthSteps;
    expect(steps).toContain(edgeWidthBucket(0));
    expect(steps).toContain(edgeWidthBucket(1));
    expect(steps).toContain(edgeWidthBucket(0.5));
  });
});

describe("edgeFocusOverlayWidth — focus 오버레이 굵기 (1차 연결선 강조)", () => {
  test("오버레이 굵기 = 배경 버킷 굵기 + edgeFocusWidthBoost 토큰", () => {
    const base = edgeLineWidth({ id: "m", from: "n1", to: "n2", type: "related_to", weight: 0.5 });
    expect(edgeFocusOverlayWidth(base)).toBeCloseTo(
      base + GRAPH_RENDER_THEME.edgeFocusWidthBoost,
      10,
    );
  });

  test("오버레이는 항상 그 버킷 배경선보다 굵다(boost 가 양수)", () => {
    expect(GRAPH_RENDER_THEME.edgeFocusWidthBoost).toBeGreaterThan(0);
    for (const w of GRAPH_RENDER_THEME.edgeWidthSteps) {
      expect(edgeFocusOverlayWidth(w)).toBeGreaterThan(w);
    }
  });

  test("관계선 버킷(더 굵은 최소값) 위에서도 boost 만큼만 더한다", () => {
    const relationWidth = edgeLineWidth({
      id: "r",
      from: "work:a",
      to: "person:p",
      type: "created_by",
      weight: 0.75,
    });
    expect(edgeFocusOverlayWidth(relationWidth)).toBeCloseTo(
      relationWidth + GRAPH_RENDER_THEME.edgeFocusWidthBoost,
      10,
    );
  });
});

describe("focus 오버레이 토큰 — graph-theme 단일 출처", () => {
  test("edgeFocusWidthBoost 는 사용자 요청 수치 0.02 다", () => {
    expect(GRAPH_RENDER_THEME.edgeFocusWidthBoost).toBe(0.02);
  });

  test("edgeFocusOverlayOpacity 는 배경 버킷 투명도보다 진하다", () => {
    expect(GRAPH_RENDER_THEME.edgeFocusOverlayOpacity).toBe(0.85);
    // 배경 버킷 최대 투명도(edgeOpacitySteps 마지막)보다 또렷해야 focus 가 배경 위로 읽힌다.
    const maxBucketOpacity = Math.max(...GRAPH_RENDER_THEME.edgeOpacitySteps);
    expect(GRAPH_RENDER_THEME.edgeFocusOverlayOpacity).toBeGreaterThan(maxBucketOpacity);
  });
});

describe("edge grow windows — 연속 입력 연결선 자람 상태", () => {
  test("startedAt 이전에는 새 엣지가 아직 보이지 않는다", () => {
    expect(edgeGrowProgress({ startedAt: 10, durationS: 1 }, 9.9)).toBe(0);
  });

  test("새 setGrowing 이 기존 자람 key 를 지우거나 리셋하지 않는다", () => {
    const first = mergeEdgeGrowWindows(new Map(), new Set(["a b memory_link"]), 10, 1);
    const second = mergeEdgeGrowWindows(first, new Set(["c d memory_link"]), 10.4, 1);

    expect(second.get("a b memory_link")).toEqual({ startedAt: 10, durationS: 1 });
    expect(second.get("c d memory_link")).toEqual({ startedAt: 10.4, durationS: 1 });
    expect(edgeGrowProgress(second.get("a b memory_link"), 10.5)).toBeCloseTo(0.5, 5);
    expect(edgeGrowProgress(second.get("c d memory_link"), 10.5)).toBeCloseTo(0.1, 5);
  });

  test("끝난 key 만 pruning 하고 아직 자라는 key 는 남긴다", () => {
    const current = new Map([
      ["done", { startedAt: 1, durationS: 1 }],
      ["live", { startedAt: 1.6, durationS: 1 }],
    ]);
    const pruned = pruneFinishedEdgeGrowWindows(current, 2.1);

    expect(pruned.has("done")).toBe(false);
    expect(pruned.get("live")).toEqual({ startedAt: 1.6, durationS: 1 });
  });
});
