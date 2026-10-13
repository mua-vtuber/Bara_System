/**
 * store-internal/entity-concept-edge-repository.ts — 엔티티 행의 라벨·identity
 * 엣지 공통 CRUD (spec 2026-06-09 §4.2·§6.6 · 분류 단계4 T4 범용 통합).
 *
 * 분류 단계4 T4: 옛 `<type>_concept_edges` 8개 테이블(works→work_concept_edges 등·
 * 죽은 전용 본체 테이블로 향하는 FK)을 범용 통합 엣지 테이블 `entity_concept_edges`
 * (T1 신설·FK→entities) 하나로 수렴했다. 정적 8 타입의 본체 행이 전용 테이블에서
 * 범용 `entities` 로 옮겨졌으므로(T4), 그 행에 거는 라벨·identity 엣지도 entity_id 를
 * 끝점으로 하는 통합 테이블에 저장해야 FK 가 맞는다(per-type 테이블 FK 는 죽은 본체를
 * 가리켜 INSERT 가 깨졌다). 새 종류(entity_types)도 같은 entities 본체에 살아 같은
 * 통합 엣지를 쓴다 — 종류 무관 단일 통로.
 *
 * 엣지 의미(wiring 이 소비):
 *  - role='has_attribute' = 엔티티 행 ↔ 라벨 개념(공유 특성). 예: 작품 행 ↔ "액션" 개념.
 *  - role='identity'      = 엔티티 행 ↔ 위계 잎 개념(이 행 = 이 위계 잎). spec §6.6.
 * role 은 자유 문자열로 받아 위 둘에 묶지 않는다 — plan 이 새 갈래를 더할 수 있다.
 *
 * typeName 인자는 호출처 의도 표시·시그니처 안정용으로 남긴다 — entity_id 가 전역
 * UNIQUE 라 통합 테이블 조회·쓰기에 종류 분기가 필요 없다. 동적 테이블명 분기가 사라져
 * SQL injection 면(테이블/칸 이름이 전부 리터럴)이 더 단순해졌다. HTTP 입력은 placeholder
 * `?` 바인딩만 거친다(entity-embedding.ts 주석 정합).
 */

import type { Database } from "bun:sqlite";
import { nowKst } from "./helpers.ts";
import { warnOnRelationPolicy } from "../../memory/relation-policy.ts";
import {
  listRelationEdges,
  type RelationEndpointFilter,
  type UnifiedRelationEdge,
} from "../../memory/relation-reader.ts";
import type { Provenance } from "../../memory/provenance-vocabulary.ts";

/** `entity_concept_edges` 한 행 — 엔티티 행 ↔ 개념(라벨·identity) 엣지. */
export interface EntityConceptEdge {
  entityId: string;
  conceptId: string;
  role: string;
  /** 라벨 강도(없으면 null). spec 은 weight 를 선택 칸으로 둔다. */
  weight: number | null;
  createdAt: string;
}

export class EntityConceptEdgeRepository {
  constructor(private readonly db: Database) {}

  /**
   * 엔티티 행 → 개념 엣지 추가. INSERT OR IGNORE 라 같은
   * (entity, concept, role) 중복은 silently ignore — 신규면 true, 중복이면 false.
   * 멱등(두 번 호출해도 한 행). weight 는 선택(미지정 시 NULL). 범용 통합 테이블
   * entity_concept_edges 에 entity_id 끝점으로 쓴다(단계4 T4·죽은 per-type FK 제거).
   */
  addEntityConceptEdge(
    _typeName: string,
    entityId: string,
    conceptId: string,
    role: string,
    provenance: Provenance,
    sourceNodeId: number | null,
    weight?: number,
  ): boolean {
    warnOnRelationPolicy("entity_concept_edges", "role", role);
    const result = this.db
      .query(
        `INSERT OR IGNORE INTO entity_concept_edges
           (entity_id, concept_id, role, provenance, source_node_id, weight, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entityId, conceptId, role, provenance, sourceNodeId, weight ?? null, nowKst());
    return result.changes > 0;
  }

  /**
   * 한 엔티티 행이 가진 개념 엣지 목록(엔티티 → 개념 방향). role 을 주면 그 role 만,
   * 안 주면 전부. 행이 없으면 빈 배열(정직한 빈 결과 — 실패가 아니라 진짜 없음).
   */
  getEntityConceptEdges(
    _typeName: string,
    entityId: string,
    role?: string,
  ): EntityConceptEdge[] {
    return listEntityConceptEdges(this.db, {
      source: { id: entityId },
      role,
    });
  }

  /**
   * 한 개념을 가진 *그 종류(typeName)* 엔티티 행 목록(개념 → 엔티티 역방향). role 을
   * 주면 그 role 만. 행이 없으면 빈 배열. 라벨로 같은 종류를 묶어 찾을 때 쓴다(검색 합류).
   *
   * 통합 테이블은 종류를 안 담으므로 entities 로 JOIN 해 type_name 으로 거른다 — 옛
   * per-type 테이블이 구조적으로 보장하던 "그 종류만" 의미를 보존한다(단계4 T4). 이
   * 필터가 없으면 graph-augment 의 ENTITY_TYPE_METAS 순회가 한 엔티티를 8 종류 모두로
   * 잘못 합류시켜(엉뚱한 sourceType·8배 중복) 동작이 깨진다. addEntityConceptEdge·
   * getEntityConceptEdges 는 entity_id 단건이라 종류 필터가 불필요(entity_id 전역 UNIQUE).
   */
  getEntitiesByConcept(
    typeName: string,
    conceptId: string,
    role?: string,
  ): EntityConceptEdge[] {
    return listEntityConceptEdges(this.db, {
      source: { kind: typeName },
      target: { kind: "concept", id: conceptId },
      role,
    });
  }
}

function listEntityConceptEdges(
  db: Database,
  filter: {
    source?: RelationEndpointFilter;
    target?: RelationEndpointFilter;
    role?: string;
  },
): EntityConceptEdge[] {
  return listRelationEdges(db, {
    tableName: "entity_concept_edges",
    source: filter.source,
    target: filter.target,
    relation: filter.role,
  })
    .map(readerEdgeToEntityConceptEdge)
    .sort(compareEntityConceptEdges);
}

function readerEdgeToEntityConceptEdge(edge: UnifiedRelationEdge): EntityConceptEdge {
  return {
    entityId: edge.sourceId,
    conceptId: edge.targetId,
    role: edge.relation,
    weight: edge.weight,
    createdAt: edge.createdAt ?? "",
  };
}

function compareEntityConceptEdges(
  a: EntityConceptEdge,
  b: EntityConceptEdge,
): number {
  const byCreated = a.createdAt.localeCompare(b.createdAt);
  if (byCreated !== 0) return byCreated;
  const byEntity = a.entityId.localeCompare(b.entityId);
  if (byEntity !== 0) return byEntity;
  const byConcept = a.conceptId.localeCompare(b.conceptId);
  if (byConcept !== 0) return byConcept;
  return a.role.localeCompare(b.role);
}
