/**
 * DB cleanup helpers — Phase 5.6 W5 (2026-05-20).
 *
 * 본 모듈은 A1 가동 흐름 안 *옛 bug* 의 누적 잔재를 정리하는 helper 한 묶음.
 *
 * 배경:
 *   2026-05-20 A1 가동 흐름에서 본격 bug 발견 — 백필 cron 안 `extractAndStore`
 *   호출이 `applyHashtagWiring` 를 매 사이클 또 가동했다. 옛 raw 는 봇
 *   captureRaw 시점에 이미 hashtag wiring 거쳤기에, 본 흐름은 같은 본문 노드
 *   + 같은 tagged_with edge 를 매 30분마다 또 박았다. A1 DB 안 같은 messageId
 *   를 가진 raw 묶음이 22~24 회 누적된 정황.
 *
 *   W5 코드 fix:
 *     1. `extractor.extractAndStore({ skipHashtagWiring: true })` 옵션
 *     2. `store.getBackfillCandidates` SQL 안 `merged_into` edge 박힌 raw 제외
 *     3. scheduler 가 (1) 옵션 박음
 *
 *   본 helper 는 코드 fix 가 박힌 시점 *이전* 부터 누적된 옛 중복을 한 번 청소.
 *
 * 정리 규칙:
 *   1. metadata 안 `messageId` 키 같은 raw 묶음을 그룹 단위로 묶는다 (`GROUP BY
 *      json_extract(metadata_json, '$.messageId')` HAVING COUNT > 1).
 *   2. 각 그룹의 keep_id 결정:
 *      a. 그룹 안 `merged_into` edge 박힌 raw 가 있으면 가장 옛 (id ASC) 것 = keep.
 *      b. 없으면 그룹 안 가장 옛 raw = keep (옛 흐름 보존).
 *   3. keep 외 raw 노드만 뿌리로 넘겨 명시적 휴지통 이동(store.trashNodes, 정책 cascade —
 *      WP-B1-20U 설계 17.3). 계보 자손(추출 자식·청크 등)은 자기 출처 행도 살아 남는 다른
 *      계보 부모도 없을 때만 archived_lineage 행과 함께 옮겨지고, 자기 출처 행이 있으면 남는다.
 *      edge 는 ON DELETE CASCADE 가 처리.
 *   4. `dryRun=true` 면 같은 계획을 읽기만 해서(store.previewTrash) 통계를 반환 (실 변경 0) —
 *      dry-run 수치가 실제 이동 수치와 같다. `dryRun=false` 면 같은 쓰기 잠금 안에서 실 적용.
 *
 * silent fallback 금지 정신 — dryRun 결과는 명시 통계 반환. cleanup 호출자
 * (메인 / W8 흐름 / 본인 손) 가 dryRun 통계 본 후 실 적용 결정.
 */

import type { SqliteMemoryStore } from "./store.ts";
import type { ExplicitRemovalPolicy } from "../memory/lineage-removal.ts";
import { withMemoryMutationLock } from "../memory/shared-memory-mutation-lock.ts";
import { SHARED_MEMORY_LINEAGE_RELATIONS } from "../memory/shared-memory-contract.ts";
import { inIdBatches, sqlPlaceholders } from "./store-internal/id-batches.ts";

/**
 * cleanup 1회 실행 결과 통계. silent fallback 금지 — 호출자가 본 산출 본 후
 * 실 적용 또는 보고 결정.
 */
export interface CleanupDuplicateRawsResult {
  /** 중복 그룹 (같은 messageId + count>1) 갯수. */
  candidateGroups: number;
  /** archive 이동 대상 raw 노드 개수. */
  rawNodesArchived: number;
  /**
   * raw 와 함께 archive 로 옮기는 계보 자손 개수 — 자기 출처 행도 살아 남는 다른 계보 부모도 없는
   * 추출 자식·청크 등(제거 계획 cascade 의 cascadeMovedIds).
   */
  atomicNodesArchived: number;
  /** 삭제 대상 edge 개수 (ON DELETE CASCADE 가 자동 처리하므로 정보 한정). */
  edgesArchived: number;
  /**
   * 그룹별 keep_id + archived ids 산출 (디버깅 / 보고용). archivedAtomicIds 는 함께 옮기는 계보 자손 중
   * 그 그룹 raw 에서 계보(엣지·extractedTo)로 닿는 것 — 두 그룹에서 닿는 자손은 두 그룹 모두에 든다.
   */
  perGroup: Array<{
    messageId: string;
    keepId: number;
    archivedRawIds: number[];
    archivedAtomicIds: number[];
  }>;
}

interface DuplicateGroup {
  messageId: string;
  rawIds: number[];
}

/**
 * 같은 messageId 묶음 중 가장 옛 raw + atomic 자식 박힌 raw 우선 keep, 그 외
 * 중복 raw(와 출처 없는 계보 자손) + edge archive 이동 helper.
 *
 * @param store    SqliteMemoryStore 인스턴스 — `previewTrash`·`trashNodes` + 내부 db 접근.
 * @param options.dryRun  true 면 통계만 반환, false 면 실 archive 이동 진행.
 *
 * @returns 통계 산출 (dryRun 갈래에서도 같은 모양).
 */
export async function cleanupDuplicateRaws(
  store: SqliteMemoryStore,
  options: { dryRun: boolean },
): Promise<CleanupDuplicateRawsResult> {
  const db = getDb(store);

  // 1) 같은 messageId 묶음 + count > 1 그룹 조회.
  const groupRows = db
    .prepare(
      `SELECT json_extract(metadata_json, '$.messageId') AS message_id,
              GROUP_CONCAT(id) AS raw_ids,
              COUNT(*) AS cnt
       FROM knowledge_nodes
       WHERE source_type = 'auto_capture'
         AND json_extract(metadata_json, '$.messageId') IS NOT NULL
       GROUP BY json_extract(metadata_json, '$.messageId')
       HAVING cnt > 1`,
    )
    .all() as Array<{
    message_id: string | null;
    raw_ids: string | null;
    cnt: number;
  }>;

  const groups: DuplicateGroup[] = [];
  for (const row of groupRows) {
    if (typeof row.message_id !== "string" || row.message_id.length === 0) {
      continue;
    }
    if (typeof row.raw_ids !== "string" || row.raw_ids.length === 0) continue;
    const rawIds = row.raw_ids
      .split(",")
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
    if (rawIds.length < 2) continue;
    groups.push({ messageId: row.message_id, rawIds });
  }

  // 2) 각 그룹별 keep_id + archive 대상 결정.
  const selectMergedInto = db.prepare(
    `SELECT source_id, target_id FROM knowledge_edges
     WHERE relation = 'merged_into' AND target_id = ?`,
  );

  const groupPlans: Array<{ messageId: string; keepId: number; archivedRawIds: number[] }> = [];
  const allRawIdsToArchive: number[] = [];

  for (const group of groups) {
    // 그룹 안 raw 중 merged_into edge 박힌 (자식 atomic 있는) raw id 후보.
    const rawsWithChildren: number[] = [];
    for (const rawId of group.rawIds) {
      const edgeRows = selectMergedInto.all(rawId) as Array<{
        source_id: number;
        target_id: number;
      }>;
      if (edgeRows.length > 0) rawsWithChildren.push(rawId);
    }

    // keep_id 결정: 자식 박힌 raw 가 있으면 그 중 가장 옛 (id ASC), 없으면 그룹 가장 옛.
    const sortedRawIds = [...group.rawIds].sort((a, b) => a - b);
    let keepId: number;
    if (rawsWithChildren.length > 0) {
      keepId = [...rawsWithChildren].sort((a, b) => a - b)[0]!;
    } else {
      keepId = sortedRawIds[0]!;
    }

    const archivedRawIds = sortedRawIds.filter((id) => id !== keepId);
    groupPlans.push({ messageId: group.messageId, keepId, archivedRawIds });
    allRawIdsToArchive.push(...archivedRawIds);
  }

  // 3~5) 계획·집계·적용을 한 쓰기 잠금 안에서 한다 — dry-run 과 실 적용이 같은 계획(previewTrash 와
  // trashNodes 는 같은 explicit/cascade 계획)을 세고, 그 사이에 이 프로세스의 다른 쓰기가 끼지 못한다.
  return withMemoryMutationLock(store, async () => {
    const plan = store.previewTrash(allRawIdsToArchive, CLEANUP_REMOVAL_POLICY);
    const cascadeByGroup = movedDescendantsByGroup(
      db,
      groupPlans.map((g) => g.archivedRawIds),
      plan.cascadeMovedIds,
    );
    const result: CleanupDuplicateRawsResult = {
      candidateGroups: groups.length,
      rawNodesArchived: plan.rootIds.length,
      atomicNodesArchived: plan.cascadeMovedIds.length,
      // edge 갯수 미리 측정 (ON DELETE CASCADE 자동 처리 — 보고 한정).
      edgesArchived: countEdgesTouching(db, plan.movedIds),
      perGroup: groupPlans.map((g, index) => ({ ...g, archivedAtomicIds: cascadeByGroup[index]! })),
    };

    // 4) dryRun 갈래 = 변경 0 + 통계만.
    if (options.dryRun) return result;

    // 5) 실 적용 — 같은 계획으로 옮긴다(트랜잭션 + ON DELETE CASCADE 가 edge 정리).
    const moved = await store.trashNodes(allRawIdsToArchive, CLEANUP_REMOVAL_POLICY);
    if (moved.movedIds.join(",") !== plan.movedIds.join(",")) {
      throw new Error(
        `cleanupDuplicateRaws: 실제로 옮긴 노드 ${moved.movedIds.length}개가 계획 ${plan.movedIds.length}개와 다릅니다 — ` +
          "계획과 적용 사이에 다른 프로세스가 DB 를 바꿨습니다. 서버를 멈추고 dry-run 부터 다시 실행하세요",
      );
    }
    return result;
  });
}

/** 중복 원문 정리의 휴지통 이동 정책(설계 17.3) — 출처 없는 계보 자손은 원문과 함께 옮긴다. */
const CLEANUP_REMOVAL_POLICY: ExplicitRemovalPolicy = "cascade";

/** 계보 관계(merged_into·parent_of) 자리표시자 — 아래 계보 자식 조회용. */
const LINEAGE_PLACEHOLDERS = sqlPlaceholders(SHARED_MEMORY_LINEAGE_RELATIONS.length);

/** ids 에 한쪽 끝이 닿은 edge 의 서로 다른 개수(500개 묶음마다 edge id 를 모아 중복 없이 센다). */
function countEdgesTouching(db: CleanupDb, ids: readonly number[]): number {
  const edgeIds = new Set<number>();
  for (const batch of inIdBatches(ids)) {
    const list = sqlPlaceholders(batch.length);
    const rows = db
      .prepare(`SELECT id FROM knowledge_edges WHERE source_id IN (${list}) OR target_id IN (${list})`)
      .all(...batch, ...batch) as Array<{ id: number }>;
    for (const row of rows) edgeIds.add(row.id);
  }
  return edgeIds.size;
}

/**
 * 그룹마다 그 그룹 raw 에서 계보 자식 방향(계보 엣지의 자식, metadata.extractedTo 항목)으로 걸어 닿는
 * cascadeIds 노드(오름차순). 계획이 함께 옮기기로 한 노드 안에서만 걷는다 — 보고용 귀속이라 이동 대상은
 * 바꾸지 않는다. 층마다 500개 묶음으로 엣지 1번·extractedTo 1번 읽는다.
 */
function movedDescendantsByGroup(
  db: CleanupDb,
  rawIdsByGroup: readonly number[][],
  cascadeIds: readonly number[],
): number[][] {
  const cascade = new Set(cascadeIds);
  if (cascade.size === 0) return rawIdsByGroup.map(() => []);
  return rawIdsByGroup.map((rawIds) => {
    const found = new Set<number>();
    let layer: number[] = [...rawIds];
    while (layer.length > 0) {
      const next: number[] = [];
      for (const childId of lineageChildrenOf(db, layer)) {
        if (!cascade.has(childId) || found.has(childId)) continue;
        found.add(childId);
        next.push(childId);
      }
      layer = next;
    }
    return [...found].sort((a, b) => a - b);
  });
}

function lineageChildrenOf(db: CleanupDb, parentIds: readonly number[]): number[] {
  const children: number[] = [];
  for (const batch of inIdBatches(parentIds)) {
    const list = sqlPlaceholders(batch.length);
    const edges = db
      .prepare(
        `SELECT source_id FROM knowledge_edges
         WHERE target_id IN (${list}) AND relation IN (${LINEAGE_PLACEHOLDERS})`,
      )
      .all(...batch, ...SHARED_MEMORY_LINEAGE_RELATIONS) as Array<{ source_id: number }>;
    for (const edge of edges) children.push(edge.source_id);
    const lists = db
      .prepare(
        `SELECT metadata_json -> '$.extractedTo' AS list FROM knowledge_nodes
         WHERE id IN (${list}) AND json_type(metadata_json, '$.extractedTo') = 'array'`,
      )
      .all(...batch) as Array<{ list: string }>;
    for (const row of lists) {
      for (const childId of JSON.parse(row.list) as unknown[]) {
        if (typeof childId === "number" && Number.isSafeInteger(childId)) children.push(childId);
      }
    }
  }
  return children;
}

type CleanupDb = ReturnType<typeof getDb>;

/**
 * SqliteMemoryStore 의 내부 db 핸들에 접근 — 본 helper 한정 raw SQL 호출 필요.
 * 본 통로는 cleanup helper 한 곳만 사용. 일반 호출은 store 의 공개 메서드 활용.
 */
function getDb(store: SqliteMemoryStore): {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
    run: (...params: unknown[]) => unknown;
  };
} {
  // SqliteMemoryStore.db 는 private 이라 unknown cast 한 번 거침.
  const dbField = (store as unknown as { db: unknown }).db;
  return dbField as {
    prepare: (sql: string) => {
      all: (...params: unknown[]) => unknown[];
      get: (...params: unknown[]) => unknown;
      run: (...params: unknown[]) => unknown;
    };
  };
}
