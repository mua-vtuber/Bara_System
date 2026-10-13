/**
 * Phase 5.7.3 W2 — 메모리 자동 정리 본체 (옛 evolver 단계 1+2+3+5 분리).
 *
 * 동작 순서:
 *  1. 전체 노드를 id ASC 페이지 단위로 순회하며 가치 점수 계산
 *     (scoring.computeNodeValue) + 보호 규칙 적용. 옛 getAllNodes(10_000)
 *     상한으로 1만 초과 노드가 조용히 정리에서 빠지던 구멍을 페이지 순회로
 *     제거(2026-07 감사 High).
 *  2. 노드별 vec_nodes kNN(sqlite-vec)으로 이웃을 뽑아 cosine sim
 *     [clusterSimLow, clusterSimHigh) 안 같은 (memory_type, platform) 그룹
 *     이웃에 related_to 엣지 추가. 기본 [0.84, 0.99) — legacy 임계값 보존
 *     (Phase 4 B3+). 옛 그룹 내 전짝 O(n²) JS cosine 비교를 kNN 으로 대체
 *     (2026-07 감사 High — 5천 노드 그룹이면 사이클당 ~1,250만 비교였음).
 *  3. 임계값 이하 노드 → 휴지통 이동(selected_only — 고르지 않은 노드의 마지막 계보 부모는 남김)
 *  5. 활동 요약 DB 로그 (logAutoCleanupActivity)
 *
 * 옛 evolver.evolve() 안 단계 4 (30일+ archive 영구 삭제 + soonToPurge) 는
 * 본 함수에서 제외 — `trash-manager.ts` 가 담당 (시간 cron 단계).
 *
 * 옛 evolver.evolve() 안 단계 0 (concept emergence) + 단계 6 (tag hierarchy
 * promoter) 도 본 함수에서 제외 — 본 W2 범위는 "자동 정리" 순수 흐름 한정.
 *
 * 디자인 근거: docs/decisions/2026-05-21-memory-auto-cleanup-redesign-spec.md
 */

import { computeNodeValue } from "./scoring.ts";
import type { EdgeRelation, MemoryNode } from "./types.ts";
import type { ExplicitRemovalPolicy } from "./lineage-removal.ts";
import type { TrashNodesResult } from "../db/store-internal/stats-repository.ts";

export interface AutoCleanupOptions {
  recencyHalfLifeDays?: number;
  importanceHalfLifeDays?: number;
  valueThreshold?: number;
  clusterSimLow?: number;
  clusterSimHigh?: number;
  /**
   * 전량 순회 페이지 크기(id ASC 배치 한 번에 읽는 노드 수). 미지정 시
   * DEFAULTS.pageSize. 테스트가 작은 값으로 페이지 경계 동작을 검증한다.
   */
  pageSize?: number;
}

export interface AutoCleanupActivitySummary {
  /** ISO 8601 UTC 시각 (가동 시작 시점). */
  startedAt: string;
  /** 한 사이클 가동 시간 (밀리초). */
  durationMs: number;
  /** 본 사이클에 추가된 related_to 엣지 수. */
  clusterEdgesAdded: number;
  /** 본 사이클에 휴지통으로 이동된 노드 수. */
  nodesArchived: number;
  /**
   * 가치 점수 미달로 골랐지만, 옮기면 고르지 않은 노드(아직 가치가 남은 추출 사실 등)가 마지막 계보 부모를
   * 잃게 돼 이번 사이클에 남긴 노드 수(WP-B1-20U 설계 17.3, selected_only). 반환값에만 있고 활동 로그 표에는
   * 적지 않는다.
   */
  nodesKeptForLineage: number;
}

/**
 * 자동 정리의 휴지통 이동 정책(설계 17.3 Q3 기본값). 고른 노드만 옮기고, 고르지 않은 노드의 마지막 부모인
 * 고른 노드는 남긴다 — 자동 기능이 아직 쓸모 있는 추출 사실을 사용자 모르게 휴지통으로 보내지 않게.
 * 반대 선택지 "cascade" 는 출처 없는 자손을 함께 옮긴다(보관 기간 뒤 자동 영구 삭제로 이어진다).
 */
export const AUTO_CLEANUP_REMOVAL_POLICY: ExplicitRemovalPolicy = "selected_only";

const DEFAULTS = {
  recencyHalfLifeDays: 30,
  importanceHalfLifeDays: 90,
  valueThreshold: 0.05,
  clusterSimLow: 0.84,
  clusterSimHigh: 0.99,
  pageSize: 1_000,
};

/**
 * 클러스터 엣지용 노드당 kNN 이웃 수. self 포함 조회라 실제 질의는 +1.
 *
 * 근거: related_to 엣지의 소비처(EdgeRepository.getNeighbors 기본 limit 20,
 * getConnectedNodes BFS)가 노드당 상위 ~20개 이웃만 쓰므로, sim 밴드
 * [clusterSimLow, clusterSimHigh) 안 이웃을 노드당 20개 넘게 이어도 검색·그래프
 * 소비에 더해지는 가치가 없다. 짝은 양 끝 어느 한쪽 kNN 에만 잡혀도 이어지므로
 * 실효 커버리지는 노드당 최대 ~2K 다. 옛 O(n²) 전짝과 달리 초고밀도 클러스터
 * 에서는 K 밖 짝이 생략될 수 있으나, 그 클러스터는 이미 노드당 K 개 엣지로
 * 촘촘히 연결된 뒤라 의도된 절충이다.
 */
const CLUSTER_KNN_K = 20;

/**
 * 자동 정리 함수가 호출하는 store 메서드 좁힌 표면.
 * SqliteMemoryStore 가 실제 구현. 옛 단계 4 (영구 삭제 + 사전 알림)
 * 메서드는 의도적으로 제외 — trash-manager.ts 가 담당.
 */
export interface AutoCleanupStore {
  /** id > afterId 노드를 id ASC 로 limit 개 — 전량 순회 페이지 통로. */
  getNodesAfterId(afterId: number, limit: number): Promise<MemoryNode[]>;
  getNodesByIds(ids: readonly number[]): Promise<MemoryNode[]>;
  getVectorsByIds(ids: readonly number[]): Promise<Map<number, Float32Array>>;
  /**
   * vec_nodes kNN — distance 는 vec0 distance_metric=cosine 값
   * (= 1 − cosine similarity, 기준 스키마 vec_nodes 정의).
   */
  searchByVectorRaw(
    queryVec: Float32Array,
    k: number,
  ): Promise<Array<{ nodeId: number; distance: number }>>;
  /**
   * 명시적 휴지통 이동(설계 17.3) — 자동 정리는 AUTO_CLEANUP_REMOVAL_POLICY 로 부른다. 쓰기 잠금은 store 가
   * 잡는다(트리거가 이미 쥔 흐름은 재진입).
   */
  trashNodes(ids: readonly number[], policy: ExplicitRemovalPolicy): Promise<TrashNodesResult>;
  addEdge(args: {
    sourceId: number;
    targetId: number;
    relation: EdgeRelation;
    provenance: "evolver";
    sourceNodeId: number;
    weight: number;
  }): Promise<unknown>;
  logAutoCleanupActivity(summary: {
    clusterEdgesAdded: number;
    nodesArchived: number;
  }): Promise<void>;
}

/**
 * 노드가 보호 규칙에 해당하면 true.
 *
 * 옛 evolver.isProtected 본체와 동일:
 *  - `metadata.preservedRaw === true`
 *  - `metadata.is_protected === true` (2026-05-16 spec 4.2 영구화)
 *  - `sourceType === 'user_explicit'`
 *  - `metadata.protectUntil` 가 미래 시각
 */
export function isProtected(node: MemoryNode, now: Date): boolean {
  if (node.metadata.preservedRaw === true) return true;
  if (node.metadata.is_protected === true) return true;
  if (node.sourceType === "user_explicit") return true;
  const pu = node.metadata.protectUntil;
  if (typeof pu === "string") {
    const puDate = new Date(pu);
    if (!Number.isNaN(puDate.getTime()) && puDate.getTime() > now.getTime()) {
      return true;
    }
  }
  return false;
}

/**
 * 한 페이지 노드들의 sim 범위 안 이웃 짝에 related_to 엣지 추가.
 * 반환 = 본 페이지 처리로 새로 이어진 짝 수.
 *
 * 옛 (memory_type, platform) 그룹 내 전짝 O(n²) JS cosine 비교를 노드당
 * vec_nodes kNN(sqlite-vec)으로 대체. 그룹 좁힘은 kNN 결과를 이웃 노드의
 * (memoryType, platform) 로 후필터해 보존한다 — 옛 Python evolver 패턴 유지.
 *
 * 중복 차단 2중 구조:
 *  - 엣지는 항상 min(id) → max(id) 로 정규화해 넣는다. 옛 i<j 루프도 id ASC
 *    배열이라 같은 방향이었다(방향 의미 보존). kNN 이 짝을 양방향으로 두 번
 *    방문해도 같은 (source, target) 행이 된다.
 *  - DB 는 idx_ke_pair UNIQUE(source_id, target_id, relation) + INSERT OR
 *    IGNORE(EdgeRepository.addEdge)가 최종 방어선. 사이클 안 카운트 중복은
 *    linkedPairs Set 이 거른다(kNN 은 비대칭이라 한쪽 kNN 에만 잡힌 짝도
 *    그 한쪽 방문 때 이어진다).
 */
async function addClusterEdgesForPage(
  store: AutoCleanupStore,
  pageNodes: MemoryNode[],
  clusterSimLow: number,
  clusterSimHigh: number,
  linkedPairs: Set<string>,
): Promise<number> {
  if (pageNodes.length === 0) return 0;

  const nodeMetaById = new Map<number, { memoryType: string; platform: string }>();
  for (const n of pageNodes) {
    nodeMetaById.set(n.id, { memoryType: n.memoryType, platform: n.platform });
  }

  const vectors = await store.getVectorsByIds(pageNodes.map((n) => n.id));

  // 1차 — 노드별 kNN + sim 범위 필터. 그룹 판정은 페이지 밖 이웃 메타를
  // 한 번에 회수한 뒤 2차에서 한다(노드당 조회 N+1 회피).
  const candidates: Array<{ node: MemoryNode; neighborId: number; sim: number }> = [];
  const unknownNeighborIds = new Set<number>();
  for (const node of pageNodes) {
    const vec = vectors.get(node.id);
    // 임베딩 미적재 노드(backfill 대기)는 클러스터링 불참 — 옛 전짝 루프의
    // vector 부재 skip 과 동일한 실제 상태(실패 은폐 아님).
    if (!vec) continue;

    // +1 = kNN 이 자기 자신(distance 0)을 포함하는 자리.
    const hits = await store.searchByVectorRaw(vec, CLUSTER_KNN_K + 1);
    for (const hit of hits) {
      if (hit.nodeId === node.id) continue;
      // vec_nodes 는 distance_metric=cosine → distance = 1 − cosine similarity.
      const sim = 1 - hit.distance;
      if (sim < clusterSimLow || sim >= clusterSimHigh) continue;
      candidates.push({ node, neighborId: hit.nodeId, sim });
      if (!nodeMetaById.has(hit.nodeId)) unknownNeighborIds.add(hit.nodeId);
    }
  }
  if (candidates.length === 0) return 0;

  if (unknownNeighborIds.size > 0) {
    const neighborNodes = await store.getNodesByIds([...unknownNeighborIds]);
    for (const n of neighborNodes) {
      nodeMetaById.set(n.id, { memoryType: n.memoryType, platform: n.platform });
    }
  }

  let added = 0;
  for (const { node, neighborId, sim } of candidates) {
    const meta = nodeMetaById.get(neighborId);
    // kNN 직후 삭제·이동된 이웃은 knowledge_nodes 에 없다 — 짝 판정 대상이
    // 아니므로 건너뛴다(옛 전량 배열 밖 노드와 동일 취급).
    if (!meta) continue;
    if (meta.memoryType !== node.memoryType || meta.platform !== node.platform) {
      continue;
    }

    const sourceId = Math.min(node.id, neighborId);
    const targetId = Math.max(node.id, neighborId);
    const pairKey = `${sourceId}:${targetId}`;
    if (linkedPairs.has(pairKey)) continue;
    linkedPairs.add(pairKey);

    await store.addEdge({
      sourceId,
      targetId,
      relation: "related_to" as EdgeRelation,
      provenance: "evolver",
      sourceNodeId: sourceId,
      weight: sim,
    });
    added += 1;
  }
  return added;
}

/**
 * 데이터 변동 시점에 가동되는 메모리 자동 정리 본체.
 *
 * 옛 evolver.evolve() 안 단계 1+2+3+5 만 분리. 단계 4 (휴지통 영구 삭제)
 * 는 trash-manager.ts 가 담당.
 *
 * 전량 순회 = id ASC 페이지(getNodesAfterId). 페이지마다 가치 점수 + 클러스터
 * 엣지를 처리하고, 휴지통 이동은 순회가 끝난 뒤 한 번에 한다 — 옛 "점수 전량
 * → 엣지 전량 → 이동" 흐름과 같은 상대 순서(엣지 계산이 이동보다 먼저)를
 * 보존한다. 클러스터 짝은 kNN 이 vec_nodes 전체를 보므로 페이지 경계를
 * 넘어도 이어진다(전량 배열을 메모리에 들 필요 없음).
 */
export async function runAutoCleanup(
  store: AutoCleanupStore,
  options: AutoCleanupOptions = {},
): Promise<AutoCleanupActivitySummary> {
  const opts = {
    recencyHalfLifeDays: options.recencyHalfLifeDays ?? DEFAULTS.recencyHalfLifeDays,
    importanceHalfLifeDays: options.importanceHalfLifeDays ?? DEFAULTS.importanceHalfLifeDays,
    valueThreshold: options.valueThreshold ?? DEFAULTS.valueThreshold,
    clusterSimLow: options.clusterSimLow ?? DEFAULTS.clusterSimLow,
    clusterSimHigh: options.clusterSimHigh ?? DEFAULTS.clusterSimHigh,
    pageSize: options.pageSize ?? DEFAULTS.pageSize,
  };
  if (!Number.isInteger(opts.pageSize) || opts.pageSize <= 0) {
    throw new Error(
      `runAutoCleanup: pageSize must be a positive integer, got ${opts.pageSize}`,
    );
  }

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const now = new Date(startedAtMs);

  const archiveCandidates: number[] = [];
  const linkedPairs = new Set<string>();
  let clusterEdgesAdded = 0;

  // 단계 1+2 — 전체 노드를 id ASC 페이지로 순회. 페이지마다 가치 점수 +
  // 보호 규칙(단계 1), 클러스터 엣지(단계 2 — 보호 노드도 클러스터링 대상,
  // cleanup 만 제외하고 그래프 구조는 모두 참여)를 처리한다.
  let afterId = 0;
  while (true) {
    const page = await store.getNodesAfterId(afterId, opts.pageSize);
    if (page.length === 0) break;

    for (const node of page) {
      if (isProtected(node, now)) continue;
      const value = computeNodeValue(
        {
          importance: node.importance,
          lastAccessedAt: node.lastAccessedAt,
          mentionCount: node.mentionCount,
        },
        {
          recencyHalfLifeDays: opts.recencyHalfLifeDays,
          importanceHalfLifeDays: opts.importanceHalfLifeDays,
        },
      );
      if (value < opts.valueThreshold) {
        archiveCandidates.push(node.id);
      }
    }

    clusterEdgesAdded += await addClusterEdgesForPage(
      store,
      page,
      opts.clusterSimLow,
      opts.clusterSimHigh,
      linkedPairs,
    );

    afterId = page[page.length - 1]!.id;
    if (page.length < opts.pageSize) break;
  }

  // 단계 3 — 휴지통 이동(고른 노드만, 고르지 않은 노드의 마지막 계보 부모는 남김 — 설계 17.3)
  let nodesArchived = 0;
  let nodesKeptForLineage = 0;
  if (archiveCandidates.length > 0) {
    const trashed = await store.trashNodes(archiveCandidates, AUTO_CLEANUP_REMOVAL_POLICY);
    nodesArchived = trashed.movedIds.length;
    nodesKeptForLineage = trashed.blockedIds.length;
  }

  // 단계 5 — 활동 요약 로그(남긴 수는 반환값에만 — 로그 표 칸은 그대로)
  const summary: AutoCleanupActivitySummary = {
    startedAt,
    durationMs: Date.now() - startedAtMs,
    clusterEdgesAdded,
    nodesArchived,
    nodesKeptForLineage,
  };
  await store.logAutoCleanupActivity({
    clusterEdgesAdded,
    nodesArchived,
  });

  return summary;
}
