import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../../embedding/factory.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { EntityTypeRegistryDb } from "./entity-type-registry-db.ts";
import { EntitiesRepository } from "./entities-repository.ts";

// 실제 bge-m3 임베딩(mock 금지·CLAUDE.md). 차원은 글 모델 단일 출처에서 읽어
// 하드코딩 0. 한 번 로드해 모든 케이스가 공유한다.
let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let registry: EntityTypeRegistryDb;
let repo: EntitiesRepository;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", {
    embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"],
  });
  registry = new EntityTypeRegistryDb(db);
  registry.addEntityType({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
  repo = new EntitiesRepository(db, embedder, registry);
});
afterEach(() => {
  db.close();
});

test("findOrCreateEntity — 새 종류 행 생성, id_prefix 적용", async () => {
  const e = await repo.findOrCreateEntity("vehicle", "아반떼");
  expect(e.id.startsWith("veh_")).toBe(true);
  expect(e.typeName).toBe("vehicle");
  expect(e.name).toBe("아반떼");
});

test("findOrCreateEntity — 같은 (종류, 이름) 재호출은 같은 행 재사용", async () => {
  const a = await repo.findOrCreateEntity("vehicle", "아반떼");
  const b = await repo.findOrCreateEntity("vehicle", "아반떼");
  expect(b.id).toBe(a.id);
  const cnt = db
    .query("SELECT COUNT(*) AS c FROM entities WHERE type_name = 'vehicle'")
    .get() as { c: number };
  expect(cnt.c).toBe(1);
});

test("findOrCreateEntity — 정적 10종 + 새 종류 모두 허용(미등록만 throw·단계4 T3)", async () => {
  // 단계4: 정적 10종이 범용 본체로 흡수된다 — 더는 throw 하지 않고 행을 만든다.
  const STATIC_TEN = [
    "creature",
    "thing",
    "intake",
    "usable",
    "work",
    "material",
    "place",
    "schedule",
    "person",
    "project",
  ];
  for (const t of STATIC_TEN) {
    const e = await repo.findOrCreateEntity(t, `샘플_${t}`);
    expect(e.typeName).toBe(t);
    expect(e.name).toBe(`샘플_${t}`);
    // id 접두사가 그 종류 메타 권위와 정합(person='psn_'·project='prj_'·8타입은 메타).
    const expectedPrefix = registry.idPrefixOf(t);
    expect(expectedPrefix).toBeTruthy();
    expect(e.id.startsWith(expectedPrefix!)).toBe(true);
  }
});

test("findOrCreateEntity — 미등록 새 종류는 throw(명부에 없으면 거부)", async () => {
  await expect(repo.findOrCreateEntity("ghost", "x")).rejects.toThrow(/등록|명부|알려진/);
});

test("findOrCreateEntity — 빈 id_prefix 종류는 빈 접두사 + UUID 로 정상 생성(라우트 설계 정합·단계4 T3)", async () => {
  // 빈 idPrefix 는 문서화된 정당 설계다 — /api/entity-types 라우트가 idPrefix 미지정·빈값을
  // 허용하고(idPrefix 는 가독용일 뿐 식별엔 UUID), newId 가 빈 접두사 + UUID 로 충돌 없는
  // entity_id 를 만든다. 등록은 OK·사용은 throw 라는 라우트 계약 위반을 만들지 않는다.
  registry.addEntityType({ typeName: "blankpfx", koName: "빈접두사", idPrefix: "" });
  const e = await repo.findOrCreateEntity("blankpfx", "x");
  expect(e.typeName).toBe("blankpfx");
  expect(e.name).toBe("x");
  // 빈 접두사라 entity_id 는 raw UUID(prefix 없음) — 그래도 생성·식별은 UUID 로 정상.
  expect(e.id.length).toBeGreaterThan(0);
  const row = db
    .query("SELECT entity_id FROM entities WHERE type_name = 'blankpfx' AND name = 'x'")
    .get() as { entity_id: string } | null;
  expect(row?.entity_id).toBe(e.id);
});

test("findOrCreateEntity — work 동명이매체는 별개 행, 같은 3-tuple 은 한 행(단계4 T3)", async () => {
  const novel = await repo.findOrCreateEntity("work", "괴담", {
    medium: "소설",
    createdBy: "백덕수",
  });
  const webtoon = await repo.findOrCreateEntity("work", "괴담", {
    medium: "웹툰",
    createdBy: "백덕수",
  });
  // 같은 이름·다른 매체 → 별개 행(4-tuple 정체성).
  expect(webtoon.id).not.toBe(novel.id);

  // 같은 (name, medium, created_by) 재호출 → 같은 행(중복 0).
  const novelAgain = await repo.findOrCreateEntity("work", "괴담", {
    medium: "소설",
    createdBy: "백덕수",
  });
  expect(novelAgain.id).toBe(novel.id);

  const cnt = db
    .query("SELECT COUNT(*) AS c FROM entities WHERE type_name = 'work' AND name = '괴담'")
    .get() as { c: number };
  expect(cnt.c).toBe(2);

  // medium·created_by 가 entities 칼럼에 보존된다.
  const novelRow = db
    .query("SELECT medium, created_by FROM entities WHERE entity_id = ?")
    .get(novel.id) as { medium: string | null; created_by: string | null };
  expect(novelRow.medium).toBe("소설");
  expect(novelRow.created_by).toBe("백덕수");
});

test("findOrCreateEntity — 제목만 있던 work 는 후속 매체·작가 입력으로 같은 행을 보강", async () => {
  const bare = await repo.findOrCreateEntity("work", "데뷔 못 하면 죽는 병 걸림");
  const qualified = await repo.findOrCreateEntity("work", "데뷔 못 하면 죽는 병 걸림", {
    medium: "소설",
    createdBy: "백덕수",
  });

  expect(qualified.id).toBe(bare.id);

  const rows = db
    .query(
      `SELECT entity_id, medium, created_by
       FROM entities
       WHERE type_name = 'work' AND name = '데뷔 못 하면 죽는 병 걸림'`,
    )
    .all() as Array<{ entity_id: string; medium: string | null; created_by: string | null }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.medium).toBe("소설");
  expect(rows[0]!.created_by).toBe("백덕수");
});

test("findOrCreateEntity — partial work 보강은 충돌 없는 같은 축에서만 수행", async () => {
  const novel = await repo.findOrCreateEntity("work", "괴담", {
    medium: "소설",
  });
  const authoredNovel = await repo.findOrCreateEntity("work", "괴담", {
    medium: "소설",
    createdBy: "백덕수",
  });
  expect(authoredNovel.id).toBe(novel.id);

  const otherAuthor = await repo.findOrCreateEntity("work", "괴담", {
    medium: "소설",
    createdBy: "쓩늉",
  });
  expect(otherAuthor.id).not.toBe(novel.id);
});

test("findOrCreateEntity — 다른 작가 같은 이름·매체도 별개 work 행(단계4 T3)", async () => {
  const a = await repo.findOrCreateEntity("work", "괴담", {
    medium: "소설",
    createdBy: "백덕수",
  });
  const b = await repo.findOrCreateEntity("work", "괴담", {
    medium: "소설",
    createdBy: "쓩늉",
  });
  expect(b.id).not.toBe(a.id);
});

test("findOrCreateEntity — person external_refs 보존 + 같은 키로 같은 사람 합류(단계4 T3)", async () => {
  const p1 = await repo.findOrCreateEntity("person", "철수", {
    externalRefs: { discord_user_id: "123" },
  });
  // external_refs 가 entities 칼럼에 JSON 으로 보존된다.
  const row = db
    .query("SELECT external_refs FROM entities WHERE entity_id = ?")
    .get(p1.id) as { external_refs: string | null };
  expect(JSON.parse(row.external_refs!)).toEqual({ discord_user_id: "123" });

  // 같은 (refKey, userId) 로 같은 사람을 찾는다(신원 합류 — person-repository 미러).
  const found = await repo.findPersonByExternalRef("discord_user_id", "123");
  expect(found).not.toBe(null);
  expect(found!.id).toBe(p1.id);

  // 다른 userId 는 같은 사람이 아니다(null).
  const other = await repo.findPersonByExternalRef("discord_user_id", "999");
  expect(other).toBe(null);
});

test("findPersonByExternalRef — 재호출 시 같은 external_refs 가진 사람을 다시 만들지 않는다(합류)", async () => {
  // findOrCreateEntity 가 external_refs 매칭을 우선해 같은 사람을 재사용한다(중복 0).
  const a = await repo.findOrCreateEntity("person", "철수", {
    externalRefs: { discord_user_id: "abc" },
  });
  // 같은 어댑터 userId, 다른 표시 이름으로 다시 들어와도 같은 사람으로 합류.
  const b = await repo.findOrCreateEntity("person", "철수씨", {
    externalRefs: { discord_user_id: "abc" },
  });
  expect(b.id).toBe(a.id);
  const cnt = db
    .query("SELECT COUNT(*) AS c FROM entities WHERE type_name = 'person'")
    .get() as { c: number };
  expect(cnt.c).toBe(1);
});

test("findOrCreateEntity — person 동명이인(귀속 축)은 별개 행으로 보존(단계4 T3)", async () => {
  // 옛 findOrCreatePerson 동작 보존 — external_refs 가 다르면 같은 이름이라도 다른
  // 사람이다(어댑터별 user_id 가 신원 키). (type_name,name) 유일성에서 person 면제.
  const a = await repo.findOrCreateEntity("person", "철수", {
    externalRefs: { discord_user_id: "A" },
  });
  const b = await repo.findOrCreateEntity("person", "철수", {
    externalRefs: { discord_user_id: "B" },
  });
  // 같은 이름·다른 어댑터 user_id → 별개 행(동명이인).
  expect(b.id).not.toBe(a.id);
  const cnt = db
    .query("SELECT COUNT(*) AS c FROM entities WHERE type_name = 'person' AND name = '철수'")
    .get() as { c: number };
  expect(cnt.c).toBe(2);
  // 각자 external_refs 가 자기 user_id 로 보존된다(귀속 오염 0).
  const aRefs = db
    .query("SELECT external_refs FROM entities WHERE entity_id = ?")
    .get(a.id) as { external_refs: string };
  const bRefs = db
    .query("SELECT external_refs FROM entities WHERE entity_id = ?")
    .get(b.id) as { external_refs: string };
  expect(JSON.parse(aRefs.external_refs)).toEqual({ discord_user_id: "A" });
  expect(JSON.parse(bRefs.external_refs)).toEqual({ discord_user_id: "B" });
});

test("findOrCreateEntity — externalRefs 없는 person(이름 축)은 첫 행 재사용(단계4 T3)", async () => {
  // 이름 축(#사람:철수)은 findOrCreatePersonByName 미러 — 같은 이름이면 첫 행 재사용.
  // person 분기에서 (type_name,name) 폴백은 externalRefs 미제공일 때만 탄다.
  const a = await repo.findOrCreateEntity("person", "영희");
  const b = await repo.findOrCreateEntity("person", "영희");
  expect(b.id).toBe(a.id);
  const cnt = db
    .query("SELECT COUNT(*) AS c FROM entities WHERE type_name = 'person' AND name = '영희'")
    .get() as { c: number };
  expect(cnt.c).toBe(1);
});

test("findOrCreateEntity — 빈 externalRefs {} 는 이름 축으로(footgun 차단·단계4 T3)", async () => {
  // 빈 신원 객체 = "신원 없음" — 매 호출 새 행을 만들면 안 된다(footgun). 키 0개면
  // 이름 축(type_name,name) 첫 행 재사용 경로로 떨어져야 한다.
  const a = await repo.findOrCreateEntity("person", "민수", { externalRefs: {} });
  const b = await repo.findOrCreateEntity("person", "민수", { externalRefs: {} });
  expect(b.id).toBe(a.id);
  const cnt = db
    .query("SELECT COUNT(*) AS c FROM entities WHERE type_name = 'person' AND name = '민수'")
    .get() as { c: number };
  expect(cnt.c).toBe(1);
});

test("findByName — type_name 으로 가른 첫 행 회신, 없으면 null(단계4 T3)", async () => {
  await repo.findOrCreateEntity("vehicle", "아반떼");
  const found = await repo.findByName("vehicle", "아반떼");
  expect(found?.name).toBe("아반떼");
  expect(found?.typeName).toBe("vehicle");
  // 종류가 다르면 안 잡힌다(같은 이름이라도 type_name 으로 가름).
  expect(await repo.findByName("equipment", "아반떼")).toBe(null);
  // 없는 이름은 null, 빈 이름도 null(throw 아님 — 조회 통로).
  expect(await repo.findByName("vehicle", "없음")).toBe(null);
  expect(await repo.findByName("vehicle", "  ")).toBe(null);
});

test("findByNameOrAlias — 이름 우선, 별칭 단일 매칭, 2건+ 모호", async () => {
  const avante = await repo.findOrCreateEntity("vehicle", "아반떼");
  const sonata = await repo.findOrCreateEntity("vehicle", "쏘나타");
  repo.setKoAliases(avante.id, ["준중형"]);
  repo.setKoAliases(sonata.id, ["중형"]);

  const exact = await repo.findByNameOrAlias("vehicle", "아반떼");
  expect(exact.ambiguous).toBe(false);
  expect(exact.entity?.id).toBe(avante.id);

  const alias = await repo.findByNameOrAlias("vehicle", "중형");
  expect(alias.ambiguous).toBe(false);
  expect(alias.entity?.id).toBe(sonata.id);

  repo.setKoAliases(avante.id, ["겹침"]);
  repo.setKoAliases(sonata.id, ["겹침"]);
  const ambiguous = await repo.findByNameOrAlias("vehicle", "겹침");
  expect(ambiguous.entity).toBe(null);
  expect(ambiguous.ambiguous).toBe(true);
  // 모호하면 같은 규칙에 걸린 행 전부를 후보로 돌려준다(호출처가 오류에 후보를 밝힌다).
  expect(ambiguous.candidates?.map((e) => e.id).sort()).toEqual([avante.id, sonata.id].sort());

  const missing = await repo.findByNameOrAlias("vehicle", "없는별칭");
  expect(missing).toEqual({ entity: null, ambiguous: false });
});

test("list — type_name 으로 가른 최근 갱신 순 목록(단계4 T3)", async () => {
  const a = await repo.findOrCreateEntity("vehicle", "아반떼");
  await repo.findOrCreateEntity("vehicle", "쏘렌토");
  await repo.findOrCreateEntity("work", "괴담", { medium: "소설" });
  const list = await repo.list("vehicle");
  expect(list.length).toBe(2);
  expect(list.every((e) => e.typeName === "vehicle")).toBe(true);
  expect(list.some((e) => e.id === a.id)).toBe(true);
  // work 종류는 vehicle 목록에 섞이지 않는다.
  expect(list.some((e) => e.typeName === "work")).toBe(false);
});

test("update — koName·attributes 부분 수정 후 보존(단계4 T3)", async () => {
  const e = await repo.findOrCreateEntity("vehicle", "아반떼");
  const updated = await repo.update(e.id, { koName: "아반떼(현대)" });
  expect(updated?.koName).toBe("아반떼(현대)");
  // 없는 id 는 null.
  expect(await repo.update("veh_nope", { koName: "x" })).toBe(null);
});

test("findOrCreateEntity — 빈 이름은 명시 throw(silent skip 금지)", async () => {
  await expect(repo.findOrCreateEntity("vehicle", "   ")).rejects.toThrow(/이름|name/);
});

test("setAttribute — 칸(is_column=1) UPSERT 후 entity_attributes 보존", async () => {
  const e = await repo.findOrCreateEntity("vehicle", "아반떼");
  repo.setAttribute(e.id, "제조사", "현대", true);
  const row = db
    .query(
      "SELECT attr_value, is_column FROM entity_attributes WHERE entity_id = ? AND attr_key = ?",
    )
    .get(e.id, "제조사") as { attr_value: string; is_column: number };
  expect(row.attr_value).toBe("현대");
  expect(row.is_column).toBe(1);
});

test("setAttribute — 같은 key 재설정은 UPSERT(값·is_column 갱신, 새 행 없음)", async () => {
  const e = await repo.findOrCreateEntity("vehicle", "아반떼");
  repo.setAttribute(e.id, "제조사", "현대", true);
  repo.setAttribute(e.id, "제조사", "기아", false);
  const rows = db
    .query("SELECT attr_value, is_column FROM entity_attributes WHERE entity_id = ?")
    .all(e.id) as { attr_value: string; is_column: number }[];
  expect(rows.length).toBe(1);
  expect(rows[0]!.attr_value).toBe("기아");
  expect(rows[0]!.is_column).toBe(0);
});

test("listAttributes — 칸과 라벨을 구분해 표시 순서로 반환한다", async () => {
  const e = await repo.findOrCreateEntity("vehicle", "아반떼");
  repo.setAttribute(e.id, "비고", "라벨값", false);
  repo.setAttribute(e.id, "제조사", "현대", true);

  expect(repo.listAttributes(e.id)).toEqual([
    { entityId: e.id, key: "제조사", value: "현대", isColumn: true },
    { entityId: e.id, key: "비고", value: "라벨값", isColumn: false },
  ]);
});

test("setAttribute — 라벨(is_column=0)은 FTS 합성에 안 들어가고 칸은 들어간다", async () => {
  const e = await repo.findOrCreateEntity("vehicle", "아반떼");
  repo.setAttribute(e.id, "제조사", "현대모비스", true); // 칸 → FTS 합성 포함
  repo.setAttribute(e.id, "비고", "라벨전용단어값", false); // 라벨 → 합성 제외
  // 트리거가 fts 를 자동 재합성한다(repo 가 fts 직접 안 건드림). trigram 검색.
  const colHit = db
    .query("SELECT entity_id FROM entities_fts WHERE entities_fts MATCH ? LIMIT 1")
    .get("현대모비스") as { entity_id: string } | null;
  expect(colHit?.entity_id).toBe(e.id);
  const labelHit = db
    .query("SELECT entity_id FROM entities_fts WHERE entities_fts MATCH ? LIMIT 1")
    .get("라벨전용단어값") as { entity_id: string } | null;
  expect(labelHit).toBe(null);
});

test("setAttribute — 없는 entityId 면 명시 throw(FK 위반 전 loud fail)", () => {
  expect(() => repo.setAttribute("veh_nonexistent", "k", "v", true)).toThrow(
    /entity|존재/,
  );
});

test("applyEmbedding — 합성 텍스트(이름+koName+칸값)로 실제 임베딩 적재", async () => {
  const e = await repo.findOrCreateEntity("vehicle", "아반떼");
  repo.setAttribute(e.id, "제조사", "현대", true);
  expect(await repo.applyEmbedding(e.id)).toBe(true);
  const cnt = db.query("SELECT COUNT(*) AS c FROM entities_vec").get() as { c: number };
  expect(cnt.c).toBe(1);
});

test("applyEmbedding — 차원이 글 모델 단일 출처와 일치(하드코딩 0 검증)", async () => {
  const e = await repo.findOrCreateEntity("vehicle", "아반떼");
  await repo.applyEmbedding(e.id);
  // entities_vec 차원이 embedder.dimension(=EMBEDDING_DIMENSIONS bge-m3)과 같다.
  expect(embedder.dimension).toBe(EMBEDDING_DIMENSIONS["bge-m3"]);
  const dimRow = db
    .query("SELECT sql FROM sqlite_master WHERE name = 'entities_vec'")
    .get() as { sql: string };
  expect(dimRow.sql).toContain(`float[${EMBEDDING_DIMENSIONS["bge-m3"]}]`);
});

test("applyEmbedding — 칸값이 합성 텍스트에 한 덩이로 모인다(BM25 문서 경계 보존)", async () => {
  const e = await repo.findOrCreateEntity("vehicle", "아반떼");
  repo.setAttribute(e.id, "제조사", "현대", true);
  repo.setAttribute(e.id, "색상", "검정", true);
  // 합성 텍스트 단위 = 엔티티당 한 문서. buildCompositeText 가 한 문자열로 모은다
  // (이름 + 엔티티 ko_name + 칸값 모음). 기준 스키마 트리거 합성식과 같다.
  const text = repo.buildCompositeText(e.id);
  expect(text).toContain("아반떼");
  expect(text).toContain("현대");
  expect(text).toContain("검정");
});

test("applyEmbedding — 미존재 id 면 명시 throw", async () => {
  await expect(repo.applyEmbedding("veh_nonexistent")).rejects.toThrow(
    /not found|존재/,
  );
});

// ── 새 종류 검색(분류 단계3 T5·D14-2) ────────────────────────────────────

test("searchEntitiesByFts — 문자열 entityId 회신·실 BM25 매칭", () => {
  const hits = (async () => {
    const a = await repo.findOrCreateEntity("vehicle", "아반떼");
    const b = await repo.findOrCreateEntity("vehicle", "쏘렌토");
    repo.setAttribute(a.id, "제조사", "현대자동차", true); // 칸 → FTS 합성 포함
    return { a, b };
  })();
  return hits.then(({ a }) => {
    // 합성 텍스트(이름 + 칸값)에 든 "현대자동차" 로 BM25 매칭.
    const fts = repo.searchEntitiesByFts("현대자동차", 10);
    expect(fts.length).toBeGreaterThan(0);
    expect(typeof fts[0]!.entityId).toBe("string");
    expect(fts.some((h) => h.entityId === a.id)).toBe(true);
  });
});

test("searchEntitiesByFts — 빈 쿼리·limit<=0 면 빈 배열(정직)", async () => {
  await repo.findOrCreateEntity("vehicle", "아반떼");
  expect(repo.searchEntitiesByFts("   ", 10)).toEqual([]);
  expect(repo.searchEntitiesByFts("아반떼", 0)).toEqual([]);
});

test("searchEntitiesByVector — 문자열 entityId 회신·실 KNN", async () => {
  const a = await repo.findOrCreateEntity("vehicle", "아반떼");
  await repo.findOrCreateEntity("vehicle", "쏘렌토");
  await repo.applyEmbedding(a.id);
  // 쿼리 임베딩 → entities_vec KNN. 적재한 엔티티가 후보로 뜬다.
  const queryVec = await embedder.embed("아반떼");
  const hits = repo.searchEntitiesByVector(Array.from(queryVec), 10);
  expect(hits.length).toBeGreaterThan(0);
  expect(typeof hits[0]!.entityId).toBe("string");
  expect(hits.some((h) => h.entityId === a.id)).toBe(true);
  // distance 는 cosine [0,2] — 자기 자신에 가까운 쿼리는 작은 거리.
  expect(hits[0]!.distance).toBeGreaterThanOrEqual(0);
});

test("searchEntitiesByVector — k<=0 면 빈 배열·차원 불일치는 throw(하드코딩 0·loud fail)", async () => {
  const a = await repo.findOrCreateEntity("vehicle", "아반떼");
  await repo.applyEmbedding(a.id);
  const queryVec = await embedder.embed("아반떼");
  expect(repo.searchEntitiesByVector(Array.from(queryVec), 0)).toEqual([]);
  // 차원이 글 모델 단일 출처와 다르면 명시 throw(silent fallback 금지).
  expect(() => repo.searchEntitiesByVector([0.1, 0.2, 0.3], 5)).toThrow(
    /dim mismatch/,
  );
});

// ── 단계4 T4 — 전용 테이블 흡수: 별칭·고유 칸 범용 통로 ───────────────────────

test("setKoAliases/get — 별칭을 entity_attributes(is_column=1)로 저장·읽기(단계4 T4)", async () => {
  const e = await repo.findOrCreateEntity("vehicle", "아반떼");
  // 처음엔 별칭 0개(정직한 빈 상태).
  expect((await repo.get(e.id))?.koAliases).toEqual([]);

  repo.setKoAliases(e.id, ["아반떼AD", "준중형"]);
  const view = await repo.get(e.id);
  expect(view?.koAliases).toEqual(["아반떼AD", "준중형"]);

  // is_column=1 로 저장돼 합성 색인에 들어간다(옛 <type>_fts 동등·결정 2).
  const attr = db
    .query(
      "SELECT attr_value, is_column FROM entity_attributes WHERE entity_id = ? AND attr_key = 'ko_aliases'",
    )
    .get(e.id) as { attr_value: string; is_column: number };
  expect(attr.is_column).toBe(1);
  expect(JSON.parse(attr.attr_value)).toEqual(["아반떼AD", "준중형"]);
});

test("setKoAliases — FTS 합성 본문에 별칭이 들어가 검색에 걸린다(검색 동등성·단계4 T4)", async () => {
  const e = await repo.findOrCreateEntity("vehicle", "아반떼");
  repo.setKoAliases(e.id, ["꿀벅지차"]);
  // 별칭 텍스트로 entities_fts 가 그 엔티티를 잡는다(합성=이름+ko_name+칸값(별칭 포함)).
  const hits = repo.searchEntitiesByFts("꿀벅지차", 10);
  expect(hits.some((h) => h.entityId === e.id)).toBe(true);
});

test("get — work medium·createdBy 가 범용 view 에 노출(전용 칼럼 흡수·단계4 T4)", async () => {
  const w = await repo.findOrCreateEntity("work", "괴담", {
    medium: "소설",
    createdBy: "백덕수",
  });
  const view = await repo.get(w.id);
  expect(view?.medium).toBe("소설");
  expect(view?.createdBy).toBe("백덕수");
  // work 외 종류는 medium·createdBy 가 null(보조 칼럼이 엉뚱한 종류에 새지 않음).
  const v = await repo.findOrCreateEntity("vehicle", "쏘렌토");
  const vView = await repo.get(v.id);
  expect(vView?.medium).toBe(null);
  expect(vView?.createdBy).toBe(null);
});

test("범용 rowToUserEntity 한 매퍼가 work row 전체를 변환한다(8 매퍼 → 한 통로·단계4 T5)", async () => {
  // 단계4 T5 — 옛 rowToWork~rowToSchedule 8 매퍼·8 Row 인터페이스를 지우고 범용
  // rowToUserEntity 한 매퍼로 통일했다. 이 한 매퍼가 work row 의 공통 칸(id·typeName·
  // name·koName)·정체성 칸(medium·createdBy)·별칭 칸(koAliases·enAliases)을 한 번에
  // 정확히 변환하는지(옛 rowToWork 가 하던 일을 빠짐없이 흡수) 한 호출로 확인한다.
  const w = await repo.findOrCreateEntity("work", "괴담", {
    medium: "소설",
    createdBy: "백덕수",
  });
  await repo.update(w.id, { koName: "괴담(한글)" });
  repo.setKoAliases(w.id, ["괴담이"]);
  repo.setEnAliases(w.id, ["Ghost Story"]);

  const view = await repo.get(w.id);
  expect(view).not.toBeNull();
  expect(view!.id).toBe(w.id);
  expect(view!.typeName).toBe("work");
  expect(view!.name).toBe("괴담");
  expect(view!.koName).toBe("괴담(한글)");
  expect(view!.medium).toBe("소설");
  expect(view!.createdBy).toBe("백덕수");
  expect(view!.koAliases).toEqual(["괴담이"]);
  expect(view!.enAliases).toEqual(["Ghost Story"]);
  expect(typeof view!.createdAt).toBe("string");
  expect(typeof view!.updatedAt).toBe("string");
});

test("findByNameAndAuthor — 동명+작가 work 행을 모두 회신(매체별)·미상은 빈 배열(단계4 T4)", async () => {
  await repo.findOrCreateEntity("work", "괴담", { medium: "소설", createdBy: "백덕수" });
  await repo.findOrCreateEntity("work", "괴담", { medium: "웹툰", createdBy: "백덕수" });
  await repo.findOrCreateEntity("work", "괴담", { medium: "소설", createdBy: "쓩늉" });

  const baekWorks = repo.findByNameAndAuthor("괴담", "백덕수");
  // 백덕수 괴담 = 소설·웹툰 둘(작가 같고 매체 다름) — 모두 회신.
  expect(baekWorks.length).toBe(2);
  expect(baekWorks.every((w) => w.createdBy === "백덕수")).toBe(true);

  // 다른 작가는 안 섞인다.
  expect(repo.findByNameAndAuthor("괴담", "쓩늉").length).toBe(1);
  // 작가 미상(빈 문자열)·없는 작가는 빈 배열(거짓 연결 0).
  expect(repo.findByNameAndAuthor("괴담", "  ")).toEqual([]);
  expect(repo.findByNameAndAuthor("괴담", "없는작가")).toEqual([]);
});

// ── NFD 재입력 회귀(정규화 전수 점검 T6) ──────────────────────────────────────
// 참조 결함(LightRAG #3367 계열): 저장 시점 문자열과 새로 들어온 문자열의 정규화
// 상태가 다르면 정확-중복이 안 잡혀 재입력마다 사본이 쌓인다. 한글 조합형(NFD)은
// 완성형(NFC)과 바이트가 달라 SQL `name = ?` 동등 비교에서 갈린다.

test("findOrCreateEntity — NFD 재입력이 NFC 기존 행으로 수렴(사본 0)", async () => {
  const nfc = "데못죽";
  const nfd = nfc.normalize("NFD");
  // 전제 확인 — 두 문자열은 같은 글자지만 바이트가 다르다(정규화 없으면 안 잡힘).
  expect(nfd).not.toBe(nfc);

  const first = await repo.findOrCreateEntity("work", nfc);
  const second = await repo.findOrCreateEntity("work", nfd);

  expect(second.id).toBe(first.id);
  const cnt = db
    .query("SELECT COUNT(*) AS c FROM entities WHERE type_name = 'work'")
    .get() as { c: number };
  expect(cnt.c).toBe(1);
  // 저장된 이름은 NFC 단일 형태다.
  expect(second.name).toBe(nfc);
});

test("findByName·findByNameOrAlias — NFD 질의가 NFC 저장 행을 찾는다", async () => {
  const nfc = "데못죽";
  const created = await repo.findOrCreateEntity("work", nfc);

  const byName = await repo.findByName("work", nfc.normalize("NFD"));
  expect(byName?.id).toBe(created.id);

  const byAlias = await repo.findByNameOrAlias("work", nfc.normalize("NFD"));
  expect(byAlias.entity?.id).toBe(created.id);
  expect(byAlias.ambiguous).toBe(false);
});

test("findByNameOrAlias — NFD 저장 별칭도 NFC 질의로 잡힌다", async () => {
  const created = await repo.findOrCreateEntity("work", "괴담");
  // 별칭을 조합형(NFD)으로 저장 — 옛 저장분이 NFD 인 경우를 재현한다.
  repo.setKoAliases(created.id, ["괴담이".normalize("NFD")]);

  const found = await repo.findByNameOrAlias("work", "괴담이");
  expect(found.entity?.id).toBe(created.id);
  expect(found.ambiguous).toBe(false);
});

test("findByNameAndAuthor — NFD 이름·작가 질의가 NFC 저장 행을 찾는다", async () => {
  await repo.findOrCreateEntity("work", "괴담", {
    medium: "소설",
    createdBy: "백덕수",
  });

  const rows = repo.findByNameAndAuthor(
    "괴담".normalize("NFD"),
    "백덕수".normalize("NFD"),
  );
  expect(rows.length).toBe(1);
  expect(rows[0]!.createdBy).toBe("백덕수");
});

test("findOrCreateEntity — work 정체성 3-tuple 이 NFD 재입력에도 같은 행으로 수렴", async () => {
  const name = "괴담";
  const author = "백덕수";
  const medium = "소설";

  const first = await repo.findOrCreateEntity("work", name, {
    medium,
    createdBy: author,
  });
  // 이름·작가·매체를 모두 조합형으로 다시 입력 — 정체성 키 전체가 통일돼야 같은 행.
  const second = await repo.findOrCreateEntity("work", name.normalize("NFD"), {
    medium: medium.normalize("NFD"),
    createdBy: author.normalize("NFD"),
  });

  expect(second.id).toBe(first.id);
  const cnt = db
    .query("SELECT COUNT(*) AS c FROM entities WHERE type_name = 'work'")
    .get() as { c: number };
  expect(cnt.c).toBe(1);
  // 저장 값도 NFC 단일 형태 — 조회 정규화/저장 원문 비대칭이 남지 않는다.
  expect(second.createdBy).toBe(author);
  expect(second.medium).toBe(medium);
});

test("findByNameAndAuthor — NFD 작가로 만든 행도 NFC 질의로 찾힌다(조회/저장 대칭)", async () => {
  // 작가를 조합형으로만 넣어 생성 — 저장이 raw NFD 면 NFC 질의가 못 찾는다.
  await repo.findOrCreateEntity("work", "괴담".normalize("NFD"), {
    medium: "소설",
    createdBy: "백덕수".normalize("NFD"),
  });

  const rows = repo.findByNameAndAuthor("괴담", "백덕수");
  expect(rows.length).toBe(1);
  expect(rows[0]!.createdBy).toBe("백덕수");
});
