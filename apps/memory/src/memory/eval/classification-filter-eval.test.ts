/**
 * memory/eval/classification-filter-eval.test.ts — 학술 분류 필터 측정
 * (공통 인프라 1.1c T4 / spec 5.7 / 3.5).
 *
 * 학술 분류 필터는 RRF 합산 *전* 후보 pool 을 분류 매칭 자산으로 줄인다(가중치가
 * 아니라 축소 / [[retriever-fusion-rrf]] 동등 합산 불변). 이 파일은 실 검색 경로
 * (HybridRetriever.retrieve(query, { filter }))로 (1) name UNIQUE 자동 통합 —
 * `#만화` 태그 자산 + `review:만화` 분류 자산이 한 filter query 로 둘 다 잡힘 —
 * (2) 다른 분류 자산 정확 제외 (3) 여러 filter key 의 AND 교집합 (4) graceful
 * 빈 결과를 측정한다.
 *
 * enriched 코퍼스(T1)는 분류 role 자산이 없어 분별을 못 잰다 — 이 측정은 자체
 * 분류 라벨 자산을 :memory: DB 에 적재해 분류 필터가 후보를 *줄이는* 효과를 잰다.
 *
 * 실 bun:sqlite + 실 bge-m3 + :memory: DB. mock 없음. 운영 DB 불변경.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

/**
 * 분류 라벨 코퍼스를 적재한다. 한 주제(작품 메모)에 분류 값을 두 통로로 붙여
 * name UNIQUE 통합을 잴 수 있게 한다.
 */
async function loadClassificationCorpus(store: SqliteMemoryStore): Promise<{
  mangaTagNode: number;
  mangaClassNode: number;
  novelNode: number;
  cozyMangaNode: number;
  noLabelNode: number;
}> {
  // (A) `#만화` 해시태그 통로 자산 — role='tag'.
  const mangaTagNode = await store.addNode({
    content: "어제 새 만화 한 권을 다 읽었다",
  });
  const cidMangaTag = await store.findOrCreateTagConcept("만화");
  await store.addNodeConceptEdge(mangaTagNode, cidMangaTag, "tag", "user_input", mangaTagNode);

  // (B) `review:만화` 분류 통로 자산 — role='classification'. 같은 이름 = 같은
  //     노드라 (A)의 `만화` concept 와 동일 conceptId 로 통합된다.
  const mangaClassNode = await store.addNode({
    content: "이 작품에 리뷰를 길게 남겼다",
  });
  const cidMangaClass = await store.findOrCreateConcept("만화", {
    isClassificationValue: true,
  });
  await store.addNodeConceptEdge(mangaClassNode, cidMangaClass, "classification", "user_input", mangaClassNode);

  // (C) 다른 분류 값(소설) 자산 — 분류 필터가 제외해야 하는 대조군.
  const novelNode = await store.addNode({ content: "두꺼운 소설을 읽기 시작했다" });
  const cidNovel = await store.findOrCreateConcept("소설", {
    isClassificationValue: true,
  });
  await store.addNodeConceptEdge(novelNode, cidNovel, "classification", "user_input", novelNode);

  // (D) 만화 분류 + 분위기 분류(포근함) 둘 다 붙은 자산 — 여러 key AND 측정용.
  const cozyMangaNode = await store.addNode({
    content: "포근한 분위기의 만화를 골랐다",
  });
  await store.addNodeConceptEdge(cozyMangaNode, cidMangaClass, "classification", "user_input", cozyMangaNode);
  const cidCozy = await store.findOrCreateConcept("포근함", {
    isClassificationValue: true,
  });
  await store.addNodeConceptEdge(cozyMangaNode, cidCozy, "classification", "user_input", cozyMangaNode);

  // (E) 분류 라벨이 전혀 없는 자산 — 분류 필터가 항상 제외해야 한다.
  const noLabelNode = await store.addNode({
    content: "그냥 라벨 없이 적은 메모 하나",
  });

  return { mangaTagNode, mangaClassNode, novelNode, cozyMangaNode, noLabelNode };
}

describe("학술 분류 필터 — 1.1c T4 실배선 측정", () => {
  test("name UNIQUE 통합 — #만화 태그 + review:만화 분류 자산이 filter 한 query 로 둘 다 잡힘", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const ids = await loadClassificationCorpus(store);
    const retriever = new HybridRetriever(store, embedder);

    // filter.review=만화 (key 는 분류 키 / value '만화' 가 name UNIQUE 매칭).
    // 넓은 검색어로 후보를 모은 뒤 분류 값 '만화' 로 후보를 줄인다.
    const filtered = await retriever.retrieve("작품 메모", {
      limit: 20,
      filter: { review: "만화" },
    });
    const filteredIds = new Set(filtered.map((r) => r.node.id));

    // 두 통로(role='tag' / role='classification') 자산이 같은 `만화` concept 노드라
    // 한 filter query 로 둘 다 회수돼야 한다(spec 3.5.5 갈라짐 없음).
    expect(filteredIds.has(ids.mangaTagNode)).toBe(true); // #만화 태그 통로
    expect(filteredIds.has(ids.mangaClassNode)).toBe(true); // review:만화 분류 통로

    // 다른 분류(소설)·라벨 없는 자산은 제외(후보 줄임).
    expect(filteredIds.has(ids.novelNode)).toBe(false);
    expect(filteredIds.has(ids.noLabelNode)).toBe(false);

    console.log(
      `[1.1c T4 분류필터] filter.review=만화 → ${filtered.length}건 회수 ` +
        `(만화 태그·분류 통로 통합 / 소설·무라벨 제외)`,
    );
    db.close();
  });

  test("필터 미지정 vs 지정 — 후보 축소 효과 측정(분류 자산 줄어듦)", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const ids = await loadClassificationCorpus(store);
    const retriever = new HybridRetriever(store, embedder);

    // (1) filter 미지정 = 전 후보(분류·무라벨 다 섞임 / 1.1b·T3 동작 불변).
    const before = await retriever.retrieve("작품 메모", { limit: 20 });
    const beforeIds = new Set(before.map((r) => r.node.id));
    // 무라벨 또는 다른 분류 자산이 후보에 섞여 있어야 분별이 vacuous 가 아니다.
    const hasNonManga =
      beforeIds.has(ids.novelNode) || beforeIds.has(ids.noLabelNode);
    expect(hasNonManga).toBe(true);

    // (2) filter.review=만화 지정 = 분류 매칭 자산만 — 후보가 줄어든다.
    const after = await retriever.retrieve("작품 메모", {
      limit: 20,
      filter: { review: "만화" },
    });
    expect(after.length).toBeGreaterThan(0); // 만화 자산이 있으니 빈 결과 아님
    expect(after.length).toBeLessThan(before.length); // 비-만화 제거됨

    console.log(
      `[1.1c T4 분류필터] filter-off ${before.length}건 → filter-on ${after.length}건 ` +
        `(분류 매칭 후보 축소)`,
    );
    db.close();
  });

  test("여러 filter key = AND(모든 분류 만족 노드만)", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const ids = await loadClassificationCorpus(store);
    const retriever = new HybridRetriever(store, embedder);

    // review=만화 AND mood=포근함 → 두 분류 다 붙은 자산(cozyMangaNode)만.
    // mangaTagNode·mangaClassNode 는 만화이지만 포근함이 없어 제외돼야 한다.
    const both = await retriever.retrieve("작품 분위기", {
      limit: 20,
      filter: { review: "만화", mood: "포근함" },
    });
    const bothIds = new Set(both.map((r) => r.node.id));
    expect(bothIds.has(ids.cozyMangaNode)).toBe(true); // 두 분류 다 만족
    expect(bothIds.has(ids.mangaTagNode)).toBe(false); // 포근함 없음 → AND 탈락
    expect(bothIds.has(ids.novelNode)).toBe(false); // 만화도 아님
    db.close();
  });

  test("graceful — 매칭 분류 0개면 빈 결과(에러 아님)", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    await loadClassificationCorpus(store);
    const retriever = new HybridRetriever(store, embedder);

    // 존재하지 않는 분류 값 → 매칭 concept 0개 → 후보 0개 → 빈 결과.
    // "그 분류로 라벨된 자산 없음" = 정직한 빈 상태(에러 throw 안 함 / Mock Policy).
    const result = await retriever.retrieve("작품 메모", {
      limit: 20,
      filter: { genre: "존재하지않는장르" },
    });
    expect(result).toEqual([]);
    db.close();
  });

  test("polarity + filter 동시 지정 = 두 축소 교집합(RRF 합산 전 같은 단계)", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);

    // 만화 분류 + positive polarity 자산 / 만화 분류 + negative polarity 자산.
    const posManga = await store.addNode({
      content: "이 만화 정말 마음에 든다",
      polarity: "positive",
    });
    const negManga = await store.addNode({
      content: "이 만화는 영 별로였다",
      polarity: "negative",
    });
    const cidManga = await store.findOrCreateConcept("만화", {
      isClassificationValue: true,
    });
    await store.addNodeConceptEdge(posManga, cidManga, "classification", "user_input", posManga);
    await store.addNodeConceptEdge(negManga, cidManga, "classification", "user_input", negManga);

    const retriever = new HybridRetriever(store, embedder);

    // filter.review=만화 AND polarity=positive → 만화 분류 + positive 둘 다 만족.
    const both = await retriever.retrieve("만화 감상", {
      limit: 20,
      filter: { review: "만화" },
      polarity: "positive",
    });
    const bothIds = new Set(both.map((r) => r.node.id));
    expect(bothIds.has(posManga)).toBe(true); // 만화 + positive
    expect(bothIds.has(negManga)).toBe(false); // 만화이나 negative → 교집합 탈락
    for (const r of both) expect(r.node.polarity).toBe("positive");
    db.close();
  });
});
