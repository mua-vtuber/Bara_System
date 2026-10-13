/**
 * colon-chain-mid-bridge.test.ts — 3단 이상 콜론 사슬 가운데 다리 누락 수정 재현
 * (2026-06-28 콜론 사슬 가운데 다리 누락 수정 spec §8 재현표 A~I).
 *
 * mock 클래스 0 — 실제 SQLite + 실제 임베딩 store + 실제 어휘 사전 + 실제 입력 통로
 * (wireHashtagEntities → wireEntityPlacement)를 그대로 태운다(CLAUDE.md "DB/임베딩 의존
 * 모듈은 실제 구현체와 통합 검증"·spec §4 Mock Policy). 임시 :memory: DB 라 운영 DB
 * (apps/memory/data/bara.sqlite) 무접촉.
 *
 * spec §8 재현표를 *기대값 = "가운데 다리 존재"* 로 고정한다:
 *   - A. project 3단 — 수정 전 가운데 `코딩→앱` 없음(red)·수정 후 존재(green).
 *   - H. project 3단 + place 3단 동시 — 수정 전 project 가운데 누락(red)·수정 후 완결(green).
 *   - B~G·I — 수정 전부터 통과(가운데 살아 있음·통로 2/3 가동)·수정 후 유지(멱등 회귀 0).
 *
 * 가운데 다리 = 사슬의 인접 분류 단 한 쌍(`#A:B #B:C` 의 `B→C`). 입력 통로가 만든
 * hierarchy_edges(parent_of)를 이름 조회로 확인한다. 끝-실체는 place/project 행이라
 * 마지막 단(분류 키 → 행)은 별도 위계 잎 통로가 진다 — 가운데 다리는 *개념↔개념* 한 쌍.
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
import { wireEntityPlacement } from "./entity-placement-wiring.ts";
import { wireHashtagEntities } from "./hashtag-entity-wiring.ts";
import {
  clearConceptVocabularyOverrides,
  loadConceptTypeVocabulary,
  setConceptVocabOverride,
  setEntityTypeOverride,
  type ConceptTypeVocabulary,
  type PlacementTypeName,
} from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";

describe("콜론 사슬 가운데 다리 누락 수정 (spec §8 A~I)", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
    clearConceptVocabularyOverrides();
    resetClassifierCache();
  });
  afterAll(() => {});

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  /** 실 입력 통로 순서 — 사람·프로젝트 통로(wireHashtagEntities) → 엔티티 배치(wireEntityPlacement). */
  async function run(content: string): Promise<number> {
    const origin = await store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    await wireHashtagEntities(store, origin, content);
    await wireEntityPlacement(store, origin, content, { llm: null });
    return origin;
  }

  /**
   * 두 개념 이름 사이에 parent_of 위계 엣지가 있는지 — 이름 조회 후 id 쌍으로 확인한다.
   * 한쪽 개념이 아예 없으면 false(엣지도 당연히 없음). 끝-실체(행) 매칭은 hasEntityEdge.
   */
  async function hasConceptEdge(parentName: string, childName: string): Promise<boolean> {
    const parent = await store.findConceptByName(parentName);
    const child = await store.findConceptByName(childName);
    if (!parent || !child) return false;
    const edges = store.getHierarchyEdgesWithin([parent.conceptId, child.conceptId]);
    return edges.some(
      (e) =>
        e.relation === "parent_of" &&
        e.sourceId === parent.conceptId &&
        e.targetId === child.conceptId,
    );
  }

  /** 부모 개념 → 엔티티 행 parent_of 위계 엣지가 있는지(마지막 단·분류 키 → 끝-실체 행). */
  async function hasEntityEdge(parentName: string, entityId: string): Promise<boolean> {
    const parent = await store.findConceptByName(parentName);
    if (!parent) return false;
    const edges = store.getHierarchyEdgesWithin([parent.conceptId, entityId]);
    return edges.some(
      (e) =>
        e.relation === "parent_of" &&
        e.sourceId === parent.conceptId &&
        e.targetId === entityId,
    );
  }

  test("A. project 3단 — 프로젝트→코딩→앱→바라 한 사슬(가운데 코딩→앱 존재)", async () => {
    await run("#프로젝트:코딩, #코딩:앱, #앱:바라, 오늘 바라 모듈 작업함");

    // 사슬 양 끝 두 토막 — 기존 통로가 이미 세운다(수정 전부터 green).
    expect(await hasConceptEdge("프로젝트", "코딩")).toBe(true); // 타입 루트 → 첫 분류
    // 가운데 다리 — 수정 전엔 없음(red)·수정 후 존재(green). 이 케이스의 핵심.
    expect(await hasConceptEdge("코딩", "앱")).toBe(true); // 가운데 코딩 → 앱

    // 끝-실체 — "바라" project 행. 마지막 분류 단(앱) → project 행 parent_of.
    const project = await store.findProjectByName("바라");
    expect(project).not.toBeNull();
    expect(await hasEntityEdge("앱", project!.projectId)).toBe(true); // 앱 → project:바라 행
  });

  test("B. project 2단 (대조군) — 프로젝트→라이브2D + 라이브2D→project:동글이 (가운데 없음·no-op)", async () => {
    await run("#프로젝트:라이브2D #라이브2D:동글이");

    expect(await hasConceptEdge("프로젝트", "라이브2D")).toBe(true);
    const project = await store.findProjectByName("동글이");
    expect(project).not.toBeNull();
    expect(await hasEntityEdge("라이브2D", project!.projectId)).toBe(true);
  });

  test("C. project 단독 (대조군) — 프로젝트→project:바라", async () => {
    await run("#프로젝트:바라");

    const project = await store.findProjectByName("바라");
    expect(project).not.toBeNull();
    expect(await hasEntityEdge("프로젝트", project!.projectId)).toBe(true);
  });

  test("D. place 3단 단독 — 장소→병원→피부과→place:무지개의원 (가운데 살아 있음)", async () => {
    await run("#장소:병원 #병원:피부과 #피부과:무지개의원, 5월 12일 시술 받음");

    expect(await hasConceptEdge("장소", "병원")).toBe(true);
    expect(await hasConceptEdge("병원", "피부과")).toBe(true); // 가운데(통로 2 가동)
    const row = await store.entitiesRepo.findByName("place", "무지개의원");
    expect(row).not.toBeNull();
    expect(await hasEntityEdge("피부과", row!.id)).toBe(true);
  });

  test("E. place 3단 + 사람 — 가운데 병원→피부과 살아 있음(통로 3 가동)", async () => {
    await run("#사람:철수, #장소:병원, #병원:피부과, #피부과:무지개의원, 시술 받음");

    expect(await hasConceptEdge("장소", "병원")).toBe(true);
    expect(await hasConceptEdge("병원", "피부과")).toBe(true);
    const row = await store.entitiesRepo.findByName("place", "무지개의원");
    expect(row).not.toBeNull();
    expect(await hasEntityEdge("피부과", row!.id)).toBe(true);
  });

  test("F. creature 3단 + 사람 — 생물→동물→고양이→creature:얼룩이 (가운데 살아 있음)", async () => {
    await run("#사람:철수 #생물:동물 #동물:고양이 #고양이:얼룩이");

    expect(await hasConceptEdge("생물", "동물")).toBe(true);
    expect(await hasConceptEdge("동물", "고양이")).toBe(true);
    const row = await store.entitiesRepo.findByName("creature", "얼룩이");
    expect(row).not.toBeNull();
    expect(await hasEntityEdge("고양이", row!.id)).toBe(true);
  });

  test("G. creature 3단 단독 (대조군) — 생물→동물→고양이→creature:얼룩이", async () => {
    await run("#생물:동물 #동물:고양이 #고양이:얼룩이");

    expect(await hasConceptEdge("생물", "동물")).toBe(true);
    expect(await hasConceptEdge("동물", "고양이")).toBe(true);
    const row = await store.entitiesRepo.findByName("creature", "얼룩이");
    expect(row).not.toBeNull();
    expect(await hasEntityEdge("고양이", row!.id)).toBe(true);
  });

  test("H. project 3단 + place 3단 동시 — place 완결 + project 가운데 코딩→앱 존재", async () => {
    await run(
      "#프로젝트:코딩 #코딩:앱 #앱:바라 #장소:병원 #병원:피부과 #피부과:무지개의원",
    );

    // place 는 통로 2 가 가운데를 세운다 — 수정 전부터 완결.
    expect(await hasConceptEdge("장소", "병원")).toBe(true);
    expect(await hasConceptEdge("병원", "피부과")).toBe(true);
    const place = await store.entitiesRepo.findByName("place", "무지개의원");
    expect(place).not.toBeNull();
    expect(await hasEntityEdge("피부과", place!.id)).toBe(true);

    // project 는 통로 2·3 둘 다 막혀 가운데 코딩→앱 이 수정 전엔 없다(red)·수정 후 존재(green).
    expect(await hasConceptEdge("프로젝트", "코딩")).toBe(true);
    expect(await hasConceptEdge("코딩", "앱")).toBe(true); // 핵심 — 가운데 다리
    const project = await store.findProjectByName("바라");
    expect(project).not.toBeNull();
    expect(await hasEntityEdge("앱", project!.projectId)).toBe(true);
  });

  test("I. user 종류 3단 + 사람 — 가운데 다리 살아 있음(통로 3 가동·잠재 동형 경계)", async () => {
    // 새 user 종류 '장치류'(deco) 를 DB 명부 + 동적 명부 + 어휘 캐시에 주입한 뒤 사슬을
    // 태운다. 통로 3(라벨 위계)이 사람 귀속으로 가운데를 만들어 수정 전부터 살아 있고,
    // S1 멱등으로 수정 후 유지된다(spec §8 케이스 I·§주의 잠재 동형 경계).
    store.entityTypeRegistryDb.addEntityType({
      typeName: "deco",
      koName: "장치류",
      idPrefix: "dec_",
    });
    setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
    clearConceptVocabularyOverrides();
    resetClassifierCache();
    const yamlVocab = loadConceptTypeVocabulary();
    const merged: ConceptTypeVocabulary = new Map(yamlVocab);
    merged.set("deco" as PlacementTypeName, {
      synonyms: [],
      subcategories: [],
      attributes: [],
      columns: [],
    });
    setConceptVocabOverride(merged);
    resetClassifierCache();

    await run(
      "#사람:철수 #장치류:즈낙갈래 #즈낙갈래:즈낙중간 #즈낙중간:즈낙실체",
    );

    expect(await hasConceptEdge("장치류", "즈낙갈래")).toBe(true);
    expect(await hasConceptEdge("즈낙갈래", "즈낙중간")).toBe(true); // 가운데 다리
    const row = await store.entitiesRepo.findByName("deco", "즈낙실체");
    expect(row).not.toBeNull();
    expect(await hasEntityEdge("즈낙중간", row!.id)).toBe(true);

    // 전역 누출 차단 — 동적 명부·어휘·분류기 캐시를 정적 10종으로 되돌린다(2-reset 양식).
    setEntityTypeOverride([]);
    clearConceptVocabularyOverrides();
    resetClassifierCache();
  });

  test("S3 work 3단 — 매체 토막이 가운데(작품→소설→만화→work행)·가운데 소설→만화 존재", async () => {
    // work 의 categoryChain 가운데는 매체 토막이라 인접 쌍이 개념-개념이다(spec §10 회귀 위험
    // work 갈래). `#작품:소설 #소설:만화 #만화:이름` → categoryChain=[소설,만화]. 가운데
    // 다리 소설→만화 가 placement 자기 완결로 선다. work 잎은 정체성 키(매체)로 갈린 개념이라
    // 위계 잎은 work 행 자체(마지막 분류 단 만화 → work행).
    await run("#작품:소설 #소설:만화 #만화:이름");

    expect(await hasConceptEdge("작품", "소설")).toBe(true); // 타입 루트 → 첫 분류
    expect(await hasConceptEdge("소설", "만화")).toBe(true); // 가운데 매체 다리(핵심)
    const row = await store.entitiesRepo.findByName("work", "이름");
    expect(row).not.toBeNull();
    expect(await hasEntityEdge("만화", row!.id)).toBe(true); // 마지막 분류 단 → work행
  });
});
