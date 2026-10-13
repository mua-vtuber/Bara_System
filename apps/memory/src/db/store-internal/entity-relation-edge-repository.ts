/**
 * store-internal/entity-relation-edge-repository.ts — 통합 cross-type 관계 엣지 공통
 * CRUD (4단계 Task 1 · spec 2026-06-09 §7.2).
 *
 * 3단계가 만든 엔티티 행끼리(작품 행 → 사람 행 created_by 등)를 잇는 단일 테이블
 * entity_relation_edges 를 한 repository 가 다룬다. 3단계 라벨 엣지
 * (entity-concept-edge-repository)와 갈래가 다르다: 라벨 엣지는 엔티티 행 ↔ 개념을
 * 8 타입마다 따로 둔 `<type>_concept_edges` 에 적지만, 관계 엣지는 어느 타입 행이든
 * 어느 타입 행이든 가리키므로 한 테이블에 (source_type, source_id, target_type,
 * target_id) 네 칸으로 양 끝을 적는다.
 *
 * FK 0: source/target 이 8 타입 + person/project 어느 테이블이든 가리키므로 단일 칸
 * FK 를 둘 수 없다(concept_edges·node_concept_edges 가 두 부모를 한 TEXT id 칸으로
 * 담아 FK 0 인 것과 같은 양식). 관계명 유효는 addEntityRelationEdge 가 쓰기 직전
 * assertRelationName 으로 막는다(unknown relation 은 식별자와 함께 loud throw —
 * 조용한 빈 결과·silent fallback 금지). 끝점 행 실재는 wiring(Task 4)이 책임진다.
 *
 * SQL 정합: 정적 SQL 이라 db.query() 캐시를 쓴다(entity-concept-edge-repository
 * 정합 — 동적 테이블 이름이 없어 한 SQL 문이 그대로 재사용된다). created_at 은
 * 형제 hierarchy_edges·코어 테이블과 같은 TEXT datetime(nowKst)으로 적는다 —
 * lexicographic 비교가 곧 시간 순서라 ORDER BY created_at 가 양방향 1-hop 조회를
 * 시간순으로 정렬한다(선통일 묶음 M2/T1 에서 옛 INTEGER epoch ms 를 TEXT 로 통일).
 * 같은 초 INSERT 동률은 PK(source_id, target_id) 보조 정렬로 결정성을 확보한다.
 */

import type { Database } from "bun:sqlite";
import type { PlacementTypeName } from "../../memory/concept-type-vocabulary.ts";
import { assertRelationName } from "../../memory/entity-relation-vocabulary.ts";
import {
  listRelationEdges,
  type RelationEndpointFilter,
  type UnifiedRelationEdge,
} from "../../memory/relation-reader.ts";
import { nowKst } from "./helpers.ts";
import type { Provenance } from "../../memory/provenance-vocabulary.ts";

/** 엔티티 행 한 점을 가리키는 참조(타입 + id). 관계 펼침 seed·이웃 단위. */
export interface EntityRef {
  type: PlacementTypeName;
  id: string;
}

/** entity_relation_edges 한 행 — 엔티티 행 ↔ 엔티티 행 통합 관계 엣지. */
export interface EntityRelationEdge {
  sourceType: PlacementTypeName;
  sourceId: string;
  targetType: PlacementTypeName;
  targetId: string;
  relation: string;
  /** 관계 강도(없으면 null). spec 은 weight 를 선택 칸으로 둔다. */
  weight: number | null;
  /** TEXT datetime (nowKst — "YYYY-MM-DD HH:MM:SS"). lexicographic 비교 = 시간순. */
  createdAt: string;
}

export class EntityRelationEdgeRepository {
  constructor(private readonly db: Database) {}

  /**
   * 엔티티 행 → 엔티티 행 관계 엣지 추가. INSERT OR IGNORE 라 같은
   * (source_type, source_id, target_type, target_id, relation) 중복은 silently
   * ignore — 신규면 true, 중복이면 false. 멱등(두 번 호출해도 한 행).
   *
   * relation 은 쓰기 직전 assertRelationName 으로 검증한다 — 허용 관계명 8개가
   * 아니면 식별자와 함께 loud throw(거짓 엣지·silent fallback 금지). weight 는
   * 선택(미지정 시 NULL).
   */
  addEntityRelationEdge(
    sourceType: PlacementTypeName,
    sourceId: string,
    targetType: PlacementTypeName,
    targetId: string,
    relation: string,
    provenance: Provenance,
    sourceNodeId: number | null,
    weight?: number,
  ): boolean {
    // unknown relation 은 여기서 멈춘다(조용히 빈 엣지로 가리지 않는다).
    // relation-policy 의 entity_relation_edges 표준 목록도 같은 seed vocabulary 를 쓴다.
    // 이 strict 검증(loud throw)이 있어서 entity_relation_edges 는 약한
    // warnOnRelationPolicy 경로를 의도적으로 거치지 않는다(FK 없는 polymorphic
    // 테이블이라 약한 경고 대신 강한 단언이 맞다 — relation-policy.ts 주석 참조).
    assertRelationName(relation);
    const result = this.db
      .query(
        `INSERT OR IGNORE INTO entity_relation_edges
           (source_type, source_id, target_type, target_id, relation, provenance,
            source_node_id, weight, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceType,
        sourceId,
        targetType,
        targetId,
        relation,
        provenance,
        sourceNodeId,
        weight ?? null,
        nowKst(),
      );
    return result.changes > 0;
  }

  /**
   * 한 source 행에서 나가는 관계 엣지 목록(source → target 방향). 행이 없으면 빈
   * 배열(정직한 빈 결과 — 실패가 아니라 진짜 없음). 검색 1-hop 펼침이 쓴다.
   */
  getRelationsFromSource(
    sourceType: PlacementTypeName,
    sourceId: string,
  ): EntityRelationEdge[] {
    return listEntityRelationEdges(this.db, {
      source: { kind: sourceType, id: sourceId },
    });
  }

  /**
   * 한 target 행으로 들어오는 관계 엣지 목록(target → source 역방향). 같은 작가를
   * 가리키는 다른 작품을 거꾸로 찾을 때 쓴다(검색 1-hop). 행이 없으면 빈 배열.
   */
  getRelationsToTarget(
    targetType: PlacementTypeName,
    targetId: string,
  ): EntityRelationEdge[] {
    return listEntityRelationEdges(this.db, {
      target: { kind: targetType, id: targetId },
    });
  }

  /**
   * 한 엔티티 행의 양방향 1-hop 이웃 엣지(나가는 것 + 들어오는 것 한 단). 검색이
   * source 든 target 이든 잡았을 때 양쪽으로 펼치게 한다(Task 5). 이웃이 없으면 빈
   * 배열. 같은 엣지가 양쪽에 동시에 잡히는 경우는 없다 — 한 행은 한 방향이다.
   */
  getRelationNeighbors(
    type: PlacementTypeName,
    id: string,
  ): EntityRelationEdge[] {
    return [
      ...this.getRelationsFromSource(type, id),
      ...this.getRelationsToTarget(type, id),
    ];
  }

  /**
   * 검색이 직접 잡은 개념 id 목록에서 그 개념을 identity 로 가진 엔티티 행을 회수한다
   * (검색 1-hop 펼침의 seed). 3단계가 행을 세울 때 `<type>_concept_edges` 에
   * role='identity' 로 위계 잎 개념 ↔ 행을 이었으므로(spec §6.6), 검색어가 '데못죽'
   * 개념을 직접 잡으면 그 개념을 identity 로 가진 작품 행(wrk_demotjuk)이 여기서 나온다.
   *
   * 신규 8 타입의 identity 엣지만 본다(person/project 는 자기 검색 채널이 따로 글을
   * 풀므로 여기 seed 로 안 더한다 — 이 통로는 신규 8 타입 엔티티 관계 펼침 전용).
   * conceptIds 가 빈 배열이면 빈 배열(IN () 빈 절 방어 — 정직한 빈 결과). identity
   * 엣지가 0건이면 빈 배열(검색어가 엔티티 행을 직접 잡지 않은 평범한 검색 — 펼침
   * 없이 옛 동작 그대로). SQL 실패는 삼키지 않고 전파한다.
   */
  getEntitySeedsByConcepts(conceptIds: readonly string[]): EntityRef[] {
    if (conceptIds.length === 0) return [];
    const placeholders = conceptIds.map(() => "?").join(",");
    const seeds: EntityRef[] = [];
    const seen = new Set<string>();
    // 분류 단계4 T4 — identity 엣지가 범용 통합 테이블 entity_concept_edges 에 모였다.
    // 종류는 통합 엣지가 안 담으므로 entities 로 JOIN 해 type_name 을 함께 읽는다(옛
    // per-type 테이블 순회 대체). 신규 8 타입만 seed 로 본다 — person/project 는 자기
    // 검색 채널이 글을 풀므로 제외한다(type_name NOT IN). value 는 placeholder 바인딩만.
    const rows = this.db
      .prepare(
        `SELECT e.entity_id AS entity_id, e.type_name AS type_name
         FROM entity_concept_edges ece
         JOIN entities e ON e.entity_id = ece.entity_id
         WHERE ece.role = 'identity'
           AND ece.concept_id IN (${placeholders})
           AND e.type_name NOT IN ('person', 'project')`,
      )
      .all(...conceptIds) as Array<{ entity_id: string; type_name: string }>;
    for (const r of rows) {
      const key = `${r.type_name}:${r.entity_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seeds.push({ type: r.type_name as EntityRef["type"], id: r.entity_id });
    }
    return seeds;
  }

  /**
   * 관계 1-hop 펼침의 핵심 — seed 엔티티에서 관계 엣지를 깊이 1 따라 모은 엔티티들을
   * 그 엔티티를 언급하는 글 노드(node_id)로 풀어 회신한다. '데못죽' seed →
   * created_by 로 이어진 아쿠타미(target) → 같은 아쿠타미를 target 으로 가진 다른
   * 작품 주술회전(other source) → 주술회전 글 노드, 이렇게 끌어온다.
   *
   * 깊이 1 고정(무한 확산 0): seed → 이웃 target → 같은 target 공유 다른 source,
   * 거기서 멈춘다(다른 source 를 다시 seed 로 안 씀). 펼친 엔티티들을 글 노드로
   * 풀 때만 한 단 더 내려가지 추가 관계 hop 은 없다.
   *
   * 1) getRelationNeighbors 로 seed 의 양방향 1-hop 이웃 엔티티(target 들 + seed 를
   *    target 으로 가진 source 들)를 모은다.
   * 2) 그 이웃 중 target 으로 잡힌 엔티티마다 getRelationsToTarget 으로 같은 target 을
   *    공유하는 *다른* source 한 단을 더 모은다(데못죽→아쿠타미→주술회전).
   * 3) 모은 엔티티(seed 제외)를 글 노드로 푼다: 신규 8 타입은 identity 개념을 거쳐
   *    node_concept_edges 로, person 은 node_person_edges 로 node_id 회수.
   *
   * seed 가 빈 배열이거나 이웃이 0개면 빈 배열(정직한 빈 결과 — 실패 아님). limit 로
   * 회수 글 수를 자른다. 같은 글 노드 중복은 제거한다. SQL 실패는 전파한다.
   */
  getRelatedEntityNodeIds(seedEntityRefs: readonly EntityRef[], limit: number): number[] {
    if (seedEntityRefs.length === 0 || limit <= 0) return [];

    const seedKeys = new Set(seedEntityRefs.map((s) => `${s.type}:${s.id}`));
    // 글로 풀 엔티티를 모은다(seed 자신은 제외 — 1차 검색이 이미 seed 글을 잡았다).
    const collected = new Map<string, EntityRef>();
    const addEntity = (ref: EntityRef) => {
      const key = `${ref.type}:${ref.id}`;
      if (seedKeys.has(key) || collected.has(key)) return;
      collected.set(key, ref);
    };

    for (const seed of seedEntityRefs) {
      const neighbors = this.getRelationNeighbors(seed.type, seed.id);
      for (const edge of neighbors) {
        // 1-hop 이웃 = 엣지의 반대편 끝.
        const otherEnd: EntityRef =
          edge.sourceType === seed.type && edge.sourceId === seed.id
            ? { type: edge.targetType, id: edge.targetId }
            : { type: edge.sourceType, id: edge.sourceId };
        addEntity(otherEnd);

        // 이웃이 *target* 으로 잡힌 경우(seed → otherEnd 방향)에 한해, 같은 target 을
        // 공유하는 다른 source 한 단 더(깊이 1 고정). otherEnd 가 source 였던 경우
        // (자료 → 데못죽)는 여기서 멈춘다 — 더 펼치면 깊이 2 가 된다.
        const otherIsTarget =
          edge.sourceType === seed.type && edge.sourceId === seed.id;
        if (otherIsTarget) {
          const sharing = this.getRelationsToTarget(otherEnd.type, otherEnd.id);
          for (const e2 of sharing) {
            addEntity({ type: e2.sourceType, id: e2.sourceId });
          }
        }
      }
    }

    if (collected.size === 0) return [];

    const refs = [...collected.values()];
    // 8 타입은 identity 개념을 거쳐, person 은 node_person_edges 로 글 노드를 푼다.
    const personIds = refs
      .filter((r) => r.type === "person")
      .map((r) => r.id);
    const entityRefs = refs.filter((r) => r.type !== "person" && r.type !== "project");

    const nodeIds: number[] = [];
    const seenNode = new Set<number>();
    const pushNode = (id: number) => {
      if (seenNode.has(id)) return;
      seenNode.add(id);
      nodeIds.push(id);
    };

    // (a) 신규 8 타입: identity 개념 → node_concept_edges 로 글 노드. 분류 단계4 T4 —
    //     identity 엣지가 범용 통합 entity_concept_edges(entity_id 끝점)에 모여, 종류별
    //     테이블 분기 없이 entity_id 한 키로 그 행의 identity 개념을 조회한다.
    for (const ref of entityRefs) {
      if (nodeIds.length >= limit) break;
      const rows = this.db
        .query(
          `SELECT DISTINCT nce.node_id AS node_id
           FROM entity_concept_edges ece
           JOIN node_concept_edges nce ON nce.concept_id = ece.concept_id
           WHERE ece.entity_id = ? AND ece.role = 'identity'`,
        )
        .all(ref.id) as Array<{ node_id: number }>;
      for (const r of rows) pushNode(r.node_id);
    }

    // (b) person target: node_person_edges 로 글 노드(작가 자신을 언급한 글).
    if (personIds.length > 0 && nodeIds.length < limit) {
      const personPlaceholders = personIds.map(() => "?").join(",");
      const personRows = this.db
        // dynamic SQL: placeholder count varies, keep prepare()
        .prepare(
          `SELECT DISTINCT node_id FROM node_person_edges
           WHERE person_id IN (${personPlaceholders})`,
        )
        .all(...personIds) as Array<{ node_id: number }>;
      for (const r of personRows) pushNode(r.node_id);
    }

    return nodeIds.slice(0, limit);
  }
}

function listEntityRelationEdges(
  db: Database,
  filter: {
    source?: RelationEndpointFilter;
    target?: RelationEndpointFilter;
  },
): EntityRelationEdge[] {
  return listRelationEdges(db, {
    tableName: "entity_relation_edges",
    ...filter,
  })
    .map(readerEdgeToEntityRelationEdge)
    .sort(compareEntityRelationEdges);
}

function readerEdgeToEntityRelationEdge(edge: UnifiedRelationEdge): EntityRelationEdge {
  return {
    sourceType: edge.sourceKind as PlacementTypeName,
    sourceId: edge.sourceId,
    targetType: edge.targetKind as PlacementTypeName,
    targetId: edge.targetId,
    relation: edge.relation,
    weight: edge.weight,
    createdAt: edge.createdAt ?? "",
  };
}

function compareEntityRelationEdges(
  a: EntityRelationEdge,
  b: EntityRelationEdge,
): number {
  const byCreated = a.createdAt.localeCompare(b.createdAt);
  if (byCreated !== 0) return byCreated;
  const bySource = a.sourceId.localeCompare(b.sourceId);
  if (bySource !== 0) return bySource;
  return a.targetId.localeCompare(b.targetId);
}
