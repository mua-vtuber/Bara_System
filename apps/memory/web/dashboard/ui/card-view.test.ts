/**
 * apps/memory/web/dashboard/ui/card-view.test.ts
 *
 * fromSearchHit / fromGraphHit 순수 함수 단위 테스트.
 * DOM 불필요 — happy-dom 등록 없음.
 * fixture 데이터만 사용. Mock 0.
 */
import { test, expect } from "bun:test";
import {
  fromSearchHit,
  fromGraphHit,
  fromGraphNode,
  type ApiSearchResult,
  type GraphOverviewNode,
  type GraphNodeRef,
} from "./card-view.ts";

// ──────────────────────────────────────────────
// fromSearchHit — 풍부 fixture
// ──────────────────────────────────────────────

const richResult: ApiSearchResult = {
  id: 7,
  content:
    "마트에서 사과 세 개를 샀다. 계산대 앞에서 한참 기다렸지만 점원이 친절했다.",
  memoryType: "event",
  importance: 0.9,
  confidence: 0.5,
  createdAt: "2026-06-10T14:00:00Z",
  sourceType: "bot",
  score: 0.82,
  sources: ["keyword", "vector"],
  components: { keyword: 0.4, vector: 0.42 },
  taggedWith: [
    { category: "장소", value: "마트" },
    { category: "행동", value: "쇼핑" },
  ],
  revision: { supersedes: true, superseded: false },
};

test("fromSearchHit: nodeId 가 mem:7 이다", () => {
  const card = fromSearchHit(richResult);
  expect(card.nodeId).toBe("mem:7");
});

test("fromSearchHit: score 와 sources 를 그대로 가져온다", () => {
  const card = fromSearchHit(richResult);
  expect(card.score).toBe(0.82);
  expect(card.sources).toEqual(["keyword", "vector"]);
});

test("fromSearchHit: components 를 그대로 가져온다", () => {
  const card = fromSearchHit(richResult);
  expect(card.components).toEqual({ keyword: 0.4, vector: 0.42 });
});

test("fromSearchHit: importance >= 0.8 이면 markers.important 가 true 이다", () => {
  const card = fromSearchHit(richResult);
  expect(card.markers?.important).toBe(true);
});

test("fromSearchHit: confidence < 0.6 이면 markers.uncertain 이 true 이다", () => {
  const card = fromSearchHit(richResult);
  expect(card.markers?.uncertain).toBe(true);
});

test("fromSearchHit: revision.supersedes=true 면 markers.supersedes 가 true 이다", () => {
  const card = fromSearchHit(richResult);
  expect(card.markers?.supersedes).toBe(true);
});

test("fromSearchHit: revision.superseded=false 면 markers.superseded 가 false 이다", () => {
  const card = fromSearchHit(richResult);
  expect(card.markers?.superseded).toBe(false);
});

test("fromSearchHit: taggedWith 를 '장소: 마트' 형식 tags 배열로 변환한다", () => {
  const card = fromSearchHit(richResult);
  expect(card.tags).toEqual(["장소: 마트", "행동: 쇼핑"]);
});

test("fromSearchHit: title 이 40자 이하이면 그대로 쓴다", () => {
  const short: ApiSearchResult = {
    ...richResult,
    content: "짧은 메모",
  };
  const card = fromSearchHit(short);
  expect(card.title).toBe("짧은 메모");
});

test("fromSearchHit: content 첫 줄이 40자를 넘으면 잘라서 … 붙인다", () => {
  const long: ApiSearchResult = {
    ...richResult,
    content: "가".repeat(50) + "\n두 번째 줄",
  };
  const card = fromSearchHit(long);
  expect(card.title.endsWith("…")).toBe(true);
  expect(card.title.length).toBeLessThanOrEqual(41); // 40자 + "…"
});

test("fromSearchHit: snippet 은 content 전체이다", () => {
  const card = fromSearchHit(richResult);
  expect(card.snippet).toBe(richResult.content);
});

test("fromSearchHit: date 가 createdAt 과 같다", () => {
  const card = fromSearchHit(richResult);
  expect(card.date).toBe("2026-06-10T14:00:00Z");
});

test("fromSearchHit: matchReason·state·people 은 undefined 이다", () => {
  const card = fromSearchHit(richResult);
  expect(card.matchReason).toBeUndefined();
  expect(card.state).toBeUndefined();
  expect(card.people).toBeUndefined();
});

// ──────────────────────────────────────────────
// fromSearchHit — 경계: 없는 칸
// ──────────────────────────────────────────────

test("fromSearchHit: importance 없으면 markers.important 가 false 이다", () => {
  const noImportance: ApiSearchResult = {
    ...richResult,
    importance: undefined,
  };
  const card = fromSearchHit(noImportance);
  expect(card.markers?.important).toBe(false);
});

test("fromSearchHit: confidence 없으면 markers.uncertain 이 false 이다", () => {
  const noConfidence: ApiSearchResult = {
    ...richResult,
    confidence: undefined,
  };
  const card = fromSearchHit(noConfidence);
  expect(card.markers?.uncertain).toBe(false);
});

test("fromSearchHit: taggedWith 없으면 tags 가 undefined 이다", () => {
  const noTags: ApiSearchResult = {
    ...richResult,
    taggedWith: undefined,
  };
  const card = fromSearchHit(noTags);
  expect(card.tags).toBeUndefined();
});

test("fromSearchHit: taggedWith 빈 배열이면 tags 가 undefined 이다", () => {
  const emptyTags: ApiSearchResult = {
    ...richResult,
    taggedWith: [],
  };
  const card = fromSearchHit(emptyTags);
  expect(card.tags).toBeUndefined();
});

test("fromSearchHit: revision 없으면 markers.supersedes/superseded 가 false 이다", () => {
  const noRevision: ApiSearchResult = {
    ...richResult,
    revision: undefined,
  };
  const card = fromSearchHit(noRevision);
  expect(card.markers?.supersedes).toBe(false);
  expect(card.markers?.superseded).toBe(false);
});

// ──────────────────────────────────────────────
// fromGraphHit — 빈약 fixture
// ──────────────────────────────────────────────

const sparseNode: GraphOverviewNode = {
  id: "mem:42",
  label: "산책 중에 생각한 것들",
  snippet: "날씨가 좋아서 한강변을 걸었다.",
  sourceType: "bot",
  createdAt: "2026-06-11T09:00:00Z",
  // importance·confidence 미제공
};

const sparseRef: GraphNodeRef = {
  nodeId: "mem:42",
  score: 0.71,
};

test("fromGraphHit: nodeId 가 node.id 그대로이다", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.nodeId).toBe("mem:42");
});

test("fromGraphHit: title 이 node.label 이다", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.title).toBe("산책 중에 생각한 것들");
});

test("fromGraphHit: snippet 이 node.snippet 이다", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.snippet).toBe("날씨가 좋아서 한강변을 걸었다.");
});

test("fromGraphHit: sourceType 이 node.sourceType 이다", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.sourceType).toBe("bot");
});

test("fromGraphHit: score 가 ref.score 이다", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.score).toBe(0.71);
});

test("fromGraphHit: date 가 node.createdAt 이다", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.date).toBe("2026-06-11T09:00:00Z");
});

test("fromGraphHit: sources 가 undefined 이다 (서버 미제공)", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.sources).toBeUndefined();
});

test("fromGraphHit: components 가 undefined 이다 (서버 미제공)", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.components).toBeUndefined();
});

test("fromGraphHit: matchReason 이 undefined 이다 (서버 미제공)", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.matchReason).toBeUndefined();
});

test("fromGraphHit: markers.supersedes 가 undefined 이다 (서버 미제공)", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.markers?.supersedes).toBeUndefined();
});

test("fromGraphHit: markers.superseded 가 undefined 이다 (서버 미제공)", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.markers?.superseded).toBeUndefined();
});

test("fromGraphHit: tags 가 undefined 이다 (서버 미제공)", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.tags).toBeUndefined();
});

test("fromGraphHit: people 이 undefined 이다 (서버 미제공)", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.people).toBeUndefined();
});

// ──────────────────────────────────────────────
// fromGraphHit — 경계: importance/confidence 없음
// ──────────────────────────────────────────────

test("fromGraphHit: importance 없으면 markers.important 가 false 이다", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.markers?.important).toBe(false);
});

test("fromGraphHit: confidence 없으면 markers.uncertain 이 false 이다", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.markers?.uncertain).toBe(false);
});

test("fromGraphHit: importance >= 0.8 이면 markers.important 가 true 이다", () => {
  const importantNode: GraphOverviewNode = {
    ...sparseNode,
    importance: 0.85,
  };
  const card = fromGraphHit(importantNode, sparseRef);
  expect(card.markers?.important).toBe(true);
});

test("fromGraphHit: confidence < 0.6 이면 markers.uncertain 이 true 이다", () => {
  const uncertainNode: GraphOverviewNode = {
    ...sparseNode,
    confidence: 0.3,
  };
  const card = fromGraphHit(uncertainNode, sparseRef);
  expect(card.markers?.uncertain).toBe(true);
});

// ──────────────────────────────────────────────
// fromGraphNode — 노드 단독(검색 hit 없이) 변환
// ──────────────────────────────────────────────

const overviewNode: GraphOverviewNode = {
  id: "concept:달리기",
  label: "달리기",
  snippet: "매일 아침 5km 를 달린다.",
  sourceType: "concept",
  type: "concept",
  createdAt: "2026-06-18T08:00:00Z",
  importance: 0.85,
  confidence: 0.9,
  // score 없음 — 검색 hit 아닌 일반 노드
};

test("fromGraphNode: nodeId 가 node.id 이다", () => {
  const card = fromGraphNode(overviewNode);
  expect(card.nodeId).toBe("concept:달리기");
});

test("fromGraphNode: title 이 node.label 이다", () => {
  const card = fromGraphNode(overviewNode);
  expect(card.title).toBe("달리기");
});

test("fromGraphNode: snippet 이 node.snippet 이다", () => {
  const card = fromGraphNode(overviewNode);
  expect(card.snippet).toBe("매일 아침 5km 를 달린다.");
});

test("fromGraphNode: nodeType 이 node.type 이다", () => {
  const card = fromGraphNode(overviewNode);
  expect(card.nodeType).toBe("concept");
});

test("fromGraphNode: sourceType 이 node.sourceType 이다", () => {
  const card = fromGraphNode(overviewNode);
  expect(card.sourceType).toBe("concept");
});

test("fromGraphNode: date 가 node.createdAt 이다", () => {
  const card = fromGraphNode(overviewNode);
  expect(card.date).toBe("2026-06-18T08:00:00Z");
});

test("fromGraphNode: node.score 없으면 score 가 undefined 이다 (가짜 0 금지)", () => {
  const card = fromGraphNode(overviewNode);
  expect(card.score).toBeUndefined();
});

test("fromGraphNode: node.score 있으면 그대로 전달된다", () => {
  const nodeWithScore: GraphOverviewNode = {
    ...overviewNode,
    score: 0.63,
  };
  const card = fromGraphNode(nodeWithScore);
  expect(card.score).toBe(0.63);
});

test("fromGraphNode: importance >= 0.8 이면 markers.important 가 true 이다", () => {
  const card = fromGraphNode(overviewNode);
  expect(card.markers?.important).toBe(true);
});

test("fromGraphNode: confidence >= 0.6 이면 markers.uncertain 이 false 이다", () => {
  const card = fromGraphNode(overviewNode);
  expect(card.markers?.uncertain).toBe(false);
});

test("fromGraphNode: importance 없으면 markers.important 가 false 이다", () => {
  const noImportance: GraphOverviewNode = { ...overviewNode, importance: undefined };
  const card = fromGraphNode(noImportance);
  expect(card.markers?.important).toBe(false);
});

test("fromGraphNode: confidence < 0.6 이면 markers.uncertain 이 true 이다", () => {
  const lowConf: GraphOverviewNode = { ...overviewNode, confidence: 0.4 };
  const card = fromGraphNode(lowConf);
  expect(card.markers?.uncertain).toBe(true);
});

test("fromGraphNode: sources·components·matchReason·state·tags·people 는 undefined 이다", () => {
  const card = fromGraphNode(overviewNode);
  expect(card.sources).toBeUndefined();
  expect(card.components).toBeUndefined();
  expect(card.matchReason).toBeUndefined();
  expect(card.state).toBeUndefined();
  expect(card.tags).toBeUndefined();
  expect(card.people).toBeUndefined();
});

test("fromGraphNode: 그래프 메모리 제목·snippet 에서 해시태그를 숨기고 키워드 태그만 tags 로 보낸다", () => {
  const card = fromGraphNode({
    id: "node:77",
    type: "memory",
    sourceType: "user_explicit",
    label: "그래프 모달 정리",
    snippet: "#아이디어 #작품:소설, #장르:판타지, 그래프 모달 정리",
  });
  expect(card.title).toBe("그래프 모달 정리");
  expect(card.snippet).toBe("그래프 모달 정리");
  expect(card.tags).toEqual(["#아이디어"]);
});

test("fromGraphNode: 엔티티·분류 노드는 snippet 태그를 tags 로 승격하지 않는다", () => {
  const card = fromGraphNode({
    id: "concept:work",
    type: "classification_key",
    sourceType: "classification_key",
    label: "작품",
    snippet: "#아이디어 구조 설명",
  });
  expect(card.title).toBe("작품");
  expect(card.snippet).toBe("#아이디어 구조 설명");
  expect(card.tags).toBeUndefined();
});

// ──────────────────────────────────────────────
// fromGraphHit — 그래프 검색채널·revision 칸 (Task 6.5)
// ──────────────────────────────────────────────

test("fromGraphHit: ref.sources 있으면 CardView.sources 에 그대로 담긴다", () => {
  const refWithSources: GraphNodeRef = {
    ...sparseRef,
    sources: ["fts", "vector"],
  };
  const card = fromGraphHit(sparseNode, refWithSources);
  expect(card.sources).toEqual(["fts", "vector"]);
});

test("fromGraphHit: ref.sources 없으면 CardView.sources 가 undefined 이다", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.sources).toBeUndefined();
});

test("fromGraphHit: ref.components 있으면 CardView.components 에 그대로 담긴다", () => {
  const refWithComponents: GraphNodeRef = {
    ...sparseRef,
    components: { fts: 0.6, vector: 0.4 },
  };
  const card = fromGraphHit(sparseNode, refWithComponents);
  expect(card.components).toEqual({ fts: 0.6, vector: 0.4 });
});

test("fromGraphHit: ref.revision.supersedes=true 면 markers.supersedes 가 true 이다", () => {
  const refWithRevision: GraphNodeRef = {
    ...sparseRef,
    revision: { supersedes: true, superseded: false },
  };
  const card = fromGraphHit(sparseNode, refWithRevision);
  expect(card.markers?.supersedes).toBe(true);
  expect(card.markers?.superseded).toBe(false);
});

test("fromGraphHit: ref.revision.superseded=true 면 markers.superseded 가 true 이다", () => {
  const refWithRevision: GraphNodeRef = {
    ...sparseRef,
    revision: { supersedes: false, superseded: true },
  };
  const card = fromGraphHit(sparseNode, refWithRevision);
  expect(card.markers?.superseded).toBe(true);
  expect(card.markers?.supersedes).toBe(false);
});

test("fromGraphHit: ref.revision 없으면 markers.supersedes/superseded 가 undefined 이다", () => {
  const card = fromGraphHit(sparseNode, sparseRef);
  expect(card.markers?.supersedes).toBeUndefined();
  expect(card.markers?.superseded).toBeUndefined();
});
