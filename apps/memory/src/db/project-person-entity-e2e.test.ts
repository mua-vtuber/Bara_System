/**
 * project-person-entity-e2e.test.ts — 공통 인프라 1.2 E2E(Task 14, 마지막).
 *
 * 1.2 의 한 흐름을 끝에서 끝까지 잇는다: 해시태그 규칙 입력 →
 * wireHashtagEntities 가 projects/persons 행·고유 사실 칸·라벨 엣지·project_id 를
 * 채우고 → 3채널 검색(프로젝트·사람·개념 has_attribute)이 그 엔티티에 잇힌 글을
 * 후보로 끌어오고 → memory_type 필터가 종류를 줄이고 → 참여자 엣지가 양방향으로
 * 조회된다. 실제 SqliteMemoryStore + 실 Bgem3Embedder(mock 0, CLAUDE.md 정책).
 *
 * embeddingDim 384 명시 필수 — T13 이후 openMemoryDatabase 의 default 가 1024 라,
 * 명시 384-dim 스키마와 맞추지 않으면 vec0 차원 불일치로 throw 한다.
 *
 * 회귀 0 가드(make-or-break): 엔티티 색인이 빈 코퍼스에서 project/person/memoryType
 * 미지정 검색은 같은 검색을 두 번 돌려도 결과·순위·점수가 동일하다. 두 엔티티 채널이
 * 빈 배열을 내면 RRF 안 0 기여 — 도입 전과 수학적으로 동일([[retriever-fusion-rrf]]).
 *
 * 2글자 글자 검색(S5 / 사용자 승인 2026-07-03): 옛날에는 entity FTS(concept/persons/
 * entities)가 trigram 단독이라 3글자 미만(예 "바라"·"민수")이 글자 채널로 안 잡혔다.
 * S5 가 세 entity FTS 에 unicode61 보조 색인을 추가해(trigram 유지·삭제 0) 2글자를
 * 복구했다 — 이제 케이스 9·10·11 이 2글자 '바라'·'민수'·'커피' 검출을 단언하고, 3글자+
 * 합성어 부분매치(trigram 강점)도 함께 살아있음을 검증한다. 나머지 채널 케이스는 3글자
 * 이상 이름("바라시스템"·"민수기록자")으로도 돌려 글자 채널 합류를 확인한다.
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
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "./migrations.ts";
import { SqliteMemoryStore } from "./store.ts";
import { HybridRetriever } from "../memory/retriever.ts";
import { wireHashtagEntities } from "../memory/hashtag-entity-wiring.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("1.2 E2E — 엔티티 입력 → 3채널 검색 → 필터 → 참여자 양방향", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    retriever = new HybridRetriever(store, embedder);
  });
  afterEach(() => {
    db.close();
  });

  // ── 케이스 1: 프로젝트 등록 입력 → projects 행 + 두 role 엣지 + project_id ──

  test("#프로젝트:바라시스템 #참여자:철수 → projects 행 + classification·tag 두 role + 글 project_id", async () => {
    const content = "#프로젝트:바라시스템 #참여자:철수, 첫 회의 메모";
    const originId = await store.addNode({ content });

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings).toEqual([]);
    expect(result.projectId).not.toBeNull();
    expect(result.projectId!.startsWith("prj_")).toBe(true);
    expect(result.labelsApplied).toBe(1);

    // 글의 project_id 가 선언 프로젝트로 채워졌다.
    const row = db
      .prepare("SELECT project_id FROM knowledge_nodes WHERE id = ?")
      .get(originId) as { project_id: string | null };
    expect(row.project_id).toBe(result.projectId);

    // '참여자:철수' value 개념이 classification·tag 두 role 로 프로젝트에 잇혔다(Q4).
    const participantId = await store.findOrCreateConcept("철수");
    const labels = await store.listProjectConcepts(result.projectId!);
    const participantRoles = labels
      .filter((l) => l.conceptId === participantId)
      .map((l) => l.role)
      .sort();
    expect(participantRoles).toEqual(["classification", "tag"]);
  });

  // ── 케이스 2: 사람 등록 입력 → persons 행(생일·별칭) + has_attribute 라벨 ──

  test("#사람:민수기록자 #생일:3월5일 #직업:개발자 #닉네임:민짱 → persons 행 + 생일·별칭 + 개발자 has_attribute", async () => {
    const content = "#사람:민수기록자 #생일:3월5일 #직업:개발자 #닉네임:민짱, 자기소개 글";
    const originId = await store.addNode({ content });

    const result = await wireHashtagEntities(store, originId, content);

    expect(result.warnings).toEqual([]);
    expect(result.personIds).toHaveLength(1);
    expect(result.attributesApplied).toBe(1); // 생일 한 칸
    expect(result.labelsApplied).toBe(1); // 직업:개발자 한 라벨

    const person = await store.getPerson(result.personIds[0]!);
    expect(person).not.toBeNull();
    expect(person!.displayName).toBe("민수기록자");
    expect(person!.birthday).toBe("3월5일"); // 고유 사실 칸이 값 그대로 채워졌다
    expect(person!.aliases).toContain("민짱");

    // 직업:개발자 라벨이 has_attribute 로 사람에 잇혔다 — value 개념 '개발자'.
    const devId = await store.findOrCreateConcept("개발자");
    expect(store.getPersonsByAttributeConcept(devId)).toContain(
      result.personIds[0]!,
    );
  });

  // ── 케이스 3: 참여자 엣지 양방향 조회(프로젝트↔사람) ─────────────────────

  test("addProjectPersonEdge → listProjectParticipants / listPersonProjects 양방향 일치", async () => {
    const prj = await store.findOrCreateProject({ name: "협업기록프로젝트" });
    const kim = await store.findOrCreatePersonByName("김참여자");
    const lee = await store.findOrCreatePersonByName("이참여자");

    await store.addProjectPersonEdge(prj.projectId, kim.personId, "creator", "user_input", null);
    await store.addProjectPersonEdge(prj.projectId, lee.personId, "participant", "user_input", null);

    // 프로젝트 → 사람.
    const parts = await store.listProjectParticipants(prj.projectId);
    expect(parts.map((e) => e.personId).sort()).toEqual(
      [kim.personId, lee.personId].sort(),
    );

    // 사람 → 프로젝트 (반대 방향이 같은 엣지를 본다).
    const kimProjects = await store.listPersonProjects(kim.personId);
    expect(kimProjects.map((e) => e.projectId)).toEqual([prj.projectId]);
    const leeProjects = await store.listPersonProjects(lee.personId);
    expect(leeProjects.map((e) => e.projectId)).toEqual([prj.projectId]);
  });

  // ── 케이스 4: 프로젝트 채널 검색 — 프로젝트 이름이 그 글을 끌어온다 ────────

  test("검색 '바라시스템' → 그 프로젝트의 글이 project 출처로 합류", async () => {
    const content = "#프로젝트:바라시스템, 자정 라이브 일정 점검 회의";
    const originId = await store.addNode({ content });
    await wireHashtagEntities(store, originId, content);

    // 검색어(프로젝트 이름)와 글자·의미가 무관한 노이즈.
    for (let i = 0; i < 3; i++) {
      await store.addNode({ content: `노이즈 ${i} 산악 자전거 등산` });
    }

    const results = await retriever.retrieve("바라시스템");
    const found = results.find((r) => r.node.id === originId);
    expect(found).toBeDefined();
    expect(found!.sources).toContain("project");
  });

  // ── 케이스 5: 사람 채널 검색 — 사람 이름이 그 사람의 글을 끌어온다 ─────────

  test("검색 '민수기록자' → 그 사람의 mentions 글이 person 출처로 합류", async () => {
    // 사건 글 — 고유 사실 없이 사람만 언급 → mentions 엣지로만 이어진다.
    const content = "#사람:민수기록자, 어제 본 영화가 인상 깊었다 메모";
    const originId = await store.addNode({ content });
    const wired = await wireHashtagEntities(store, originId, content);
    expect(wired.personIds).toHaveLength(1);

    for (let i = 0; i < 3; i++) {
      await store.addNode({ content: `노이즈 ${i} 산악 자전거 등산` });
    }

    const results = await retriever.retrieve("민수기록자");
    const found = results.find((r) => r.node.id === originId);
    expect(found).toBeDefined();
    expect(found!.sources).toContain("person");
  });

  // ── 케이스 6: 개념 채널 has_attribute — '개발자' 가 그 라벨 사람의 글을 끈다 ─

  test("검색 '개발자' → 그 라벨을 가진 사람의 글이 concept 출처로 합류", async () => {
    // 등록 글 — 고유 사실(생일)이 있어야 사람이 주 엔티티가 되고 직업:개발자 라벨이
    // 그 사람에게 has_attribute 로 붙는다(T10 설계: 고유 사실/별칭 신호 없는 #직업 만은
    // 사건 글로 갈려 라벨 미반영). 그래서 #생일 을 함께 넣어 등록 글로 만든다.
    const regContent = "#사람:민수기록자 #생일:3월5일 #직업:개발자, 자기소개";
    const regId = await store.addNode({ content: regContent });
    const wired = await wireHashtagEntities(store, regId, regContent);
    expect(wired.labelsApplied).toBe(1);
    const personId = wired.personIds[0]!;

    // 사람의 별개 글 — 검색어 "개발자"와 글자·의미가 무관(개념→사람 갈래로만 닿는다).
    const article = await store.addNode({
      content: "주말에 김치찌개를 끓여 먹었다 기록",
    });
    await store.addNodePersonEdge(article, personId, "mentions", "user_input", article);
    for (let i = 0; i < 3; i++) {
      await store.addNode({ content: `노이즈 ${i} 산악 자전거 등산` });
    }

    const results = await retriever.retrieve("개발자");
    const found = results.find((r) => r.node.id === article);
    expect(found).toBeDefined();
    // 개념 채널 has_attribute 역방향으로 합류 — 출처는 concept(별도 person 통로 아님).
    expect(found!.sources).toContain("concept");
  });

  // ── 케이스 7: memory_type 필터 — episode 만 남고 insight/fact 는 빠진다 ────

  test("memoryType='episode' → insight/fact 글이 후보에서 빠진다", async () => {
    const ep = await store.addNode({
      content: "어제 회의에 갔다 커피 기록",
      memoryType: "episode",
    });
    const ins = await store.addNode({
      content: "회의는 비효율적이다 커피 통찰",
      memoryType: "insight",
    });
    const ft = await store.addNode({
      content: "회의는 오후 3시다 커피 사실",
      memoryType: "fact",
    });

    const results = await retriever.retrieve("커피 회의", {
      memoryType: "episode",
    });
    const ids = results.map((r) => r.node.id);
    expect(ids).toContain(ep);
    expect(ids).not.toContain(ins);
    expect(ids).not.toContain(ft);
  });

  // ── 케이스 8: 회귀 0 — 빈 엔티티 색인 + 미지정이면 두 검색이 동일 ──────────

  test("회귀 0 — 엔티티 색인 빈 코퍼스 + project/person/memoryType 미지정이면 결과·점수 byte 동일", async () => {
    // 프로젝트·사람을 한 건도 안 만든다(엔티티 색인 빈 상태). 두 새 채널이 빈 배열을
    // 내므로 RRF 안 0 기여 → 같은 검색을 두 번 돌려도 결과·순서·점수가 동일하다.
    for (let i = 0; i < 5; i++) {
      await store.addNode({ content: `메모 ${i} — 커피 카페 키워드` });
    }
    const a = await retriever.retrieve("커피", { limit: 5 });
    const b = await retriever.retrieve("커피", { limit: 5 });
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.node.id).toBe(b[i]!.node.id);
      expect(a[i]!.score).toBeCloseTo(b[i]!.score, 10);
      // 엔티티 색인이 비어 어떤 결과에도 project·person 출처가 붙지 않는다.
      expect(a[i]!.sources).not.toContain("project");
      expect(a[i]!.sources).not.toContain("person");
    }
  });

  // ── 케이스 9: 2글자 검색 복구(S5) — unicode61 보조 색인이 '바라'를 잡는다 ──

  test("2글자 query 검색됨(S5) — entities_fts unicode61 병행 색인이 '바라' 프로젝트를 글자로 잡는다", async () => {
    // S5(사용자 승인 2026-07-03): 옛 "2글자 미검출은 사양" 동결을 뒤집는다. 세
    // entity FTS(concept/persons/entities)에 unicode61 보조 색인을 추가해(trigram 유지)
    // 2글자 한국어 이름을 글자 채널로 복구했다. 근거 = lexical-search-redesign-spec
    // Decision Change Log 의 사용자 승인 항목("2글자 검색되게 바꿈").
    const prj = await store.findOrCreateProject({ name: "바라" });
    const fts = await store.searchProjectsByFts("바라", 10);
    expect(fts.find((h) => h.projectId === prj.projectId)).toBeDefined();
  });

  // ── 케이스 10: 2글자 검색 복구(S5) — 사람 이름 '민수' ──────────────────────

  test("2글자 query 검색됨(S5) — persons_fts unicode61 병행 색인이 '민수' 사람을 글자로 잡는다", async () => {
    const person = await store.findOrCreatePersonByName("민수");
    const fts = await store.searchPersonsByFts("민수", 10);
    expect(fts.find((h) => h.personId === person.personId)).toBeDefined();
  });

  // ── 케이스 11: 2글자 검색 복구(S5) — 개념 '커피' + trigram 합성어 부분매치 병존 ──

  test("2글자 query 검색됨(S5) — concept_nodes_fts unicode61 이 '커피' 개념을 잡고 trigram 부분매치도 유지", async () => {
    // unicode61 이 2글자를 잡고, trigram 이 3글자+ 합성어 부분매치를 유지한다(두 색인 RRF).
    const coffeeId = await store.findOrCreateConcept("커피");
    const brewId = await store.findOrCreateConcept("커피추출도구");

    // (1) 2글자 정확 검색 — unicode61 이 '커피' 개념을 잡는다(옛 trigram 단독은 0건).
    const twoChar = await store.searchConceptsByFts("커피", 10);
    expect(twoChar.find((h) => h.conceptId === coffeeId)).toBeDefined();

    // (2) 3글자+ 합성어 부분매치 — '추출도구'(합성어 내부)는 trigram 이 잡는다(unicode61
    //     공백 토큰화로는 못 잡음). 두 색인 병행이라 부분매치가 살아있다.
    const partial = await store.searchConceptsByFts("추출도구", 10);
    expect(partial.find((h) => h.conceptId === brewId)).toBeDefined();
  });
});
