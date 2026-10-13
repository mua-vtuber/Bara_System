/**
 * ProjectEntityMixin — 프로젝트 1급 엔티티 + 신규 8타입 라벨/identity 엣지 +
 * 통합 cross-type 관계 엣지 위임 묶음(facade 분해 C2/store). 동작 무변경.
 */

import type {
  Project,
  ProjectConceptEdge,
  ProjectConceptRole,
  ProjectPersonEdge,
  ProjectStatus,
} from "../../memory/types.ts";
import type {
  CreateProjectArgs,
  ProjectLookup,
  UpdateProjectArgs,
} from "../store-internal/project-repository.ts";
import type { EntityConceptEdge } from "../store-internal/entity-concept-edge-repository.ts";
import type {
  EntityRelationEdge,
  EntityRef,
} from "../store-internal/entity-relation-edge-repository.ts";
import type { PlacementTypeName } from "../../memory/concept-type-vocabulary.ts";
import type { Constructor, StoreInternals } from "./base.ts";
import type { Provenance } from "../../memory/provenance-vocabulary.ts";

export function ProjectEntityMixin<TBase extends Constructor<StoreInternals>>(
  Base: TBase,
) {
  return class ProjectEntityMixed extends Base {
    // ── 프로젝트 1급 엔티티 (projects + 두 엣지) — ProjectRepository 위임 (1.2 T6) ─

    /** 이름으로 프로젝트를 찾거나 만든다(name UNIQUE). 빈 이름·잘못된 status 는 throw. */
    async findOrCreateProject(args: CreateProjectArgs): Promise<Project> {
      return this.projectRepo.findOrCreateProject(args);
    }

    /** 프로젝트 부분 수정(summary·status·attributes·embeddingText). 미존재 id 면 null. */
    async updateProject(
      projectId: string,
      fields: UpdateProjectArgs,
    ): Promise<Project | null> {
      return this.projectRepo.updateProject(projectId, fields);
    }

    async getProject(projectId: string): Promise<Project | null> {
      return this.projectRepo.getProject(projectId);
    }

    async findProjectByName(name: string): Promise<Project | null> {
      return this.projectRepo.findProjectByName(name);
    }

    async findProjectByNameOrAlias(name: string): Promise<ProjectLookup> {
      return this.projectRepo.findProjectByNameOrAlias(name);
    }

    /** 프로젝트 목록 — status 필터(미지정 = 전체). 최근 갱신 순. */
    async listProjects(
      options: { limit?: number; status?: ProjectStatus } = {},
    ): Promise<Project[]> {
      return this.projectRepo.listProjects(options);
    }

    /** 프로젝트 요약 임베딩 적재(범용 entities_vec·type_name='project'·T7'b). 성공하면 true. 실패는 그대로 throw. */
    async applyProjectEmbedding(projectId: string): Promise<boolean> {
      return this.projectRepo.applyProjectEmbedding(projectId);
    }

    /** 프로젝트 → 개념(특성 라벨) 엣지 추가. 신규면 true, 중복이면 false. */
    async addProjectConceptEdge(
      projectId: string,
      conceptId: string,
      role: ProjectConceptRole,
      provenance: Provenance,
      sourceNodeId: number | null,
    ): Promise<boolean> {
      return this.projectRepo.addProjectConceptEdge(
        projectId,
        conceptId,
        role,
        provenance,
        sourceNodeId,
      );
    }

    /**
     * 프로젝트 → 사람(참여자) 엣지를 범용 entity_relation_edges 에 participated_by 로
     * 적는다. role 은 통합 후 보존하지 않는다(검색·표시가 role 을 안 가름·사용자 결정).
     * 신규면 true, 중복이면 false(멱등). role 인자는 라우트 계약 유지로 받되 무시한다.
     */
    async addProjectPersonEdge(
      projectId: string,
      personId: string,
      role: string,
      provenance: Provenance,
      sourceNodeId: number | null,
    ): Promise<boolean> {
      void role;
      return this.entityRelationEdgeRepo.addEntityRelationEdge(
        "project",
        projectId,
        "person",
        personId,
        "participated_by",
        provenance,
        sourceNodeId,
      );
    }

    /** 프로젝트의 참여자 목록(프로젝트 → 사람). 없으면 빈 배열. */
    async listProjectParticipants(
      projectId: string,
    ): Promise<ProjectPersonEdge[]> {
      return this.projectRepo.listProjectParticipants(projectId);
    }

    /** 한 사람이 참여한 프로젝트 목록(사람 → 프로젝트). 없으면 빈 배열. */
    async listPersonProjects(personId: string): Promise<ProjectPersonEdge[]> {
      return this.projectRepo.listPersonProjects(personId);
    }

    /** 프로젝트의 개념(특성 라벨) 목록. 없으면 빈 배열. */
    async listProjectConcepts(
      projectId: string,
    ): Promise<ProjectConceptEdge[]> {
      return this.projectRepo.listProjectConcepts(projectId);
    }

    /**
     * 한 개념에 이어진 프로젝트 목록 — 개념 → 프로젝트 역방향(읽기 전용).
     * role 미지정 = classification/tag 전체. 없으면 빈 배열.
     * graph.ts Task 9 가 프로젝트 노드 합류에 사용한다.
     */
    getProjectsByConceptId(
      conceptId: string,
      role?: string,
    ): Array<{ projectId: string; role: string }> {
      return this.projectRepo.getProjectsByConceptId(conceptId, role);
    }

    // ── 엔티티 행 라벨·identity 엣지 (통합 entity_concept_edges) — 3단계 Task 1·단계4 T4 ──
    // EntityConceptEdgeRepository 위임. role='has_attribute'(라벨)·'identity'(위계 잎).
    // typeName 은 string — 정적 8 타입(EntityTypeName) + 사용자 새 종류(런타임 string)
    // 모두 같은 통합 테이블 단일 통로를 탄다(entity_id 전역 UNIQUE 라 add/get-by-id 는 종류
    // 무관, getEntitiesByConcept 만 entities JOIN type_name 으로 종류를 가른다). user 종류
    // 묶음 노드 버그(G1·plan 2026-06-28)가 user identity 엣지를 이 통로로 깐다.
    addEntityConceptEdge(typeName: string, entityId: string, conceptId: string, role: string, provenance: Provenance, sourceNodeId: number | null, weight?: number): boolean { return this.entityConceptEdgeRepo.addEntityConceptEdge(typeName, entityId, conceptId, role, provenance, sourceNodeId, weight); }
    getEntityConceptEdges(typeName: string, entityId: string, role?: string): EntityConceptEdge[] { return this.entityConceptEdgeRepo.getEntityConceptEdges(typeName, entityId, role); }
    getEntitiesByConcept(typeName: string, conceptId: string, role?: string): EntityConceptEdge[] { return this.entityConceptEdgeRepo.getEntitiesByConcept(typeName, conceptId, role); }

    // ── 통합 cross-type 관계 엣지 (entity_relation_edges) — 4단계 Task 1 ──
    // EntityRelationEdgeRepository 위임. 엔티티 행 ↔ 엔티티 행(작품→사람 created_by 등).
    // addEntityRelationEdge 는 쓰기 직전 assertRelationName 으로 unknown relation 을
    // loud throw 한다(거짓 엣지 0). 양방향 1-hop 조회는 검색 펼침(Task 5)이 쓴다.
    addEntityRelationEdge(sourceType: PlacementTypeName, sourceId: string, targetType: PlacementTypeName, targetId: string, relation: string, provenance: Provenance, sourceNodeId: number | null, weight?: number): boolean { return this.entityRelationEdgeRepo.addEntityRelationEdge(sourceType, sourceId, targetType, targetId, relation, provenance, sourceNodeId, weight); }
    getRelationsFromSource(sourceType: PlacementTypeName, sourceId: string): EntityRelationEdge[] { return this.entityRelationEdgeRepo.getRelationsFromSource(sourceType, sourceId); }
    getRelationsToTarget(targetType: PlacementTypeName, targetId: string): EntityRelationEdge[] { return this.entityRelationEdgeRepo.getRelationsToTarget(targetType, targetId); }
    getRelationNeighbors(type: PlacementTypeName, id: string): EntityRelationEdge[] { return this.entityRelationEdgeRepo.getRelationNeighbors(type, id); }
    // 검색 1-hop 펼침(Task 5) — 직접 잡은 개념 → identity 엔티티 행 seed → 관계로
    // 이어진 엔티티 글 노드(후보 pool 확장 / RRF 코어 0줄). retrieve-channels 가 쓴다.
    getEntitySeedsByConcepts(conceptIds: readonly string[]): EntityRef[] { return this.entityRelationEdgeRepo.getEntitySeedsByConcepts(conceptIds); }
    getRelatedEntityNodeIds(seedEntityRefs: readonly EntityRef[], limit: number): number[] { return this.entityRelationEdgeRepo.getRelatedEntityNodeIds(seedEntityRefs, limit); }
  };
}
