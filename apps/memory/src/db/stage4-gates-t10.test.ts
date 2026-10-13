/**
 * stage4-gates-t10.test.ts — 분류 단계4 전면 통일 검증 게이트(T10).
 *
 * spec §10 8 게이트 중 *런타임 라이브 동작* 게이트(4·5·7)를 한 곳에서 끝에서 끝으로
 * 확인한다(나머지 게이트 — 빌드/tsc·점수식 0 diff·합성 색인 양식·스키마 스냅샷(schema-snapshot.test.ts)·
 * listPlaceLeafNames — 은 별 검증·기존 테스트가 책임). person A·project B 결정을 반영한다.
 *
 * 게이트 4 — 빈 DB 라이브: 8 entity 타입 + project(entities 본체) + person(persons 전용)을
 *   입력해 각자 통로로 검색에 잡히고, FK 끝점이 정상인지 본다(silent miss 0).
 * 게이트 5 — FK CASCADE: entity 행 삭제 시 그 끝점 엣지(entity_concept_edges·
 *   entity_attributes)가 ON DELETE CASCADE 로 동반 삭제(C2 구조적 소멸). node_person_edges
 *   도 person FK CASCADE 로 정리한다. 참여자 엣지 participated_by 는 D6 로 FK 0 인
 *   entity_relation_edges 로 옮겨졌다(옛 project_person_edges CASCADE 아님) — project·person
 *   삭제가 이 엣지를 자동으로 안 지운다(FK 0 잔존). 끊긴 엣지 정리는 app 로직(wipe)이
 *   진다(spec §4.4). entity_relation_edges·hierarchy_edges 가 다형 끝점이라 FK 0 인 사실은
 *   아래 별도 테스트가 명시 단언한다(거짓 CASCADE 안 만든다).
 * 게이트 7 — special 칸: work 정체성 4-tuple(type_name·name·medium·created_by) 충돌 0·
 *   person 신원 합류(external_refs·persons·person A) 동작 보존.
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder(1024) — Mock 0(CLAUDE.md). 운영 DB 미접촉.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "./migrations.ts";
import { SqliteMemoryStore } from "./store.ts";
import { ENTITY_TYPE_METAS } from "./store-internal/entity-type-registry.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("T10 게이트 4·5·7 — 단계4 전면 통일 라이브 검증", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => db.close());

  const countRows = (
    table: string,
    where: string,
    ...params: (string | number)[]
  ): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...params) as {
      c: number;
    }).c;

  // ── 게이트 4 — 빈 DB 라이브(8타입+project=entities·person=persons) ──────────────

  test("게이트4 — 8 entity 타입 + project 가 범용 entities 본체에 살고 각자 검색 통로로 잡힌다", async () => {
    // 8 타입 + project 를 entities 본체에 만든다(같은 토큰 '게이트사검증').
    const made: Array<{ typeName: string; id: string }> = [];
    for (const m of ENTITY_TYPE_METAS) {
      const e = await store.entitiesRepo.findOrCreateEntity(m.typeName, `게이트사검증_${m.typeName}`);
      made.push({ typeName: m.typeName, id: e.id });
    }
    const project = await store.findOrCreateProject({ name: "게이트사검증프로젝트" });

    // 8 타입·새 종류: 범용 entities_fts(searchEntitiesByFts)로 잡힌다.
    const entHits = store.searchEntitiesByFts("게이트사검증", 50).map((h) => h.entityId);
    for (const x of made) expect(entHits).toContain(x.id);

    // project: 타입 필터 통로(searchProjectsByFts→entities_fts type_name='project')로 잡히고
    // 8 타입 entity_id 는 안 섞인다(T7' 타입 가름).
    const prjHits = (await store.searchProjectsByFts("게이트사검증", 50)).map((h) => h.projectId);
    expect(prjHits).toContain(project.projectId);
    for (const x of made) expect(prjHits).not.toContain(x.id);
  });

  test("게이트4 — person 은 persons 전용 통로(searchPersonsByFts)로 잡힌다(person A 보존)", async () => {
    const person = await store.findOrCreatePersonByName("게이트사사람검증");
    const psnHits = (await store.searchPersonsByFts("게이트사사람검증", 50)).map((h) => h.personId);
    expect(psnHits).toContain(person.personId);
    // person 은 entities 본체에 안 들어간다(person A — 전용 persons 테이블).
    const inEntities = countRows("entities", "name = ?", "게이트사사람검증");
    expect(inEntities).toBe(0);
  });

  // ── 게이트 5 — FK CASCADE(끊긴 엣지 0·C2 구조적 소멸) ──────────────────────────

  test("게이트5 — entity 행 삭제 시 entity_concept_edges·entity_attributes 가 CASCADE 동반 삭제", async () => {
    const work = await store.entitiesRepo.findOrCreateEntity("work", "캐스케이드작품");
    const concept = await store.findOrCreateTagConcept("캐스케이드라벨");
    store.addEntityConceptEdge("work", work.id, concept, "has_attribute", "user_input", null);
    store.entitiesRepo.setAttribute(work.id, "비고", "메모값", false);

    // 삭제 전 — 엣지·칸이 있다.
    expect(countRows("entity_concept_edges", "entity_id = ?", work.id)).toBe(1);
    expect(countRows("entity_attributes", "entity_id = ?", work.id)).toBeGreaterThanOrEqual(1);

    // entities 행 삭제(FK 강제 ON·ON DELETE CASCADE).
    db.prepare("DELETE FROM entities WHERE entity_id = ?").run(work.id);

    // 삭제 후 — 끝점 엣지·칸이 잔존 0(C2 구조적 소멸).
    expect(countRows("entity_concept_edges", "entity_id = ?", work.id)).toBe(0);
    expect(countRows("entity_attributes", "entity_id = ?", work.id)).toBe(0);
  });

  test("게이트5 — project 삭제 시 participated_by(entity_relation_edges)는 FK 0 라 CASCADE 안 됨 — §4.4 트레이드오프(정리는 app/wipe)", async () => {
    const project = await store.findOrCreateProject({ name: "캐스케이드프로젝트" });
    const person = await store.findOrCreatePersonByName("캐스케이드참여자");
    await store.addProjectPersonEdge(project.projectId, person.personId, "owner", "user_input", null);

    expect(
      countRows(
        "entity_relation_edges",
        "source_id = ? AND relation = 'participated_by'",
        project.projectId,
      ),
    ).toBe(1);

    // project(=entities 행) 삭제.
    db.prepare("DELETE FROM entities WHERE entity_id = ?").run(project.projectId);

    // FK 0 이라 project 삭제가 participated_by 를 자동으로 안 지운다 — 끊긴 엣지로 남는다.
    // 끊긴 엣지 정리는 app(wipe·wiring 게이트)가 진다 — 아래 line FK 0 단언·spec §4.4 정합.
    // 옛 project_person_edges CASCADE 보호는 D6 가 의도적으로 내려놓았다(읽는 곳·삭제
    // 경로가 없어 실해 0).
    expect(
      countRows(
        "entity_relation_edges",
        "source_id = ? AND relation = 'participated_by'",
        project.projectId,
      ),
    ).toBe(1);
    // person 행 자체는 보존(person A — project 삭제가 사람을 지우지 않는다).
    expect(countRows("persons", "person_id = ?", person.personId)).toBe(1);
  });

  test("게이트5 — person 삭제 시 node_person_edges 는 CASCADE 정리·participated_by(entity_relation_edges)는 FK 0 라 잔존", async () => {
    const person = await store.findOrCreatePersonByName("삭제대상사람");
    const node = await store.addNode({ content: "사람 언급 글" });
    await store.addNodePersonEdge(node, person.personId, "mentions", "user_input", node);
    const project = await store.findOrCreateProject({ name: "사람삭제프로젝트" });
    await store.addProjectPersonEdge(project.projectId, person.personId, "contributor", "user_input", null);

    expect(countRows("node_person_edges", "person_id = ?", person.personId)).toBe(1);
    expect(
      countRows(
        "entity_relation_edges",
        "target_id = ? AND relation = 'participated_by'",
        person.personId,
      ),
    ).toBe(1);

    // persons 행 삭제.
    db.prepare("DELETE FROM persons WHERE person_id = ?").run(person.personId);

    // node_person_edges 는 person FK CASCADE 가 살아 있어 정리된다.
    expect(countRows("node_person_edges", "person_id = ?", person.personId)).toBe(0);
    // participated_by 는 FK 0 인 entity_relation_edges 라 person 삭제로 안 지워진다 —
    // 끊긴 엣지로 잔존(정리는 app/wipe·spec §4.4). 옛 project_person_edges CASCADE 아님.
    expect(
      countRows(
        "entity_relation_edges",
        "target_id = ? AND relation = 'participated_by'",
        person.personId,
      ),
    ).toBe(1);
    // project 본체는 보존(사람 삭제가 프로젝트를 지우지 않는다).
    expect(countRows("entities", "entity_id = ?", project.projectId)).toBe(1);
  });

  test("게이트5 — entity_relation_edges·hierarchy_edges 는 다형 끝점이라 FK 0(거짓 CASCADE 안 만듦)", () => {
    // 두 테이블은 끝점 종류가 섞여(concept·person·8타입·project) 단일 FK 를 못 건다.
    // 그래서 entity 행 삭제가 이 엣지를 자동으로 안 지운다 — app 로직(reset·정리 사이클)이
    // 정리한다. 이 사실을 스키마로 명시 단언한다(거짓 CASCADE 기대 0·정직한 설계 진술).
    const fkList = (table: string): unknown[] =>
      db.prepare(`PRAGMA foreign_key_list(${table})`).all();
    expect(fkList("entity_relation_edges")).toEqual([]);
    expect(fkList("hierarchy_edges")).toEqual([]);
  });

  // ── 게이트 7 — special 칸 보존(work 4-tuple·person 신원) ───────────────────────

  test("게이트7 — work 정체성 4-tuple 충돌 0(동명이매체·동명이작가 별개 행·같은 4-tuple 한 행)", async () => {
    const novel = await store.entitiesRepo.findOrCreateEntity("work", "괴담", {
      medium: "소설",
      createdBy: "백덕수",
    });
    const webtoon = await store.entitiesRepo.findOrCreateEntity("work", "괴담", {
      medium: "웹툰",
      createdBy: "백덕수",
    });
    const otherAuthor = await store.entitiesRepo.findOrCreateEntity("work", "괴담", {
      medium: "소설",
      createdBy: "쓩늉",
    });
    // 같은 이름이라도 매체·작가가 다르면 별개 행(4-tuple 정체성).
    expect(new Set([novel.id, webtoon.id, otherAuthor.id]).size).toBe(3);
    // 같은 4-tuple 재호출은 같은 행(중복 0).
    const again = await store.entitiesRepo.findOrCreateEntity("work", "괴담", {
      medium: "소설",
      createdBy: "백덕수",
    });
    expect(again.id).toBe(novel.id);
    expect(countRows("entities", "type_name='work' AND name='괴담'")).toBe(3);
  });

  test("게이트7 — person 신원 합류(external_refs) 보존(person A·persons 테이블)", async () => {
    // 같은 어댑터 user_id 면 표시 이름이 달라도 같은 사람으로 합류(persons 전용 통로).
    const a = await store.findOrCreatePerson({
      displayName: "철수",
      userId: "discord-123",
      source: "discord",
    });
    const b = await store.findOrCreatePerson({
      displayName: "철수씨",
      userId: "discord-123",
      source: "discord",
    });
    expect(b.personId).toBe(a.personId); // 같은 user_id → 같은 사람(신원 합류).
    // 다른 user_id 는 동명이라도 별개 사람(동명이인 보존).
    const c = await store.findOrCreatePerson({
      displayName: "철수",
      userId: "discord-999",
      source: "discord",
    });
    expect(c.personId).not.toBe(a.personId);
    // person 은 persons 전용 테이블에 산다(person A — entities 미진입).
    expect(countRows("persons", "person_id = ?", a.personId)).toBe(1);
    expect(countRows("entities", "entity_id = ?", a.personId)).toBe(0);
  });
});
