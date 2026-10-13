/**
 * store-internal/edge-repository.ts — 엣지 그래프 메서드 모음.
 *
 * SqliteMemoryStore facade 가 EdgeRepository 로 위임하는 단일 진입점.
 * knowledge_edges(자산 글끼리 관계) CRUD + BFS 탐색 + concept_edges(개념 ↔
 * 개념 위계) 접근 + 태그 개념 공출현 카운트를 담당한다.
 * embedder 의존 없음 — 생성자에 db 만 필요.
 */

import type { Database } from "bun:sqlite";
import type {
  ConceptEdge,
  ConceptEdgeRelation,
  EdgeRelation,
  MemoryEdge,
} from "../../memory/types.ts";
import type { ConceptEdgeRow, EdgeRow } from "./row-types.ts";
import { nowKst, rowToConceptEdge, rowToEdge } from "./helpers.ts";
import { warnOnRelationPolicy } from "../../memory/relation-policy.ts";
import type { Provenance } from "../../memory/provenance-vocabulary.ts";

export class EdgeRepository {
  constructor(private readonly db: Database) {}

  async addEdge(args: {
    sourceId: number;
    targetId: number;
    relation: EdgeRelation;
    provenance: Provenance;
    sourceNodeId: number | null;
    weight: number;
  }): Promise<void> {
    this.addEdgeSync(args);
  }

  /**
   * addEdge 의 동기 본체. embed/await 없는 순수 DB 쓰기라 호출자가
   * `db.transaction(() => {...})` 동기 콜백 안에서 노드 INSERT 와 한 덩어리로
   * 묶을 수 있다(addConceptEdgeSync M-5 패턴 — DocumentGraphRepository 문서
   * 단위 원자 쓰기가 소비). 외부 호출자는 그대로 addEdge(async)를 쓴다.
   */
  addEdgeSync(args: {
    sourceId: number;
    targetId: number;
    relation: EdgeRelation;
    provenance: Provenance;
    sourceNodeId: number | null;
    weight: number;
  }): void {
    warnOnRelationPolicy("knowledge_edges", "relation", args.relation);
    this.db
      .query(
        `INSERT OR IGNORE INTO knowledge_edges
          (source_id, target_id, relation, provenance, source_node_id, weight, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.sourceId,
        args.targetId,
        args.relation,
        args.provenance,
        args.sourceNodeId,
        args.weight,
        nowKst(),
      );
  }

  async getNeighbors(nodeId: number, limit = 20): Promise<MemoryEdge[]> {
    const rows = this.db
      .query(
        `SELECT * FROM knowledge_edges
         WHERE source_id = ? OR target_id = ?
         ORDER BY weight DESC LIMIT ?`,
      )
      .all(nodeId, nodeId, limit) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * 한 노드에 붙은 'supersedes' 엣지 전체(source·target 양방향). 편집 후 충돌
   * 재검사(ConflictChecker.recheckAfterEdit)가 기존 충돌 상대를 재평가하는 재료다.
   * getNeighbors 는 relation 무관 + weight 상위 limit 컷이라 supersedes 엣지가
   * 밀려날 수 있어 relation 한정 전수 조회를 별도로 둔다. 0건 = 빈 배열.
   */
  async getSupersedeEdges(nodeId: number): Promise<MemoryEdge[]> {
    const rows = this.db
      .query(
        `SELECT * FROM knowledge_edges
         WHERE relation = 'supersedes' AND (source_id = ? OR target_id = ?)`,
      )
      .all(nodeId, nodeId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * knowledge_edges 한 개 삭제(멱등 no-op — removeHierarchyEdge 선례).
   * (source, target, relation) 은 idx_ke_pair UNIQUE 라 최대 1행이 지워진다.
   * 편집 후 충돌 재검사가 band 를 벗어난 stale supersedes 엣지를 걷을 때 쓴다.
   */
  async removeEdge(
    sourceId: number,
    targetId: number,
    relation: EdgeRelation,
  ): Promise<void> {
    this.db
      .query(
        `DELETE FROM knowledge_edges
         WHERE source_id = ? AND target_id = ? AND relation = ?`,
      )
      .run(sourceId, targetId, relation);
  }

  // ── concept_edges (개념 ↔ 개념 위계) ──────────────────────────────────

  /**
   * 개념 위계 엣지 추가(조건부 갱신 UPSERT). 같은 (source, target, relation) 이 이미
   * 있으면 weight 를 MAX(기존, 새 값)으로 끌어올린다 — 더 높은 값으로만 갱신하고
   * 낮추지 않는다. 옛 순서 추측(0.3) 잔재가 있는 장수 DB·외부 fork 도 콜론으로 같은
   * 쌍을 다시 선언하면 0.9 로 자가 치유된다(spec
   * docs/decisions/2026-06-07-concept-edge-upsert-self-heal-spec.md).
   * created_at 은 첫 생성 시각 보존, updated_at 만 갱신. weight 미지정 시 default 0.3.
   */
  async addConceptEdge(args: {
    sourceConceptId: string;
    targetConceptId: string;
    relation: ConceptEdgeRelation;
    provenance: Provenance;
    sourceNodeId: number | null;
    weight?: number;
  }): Promise<void> {
    this.addConceptEdgeSync(args);
  }

  /**
   * addConceptEdge 의 동기 본체. embed/await 없는 순수 DB 쓰기라 호출자가
   * `db.transaction(() => {...})` 콜백(bun:sqlite 트랜잭션 콜백은 반드시 동기)
   * 안에서 다른 동기 쓰기와 한 덩어리로 묶을 수 있다(M-5). async 메서드를
   * 트랜잭션 콜백 안에서 await 없이 부르고 promise 를 버리는 fragile 패턴을
   * 피하려는 것이다. 외부 호출자는 그대로 addConceptEdge(async)를 쓴다.
   */
  addConceptEdgeSync(args: {
    sourceConceptId: string;
    targetConceptId: string;
    relation: ConceptEdgeRelation;
    provenance: Provenance;
    sourceNodeId: number | null;
    weight?: number;
  }): void {
    warnOnRelationPolicy("concept_edges", "relation", args.relation);
    const now = nowKst();
    this.db
      .query(
        `INSERT INTO concept_edges
           (source_concept_id, target_concept_id, relation, provenance, source_node_id,
            weight, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_concept_id, target_concept_id, relation) DO UPDATE SET
           weight = MAX(weight, excluded.weight),
           updated_at = excluded.updated_at`,
      )
      .run(
        args.sourceConceptId,
        args.targetConceptId,
        args.relation,
        args.provenance,
        args.sourceNodeId,
        args.weight ?? 0.3,
        now,
        now,
      );
  }

  /**
   * concept_edges 전체 또는 특정 relation 만 조회. weight DESC, source ASC 정렬.
   */
  async listConceptEdges(
    options: { relation?: ConceptEdgeRelation; limit?: number } = {},
  ): Promise<ConceptEdge[]> {
    const limit = options.limit ?? 10_000;
    if (options.relation) {
      const rows = this.db
        .query(
          `SELECT * FROM concept_edges
           WHERE relation = ?
           ORDER BY weight DESC, source_concept_id ASC LIMIT ?`,
        )
        .all(options.relation, limit) as ConceptEdgeRow[];
      return rows.map(rowToConceptEdge);
    }
    const rows = this.db
      .query(
        `SELECT * FROM concept_edges
         ORDER BY weight DESC, source_concept_id ASC LIMIT ?`,
      )
      .all(limit) as ConceptEdgeRow[];
    return rows.map(rowToConceptEdge);
  }

  /**
   * Phase 7 둘째 단계 Task 15 — 한 개념의 `llm_relation` 1-hop 이웃 개념 id 만 회신한다.
   *
   * 강한 모델이 발굴해 `concept_edges` 에 `relation='llm_relation'` 으로 넣은 관계
   * 엣지를 따라, 입력 개념과 직접 이어진 이웃 개념 id 집합을 회신한다. 검색 개념 채널이
   * 개념 A 를 잡았을 때 A 와 `llm_relation` 으로 이어진 개념 B 도 후보에 더하는 1-hop
   * 펼침의 재료다(spec §4.4·§5.2 — `getConnectedNodes` BFS 는 knowledge_edges 만 보므로
   * 개념 엣지 자동 합류가 안 통한다, 이 펼침이 그 합류 좌표).
   *
   * `relation='llm_relation'` 한정이라 위계 `parent_of` 는 따라가지 않는다(갈래 분리 —
   * spec §4.4 ③ 꼬리표 분리 정신). 이웃이 사람(`psn_`)이어도 그 id 를 그대로 회신한다 —
   * 사람·개념 자유 연결(Task 18 FK 완화) 정합. 다만 사람 끝 글 노드 합류는 Task 19 가
   * `getNodesByConcepts` 쪽에서 다룬다(이 메서드는 이웃 id 까지만 / `cpt_`·`psn_` 둘 다).
   *
   * source/target 양방향 매칭(엣지는 무방향 의미). DISTINCT(같은 이웃 중복 제거). 입력
   * 개념 자기 자신은 회신에서 제외(자기 이웃 차단). 엣지 0건 = 빈 배열(정직한 빈 결과).
   */
  getLlmRelationNeighborConceptIds(conceptId: string): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT CASE
                  WHEN source_concept_id = ?1 THEN target_concept_id
                  ELSE source_concept_id
                END AS neighbor_id
         FROM concept_edges
         WHERE relation = 'llm_relation'
           AND (source_concept_id = ?1 OR target_concept_id = ?1)`,
      )
      .all(conceptId) as Array<{ neighbor_id: string }>;
    return rows
      .map((r) => r.neighbor_id)
      .filter((id) => id !== conceptId);
  }

  /**
   * 1.2 T5 — 한 특성 개념(직업 라벨 등)에 has_attribute 로 이어진 사람 id 목록.
   *
   * "개발자인 사람들" 역방향 조회 — addPersonAttributeConcept 이 넣은
   * concept_edges(source=psn_, target=conceptId, relation='has_attribute') 행에서
   * source_concept_id 를 모은다. source 가 psn_ 인 행만 골라(라벨 끝이 아닌 사람 끝
   * 보장) personId 배열을 회신한다. 엣지 0건 = 빈 배열(정직한 빈 결과 — throw 안 함).
   *
   * relation='has_attribute' 한정이라 parent_of 위계·llm_relation 의미 관계와 갈래가
   * 다르다(getLlmRelationNeighborConceptIds 불변식 그대로). source_concept_id LIKE
   * 'psn_%' 로 라벨↔라벨 같은 다른 has_attribute 짝이 섞이는 일을 막는다.
   */
  getPersonsByAttributeConcept(conceptId: string): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT source_concept_id AS person_id
         FROM concept_edges
         WHERE target_concept_id = ?
           AND relation = 'has_attribute'
           AND source_concept_id LIKE 'psn_%'`,
      )
      .all(conceptId) as Array<{ person_id: string }>;
    return rows.map((r) => r.person_id);
  }

  /**
   * 한 개념의 직접 이웃 엣지(source 또는 target 매칭). 검색 결과 개념 펼침
   * (설계 단락 2.2 — 직접 연결 1단계)의 재료. weight DESC.
   */
  async getConceptNeighbors(conceptId: string, limit = 20): Promise<ConceptEdge[]> {
    const rows = this.db
      .query(
        `SELECT * FROM concept_edges
         WHERE source_concept_id = ? OR target_concept_id = ?
         ORDER BY weight DESC LIMIT ?`,
      )
      .all(conceptId, conceptId, limit) as ConceptEdgeRow[];
    return rows.map(rowToConceptEdge);
  }

  /**
   * 두 태그 개념이 *공출현* 한 자산 글 수(distinct node_id).
   *
   * 정의 = 같은 node_id 가 node_concept_edges(role='tag') 로 parent + child
   * 둘 다에 연결된 경우를 카운트. 옛 knowledge_edges(relation='tagged_with')
   * self-join 을 node_concept_edges 로 옮긴 것. 1.0b 동작 동일.
   *
   * 0 = 정상(변동 0 신호). throw 안 함.
   */
  async countConceptCoOccurrence(
    parentConceptId: string,
    childConceptId: string,
  ): Promise<number> {
    const row = this.db
      .query(
        `SELECT COUNT(DISTINCT e1.node_id) AS cnt
         FROM node_concept_edges e1
         JOIN node_concept_edges e2 ON e1.node_id = e2.node_id
         WHERE e1.concept_id = ? AND e1.role = 'tag'
           AND e2.concept_id = ? AND e2.role = 'tag'`,
      )
      .get(parentConceptId, childConceptId) as { cnt: number };
    return row.cnt;
  }

  /**
   * 자동 재정리(spec §4.2.1 B1) — 부모와 자식 *둘 다* role='tag' 로 붙은 과거 글
   * node_id 를 회신한다(distinct). 콜론 위계가 *나중에* 선언됐을 때, 그 선언 전에
   * 평평하게(부모+자식 둘 다) 붙은 과거 글을 찾는 재료다 — detachParentTagEdge 가
   * 그 글에서 부모 연결만 뗀다.
   *
   * countConceptCoOccurrence 의 self-join 양식 정합(단 count 가 아니라 node_id 목록).
   * 부모에만 붙고 자식엔 안 붙은 글은 JOIN(e2.concept_id IN children)에 안 걸려 자연
   * 제외된다 — 부모만 붙은 글은 안 건드린다(spec §4.2.4). childConceptIds 가 빈
   * 배열이면 빈 배열(IN () 빈 절 방어 — 정직한 빈 결과). SQL 실패는 전파한다.
   */
  async findFlatParentTagNodes(
    parentConceptId: string,
    childConceptIds: string[],
  ): Promise<number[]> {
    if (childConceptIds.length === 0) return [];
    const placeholders = childConceptIds.map(() => "?").join(",");
    // dynamic SQL: placeholder count varies, keep prepare()
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e1.node_id AS node_id
         FROM node_concept_edges e1
         JOIN node_concept_edges e2 ON e1.node_id = e2.node_id
         WHERE e1.concept_id = ? AND e1.role = 'tag'
           AND e2.concept_id IN (${placeholders}) AND e2.role = 'tag'`,
      )
      .all(parentConceptId, ...childConceptIds) as Array<{ node_id: number }>;
    return rows.map((r) => r.node_id);
  }

  /**
   * 자동 재정리(spec §4.2.1 B1) — 한 글에서 부모 개념의 role='tag' 엣지 *한 개만*
   * 떼고, 같은 트랜잭션 안에서 tag_reflow_log 에 떼어낸 기록을 남긴다. 둘이 한
   * 트랜잭션이라 엣지를 떼면 기록이 반드시 남는다(부분 실패로 기록 없이 떼이는 일 없음).
   *
   * 자식(잎) 엣지·mentions·classification role 엣지는 안 건드린다 — (node_id,
   * parentConceptId, role='tag') 한 행만 DELETE 한다. 그래서 떼인 글은 반드시 자식 tag
   * 엣지가 남아 검색에서 사라지지 않는다(spec §5.5 안전 증명 / A 가 부모 검색 시 도달).
   * 전역 DELETE(stats-repository)·concept 단위 DELETE(concept-repository 별칭 병합)와
   * 달리 한 엣지만 정확히 떼는 메서드라 신설한다. SQL 실패는 트랜잭션 롤백 + 전파한다
   * (호출자 reflowFlatParentTags 가 글 단위로 격리 warn — spec §4.2.4).
   */
  async detachParentTagEdge(
    nodeId: number,
    parentConceptId: string,
    triggerHierarchy: string,
  ): Promise<void> {
    const logId = `trl_${crypto.randomUUID()}`;
    const detachedAt = nowKst();
    const tx = this.db.transaction(() => {
      this.db
        .query(
          "DELETE FROM node_concept_edges WHERE node_id = ? AND concept_id = ? AND role = 'tag'",
        )
        .run(nodeId, parentConceptId);
      this.db
        .query(
          `INSERT INTO tag_reflow_log
             (log_id, node_id, parent_concept_id, trigger_hierarchy, detached_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(logId, nodeId, parentConceptId, triggerHierarchy, detachedAt);
    });
    tx();
  }

  /**
   * BFS traversal returning `[nodeId, maxEdgeWeight]` pairs. Walks up to
   * `maxHops` levels from `seedIds`, accumulates the highest edge weight
   * encountered along any path to each discovered node, and returns the
   * top `limit` by weight. Seeds themselves are excluded from the result.
   */
  async getConnectedNodes(
    seedIds: readonly number[],
    options: { maxHops?: number; limit?: number } = {},
  ): Promise<Array<[number, number]>> {
    const maxHops = options.maxHops ?? 2;
    const limit = options.limit ?? 30;
    if (seedIds.length === 0) return [];

    const visited = new Set<number>(seedIds);
    let frontier: number[] = [...seedIds];
    const discovered = new Map<number, number>();

    for (let hop = 0; hop < maxHops; hop++) {
      if (frontier.length === 0) break;
      const placeholders = frontier.map(() => "?").join(",");
      // dynamic SQL: placeholder count varies, keep prepare()
      const rows = this.db
        .prepare(
          `SELECT source_id, target_id, weight FROM knowledge_edges
           WHERE source_id IN (${placeholders})
              OR target_id IN (${placeholders})`,
        )
        .all(...frontier, ...frontier) as Array<{
        source_id: number;
        target_id: number;
        weight: number;
      }>;

      const nextFrontier: number[] = [];
      for (const row of rows) {
        for (const neighborId of [row.source_id, row.target_id]) {
          if (visited.has(neighborId)) continue;
          visited.add(neighborId);
          const prev = discovered.get(neighborId);
          discovered.set(
            neighborId,
            prev === undefined ? row.weight : Math.max(prev, row.weight),
          );
          nextFrontier.push(neighborId);
        }
      }
      frontier = nextFrontier;
    }

    const sorted = [...discovered.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, limit);
  }

  /** Return the subset of `nodeIds` that are targets of a 'supersedes' edge. */
  async getSupersededNodeIds(
    nodeIds: readonly number[],
  ): Promise<Set<number>> {
    if (nodeIds.length === 0) return new Set();
    const placeholders = nodeIds.map(() => "?").join(",");
    // dynamic SQL: placeholder count varies, keep prepare()
    const rows = this.db
      .prepare(
        `SELECT DISTINCT target_id FROM knowledge_edges
         WHERE target_id IN (${placeholders}) AND relation = 'supersedes'`,
      )
      .all(...nodeIds) as Array<{ target_id: number }>;
    return new Set(rows.map((r) => r.target_id));
  }

  /**
   * Return the subset of `nodeIds` that are *sources* of a 'supersedes' edge —
   * the new nodes that override some older node. Symmetric to
   * `getSupersededNodeIds` (which returns the old/target side). Used by the
   * search route to attach the "supersedes"(갱신함) flag in one batch query
   * (N+1 회피).
   */
  async getSupersedingNodeIds(
    nodeIds: readonly number[],
  ): Promise<Set<number>> {
    if (nodeIds.length === 0) return new Set();
    const placeholders = nodeIds.map(() => "?").join(",");
    // dynamic SQL: placeholder count varies, keep prepare()
    const rows = this.db
      .prepare(
        `SELECT DISTINCT source_id FROM knowledge_edges
         WHERE source_id IN (${placeholders}) AND relation = 'supersedes'`,
      )
      .all(...nodeIds) as Array<{ source_id: number }>;
    return new Set(rows.map((r) => r.source_id));
  }
}
