/**
 * project-person-edges-characterization.test.ts — D6 현재 동작 특성 테스트 (plan S1).
 *
 * 통합 작업(spec/plan 2026-06-27 엔티티 관리 통합) D6 의 *재작성 전* 회귀 안전망이다.
 * project_person_edges(전용 참여자 테이블) 기반 현재 동작을 그대로 기록한다. S2+S3 가
 * 이 관계를 범용 entity_relation_edges(relation='participated_by')로 옮긴 뒤, 이 테스트
 * 5갈래가 그대로 통과하면 = 회귀 0 의 기계 증명이다. 그래서 이 테스트는 *현재 코드*에서
 * 전부 통과해야 한다(현재 동작을 기록하므로 지금 green).
 *
 * 실제 bun:sqlite(:memory:) + 실제 bge-m3 임베딩으로 통합 검증한다 — Mock 클래스 0.
 * 데이터는 store facade(addProjectPersonEdge 등)와 FK 충족용 직접 INSERT 로 깐다.
 * 운영 DB(data/bara.sqlite) 비접근 — 전부 :memory: 격리.
 *
 * 덮는 5갈래(plan S1):
 *   1. 참여자 추가 — POST /api/projects/:id/participants → 추가 성공/중복 false/없는 사람 404.
 *   2. 양방향 상세 — GET /api/projects/:id(participants)·GET /api/persons/:id(projects).
 *   3. 검색 회상(프로젝트 채널) — 프로젝트 검색이 그 프로젝트 글 + 참여자 글을 끌어온다
 *      (collectProjectChannel).
 *   4. 검색 회상(사람 채널) — 사람 검색이 그 사람 글 + 참여 프로젝트 글을 끌어온다
 *      (collectPersonChannel).
 *   5. 검색 회상(개념 채널 — 검토가 잡은 핵심) — 한 사람이 created_by(작품→사람)와
 *      participated_by(프로젝트→사람) 양쪽으로 잡히는 데이터를 깔고, 작품 검색이
 *      collectConceptChannel 의 1-hop 펼침(getEntitySeedsByConcepts +
 *      getRelatedEntityNodeIds)으로 끌어오는 후보 글 집합을 명시 스냅샷으로 기록한다.
 *      D6 후 이 집합이 늘면 누수(spec §4.5a). participated_by 가 entity_relation_edges 에
 *      있어도 project 끝점은 글로 안 풀려 개념 채널 1-hop 펼침에 안 잡힌다(누수 0) —
 *      이 baseline 을 정확히 고정한다(S4 후: 별 테이블 제거·범용 표 한 곳).
 *
 * role 실사용 판정 결과: 검색 회상은 DISTINCT 로 role 무시, 상세는 옛 전용 테이블에서
 * role 보존했으나 — 사용자 결정으로 통합 후 role 버림(default a). 범용
 * entity_relation_edges 에 role 칸이 없어 같은 사람·다른 role 은 한 엣지로 합쳐진다.
 * 동등성 4갈래(추가성공/중복/404·양방향 person_id·프로젝트/사람/개념 채널)는 role 과
 * 무관해 그대로 통과 = 회귀 0 증명.
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
import { openMemoryDatabase } from "../migrations.ts";
import { SqliteMemoryStore } from "../store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import {
  collectProjectChannel,
  collectPersonChannel,
  collectConceptChannel,
} from "../../memory/retrieve-channels.ts";
import { resolveRetrieveConfig } from "../../memory/retrieve-config.ts";
import { ENTITY_RELATION_EXPANSION_LIMIT } from "../../memory/retrieve-constants.ts";
import { resetConceptTypeVocabularyCache } from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";

/** bge-m3 정식 운영 모델(dim 1024). 검색 회상을 실제 임베딩으로 돌린다. */
const EMBEDDING_DIM = 1024;

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  resetConceptTypeVocabularyCache();
  resetClassifierCache();
});
afterAll(() => {});

// ── 공통 하네스 (실 store + 실 retriever + 실 app) ──────────────────────────

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
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

// ── 갈래 1 — 참여자 추가 (POST /projects/:id/participants) ────────────────────

describe("S1 갈래1 — 참여자 추가 (현재 project_person_edges 통로)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("참여자 추가 성공 → added: true", async () => {
    const created = await postJson(h.app, "/projects", { name: "참여자 추가 대상" });
    const projectId = created.body.project.projectId;
    const person = await h.store.findOrCreatePerson({
      displayName: "김민수",
      userId: "u-kim",
      source: "discord",
    });

    const linked = await postJson(h.app, `/projects/${projectId}/participants`, {
      personId: person.personId,
      role: "creator",
    });
    expect(linked.status).toBe(201);
    expect(linked.body.added).toBe(true);
    expect(linked.body.personId).toBe(person.personId);
    expect(linked.body.role).toBe("creator");
  });

  test("같은 (project, person, role) 중복 추가 → added: false", async () => {
    const created = await postJson(h.app, "/projects", { name: "중복 대상" });
    const projectId = created.body.project.projectId;
    const person = await h.store.findOrCreatePerson({
      displayName: "이영희",
      userId: "u-lee",
      source: "discord",
    });

    const first = await postJson(h.app, `/projects/${projectId}/participants`, {
      personId: person.personId,
      role: "participant",
    });
    expect(first.body.added).toBe(true);

    const second = await postJson(h.app, `/projects/${projectId}/participants`, {
      personId: person.personId,
      role: "participant",
    });
    expect(second.status).toBe(201);
    expect(second.body.added).toBe(false);
  });

  test("없는 사람 추가 → 404 (존재 게이트 — spec §4.4 입력 게이트)", async () => {
    const created = await postJson(h.app, "/projects", { name: "없는 사람 대상" });
    const projectId = created.body.project.projectId;

    const res = await postJson(h.app, `/projects/${projectId}/participants`, {
      personId: "psn_does_not_exist",
      role: "participant",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("person not found");
  });

  test("같은 사람을 다른 role 로 또 넣어도 한 participated_by 엣지로 합쳐진다(role 통합·D6)", async () => {
    // role 통합 후 동작: entity_relation_edges PK 에 role 칸이 없어 같은 (project,
    // person, participated_by)는 한 엣지다. 같은 사람을 다른 role 로 또 넣으면 둘째는
    // 중복 엣지라 added:false 로 합쳐진다(role 은 통합 후 안 가름·사용자 결정).
    const created = await postJson(h.app, "/projects", { name: "다중 role 대상" });
    const projectId = created.body.project.projectId;
    const person = await h.store.findOrCreatePerson({
      displayName: "박지성",
      userId: "u-park",
      source: "discord",
    });

    const asCreator = await postJson(
      h.app,
      `/projects/${projectId}/participants`,
      { personId: person.personId, role: "creator" },
    );
    const asContributor = await postJson(
      h.app,
      `/projects/${projectId}/participants`,
      { personId: person.personId, role: "contributor" },
    );
    expect(asCreator.body.added).toBe(true);
    // 둘째 role 은 같은 participated_by 엣지라 중복(멱등).
    expect(asContributor.body.added).toBe(false);

    // 상세 participants 는 한 줄로 합쳐 보인다 — person_id 1개·role 빈 값.
    const detail = await getJson(h.app, `/projects/${projectId}`);
    expect(detail.body.participants.length).toBe(1);
    expect(detail.body.participants[0].personId).toBe(person.personId);
    expect(detail.body.participants[0].role).toBe("");
  });
});

// ── 갈래 2 — 양방향 상세 (GET /projects/:id · GET /persons/:id) ───────────────

describe("S1 갈래2 — 양방향 상세 (프로젝트→참여자 / 사람→참여 프로젝트)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("프로젝트 상세에 참여자 목록이 뜬다", async () => {
    const created = await postJson(h.app, "/projects", { name: "상세 프로젝트" });
    const projectId = created.body.project.projectId;
    const kim = await h.store.findOrCreatePerson({
      displayName: "김민수",
      userId: "u-kim",
      source: "discord",
    });
    const lee = await h.store.findOrCreatePerson({
      displayName: "이영희",
      userId: "u-lee",
      source: "discord",
    });
    await postJson(h.app, `/projects/${projectId}/participants`, {
      personId: kim.personId,
      role: "creator",
    });
    await postJson(h.app, `/projects/${projectId}/participants`, {
      personId: lee.personId,
      role: "participant",
    });

    const detail = await getJson(h.app, `/projects/${projectId}`);
    expect(detail.status).toBe(200);
    const personIds = detail.body.participants
      .map((p: any) => p.personId)
      .sort();
    expect(personIds).toEqual([kim.personId, lee.personId].sort());
  });

  test("사람 상세에 참여 프로젝트 목록이 뜬다 (한 사람 두 프로젝트)", async () => {
    const p1 = (await postJson(h.app, "/projects", { name: "프로젝트 하나" })).body
      .project.projectId;
    const p2 = (await postJson(h.app, "/projects", { name: "프로젝트 둘" })).body
      .project.projectId;
    const kim = await h.store.findOrCreatePerson({
      displayName: "김민수",
      userId: "u-kim",
      source: "discord",
    });
    await postJson(h.app, `/projects/${p1}/participants`, {
      personId: kim.personId,
      role: "creator",
    });
    await postJson(h.app, `/projects/${p2}/participants`, {
      personId: kim.personId,
      role: "participant",
    });

    const detail = await getJson(h.app, `/persons/${kim.personId}`);
    expect(detail.status).toBe(200);
    const projectIds = detail.body.projects
      .map((p: any) => p.projectId)
      .sort();
    expect(projectIds).toEqual([p1, p2].sort());
  });

  test("참여자 0건 프로젝트 = 빈 배열 (정직한 빈 상태)", async () => {
    const created = await postJson(h.app, "/projects", { name: "외톨이 프로젝트" });
    const detail = await getJson(
      h.app,
      `/projects/${created.body.project.projectId}`,
    );
    expect(detail.body.participants).toEqual([]);
  });

  test("참여 프로젝트 0건 사람 = 빈 배열", async () => {
    const person = await h.store.findOrCreatePerson({
      displayName: "외톨이",
      userId: "u-alone",
      source: "discord",
    });
    const detail = await getJson(h.app, `/persons/${person.personId}`);
    expect(detail.body.projects).toEqual([]);
  });
});

// ── 갈래 3 — 검색 회상: 프로젝트 채널 (collectProjectChannel) ─────────────────

describe("S1 갈래3 — 검색 회상 프로젝트 채널", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("프로젝트 검색이 그 프로젝트 글 + 참여자 글을 후보로 끌어온다", async () => {
    // 프로젝트 표지 + 임베딩 적재(검색 매칭용).
    const created = await postJson(h.app, "/projects", {
      name: "주술회전 위키",
      summary: "주술회전 캐릭터 설정 보관소",
    });
    const projectId = created.body.project.projectId;

    // 프로젝트에 묶인 글 하나(getNodesByProjectId 로 끌려올 대상).
    const projectDocId = await h.store.addNode({
      content: "주술회전 위키 정리 노트",
      sourceType: "auto_capture",
    });
    await postJson(h.app, `/projects/${projectId}/documents`, {
      nodeId: projectDocId,
    });

    // 참여자(사람) + 그 사람을 언급하는 글(node_person_edges).
    const person = await h.store.findOrCreatePerson({
      displayName: "아쿠타미",
      userId: "u-aku",
      source: "discord",
    });
    await postJson(h.app, `/projects/${projectId}/participants`, {
      personId: person.personId,
      role: "creator",
    });
    const participantDocId = await h.store.addNode({
      content: "아쿠타미 인터뷰 메모",
      sourceType: "auto_capture",
    });
    h.db
      .prepare(
        "INSERT INTO node_person_edges (node_id, person_id, relation, provenance, source_node_id) VALUES (?, ?, 'mentions', 'user_input', NULL)",
      )
      .run(participantDocId, person.personId);

    // 실제 임베딩으로 프로젝트 채널을 통째로 돌린다.
    const queryText = "주술회전 위키";
    const queryVec = await embedder.embed(queryText);
    const config = resolveRetrieveConfig(queryText, {}, {});
    const candidates = await collectProjectChannel(
      h.store,
      queryText,
      queryVec,
      config,
    );

    // 프로젝트 글 + 참여자 글 둘 다 후보 pool 에 들어온다.
    expect(candidates).toContain(projectDocId);
    expect(candidates).toContain(participantDocId);
  });

  test("프로젝트가 안 잡히면 후보 0개 (자연 degrade)", async () => {
    // projects 색인이 빈 DB — 어떤 검색어도 프로젝트를 못 잡아 빈 후보.
    const queryText = "존재하지 않는 프로젝트 이름 xyz";
    const queryVec = await embedder.embed(queryText);
    const config = resolveRetrieveConfig(queryText, {}, {});
    const candidates = await collectProjectChannel(
      h.store,
      queryText,
      queryVec,
      config,
    );
    expect(candidates).toEqual([]);
  });
});

// ── 갈래 4 — 검색 회상: 사람 채널 (collectPersonChannel) ──────────────────────

describe("S1 갈래4 — 검색 회상 사람 채널", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("사람 검색이 그 사람 글 + 참여 프로젝트 글을 후보로 끌어온다", async () => {
    // 사람 + 임베딩 적재(검색 매칭용) + 그 사람 언급 글.
    const personRes = await postJson(h.app, "/persons", {
      name: "고하루치카",
      embeddingText: "고하루치카는 만화가다",
    });
    const personId = personRes.body.person.personId;
    const personDocId = await h.store.addNode({
      content: "고하루치카 신작 소식",
      sourceType: "auto_capture",
    });
    h.db
      .prepare(
        "INSERT INTO node_person_edges (node_id, person_id, relation, provenance, source_node_id) VALUES (?, ?, 'mentions', 'user_input', NULL)",
      )
      .run(personDocId, personId);

    // 그 사람이 참여한 프로젝트 + 그 프로젝트 글.
    const created = await postJson(h.app, "/projects", {
      name: "고하루치카 작품집",
      summary: "고하루치카 작품 모음",
    });
    const projectId = created.body.project.projectId;
    const projectDocId = await h.store.addNode({
      content: "작품집 편집 노트",
      sourceType: "auto_capture",
    });
    await postJson(h.app, `/projects/${projectId}/documents`, {
      nodeId: projectDocId,
    });
    await postJson(h.app, `/projects/${projectId}/participants`, {
      personId,
      role: "creator",
    });

    const queryText = "고하루치카";
    const queryVec = await embedder.embed(queryText);
    const config = resolveRetrieveConfig(queryText, {}, {});
    const candidates = await collectPersonChannel(
      h.store,
      queryText,
      queryVec,
      config,
    );

    // 사람 글 + 참여 프로젝트 글 둘 다 후보에 들어온다.
    expect(candidates).toContain(personDocId);
    expect(candidates).toContain(projectDocId);
  });

  test("사람이 안 잡히면 후보 0개 (자연 degrade)", async () => {
    const queryText = "존재하지 않는 사람 이름 qwerty";
    const queryVec = await embedder.embed(queryText);
    const config = resolveRetrieveConfig(queryText, {}, {});
    const candidates = await collectPersonChannel(
      h.store,
      queryText,
      queryVec,
      config,
    );
    expect(candidates).toEqual([]);
  });
});

// ── 갈래 5 — 검색 회상: 개념 채널 1-hop 펼침 baseline (spec §4.5a · 핵심) ──────
//
// 한 사람(아쿠타미)이 created_by(작품→사람)와 participated_by(프로젝트→사람) 양쪽으로
// 잡히는 데이터를 깐다. 작품 검색 시 collectConceptChannel 의 1-hop 펼침이 끌어오는 글
// 집합을 명시 스냅샷으로 기록한다. 현재(D6 전)는 participated_by 가 project_person_edges
// 별 테이블에 있어 getRelatedEntityNodeIds 의 entity_relation_edges 펼침에 안 잡힌다 —
// 그래서 프로젝트 글은 개념 채널 baseline 에 *안 들어온다*. 이 baseline 을 고정한다.
//
// 임베딩 비결정성을 변수에서 빼려고, 5번 갈래의 핵심 스냅샷은 getEntitySeedsByConcepts +
// getRelatedEntityNodeIds 를 *고정 개념 집합*으로 직접 호출해 결정적으로 기록한다(entity-
// relation-search.test.ts 와 같은 결정적 좌표). collectConceptChannel 전 경로(실 임베딩)
// 도 별도로 돌려 같은 baseline 을 확인한다.

describe("S1 갈래5 — 개념 채널 1-hop 펼침 baseline (참여자 누수 가드 — spec §4.5a)", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  // FK 충족용 직접 INSERT 헬퍼 — entity-relation-search.test.ts 양식.
  function insertWork(workId: string, name: string): void {
    db.prepare(
      `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
       VALUES (?, 'work', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    ).run(workId, name);
  }
  function insertConceptRow(conceptId: string, name: string): void {
    db.prepare(
      "INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)",
    ).run(conceptId, name);
  }
  function linkIdentity(entityId: string, conceptId: string): void {
    db.prepare(
      `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, 'identity', '2026-01-01 00:00:00', 'user_input', NULL)`,
    ).run(entityId, conceptId);
  }
  function insertNode(content: string): number {
    const r = db
      .prepare("INSERT INTO knowledge_nodes (content) VALUES (?)")
      .run(content);
    return Number(r.lastInsertRowid);
  }
  function linkNodeConcept(nodeId: number, conceptId: string): void {
    db.prepare(
      "INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, 'tag', 'user_input', NULL)",
    ).run(nodeId, conceptId);
  }
  function insertPersonRow(personId: string, name: string): void {
    db.prepare(
      "INSERT INTO persons (person_id, display_name) VALUES (?, ?)",
    ).run(personId, name);
  }

  /**
   * 끝에서 끝 데이터:
   *   - 작품 데못죽(wrk_demotjuk): identity 개념 cpt_demotjuk + 그 개념 글 demotjukNode.
   *   - 작품 주술회전(wrk_jjk): identity 개념 cpt_jjk + 그 개념 글 jjkNode.
   *   - 두 작품 모두 created_by → 아쿠타미(psn_akutami)  [entity_relation_edges]
   *   - 프로젝트 만화방(prj_studio): 아쿠타미 participated_by  [project_person_edges]
   *   - 프로젝트 글 studioNode (project_id = prj_studio).
   *
   * 검색어 '데못죽' → cpt_demotjuk 직접 매칭 → wrk_demotjuk seed →
   *   1-hop: created_by 아쿠타미(target) → 같은 아쿠타미 가진 wrk_jjk(other source) →
   *   주술회전 글 jjkNode 가 개념 채널 후보로 합류한다.
   * 현재 동작: 프로젝트 만화방은 participated_by 가 별 테이블이라 1-hop 펼침에 안 잡힘 —
   *   studioNode 는 개념 채널 baseline 에 안 들어온다.
   */
  function seedSharedPersonWorld(): {
    demotjukNode: number;
    jjkNode: number;
    studioNode: number;
    projectId: string;
  } {
    insertWork("wrk_demotjuk", "데못죽");
    insertWork("wrk_jjk", "주술회전");
    insertPersonRow("psn_akutami", "아쿠타미");

    insertConceptRow("cpt_demotjuk", "데못죽");
    insertConceptRow("cpt_jjk", "주술회전");
    linkIdentity("wrk_demotjuk", "cpt_demotjuk");
    linkIdentity("wrk_jjk", "cpt_jjk");

    const demotjukNode = insertNode("데못죽 감상");
    const jjkNode = insertNode("주술회전 감상");
    linkNodeConcept(demotjukNode, "cpt_demotjuk");
    linkNodeConcept(jjkNode, "cpt_jjk");

    // 두 작품이 같은 작가 아쿠타미를 created_by 로 가진다(범용 관계 테이블).
    store.addEntityRelationEdge(
      "work",
      "wrk_demotjuk",
      "person",
      "psn_akutami",
      "created_by",
      "user_input",
      null,
    );
    store.addEntityRelationEdge(
      "work",
      "wrk_jjk",
      "person",
      "psn_akutami",
      "created_by",
      "user_input",
      null,
    );

    // 프로젝트(범용 entities type_name='project') + 그 프로젝트에 아쿠타미가 참여.
    // S2·S3·S4 후 참여 통로 = 범용 entity_relation_edges(participated_by) 한 곳 —
    // 옛 project_person_edges 별 테이블은 S4 가 제거했다. 프로젝트 글 하나(project_id
    // 칸으로 연결).
    db.prepare(
      `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
       VALUES ('prj_studio', 'project', '만화방', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    ).run();
    store.addEntityRelationEdge(
      "project",
      "prj_studio",
      "person",
      "psn_akutami",
      "participated_by",
      "user_input",
      null,
    );
    const studioNode = insertNode("만화방 프로젝트 운영 노트");
    db.prepare("UPDATE knowledge_nodes SET project_id = 'prj_studio' WHERE id = ?").run(
      studioNode,
    );

    return { demotjukNode, jjkNode, studioNode, projectId: "prj_studio" };
  }

  test("seed/펼침 직접 호출 — 작품 검색은 같은 작가의 다른 작품 글만 끌어온다(참여 프로젝트 글은 안 끌려옴)", () => {
    const { demotjukNode, jjkNode, studioNode } = seedSharedPersonWorld();

    // 검색어 '데못죽' 이 직접 잡은 개념(고정) → identity seed 회수.
    const seeds = store.getEntitySeedsByConcepts(["cpt_demotjuk"]);
    expect(seeds.length).toBe(1);
    expect(seeds[0]!.type).toBe("work");
    expect(seeds[0]!.id).toBe("wrk_demotjuk");

    // 1-hop 펼침 — 현재 baseline 후보 글 집합.
    const related = store.getRelatedEntityNodeIds(
      seeds,
      ENTITY_RELATION_EXPANSION_LIMIT,
    );

    // baseline: 같은 작가 아쿠타미의 다른 작품(주술회전) 글이 끌려온다.
    expect(related).toContain(jjkNode);
    // seed 자신(데못죽) 글은 제외(1차 검색이 이미 잡음).
    expect(related).not.toContain(demotjukNode);
    // 핵심 — 참여 프로젝트(만화방) 글은 1-hop 펼침에 안 끌려온다. participated_by 가
    // entity_relation_edges 에 있어도 project 끝점은 글 풀이에서 제외되고(r.type !==
    // 'project') 만화방이 글로 안 풀려 후보에 안 든다(누수 0 — spec §4.5a).
    expect(related).not.toContain(studioNode);

    // baseline 후보 집합 명시 스냅샷 — D6 후 동등성 비교 기준선(정렬해 결정적 비교).
    expect([...related].sort((a, b) => a - b)).toEqual([jjkNode]);
  });

  test("개념 채널 전 경로(실 임베딩) — 작품 검색 baseline 에 참여 프로젝트 글이 없다", async () => {
    const { jjkNode, studioNode } = seedSharedPersonWorld();

    // '데못죽' 개념을 실제 검색 색인에 올린다 — findOrCreateConcept 가 concept_fts·
    // concept_vec 을 채워 searchConceptsByFts/Vector 가 cpt_demotjuk 을 잡게 한다.
    // 위 seed 의 cpt_demotjuk(직접 INSERT) 대신 검색 가능한 개념을 새로 만들어 identity
    // 를 그 개념으로 다시 잇는다(검색 도달 통로 정합).
    const demotjukSearchable = await store.findOrCreateConcept("데못죽데못죽", {
      isClassificationValue: true,
    });
    db.prepare(
      `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES ('wrk_demotjuk', ?, 'identity', '2026-01-01 00:00:00', 'user_input', NULL)`,
    ).run(demotjukSearchable);

    const queryText = "데못죽데못죽";
    const queryVec = await embedder.embed(queryText);
    const config = resolveRetrieveConfig(queryText, {}, {});
    const candidates = await collectConceptChannel(
      store,
      queryText,
      queryVec,
      config,
    );

    // 같은 작가의 다른 작품 글(주술회전)은 1-hop 펼침으로 끌려온다.
    expect(candidates).toContain(jjkNode);
    // 참여 프로젝트(만화방) 글은 현재 baseline 에 없다 — 누수 0 기준선.
    expect(candidates).not.toContain(studioNode);
  });

  test("대조 — 만화방 검색은 프로젝트 채널로 그 프로젝트 글을 끌어온다(개념 채널과 통로 분리)", async () => {
    // 참여 프로젝트 글이 *전혀 도달 불가*가 아님을 대조로 확인한다. 만화방을 직접
    // 검색하면 프로젝트 채널이 그 글을 끌어온다 — 개념 채널 baseline 에 없는 것은
    // "통로가 다르다" 이지 "글이 사라졌다" 가 아니다(거짓 baseline 차단).
    const { studioNode } = seedSharedPersonWorld();

    // 만화방 프로젝트를 검색 색인에 올린다(요약 임베딩).
    await store.updateProject("prj_studio", { summary: "만화방 작업 공간 운영" });
    await store.applyProjectEmbedding("prj_studio");

    const queryText = "만화방";
    const queryVec = await embedder.embed(queryText);
    const config = resolveRetrieveConfig(queryText, {}, {});
    const candidates = await collectProjectChannel(
      store,
      queryText,
      queryVec,
      config,
    );

    // 프로젝트 채널은 만화방 글을 끌어온다(통로가 살아 있음 — 거짓 baseline 아님).
    expect(candidates).toContain(studioNode);
  });

  // ── participated_by 합류가 개념 채널을 바꾸는가 (누수 0 동등성 좌표) ──
  //
  // S2·S3·S4 후 participated_by 는 범용 entity_relation_edges 한 곳에 산다. 이 관계가
  // 1-hop 펼침 후보 집합을 늘리는지(=누수) 직접 확인한다. plan S3 의 "집합이 동일하면
  // (누수 없음) 가드 불필요 — 그 사실도 테스트로 기록한다" 의 좌표다. setup 이 이미
  // participated_by 를 깔아 둔 상태에서, 같은 엣지를 한 번 더 더해도 후보가 안 바뀌는지
  // 본다(중복은 INSERT OR IGNORE 라 무변·후보도 무변이어야 누수 0).
  test("participated_by 가 entity_relation_edges 에 있어도 개념 채널 1-hop 후보 불변", () => {
    seedSharedPersonWorld();
    const seeds = () => store.getEntitySeedsByConcepts(["cpt_demotjuk"]);

    // before: setup 이 깐 participated_by 가 범용 entity_relation_edges 에 있는 상태.
    const before = store
      .getRelatedEntityNodeIds(seeds(), ENTITY_RELATION_EXPANSION_LIMIT)
      .slice()
      .sort((a, b) => a - b);

    // 같은 participated_by 를 한 번 더 더한다(펼침 입력이 늘었을 때 후보가 바뀌는지 본다).
    store.addEntityRelationEdge(
      "project",
      "prj_studio",
      "person",
      "psn_akutami",
      "participated_by",
      "user_input",
      null,
    );
    const after = store
      .getRelatedEntityNodeIds(seeds(), ENTITY_RELATION_EXPANSION_LIMIT)
      .slice()
      .sort((a, b) => a - b);

    // 실측: 후보 집합이 안 바뀐다. project 끝점은 글 풀이에서 제외되고(r.type !==
    // 'project'), 아쿠타미를 공유하는 source 가 만화방으로 넓어져도 만화방은 글로 안
    // 풀려 후보가 안 는다. 누수 없음 = 가드 불필요(이 데이터 형태에서).
    expect(after).toEqual(before);
  });
});

// ── role 실사용 판정 — 회상이 role 을 변별 신호로 쓰는가 ──────────────────────
//
// spec §6 role default 확정 근거: 회상·상세가 participated_by 의 role 값을 가르는지
// (DISTINCT person_id/project_id 로만 쓰는지) 테스트로 드러낸다. 안 쓰면 S2 에서
// role 버림(default (a))을 확정할 수 있다.

describe("S1 role 실사용 판정 — 회상은 role 을 안 가른다(DISTINCT person_id/project_id)", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  function insertPersonRow(personId: string, name: string): void {
    db.prepare(
      "INSERT INTO persons (person_id, display_name) VALUES (?, ?)",
    ).run(personId, name);
  }

  test("같은 사람을 두 번 넣어도 회상 person_id 는 1개 (한 엣지로 합쳐짐·role 통합)", async () => {
    const project = await store.findOrCreateProject({ name: "role 판정 프로젝트" });
    insertPersonRow("psn_dual", "양다리");

    // 같은 사람을 다른 role 로 두 번 넣어도 participated_by 엣지 하나로 합쳐진다.
    await store.addProjectPersonEdge(project.projectId, "psn_dual", "creator", "user_input", null);
    await store.addProjectPersonEdge(project.projectId, "psn_dual", "participant", "user_input", null);

    // 회상 통로(getProjectParticipantPersonIds)는 person_id 1개로 묶는다 — role 무시.
    const personIds = store.getProjectParticipantPersonIds(project.projectId);
    expect(personIds).toEqual(["psn_dual"]);

    // 반대 방향(getPersonProjectIds)도 project_id 1개로 묶는다 — role 무시.
    const projectIds = store.getPersonProjectIds("psn_dual");
    expect(projectIds).toEqual([project.projectId]);
  });

  test("상세는 한 줄로 합쳐 보인다(role 통합 — person_id 1개·role 빈 값)", async () => {
    // 상세 listProjectParticipants 는 통합 후 한 줄만 돌려준다. 같은 사람을 두 role 로
    // 넣어도 participated_by 엣지 하나라 person_id 1개·role 빈 값이다(통합 후 role 미보존).
    const project = await store.findOrCreateProject({ name: "role 표시 프로젝트" });
    insertPersonRow("psn_show", "표시대상");
    await store.addProjectPersonEdge(project.projectId, "psn_show", "creator", "user_input", null);
    await store.addProjectPersonEdge(project.projectId, "psn_show", "contributor", "user_input", null);

    const parts = await store.listProjectParticipants(project.projectId);
    expect(parts.length).toBe(1);
    expect(parts[0]!.personId).toBe("psn_show");
    expect(parts[0]!.role).toBe("");
  });
});
