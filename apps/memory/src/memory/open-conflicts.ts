/**
 * memory/open-conflicts.ts — 열린 충돌 후보 조회 (WP-B1-10 / SL-3 표시) +
 * 원문(auto_capture 등) 계보 표시 확장 (WP-B1-10R).
 *
 * 열린 충돌: `contradicts` 엣지로 이어진 두 기억 양쪽이 모두 아직 해소되지 않은
 * (superseded 도 retracted 도 아닌 — 즉 active 또는 disputed) 상태인 관계. supersede나
 * retract로 어느 한쪽이 해소되면 그 엣지는 더 이상 열린 충돌이 아니다.
 *
 * WP-B1-08R Minor 2 가 드러낸 사례: 새 기억 N이 옛 기억 A·B 둘과 contradicts로 이어졌을 때
 * `supersede_memory(A -> N)`로 N을 채택하면(N active, A superseded) N-A 관계는 해소되지만
 * N-B 는 여전히 열려 있다. 이 모듈은 노드 하나당 "해소 안 된 상대 id 목록"을 계산해, 그
 * 상대가 어느 쪽(N 이 disputed 인 통상 사례든, 둘 다 active 인 위 사례든)이어도 같은 규칙으로
 * 잡아낸다.
 *
 * WP-B1-10R — 사용자 결정(2026-09-29, 1안): 원문(auto_capture)은 계속 기본 조회에 남되,
 * 원문을 보여 줄 때 그 원문에서 추출된 자식(merged_into 엣지)의 열린 충돌 id와 "대체된
 * 주장"(자식이 supersede된 뒤 그 대체 기억) 표시를 함께 싣는다. `listOriginMarks` 가 이
 * 확장을 맡는다 — 원문 자신은 contradicts 엣지의 당사자가 아니라 `listOpenConflicts` 만으로는
 * 잡히지 않는 계보 한 단계를 넓혀 본다.
 *
 * src/memory/** 안에 있어야 한다 — src/server-internal/**(search-post-process.ts·profile.ts)와
 * src/mcp/**(tools-memory.ts) 양쪽이 이 모듈을 가져다 쓰고, 역방향 import는 금지되어 있다.
 *
 * id 여러 개를 한 번의 일괄 질의로 처리해 N+1 을 피한다(search-post-process.ts·profile.ts
 * 양쪽이 결과 전체를 한 번에 조회).
 */

import type { Database } from "bun:sqlite";
import { isLineageInvalidated, readSharedMemory } from "./shared-memory-contract.ts";

interface ContradictsEdgeRow {
  source_id: number;
  target_id: number;
}

interface MetadataRow {
  id: number;
  metadata_json: string;
}

/** merged_into 엣지 한 행 — 자식(source_id)이 원문(target_id)에서 추출됐다는 계보. */
interface MergedIntoEdgeRow {
  source_id: number;
  target_id: number;
}

/**
 * WP-B1-10R — 원문 하나에 실리는 두 계보 표시.
 *   - openConflicts: 이 원문에서 추출된 자식(들) 가운데 아직 해소되지 않은 충돌이 있는
 *     모든 상대 id(자식 자신의 id 는 포함하지 않는다 — 충돌 상대만).
 *   - supersededClaims: 이 원문에서 추출된 자식이 supersede돼 대체됐고, 그 대체 기억이
 *     아직 current(superseded 아님)인 동안의 { childId, replacementId } 목록.
 */
export interface OriginMarks {
  openConflicts: number[];
  supersededClaims: Array<{ childId: number; replacementId: number }>;
}

/** 해소되지 않은 상태 — supersede·retract 어느 쪽도 거치지 않은 기억. */
function isUnresolved(metadataJson: string): boolean {
  const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
  const status = readSharedMemory(metadata).status;
  return status !== "superseded" && status !== "retracted";
}

/**
 * 주어진 id들 각각에 대해, contradicts 엣지로 이어져 있고 아직 해소되지 않은 상대 id 목록을
 * 돌려준다. 두 배치 질의(엣지 조회 1회 + metadata 조회 1회)로 끝낸다 — id 수·상대 수와 무관하게
 * 호출당 SQL 2회.
 *
 * 결과에 없는 id(엣지가 없거나 이미 해소된 관계뿐)는 맵에서 생략한다(정직한 빈 상태 —
 * 호출자는 `.get(id) ?? []`로 읽는다).
 */
export function listOpenConflicts(
  db: Database,
  ids: readonly number[],
): Map<number, number[]> {
  const result = new Map<number, number[]>();
  if (ids.length === 0) return result;

  const placeholders = ids.map(() => "?").join(", ");
  // contradicts 엣지 방향은 항상 신규(또는 채택된) 기억 -> 대상이지만(conflict-checker.ts),
  // 어느 쪽이 이번 결과에 표시되든 상대를 찾아야 하므로 source·target 양쪽을 함께 본다.
  const edgeRows = db
    .prepare(
      `SELECT source_id, target_id FROM knowledge_edges
       WHERE relation = 'contradicts'
         AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}))`,
    )
    .all(...ids, ...ids) as ContradictsEdgeRow[];
  if (edgeRows.length === 0) return result;

  const requested = new Set(ids);
  const counterpartOf = new Map<number, Set<number>>();
  const otherNodeIds = new Set<number>();
  for (const row of edgeRows) {
    if (row.source_id === row.target_id) continue;
    if (requested.has(row.source_id)) {
      addCounterpart(counterpartOf, row.source_id, row.target_id);
      otherNodeIds.add(row.target_id);
    }
    if (requested.has(row.target_id)) {
      addCounterpart(counterpartOf, row.target_id, row.source_id);
      otherNodeIds.add(row.source_id);
    }
  }
  if (counterpartOf.size === 0) return result;

  // 판정에 필요한 모든 노드(요청 id + 상대 id)의 metadata를 한 번에 읽는다. 요청 id 자체도
  // 상대의 상대일 수 있어(둘 다 이번 배치 안) 합쳐서 조회하면 중복 질의가 없다.
  const allNodeIds = new Set<number>([...ids, ...otherNodeIds]);
  const nodeIdList = [...allNodeIds];
  const nodePlaceholders = nodeIdList.map(() => "?").join(", ");
  const metadataRows = db
    .prepare(`SELECT id, metadata_json FROM knowledge_nodes WHERE id IN (${nodePlaceholders})`)
    .all(...nodeIdList) as MetadataRow[];
  const unresolvedById = new Map<number, boolean>();
  for (const row of metadataRows) unresolvedById.set(row.id, isUnresolved(row.metadata_json));

  for (const [id, counterparts] of counterpartOf) {
    // 이 기억 자신이 이미 해소됐으면(예: get_memory로 조회한 superseded 기억) 그 관계는
    // 더 이상 열린 충돌이 아니다.
    if (unresolvedById.get(id) !== true) continue;
    const open = [...counterparts].filter((otherId) => unresolvedById.get(otherId) === true);
    if (open.length > 0) result.set(id, open.sort((a, b) => a - b));
  }
  return result;
}

function addCounterpart(map: Map<number, Set<number>>, id: number, counterpart: number): void {
  const set = map.get(id);
  if (set) set.add(counterpart);
  else map.set(id, new Set([counterpart]));
}

/**
 * WP-B1-10R — 주어진 원문 id들 각각에 대해, 그 원문에서 추출된 자식(merged_into 엣지,
 * source=자식 -> target=원문)을 근거로 두 계보 표시를 계산한다.
 *
 * WP-B1-10S(Medium 2) — 긴 `auto_capture` 원문·문서(`document`)는 원문 -parent_of-> 청크
 * (`document_chunk`) -merged_into-> 주장의 두 단계 계보다(origin-chunks.ts writeOriginChunksAtomic
 * · ingest-document.ts). 직속 merged_into 자식(짧은 원문의 즉시 추출)뿐 아니라, 원문의
 * parent_of 청크를 한 단 더 거쳐 그 청크의 merged_into 자식도 "원문의 자식"으로 함께 본다 —
 * 두 경로의 자식이 같은 규칙(아래 (a)(b))으로 원문에 표시를 싣는다.
 *
 *   (a) 자식의 열린 충돌: 살아 있는(계보 무효화 아닌) 자식들의 id 를 모아
 *       `listOpenConflicts` 를 한 번 더 호출하고, 그 결과를 원문에 병합한다(자식이 여럿이면
 *       합집합·정렬·중복 제거). 자식 자신은 원문의 표시 목록에 넣지 않는다 — 표시되는 것은
 *       상대(충돌 후보) id뿐이다.
 *   (b) 대체된 주장: 자식이 supersede로 superseded 상태가 됐고 그 supersededBy 대상이
 *       *아직 current* 이면(대체 기억이 다시 수정·철회되지 않았으면) { childId, replacementId }
 *       를 싣는다. 대체 기억마저 나중에 superseded/retracted 되면 이 마크는 더 이상 싣지
 *       않는다(사용자 결정 "대체 기억이 현재 기준일 때만").
 *
 * 계보 무효화(isLineageInvalidated — 원문 편집·철회가 거둔)는 두 표시 모두에서 제외한다:
 * 사용자·AI 가 직접 supersede/retract 한 것이 아니라 서버가 계보로 거둔 것이라 "대체된 주장"이
 * 아니고, 그 옛 충돌도 더 이상 관련 있는 신호가 아니다. 청크 한 단계도 같은 규칙을 받는다 —
 * 계보 무효화된 청크는 통로 자체가 끊긴 것이라 그 밑의 주장까지 함께 제외한다.
 *
 * 다섯 배치 질의로 끝낸다(원문 수·자식 수와 무관): 직속 merged_into 엣지 조회 1회, 청크
 * parent_of 엣지 조회 1회, 청크 metadata(계보 무효화 판정) 조회 1회, 청크의 merged_into
 * 엣지 조회 1회, 전체 자식(직속+청크 경유) metadata 조회 1회(+ listOpenConflicts 내부 2회),
 * supersededBy 대상의 current 여부 조회 1회.
 * 결과에 없는 원문 id(자식이 없거나 두 표시 모두 빈 원문)는 맵에서 생략한다(정직한 빈 상태 —
 * 호출자는 `.get(id) ?? { openConflicts: [], supersededClaims: [] }`로 읽는다).
 */
export function listOriginMarks(
  db: Database,
  originIds: readonly number[],
): Map<number, OriginMarks> {
  const result = new Map<number, OriginMarks>();
  if (originIds.length === 0) return result;

  const placeholders = originIds.map(() => "?").join(", ");
  const directEdgeRows = db
    .prepare(
      `SELECT source_id, target_id FROM knowledge_edges
       WHERE relation = 'merged_into' AND target_id IN (${placeholders})`,
    )
    .all(...originIds) as MergedIntoEdgeRow[];

  // WP-B1-10S(Medium 2) — 원문의 parent_of 청크(document_chunk)를 찾는다. 짧은 원문은
  // 청크가 없어 이 조회가 빈 배열을 돌려줄 뿐이다.
  const chunkEdgeRows = db
    .prepare(
      `SELECT source_id, target_id FROM knowledge_edges
       WHERE relation = 'parent_of' AND target_id IN (${placeholders})`,
    )
    .all(...originIds) as MergedIntoEdgeRow[];

  const childrenByOrigin = new Map<number, Set<number>>();
  const allChildIds = new Set<number>();
  for (const row of directEdgeRows) {
    addCounterpart(childrenByOrigin, row.target_id, row.source_id);
    allChildIds.add(row.source_id);
  }

  if (chunkEdgeRows.length > 0) {
    // 청크 자신의 계보 무효화 여부를 먼저 본다 — 무효화된 청크는 통로가 끊긴 것이라
    // 그 밑의 주장(merged_into 자식)까지 함께 제외한다.
    const chunkByOrigin = new Map<number, Set<number>>();
    const chunkIds = new Set<number>();
    for (const row of chunkEdgeRows) {
      addCounterpart(chunkByOrigin, row.target_id, row.source_id);
      chunkIds.add(row.source_id);
    }
    const chunkIdList = [...chunkIds];
    const chunkPlaceholders = chunkIdList.map(() => "?").join(", ");
    const chunkMetadataRows = db
      .prepare(`SELECT id, metadata_json FROM knowledge_nodes WHERE id IN (${chunkPlaceholders})`)
      .all(...chunkIdList) as MetadataRow[];
    const liveChunkIds = new Set<number>();
    for (const row of chunkMetadataRows) {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      if (!isLineageInvalidated(readSharedMemory(metadata))) liveChunkIds.add(row.id);
    }

    if (liveChunkIds.size > 0) {
      const liveChunkPlaceholders = [...liveChunkIds].map(() => "?").join(", ");
      const claimEdgeRows = db
        .prepare(
          `SELECT source_id, target_id FROM knowledge_edges
           WHERE relation = 'merged_into' AND target_id IN (${liveChunkPlaceholders})`,
        )
        .all(...liveChunkIds) as MergedIntoEdgeRow[];
      // 청크 -> 원문 매핑을 거쳐 주장을 원문에 직접 매단다(호출자는 두 경로를 구분하지 않는다).
      const originByChunk = new Map<number, Set<number>>();
      for (const [originId, chunks] of chunkByOrigin) {
        for (const chunkId of chunks) {
          if (!liveChunkIds.has(chunkId)) continue;
          addCounterpart(originByChunk, chunkId, originId);
        }
      }
      for (const row of claimEdgeRows) {
        const origins = originByChunk.get(row.target_id);
        if (!origins) continue;
        for (const originId of origins) addCounterpart(childrenByOrigin, originId, row.source_id);
        allChildIds.add(row.source_id);
      }
    }
  }

  if (allChildIds.size === 0) return result;

  // 자식 metadata 를 한 번에 읽어 계보 무효화 여부·supersededBy 대상을 판정한다.
  const childIdList = [...allChildIds];
  const childPlaceholders = childIdList.map(() => "?").join(", ");
  const childMetadataRows = db
    .prepare(`SELECT id, metadata_json FROM knowledge_nodes WHERE id IN (${childPlaceholders})`)
    .all(...childIdList) as MetadataRow[];

  const liveChildIds: number[] = [];
  const supersededByChild = new Map<number, number>();
  for (const row of childMetadataRows) {
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    const state = readSharedMemory(metadata);
    if (isLineageInvalidated(state)) continue; // 서버가 계보로 거둔 자식 — 두 표시 모두 제외.
    liveChildIds.push(row.id);
    if (state.status === "superseded" && state.supersededBy !== undefined) {
      supersededByChild.set(row.id, state.supersededBy);
    }
  }

  // (a) 살아 있는 자식들의 열린 충돌을 한 번에 조회 — 자식 자신을 요청 id 로 넣는다.
  const childOpenConflicts = listOpenConflicts(db, liveChildIds);

  // (b) supersededBy 대상이 아직 current 인지 배치 조회(한 번). "아직 current"란 그
  // 대체 기억이 다시 supersede/retract 되지 않았다는 뜻 — status === 'active'|'disputed'.
  const replacementIds = [...new Set(supersededByChild.values())];
  const currentReplacementIds = new Set<number>();
  if (replacementIds.length > 0) {
    const replacementPlaceholders = replacementIds.map(() => "?").join(", ");
    const replacementRows = db
      .prepare(`SELECT id, metadata_json FROM knowledge_nodes WHERE id IN (${replacementPlaceholders})`)
      .all(...replacementIds) as MetadataRow[];
    for (const row of replacementRows) {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const state = readSharedMemory(metadata);
      if (state.status === "active" || state.status === "disputed") currentReplacementIds.add(row.id);
    }
  }

  const liveChildSet = new Set(liveChildIds);
  for (const [originId, children] of childrenByOrigin) {
    const openConflicts = new Set<number>();
    const supersededClaims: Array<{ childId: number; replacementId: number }> = [];
    for (const childId of children) {
      if (!liveChildSet.has(childId)) continue; // 계보 무효화된 자식 — 제외.
      for (const counterpart of childOpenConflicts.get(childId) ?? []) openConflicts.add(counterpart);
      const replacementId = supersededByChild.get(childId);
      if (replacementId !== undefined && currentReplacementIds.has(replacementId)) {
        supersededClaims.push({ childId, replacementId });
      }
    }
    if (openConflicts.size === 0 && supersededClaims.length === 0) continue;
    result.set(originId, {
      openConflicts: [...openConflicts].sort((a, b) => a - b),
      supersededClaims: supersededClaims.sort((a, b) => a.childId - b.childId),
    });
  }
  return result;
}
