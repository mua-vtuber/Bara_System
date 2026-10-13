/**
 * server-internal/routes/graph.ts — GET /graph/overview + POST /graph/search 라우트.
 *
 * GET /graph/overview:
 *   idle 그래프 화면이 "기억망 일부"를 보여주기 위해 호출하는 라우트다.
 *   최근 글(getRecent) + 그 글의 1-hop 이웃(getNeighbors) 합집합을 노드로 조립하고,
 *   그 노드들 사이의 엣지(양끝이 노드 집합 안인 것만)를 함께 회신한다.
 *
 * POST /graph/search:
 *   기존 retriever 검색 결과를 그래프 형태로 재포장한다.
 *   hit 노드 + 1-hop 이웃을 subgraph 로 조립하고 focus 정보를 덧붙인다.
 *   RRF 점수식 코어(rrf.ts·scoring.ts·search-tuning.ts) 불변 — retriever 호출만.
 *
 * 그래프 빌드 ②~⑨(노드 흡수·묶음 통합·거대 허브·글-선 정리·같은 이름 흡수)는 책임
 * 단위로 갈라 둔다(CLAUDE.md "파일 작게·책임 경계로 분리") — graph-nodes-shared.ts(공유
 * 토대)·graph-augment.ts(엔티티↔개념 흡수)·graph-group-nodes.ts(타입 묶음)·
 * graph-absorb-same-label.ts(⑧ 같은 이름 흡수)·graph-leaf-line.ts(⑦⑨ 글-선 정리).
 * 이 파일은 두 라우트와 그 빌드 파이프라인 호출만 맡는다(순수 분리·동작 불변).
 *
 * 공개 API 보존 — 다른 모듈·테스트가 graph.ts 에서 가져가던 export(타입·헬퍼·상수)는
 * 아래 re-export 로 같은 경로에서 그대로 가져갈 수 있게 둔다.
 *
 * 쓰기 0 / 스키마 변경 0 / RRF 코어 파일 변경 0.
 */

import type { Hono } from "hono";
import type { MemoryEdge, MemoryNode } from "../../memory/types.ts";
import type { MemoryApiDeps } from "../types.ts";
import { parseLimit, err } from "../http-helpers.ts";
import {
  parseKind,
  parseFieldFilters,
  parseFilter,
  parseImageSearch,
  resolveDateRange,
} from "./search-params.ts";
import {
  type GraphNode,
  type GraphEdge,
  type GraphOverviewResponse,
  type GraphSearchHit,
  type GraphSearchResponse,
  type AugmentResult,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  NEIGHBORS_PER_NODE,
  DOCS_IMAGES_LIMIT,
  DOCS_IMAGES_SOURCE_TYPES,
  nodeKey,
  toGraphNode,
  personToDetailedGraphNode,
  projectToDetailedGraphNode,
  entityToGraphNode,
  scheduleOccurrenceRowsForEntity,
  personKey,
  projectKey,
  entityKey,
} from "./graph-nodes-shared.ts";
import { augmentWithEntities } from "./graph-augment.ts";
import { drawEntityRelationEdgesFromRefs } from "./graph-augment-relations.ts";
import { attachStandaloneHierarchyBridges } from "./graph-augment-hierarchy-bridge.ts";
import { revealSearchRelationEdges } from "./graph-search-relation-reveal.ts";
import { buildGroupNodes } from "./graph-group-nodes.ts";
import { absorbSameLabelNodes } from "./graph-absorb-same-label.ts";
import { pruneClassificationLeafLines } from "./graph-leaf-line.ts";
import { explicitDisplayKind } from "../../memory/entity-type-classifier.ts";
import { ENTITY_TYPE_METAS } from "../../db/store-internal/entity-type-registry.ts";

// ── 공개 API re-export ────────────────────────────────────────────────────
// 분리 전 graph.ts 에서 직접 가져가던 심볼을 같은 경로에서 그대로 노출한다
// (다른 모듈·테스트 import 보존·순수 분리). 본 파일이 단일 진입점 역할도 겸한다.
export type {
  GraphNode,
  GraphEdge,
  GraphOverviewResponse,
  GraphSearchHit,
  GraphSearchFocus,
  GraphSearchResponse,
  AugmentResult,
} from "./graph-nodes-shared.ts";
export {
  PROJECTS_PER_NODE,
  PROJECT_MEMBER_NODES_LIMIT,
  OWNS_MEMORY_EDGE_TYPE,
  PROJECT_OWNS_WEIGHT,
  conceptToGraphNode,
} from "./graph-nodes-shared.ts";
export { augmentWithEntities, absorbConceptsIntoEntities } from "./graph-augment.ts";
export { buildGroupNodes } from "./graph-group-nodes.ts";
export { absorbSameLabelNodes } from "./graph-absorb-same-label.ts";
export { pruneClassificationLeafLines } from "./graph-leaf-line.ts";

// ── 내부 헬퍼 ────────────────────────────────────────────────────────────

const OVERVIEW_STANDALONE_PERSONS_LIMIT = 12;
const OVERVIEW_STANDALONE_PROJECTS_LIMIT = 12;
const OVERVIEW_STANDALONE_ENTITIES_PER_TYPE = 8;
const GRAPH_SEARCH_ENTITY_SEEDS_PER_KIND = 8;
const GRAPH_SEARCH_ENTITY_EXACT_SCORE = 1.0;
const GRAPH_SEARCH_ENTITY_PARTIAL_SCORE = 0.72;
const DERIVED_GRAPH_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "document_chunk",
  "llm_extract",
  "image_caption",
]);
const DERIVED_GRAPH_RELATIONS: ReadonlySet<string> = new Set([
  "merged_into",
  "parent_of",
]);
const DERIVED_CHILDREN_PER_EXPANDED_NODE = 200;

function emptyAugmentResult(): AugmentResult {
  return { entityRefs: [], personRefs: [], projectRefs: [] };
}

function mergeAugmentResults(left: AugmentResult, right: AugmentResult): AugmentResult {
  const merged = emptyAugmentResult();
  const entityKeys = new Set<string>();
  const personIds = new Set<string>();
  const projectIds = new Set<string>();

  for (const source of [left, right]) {
    for (const ref of source.entityRefs) {
      const key = `${ref.type}:${ref.id}`;
      if (entityKeys.has(key)) continue;
      entityKeys.add(key);
      merged.entityRefs.push(ref);
    }
    for (const personId of source.personRefs) {
      if (personIds.has(personId)) continue;
      personIds.add(personId);
      merged.personRefs.push(personId);
    }
    for (const projectId of source.projectRefs) {
      if (projectIds.has(projectId)) continue;
      projectIds.add(projectId);
      merged.projectRefs.push(projectId);
    }
  }

  return merged;
}

function isDerivedGraphNode(node: MemoryNode): boolean {
  return DERIVED_GRAPH_SOURCE_TYPES.has(node.sourceType);
}

function parseExpandedNodeIds(raw: string | undefined): Set<number> {
  const ids = new Set<number>();
  if (!raw) return ids;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const numeric = trimmed.startsWith("node:") ? trimmed.slice("node:".length) : trimmed;
    if (!/^\d+$/.test(numeric)) continue;
    const id = Number(numeric);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

function graphEdgeFromMemoryEdge(edge: MemoryEdge): GraphEdge {
  return {
    id: `edge:${edge.sourceId}-${edge.targetId}:${edge.relation}`,
    from: nodeKey(edge.sourceId),
    to: nodeKey(edge.targetId),
    type: edge.relation,
    weight: edge.weight,
  };
}

function addEdgeIfEndpointsExist(
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
  edge: MemoryEdge,
): void {
  const graphEdge = graphEdgeFromMemoryEdge(edge);
  if (nodeById.has(graphEdge.from) && nodeById.has(graphEdge.to)) {
    edgeSet.set(graphEdge.id, graphEdge);
  }
}

async function addVisibleNeighborSubgraph(
  store: MemoryApiDeps["store"],
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
  seedId: number,
): Promise<void> {
  const neighbors = await store.getNeighbors(seedId, NEIGHBORS_PER_NODE);
  for (const edge of neighbors) {
    for (const nbId of [edge.sourceId, edge.targetId]) {
      if (nodeById.has(nodeKey(nbId))) continue;
      const full = await store.getNode(nbId);
      if (!full || isDerivedGraphNode(full)) continue;
      nodeById.set(nodeKey(full.id), toGraphNode(full));
    }
    addEdgeIfEndpointsExist(nodeById, edgeSet, edge);
  }
}

function isDerivedChildEdge(edge: MemoryEdge, childId: number, originId: number): boolean {
  if (!DERIVED_GRAPH_RELATIONS.has(edge.relation)) return false;
  return (
    (edge.sourceId === childId && edge.targetId === originId) ||
    (edge.targetId === childId && edge.sourceId === originId)
  );
}

async function addDerivedChildrenForExpandedNodes(
  store: MemoryApiDeps["store"],
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
  expandedNodeIds: Set<number>,
): Promise<void> {
  for (const originId of expandedNodeIds) {
    if (!nodeById.has(nodeKey(originId))) continue;
    const neighbors = await store.getNeighbors(originId, DERIVED_CHILDREN_PER_EXPANDED_NODE);
    for (const edge of neighbors) {
      for (const nbId of [edge.sourceId, edge.targetId]) {
        if (nbId === originId) continue;
        const full = await store.getNode(nbId);
        if (!full || !isDerivedGraphNode(full)) continue;
        if (!isDerivedChildEdge(edge, full.id, originId)) continue;
        nodeById.set(nodeKey(full.id), toGraphNode(full));
        addEdgeIfEndpointsExist(nodeById, edgeSet, edge);
      }
    }
  }
}

/**
 * base 에서 exclude 에 이미 있는 ref 를 뺀 차집합만 담아 돌려준다(mergeAugmentResults
 * 와 같은 dedup 키 방식 — entityRefs 는 `${type}:${id}`, personRefs/projectRefs 는 값
 * 자체). /graph/search 의 늦은 위계 다리 시드(lateSearchSeeds)가 1차 augment 패스가
 * 이미 climb 한 ref 까지 다시 walkHierarchyUpward 에 넘겨 중복 DB 조회를 만드는 것을
 * 막기 위한 헬퍼(overview 의 결함 2 수정과 같은 정신).
 */
function diffAugmentResults(base: AugmentResult, exclude: AugmentResult): AugmentResult {
  const excludedEntityKeys = new Set(exclude.entityRefs.map((ref) => `${ref.type}:${ref.id}`));
  const excludedPersonIds = new Set(exclude.personRefs);
  const excludedProjectIds = new Set(exclude.projectRefs);

  return {
    entityRefs: base.entityRefs.filter((ref) => !excludedEntityKeys.has(`${ref.type}:${ref.id}`)),
    personRefs: base.personRefs.filter((id) => !excludedPersonIds.has(id)),
    projectRefs: base.projectRefs.filter((id) => !excludedProjectIds.has(id)),
  };
}

interface GraphSearchEntitySeedResult {
  augment: AugmentResult;
  hits: GraphSearchHit[];
}

type DirectEntityMatchKind = "exact" | "partial";

interface DirectEntityMatch {
  kind: DirectEntityMatchKind;
  score: number;
}

function emptyGraphSearchEntitySeedResult(): GraphSearchEntitySeedResult {
  return { augment: emptyAugmentResult(), hits: [] };
}

function toGraphEntityHit(
  nodeId: string,
  score: number,
  source: string,
  match: DirectEntityMatch,
  ftsScore: number,
  ftsComponent: string,
): GraphSearchHit {
  const matchComponent =
    match.kind === "exact" ? "directEntityExact" : "directEntityPartial";
  return {
    nodeId,
    score,
    sources: [source],
    components: { [ftsComponent]: ftsScore, [matchComponent]: match.score },
  };
}

function normalizeDirectEntitySearchText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, "").trim();
}

function matchDirectEntityMention(
  query: string,
  candidates: readonly (string | null | undefined)[],
): DirectEntityMatch | null {
  const normalizedQuery = normalizeDirectEntitySearchText(query);
  if (normalizedQuery.length === 0) return null;
  let partialMatch = false;
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeDirectEntitySearchText(candidate);
    if (normalizedCandidate.length === 0) continue;
    if (normalizedQuery === normalizedCandidate) {
      return { kind: "exact", score: GRAPH_SEARCH_ENTITY_EXACT_SCORE };
    }
    if (normalizedQuery.includes(normalizedCandidate)) partialMatch = true;
    if (
      normalizedQuery.length >= 3 &&
      normalizedCandidate.includes(normalizedQuery)
    ) {
      partialMatch = true;
    }
  }
  return partialMatch
    ? { kind: "partial", score: GRAPH_SEARCH_ENTITY_PARTIAL_SCORE }
    : null;
}

/**
 * /graph/search 의 검색어가 글이 아니라 독립 엔티티 이름을 직접 가리킬 때도
 * subgraph 시드로 합류시킨다. entity_patch 입력은 knowledge_nodes 를 만들지 않아
 * retriever 결과가 0건일 수 있으므로, 검색 화면에서만 사람·프로젝트·범용 엔티티
 * FTS 를 별도로 읽는다. RRF 점수식·retriever 결과는 건드리지 않는다.
 */
async function addMatchingEntitySearchSeeds(
  store: MemoryApiDeps["store"],
  query: string,
  nodeById: Map<string, GraphNode>,
): Promise<GraphSearchEntitySeedResult> {
  const result = emptyGraphSearchEntitySeedResult();
  const seenHitNodeIds = new Set<string>();

  const addHit = (hit: GraphSearchHit): void => {
    if (seenHitNodeIds.has(hit.nodeId)) return;
    seenHitNodeIds.add(hit.nodeId);
    result.hits.push(hit);
  };

  const [personHits, projectHits, entityHits] = await Promise.all([
    store.searchPersonsByFts(query, GRAPH_SEARCH_ENTITY_SEEDS_PER_KIND),
    store.searchProjectsByFts(query, GRAPH_SEARCH_ENTITY_SEEDS_PER_KIND),
    Promise.resolve(
      store.entitiesRepo.searchEntitiesByFts(
        query,
        GRAPH_SEARCH_ENTITY_SEEDS_PER_KIND,
      ),
    ),
  ]);

  for (const hit of personHits) {
    const person = await store.getPerson(hit.personId);
    if (!person) continue;
    const match = matchDirectEntityMention(query, [
      person.displayName,
      ...person.aliases,
    ]);
    if (!match) continue;
    const key = personKey(person.personId);
    if (!nodeById.has(key)) {
      nodeById.set(key, await personToDetailedGraphNode(store, person));
    }
    result.augment.personRefs.push(person.personId);
    addHit(
      toGraphEntityHit(key, match.score, "person", match, hit.score, "person_fts"),
    );
  }

  for (const hit of projectHits) {
    const project = await store.getProject(hit.projectId);
    if (!project) continue;
    const match = matchDirectEntityMention(query, [project.name]);
    if (!match) continue;
    const key = projectKey(project.projectId);
    if (!nodeById.has(key)) {
      nodeById.set(key, await projectToDetailedGraphNode(store, project));
    }
    result.augment.projectRefs.push(project.projectId);
    addHit(
      toGraphEntityHit(key, match.score, "project", match, hit.score, "project_fts"),
    );
  }

  for (const hit of entityHits) {
    const entity = await store.entitiesRepo.get(hit.entityId);
    if (!entity) continue;
    if (entity.typeName === "person" || entity.typeName === "project") continue;
    const attrs = store.entitiesRepo.listAttributes(entity.id);
    const match = matchDirectEntityMention(query, [
      entity.name,
      entity.koName,
      ...entity.koAliases,
      ...entity.enAliases,
      ...attrs.map((attr) => attr.value),
    ]);
    if (!match) continue;
    const key = entityKey(entity.typeName, entity.id);
    if (!nodeById.has(key)) {
      nodeById.set(
        key,
        entityToGraphNode(
          entity,
          attrs,
          scheduleOccurrenceRowsForEntity(store, entity),
        ),
      );
    }
    result.augment.entityRefs.push({ type: entity.typeName, id: entity.id });
    addHit(
      toGraphEntityHit(
        key,
        match.score,
        entity.typeName,
        match,
        hit.score,
        "entities_fts",
      ),
    );
  }

  return result;
}

/**
 * 글 노드를 만들지 않는 entity_patch 입력도 idle 그래프에서 보이도록, 최근 엔티티들을
 * overview 의 독립 시드로 넣는다. 기존 augmentWithEntities 는 "최근 글 → 연결된 엔티티"
 * 흐름이라 글 없는 엔티티를 발견할 출발점이 없었다. 여기서는 저장 모델을 바꾸지 않고
 * 화면용 그래프 조립 단계에서 사람·프로젝트·정적 8종·사용자 추가 타입을 직접 합류시킨다.
 */
async function addStandaloneEntitySeeds(
  store: MemoryApiDeps["store"],
  nodeById: Map<string, GraphNode>,
): Promise<AugmentResult> {
  const result = emptyAugmentResult();

  const [persons, projects] = await Promise.all([
    store.listPersons({ limit: OVERVIEW_STANDALONE_PERSONS_LIMIT }),
    store.listProjects({ limit: OVERVIEW_STANDALONE_PROJECTS_LIMIT }),
  ]);

  for (const person of persons) {
    const graphNode = await personToDetailedGraphNode(store, person);
    if (!nodeById.has(graphNode.id)) nodeById.set(graphNode.id, graphNode);
    result.personRefs.push(person.personId);
  }

  for (const project of projects) {
    const graphNode = await projectToDetailedGraphNode(store, project);
    if (!nodeById.has(graphNode.id)) nodeById.set(graphNode.id, graphNode);
    result.projectRefs.push(project.projectId);
  }

  const staticTypeNames = ENTITY_TYPE_METAS.map((meta) => meta.typeName);
  const userTypeNames = store.entityTypeRegistryDb
    .listUserEntityTypes()
    .map((type) => type.typeName);
  const typeNames = [...new Set([...staticTypeNames, ...userTypeNames])];

  const entityLists = await Promise.all(
    typeNames.map(async (typeName) => ({
      typeName,
      entities: await store.entitiesRepo.list(typeName, {
        limit: OVERVIEW_STANDALONE_ENTITIES_PER_TYPE,
      }),
    })),
  );

  for (const { entities } of entityLists) {
    for (const entity of entities) {
      const graphNode = entityToGraphNode(
        entity,
        store.entitiesRepo.listAttributes(entity.id),
        scheduleOccurrenceRowsForEntity(store, entity),
      );
      if (!nodeById.has(graphNode.id)) nodeById.set(graphNode.id, graphNode);
      result.entityRefs.push({ type: entity.typeName, id: entity.id });
    }
  }

  return result;
}

/**
 * nodeById 안 메모리 글 노드에 종류(kind) 배지를 채운다 — 글 본문(snippet)의 엔티티
 * 종류를 콜론 태그로 명시했을 때만(explicitDisplayKind) 한국어 배지로 바꾼다.
 *
 * 2026-06-28 "종류" 허브 버그 수정(spec §4.3) — 옛 코드는 store.getNodeKinds(글의 "종류"
 * 분류 꼬리표)에서 배지를 읽었다. 그 꼬리표가 그래프의 "종류" 허브 노드를 만든 데이터
 * 출처라(spec §2.2), ingest 가 자동 "종류" 승격을 끊었다. 그래서 배지를 꼬리표 대신
 * 글 본문의 엔티티 종류로 직접 산출한다.
 *
 * 2026-07-06 평문 자동 추론 범위 조이기(Task 3·P-2) — explicitDisplayKind 가 콜론 명시
 * (source "explicit")일 때만 배지를 인정하고 평문 어휘 경계(source "seed")는 null 로
 * 접는다. 저장 측(ingest 종류값 노드·Task 2)과 같은 규칙을 화면 표시에도 적용해, 평문
 * "클로드 코드"의 "코드"가 material 배지를 달던 저장·표시 불일치를 없앤다. 이 게이트는
 * search.ts·search-post-process.ts 배지와 같은 단일 출처(entity-type-classifier.ts
 * explicitDisplayKind)를 공유한다.
 *
 * 비용 — snippet 은 toGraphNode 가 이미 글 본문을 실어 둔 칸이라 DB 왕복 0,
 * explicitDisplayKind 는 순수 함수 조합(추가 조회 0)이다. N+1 없음.
 *
 * 개념·사람·묶음 같은 비-메모리 노드는 sourceId 가 없어 건너뛴다. 본문에 종류 신호가
 * 없는 글은 kind 를 설정하지 않는다(정직한 빈 상태 — 가짜 0 금지). 검색 캡슐·계산 탭은
 * 개념 이름 매칭(getNodeIdsByConceptName)을 써 이 배지 산출과 무관하다(검색 라우트 무접촉).
 */
function enrichNodeKinds(nodeById: Map<string, GraphNode>): void {
  for (const node of nodeById.values()) {
    if (node.sourceId == null) continue;
    // snippet = 글 본문(toGraphNode 가 채움). 개념·사람 노드는 snippet 이 없어 무해.
    const content = node.snippet;
    if (typeof content !== "string" || content.length === 0) continue;
    const kind = explicitDisplayKind(content);
    if (kind !== null) node.kind = kind;
  }
}

// ── 라우트 등록 ───────────────────────────────────────────────────────────

export function registerGraphRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store, retriever } = deps;

  /**
   * GET /graph/overview?limit=N
   *
   * 회신: { nodes, edges, stats }
   *   - nodes: 최근 글 + 1-hop 이웃 합집합(중복 제거).
   *   - edges: 노드 집합 안 양끝을 모두 가진 knowledge_edges 만.
   *   - stats: totalNodes / totalEdges.
   *
   * 빈 DB → { nodes:[], edges:[], stats:{totalNodes:0,totalEdges:0} } (정직한 빈 상태).
   * limit 미지정 → DEFAULT_LIMIT(60), 상한 MAX_LIMIT(200).
   */
  app.get("/graph/overview", async (c) => {
    const limit = parseLimit(c.req.query("limit"), DEFAULT_LIMIT, MAX_LIMIT);
    const expandedNodeIds = parseExpandedNodeIds(c.req.query("expand"));

    const recent = await store.getRecent(limit);

    const nodeById = new Map<string, GraphNode>();
    const edgeSet = new Map<string, GraphEdge>();

    // 최근 글을 노드 집합 초기 시드로 추가한다.
    //   · 일반 글(auto_capture·user_explicit 등)은 제한 없이 모두 시드로 넣는다.
    //   · 문서(document)·이미지(image_asset)는 이미 getRecent 가 섞어 돌려주므로
    //     별도 조회 없이 같은 목록에서 합류하되, 한 화면 과밀을 막으려고
    //     DOCS_IMAGES_LIMIT 상한까지만 띄운다. 상한을 넘는 문서·이미지는 시드에서
    //     건너뛴다(가짜 노드는 만들지 않는다 — 0건이면 그대로 0).
    let docsImagesAdded = 0;
    for (const node of recent) {
      if (DOCS_IMAGES_SOURCE_TYPES.has(node.sourceType)) {
        if (docsImagesAdded >= DOCS_IMAGES_LIMIT) continue;
        docsImagesAdded++;
      }
      nodeById.set(nodeKey(node.id), toGraphNode(node));
    }

    // 각 최근 글의 1-hop 이웃을 순회해 노드 집합을 확장하고 엣지를 수집한다.
    for (const node of recent) {
      await addVisibleNeighborSubgraph(store, nodeById, edgeSet, node.id);
    }
    await addDerivedChildrenForExpandedNodes(store, nodeById, edgeSet, expandedNodeIds);

    // 개념·사람·엔티티·프로젝트 노드 합류 + 타입 묶음 노드 생성.
    const augment = await augmentWithEntities(store, nodeById, edgeSet);
    // entity_patch 는 knowledge_nodes 를 만들지 않으므로, 최근 글 기반 augment 뒤에
    // 독립 엔티티를 overview 시드로 보강한다. augment 앞에 넣으면 이미 있는 entity row 로
    // 판정되어 콜론 위계 루트("작품" 등)를 덜 끌어오는 회귀가 생긴다.
    const standalone = await addStandaloneEntitySeeds(store, nodeById);
    const merged = mergeAugmentResults(standalone, augment);
    // 관계선(entity_relation_edges)은 addStandaloneEntitySeeds 뒤라야 관계 양끝 노드가
    // 모두 모여 그려진다 — augment 안의 이른 패스는 관계 대상 작가(문찐·리벨 등)가 아직
    // nodeById 에 없어 그 관계선을 못 그리고 지나쳤다(양끝 존재 불변식). augment 이른
    // 패스는 검색 뷰(/graph/search)용으로 그대로 남기고, overview 는 완전한 노드 집합에서
    // 한 번 더 긋는다. addEntityEdge 가 `edge:from->to:type` id 로 멱등이라 두 번 그려도
    // 중복 0(이 패스는 노드를 새로 만들지 않고 이미 모인 노드 사이에 엣지만 긋는다).
    const userTypeNames = store.entityTypeRegistryDb
      .listUserEntityTypes()
      .map((t) => t.typeName);
    drawEntityRelationEdgesFromRefs(
      store,
      nodeById,
      edgeSet,
      merged.entityRefs,
      merged.personRefs,
      merged.projectRefs,
      userTypeNames,
    );
    // standalone 위계 다리 복원(Task 4) — addStandaloneEntitySeeds 로 뒤늦게 들어온
    // 독립 엔티티/사람 잎은 글 mention 이 없어 augment 이른 패스의 위계 상위 합류
    // (walkHierarchyUpward)를 못 탔다. 모든 노드가 다 모인 이 시점에 같은 로직을 한 번
    // 더 돌려 가운데 다리 개념 노드·parent_of 위계선을 마저 세운다(drawEntityRelationEdgesFromRefs
    // 와 같은 "두 번째 멱등 패스" 정신 — buildGroupNodes 가 이 사슬을 읽어야 member_of
    // 추이 감축이 가운데 다리를 건너뛰지 않는다).
    // 결함 2 수정(코드 리뷰 지적) — merged 는 첫 augment 패스가 이미 처리한 refs까지
    // 포함한 전체 집합이라, 이걸 넘기면 walkHierarchyUpward 가 이미 climb 한 것들까지
    // 매번 getHierarchyDirectParents DB 조회로 다시 climb 한다(위계 climb 는 상한이
    // 넉넉해 조기 종료가 거의 없어 그 중복이 그대로 쌓인다). standalone(464행 —
    // addStandaloneEntitySeeds 가 만든, 진짜 새로 들어온 leaf 만 담은 AugmentResult)을
    // 대신 넘겨 이 중복을 없앤다. buildGroupNodes 는 여전히 merged 를 써야 한다(묶음
    // 노드는 전체 집합 기준).
    await attachStandaloneHierarchyBridges(store, nodeById, edgeSet, standalone);
    buildGroupNodes(nodeById, edgeSet, merged);
    // ⑧ 같은 이름 노드 전면 흡수 — ②④ 가 못 잡은 잔여 동명(태그 "일정" 등)을 마저 합친다(표시만).
    absorbSameLabelNodes(nodeById, edgeSet);
    // ⑨ 글-허브 연결선 정리 — 상위 분류·타입 허브 글-선(role 무관)을 거르고 잎만 남긴다(표시만).
    pruneClassificationLeafLines(nodeById, edgeSet);

    // 종류 배지 enrich — 글 본문(snippet)의 엔티티 종류로 직접 산출(꼬리표 미사용·N+1 0).
    enrichNodeKinds(nodeById);

    const nodes = [...nodeById.values()];
    const edges = [...edgeSet.values()];

    const body: GraphOverviewResponse = {
      nodes,
      edges,
      stats: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
      },
    };

    return c.json(body);
  });

  /**
   * POST /graph/search
   *
   * 요청: { query: string, limit?: number, kind?: string,
   *         fieldFilters?: Array<{key,value}>, filter?: Record<string,string>,
   *         since?: string, until?: string }
   * 응답: { query, count, hits[], top3[], subgraph:{nodes,edges}, focus:{centerNodeId,highlightedNodeIds,highlightedEdgeIds} }
   *
   * 기존 retriever.retrieve 를 그대로 호출해 점수식을 바꾸지 않는다(search.ts 호출 형태 본뜸).
   * kind·fieldFilters·filter·dateRange 는 RRF 합산 *전* 후보를 *축소* 하는 하드 필터다 —
   * /search 라우트가 쓰는 같은 파서(search-params.ts)를 그대로 부착한다(점수식 코어 불변).
   * filter 는 (분류 키 무시·)값을 개념 이름으로 매칭해 글→갈래 분류 링크가 있는 글만 통과시킨다
   * (S7 하위분류 단일 드롭다운이 보내는 {subcategory: 갈래값}).
   * 빈/공백 쿼리 → 400. 결과 0 → 빈 subgraph + count 0(정직한 빈 상태).
   */
  app.post("/graph/search", async (c) => {
    let rawBody: Record<string, unknown>;
    try {
      rawBody = await c.req.json<Record<string, unknown>>();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    const query = typeof rawBody.query === "string" ? rawBody.query.trim() : "";
    if (query.length === 0) {
      return err(c, 400, "query is required");
    }

    const limit = parseLimit(rawBody.limit, 20, MAX_LIMIT);

    // kind·fieldFilters·filter·dateRange 하드 필터 — RRF 합산 *전* 후보를 *축소* 한다(가중치 무변경).
    // /search 라우트와 같은 파서를 그대로 쓴다(search-params.ts·search.ts 패턴).
    const dateRange = resolveDateRange(rawBody.since, rawBody.until, query, new Date());
    const kind = parseKind(rawBody.kind);
    const fieldFilters = parseFieldFilters(rawBody.fieldFilters);
    // filter — 값(개념 이름)을 AND 교집합으로 매칭해 분류 링크가 있는 글만 통과(키 이름은
    // retriever 가 무시·값만 본다). S7 하위분류 드롭다운이 {subcategory: 갈래값} 으로 보낸다.
    const filter = parseFilter(rawBody.filter);
    const imageSearch = parseImageSearch(rawBody.imageSearch);

    // 미전달이면 네 파서가 undefined → 조건부 스프레드로 키 자체가 안 들어가 옛
    // retrieve(query, { limit }) 와 byte 동일 호출(회귀 0). RRF 점수식 코어
    // (rrf.ts·scoring.ts·search-tuning.ts) 불변.
    const results = await retriever.retrieve(query, {
      limit,
      ...(dateRange ? { dateRange } : {}),
      ...(kind ? { kind } : {}),
      ...(fieldFilters ? { fieldFilters } : {}),
      ...(filter ? { filter } : {}),
      channelMask: {
        vector: true,
        fts: true,
        graph: true,
        concept: true,
        imageVec: imageSearch,
        project: true,
        person: true,
      },
    });

    const hits: GraphSearchHit[] = results.map((r) => ({
      nodeId: nodeKey(r.node.id),
      score: r.score,
      sources: r.sources as string[],
      components: r.components as Record<string, number>,
    }));

    const displayedIds = results.map((r) => r.node.id);
    if (displayedIds.length > 0) {
      const [supersededIds, supersedingIds] = await Promise.all([
        store.getSupersededNodeIds(displayedIds),
        store.getSupersedingNodeIds(displayedIds),
      ]);
      for (let i = 0; i < hits.length; i++) {
        hits[i]!.revision = {
          superseded: supersededIds.has(results[i]!.node.id),
          supersedes: supersedingIds.has(results[i]!.node.id),
        };
      }
    }

    // hit 노드 + 각 hit 의 1-hop 이웃으로 subgraph 를 조립한다.
    const nodeById = new Map<string, GraphNode>();
    const edgeSet = new Map<string, GraphEdge>();

    // hit 노드를 노드 집합 초기 시드로 추가한다.
    for (const r of results) {
      nodeById.set(nodeKey(r.node.id), toGraphNode(r.node));
    }

    // 각 hit 의 1-hop 이웃을 순회해 노드 집합을 확장하고 엣지를 수집한다.
    for (const r of results) {
      await addVisibleNeighborSubgraph(store, nodeById, edgeSet, r.node.id);
    }

    // 개념·사람·엔티티·프로젝트 노드를 subgraph 에 합류시킨다.
    const augment = await augmentWithEntities(store, nodeById, edgeSet);
    // retriever 는 글 노드만 회신하므로, 글 없는 entity_patch 검색도 화면에 보이게
    // 이름이 직접 맞는 독립 엔티티를 검색 시드로 보강한다.
    const entitySearchSeeds = await addMatchingEntitySearchSeeds(
      store,
      query,
      nodeById,
    );
    const merged = mergeAugmentResults(augment, entitySearchSeeds.augment);
    // 관계선(entity_relation_edges) — 검색한 엔티티/사람에 걸린 관계 상대를 상한 안에서 끌어와
    // 점선으로 잇는다(사용자 결정). 검색 뷰는 사람 시드가 augment *뒤*에 들어와, augment 안의
    // 이른 관계선 패스는 그 사람 노드가 없어 work→person 관계선을 건너뛴다(양끝이 최종 집합에
    // 다 있는데도 0개로 남는 순서 버그). 또 이름 검색은 상대(작품)를 retriever 결과에 안 담아
    // 관계 상대가 아예 없을 수 있다. 그래서 모든 시드가 모인 여기서 양방향으로 펼쳐, 상대 노드를
    // 상한(SEARCH_RELATION_PULL_LIMIT) 안에서 끌어오고 관계선을 그린다(overview 는 무접촉).
    const userTypeNames = store.entityTypeRegistryDb
      .listUserEntityTypes()
      .map((t) => t.typeName);
    const pulled = await revealSearchRelationEdges(
      store,
      nodeById,
      edgeSet,
      merged,
      userTypeNames,
    );
    // standalone 위계 다리 복원(Task 5 — overview 의 Task 4 와 같은 문제를 검색 뷰에
    // 적용). entitySearchSeeds(이름 직접 매칭)와 pulled(관계선 pull-in) 는 둘 다 1차
    // augment *뒤*에 새로 들어온 시드라 walkHierarchyUpward 를 못 탔다.
    // 결함 수정(코드 리뷰 지적) — pulled 는 revealSearchRelationEdges 가 merged(1차
    // augment 포함 전체 누적)를 앵커로 관계를 펼치며 앵커 자기 자신까지 양끝으로 도로
    // push 하므로(pushRef), 1차 augment 가 이미 climb 한 ref 의 echo 를 그대로 담고
    // 있을 수 있다. 이걸 그대로 넘기면 walkHierarchyUpward 가 이미 climb 한 상위 사슬을
    // getHierarchyDirectParents 로 매번 다시 조회한다(위계 climb 는 상한이 넉넉해 조기
    // 종료가 거의 없어 그 중복이 그대로 쌓인다 — overview 결함 2 와 같은 낭비). pulled 에서
    // 1차 augment 에 이미 있던 ref 를 뺀 차집합(diffAugmentResults)만 entitySearchSeeds.augment
    // (이미 진짜 새 시드)와 합쳐 넘겨 이 중복을 없앤다. 노드/엣지 생성은 멱등 가드
    // (nodeById.has·addEntityEdge id)라 정합성(연결선·묶음)은 이 수정과 무관하게 불변이다.
    const lateSearchSeeds = mergeAugmentResults(
      entitySearchSeeds.augment,
      diffAugmentResults(pulled, augment),
    );
    await attachStandaloneHierarchyBridges(store, nodeById, edgeSet, lateSearchSeeds);
    // 묶음 노드는 검색 화면에서도 또렷이 보이도록 focus 강조 대상에 더한다(Q1·완료기준 9).
    const groupNodeIds = buildGroupNodes(
      nodeById,
      edgeSet,
      mergeAugmentResults(merged, pulled),
    );
    // ⑧ 같은 이름 노드 전면 흡수 — ②④ 가 못 잡은 잔여 동명을 마저 합친다(표시만). 묶음
    //   노드(entity_group rank 3)는 흡수 대표라 살아남아 groupNodeIds 가 유효하다.
    absorbSameLabelNodes(nodeById, edgeSet);
    // ⑨ 글-허브 연결선 정리 — 상위 분류·타입 허브 글-선(role 무관)을 거르고 잎만 남긴다(표시만).
    pruneClassificationLeafLines(nodeById, edgeSet);

    // 종류 배지 enrich — 글 본문(snippet)의 엔티티 종류로 직접 산출(꼬리표 미사용·N+1 0).
    enrichNodeKinds(nodeById);

    // 검색 강조 엣지 = 최종 subgraph 에 살아남은 모든 엣지(개념·사람·엔티티 연결선 포함).
    // 결과 노드들 사이 연결선이 검색 중에도 그대로 보이게 한다(글↔글만 강조하던 옛 정책 폐기·
    // 장터당번 검색 시 개념노드↔글노드 선이 사라지던 문제 해결). 표시되는 모든 선을 강조한다.
    const highlightedEdgeIds = [...edgeSet.keys()];

    const allHits = [...hits, ...entitySearchSeeds.hits].sort(
      (a, b) => b.score - a.score,
    );
    const edges = [...edgeSet.values()];
    const top3 = allHits.slice(0, 3);

    const response: GraphSearchResponse = {
      query,
      count: allHits.length,
      hits: allHits,
      top3,
      subgraph: {
        nodes: [...nodeById.values()],
        edges,
      },
      focus: {
        centerNodeId: allHits[0]?.nodeId ?? "",
        highlightedNodeIds: [...allHits.map((h) => h.nodeId), ...groupNodeIds],
        highlightedEdgeIds,
      },
    };

    return c.json(response);
  });
}
