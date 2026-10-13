/**
 * apps/memory/web/dashboard/ui/card-view.ts
 *
 * index `/search` 응답과 그래프 `/graph/search` 응답을
 * 같은 CardView 한 모양으로 정규화하는 순수 함수 모음.
 *
 * 아키텍처 규칙:
 *   - 이 파일은 공유 기반 층(ui/)이다. ../graph/ 에서 import 하지 않는다.
 *   - 입력 응답 모양은 아래 구조 인터페이스로 자체 선언한다.
 *   - 부수효과·전역 변경 0.
 */
import {
  displaySnippetWithoutHashtags,
  displayTitleForNode,
  displayTextWithoutHashtags,
  isContentDisplayNode,
  keywordTagLabelsFromText,
  mergeTagLabels,
} from "./hashtag-display.ts";

// ──────────────────────────────────────────────
// 1. 입력 응답 구조 인터페이스 (자체 선언 — graph 모듈 import 없음)
// ──────────────────────────────────────────────

/** index /search 결과 항목 */
export interface ApiSearchResult {
  id: number;
  content: string;
  memoryType?: string;
  importance?: number;
  confidence?: number;
  createdAt?: string;
  sourceType?: string;
  score: number;
  sources: string[];
  components: Record<string, number>;
  taggedWith?: Array<{ category: string; value: string }>;
  revision?: { superseded: boolean; supersedes: boolean };
  /** 단계6 — 일정 시작 일시(event_at). 없으면 undefined. */
  eventAt?: string | null;
  /** 단계6 — 일정 종료 일시(event_until). 없으면 undefined. */
  eventUntil?: string | null;
  /** 단계6 — 글의 분류 종류명. 검색 통로(getNodeKind)·그래프 통로(T1c bulk enrich) 공유. 종류 없으면 null. */
  kind?: string | null;
}

/** 그래프 /graph/search subgraph 노드, 또는 overview 노드 */
export interface GraphOverviewNode {
  id: string;
  sourceType?: string;
  label: string;
  snippet?: string;
  importance?: number;
  confidence?: number;
  createdAt?: string;
  /** 노드 종류 문자열 (예: "document" · "concept" · "person"). 있을 때만. */
  type?: string;
  /** 검색 점수. 검색 hit 가 아닌 일반 노드 클릭 시에는 없다. 가짜 0 금지. */
  score?: number;
  /** 단계6 — 일정 시작 일시(event_at). 글·문서 노드만 채움. */
  eventAt?: string;
  /** 단계6 — 일정 종료 일시(event_until). 기간 표기용. 단일 시점이면 undefined. */
  eventUntil?: string;
  /** 단계6 T1c — 글의 분류 종류명. graph 라우트 bulk enrich 로 채워진다. 없으면 undefined. */
  kind?: string;
}

/**
 * 그래프 검색 결과 hit 참조.
 * top3 또는 개별 hit 에 들어있는 (nodeId, score) 쌍.
 * score 는 서버 hit 가 점수를 싣지 않을 수도 있어 선택적이다 — 없으면
 * CardView.score 도 undefined 로 흘러 가짜 0 없이 정직하게 처리된다.
 */
export interface GraphNodeRef {
  nodeId: string;
  score?: number;
  sources?: string[];
  components?: Record<string, number>;
  revision?: { superseded: boolean; supersedes: boolean };
}

// ──────────────────────────────────────────────
// 2. 출력 타입
// ──────────────────────────────────────────────

export type CardView = {
  nodeId: string;
  title: string;
  snippet?: string;
  nodeType?: string;
  sourceType?: string;
  score?: number;
  sources?: string[];
  matchReason?: string[];
  renderMode?: "plain" | "markdown";
  state?: string;
  markers?: {
    important?: boolean;
    uncertain?: boolean;
    supersedes?: boolean;
    superseded?: boolean;
  };
  tags?: string[];
  people?: string[];
  date?: string;
  components?: Record<string, number>;
  /** 단계6 — 일정 시작 일시. 있으면 제목 앞에 시간 배지 표시. */
  eventAt?: string;
  /** 단계6 — 일정 종료 일시. 기간 표기용. */
  eventUntil?: string;
  /** 단계6 — 분류 종류명. 있으면 점수 앞에 종류 배지 표시. */
  kind?: string;
  /** 이 노드 자체 또는 이 노드 아래에 붙은 이미지 미리보기. */
  images?: ImagePreview[];
};

export interface ImagePreview {
  nodeId?: number;
  assetSha256: string;
  thumbSha256?: string;
  width?: number;
  height?: number;
  mime?: string;
  alt?: string;
}

// ──────────────────────────────────────────────
// 3. 내부 헬퍼
// ──────────────────────────────────────────────

/**
 * content 첫 줄 또는 전체를 40자 안팎에서 잘라 제목으로 쓴다.
 * 잘린 경우 "…" 을 추가한다.
 */
function extractTitle(content: string): string {
  const displayContent = displayTextWithoutHashtags(content) || content;
  const firstLine = displayContent.split("\n")[0] ?? displayContent;
  if (firstLine.length <= 40) return firstLine;
  return firstLine.slice(0, 40) + "…";
}

/**
 * importance 값이 있고 0.8 이상이면 중요 표시.
 * 값이 없으면 false — 가짜 마커 금지.
 */
function isImportant(importance: number | undefined): boolean {
  return importance != null && importance >= 0.8;
}

/**
 * confidence 값이 있고 0.6 미만이면 불확실 표시.
 * 값이 없으면 false — 가짜 미확인 금지.
 */
function isUncertain(confidence: number | undefined): boolean {
  return typeof confidence === "number" && confidence < 0.6;
}

// ──────────────────────────────────────────────
// 4. 정규화 함수
// ──────────────────────────────────────────────

/**
 * index /search 결과 항목 하나를 CardView 로 정규화한다.
 *
 * nodeId 규칙: `mem:${result.id}`
 *   — index 목록은 그래프 노드 id 와 교차참조하지 않으므로
 *     자체 접두사 규칙(mem:)으로 생성한다.
 */
export function fromSearchHit(result: ApiSearchResult): CardView {
  const markers: CardView["markers"] = {};
  markers.important = isImportant(result.importance);
  markers.uncertain = isUncertain(result.confidence);
  markers.supersedes = result.revision?.supersedes === true;
  markers.superseded = result.revision?.superseded === true;

  const tags =
    result.taggedWith != null && result.taggedWith.length > 0
      ? result.taggedWith.map((t) => `${t.category}: ${t.value}`)
      : undefined;
  const keywordTags = keywordTagLabelsFromText(result.content);

  return {
    nodeId: `mem:${result.id}`,
    title: extractTitle(result.content),
    snippet: displaySnippetWithoutHashtags(result.content),
    sourceType: result.sourceType,
    score: result.score,
    sources: result.sources,
    components: result.components,
    markers,
    tags: mergeTagLabels(keywordTags, tags),
    date: result.createdAt,
    eventAt: result.eventAt ?? undefined,
    eventUntil: result.eventUntil ?? undefined,
    // 종류 배지 — T1a 가 신설한 result.kind(getNodeKind)에서 읽는다(taggedWith 아님 —
    // taggedWith 는 image_asset 전용). 종류 없으면 undefined(가짜 0 금지).
    kind: result.kind ?? undefined,
    // matchReason·state·people — 이 응답에 없으므로 설정 안 함
  };
}

/**
 * 그래프 /graph/search subgraph 노드와 hit 참조를 CardView 로 정규화한다.
 *
 * 서버가 제공하지 않는 칸(sources·components·matchReason·state·tags·
 * revision(supersedes/superseded)·people)은 undefined 로 두고 채우지 않는다.
 */
export function fromGraphHit(
  node: GraphOverviewNode,
  ref: GraphNodeRef
): CardView {
  const markers: CardView["markers"] = {};
  markers.important = isImportant(node.importance);
  markers.uncertain = isUncertain(node.confidence);
  if (ref.revision != null) {
    markers.supersedes = ref.revision.supersedes === true;
    markers.superseded = ref.revision.superseded === true;
  }
  const contentNode = isContentDisplayNode(node);

  return {
    nodeId: node.id,
    title: contentNode ? displayTitleForNode(node) : node.label,
    snippet: contentNode ? displaySnippetWithoutHashtags(node.snippet) : node.snippet,
    nodeType: node.type,
    sourceType: node.sourceType,
    score: ref.score,
    sources: ref.sources,
    components: ref.components,
    markers,
    date: node.createdAt,
    eventAt: node.eventAt,
    eventUntil: node.eventUntil,
    // 단계6 T1c — graph 라우트 enrich 로 채워진 kind 를 전달한다. 없으면 undefined.
    kind: node.kind,
    tags: contentNode
      ? mergeTagLabels(keywordTagLabelsFromText(node.snippet ?? node.label))
      : undefined,
    // matchReason·state·people — 미제공
  };
}

/**
 * 검색 hit 없이 노드 하나만으로 CardView 를 만든다.
 * 노드 클릭(상세창) 시 사용한다 — score 없는 노드도 정직하게 처리한다.
 *
 * score 규칙:
 *   - node.score 가 있으면 그대로 전달한다.
 *   - 없으면 undefined 를 유지한다. 가짜 0 금지.
 */
export function fromGraphNode(node: GraphOverviewNode): CardView {
  const markers: CardView["markers"] = {};
  markers.important = isImportant(node.importance);
  markers.uncertain = isUncertain(node.confidence);
  // supersedes·superseded — 노드 단독 표시에서는 제공되지 않으므로 설정 안 함
  const contentNode = isContentDisplayNode(node);

  return {
    nodeId: node.id,
    title: contentNode ? displayTitleForNode(node) : node.label,
    snippet: contentNode ? displaySnippetWithoutHashtags(node.snippet) : node.snippet,
    nodeType: node.type,
    sourceType: node.sourceType,
    // score 가 있을 때만 전달 — 가짜 0 금지
    score: node.score !== undefined ? node.score : undefined,
    markers,
    date: node.createdAt,
    eventAt: node.eventAt,
    eventUntil: node.eventUntil,
    // 단계6 T1c — graph 라우트 enrich 로 채워진 kind 를 전달한다. 없으면 undefined.
    kind: node.kind,
    tags: contentNode
      ? mergeTagLabels(keywordTagLabelsFromText(node.snippet ?? node.label))
      : undefined,
    // sources·components·matchReason·state·people — 미제공
  };
}
