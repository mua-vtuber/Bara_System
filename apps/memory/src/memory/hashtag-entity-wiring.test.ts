/**
 * hashtag-entity-wiring.test.ts — wireHashtagEntities(1.2 T10) 통합 검증.
 *
 * mock 0 — 실제 SQLite + bge-m3 임베딩 store 로 데이터 변경(persons/projects 행·
 * 고유 사실 칸·라벨 엣지·mentions 엣지·project_id)만 검증한다(CLAUDE.md "DB/임베딩
 * 의존 모듈은 실제 구현체와 통합 검증").
 *
 * 핵심 결정 = 주 엔티티(고유 사실을 한 사람에게 붙일지) + 모호 경고(추정 귀속 금지).
 * 각 테스트는 먼저 origin 노드를 store.addNode 로 만들고 그 id 를 넘긴다.
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
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { wireHashtagEntities } from "./hashtag-entity-wiring.ts";

describe("wireHashtagEntities — 해시태그 엔티티 입력 시점 wiring", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
  });

  afterAll(() => {});

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  /** origin 노드 한 개를 실제로 만들어 id 를 돌려준다. */
  async function makeOrigin(content: string): Promise<number> {
    return store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
  }

  function readProjectId(nodeId: number): string | null {
    const row = db
      .prepare("SELECT project_id FROM knowledge_nodes WHERE id = ?")
      .get(nodeId) as { project_id: string | null } | null;
    return row ? row.project_id : null;
  }

  test("등록 글 — 고유 사실 + 사람 1명이면 그 사람에게 사실·별칭·라벨이 붙는다", async () => {
    const content = "#사람:철수 #생일:1990-03-05 #닉네임:철이 #직업:개발자";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings).toEqual([]);
    expect(result.personIds).toHaveLength(1);
    expect(result.attributesApplied).toBe(1); // 생일 한 칸
    expect(result.labelsApplied).toBe(1); // 직업:개발자 한 라벨

    const person = await store.getPerson(result.personIds[0]!);
    expect(person).not.toBeNull();
    expect(person!.displayName).toBe("철수");
    expect(person!.birthday).toBe("1990-03-05");
    expect(person!.aliases).toContain("철이");

    // 직업:개발자 라벨이 has_attribute 로 사람에 잇혔다 — value 개념 '개발자'.
    const devId = await store.findOrCreateConcept("개발자");
    const persons = store.getPersonsByAttributeConcept(devId);
    expect(persons).toContain(result.personIds[0]!);
  });

  test("칸만 있는 등록 글(라벨 0)도 주 사람에게 mentions 1(글이 그 사람에 매달림·2026-06-15)", async () => {
    // 고유 사실만 있고 라벨이 없어도 철수는 등록되고, 그 등록 글은 철수에게 mentions
    // 엣지로 이어진다 — 그러면 글이 철수에 매달리고 철수 이름 검색에도 합류한다
    // (사용자 결정 2026-06-15·이놀부 케이스와 일관). 사람이 정확히 1명이라 추정 귀속
    // 위험이 없다(personCount===1 으로 모호 0). 한 사람당 mentions 엣지는 정확히 하나.
    const content = "#사람:철수 #생일:3월5일";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings).toEqual([]);
    expect(result.personIds).toHaveLength(1);
    expect(result.attributesApplied).toBe(1);
    expect(result.labelsApplied).toBe(0);

    const person = await store.getPerson(result.personIds[0]!);
    expect(person!.displayName).toBe("철수");
    expect(person!.birthday).toBe("3월5일");

    // 칸만 있는 등록 글도 주 사람에게 mentions 엣지 하나(중복·누락 0).
    const edges = await store.listNodePersonEdges({ nodeId: originId });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("mentions");
    expect(edges[0]!.personId).toBe(result.personIds[0]!);
  });

  test("이놀부 등록 글 — 관계·가족·별명·생일 섞인 등록 글도 주 사람에게 mentions 1(S1-LIVE 결함 가드)", async () => {
    // S1-LIVE 실측 결함: 이놀부 등록 글이 mentions 0 이라 그래프에서 글이 이놀부(위계
    // 잎)에 못 매달리고 막내(역할 개념)로 떨어졌다. factPersonId 확정 글에 mentions 를
    // 달아 글이 이놀부에 매달리고 검색에도 합류하게 한다(사용자 결정 2026-06-15). 별명·
    // 생일은 이놀부 person 행에 그대로(기존 동작 보존). #관계:가족·#가족:막내 는 person
    // 사슬 전담 키라 라벨로 안 새고(S1-T3c), 그래도 주 사람 mentions 는 선다.
    const content =
      "#사람:이놀부 #관계:가족 #가족:막내 #별명:놀부 #별명:셋째 #생일:1991년8월19일";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings).toEqual([]);
    expect(result.personIds).toHaveLength(1);
    // 관계·가족 키는 person 라벨로 안 샌다(라벨 0).
    expect(result.labelsApplied).toBe(0);

    const nolbu = await store.getPerson(result.personIds[0]!);
    expect(nolbu!.displayName).toBe("이놀부");
    expect(nolbu!.birthday).toBe("1991년8월19일"); // 생일 보존
    expect(nolbu!.aliases).toContain("놀부"); // 별명 보존
    expect(nolbu!.aliases).toContain("셋째");

    // 글→이놀부 mentions 엣지 하나(중복·누락 0) — 글이 이놀부에 매달리는 데이터 토대.
    const edges = await store.listNodePersonEdges({ nodeId: originId });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("mentions");
    expect(edges[0]!.personId).toBe(result.personIds[0]!);
  });

  test("인영희 등록 글 — 관계 라벨이 S1-T3c 로 빠져도 주 사람에게 mentions 1(이놀부와 일관)", async () => {
    // 이놀부와 같은 코드 경로로 인영희 등록 글도 글→인영희 mentions 가 선다 — 등록 글의
    // 주 사람 mentions 는 사람마다 일관되게 적용된다(특정 이름에 의존 0).
    const content = "#사람:인영희 #관계:가족 #가족:엄마";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    // #관계:가족·#가족:엄마 만 있어 고유 사실·별칭은 없지만, 이름 선언만으로 등록 글이
    // 되려면 등록 신호(고유 사실·별칭·라벨)가 필요하다. 관계 키는 라벨에서 빠지므로
    // (S1-T3c) 이 글은 사건 글 경로로 mentions 를 받는다 — 어느 경로든 글→인영희 1.
    expect(result.personIds).toHaveLength(1);
    const inyeonghui = await store.findPersonByName("인영희");
    expect(inyeonghui).not.toBeNull();

    const edges = await store.listNodePersonEdges({ nodeId: originId });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("mentions");
    expect(edges[0]!.personId).toBe(inyeonghui!.personId);
  });

  test("모호 — 고유 사실 + 사람 2명이면 아무에게도 안 붙이고 정직한 경고", async () => {
    const content = "#사람:철수 #사람:영희 #생일:1990-03-05";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.attributesApplied).toBe(0);
    expect(result.labelsApplied).toBe(0);
    expect(result.warnings.some((w) => w.includes("주 엔티티가 모호"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("#사람: 이 2개"))).toBe(true);

    // 두 사람에게 생일이 안 붙어야 한다(추정 귀속 금지) — persons 표가 비어 있다
    // (사건 글 mentions 경로도 안 탔다: 고유 사실이 있어 등록 글로 갈렸으나 모호).
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM persons").get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  test("사건 글 — 고유 사실 없고 사람 여럿이면 mentions 엣지만(사실·라벨 0)", async () => {
    const content = "#사람:철수 #사람:영희 오늘 같이 점심 먹음";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings).toEqual([]);
    expect(result.personIds).toHaveLength(2);
    expect(result.attributesApplied).toBe(0);
    expect(result.labelsApplied).toBe(0);

    const edges = await store.listNodePersonEdges({ nodeId: originId });
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.relation === "mentions")).toBe(true);
  });

  test("프로젝트 선언 + 삭제된 라벨 키 — project_id 만 설정하고 언어는 프로젝트 라벨로 먹지 않음", async () => {
    const content = "#프로젝트:바라 #언어:TS";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings).toEqual([]);
    expect(result.projectId).not.toBeNull();
    expect(result.labelsApplied).toBe(0);

    // origin 노드의 project_id 가 선언 프로젝트로 채워졌다.
    expect(readProjectId(originId)).toBe(result.projectId);

    // 제거된 프로젝트 라벨 키 '언어' 는 프로젝트 classification/tag 엣지를 만들지 않는다.
    const labels = await store.listProjectConcepts(result.projectId!);
    expect(labels).toEqual([]);
  });

  test("프로젝트 별칭 — #별칭 등록 후 별칭 선언이 같은 프로젝트를 가리킨다", async () => {
    const content = "#프로젝트:바라시스템 #별칭:바라";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings).toEqual([]);
    expect(result.projectId).not.toBeNull();
    const projectEntity = await store.entitiesRepo.get(result.projectId!);
    expect(projectEntity?.koAliases).toContain("바라");

    const aliasOriginId = await makeOrigin("#프로젝트:바라");
    const aliasResult = await wireHashtagEntities(
      store,
      aliasOriginId,
      "#프로젝트:바라",
    );

    expect(aliasResult.warnings).toEqual([]);
    expect(aliasResult.projectId).toBe(result.projectId);
    expect(readProjectId(aliasOriginId)).toBe(result.projectId);
  });

  test("프로젝트 + 사람 + 별칭 — 귀속 모호로 프로젝트 별칭에 붙이지 않는다", async () => {
    const content = "#프로젝트:바라 #사람:철수 #별칭:바시";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings.some((w) => w.includes("별칭 귀속 모호"))).toBe(true);
    const projectEntity = await store.entitiesRepo.get(result.projectId!);
    expect(projectEntity?.koAliases).not.toContain("바시");
  });

  test("프로젝트 + 사람 + 라벨 — 라벨은 프로젝트로, 선언된 사람은 mentions 로 잇힌다(F3 보정)", async () => {
    // 라벨은 프로젝트가 주 엔티티라 프로젝트로 간다(classification+tag). 같이 선언된
    // 철수는 글에 언급된 사람이므로 mentions 엣지를 한 개 받는다(검색 정합).
    // 프로젝트 라벨 어휘에 남은 #참여자 만 프로젝트 라벨로 먹는다. 사용자 실데이터
    // 양식대로 쉼표로 본문을 가른다(spec §3.2) → 라벨 값이 "철수" 로 잘린다.
    const content = "#프로젝트:바라 #사람:철수 #참여자:철수, 바라 프로젝트 철수랑 같이";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings).toEqual([]);
    expect(result.projectId).not.toBeNull();
    expect(result.labelsApplied).toBe(1); // 라벨은 프로젝트로 한 번

    // 라벨 '철수' 는 프로젝트에 잇혔지, 사람 속성으로는 안 붙었다(프로젝트가 주 엔티티).
    const participantConceptId = await store.findOrCreateConcept("철수");
    const projLabels = await store.listProjectConcepts(result.projectId!);
    expect(projLabels.some((l) => l.conceptId === participantConceptId)).toBe(true);
    expect(store.getPersonsByAttributeConcept(participantConceptId)).toHaveLength(0);

    // 철수는 mentions 엣지 한 개(중복 없음).
    expect(result.personIds).toHaveLength(1);
    const edges = await store.listNodePersonEdges({ nodeId: originId });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("mentions");
    expect(edges[0]!.personId).toBe(result.personIds[0]!);
  });

  test("프로젝트 + 사람(라벨 없음) — 철수 mentions 1(F3 전 동작 보존, 회귀 가드)", async () => {
    const content = "#프로젝트:바라 #사람:철수 회의에 철수가 왔다";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings).toEqual([]);
    expect(result.projectId).not.toBeNull();
    expect(result.labelsApplied).toBe(0);
    expect(result.attributesApplied).toBe(0);

    expect(result.personIds).toHaveLength(1);
    const edges = await store.listNodePersonEdges({ nodeId: originId });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("mentions");
    expect(edges[0]!.personId).toBe(result.personIds[0]!);
  });

  test("파싱 실패 정직 — 깨진 예약 키는 경고로 흐르되 살아남은 라벨은 그 사람에 등록(Q21)", async () => {
    // '#생일:' 은 값이 비어 깨졌다(파싱 실패 경고). 하지만 '#직업:개발자' 라벨은
    // 멀쩡하므로 Q21 에 따라 칸 없이도 철수에게 붙는다(라벨만으로 등록). 철수는 라벨이
    // 잇히면서 검색 정합용 mentions 엣지도 한 개 받는다.
    const content = "#사람:철수 #생일: #직업:개발자";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    // 깨진 '#생일:' 이 파싱 실패 경고로 떴다.
    expect(result.warnings.some((w) => w.includes("파싱 실패") && w.includes("생일"))).toBe(true);
    // 깨진 생일 칸은 안 붙고, 라벨은 철수에게 붙는다(Q21 — 라벨만으로 등록).
    expect(result.attributesApplied).toBe(0);
    expect(result.labelsApplied).toBe(1);
    expect(result.personIds).toHaveLength(1);

    const devId = await store.findOrCreateConcept("개발자");
    expect(store.getPersonsByAttributeConcept(devId)).toContain(result.personIds[0]!);

    const edges = await store.listNodePersonEdges({ nodeId: originId });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("mentions");
  });

  test("라벨 미반영 — 사람도 프로젝트도 없으면 라벨은 붙을 곳이 없어 정직한 경고", async () => {
    // 선언된 사람·프로젝트가 하나도 없으면 라벨이 붙을 주 엔티티가 없다. 조용히
    // 버리지 않고 정직하게 미반영 경고를 남긴다(silent drop 금지).
    const content = "#직업:개발자 #회사:바라";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.labelsApplied).toBe(0);
    expect(result.personIds).toEqual([]);
    expect(result.warnings.some((w) => w.includes("라벨 미반영"))).toBe(true);

    const edges = await store.listNodePersonEdges({ nodeId: originId });
    expect(edges).toHaveLength(0);
  });

  test("라벨만 등록 — 칸 없이 라벨만 있어도 사람 1명에게 라벨이 붙는다(Q21)", async () => {
    const content = "#사람:철수 #직업:개발자";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings).toEqual([]);
    expect(result.personIds).toHaveLength(1);
    expect(result.attributesApplied).toBe(0); // 칸 없음
    expect(result.labelsApplied).toBe(1); // 직업:개발자

    const person = await store.getPerson(result.personIds[0]!);
    expect(person).not.toBeNull();
    expect(person!.displayName).toBe("철수");

    const devId = await store.findOrCreateConcept("개발자");
    expect(store.getPersonsByAttributeConcept(devId)).toContain(result.personIds[0]!);

    // 검색 정합 — 라벨 등록 사람은 origin 에 mentions 엣지로도 잇혀야 한다(중복 없이 1개).
    const edges = await store.listNodePersonEdges({ nodeId: originId });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("mentions");
    expect(edges[0]!.personId).toBe(result.personIds[0]!);
  });

  test("라벨 전원 — 라벨은 선언된 모든 사람에게 붙는다(Q22)", async () => {
    const content = "#사람:철수 #사람:민수 #직업:개발자";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings).toEqual([]);
    expect(result.personIds).toHaveLength(2);
    expect(result.attributesApplied).toBe(0);
    expect(result.labelsApplied).toBe(2); // 두 사람 × 한 라벨

    const devId = await store.findOrCreateConcept("개발자");
    const labeled = store.getPersonsByAttributeConcept(devId);
    for (const pid of result.personIds) {
      expect(labeled).toContain(pid);
    }

    // 두 사람 모두 origin 에 mentions 로 잇힌다(중복 없이 각 1개).
    const edges = await store.listNodePersonEdges({ nodeId: originId });
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.relation === "mentions")).toBe(true);
  });

  test("고유 사실 칸은 1명만 — 사람 2명 + 생일이면 칸은 아무에게도 안 붙고 모호 경고(Q22)", async () => {
    const content = "#사람:철수 #사람:민수 #생일:3월5일";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.attributesApplied).toBe(0);
    expect(result.labelsApplied).toBe(0);
    expect(result.warnings.some((w) => w.includes("주 엔티티가 모호"))).toBe(true);

    // 생일은 고유 사실 칸이라 여러 사람에 못 붙는다 — 아무도 안 만들어진다.
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM persons").get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  test("독립 적용 — 사람 2명 + 생일 + 직업이면 직업은 전원, 생일은 모호 경고(Q22)", async () => {
    const content = "#사람:철수 #사람:민수 #생일:3월5일 #직업:개발자";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    // 직업 라벨은 두 사람 전원에게.
    expect(result.labelsApplied).toBe(2);
    // 생일 칸은 고유 사실이라 모호 경고로 미반영.
    expect(result.attributesApplied).toBe(0);
    expect(result.warnings.some((w) => w.includes("주 엔티티가 모호"))).toBe(true);

    expect(result.personIds).toHaveLength(2);
    const devId = await store.findOrCreateConcept("개발자");
    const labeled = store.getPersonsByAttributeConcept(devId);
    for (const pid of result.personIds) {
      expect(labeled).toContain(pid);
      const person = await store.getPerson(pid);
      expect(person!.birthday).toBeNull(); // 생일은 아무에게도 안 붙었다
    }

    // 두 사람 mentions(중복 없이).
    const edges = await store.listNodePersonEdges({ nodeId: originId });
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.relation === "mentions")).toBe(true);
  });

  test("콜론 라벨 위계 weight — category→value parent_of 엣지는 0.9 확정(회귀 가드, Task 4)", async () => {
    // 콜론 라벨(`#직업:개발자`)은 사용자의 명시 선언이라 category→value parent_of
    // 엣지를 확정 강도 0.9 로 잇는다. 누가 옛 promoter 시절 시작값 0.3 으로 되돌려도
    // 이 단언이 잡는다. 라벨이 실제 개념 엣지를 만들려면 주 엔티티(사람) 한 명이
    // 필요하므로(1.2 동작) `#사람:철수` 를 같이 둔다 — '라벨만 등록' 케이스와 같은 셋업.
    const content = "#사람:철수 #직업:개발자";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings).toEqual([]);
    expect(result.labelsApplied).toBe(1);

    // category '직업' → value '개발자' parent_of 엣지를 찾아 weight 가 0.9 인지 단언.
    // S0-T4(위계 단일 출처) — 위계는 hierarchy_edges 에서 본다.
    const categoryId = await store.findOrCreateConcept("직업");
    const valueId = await store.findOrCreateConcept("개발자");
    const parentEdges = store.getHierarchyEdgesWithin([categoryId, valueId]);
    const edge = parentEdges.find(
      (e) => e.sourceId === categoryId && e.targetId === valueId,
    );
    expect(edge).toBeDefined();
    expect(edge!.weight).toBe(0.9);
  });

  test("person 사슬 전담 키 라벨 제외 — #관계:가족 #가족:엄마 은 라벨로 안 새고 관계→가족 잉여 위계·인영희↔가족/엄마 has_attribute 0(S1-T3c)", async () => {
    // person 위계 사슬을 전담하는 두 갈래 키는 person 라벨로 처리하지 않는다:
    //   (1) 타입 지시 키 '관계'(synonyms: 사람·인물·관계) — 관계 선언 지붕.
    //   (2) 관계 어휘 키 '가족'(lookupRelationTag → family_of) — person-relation-chain 이
    //       가족→엄마→인영희 사슬로 이미 완전 표현하는 키.
    // 옛 동작은 `#관계:가족` 을 라벨로 갈라 관계→가족 parent_of 잉여 위계 + 인영희↔가족
    // has_attribute 잉여를 세웠고(사용자 라이브 지적: 갈래로 사람>가족>관계 가 뜸), `#가족:엄마`
    // 도 라벨로 떨어져 인영희↔엄마 has_attribute 잉여를 붙였다. 두 갈래 키 라벨 제외로 셋 다
    // 안 선다 — 관계·위계 정보는 person-relation-chain 이 사슬로 따로 세운다(보존·중복 0).
    // 이 테스트는 wireHashtagEntities 단독이라 그 사슬은 안 보고, 잉여 부재만 본다.
    const content = "#사람:인영희 #관계:가족 #가족:엄마";
    const originId = await makeOrigin(content);

    await wireHashtagEntities(store, originId, content);

    // (1) 잉여 위계 관계→가족 (parent_of) 가 없어야 한다 — 타입 지시 키 라벨 제외의 핵심.
    const gwanggyeId = await store.findOrCreateConcept("관계");
    const gajokId = await store.findOrCreateConcept("가족");
    const omaId = await store.findOrCreateConcept("엄마");
    const edges = store.getHierarchyEdgesWithin([gwanggyeId, gajokId, omaId]);
    const stray = edges.find(
      (e) => e.sourceId === gwanggyeId && e.targetId === gajokId,
    );
    expect(stray).toBeUndefined();

    // (2) 인영희에 '가족'·'엄마' has_attribute 가 둘 다 안 붙어야 한다 — person 사슬 전담
    //     키(관계·가족) 라벨이 person 속성으로 새지 않는다.
    const inyeonghui = await store.findPersonByName("인영희");
    expect(inyeonghui).not.toBeNull();
    const gajokAttrPersons = store.getPersonsByAttributeConcept(gajokId);
    expect(gajokAttrPersons).toEqual([]);
    const omaAttrPersons = store.getPersonsByAttributeConcept(omaId);
    expect(omaAttrPersons).toEqual([]);
  });

  test("#나 #생일 → 홍길동 생일 등록(별명 주 엔티티)", async () => {
    const gildong = await store.findOrCreatePersonByName("홍길동");
    await store.addPersonAlias(gildong.personId, "나");
    const content = "#나 #생일:0000년0월0일";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.attributesApplied).toBe(1);
    const person = await store.getPerson(gildong.personId);
    expect(person?.birthday).toBe("0000년0월0일");
  });

  test("#사람:나 #생일 → 별칭 선언도 홍길동에게 등록하고 새 사람 '나' 를 만들지 않음", async () => {
    const gildong = await store.findOrCreatePersonByName("홍길동");
    await store.addPersonAlias(gildong.personId, "나");
    const content = "#사람:나 #생일:0000년0월0일";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.attributesApplied).toBe(1);
    expect(result.personIds).toEqual([gildong.personId]);
    expect((await store.getPerson(gildong.personId))?.birthday).toBe("0000년0월0일");
    expect(await store.findPersonByName("나")).toBeNull();
  });

  test("#사람:홍길동 #생일 → 생일 등록(콜론 선언, 회귀 불변)", async () => {
    const content = "#사람:홍길동 #생일:0000년0월0일";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.attributesApplied).toBe(1);
    const gildong = await store.findPersonByName("홍길동");
    expect(gildong?.birthday).toBe("0000년0월0일");
  });

  test("#나 #직업:나무꾼 → 홍길동에 라벨 + personIds 포함", async () => {
    const gildong = await store.findOrCreatePersonByName("홍길동");
    await store.addPersonAlias(gildong.personId, "나");
    const content = "#나 #직업:나무꾼";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.labelsApplied).toBe(1);
    expect(result.personIds).toContain(gildong.personId);
  });

  test("#사람:홍길동 #나 #생일 → 같은 사람 1명, 중복 없이 생일 등록", async () => {
    const gildong = await store.findOrCreatePersonByName("홍길동");
    await store.addPersonAlias(gildong.personId, "나");
    const content = "#사람:홍길동 #나 #생일:0000년0월0일";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.attributesApplied).toBe(1);
    expect(result.warnings).toEqual([]);
    const person = await store.getPerson(gildong.personId);
    expect(person?.birthday).toBe("0000년0월0일");
  });

  test("모호 별명(2명+) #셋째 #생일 → 정보 미반영 + 모호 경고", async () => {
    const a = await store.findOrCreatePersonByName("홍길동");
    const b = await store.findOrCreatePersonByName("이몽룡");
    await store.addPersonAlias(a.personId, "셋째");
    await store.addPersonAlias(b.personId, "셋째");
    const content = "#셋째 #생일:1990년1월1일";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.attributesApplied).toBe(0);
    expect(result.warnings.some((w) => w.includes("셋째") && w.includes("모호"))).toBe(true);
    expect((await store.getPerson(a.personId))?.birthday ?? null).toBeNull();
    expect((await store.getPerson(b.personId))?.birthday ?? null).toBeNull();
  });

  test("등록 신호 없는 #나 사건 글 → wireHashtagEntities 는 병합 안 함", async () => {
    const gildong = await store.findOrCreatePersonByName("홍길동");
    await store.addPersonAlias(gildong.personId, "나");
    const content = "#나 그냥 메모";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.attributesApplied).toBe(0);
    expect(result.labelsApplied).toBe(0);
    expect(result.personIds).toEqual([]);
  });

  test("태그 0개 평범한 글 — 엔티티·경고 0(real empty state)", async () => {
    const content = "오늘 날씨가 좋다";
    const originId = await makeOrigin(content);

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.personIds).toEqual([]);
    expect(result.projectId).toBeNull();
    expect(result.attributesApplied).toBe(0);
    expect(result.labelsApplied).toBe(0);
    expect(result.warnings).toEqual([]);

    const cnt = db.prepare("SELECT COUNT(*) AS c FROM persons").get() as { c: number };
    expect(cnt.c).toBe(0);
  });
});
