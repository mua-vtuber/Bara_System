/**
 * store-internal/hierarchy-edge-repository.ts — 위계 단일 출처 읽기/쓰기 헬퍼
 * (Stage 0 Task 3 · spec 2026-06-14 §4.1).
 *
 * 위계(parent_of)를 새 단일 출처 테이블 hierarchy_edges 위에서 다룬다. 옛
 * concept_edges parent_of 통로(edge-repository)와 달리, 끝점이 concept·person·8
 * 엔티티·project 어느 타입 행이든 가리킬 수 있어 (source_type, source_id,
 * target_type, target_id) 네 칸으로 양 끝을 적는다(entity_relation_edges 양식 정합).
 *
 * FK 0: source/target 이 어느 타입 행이든 가리키므로 단일 칸 FK 를 둘 수 없다. 끝점
 * 행 실재는 wiring(S0-T4 이후)이 책임진다 — 이 repository 는 멱등 저장·삭제·자식
 * BFS·1단 부모/자식 조회만 한다. relation 은 'parent_of' 한 값 고정이라 검증 대신
 * 상수로 적는다.
 *
 * SQL 정합: source_id/target_id WHERE 절이 idx_he_source(source_type, source_id)·
 * idx_he_target(target_type, target_id) 인덱스를 받친다(기준 스키마). 정적 SQL 은
 * db.query() 캐시를, IN 절 placeholder 개수가 변하는 동적 SQL 은 db.prepare() 를 쓴다
 * (edge-repository 정합). created_at 은 schema DEFAULT(datetime('now','localtime'))가
 * 채운다 — INSERT 에 적지 않는다.
 *
 * 이 task 는 새 테이블 위 헬퍼만 만든다. edge-repository 의 옛 함수·옛 호출자는 후속
 * task(S0-T4/T5)가 전환할 때까지 그대로 둔다.
 */

import type { Database } from "bun:sqlite";
import type { Provenance } from "../../memory/provenance-vocabulary.ts";

const PARENT_OF = "parent_of";
const DEFAULT_HIERARCHY_WEIGHT = 0.9;
const TRANSITIVE_DESCENDANT_LIMIT = 64;
const HIERARCHY_MIN_WEIGHT = 0.7;

/** addHierarchyEdge 입력 — 양 끝 종류·id + 선택 weight. S0-T4·S1-T1·S2-T1 공통 계약. */
export interface AddHierarchyEdgeArgs {
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  provenance: Provenance;
  sourceNodeId: number | null;
  /** 위계 강도(미지정 시 0.9). */
  weight?: number;
}

/** 다형 hierarchy_edges 끝점. concept·person·project·8종/user 엔티티 모두 이 형태로 다룬다. */
export interface HierarchyEndpoint {
  type: string;
  id: string;
}

/** 지름길 감축 위계 쓰기 결과. raw insert 여부와 shortcut 판단을 호출자가 구분할 때 쓴다. */
export interface ReducedHierarchyWriteResult {
  inserted: boolean;
  skippedAsShortcut: boolean;
  prunedShortcutCount: number;
}

/**
 * getHierarchyEdgesWithin 한 행 — 위계 엣지 양 끝 종류·id + relation·weight.
 * 옛 ConceptEdge(개념 전용)와 달리 끝점이 cpt_·psn_·엔티티 어느 종류든이라
 * source/target 칸이 종류·id 한 쌍씩이다(테이블 양식 정합). relation 은 항상
 * 'parent_of'(이 함수가 그 한 종류만 본다).
 */
export interface HierarchyEdgeRow {
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relation: string;
  weight: number;
}

export class HierarchyEdgeRepository {
  constructor(private readonly db: Database) {}

  private endpointKey(endpoint: HierarchyEndpoint): string {
    return `${endpoint.type}\u0000${endpoint.id}`;
  }

  private sameEndpoint(a: HierarchyEndpoint, b: HierarchyEndpoint): boolean {
    return a.type === b.type && a.id === b.id;
  }

  private deleteHierarchyEdge(
    source: HierarchyEndpoint,
    target: HierarchyEndpoint,
  ): boolean {
    const result = this.db
      .query(
        `DELETE FROM hierarchy_edges
         WHERE source_type = ?
           AND source_id = ?
           AND target_type = ?
           AND target_id = ?
           AND relation = '${PARENT_OF}'`,
      )
      .run(source.type, source.id, target.type, target.id);
    return result.changes > 0;
  }

  private getDirectChildEndpoints(endpoint: HierarchyEndpoint): HierarchyEndpoint[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT target_type AS type, target_id AS id
         FROM hierarchy_edges
         WHERE relation = '${PARENT_OF}'
           AND source_type = ?
           AND source_id = ?`,
      )
      .all(endpoint.type, endpoint.id) as Array<{ type: string; id: string }>;
    return rows.map((r) => ({ type: r.type, id: r.id }));
  }

  private getDirectParentEndpoints(endpoint: HierarchyEndpoint): HierarchyEndpoint[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT source_type AS type, source_id AS id
         FROM hierarchy_edges
         WHERE relation = '${PARENT_OF}'
           AND target_type = ?
           AND target_id = ?`,
      )
      .all(endpoint.type, endpoint.id) as Array<{ type: string; id: string }>;
    return rows.map((r) => ({ type: r.type, id: r.id }));
  }

  private getChildrenTransitiveByEndpoint(
    seedEndpoints: HierarchyEndpoint[],
    minWeight: number,
    limit: number,
  ): HierarchyEndpoint[] {
    if (seedEndpoints.length === 0) return [];
    const visited = new Set(seedEndpoints.map((e) => this.endpointKey(e)));
    let frontier = [...seedEndpoints];
    const result: HierarchyEndpoint[] = [];
    while (frontier.length > 0 && result.length < limit) {
      const clauses = frontier
        .map(() => "(source_type = ? AND source_id = ?)")
        .join(" OR ");
      const params: Array<string | number> = [minWeight];
      for (const endpoint of frontier) {
        params.push(endpoint.type, endpoint.id);
      }
      const rows = this.db
        .prepare(
          `SELECT DISTINCT target_type AS type, target_id AS id
           FROM hierarchy_edges
           WHERE relation = '${PARENT_OF}'
             AND weight >= ?
             AND (${clauses})`,
        )
        .all(...params) as Array<{ type: string; id: string }>;
      const nextFrontier: HierarchyEndpoint[] = [];
      for (const row of rows) {
        if (result.length >= limit) break;
        const endpoint = { type: row.type, id: row.id };
        const key = this.endpointKey(endpoint);
        if (visited.has(key)) continue;
        visited.add(key);
        result.push(endpoint);
        nextFrontier.push(endpoint);
      }
      frontier = nextFrontier;
    }
    return result;
  }

  private isDeeperDescendant(
    source: HierarchyEndpoint,
    target: HierarchyEndpoint,
  ): boolean {
    const descendants = new Set(
      this.getChildrenTransitiveByEndpoint(
        [source],
        HIERARCHY_MIN_WEIGHT,
        TRANSITIVE_DESCENDANT_LIMIT,
      ).map((e) => this.endpointKey(e)),
    );
    if (!descendants.has(this.endpointKey(target))) return false;
    const directChildren = new Set(
      this.getDirectChildEndpoints(source).map((e) => this.endpointKey(e)),
    );
    return !directChildren.has(this.endpointKey(target));
  }

  /**
   * target 의 직접 부모 중, 다른 자식 경유 경로로도 target 에 닿는 부모 직통을 제거한다.
   * leaf가 먼저 매달리고 중간 사슬이 나중에 완성되는 순서 보정에도 쓰인다.
   */
  pruneHierarchyShortcutParentsOf(endpoint: HierarchyEndpoint): number {
    let pruned = 0;
    const directParents = this.getDirectParentEndpoints(endpoint);
    for (const parent of directParents) {
      const alternateSeeds = this.getDirectChildEndpoints(parent).filter(
        (child) => !this.sameEndpoint(child, endpoint),
      );
      if (alternateSeeds.length === 0) continue;
      const reachable = new Set(
        this.getChildrenTransitiveByEndpoint(
          alternateSeeds,
          HIERARCHY_MIN_WEIGHT,
          TRANSITIVE_DESCENDANT_LIMIT,
        ).map((e) => this.endpointKey(e)),
      );
      if (reachable.has(this.endpointKey(endpoint))) {
        if (this.deleteHierarchyEdge(parent, endpoint)) pruned += 1;
      }
    }
    return pruned;
  }

  /**
   * 위계 엣지 추가. INSERT OR IGNORE 라 같은
   * (source_type, source_id, target_type, target_id, relation) 중복은 silently
   * ignore — 신규면 true, 중복이면 false(멱등, 두 번 호출해도 한 행).
   *
   * relation 은 'parent_of' 고정, weight 는 미지정 시 0.9. created_at 은 schema
   * DEFAULT 가 채운다.
   */
  addHierarchyEdge(args: AddHierarchyEdgeArgs): boolean {
    const result = this.db
      .query(
        `INSERT OR IGNORE INTO hierarchy_edges
           (source_type, source_id, target_type, target_id, relation, provenance,
            source_node_id, weight)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.sourceType,
        args.sourceId,
        args.targetType,
        args.targetId,
        PARENT_OF,
        args.provenance,
        args.sourceNodeId,
        args.weight ?? DEFAULT_HIERARCHY_WEIGHT,
      );
    return result.changes > 0;
  }

  /**
   * 지름길 감축 위계 엣지 추가. 더 긴 경로가 이미 있으면 직통을 만들지 않고,
   * 직통이 허용되는 경우에도 insert 뒤 target 기준 shortcut parent 를 소급 정리한다.
   */
  addReducedHierarchyEdge(
    args: AddHierarchyEdgeArgs,
  ): ReducedHierarchyWriteResult {
    const source = { type: args.sourceType, id: args.sourceId };
    const target = { type: args.targetType, id: args.targetId };
    if (this.isDeeperDescendant(source, target)) {
      return {
        inserted: false,
        skippedAsShortcut: true,
        prunedShortcutCount: 0,
      };
    }
    const inserted = this.addHierarchyEdge(args);
    const prunedShortcutCount = this.pruneHierarchyShortcutParentsOf(target);
    return {
      inserted,
      skippedAsShortcut: false,
      prunedShortcutCount,
    };
  }

  /**
   * 위계 엣지 한 개를 정확히 떼낸다(parent_of 한 행 DELETE). 멱등 — 이미 없는
   * (source, target) 이면 0 행 DELETE(no-op). 같은 입력 두 번이라도 중복 삭제가
   * 없다. SQL 실패는 삼키지 않고 전파한다.
   */
  removeHierarchyEdge(
    sourceType: string,
    sourceId: string,
    targetType: string,
    targetId: string,
  ): void {
    this.deleteHierarchyEdge(
      { type: sourceType, id: sourceId },
      { type: targetType, id: targetId },
    );
  }

  /**
   * 검색 위계 펼침 — seed 에서 source 가 seed 인 parent_of 자식을 *사슬 끝까지*
   * (BFS, downward only) 깊이 순으로 회신한다. 자식 id 는 종류 섞임(cpt_·crt_·…).
   *
   * edge-repository.getParentOfChildrenTransitive 의 BFS/visited/limit/빈-방어
   * 로직을 그대로 옮기되, 테이블을 concept_edges → hierarchy_edges 로, 칼럼을
   * source_concept_id/target_concept_id → source_id/target_id 로 바꿨다.
   * relation='parent_of' 한정·weight ≥ minWeight 조건은 그대로다.
   *
   * 동작: visited 에 seed 를 미리 넣어 seed 자신은 결과에서 제외하고 cycle·다중
   * 경로 중복을 막는다. frontier 가 source 인 parent_of 엣지 중 weight ≥ minWeight
   * 인 것의 target 을 IN 절로 한 번에 조회(idx_he_source 인덱스)해, 새로 발견한
   * target 만 result 끝 + 다음 frontier 로 모은다. result.length 가 limit 에 닿으면
   * 멈춘다. BFS 라 1단계 자식이 먼저, 먼 자식이 뒤로 — 이 순서가 깊이 감쇠를 만든다.
   *
   * seedIds 가 빈 배열이면 빈 배열(IN () 빈 절 방어 — 정직한 빈 결과). SQL 실패는
   * 삼키지 않고 전파한다.
   */
  getParentOfChildrenTransitive(
    seedIds: string[],
    minWeight: number,
    limit: number,
  ): string[] {
    if (seedIds.length === 0) return [];
    const visited = new Set<string>(seedIds);
    let frontier = [...seedIds];
    const result: string[] = [];
    while (frontier.length > 0 && result.length < limit) {
      const placeholders = frontier.map(() => "?").join(",");
      // dynamic SQL: placeholder count varies, keep prepare()
      const rows = this.db
        .prepare(
          `SELECT DISTINCT target_id AS child_id
           FROM hierarchy_edges
           WHERE relation = '${PARENT_OF}'
             AND weight >= ?
             AND source_id IN (${placeholders})`,
        )
        .all(minWeight, ...frontier) as Array<{ child_id: string }>;
      const nextFrontier: string[] = [];
      for (const row of rows) {
        if (result.length >= limit) break;
        if (visited.has(row.child_id)) continue;
        visited.add(row.child_id);
        result.push(row.child_id);
        nextFrontier.push(row.child_id);
      }
      frontier = nextFrontier;
    }
    return result;
  }

  /**
   * 한 노드의 *직접 자식* id 목록 — parent_of 로 그 노드가 부모(source)인
   * 자식(target)들(깊이1). getParentOfChildrenTransitive 의 1단 짝 — 후손 집합에서
   * 직접 자식을 빼면 깊이 ≥ 2 후손이 남는다. WHERE source_id 라 idx_he_source 가
   * 받친다.
   *
   * 빈 결과 = 잎 노드(자식 없음·정직한 빈 결과). SQL 실패는 전파한다.
   */
  getDirectChildConceptIds(id: string): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT target_id AS child_id
         FROM hierarchy_edges
         WHERE relation = '${PARENT_OF}'
           AND source_id = ?`,
      )
      .all(id) as Array<{ child_id: string }>;
    return rows.map((r) => r.child_id);
  }

  /**
   * 한 노드의 *직접 부모* id 목록 — parent_of 로 그 노드를 자식으로 가리키는
   * 부모(source)들(깊이1). getParentOfChildrenTransitive(자식 방향 BFS)의 부모 방향
   * 1단 짝이다. WHERE target_id 라 idx_he_target 이 받친다.
   *
   * 빈 결과 = 직접 부모가 없는 루트 노드(정직한 빈 결과). SQL 실패는 전파한다.
   */
  getDirectParentConceptIds(id: string): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT source_id AS parent_id
         FROM hierarchy_edges
         WHERE relation = '${PARENT_OF}'
           AND target_id = ?`,
      )
      .all(id) as Array<{ parent_id: string }>;
    return rows.map((r) => r.parent_id);
  }

  /**
   * 입력 id 집합 안에서 source·target 이 *둘 다* 그 집합에 속하는 parent_of 엣지만
   * 회신(잎 판정·그래프 위계선 재료 — R7 hashtag-wiring / R8 graph-augment).
   *
   * edge-repository.getParentOfEdgesWithin 의 양끝-입력집합-안 계약을 그대로 옮기되,
   * 테이블을 concept_edges → hierarchy_edges 로, 끝점 칼럼을
   * source_concept_id/target_concept_id → source_id/target_id 로 바꿔 끝점 종류를
   * 가리지 않는다(끝점이 cpt_·psn_·엔티티 어느 종류든 한 화면 노드 집합 안이면 잡는다).
   * 종류는 따로 거르지 않는다 — id 가 화면 집합 안인지로만 양끝을 좁히면 충분하고,
   * id 자체가 prefix 로 종류를 품는다(매달린 엣지 0 계약 유지).
   *
   * source_id IN·target_id IN 둘 다로 좁혀 idx_he_source·idx_he_target 인덱스가
   * 받친다(migrations v20). ids 가 빈 배열이면 쿼리를 건너뛰고 빈 배열(IN () 빈 절
   * 방어 — "대상 없음" 정직한 빈 결과이지 실패 위장이 아니다). placeholder 개수가
   * 변하는 동적 SQL 이라 db.prepare() 를 쓴다. SQL 실패는 전파한다.
   */
  getHierarchyEdgesWithin(ids: string[]): HierarchyEdgeRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    // dynamic SQL: placeholder count varies, keep prepare()
    const rows = this.db
      .prepare(
        `SELECT source_type, source_id, target_type, target_id, relation, weight
         FROM hierarchy_edges
         WHERE relation = '${PARENT_OF}'
           AND source_id IN (${placeholders})
           AND target_id IN (${placeholders})`,
      )
      .all(...ids, ...ids) as Array<{
      source_type: string;
      source_id: string;
      target_type: string;
      target_id: string;
      relation: string;
      weight: number;
    }>;
    return rows.map((r) => ({
      sourceType: r.source_type,
      sourceId: r.source_id,
      targetType: r.target_type,
      targetId: r.target_id,
      relation: r.relation,
      weight: r.weight,
    }));
  }
}
