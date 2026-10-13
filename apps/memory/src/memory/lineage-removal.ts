/**
 * memory/lineage-removal.ts — 메시지 삭제와 명시적 제거(휴지통 이동·영구 삭제)가 어떤 노드를 함께 없애는지
 * 정하는 제거 계획(WP-B1-20T 설계 6.3, 3.4 생존 규칙, WP-B1-20U 설계 17.3).
 *
 * 생존 규칙 한 줄: 노드는 자기 출처 행(memory_node_sources)이 있거나, 살아 남는 계보 부모
 * (merged_into·parent_of 엣지, 자식 → 부모 방향)가 있으면 남는다. 파생 모양(source_type·regex 표식)은
 * 따지지 않는다. 계획 밖 부모(방문하지 않은 노드 — 살아 남는 다른 원문 등)는 살아 남는 부모로 센다.
 * 모든 제거 통로가 이 계획을 거쳐, "살아 있는 노드는 모두 자기 출처 행이나 살아 있는 계보 부모를 가진다"는
 * 불변식을 지킨다 — 메시지 삭제는 출처 행으로만 뿌리를 찾으므로 이 불변식이 깨진 노드는 영영 찾지 못한다.
 *
 * 방아쇠 두 가지:
 *   - message: 호출자가 지운 메시지의 출처 행을 같은 트랜잭션에서 먼저 지운 뒤, 그 행을 가졌던 노드를
 *     뿌리로 넘긴다(deleteBySource). 뿌리도 생존 규칙을 따른다 — 다른 출처 행이 남았거나 살아 남는
 *     계보 부모가 있으면 남는다. 없어지는 노드는 영구 삭제된다.
 *   - explicit: 사용자나 정리 기능이 고른 노드들(휴지통 이동, 자동 정리, 중복 원문 정리, 단건 영구 삭제).
 *     뿌리는 출처 행이 있어도 없앤다(휴지통 이동인지 영구 삭제인지는 호출자가 정한다). 자손은 자기 출처
 *     행이 있으면 남고, 없으면 부모를 따른다. 계보 엣지 없이 extractedTo 에만 남은 자식(계보 엣지 이전
 *     모양)은 그 목록을 가진 노드를 부모로 삼아 함께 옮긴다 — 자기 출처 행이 있으면 남긴다. 그 부모는
 *     declaredParents 로 돌려줘 보관표에 archived_lineage 행을 남기게 한다. 정책 두 가지:
 *       cascade       — 위 규칙 그대로. 출처 없는 자손이 뿌리와 함께 없어진다.
 *       selected_only — 고른 노드만 없앤다. 고른 노드를 없애면 고르지 않은 노드가 마지막 부모를 잃게 되는
 *                       경우, 그 고른 노드는 이번에 남긴다(blockedIds). 자동 정리가 쓴다(설계 17.3 Q3).
 * 설계 16절 이후 불확실 출처가 없어, 운명은 "없앰"과 "남김" 두 단계다. 방아쇠가 없앰의 뜻(영구 삭제
 * 또는 휴지통)을 정한다.
 *
 * 계산(선형): 뿌리에서 계보 자식 방향으로 층마다 BFS 한다. 층마다 출처 행·부모 엣지·자식 엣지를
 * 500개씩 묶어 한 번에 읽는다(노드마다 따로 읽지 않는다). 자기 출처 행이 있어 남는 노드 아래로는
 * 내려가지 않는다(그 자식은 이 노드를 살아 남는 부모로 둔다). BFS 가 끝나면 남김을 부모 → 자식으로
 * 한 번씩만 퍼뜨린다 — 운명은 오르기만 하고 노드마다 한 번 오르므로 전체 비용이 방문 노드 수 + 읽은
 * 엣지 수에 비례한다. 순환 안의 노드끼리는 서로를 살려 두지 못한다(바깥 지지가 없으면 함께 없어진다).
 * 출처 사건 표(memory_source_events)는 읽지 않는다 — 생존은 출처 행만 본다(설계 3.3·D5).
 *
 * selected_only 는 DB 를 더 읽지 않는다: cascade 계획에서 끌려가는 노드(뿌리가 아닌 없앨 노드)마다 계획 안
 * 부모(BFS 가 자식 쪽 엣지를 읽을 때 본 부모와 declaredParents)를 따라 위로 걸어, 닿는 뿌리를 막는다.
 * 막힌 뿌리에 자기 출처 행이 없으면 그 뿌리도 남아 부모가 필요하므로 그 위로도 계속 걷는다. 막힌 뿌리를
 * 처음부터 남는 노드로 두고 남김 퍼뜨리기를 다시 하면, 강제 뿌리가 줄어 없앨 집합도 줄기만 하므로 끌려가는
 * 노드가 남지 않는다. 걷기는 노드마다 한 번이라 비용은 방문 노드 수 + 계획 안 엣지 수에 비례한다.
 *
 * 호출자가 트랜잭션과 쓰기 잠금 안에서 부른다. 이 함수는 읽기만 한다.
 */

import type { Database } from "bun:sqlite";
import { SHARED_MEMORY_LINEAGE_RELATIONS } from "./shared-memory-contract.ts";
import { NodeSourceRepository } from "../db/store-internal/node-source-repository.ts";
import { inIdBatches, sqlPlaceholders } from "../db/store-internal/id-batches.ts";

const LINEAGE_PLACEHOLDERS = sqlPlaceholders(SHARED_MEMORY_LINEAGE_RELATIONS.length);

/** 명시적 제거의 자손 정책(설계 17.3). */
export type ExplicitRemovalPolicy = "cascade" | "selected_only";

export type RemovalTrigger =
  /** rootIds: 이번 메시지의 출처 행을 방금 잃은 노드(호출자가 행을 먼저 지운다). */
  | { kind: "message"; rootIds: readonly number[] }
  /** rootIds: 사용자나 정리 기능이 고른 노드 — 출처 행이 있어도 없앤다(selected_only 의 막힌 뿌리 제외). */
  | { kind: "explicit"; rootIds: readonly number[]; policy: ExplicitRemovalPolicy };

/** 계획이 실제로 한 일을 센 값 — 선형 비용을 테스트가 시간 대신 이 값으로 고정한다. */
export interface RemovalPlanStats {
  /** 계획에 들어온 노드 수(뿌리 포함). */
  nodesVisited: number;
  /** 읽은 계보 엣지 행 수(부모 쪽·자식 쪽 읽기와 extractedTo 자식 확인을 모두 센다). */
  edgesRead: number;
  /** 출처 행 묶음 조회 횟수 — BFS 층마다 500개 묶음당 1번. */
  sourceLookups: number;
  /** 계획이 실행한 SQL 문 수 전체. */
  queries: number;
}

export interface RemovalPlan {
  /** 실제로 있는 뿌리(오름차순). */
  rootIds: number[];
  /** 없앨 노드(오름차순). message 방아쇠는 영구 삭제, explicit 방아쇠는 호출자가 정한다. */
  removeIds: number[];
  /** 방문했고 남는 노드(뿌리 포함, 오름차순). */
  keptIds: number[];
  /**
   * explicit 방아쇠만: 계보 엣지 없이 extractedTo 로 함께 옮기는 자식 → 그 목록을 가진 노드. 보관표의
   * archived_lineage 행(설계 5.4)을 계보 엣지와 같이 남기는 데 쓴다. removeIds 에 든 자식만 담는다.
   */
  declaredParents: Map<number, number[]>;
  /**
   * explicit/selected_only 만: 없애면 고르지 않은 노드가 마지막 부모를 잃게 돼 이번에 남긴 뿌리(오름차순).
   * 다른 방아쇠·정책은 빈 배열.
   */
  blockedIds: number[];
  stats: RemovalPlanStats;
}

/**
 * 자기 출처 판정 — 노드가 자기 출처 행(memory_node_sources)을 하나라도 가졌는가. 계보 무효화
 * (shared-memory-invalidation.ts, 설계 5.8)가 계보로 닿은 노드를 남길지 정할 때 쓴다. 출처 행은
 * 서버만 쓰는 표에 있어 클라이언트 metadata 로 흉내 낼 수 없다(설계 3.1).
 */
export function createOwnSourceProbe(db: Database): (nodeId: number) => boolean {
  const sources = new NodeSourceRepository(db);
  return (nodeId) => (sources.listSync([nodeId]).get(nodeId) ?? []).length > 0;
}

interface EdgeRecord {
  source_id: number;
  target_id: number;
}

/** 방문한 노드의 판정 재료. */
interface Visit {
  holdsRows: boolean;
  /** 계보 부모(자기 자신 제외) — 자기 출처 행이 없고 고정 뿌리가 아닌 노드만 읽는다. */
  parents: number[];
}

export function planSourceRemoval(db: Database, trigger: RemovalTrigger): RemovalPlan {
  const stats: RemovalPlanStats = { nodesVisited: 0, edgesRead: 0, sourceLookups: 0, queries: 0 };
  const sources = new NodeSourceRepository(db);
  const roots = existingNodeIds(db, trigger.rootIds, stats);
  const explicit = trigger.kind === "explicit";
  // explicit 뿌리는 고른 노드라 출처 행·부모와 무관하게 없앤다.
  const forced = new Set(explicit ? roots : []);

  const visits = new Map<number, Visit>();
  const declaredParents = new Map<number, number[]>();
  // 계획 안 부모: 펼친 노드(고정 뿌리, 출처 행 없는 노드)의 자식 쪽 엣지를 읽을 때 본 (자식 → 부모).
  // 없앨 수 있는 노드는 모두 펼쳐지므로, 없앨 수 있는 부모는 여기 빠짐없이 든다(selected_only 걷기용).
  const planParents = new Map<number, number[]>();
  for (const id of roots) visits.set(id, { holdsRows: false, parents: [] });
  let layer = roots;
  while (layer.length > 0) {
    stats.nodesVisited += layer.length;
    for (const batch of inIdBatches(layer)) {
      stats.sourceLookups += 1;
      stats.queries += 1;
      for (const [id, rows] of sources.listSync(batch)) visits.get(id)!.holdsRows = rows.length > 0;
    }
    const undecided = layer.filter((id) => !forced.has(id) && !visits.get(id)!.holdsRows);
    for (const edge of readLineageEdges(db, "source_id", undecided, stats)) {
      if (edge.target_id !== edge.source_id) visits.get(edge.source_id)!.parents.push(edge.target_id);
    }
    // 자기 출처 행으로 남는 노드 아래로는 내려가지 않는다(고정 뿌리는 내려간다).
    const expand = layer.filter((id) => forced.has(id) || !visits.get(id)!.holdsRows);
    const next: number[] = [];
    for (const edge of readLineageEdges(db, "target_id", expand, stats)) {
      if (edge.source_id === edge.target_id) continue;
      appendTo(planParents, edge.source_id, edge.target_id);
      if (visits.has(edge.source_id)) continue;
      visits.set(edge.source_id, { holdsRows: false, parents: [] });
      next.push(edge.source_id);
    }
    if (explicit) {
      for (const [childId, declarers] of declaredOnlyChildren(db, expand, visits, declaredParents, stats)) {
        if (!visits.has(childId)) {
          visits.set(childId, { holdsRows: false, parents: [] });
          next.push(childId);
        }
        const known = declaredParents.get(childId);
        declaredParents.set(childId, known ? [...new Set([...known, ...declarers])] : declarers);
      }
    }
    layer = next;
  }

  let kept = keptAfterPropagation(visits, declaredParents, forced, new Set());
  let blocked = new Set<number>();
  if (explicit && trigger.policy === "selected_only") {
    blocked = rootsHoldingDraggedNodes(visits, kept, forced, planParents, declaredParents);
    if (blocked.size > 0) {
      const stillForced = new Set([...forced].filter((id) => !blocked.has(id)));
      kept = keptAfterPropagation(visits, declaredParents, stillForced, blocked);
      for (const id of visits.keys()) {
        if (!kept.has(id) && !stillForced.has(id)) {
          throw new Error(`planSourceRemoval: selected_only 계획이 고르지 않은 노드 ${id} 를 없애려 합니다(막기 계산 오류)`);
        }
      }
    }
  }
  const ascending = (a: number, b: number) => a - b;
  const removeIds = [...visits.keys()].filter((id) => !kept.has(id)).sort(ascending);
  const removedDeclared = new Map<number, number[]>();
  for (const id of removeIds) {
    const declarers = declaredParents.get(id);
    if (declarers) removedDeclared.set(id, [...declarers].sort(ascending));
  }
  return {
    rootIds: [...roots].sort(ascending),
    removeIds,
    keptIds: [...kept].sort(ascending),
    declaredParents: removedDeclared,
    blockedIds: [...blocked].sort(ascending),
    stats,
  };
}

function appendTo(map: Map<number, number[]>, key: number, value: number): void {
  const known = map.get(key);
  if (known) known.push(value);
  else map.set(key, [value]);
}

/**
 * selected_only 막기: cascade 결과에서 끌려가는 노드(고정 뿌리가 아닌데 없어질 노드)마다 계획 안 부모를 따라
 * 위로 걸어 닿는 고정 뿌리를 모두 막는다. 걷기는 없어질 노드만 지나간다(남는 부모는 이미 지지를 준다). 자기
 * 출처 행이 있는 막힌 뿌리는 스스로 남으므로 그 위로는 걷지 않고, 출처 행이 없는 막힌 뿌리는 남으려면 부모가
 * 필요하므로 그 위로 계속 걷는다. 노드마다 한 번만 지나간다.
 */
function rootsHoldingDraggedNodes(
  visits: ReadonlyMap<number, Visit>,
  kept: ReadonlySet<number>,
  forced: ReadonlySet<number>,
  planParents: ReadonlyMap<number, number[]>,
  declaredParents: ReadonlyMap<number, number[]>,
): Set<number> {
  const blocked = new Set<number>();
  const stack = [...visits.keys()].filter((id) => !kept.has(id) && !forced.has(id));
  const walked = new Set(stack);
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const parentId of [...(planParents.get(id) ?? []), ...(declaredParents.get(id) ?? [])]) {
      if (walked.has(parentId) || kept.has(parentId) || !visits.has(parentId)) continue;
      walked.add(parentId);
      if (forced.has(parentId)) {
        blocked.add(parentId);
        if (visits.get(parentId)!.holdsRows) continue;
      }
      stack.push(parentId);
    }
  }
  return blocked;
}

/**
 * 남김 퍼뜨리기. 처음 남는 노드 = 처음부터 남기기로 한 노드(selected_only 의 막힌 뿌리), 그리고 자기 출처
 * 행이 있거나 계획 밖 부모가 있는 노드(고정 뿌리 제외). 그 뒤 남는 노드의 계획 안 자식을 한 번씩 남김으로
 * 올린다.
 */
function keptAfterPropagation(
  visits: ReadonlyMap<number, Visit>,
  declaredParents: ReadonlyMap<number, number[]>,
  forced: ReadonlySet<number>,
  initiallyKept: ReadonlySet<number>,
): Set<number> {
  const kept = new Set<number>();
  const childrenInPlan = new Map<number, number[]>();
  const queue: number[] = [];
  for (const [id, visit] of visits) {
    if (forced.has(id)) continue;
    let supported = visit.holdsRows || initiallyKept.has(id);
    for (const parentId of [...visit.parents, ...(declaredParents.get(id) ?? [])]) {
      if (!visits.has(parentId)) {
        supported = true;
        continue;
      }
      const children = childrenInPlan.get(parentId);
      if (children) children.push(id);
      else childrenInPlan.set(parentId, [id]);
    }
    if (supported) {
      kept.add(id);
      queue.push(id);
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const childId of childrenInPlan.get(queue[cursor]!) ?? []) {
      if (kept.has(childId)) continue;
      kept.add(childId);
      queue.push(childId);
    }
  }
  return kept;
}

/** 요청한 id 중 knowledge_nodes 에 있는 것(중복·양수 아닌 값 제외, 오름차순). */
function existingNodeIds(db: Database, ids: readonly number[], stats: RemovalPlanStats): number[] {
  const wanted = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
  const out: number[] = [];
  for (const batch of inIdBatches(wanted)) {
    stats.queries += 1;
    // dynamic SQL: placeholder count varies, keep prepare()
    const records = db
      .prepare(`SELECT id FROM knowledge_nodes WHERE id IN (${sqlPlaceholders(batch.length)})`)
      .all(...batch) as Array<{ id: number }>;
    for (const record of records) out.push(record.id);
  }
  return out.sort((a, b) => a - b);
}

/** ids 쪽 끝(column)에 붙은 계보 엣지. source_id = 자식, target_id = 부모. */
function readLineageEdges(
  db: Database,
  column: "source_id" | "target_id",
  ids: readonly number[],
  stats: RemovalPlanStats,
): EdgeRecord[] {
  const out: EdgeRecord[] = [];
  for (const batch of inIdBatches(ids)) {
    stats.queries += 1;
    // dynamic SQL: placeholder count varies, keep prepare()
    const records = db
      .prepare(
        `SELECT source_id, target_id FROM knowledge_edges
         WHERE ${column} IN (${sqlPlaceholders(batch.length)}) AND relation IN (${LINEAGE_PLACEHOLDERS})`,
      )
      .all(...batch, ...SHARED_MEMORY_LINEAGE_RELATIONS) as EdgeRecord[];
    stats.edgesRead += records.length;
    for (const record of records) out.push(record);
  }
  return out;
}

/**
 * explicit 방아쇠 전용: parents 의 metadata.extractedTo 에 있으나 계보 엣지(부모 쪽)가 하나도 없는 실존
 * 노드 → 그 목록을 가진 노드들. 이미 계보 엣지로 방문한 노드는 빼고, extractedTo 로 이미 들어온
 * 노드는 목록을 가진 노드만 더한다. 묶음마다 extractedTo 읽기 1번, 존재 확인 1번, 부모 엣지 확인 1번.
 */
function declaredOnlyChildren(
  db: Database,
  parents: readonly number[],
  visits: ReadonlyMap<number, Visit>,
  alreadyDeclared: ReadonlyMap<number, number[]>,
  stats: RemovalPlanStats,
): Map<number, number[]> {
  const declarersByChild = new Map<number, number[]>();
  for (const batch of inIdBatches(parents)) {
    stats.queries += 1;
    // dynamic SQL: placeholder count varies, keep prepare()
    const records = db
      .prepare(
        `SELECT id, metadata_json -> '$.extractedTo' AS list FROM knowledge_nodes
         WHERE id IN (${sqlPlaceholders(batch.length)}) AND json_type(metadata_json, '$.extractedTo') = 'array'`,
      )
      .all(...batch) as Array<{ id: number; list: string }>;
    for (const record of records) {
      for (const childId of JSON.parse(record.list) as unknown[]) {
        if (typeof childId !== "number" || !Number.isSafeInteger(childId) || childId <= 0) continue;
        if (childId === record.id) continue;
        if (visits.has(childId) && !alreadyDeclared.has(childId)) continue;
        const declarers = declarersByChild.get(childId);
        if (declarers) declarers.push(record.id);
        else declarersByChild.set(childId, [record.id]);
      }
    }
  }
  const fresh = [...declarersByChild.keys()].filter((id) => !alreadyDeclared.has(id));
  const existing = new Set(existingNodeIds(db, fresh, stats));
  const withLineage = new Set(readLineageEdges(db, "source_id", [...existing], stats).map((edge) => edge.source_id));
  const out = new Map<number, number[]>();
  for (const [childId, declarers] of declarersByChild) {
    if (!alreadyDeclared.has(childId) && (!existing.has(childId) || withLineage.has(childId))) continue;
    out.set(childId, declarers);
  }
  return out;
}
