/**
 * projects.test.ts — 공통 인프라 1.2 T11: 프로젝트 REST 통로 통합 검증.
 *
 * 설계 권위 = docs/decisions/2026-06-05-common-infra-1.2-spec(공통 인프라 1.2 프로젝트
 * 엔티티 테이블).md §3.2~3.5, plan(2026-06-06) Task 11.
 *
 * registerProjectsRoutes 가 붙이는 일곱 라우트를 실 DB + 실 임베더로 검증한다:
 *   - POST  /projects                  표지 생성·수정(name UNIQUE 충돌 = 기존 재활용)
 *   - GET   /projects                  목록(status 필터)
 *   - GET   /projects/preset-concepts  분류 키별 값 후보(usage count 순 / read-only)
 *   - GET   /projects/:id              상세(라벨 + 참여자)
 *   - POST  /projects/:id/concepts     `#분류:값` 라벨(classification+tag 두 role)
 *   - POST  /projects/:id/participants 참여자 연결
 *   - POST  /projects/:id/documents    문서(메모리) 묶기(project_id 칸)
 *
 * 임베딩 미가용 정직(spec 3.3): applyProjectEmbedding 이 throw 하면 행은 살리고
 * embeddingSkipped: true 로 정직하게 드러낸다 — 가짜 벡터·빈 성공 위장 금지. 이 갈래는
 * *실제로 throw 하는 실 Embedder*(임베더 로드 실패를 흉내내는 실패 주입 하네스)로 검증한다.
 * 가짜 데이터를 들고 있는 mock 이 아니라 실패 경로만 강제하는 실 인터페이스다.
 *
 * 라우트 등록 순서(함정 4): /projects/preset-concepts 가 /projects/:id 보다 먼저 등록돼야
 * "preset-concepts" 가 프로젝트 id 로 빨려 404 가 되지 않는다 — 그 점을 직접 검증한다.
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder. mock 0(데이터 fixture·실패 주입만). 운영 DB 비접근.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import type { Embedder } from "../../embedding/types.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

/** 실 임베더 하네스 — 보통 검증용(임베딩 정상 적재). */
function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

/**
 * 임베더 로드 실패를 흉내내는 실 Embedder — embed 호출 시 throw 한다. 가짜 *데이터*
 * 를 들고 있지 않다(빈 배열·default 벡터를 만들지 않음). spec 3.3 의 "임베딩 미가용 =
 * 행은 살리고 정직하게 skip" 경로를 강제하는 실패 주입 하네스다. dimension 은 실
 * 임베더와 같게 둬, 차원 불일치가 아니라 embed 자체가 throw 하는 경로를 본다.
 */
class FailingEmbedder implements Embedder {
  readonly dimension: number;
  constructor(dimension: number) {
    this.dimension = dimension;
  }
  async load(): Promise<void> {}
  async embed(): Promise<Float32Array> {
    throw new Error("embedder unavailable (load failed)");
  }
  async embedBatch(): Promise<Float32Array[]> {
    throw new Error("embedder unavailable (load failed)");
  }
}

/** 임베더가 throw 하는 하네스 — POST /projects 임베딩 skip 경로 전용. */
function makeFailingEmbedHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const failing = new FailingEmbedder(embedder.dimension);
  const store = new SqliteMemoryStore(db, failing);
  const retriever = new HybridRetriever(store, failing);
  const assembler = new ContextAssembler();
  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

async function postJson(
  app: Hono,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function getJson(
  app: Hono,
  path: string,
): Promise<{ status: number; body: any }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
}

describe("POST /projects — 표지 생성·수정 (Task 11)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("생성 → GET /projects/:id 상세 조회로 이어진다", async () => {
    const created = await postJson(h.app, "/projects", {
      name: "바라 메모리 모듈",
      summary: "어디든 붙는 메모리",
    });
    expect(created.status).toBe(201);
    expect(created.body.project.projectId.startsWith("prj_")).toBe(true);
    expect(created.body.project.name).toBe("바라 메모리 모듈");
    expect(created.body.project.status).toBe("active");
    expect(created.body.embeddingSkipped).toBe(false);

    const projectId = created.body.project.projectId;
    const detail = await getJson(h.app, `/projects/${projectId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.project.summary).toBe("어디든 붙는 메모리");
    // 라벨·참여자 0건이면 빈 배열(정직한 빈 표시).
    expect(detail.body.labels).toEqual([]);
    expect(detail.body.participants).toEqual([]);
  });

  test("같은 이름 재호출 = 같은 행 재활용 + 수정(name UNIQUE 충돌)", async () => {
    const first = await postJson(h.app, "/projects", {
      name: "재활용 대상",
      summary: "처음 요약",
    });
    const second = await postJson(h.app, "/projects", {
      name: "재활용 대상",
      summary: "고친 요약",
      status: "done",
    });
    // 같은 프로젝트 id — 새 행이 생기지 않는다.
    expect(second.body.project.projectId).toBe(first.body.project.projectId);
    // 재호출이 summary·status 를 덮어쓴다(생성·수정 한 통로).
    expect(second.body.project.summary).toBe("고친 요약");
    expect(second.body.project.status).toBe("done");

    // 목록에 한 행만 있어야 한다(재활용 확인).
    const list = await getJson(h.app, "/projects");
    expect(list.body.count).toBe(1);
  });

  test("빈 name = 400 / 잘못된 status = 400 (정직한 입력 검증)", async () => {
    const noName = await postJson(h.app, "/projects", { name: "  " });
    expect(noName.status).toBe(400);

    const badStatus = await postJson(h.app, "/projects", {
      name: "상태값 검증",
      status: "archived",
    });
    expect(badStatus.status).toBe(400);
  });

  test("임베더 미가용 = 행은 살리고 embeddingSkipped: true (가짜 벡터 금지)", async () => {
    const fh = makeFailingEmbedHarness();
    try {
      const created = await postJson(fh.app, "/projects", {
        name: "임베딩 미가용",
        summary: "임베더가 throw 해도 행은 산다",
      });
      // 행 자체는 저장됐다(글자·연결만 등록).
      expect(created.status).toBe(201);
      expect(created.body.project.name).toBe("임베딩 미가용");
      // 정직한 skip 신호 — 가짜 성공 위장 없이 까닭까지 노출.
      expect(created.body.embeddingSkipped).toBe(true);
      expect(typeof created.body.embeddingSkipReason).toBe("string");
      expect(created.body.embeddingSkipReason.length).toBeGreaterThan(0);

      // GET 상세도 그대로 회신된다(행이 진짜 살아 있다).
      const detail = await getJson(
        fh.app,
        `/projects/${created.body.project.projectId}`,
      );
      expect(detail.status).toBe(200);
      expect(detail.body.project.name).toBe("임베딩 미가용");
    } finally {
      fh.db.close();
    }
  });
});

describe("GET /projects — 목록(status 필터) (Task 11)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("status 필터가 그 상태만 거른다 + 잘못된 status = 400", async () => {
    await postJson(h.app, "/projects", { name: "활성 1", status: "active" });
    await postJson(h.app, "/projects", { name: "완료 1", status: "done" });

    const doneOnly = await getJson(h.app, "/projects?status=done");
    expect(doneOnly.status).toBe(200);
    expect(doneOnly.body.projects.map((p: any) => p.name)).toEqual(["완료 1"]);

    const all = await getJson(h.app, "/projects");
    expect(all.body.count).toBe(2);

    const bad = await getJson(h.app, "/projects?status=zzz");
    expect(bad.status).toBe(400);
  });
});

describe("POST /projects/:id/concepts — `#분류:값` 라벨 (Task 11)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("라벨이 classification + tag 두 role 로 연결된다(Q4)", async () => {
    const created = await postJson(h.app, "/projects", { name: "라벨 대상" });
    const projectId = created.body.project.projectId;

    const labeled = await postJson(h.app, `/projects/${projectId}/concepts`, {
      text: "#참여자:철수",
    });
    expect(labeled.status).toBe(201);
    expect(labeled.body.added.length).toBe(1);
    expect(labeled.body.added[0].category).toBe("참여자");
    expect(labeled.body.added[0].value).toBe("철수");
    // 같은 개념이 classification·tag 두 role 로 새로 연결된다.
    expect(labeled.body.added[0].classificationAdded).toBe(true);
    expect(labeled.body.added[0].tagAdded).toBe(true);

    // 상세 라벨 목록에 두 role 행이 모두 보인다.
    const detail = await getJson(h.app, `/projects/${projectId}`);
    const roles = detail.body.labels
      .map((l: any) => l.role)
      .sort();
    expect(roles).toEqual(["classification", "tag"]);
    const edgeRows = h.db
      .query<{ role: string; provenance: string; source_node_id: number | null }, [string]>(
        `SELECT role, provenance, source_node_id
           FROM entity_concept_edges
          WHERE entity_id=?
          ORDER BY role`,
      )
      .all(projectId);
    expect(edgeRows).toEqual([
      { role: "classification", provenance: "user_input", source_node_id: null },
      { role: "tag", provenance: "user_input", source_node_id: null },
    ]);
    // 라벨 이름이 보강된다(concept name 저장 양식).
    expect(detail.body.labels[0].name).toBe("철수");
  });

  test("라벨 없는 입력 = 400(빈 성공 위장 금지)", async () => {
    const created = await postJson(h.app, "/projects", { name: "빈 라벨" });
    const projectId = created.body.project.projectId;
    const res = await postJson(h.app, `/projects/${projectId}/concepts`, {
      text: "그냥 평범한 글, 분류 태그가 없다",
    });
    expect(res.status).toBe(400);
  });

  test("없는 프로젝트 id = 404", async () => {
    const res = await postJson(h.app, "/projects/prj_nope/concepts", {
      text: "#참여자:민수",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /projects/:id/participants — 참여자 연결 (Task 11)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("사람 연결 후 상세 participants 에 보인다 + 중복은 added: false", async () => {
    const created = await postJson(h.app, "/projects", { name: "참여자 대상" });
    const projectId = created.body.project.projectId;
    const person = await h.store.findOrCreatePerson({
      displayName: "타니아",
      userId: "u-001",
      source: "discord",
    });

    const linked = await postJson(
      h.app,
      `/projects/${projectId}/participants`,
      { personId: person.personId, role: "creator" },
    );
    expect(linked.status).toBe(201);
    expect(linked.body.added).toBe(true);

    const detail = await getJson(h.app, `/projects/${projectId}`);
    expect(detail.body.participants.map((p: any) => p.personId)).toEqual([
      person.personId,
    ]);
    // role 은 통합(S2/S3) 후 추적하지 않는다 — 입력 role 을 받아도 응답은 빈
    // 문자열로 채운다(plan §6 default (a)·사용자 결정). "role 을 받지만 버린다"를
    // 정직하게 검사한다.
    expect(detail.body.participants[0].role).toBe("");

    // 같은 (project, person, role) 재연결은 added: false(정직).
    const again = await postJson(
      h.app,
      `/projects/${projectId}/participants`,
      { personId: person.personId, role: "creator" },
    );
    expect(again.body.added).toBe(false);
  });

  test("없는 사람 id = 404(존재 검증)", async () => {
    const created = await postJson(h.app, "/projects", { name: "없는 사람" });
    const projectId = created.body.project.projectId;
    const res = await postJson(h.app, `/projects/${projectId}/participants`, {
      personId: "psn_nope",
      role: "participant",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /projects/:id/documents — 문서 묶기 (Task 11)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("nodeId 를 프로젝트로 묶으면 knowledge_nodes.project_id 가 채워진다", async () => {
    const created = await postJson(h.app, "/projects", { name: "문서 연결 대상" });
    const projectId = created.body.project.projectId;
    const nodeId = await h.store.addNode({
      content: "이 글은 프로젝트에 묶일 문서다",
      sourceType: "auto_capture",
    });

    const grouped = await postJson(
      h.app,
      `/projects/${projectId}/documents`,
      { nodeId },
    );
    expect(grouped.status).toBe(201);
    expect(grouped.body.nodeId).toBe(nodeId);

    // project_id 칸이 실제로 채워졌는지 직접 확인.
    const row = h.db
      .prepare("SELECT project_id FROM knowledge_nodes WHERE id = ?")
      .get(nodeId) as { project_id: string | null };
    expect(row.project_id).toBe(projectId);
  });

  test("없는 nodeId = 404(존재 검증)", async () => {
    const created = await postJson(h.app, "/projects", { name: "없는 노드" });
    const projectId = created.body.project.projectId;
    const res = await postJson(h.app, `/projects/${projectId}/documents`, {
      nodeId: 999999,
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /projects/preset-concepts — 프리셋 후보(read-only) (Task 11)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("분류 키별 값 후보가 usage count 내림차순으로 회신된다", async () => {
    // 프로젝트 두 개가 #참여자:철수, 하나가 #참여자:민수 를 라벨로 단다.
    const p1 = (await postJson(h.app, "/projects", { name: "프로젝트 A" })).body
      .project.projectId;
    const p2 = (await postJson(h.app, "/projects", { name: "프로젝트 B" })).body
      .project.projectId;
    const p3 = (await postJson(h.app, "/projects", { name: "프로젝트 C" })).body
      .project.projectId;
    await postJson(h.app, `/projects/${p1}/concepts`, { text: "#참여자:철수" });
    await postJson(h.app, `/projects/${p2}/concepts`, { text: "#참여자:철수" });
    await postJson(h.app, `/projects/${p3}/concepts`, { text: "#참여자:민수" });

    const presets = await getJson(h.app, "/projects/preset-concepts?key=참여자");
    expect(presets.status).toBe(200);
    expect(presets.body.key).toBe("참여자");
    // 철수(2) 가 민수(1) 보다 앞.
    expect(presets.body.presets.map((p: any) => p.name)).toEqual([
      "철수",
      "민수",
    ]);
    expect(presets.body.presets[0].usageCount).toBe(2);
    expect(presets.body.presets[1].usageCount).toBe(1);
  });

  test("없는 분류 키 = 빈 후보(정직한 빈 — 추천할 값 없음)", async () => {
    const res = await getJson(h.app, "/projects/preset-concepts?key=한번도안쓴키");
    expect(res.status).toBe(200);
    expect(res.body.presets).toEqual([]);
  });

  test("key 파라미터 없으면 400", async () => {
    const res = await getJson(h.app, "/projects/preset-concepts");
    expect(res.status).toBe(400);
  });

  // 함정 4 — 라우트 등록 순서 검증. /projects/preset-concepts 가 /projects/:id 보다
  // 먼저 등록돼야 "preset-concepts" 가 프로젝트 id 로 빨려 404 가 되지 않는다. 그
  // 차이를 직접 본다: preset-concepts 는 200(프리셋 라우트), 진짜 없는 id 는 404.
  test("등록 순서 — preset-concepts 가 :id 에 안 빨린다(200) / 없는 id 는 404", async () => {
    const preset = await getJson(h.app, "/projects/preset-concepts?key=참여자");
    expect(preset.status).toBe(200);
    expect(Array.isArray(preset.body.presets)).toBe(true);

    const missing = await getJson(h.app, "/projects/prj_definitely_missing");
    expect(missing.status).toBe(404);
  });
});
