/**
 * store-internal/project-repository.ts — 프로젝트 1급 엔티티 전담 클래스
 * (분류 단계4 T7'b — 전용 projects 테이블 → 범용 본체 entities 통합).
 *
 * 단계4 T7'b: 프로젝트 본체를 전용 `projects` 테이블에서 범용 `entities`
 * (type_name='project')로 옮긴다. 정체성·임베딩·검색 색인이 work·creature 등
 * 다른 종류와 한 통로(entities·entity_attributes·entities_fts·entities_vec)에
 * 모인다. 프로젝트 id 는 entities 가 registry 접두사('prj_')로 만들어 옛 prj_ 정체성을
 * 그대로 유지한다 — 같은 이름 = 같은 프로젝트(type_name='project' 안 name 유일성).
 *
 * status·summary·embedding_text 는 entity_attributes 칸(is_column=1)으로 저장해
 * 합성 색인(FTS·임베딩) 본문에 들어가게 한다(검색 합류). attributes_json 은 라벨
 * (is_column=0)로 저장해 검색 본문에 안 들어간다(Q5 — 저장소 URL 등 검색 비노출).
 * 잘못된 status 는 throw — silent fallback 금지.
 *
 * 라벨·identity 엣지는 범용 통합 테이블 `entity_concept_edges`(entity_id 끝점·
 * FK→entities)에 저장한다(단계4 T4 가 만든 통합 엣지). 옛 project_concept_edges 는
 * 더 안 쓴다. 참여자 관계(participated_by)는 S2·S3 전환 후 범용 엣지
 * `entity_relation_edges`(source=project·target=person) 한 곳에만 산다 — 옛
 * project_person_edges 테이블은 S4 가 제거했다(읽기·쓰기 0인 죽은 테이블이었다).
 *
 * 요약 임베딩은 entitiesRepo.applyEmbedding 으로 범용 색인 entities_vec 에 적재한다
 * (옛 project_summary_vec 아님). 합성 텍스트(name + ko_name + 칸값)에 summary·
 * embedding_text 가 칸으로 들어가 있어 옛 "embedding_text → summary → name" 우선순위가
 * 보존된다(셋 다 합성 본문에 합류·차원 불일치는 loud throw).
 */

import type { Database } from "bun:sqlite";
import type {
  Project,
  ProjectConceptEdge,
  ProjectConceptRole,
  ProjectPersonEdge,
  ProjectStatus,
} from "../../memory/types.ts";
import { listRelationEdges } from "../../memory/relation-reader.ts";
import { warnOnRelationPolicy } from "../../memory/relation-policy.ts";
import type { Provenance } from "../../memory/provenance-vocabulary.ts";
import { nowKst } from "./helpers.ts";
import type { EntitiesRepository } from "./entities-repository.ts";

/**
 * 허용 status 값 단일 출처(spec Q1). entity_attributes 칸은 TEXT 무제약이라
 * 도메인 입력 통로(이 클래스)가 검증한다. 잘못된 값은 throw — silent fallback 금지.
 */
export const PROJECT_STATUSES = ["active", "done", "paused"] as const;

/**
 * 프로젝트 종류 이름 — entities 본체에서 type_name 칸으로 가른다. project 검색이
 * 범용 entities_fts/entities_vec 를 이 값으로 필터하므로(search-repository) 단일 출처로
 * export 한다(SQL 리터럴 'project' 하드코딩 0·no-hardcoding).
 */
export const PROJECT_TYPE_NAME = "project";

/**
 * 프로젝트 속성을 entity_attributes 로 저장할 때 쓰는 예약 attr_key. status·summary·
 * embedding_text 는 칸(is_column=1)이라 합성 색인 본문에 합류하고, attributes_json 은
 * 라벨(is_column=0)이라 검색 본문에 안 들어간다(Q5 검색 비노출).
 */
const STATUS_ATTR_KEY = "status";
const SUMMARY_ATTR_KEY = "summary";
const EMBEDDING_TEXT_ATTR_KEY = "embedding_text";
const ATTRIBUTES_JSON_ATTR_KEY = "attributes_json";

/** PROJECT_STATUSES 멤버인지 검사하는 type guard. */
function isProjectStatus(value: string): value is ProjectStatus {
  return (PROJECT_STATUSES as readonly string[]).includes(value);
}

/** findOrCreateProject 입력 — name 만 필수. summary/status 는 선택. */
export interface CreateProjectArgs {
  name: string;
  summary?: string | null;
  status?: ProjectStatus;
}

/** updateProject 부분 수정 입력 — 지정한 칸만 갱신한다. */
export interface UpdateProjectArgs {
  summary?: string | null;
  status?: ProjectStatus;
  attributes?: Record<string, unknown>;
  embeddingText?: string | null;
}

/**
 * findProjectByNameOrAlias 결과 — 확정 프로젝트와 모호 신호를 함께 담는다.
 * candidates 는 모호할 때만 실린다(겹친 프로젝트의 번호·이름).
 */
export interface ProjectLookup {
  project: Project | null;
  ambiguous: boolean;
  candidates?: Array<{ projectId: string; name: string }>;
}

/** entity_attributes 한 행(프로젝트 속성 읽기용). */
interface ProjectAttrRow {
  attr_key: string;
  attr_value: string;
}

export class ProjectRepository {
  /**
   * entitiesRepo 를 주입받아 본체 정체성(prj_ 생성·name 유일성·임베딩)을 범용 통로로
   * 위임한다(단계4 T7'b). db 는 entity_attributes·entity_concept_edges·
   * entity_relation_edges(participated_by) 쓰기와 registry 기반 읽기에 쓴다.
   */
  constructor(
    private readonly db: Database,
    private readonly entitiesRepo: EntitiesRepository,
  ) {}

  /**
   * status 문자열을 검증한다. 허용 목록(PROJECT_STATUSES) 밖이면 구체 에러 throw —
   * silent fallback 금지. 호출처가 잘못된 값을 그대로 넣는 일을 입구에서 막는다.
   */
  private assertStatus(status: string): void {
    if (!isProjectStatus(status)) {
      throw new Error(
        `invalid project status '${status}' (allowed: ${PROJECT_STATUSES.join(", ")})`,
      );
    }
  }

  /** 한 프로젝트(entity_id)의 예약 속성 칸을 모두 읽어 map 으로 돌려준다. */
  private readAttrs(projectId: string): Map<string, string> {
    const rows = this.db
      .query(
        `SELECT attr_key, attr_value FROM entity_attributes
         WHERE entity_id = ? AND attr_key IN (?, ?, ?, ?)`,
      )
      .all(
        projectId,
        STATUS_ATTR_KEY,
        SUMMARY_ATTR_KEY,
        EMBEDDING_TEXT_ATTR_KEY,
        ATTRIBUTES_JSON_ATTR_KEY,
      ) as ProjectAttrRow[];
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.attr_key, r.attr_value);
    return map;
  }

  /** attributes_json 문자열을 Record 로 안전 파싱(null/깨짐 → 빈 객체). */
  private parseAttributes(raw: string | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 손으로 편집된 깨진 JSON 방어 — 빈 객체.
    }
    return {};
  }

  /**
   * entities 행 + 속성 칸을 모아 Project 도메인 타입으로 재조립한다. 미존재 id 면 null.
   * status 는 entity_attributes 에서 읽고, 없으면 'active'(생성 시 항상 채우므로 정상
   * 경로에서는 항상 존재 — 손 편집 방어용 default). attributes 는 attributes_json 파싱.
   */
  private async reassemble(projectId: string): Promise<Project | null> {
    const entity = await this.entitiesRepo.get(projectId);
    if (!entity || entity.typeName !== PROJECT_TYPE_NAME) return null;
    const attrs = this.readAttrs(projectId);
    const status = attrs.get(STATUS_ATTR_KEY) ?? "active";
    return {
      projectId: entity.id,
      name: entity.name,
      summary: attrs.get(SUMMARY_ATTR_KEY) ?? null,
      // status 칸은 TEXT 무제약 — 도메인 입력 통로(이 클래스)가 ProjectStatus 로 검증한다.
      status: status as ProjectStatus,
      attributes: this.parseAttributes(attrs.get(ATTRIBUTES_JSON_ATTR_KEY)),
      embeddingText: attrs.get(EMBEDDING_TEXT_ATTR_KEY) ?? null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }

  /**
   * 이름으로 프로젝트를 찾거나 만든다(type_name='project' 안 name 유일성). 옛 행이
   * 있으면 그 행을 그대로 돌려주고(재사용 — 새 행 만들지 않음), 없으면 신규 prj_ 행을
   * 만든다(entitiesRepo 가 registry 접두사로 생성).
   *
   * 빈 이름은 entitiesRepo 가 throw. status 미지정이면 'active'. 잘못된 status 는 throw —
   * silent fallback 금지(Q1 — 외부 fork 가 상태값을 늘리려면 PROJECT_STATUSES 확장).
   *
   * 신규 생성일 때만 status·summary 칸을 채운다(재사용 행은 옛 속성을 그대로 둔다 —
   * 같은 이름 두 번째 호출이 옛 summary 를 덮지 않도록). 임베딩은 별도 단계
   * applyProjectEmbedding 이 채운다(행 생성과 벡터 적재 분리 — spec 3.3 부분 합류 정합).
   */
  async findOrCreateProject(args: CreateProjectArgs): Promise<Project> {
    const status = args.status ?? "active";
    this.assertStatus(status);

    // name 정규화(trim)·빈 이름 throw 는 entitiesRepo.findOrCreateEntity 가 한다.
    const trimmed = args.name.trim();
    const existing = trimmed
      ? await this.entitiesRepo.findByName(PROJECT_TYPE_NAME, trimmed)
      : null;

    const entity = await this.entitiesRepo.findOrCreateEntity(
      PROJECT_TYPE_NAME,
      args.name,
    );

    if (!existing) {
      // 신규 행 — status·summary 칸을 채운다(is_column=1 → 합성 색인 본문 합류).
      this.entitiesRepo.setAttribute(entity.id, STATUS_ATTR_KEY, status, true);
      if (args.summary != null) {
        this.entitiesRepo.setAttribute(
          entity.id,
          SUMMARY_ATTR_KEY,
          args.summary,
          true,
        );
      }
    }

    const project = await this.reassemble(entity.id);
    if (!project) {
      throw new Error(
        `findOrCreateProject: 방금 만든 프로젝트(${entity.id})를 다시 읽지 못했다`,
      );
    }
    return project;
  }

  /**
   * 프로젝트 부분 수정 — 지정한 칸(summary/status/attributes/embeddingText)만
   * entity_attributes 로 갱신하고 updated_at 을 현재 시각으로 새로 채운다. 미존재 id 면
   * null. 잘못된 status 는 throw — silent fallback 금지.
   *
   * status/summary/embeddingText 는 칸(is_column=1·검색 합류), attributes_json 은 라벨
   * (is_column=0·검색 비노출). 임베딩(entities_vec)은 이 메서드가 안 건드린다 —
   * summary/embeddingText 가 바뀌면 호출처가 이어서 applyProjectEmbedding 을 부른다.
   */
  async updateProject(
    projectId: string,
    fields: UpdateProjectArgs,
  ): Promise<Project | null> {
    const existing = await this.reassemble(projectId);
    if (!existing) return null;

    if (fields.status !== undefined) {
      this.assertStatus(fields.status);
      this.entitiesRepo.setAttribute(
        projectId,
        STATUS_ATTR_KEY,
        fields.status,
        true,
      );
    }
    if (fields.summary !== undefined) {
      // null 도 명시 삭제 의미로 빈 문자열 칸이 아니라 빈 값을 남긴다 — summary 없음을
      // 정직히 표현. entity_attributes 는 NOT NULL 이라 빈 문자열로 저장한다.
      this.entitiesRepo.setAttribute(
        projectId,
        SUMMARY_ATTR_KEY,
        fields.summary ?? "",
        true,
      );
    }
    if (fields.embeddingText !== undefined) {
      this.entitiesRepo.setAttribute(
        projectId,
        EMBEDDING_TEXT_ATTR_KEY,
        fields.embeddingText ?? "",
        true,
      );
    }
    if (fields.attributes !== undefined) {
      this.entitiesRepo.setAttribute(
        projectId,
        ATTRIBUTES_JSON_ATTR_KEY,
        JSON.stringify(fields.attributes),
        false,
      );
    }
    // 칸을 하나라도 바꾸면 setAttribute 가 그때마다 entities.updated_at 을 올리므로(단일
    // 출처·entities-repository) 여기서 또 올리지 않는다(이중 갱신 제거). 변경 칸이 0개인
    // 명시 호출만 손댄 사실로 보고 직접 updated_at 을 올린다(옛 동작 보존).
    if (Object.keys(fields).length === 0) {
      this.db
        .query("UPDATE entities SET updated_at = ? WHERE entity_id = ?")
        .run(nowKst(), projectId);
    }

    return this.reassemble(projectId);
  }

  async getProject(projectId: string): Promise<Project | null> {
    return this.reassemble(projectId);
  }

  async findProjectByName(name: string): Promise<Project | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const entity = await this.entitiesRepo.findByName(PROJECT_TYPE_NAME, trimmed);
    if (!entity) return null;
    return this.reassemble(entity.id);
  }

  /**
   * 프로젝트 본명 우선 → 별칭 단일 매칭 → 2건+ 모호로 조회한다(조회 전용).
   * 프로젝트 별칭은 범용 entitiesRepo 의 ko_aliases/en_aliases 칸을 단일 출처로 쓴다.
   */
  async findProjectByNameOrAlias(name: string): Promise<ProjectLookup> {
    const lookup = await this.entitiesRepo.findByNameOrAlias(PROJECT_TYPE_NAME, name);
    if (lookup.ambiguous) {
      if (lookup.candidates === undefined) {
        throw new Error(`findProjectByNameOrAlias: '${name}' 이 모호한데 후보 목록이 없다`);
      }
      return {
        project: null,
        ambiguous: true,
        candidates: lookup.candidates.map((e) => ({ projectId: e.id, name: e.name })),
      };
    }
    if (!lookup.entity) return { project: null, ambiguous: false };
    const project = await this.reassemble(lookup.entity.id);
    return { project, ambiguous: false };
  }

  /**
   * 프로젝트 목록 — status 필터(미지정 = 전체). 최근 갱신 순. limit 상한 5000.
   * 잘못된 status 필터는 throw — silent fallback 금지.
   *
   * entitiesRepo.list('project') 가 type_name='project' 행을 updated_at DESC 로
   * 돌려준다. status 필터는 각 행의 status 칸을 읽어 in-memory 로 거른다(프로젝트
   * 행 규모는 수십~수백이라 비용 무시 가능 — person 신원 스캔과 같은 양식).
   */
  async listProjects(
    options: { limit?: number; status?: ProjectStatus } = {},
  ): Promise<Project[]> {
    const limit = Math.min(options.limit ?? 1000, 5000);
    if (options.status !== undefined) {
      this.assertStatus(options.status);
    }
    const entities = await this.entitiesRepo.list(PROJECT_TYPE_NAME, { limit });
    const projects: Project[] = [];
    for (const e of entities) {
      const project = await this.reassemble(e.id);
      if (!project) continue;
      if (options.status && project.status !== options.status) continue;
      projects.push(project);
    }
    return projects;
  }

  /**
   * 요약 임베딩 적재 — entitiesRepo.applyEmbedding 으로 범용 색인 entities_vec 에
   * upsert 한다(옛 project_summary_vec 아님·단계4 T7'b). 합성 텍스트(name + ko_name +
   * 칸값)에 summary·embedding_text 가 칸으로 들어가 옛 "embedding_text → summary → name"
   * 우선순위가 합성 본문 합류로 보존된다(셋 다 색인에 들어감). 적재에 성공하면 true.
   *
   * 임베딩 모델이 없거나 throw 하면 그대로 throw 한다 — silent fallback 절대 금지.
   * 미존재 id·차원 불일치 모두 구체 에러 throw(entitiesRepo.applyEmbedding 가 가린다).
   */
  async applyProjectEmbedding(projectId: string): Promise<boolean> {
    return this.entitiesRepo.applyEmbedding(projectId);
  }

  /**
   * 프로젝트 → 개념(특성 라벨) 엣지 추가 — 범용 통합 테이블 entity_concept_edges
   * (entity_id 끝점·FK→entities)에 쓴다(단계4 T4·T7'b). INSERT OR IGNORE 라 같은
   * (project, concept, role) 중복은 silently ignore — 신규면 true, 중복이면 false.
   */
  async addProjectConceptEdge(
    projectId: string,
    conceptId: string,
    role: ProjectConceptRole,
    provenance: Provenance,
    sourceNodeId: number | null,
  ): Promise<boolean> {
    warnOnRelationPolicy("entity_concept_edges", "role", role);
    const result = this.db
      .query(
        `INSERT OR IGNORE INTO entity_concept_edges
           (entity_id, concept_id, role, provenance, source_node_id, weight, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(projectId, conceptId, role, provenance, sourceNodeId, nowKst());
    return result.changes > 0;
  }

  /**
   * 프로젝트의 참여자 목록 — entity_relation_edges(participated_by) 행을 도메인
   * 타입으로 돌려준다. 양방향 조회의 한쪽(프로젝트 → 사람). 행이 없으면 빈 배열.
   * role 은 통합 후 데이터에 없어 빈 문자열로 채운다 — "role 추적 안 함"의 정직한
   * 표현이다(사용자 결정·실패 위장 fallback 아님).
   */
  async listProjectParticipants(
    projectId: string,
  ): Promise<ProjectPersonEdge[]> {
    return listProjectParticipantEdges(this.db, {
      source: { kind: "project", id: projectId },
      target: { kind: "person" },
    }).map((r) => ({
      projectId: r.sourceId,
      personId: r.targetId,
      role: "",
      createdAt: r.createdAt,
    }));
  }

  /**
   * 한 사람이 참여한 프로젝트 목록 — entity_relation_edges(participated_by) 행을
   * 도메인 타입으로 돌려준다. 양방향 조회의 다른 쪽(사람 → 프로젝트). 없으면 빈 배열.
   * role 은 통합 후 데이터에 없어 빈 문자열로 채운다(위와 같은 정직한 표현).
   */
  async listPersonProjects(personId: string): Promise<ProjectPersonEdge[]> {
    return listProjectParticipantEdges(this.db, {
      source: { kind: "project" },
      target: { kind: "person", id: personId },
    }).map((r) => ({
      projectId: r.sourceId,
      personId: r.targetId,
      role: "",
      createdAt: r.createdAt,
    }));
  }

  /**
   * 프로젝트의 개념(특성 라벨) 목록 — 범용 통합 entity_concept_edges 행을 도메인
   * 타입으로 돌려준다(단계4 T7'b). 행이 없으면 빈 배열.
   */
  async listProjectConcepts(
    projectId: string,
  ): Promise<ProjectConceptEdge[]> {
    return listProjectConceptEdges(this.db, {
      source: { kind: "project", id: projectId },
    });
  }

  /**
   * 한 개념에 이어진 프로젝트 목록 — 개념 → 프로젝트 역방향(읽기 전용·SELECT 만).
   *
   * 범용 통합 entity_concept_edges(concept_id = conceptId)를 entities 와 JOIN 해
   * type_name='project' 끝점만 거른다(통합 테이블은 종류를 안 담아 JOIN 으로 가른다 —
   * getEntitiesByConcept 양식 미러·단계4 T7'b). role 을 주면 그 role 만, 미지정이면
   * classification/tag 전체. 행이 없으면 빈 배열(정직한 빈 상태 — 서비스 실패가 아님).
   *
   * 쓰기 0 / 스키마 변경 0 — graph.ts Task 9 가 프로젝트 노드를 합류시킬 때 쓴다.
   */
  getProjectsByConceptId(
    conceptId: string,
    role?: string,
  ): Array<{ projectId: string; role: string }> {
    return listProjectConceptEdges(this.db, {
      source: { kind: PROJECT_TYPE_NAME },
      target: { kind: "concept", id: conceptId },
      role,
    }).map((r) => ({ projectId: r.projectId, role: r.role }));
  }
}

function listProjectConceptEdges(
  db: Database,
  filter: {
    source: { kind: "project"; id?: string };
    target?: { kind: "concept"; id?: string };
    role?: string;
  },
): ProjectConceptEdge[] {
  return listRelationEdges(db, {
    tableName: "entity_concept_edges",
    source: filter.source,
    target: filter.target,
    relation: filter.role,
  })
    .map((edge) => ({
      projectId: edge.sourceId,
      conceptId: edge.targetId,
      role: edge.relation as ProjectConceptRole,
      createdAt: edge.createdAt ?? "",
    }))
    .sort((a, b) => {
      const byCreated = a.createdAt.localeCompare(b.createdAt);
      if (byCreated !== 0) return byCreated;
      const byProject = a.projectId.localeCompare(b.projectId);
      if (byProject !== 0) return byProject;
      const byConcept = a.conceptId.localeCompare(b.conceptId);
      if (byConcept !== 0) return byConcept;
      return a.role.localeCompare(b.role);
    });
}

function listProjectParticipantEdges(
  db: Database,
  filter: {
    source: { kind: "project"; id?: string };
    target: { kind: "person"; id?: string };
  },
): Array<{
  sourceId: string;
  targetId: string;
  createdAt: string;
}> {
  return listRelationEdges(db, {
    tableName: "entity_relation_edges",
    relation: "participated_by",
    source: filter.source,
    target: filter.target,
  })
    .map((edge) => ({
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      createdAt: edge.createdAt ?? "",
    }))
    .sort((a, b) => {
      const byCreated = a.createdAt.localeCompare(b.createdAt);
      if (byCreated !== 0) return byCreated;
      const bySource = a.sourceId.localeCompare(b.sourceId);
      if (bySource !== 0) return bySource;
      return a.targetId.localeCompare(b.targetId);
    });
}
