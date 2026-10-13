/**
 * concept-emergence.test.ts — emergeRepeatedWords 통합 검증 (Task 4).
 *
 * mock 0 — 실제 SQLite + bge-m3 임베딩 store + 실 Kiwi 형태소 토큰화로
 * 검증한다(CLAUDE.md "DB/임베딩 의존 모듈은 실제 구현체와 통합 검증",
 * plan §불변식 "Mock 0(실 store + 실 Kiwi)"). 데이터 fixture(글 본문 배열)만
 * 입력하고 emerge 가 docCount 집계 → 임계 게이트 → concept upsert 하는 실제
 * 흐름을 본다.
 *
 * 검증 축:
 *  - 임계 게이트: docCount ≥ threshold 단어만 승격, 미달 단어 0개 생성.
 *  - 조사 흡수(Kiwi): "커피를/커피가/커피는" 이 "커피" 한 단어로 docCount 합산.
 *  - 합류(findOrCreateConcept 이름 UNIQUE): 기존 동명 개념과 합류·중복 0.
 *  - 증분(전체 누적 재집계): 글이 늘면 다시 집계해 임계를 새로 넘는 단어 승격.
 *  - 기본 임계 50: CONCEPT_EMERGENCE_THRESHOLD 가 50 으로 작동.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { emergeRepeatedWords } from "./concept-emergence.ts";
import { CONCEPT_EMERGENCE_THRESHOLD } from "./constants.ts";

describe("emergeRepeatedWords — 반복단어 개념 승격", () => {
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

  /** 글 한 개를 실제로 저장한다(실 임베딩 경유). */
  async function addDoc(content: string): Promise<number> {
    return store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
  }

  test("빈 DB → upsert 0(자주 반복한 단어가 아직 없는 정상 빈 결과)", async () => {
    const summary = await emergeRepeatedWords(store, { threshold: 3 });

    expect(summary.scannedNodes).toBe(0);
    expect(summary.candidateWords).toBe(0);
    expect(summary.conceptsUpserted).toBe(0);
    expect((await store.listConcepts({ limit: 100 })).length).toBe(0);
  });

  test("임계 게이트 — docCount ≥ threshold 단어만 승격, 미달 단어 0개 생성", async () => {
    // "커피" 는 3개 글에 등장(docCount 3), "녹차" 는 1개 글에만 등장(docCount 1).
    await addDoc("커피 한잔 마셨다");
    await addDoc("커피 향이 좋다");
    await addDoc("커피 또 마셨다 녹차도 있었지");

    const summary = await emergeRepeatedWords(store, { threshold: 3 });

    expect(summary.scannedNodes).toBe(3);
    // "커피" 만 임계 통과 — "녹차"(docCount 1)·"한잔"·"향" 등은 미달.
    const coffee = await store.findConceptByName("커피");
    expect(coffee).not.toBeNull();
    const green = await store.findConceptByName("녹차");
    expect(green).toBeNull();

    // 승격된 개념 전부가 임계를 넘은 단어여야 한다(미달 단어 0개 생성).
    expect(summary.candidateWords).toBe(summary.conceptsUpserted);
    expect(summary.conceptsUpserted).toBeGreaterThanOrEqual(1);
    const names = (await store.listConcepts({ limit: 100 })).map((c) => c.name);
    expect(names).toContain("커피");
    expect(names).not.toContain("녹차");
  });

  test("조사 흡수(Kiwi) — '커피를/커피가/커피는' 이 '커피' 한 단어로 docCount 합산", async () => {
    // 옛 음절 토큰화면 "커피를/커피가/커피는" 이 별개 토큰이라 각 docCount 1 이
    // 돼 임계 3 을 못 넘었다. Kiwi 가 조사를 떼어 "커피" 한 단어로 모은다.
    await addDoc("커피를 마셨다");
    await addDoc("커피가 좋다");
    await addDoc("커피는 또 마시고 싶다");

    const summary = await emergeRepeatedWords(store, { threshold: 3 });

    // 조사 붙은 채로는 docCount 가 1·1·1 로 갈려 임계 3 미달이지만, 조사
    // 흡수 후 "커피" docCount 3 으로 임계 통과.
    const coffee = await store.findConceptByName("커피");
    expect(coffee).not.toBeNull();
    expect(summary.conceptsUpserted).toBeGreaterThanOrEqual(1);
    // 조사 붙은 형태는 개념으로 안 생긴다(흡수됐으므로).
    expect(await store.findConceptByName("커피를")).toBeNull();
    expect(await store.findConceptByName("커피가")).toBeNull();
  });

  test("합류 — 기존 동명 개념이 있어도 findOrCreateConcept 이름 UNIQUE 로 중복 0", async () => {
    // 미리 "커피" 개념을 하나 만들어 둔다(태그 등 다른 통로로 생긴 상황 모방).
    const preId = await store.findOrCreateConcept("커피");
    expect(preId.startsWith("cpt_")).toBe(true);

    await addDoc("커피 한잔");
    await addDoc("커피 두잔");
    await addDoc("커피 석잔");

    await emergeRepeatedWords(store, { threshold: 3 });

    // emerge 가 같은 이름을 또 만들지 않고 기존 행에 합류 — "커피" 개념 1개.
    const coffeeConcepts = (await store.listConcepts({ limit: 100 })).filter(
      (c) => c.name === "커피",
    );
    expect(coffeeConcepts).toHaveLength(1);
    expect(coffeeConcepts[0]!.conceptId).toBe(preId);
  });

  test("증분(전체 누적 재집계) — 글이 늘면 새로 임계를 넘는 단어가 승격된다", async () => {
    await addDoc("사과 먹었다");
    await addDoc("사과 또 먹었다");

    // 아직 "사과" docCount 2 < 임계 3 → 미승격.
    const first = await emergeRepeatedWords(store, { threshold: 3 });
    expect(await store.findConceptByName("사과")).toBeNull();
    expect(first.candidateWords).toBe(0);

    // 글이 한 개 더 쌓이면 전체 누적 재집계로 docCount 3 → 승격.
    await addDoc("사과 진짜 자주 먹네");
    const second = await emergeRepeatedWords(store, { threshold: 3 });
    expect(await store.findConceptByName("사과")).not.toBeNull();
    expect(second.candidateWords).toBeGreaterThanOrEqual(1);
  });

  test("emerged 에 nodeId(concept:<id>)·fromSources(글 id 배열)가 채워진다", async () => {
    // "커피" 가 3개 글에 등장(docCount 3) — 임계 3 통과. fromSources 는 그 3글의 id.
    const idA = await addDoc("커피 한잔 마셨다");
    const idB = await addDoc("커피 향이 좋다");
    const idC = await addDoc("커피 또 마셨다");

    const summary = await emergeRepeatedWords(store, { threshold: 3 });

    expect(summary.emerged.length).toBeGreaterThanOrEqual(1);
    const coffee = summary.emerged.find((e) => e.word === "커피");
    expect(coffee).toBeDefined();
    // nodeId 는 concept:<conceptId> 형식(graph.ts conceptKey 정합).
    expect(coffee!.nodeId).toMatch(/^concept:cpt_/);
    // fromSources 는 그 단어가 등장한 글 id 배열 — 위 3글 전부 들어간다.
    expect(coffee!.fromSources).toHaveLength(3);
    expect(coffee!.fromSources).toContain(String(idA));
    expect(coffee!.fromSources).toContain(String(idB));
    expect(coffee!.fromSources).toContain(String(idC));
  });

  test("emerged nodeId 가 findOrCreateConcept 가 돌려준 실제 conceptId 와 일치", async () => {
    // 미리 "커피" 개념을 만들어 두면 emerge 는 같은 행에 합류 — nodeId 도 그 id.
    const preId = await store.findOrCreateConcept("커피");
    await addDoc("커피 하나");
    await addDoc("커피 둘");
    await addDoc("커피 셋");

    const summary = await emergeRepeatedWords(store, { threshold: 3 });

    const coffee = summary.emerged.find((e) => e.word === "커피");
    expect(coffee).toBeDefined();
    expect(coffee!.nodeId).toBe(`concept:${preId}`);
  });

  test("후보 0 이면 emerged 빈 배열(정직한 빈 결과)", async () => {
    await addDoc("사과 한번");
    await addDoc("바나나 한번");
    const summary = await emergeRepeatedWords(store, { threshold: 50 });
    expect(summary.emerged).toEqual([]);
  });

  test("기본 임계 = CONCEPT_EMERGENCE_THRESHOLD(50) — 49 글에는 미승격, 50 글이면 승격", async () => {
    expect(CONCEPT_EMERGENCE_THRESHOLD).toBe(50);

    // "사과" 를 49 개 글에 넣으면 docCount 49 < 50 → 미승격.
    for (let i = 0; i < 49; i++) {
      await addDoc(`사과 번호 ${i} 기록`);
    }
    const below = await emergeRepeatedWords(store);
    expect(await store.findConceptByName("사과")).toBeNull();
    expect(below.scannedNodes).toBe(49);

    // 한 개 더 넣어 docCount 50 → 임계(50) 통과 승격.
    await addDoc("사과 마지막 50번째 기록");
    const atThreshold = await emergeRepeatedWords(store);
    expect(await store.findConceptByName("사과")).not.toBeNull();
    expect(atThreshold.scannedNodes).toBe(50);
  });
});
