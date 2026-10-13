/**
 * server-internal/routes/projects.ts — /projects 계열 라우트 등록기 (공통 인프라 1.2 T11).
 *
 * 프로젝트 1급 엔티티의 REST 통로를 기존 라우터 facade 양식(registerMemoriesRoutes)으로
 * 모은다. 일곱 라우트:
 *   POST  /projects                  — 표지 생성·수정(name UNIQUE 충돌 시 기존 재활용) +
 *                                       embedding_text 채움 + 요약 임베딩 적재
 *   GET   /projects                  — 목록(status 필터)
 *   GET   /projects/preset-concepts  — 분류 키별 기존 값 후보(usage count 순 / read-only)
 *   GET   /projects/:id              — 상세(라벨 + 참여자 포함)
 *   POST  /projects/:id/concepts     — `#분류:값` 라벨 파싱 → 개념 연결(classification+tag)
 *   POST  /projects/:id/participants — {personId, role} 참여자 연결
 *   POST  /projects/:id/documents    — {nodeId} 문서(메모리)를 프로젝트로 묶기
 *
 * 절대 제약:
 *   1. 등록 순서 — 구체 경로(`/projects`, `/projects/preset-concepts`)가 `/projects/:id`
 *      보다 먼저 와야 한다. Hono 는 등록 순서대로 매칭하므로 `:id` 가 먼저면
 *      "preset-concepts" 를 id 로 받아 404 로 떨어진다(memories.ts 의 by-source < :id 선례).
 *   2. 임베딩 미가용 정직 — 표지 저장 시 applyProjectEmbedding 이 throw 하면(임베더 없음·
 *      차원 불일치) 프로젝트 행(글자·연결)은 살리고 응답에 `embeddingSkipped: true` +
 *      까닭을 명시한다. 가짜 벡터를 만들지 않고 silent fallback 도 하지 않는다(spec 3.3 /
 *      disabled-state 정직).
 *   3. store facade 만 호출 — 라우트는 body 검증 + store 위임 + 응답 조립만 한다.
 *      DB 접근은 SqliteMemoryStore facade 단일 권위(직접 SQL 금지).
 */

import { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { isPositiveString, parseIntParam, parseLimit, err } from "../http-helpers.ts";
import { parseHashtagEntities } from "../../memory/parsers/hashtag-entity-parser.ts";
import { reflowFlatParentTags, REFLOW_TRIGGER_LABEL } from "../../memory/tag-reflow.ts";
import type { Project, ProjectStatus } from "../../memory/types.ts";

/** 허용 status 값 — ProjectRepository.PROJECT_STATUSES 와 같은 단일 출처 정신. */
const PROJECT_STATUSES: readonly ProjectStatus[] = ["active", "done", "paused"];

/** 문자열이 허용 status 멤버인지 검사하는 type guard(라우트 입구 검증용). */
function isProjectStatus(value: unknown): value is ProjectStatus {
  return (
    typeof value === "string" &&
    (PROJECT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Project 도메인 객체를 응답 JSON 형태로 직렬화한다. createdAt/updatedAt·attributes 까지
 * 그대로 노출 — attributes 는 검색에는 안 쓰이지만 상세 표시·외부 fork 용도라 포함한다.
 */
function projectToJson(p: Project): Record<string, unknown> {
  return {
    projectId: p.projectId,
    name: p.name,
    summary: p.summary,
    status: p.status,
    attributes: p.attributes,
    embeddingText: p.embeddingText,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/**
 * /projects 계열 라우트를 app 에 등록한다.
 *
 * deps 객체 자체를 받는다(registerMemoriesRoutes 양식). store 만 부팅 시점 고정
 * 의존이라 구조분해한다. getSettings 같은 나중-mutate 의존은 호출 시점에 deps.xxx 로
 * lookup 하지만 이 라우트들은 store 만 쓴다.
 */
export function registerProjectsRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps;

  // ── POST /projects — 표지 생성·수정 + 요약 임베딩 ─────────────────────────
  //
  // body: { name(필수), summary?, status?, attributes?, embeddingText? }
  // name UNIQUE 충돌 시 findOrCreateProject 가 기존 행을 재활용한다(새 행 0).
  // summary/status/attributes/embeddingText 가 들어오면 그 위에 updateProject 로
  // 덮어쓴다 — "생성·수정" 한 통로(같은 이름 재호출 = 수정).
  //
  // 임베딩 적재(applyProjectEmbedding)는 행 저장과 *분리*된 단계다(spec 3.3 부분 합류).
  // 임베더가 없거나 차원이 어긋나 throw 하면, 행(글자·연결)은 이미 저장됐으므로 그대로
  // 두고 응답에 embeddingSkipped: true + 까닭을 실어 정직하게 드러낸다. 가짜 벡터를
  // 만들거나 빈 성공을 위장하지 않는다.
  app.post("/projects", async (c) => {
    let body: {
      name?: unknown;
      summary?: unknown;
      status?: unknown;
      attributes?: unknown;
      embeddingText?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (!isPositiveString(body.name)) {
      return err(c, 400, "name must be a non-empty string");
    }
    if (body.status !== undefined && !isProjectStatus(body.status)) {
      return err(
        c,
        400,
        `status must be one of: ${PROJECT_STATUSES.join(", ")}`,
      );
    }

    const summary =
      typeof body.summary === "string" ? body.summary : undefined;
    const embeddingText =
      typeof body.embeddingText === "string" ? body.embeddingText : undefined;
    const attributes =
      body.attributes &&
      typeof body.attributes === "object" &&
      !Array.isArray(body.attributes)
        ? (body.attributes as Record<string, unknown>)
        : undefined;
    const status = isProjectStatus(body.status) ? body.status : undefined;

    let project: Project;
    try {
      // 이름으로 찾거나 만든다(name UNIQUE 충돌 = 기존 재활용). status 는 신규 생성
      // 시점 초기값 — 이미 있던 행이면 아래 updateProject 가 status 갱신을 맡는다.
      project = await store.findOrCreateProject({
        name: body.name.trim(),
        summary: summary ?? null,
        status: status ?? "active",
      });

      // summary/status/attributes/embeddingText 중 하나라도 들어왔으면 그 위에 덮어쓴다.
      // 기존 행 재활용 경로에서도 새 입력으로 갱신되도록(같은 이름 재호출 = 수정).
      const hasUpdate =
        summary !== undefined ||
        status !== undefined ||
        attributes !== undefined ||
        embeddingText !== undefined;
      if (hasUpdate) {
        const updated = await store.updateProject(project.projectId, {
          ...(summary !== undefined ? { summary } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(attributes !== undefined ? { attributes } : {}),
          ...(embeddingText !== undefined ? { embeddingText } : {}),
        });
        if (updated) project = updated;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(c, 500, `프로젝트 저장 실패: ${msg}`);
    }

    // 요약 임베딩 적재 — 행 저장과 분리된 단계(spec 3.3). 임베더 미가용·차원 불일치로
    // throw 하면 행은 이미 저장됐으므로 그대로 두고 정직하게 skip 신호를 올린다.
    let embeddingSkipped = false;
    let embeddingSkipReason: string | null = null;
    try {
      await store.applyProjectEmbedding(project.projectId);
    } catch (e) {
      embeddingSkipped = true;
      embeddingSkipReason = e instanceof Error ? e.message : String(e);
    }

    return c.json(
      {
        project: projectToJson(project),
        embeddingSkipped,
        // skip 이 아니면 null — 가짜 까닭을 지어내지 않는다(정직).
        embeddingSkipReason,
      },
      201,
    );
  });

  // ── GET /projects — 목록(status 필터) ─────────────────────────────────────
  // Query: ?status=active|done|paused (옵션), ?limit=N (1..5000, default 100).
  // 잘못된 status 값은 400(silent 무시 안 함 — 입력 실수를 정직하게 알린다).
  app.get("/projects", async (c) => {
    const statusRaw = c.req.query("status");
    if (statusRaw !== undefined && !isProjectStatus(statusRaw)) {
      return err(
        c,
        400,
        `status must be one of: ${PROJECT_STATUSES.join(", ")}`,
      );
    }
    const limit = parseLimit(c.req.query("limit"), 100, 5000);
    const projects = await store.listProjects({
      ...(isProjectStatus(statusRaw) ? { status: statusRaw } : {}),
      limit,
    });
    return c.json({
      count: projects.length,
      projects: projects.map(projectToJson),
    });
  });

  // ── GET /projects/preset-concepts?key=참여자 — 프리셋 후보(read-only) ───────
  //
  // 분류 키(예: "참여자") 밑에 든 기존 값 개념을, *프로젝트 라벨로 쓰인 횟수* 내림차순으로
  // 내려준다(spec 3.5 토대 / Q13). 전용 저장 테이블 없이 기존 개념·프로젝트 데이터를
  // 그대로 읽는다:
  //   1. 키 개념을 이름으로 찾는다(findConceptByName). 없으면 빈 후보(정직한 빈 — 그
  //      키로 라벨한 적이 없으니 추천할 값도 없다).
  //   2. 키 개념의 parent_of 자식(값 개념)을 모은다(getHierarchyDirectChildren · S0-T4).
  //   3. 각 값 개념이 project_concept_edges 로 쓰인 프로젝트 수를 센다(usageCount).
  //      listProjects + listProjectConcepts 합성 — 라우트 계층 집계라 store 신규 메서드 0.
  //   4. usageCount 내림차순, 동률은 이름 오름차순으로 정렬해 회신.
  //
  // 등록 순서 주의: `/projects/:id` 보다 *먼저* 와야 한다 — 뒤에 두면 `:id` 매처가
  // "preset-concepts" 를 프로젝트 id 로 받아 404 로 떨어진다.
  app.get("/projects/preset-concepts", async (c) => {
    const key = c.req.query("key");
    if (!isPositiveString(key)) {
      return err(c, 400, "key query parameter is required");
    }

    // 1) 분류 키 개념 — 없으면 추천 후보도 없다(정직한 빈 목록).
    const keyConcept = await store.findConceptByName(key.trim());
    if (!keyConcept) {
      return c.json({ key: key.trim(), presets: [] });
    }

    // 2) 키 개념의 parent_of 자식(값 개념) id 목록. S0-T4(위계 단일 출처) — 옛
    //    getConceptNeighbors(concept_edges) 양방향 이웃에서 키가 source 인 parent_of
    //    만 거르던 것을 hierarchy_edges 직접 자식 조회로 바꾼다(getHierarchyDirectChildren
    //    이 source = 키인 parent_of target 들을 그대로 회신).
    const valueConceptIds = store.getHierarchyDirectChildren(keyConcept.conceptId);

    if (valueConceptIds.length === 0) {
      return c.json({ key: key.trim(), presets: [] });
    }

    // 3) 각 값 개념이 프로젝트 라벨로 쓰인 횟수(usageCount) — 전 프로젝트의
    //    project_concept_edges 를 모아 concept_id 별로 센다. 라우트 계층 집계(read-only).
    //    이 키의 값 후보(valueConceptIds)만 0 으로 미리 깔아 두고, 그 집합에 든 개념만
    //    센다(다른 키의 라벨은 has 체크가 자연히 거른다). 한 프로젝트가 같은 값을
    //    classification·tag 두 role 로 가져도 라벨 1개로 세려고 프로젝트별 distinct 로 본다.
    const usage = new Map<string, number>();
    for (const id of valueConceptIds) usage.set(id, 0);

    const projects = await store.listProjects({ limit: 5000 });
    for (const p of projects) {
      const edges = await store.listProjectConcepts(p.projectId);
      const countedInThisProject = new Set<string>();
      for (const edge of edges) {
        if (!usage.has(edge.conceptId)) continue; // 이 키 후보 아님 — 세지 않는다.
        if (countedInThisProject.has(edge.conceptId)) continue; // 같은 프로젝트 중복 1회만.
        countedInThisProject.add(edge.conceptId);
        usage.set(edge.conceptId, usage.get(edge.conceptId)! + 1);
      }
    }

    // 4) 값 개념 이름을 보강하고 usageCount 내림차순 + 이름 오름차순으로 정렬.
    const presets = await Promise.all(
      valueConceptIds.map(async (id) => {
        const concept = await store.getConcept(id);
        return {
          conceptId: id,
          // 흡수·삭제로 사라진 개념은 빈 이름(정직 — 가짜 이름 안 만든다).
          name: concept?.name ?? "",
          usageCount: usage.get(id) ?? 0,
        };
      }),
    );
    presets.sort((a, b) => {
      if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
      return a.name.localeCompare(b.name);
    });

    return c.json({ key: key.trim(), presets });
  });

  // ── GET /projects/:id — 상세(라벨 + 참여자 포함) ──────────────────────────
  // 없는 id 는 404(빈 상세 위장 안 함 — silent fallback 금지). 라벨·참여자가 0건이면
  // 빈 배열(정직한 빈 표시 — 그 프로젝트에 아직 연결이 없다는 진짜 빈 상태).
  app.get("/projects/:id", async (c) => {
    const id = c.req.param("id");
    const project = await store.getProject(id);
    if (!project) return err(c, 404, `project not found: ${id}`);

    const concepts = await store.listProjectConcepts(id);
    const participants = await store.listProjectParticipants(id);

    // 라벨 개념 이름 보강 — 표시 측이 conceptId 대신 사람이 읽을 이름을 쓰도록.
    const labels = await Promise.all(
      concepts.map(async (edge) => {
        const concept = await store.getConcept(edge.conceptId);
        return {
          conceptId: edge.conceptId,
          name: concept?.name ?? "",
          role: edge.role,
          createdAt: edge.createdAt,
        };
      }),
    );

    return c.json({
      project: projectToJson(project),
      labels,
      participants: participants.map((p) => ({
        personId: p.personId,
        role: p.role,
        createdAt: p.createdAt,
      })),
    });
  });

  // ── POST /projects/:id/concepts — `#분류:값` 라벨 추가 ─────────────────────
  //
  // body: { text } — `#참여자:철수` 같은 해시태그 규칙 입력. hashtag-entity-parser
  // 의 라벨 갈래(예약 키 아님 → labels)로 `#분류:값` 을 뽑고, 각 라벨마다:
  //   - 값 개념을 findOrCreate(isClassificationValue) 하고 프로젝트에 두 role(classification
  //     AND tag)로 연결한다(Q4 — 같은 라벨을 분류·손 태그 두 양식으로 동시에 잇는다).
  //   - 분류 키 개념도 findOrCreate(isClassificationKey) 하고 키 → 값 parent_of 위계를
  //     만들어, preset-concepts 가 키별 값 후보를 찾을 토대를 둔다(addClassificationTag
  //     과 같은 위계 양식).
  //
  // 라벨이 0건이면(파싱 결과 labels 빈) 400 — 라벨을 못 뽑은 입력은 실패로 정직하게
  // 알린다(빈 성공 위장 금지). 파서가 errors 를 올리면 그것도 응답에 실어 드러낸다.
  app.post("/projects/:id/concepts", async (c) => {
    const id = c.req.param("id");
    const project = await store.getProject(id);
    if (!project) return err(c, 404, `project not found: ${id}`);

    let body: { text?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }
    if (!isPositiveString(body.text)) {
      return err(c, 400, "text must be a non-empty string");
    }

    const parsed = parseHashtagEntities(body.text);
    if (parsed.labels.length === 0) {
      return err(
        c,
        400,
        "no `#분류:값` label found in text (예: #참여자:철수)",
      );
    }

    const added: {
      category: string;
      value: string;
      conceptId: string;
      classificationAdded: boolean;
      tagAdded: boolean;
    }[] = [];

    for (const label of parsed.labels) {
      // 키 개념(분류 키) + 값 개념(분류 값) — addClassificationTag 와 같은 역할 플래그.
      const keyConceptId = await store.findOrCreateConcept(label.category, {
        isClassificationKey: true,
      });
      const valueConceptId = await store.findOrCreateConcept(label.value, {
        isClassificationValue: true,
      });
      // 키 → 값 parent_of 위계 — preset-concepts 가 키별 값 후보를 찾는 토대.
      // S0-T4(위계 단일 출처) — 옛 concept_edges 가 아니라 hierarchy_edges 에 쓴다.
      const hierarchy = store.addReducedHierarchyEdge({
        sourceType: "concept",
        sourceId: keyConceptId,
        targetType: "concept",
        targetId: valueConceptId,
        provenance: "user_input",
        sourceNodeId: null,
        // 콜론 라벨은 사용자의 명시 선언이라 추측이 아닌 확정 강도 0.9 로 시작한다.
        weight: 0.9,
      });
      // 위계 선언 직후 과거 평평 글 자동 재정리(spec §4.2.3 B3 — 검토 게이트 없음).
      // 상위 실패(findFlatParentTagNodes DB 오류 등) 격리 — 자동 정리가 깨져도 라벨 등록
      // 자체는 성공 응답한다(글 단위 격리와 같은 정신, silent 아님 / §4.2.4).
      if (!hierarchy.skippedAsShortcut) {
        try {
          await reflowFlatParentTags(store, keyConceptId, valueConceptId, REFLOW_TRIGGER_LABEL);
        } catch (err) {
          console.warn(
            `[projects label reflow] 자동 재정리 실패 — 라벨 등록은 유지 ` +
              `(parent ${keyConceptId}, label ${label.category}:${label.value}): ${String(err)}`,
          );
        }
      }
      // 프로젝트에 두 role 로 연결(Q4 — classification AND tag).
      const classificationAdded = await store.addProjectConceptEdge(
        project.projectId,
        valueConceptId,
        "classification",
        "user_input",
        null,
      );
      const tagAdded = await store.addProjectConceptEdge(
        project.projectId,
        valueConceptId,
        "tag",
        "user_input",
        null,
      );
      added.push({
        category: label.category,
        value: label.value,
        conceptId: valueConceptId,
        classificationAdded,
        tagAdded,
      });
    }

    return c.json(
      {
        projectId: project.projectId,
        added,
        // 파싱 실패(`#생일:` 처럼 값 빈 예약 키)도 정직하게 드러낸다.
        errors: parsed.errors,
      },
      201,
    );
  });

  // ── POST /projects/:id/participants — 참여자(사람) 연결 ────────────────────
  // body: { personId, role } — personId(psn_)·role(creator/participant 등 자유 문자열).
  // 없는 사람 id 는 404(존재 검증). 중복 (project, person, role) 은 added: false 로 정직.
  app.post("/projects/:id/participants", async (c) => {
    const id = c.req.param("id");
    const project = await store.getProject(id);
    if (!project) return err(c, 404, `project not found: ${id}`);

    let body: { personId?: unknown; role?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }
    if (!isPositiveString(body.personId)) {
      return err(c, 400, "personId must be a non-empty string");
    }
    if (!isPositiveString(body.role)) {
      return err(c, 400, "role must be a non-empty string");
    }

    // 사람이 실제로 있는지 확인 — 없는 사람을 잇는 요청은 호출처 실수다(404 로 정직).
    const person = await store.getPerson(body.personId.trim());
    if (!person) {
      return err(c, 404, `person not found: ${body.personId}`);
    }

    const added = await store.addProjectPersonEdge(
      project.projectId,
      person.personId,
      body.role.trim(),
      "user_input",
      null,
    );
    return c.json(
      {
        projectId: project.projectId,
        personId: person.personId,
        role: body.role.trim(),
        added,
      },
      201,
    );
  });

  // ── POST /projects/:id/documents — 문서(메모리)를 프로젝트로 묶기 ──────────
  //
  // body: { nodeId } — knowledge_nodes.project_id 칸을 이 프로젝트로 채운다(spec 3.2).
  // PATCH /memories/:id/project 대신 POST /projects/:id/documents 를 고른 까닭: 프로젝트
  // 라우트군 안에 표지·라벨·참여자와 *한데* 모여 응집도가 높고, "프로젝트에
  // 문서를 더한다" 는 동작 의미가 경로에 그대로 드러난다. 없는 nodeId 는 404(존재 검증).
  app.post("/projects/:id/documents", async (c) => {
    const id = c.req.param("id");
    const project = await store.getProject(id);
    if (!project) return err(c, 404, `project not found: ${id}`);

    let body: { nodeId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }
    const nodeId = parseIntParam(
      typeof body.nodeId === "number" ? String(body.nodeId) : (body.nodeId as string | undefined),
    );
    if (nodeId === null) {
      return err(c, 400, "nodeId must be a positive integer");
    }

    // 노드가 실제로 있는지 확인 — 없는 노드를 묶는 요청은 호출처 실수다(404 로 정직).
    const node = await store.getNode(nodeId);
    if (!node) {
      return err(c, 404, `memory node not found: ${nodeId}`);
    }

    await store.setNodeProjectId(nodeId, project.projectId);
    return c.json(
      {
        projectId: project.projectId,
        nodeId,
      },
      201,
    );
  });
}
