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
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { ConceptRepository } from "./concept-repository.ts";
import { EdgeRepository } from "./edge-repository.ts";
import { PersonRepository } from "./person-repository.ts";

const TEST_PROVENANCE = "system" as const;
const TEST_SOURCE_NODE_ID = null;

// 실제 임베딩 모델(bge-m3 1024) — mock 금지(CLAUDE.md). person_vec 이 float[1024]
// 라 차원이 정확히 맞는다. 한 번 load 해서 모든 테스트가 공유한다.
let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("PersonRepository — persons 직접 CRUD", () => {
  let db: Database;
  let repo: PersonRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new PersonRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("findOrCreatePerson — 같은 source+userId 두 번이면 같은 psn_ (재사용)", async () => {
    const first = await repo.findOrCreatePerson({ displayName: "친구", userId: "u1", source: "discord" });
    const second = await repo.findOrCreatePerson({ displayName: "친구", userId: "u1", source: "discord" });
    expect(first.personId).toBe(second.personId);
    expect(first.personId.startsWith("psn_")).toBe(true);
    const all = db.prepare("SELECT COUNT(*) AS c FROM persons").get() as { c: number };
    expect(all.c).toBe(1);
  });

  test("findOrCreatePerson — displayName 새 별칭이면 aliases 누적", async () => {
    const orig = await repo.findOrCreatePerson({ displayName: "친구A", userId: "u1", source: "discord" });
    const renamed = await repo.findOrCreatePerson({ displayName: "친구B", userId: "u1", source: "discord" });
    expect(renamed.personId).toBe(orig.personId);
    expect(renamed.aliases).toContain("친구A");
    expect(renamed.aliases).toContain("친구B");
  });

  test("findOrCreatePerson — 다른 source 같은 user_id 는 별 사람", async () => {
    const a = await repo.findOrCreatePerson({ displayName: "x", userId: "u1", source: "discord" });
    const b = await repo.findOrCreatePerson({ displayName: "y", userId: "u1", source: "notion" });
    expect(a.personId).not.toBe(b.personId);
  });

  test("userId / displayName 빈 = throw", async () => {
    await expect(repo.findOrCreatePerson({ displayName: "x", userId: "" })).rejects.toThrow(/userId/);
    await expect(repo.findOrCreatePerson({ displayName: "  ", userId: "u1" })).rejects.toThrow(/displayName/);
  });

  test("findOrCreatePersonByName — 같은 이름 두 번이면 같은 psn_ 재사용 + external_refs 빈", async () => {
    const first = await repo.findOrCreatePersonByName("철수");
    const second = await repo.findOrCreatePersonByName("철수");
    expect(first.personId).toBe(second.personId);
    expect(first.personId.startsWith("psn_")).toBe(true);
    // 의미 채널 사람 선언이라 작성자 userId 를 안 찍는다 — external_refs 가 빈.
    expect(first.externalRefs).toEqual({});
    const all = db.prepare("SELECT COUNT(*) AS c FROM persons").get() as { c: number };
    expect(all.c).toBe(1);
  });

  test("findOrCreatePersonByName — 다른 이름은 다른 사람 + 빈 이름 throw", async () => {
    const a = await repo.findOrCreatePersonByName("철수");
    const b = await repo.findOrCreatePersonByName("영희");
    expect(a.personId).not.toBe(b.personId);
    await expect(repo.findOrCreatePersonByName("  ")).rejects.toThrow(/displayName/);
  });

  test("findPersonByName — 있는 사람은 찾고, 없는 이름은 null + 행 생성 0", async () => {
    // 먼저 한 사람을 등록한다(이름 선언 통로).
    const registered = await repo.findOrCreatePersonByName("민수");
    const before = (db.prepare("SELECT COUNT(*) AS c FROM persons").get() as { c: number }).c;

    // 같은 이름 조회 — 만들지 않고 등록된 그 사람을 돌려준다.
    const found = await repo.findPersonByName("민수");
    expect(found).not.toBeNull();
    expect(found!.personId).toBe(registered.personId);

    // 없는 이름 조회 — null + 행 생성 0(조회 전용, DB 변경 없음).
    const missing = await repo.findPersonByName("없는이름");
    expect(missing).toBeNull();
    const after = (db.prepare("SELECT COUNT(*) AS c FROM persons").get() as { c: number }).c;
    expect(after).toBe(before); // 조회만 — 행 수 불변(민수 1명 그대로).
  });

  test("findPersonByName — 동명이인(同名異人) 두 명이면 rowid 가장 작은(먼저 등록한) 사람", async () => {
    // 같은 이름으로 두 행을 직접 넣는다(findOrCreatePersonByName 은 재사용이라
    // 두 행을 못 만든다 — 동명이인은 다른 통로로 들어온 상황을 재현).
    const now = "2026-06-06T00:00:00+09:00";
    db.prepare(
      `INSERT INTO persons (person_id, display_name, aliases, external_refs, created_at, updated_at)
       VALUES (?, '민수', '["민수"]', '{}', ?, ?)`,
    ).run("psn_first", now, now);
    db.prepare(
      `INSERT INTO persons (person_id, display_name, aliases, external_refs, created_at, updated_at)
       VALUES (?, '민수', '["민수"]', '{}', ?, ?)`,
    ).run("psn_second", now, now);

    // 먼저 등록(rowid min)한 psn_first 를 돌려준다 — spec 3.7.9 한계 명시.
    const found = await repo.findPersonByName("민수");
    expect(found!.personId).toBe("psn_first");
  });

  test("findPersonByName — 빈 이름은 null (조회 입력 무효, throw 아님)", async () => {
    expect(await repo.findPersonByName("  ")).toBeNull();
    expect(await repo.findPersonByName("")).toBeNull();
  });

  test("addNodePersonEdge — relation 별 엣지 + 중복 false + FK CASCADE", async () => {
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES ('글')").run();
    const nodeId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    const p = await repo.findOrCreatePerson({ displayName: "사용자", userId: "u9", source: "discord" });

    expect(await repo.addNodePersonEdge(nodeId, p.personId, "authored_by", TEST_PROVENANCE, nodeId)).toBe(true);
    expect(await repo.addNodePersonEdge(nodeId, p.personId, "authored_by", "hashtag", 999)).toBe(false);
    expect(await repo.addNodePersonEdge(nodeId, p.personId, "mentions", TEST_PROVENANCE, nodeId)).toBe(true);

    const edges = await repo.listNodePersonEdges({ nodeId });
    expect(edges.length).toBe(2);
    const authored = db
      .prepare(
        `SELECT provenance, source_node_id FROM node_person_edges
         WHERE node_id = ? AND person_id = ? AND relation = 'authored_by'`,
      )
      .get(nodeId, p.personId) as { provenance: string; source_node_id: number };
    expect(authored.provenance).toBe("system");
    expect(authored.source_node_id).toBe(nodeId);

    db.prepare("DELETE FROM knowledge_nodes WHERE id = ?").run(nodeId);
    const after = await repo.listNodePersonEdges({ nodeId });
    expect(after.length).toBe(0);
  });

  // ── 1.2 T5: 고유 사실 칸 + 별칭 + 임베딩 + 직업 라벨 연결 ─────────────

  test("updatePersonFacts — 부분 갱신 + birthday 가 persons_fts 트리거로 재색인", async () => {
    // trigram 검색은 3글자 이상이라 3글자 이름을 쓴다(Task 1 발견).
    const p = await repo.findOrCreatePerson({ displayName: "김민수", userId: "u1", source: "discord" });

    const updated = await repo.updatePersonFacts(p.personId, {
      birthday: "1990-03-15",
      gender: "남",
      attributes: { 혈액형: "A", mbti: "INTJ" },
    });
    expect(updated).not.toBeNull();
    expect(updated!.birthday).toBe("1990-03-15");
    expect(updated!.gender).toBe("남");
    expect(updated!.address).toBeNull(); // 안 건드린 칸은 그대로
    expect(updated!.attributes.혈액형).toBe("A");

    // person_fts_update 트리거가 birthday 를 합성 텍스트에 다시 색인 — 생일 글자 검색 통함.
    const hit = db
      .prepare("SELECT person_id FROM persons_fts WHERE persons_fts MATCH ?")
      .get("1990") as { person_id: string } | null;
    expect(hit?.person_id).toBe(p.personId);
  });

  test("updatePersonFacts — 미존재 id 는 null", async () => {
    const r = await repo.updatePersonFacts("psn_없음", { gender: "여" });
    expect(r).toBeNull();
  });

  test("addPersonAlias — 누적 + 중복 무시 + 빈 alias throw", async () => {
    const p = await repo.findOrCreatePerson({ displayName: "민수", userId: "u2", source: "discord" });

    const a1 = await repo.addPersonAlias(p.personId, "므스");
    expect(a1!.aliases).toContain("민수");
    expect(a1!.aliases).toContain("므스");

    // 같은 별칭 다시 — 중복이라 안 늘어남.
    const before = a1!.aliases.length;
    const a2 = await repo.addPersonAlias(p.personId, "므스");
    expect(a2!.aliases.length).toBe(before);
    // display_name 과 같은 값도 중복 — 안 늘어남.
    const a3 = await repo.addPersonAlias(p.personId, "민수");
    expect(a3!.aliases.length).toBe(before);

    await expect(repo.addPersonAlias(p.personId, "  ")).rejects.toThrow(/alias/);
    expect(await repo.addPersonAlias("psn_없음", "x")).toBeNull();
  });

  test("removePersonAlias — 그 별칭만 빼고(NFC 비교) 다른 별칭·없던 별칭은 그대로", async () => {
    const p = await repo.findOrCreatePerson({ displayName: "민수", userId: "u3", source: "discord" });
    await repo.addPersonAlias(p.personId, "므스");
    await repo.addPersonAlias(p.personId, "민수형");

    // 조합형(NFD)으로 들어온 같은 별칭도 지운다.
    const r1 = await repo.removePersonAlias(p.personId, "민수형".normalize("NFD"));
    expect(r1!.aliases).toEqual(["민수", "므스"]);
    expect(r1!.displayName).toBe("민수");

    // 없던 별칭 — 무변동.
    const r2 = await repo.removePersonAlias(p.personId, "없는별칭");
    expect(r2!.aliases).toEqual(["민수", "므스"]);

    await expect(repo.removePersonAlias(p.personId, " ")).rejects.toThrow(/alias/);
    expect(await repo.removePersonAlias("psn_없음", "x")).toBeNull();
  });

  test("applyPersonEmbedding — 실제 임베딩이 person_vec 에 적재(rowid 매칭)", async () => {
    const p = await repo.findOrCreatePerson({ displayName: "임베딩테스트", userId: "u3", source: "discord" });
    const ok = await repo.applyPersonEmbedding(p.personId);
    expect(ok).toBe(true);

    const rid = (db.prepare("SELECT rowid AS r FROM persons WHERE person_id = ?").get(p.personId) as { r: number }).r;
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM person_vec WHERE person_rowid = ?").get(rid) as { c: number }).c;
    expect(cnt).toBe(1);

    // 다시 적재해도 DELETE+INSERT 라 행 수 1 그대로(중복 안 쌓임).
    await repo.applyPersonEmbedding(p.personId);
    const cnt2 = (db.prepare("SELECT COUNT(*) AS c FROM person_vec WHERE person_rowid = ?").get(rid) as { c: number }).c;
    expect(cnt2).toBe(1);
  });

  test("applyPersonEmbedding — embedding_text 우선, NULL 이면 display_name fallback", async () => {
    const p = await repo.findOrCreatePerson({ displayName: "표시이름", userId: "u4", source: "discord" });
    // embedding_text 미설정(NULL) — display_name fallback 으로도 적재 성공해야 함.
    expect(await repo.applyPersonEmbedding(p.personId)).toBe(true);
  });

  test("applyPersonEmbedding — 미존재 id 는 throw (silent fallback 금지)", async () => {
    await expect(repo.applyPersonEmbedding("psn_없음")).rejects.toThrow(/not found/);
  });

  test("addPersonAttributeConcept + 역방향 조회 — '개발자인 사람들'", async () => {
    const edges = new EdgeRepository(db);
    const concepts = new ConceptRepository(db, embedder);
    const dev = await concepts.findOrCreateTagConcept("개발자");

    const a = await repo.findOrCreatePerson({ displayName: "사람A", userId: "ua", source: "discord" });
    const b = await repo.findOrCreatePerson({ displayName: "사람B", userId: "ub", source: "discord" });

    expect(await repo.addPersonAttributeConcept(a.personId, dev, TEST_PROVENANCE, TEST_SOURCE_NODE_ID)).toBe(true);
    expect(await repo.addPersonAttributeConcept(b.personId, dev, TEST_PROVENANCE, TEST_SOURCE_NODE_ID)).toBe(true);
    // 같은 (person, concept) 중복은 false(INSERT OR IGNORE).
    expect(await repo.addPersonAttributeConcept(a.personId, dev, "user_input", 777)).toBe(false);
    const attrRow = db
      .prepare(
        `SELECT provenance, source_node_id FROM concept_edges
         WHERE source_concept_id = ? AND target_concept_id = ? AND relation = 'has_attribute'`,
      )
      .get(a.personId, dev) as { provenance: string; source_node_id: number | null };
    expect(attrRow.provenance).toBe("system");
    expect(attrRow.source_node_id).toBeNull();

    const people = edges.getPersonsByAttributeConcept(dev);
    expect(people.sort()).toEqual([a.personId, b.personId].sort());

    // 라벨 없는 개념은 빈 배열(정직한 빈 결과).
    const empty = await concepts.findOrCreateTagConcept("디자이너");
    expect(edges.getPersonsByAttributeConcept(empty)).toEqual([]);
  });

  test("has_attribute 와 parent_of 가 같은 source 에 공존 (PK 충돌 없음)", async () => {
    const edges = new EdgeRepository(db);
    const concepts = new ConceptRepository(db, embedder);
    const dev = await concepts.findOrCreateTagConcept("개발자");
    const parent = await concepts.findOrCreateTagConcept("직군");

    const a = await repo.findOrCreatePerson({ displayName: "겸업", userId: "uc", source: "discord" });

    // 같은 source(a.personId) 에 has_attribute 엣지 추가...
    expect(await repo.addPersonAttributeConcept(a.personId, dev, TEST_PROVENANCE, TEST_SOURCE_NODE_ID)).toBe(true);
    // ...그리고 같은 source 에 parent_of 엣지도 추가 — relation 이 PK 일부라 별 행으로 공존.
    await edges.addConceptEdge({
      sourceConceptId: a.personId,
      targetConceptId: parent,
      relation: "parent_of",
      provenance: TEST_PROVENANCE,
      sourceNodeId: TEST_SOURCE_NODE_ID,
    });

    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM concept_edges WHERE source_concept_id = ?").get(a.personId) as { c: number }).c;
    expect(cnt).toBe(2);

    // 역방향 조회는 has_attribute 만 — parent_of 는 섞이지 않음.
    expect(edges.getPersonsByAttributeConcept(dev)).toEqual([a.personId]);
    expect(edges.getPersonsByAttributeConcept(parent)).toEqual([]);
  });
});

describe("findPersonByNameOrAlias — 본명 우선 + 별명 매칭 + 모호 판정", () => {
  let db: Database;
  let repo: PersonRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new PersonRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("본명 정확 매칭이 별명보다 우선", async () => {
    const gildong = await repo.findOrCreatePersonByName("홍길동");
    await repo.addPersonAlias(gildong.personId, "나");
    const na = await repo.findOrCreatePersonByName("나");

    const lookup = await repo.findPersonByNameOrAlias("나");
    expect(lookup.ambiguous).toBe(false);
    expect(lookup.person?.personId).toBe(na.personId);
  });

  test("별명 단일 매칭 — 본명에 없으면 별명으로 찾는다", async () => {
    const gildong = await repo.findOrCreatePersonByName("홍길동");
    await repo.addPersonAlias(gildong.personId, "동글이");

    const lookup = await repo.findPersonByNameOrAlias("동글이");
    expect(lookup.ambiguous).toBe(false);
    expect(lookup.person?.personId).toBe(gildong.personId);
  });

  test("별명이 2명+ 겹치면 모호 — person null + ambiguous true", async () => {
    const a = await repo.findOrCreatePersonByName("홍길동");
    const b = await repo.findOrCreatePersonByName("이몽룡");
    await repo.addPersonAlias(a.personId, "셋째");
    await repo.addPersonAlias(b.personId, "셋째");

    const lookup = await repo.findPersonByNameOrAlias("셋째");
    expect(lookup.person).toBeNull();
    expect(lookup.ambiguous).toBe(true);
  });

  test("본명·별명 어디에도 없으면 person null + ambiguous false", async () => {
    await repo.findOrCreatePersonByName("홍길동");
    const lookup = await repo.findPersonByNameOrAlias("없는이름");
    expect(lookup.person).toBeNull();
    expect(lookup.ambiguous).toBe(false);
  });

  test("엄격 조회는 표시 이름 동명이인을 모호로 본다", async () => {
    await repo.findOrCreatePerson({
      displayName: "민수",
      userId: "discord-minsu",
      source: "discord",
    });
    await repo.findOrCreatePerson({
      displayName: "민수",
      userId: "slack-minsu",
      source: "slack",
    });

    const loose = await repo.findPersonByNameOrAlias("민수");
    expect(loose.person?.displayName).toBe("민수");
    expect(loose.ambiguous).toBe(false);

    const strict = await repo.findUniquePersonByNameOrAlias("민수");
    expect(strict.person).toBeNull();
    expect(strict.ambiguous).toBe(true);
  });

  test("빈 이름 — person null + ambiguous false(throw 아님)", async () => {
    const lookup = await repo.findPersonByNameOrAlias("   ");
    expect(lookup.person).toBeNull();
    expect(lookup.ambiguous).toBe(false);
  });

  test("조회는 새 행을 만들지 않는다", async () => {
    await repo.findOrCreatePersonByName("홍길동");
    await repo.findPersonByNameOrAlias("나");
    await repo.findPersonByNameOrAlias("없는이름");
    const c = db.prepare("SELECT COUNT(*) AS c FROM persons").get() as { c: number };
    expect(c.c).toBe(1);
  });
});

// ── NFD 재입력 회귀(정규화 전수 점검 T6) ──────────────────────────────────────
// persons.display_name·aliases 도 엔티티·개념과 같은 결함을 가지고 있었다 — 한글
// 조합형(NFD)으로 들어온 같은 이름이 완성형(NFC) 기존 행을 못 찾아 사람 사본이
// 쌓였다(LightRAG #3367 계열).
describe("PersonRepository — NFD 재입력 정규화", () => {
  let db: Database;
  let repo: PersonRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new PersonRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("findOrCreatePersonByName — NFD 재입력이 NFC 기존 사람으로 수렴(사본 0)", async () => {
    const nfc = "김민수";
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);

    const first = await repo.findOrCreatePersonByName(nfc);
    const second = await repo.findOrCreatePersonByName(nfd);

    expect(second.personId).toBe(first.personId);
    const cnt = db
      .query("SELECT COUNT(*) AS c FROM persons")
      .get() as { c: number };
    expect(cnt.c).toBe(1);
    expect(second.displayName).toBe(nfc);
  });

  test("findPersonByName·findPersonByNameOrAlias — NFD 질의가 NFC 사람을 찾는다", async () => {
    const nfc = "김민수";
    const created = await repo.findOrCreatePersonByName(nfc);
    const nfd = nfc.normalize("NFD");

    expect((await repo.findPersonByName(nfd))?.personId).toBe(created.personId);

    const lookup = await repo.findPersonByNameOrAlias(nfd);
    expect(lookup.person?.personId).toBe(created.personId);
    expect(lookup.ambiguous).toBe(false);

    const unique = await repo.findUniquePersonByNameOrAlias(nfd);
    expect(unique.person?.personId).toBe(created.personId);
  });

  test("addPersonAlias — NFD 별명은 같은 NFC 별명의 중복으로 판정(사본 0)", async () => {
    const created = await repo.findOrCreatePersonByName("김민수");
    await repo.addPersonAlias(created.personId, "민수");
    // 같은 별명을 조합형으로 다시 넣어도 배열이 늘지 않는다.
    const after = await repo.addPersonAlias(
      created.personId,
      "민수".normalize("NFD"),
    );
    expect(after!.aliases.filter((a) => a.normalize("NFC") === "민수")).toHaveLength(1);
  });

  test("findPersonByNameOrAlias — NFD 저장 별명도 NFC 질의로 잡힌다", async () => {
    const created = await repo.findOrCreatePersonByName("김민수");
    // 옛 저장분이 조합형인 경우를 재현 — DB 에 직접 NFD 별명을 넣는다.
    db.query("UPDATE persons SET aliases = ? WHERE person_id = ?").run(
      JSON.stringify(["민수".normalize("NFD")]),
      created.personId,
    );

    const lookup = await repo.findPersonByNameOrAlias("민수");
    expect(lookup.person?.personId).toBe(created.personId);
    expect(lookup.ambiguous).toBe(false);
  });
});
