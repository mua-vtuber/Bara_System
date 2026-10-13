/**
 * project-chain-placement.test.ts — 콜론 사슬 구조 배치 단계3(project 합류) 회귀 가드.
 *
 * 권위 = docs/decisions/2026-06-27-colon-chain-structural-placement-spec.md §9 D5·§12 단계3·
 * §15. project 를 8타입·새 종류와 *같은 배치 통로*(placeOneUserEntityType)로 합류시킨 뒤,
 * 사용자 기대 불변식(I1~I6)과 누수 차단을 빈 DB + 실 임베딩으로 고정한다.
 *
 * mock 클래스 0 — 실제 SQLite + 실제 임베딩 store(CLAUDE.md "DB/임베딩 의존 모듈은 실제
 * 구현체와 통합 검증"). 두 배치 통로를 *함께* 태운다 — 입력 통로 실제 호출 순서대로
 * wireHashtagConcepts(개념) → wireHashtagEntities(사람·프로젝트·setNodeProjectId) →
 * wireEntityPlacement(루트·위계·끝-실체 placement). probe 가 아니라 영구 회귀 가드다.
 *
 * 가드 8(spec §3-4):
 *   1. project 단일 위계 — `프로젝트→라이브2D(개념)→동글이(엔티티)` 단일 갈래·누수 0.
 *   2. 끝만 실체 — entities 에 동글이만(라이브2D 는 중간 개념·entity 아님).
 *   3. mid-chain 적용 — "라이브2D" 가 사슬에 쓰여 중간이면 그 이름 행 0.
 *   4. project 검색·project_id 회귀 0 — searchProjectsByFts 도달·project_id 끝-실체 가리킴.
 *   5. 사람·라벨 동반 글 보존 — 참여자 라벨 보존, 제거된 언어 라벨은 일반 위계로 흐름.
 *   6. subcategory project 단축 — `#프로젝트:코딩`(코딩=project subcategory) → 행 0·개념.
 *   7. 멱등 — 같은 글 두 번 → 중복 0.
 *   8. person 통로 무접촉 — person A 결정 보존(사람 글은 무변).
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
import { wireHashtagConcepts } from "./hashtag-wiring.ts";
import { wireHashtagEntities } from "./hashtag-entity-wiring.ts";
import { wireEntityPlacement } from "./entity-placement-wiring.ts";
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";

describe("project-chain-placement — 콜론 사슬 구조 배치 단계3(project 합류·§9 D5)", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
    resetConceptTypeVocabularyCache();
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

  async function makeOrigin(content: string): Promise<number> {
    return store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
  }

  /** 입력 통로 실제 순서대로 세 통로를 함께 태운다(now 주입 — directFields graceful). */
  async function wireAll(origin: number, content: string): Promise<void> {
    await wireHashtagConcepts(store, origin, content, {});
    await wireHashtagEntities(store, origin, content, { now: new Date() });
    await wireEntityPlacement(store, origin, content, { llm: null });
  }

  function conceptName(id: string): string {
    const r = db
      .prepare("SELECT name FROM concept_nodes WHERE concept_id = ?")
      .get(id) as { name: string } | null;
    return r ? r.name : `(?${id})`;
  }

  /** 개념 이름으로 (is_classification_key, is_classification_value) 플래그를 읽는다(분류 키/값 회귀 가드). */
  function conceptFlagsByName(
    name: string,
  ): { k: number; v: number } | null {
    const r = db
      .prepare(
        "SELECT is_classification_key AS k, is_classification_value AS v FROM concept_nodes WHERE name = ?",
      )
      .get(name.toLowerCase()) as { k: number; v: number } | null;
    return r ?? null;
  }

  /** hierarchy_edges 를 사람이 읽을 "부모 -> 자식" 문자열 목록으로(개념은 이름·행은 종류:id). */
  function readableHierarchy(): string[] {
    const rows = db
      .prepare(
        "SELECT source_type, source_id, target_type, target_id FROM hierarchy_edges",
      )
      .all() as Array<{
      source_type: string;
      source_id: string;
      target_type: string;
      target_id: string;
    }>;
    return rows.map((e) => {
      const src =
        e.source_type === "concept"
          ? conceptName(e.source_id)
          : `${e.source_type}:${e.source_id}`;
      const tgt =
        e.target_type === "concept"
          ? conceptName(e.target_id)
          : `${e.target_type}:${e.target_id}`;
      return `${src} -> ${tgt}`;
    });
  }

  function countEntities(typeName: string): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name = ?")
        .get(typeName) as { n: number }
    ).n;
  }

  function countHierarchyEdge(
    sourceType: string,
    sourceId: string,
    targetType: string,
    targetId: string,
  ): number {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM hierarchy_edges
           WHERE source_type = ?
             AND source_id = ?
             AND target_type = ?
             AND target_id = ?
             AND relation = 'parent_of'`,
        )
        .get(sourceType, sourceId, targetType, targetId) as { n: number }
    ).n;
  }

  function projectIdOf(origin: number): string | null {
    const r = db
      .prepare("SELECT project_id FROM knowledge_nodes WHERE id = ?")
      .get(origin) as { project_id: string | null } | null;
    return r ? r.project_id : null;
  }

  // ── 가드 1·2 — project 단일 위계 + 끝만 실체 ────────────────────────────────
  test("가드1·2 — `#프로젝트:라이브2D #라이브2D:동글이 #인형극` → 프로젝트→라이브2D(개념)→동글이(엔티티) 단일 갈래·끝만 실체·누수 0", async () => {
    const content = "#프로젝트:라이브2D #라이브2D:동글이 #인형극";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    // 끝만 실체 — entities 에 '동글이' project 행 하나만(라이브2D 는 중간 개념).
    expect(countEntities("project")).toBe(1);
    const dongguli = await store.findProjectByName("동글이");
    expect(dongguli).not.toBeNull();
    const liveAsEntity = await store.findProjectByName("라이브2D");
    expect(liveAsEntity).toBeNull(); // 라이브2D 는 entity 아님(중간 마디).

    // 루트 개념 '프로젝트' 존재.
    const root = await store.findConceptByName("프로젝트");
    expect(root).not.toBeNull();
    // '라이브2D' 는 개념(중간 폴더)으로 존재.
    const liveConcept = await store.findConceptByName("라이브2D");
    expect(liveConcept).not.toBeNull();

    // 단일 갈래 — 프로젝트 -> 라이브2d -> project:동글이행. 개념 이름은 소문자 canonical 로
    // 저장된다("라이브2D" → "라이브2d"). 누수 `라이브2d -> 동글이(개념)` 없음·
    // `프로젝트 -> project:동글이행` 직결 없음(반드시 라이브2D 개념을 거친다).
    const hier = readableHierarchy();
    expect(hier).toContain("프로젝트 -> 라이브2d");
    expect(hier).toContain(`라이브2d -> project:${dongguli!.projectId}`);
    // 누수 차단 — 라이브2d(개념) -> 동글이(개념) classification 엣지가 없다(끝-실체가 라벨/개념으로 안 샘).
    expect(hier).not.toContain("라이브2d -> 동글이");
    // 프로젝트 루트가 끝-실체 행에 직결되지 않는다(중간 개념을 반드시 거친다).
    expect(hier).not.toContain(`프로젝트 -> project:${dongguli!.projectId}`);

    // project 는 entities 단일 모델 — 끝-실체에 identity entity_concept_edge 가 안 붙는다(D6 무접촉).
    const ece = db
      .prepare(
        "SELECT COUNT(*) AS n FROM entity_concept_edges WHERE entity_id = ?",
      )
      .get(dongguli!.projectId) as { n: number };
    expect(ece.n).toBe(0);
  });

  // ── 가드 3 — mid-chain 적용(라이브2D 가 사슬에 쓰여 행 0) ────────────────────
  test("가드3 — 사슬 중간 마디 '라이브2D' 는 isMidChainNode 로 1급 행을 안 만든다(끝-실체만 행)", async () => {
    const content = "#프로젝트:라이브2D #라이브2D:동글이";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    // 끝-실체 동글이만 행. 중간 마디 라이브2D 는 행 0(이름으로 project 행 조회 시 null).
    expect(await store.findProjectByName("동글이")).not.toBeNull();
    expect(await store.findProjectByName("라이브2D")).toBeNull();
    expect(countEntities("project")).toBe(1);
  });

  // ── 가드 4 — project 검색·project_id 회귀 0 ─────────────────────────────────
  test("가드4 — searchProjectsByFts 가 끝-실체에 도달 + knowledge_nodes.project_id 가 끝-실체를 가리킨다(setNodeProjectId 보존)", async () => {
    // 끝-실체 이름을 FTS 전체 토큰으로 잡히는 다어절로 둔다 — 2글자 한글의 trigram 부분
    // 매칭 한계(검색품질 Phase A 범위)와 무관하게 *색인 합류·검색 채널 도달* 자체를 고정한다.
    const content = "#프로젝트:라이브2D #라이브2D:동글이프로젝트";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    const dongguli = await store.findProjectByName("동글이프로젝트");
    expect(dongguli).not.toBeNull();

    // project_id 칸이 끝-실체(동글이프로젝트) 행을 가리킨다 — 중간 마디(라이브2D)가 아니다.
    expect(projectIdOf(origin)).toBe(dongguli!.projectId);

    // 검색 도달 — entities_fts(type_name='project' 필터)가 끝-실체를 잡는다(색인 합류 회귀 0).
    const fts = await store.searchProjectsByFts("동글이프로젝트", 10);
    expect(fts.some((r) => r.projectId === dongguli!.projectId)).toBe(true);

    // 의미 검색(entities_vec KNN·type_name='project' 필터)도 끝-실체에 도달한다.
    const qv = await embedder.embed("동글이프로젝트");
    const vec = await store.searchProjectsByVector(qv, 10);
    expect(vec.some((r) => r.projectId === dongguli!.projectId)).toBe(true);
  });

  // ── 가드 5 — 사람·라벨 동반 글 보존 ──────────────────────────────────────────
  test("가드5 — `#프로젝트:바라 #참여자:철수 #언어:타입스크립트` → 참여자만 project 라벨, 언어는 일반 위계", async () => {
    const content = "#프로젝트:바라 #참여자:철수 #언어:타입스크립트";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    // 바라만 project 행(철수는 project 라벨, 타입스크립트는 일반 분류 값).
    const bara = await store.findProjectByName("바라");
    expect(bara).not.toBeNull();
    expect(countEntities("project")).toBe(1);
    expect(await store.findProjectByName("철수")).toBeNull();
    expect(await store.findProjectByName("타입스크립트")).toBeNull();

    // 남은 project 라벨(참여자:철수)은 addProjectConceptEdge 로 보존되고, 제거된 언어는 빠진다.
    const cheolsu = await store.findConceptByName("철수");
    const lang = await store.findConceptByName("언어");
    const ts = await store.findConceptByName("타입스크립트");
    expect(cheolsu).not.toBeNull();
    expect(lang).not.toBeNull();
    expect(ts).not.toBeNull();
    const labelEdges = db
      .prepare(
        "SELECT concept_id FROM entity_concept_edges WHERE entity_id = ? AND role IN ('classification','tag')",
      )
      .all(bara!.projectId) as Array<{ concept_id: string }>;
    const labelConceptIds = new Set(labelEdges.map((e) => e.concept_id));
    expect(labelConceptIds.has(cheolsu!.conceptId)).toBe(true);
    expect(labelConceptIds.has(ts!.conceptId)).toBe(false);
    expect(
      countHierarchyEdge("concept", lang!.conceptId, "concept", ts!.conceptId),
    ).toBe(1);

    // project_id 는 바라(끝이자 머리·단독 선언)를 가리킨다.
    expect(projectIdOf(origin)).toBe(bara!.projectId);
  });

  // ── 가드 6 — subcategory project 단축 ───────────────────────────────────────
  test("가드6 — `#프로젝트:코딩`(코딩=project subcategory) → 코딩은 분류 폴더라 행 0·개념", async () => {
    const content = "#프로젝트:코딩";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    // 코딩 = project subcategory(yaml) → 끝 마디라도 분류 폴더라 1급 행 아님(개념).
    expect(await store.findProjectByName("코딩")).toBeNull();
    expect(countEntities("project")).toBe(0);
    const codingConcept = await store.findConceptByName("코딩");
    expect(codingConcept).not.toBeNull();
    // 루트 '프로젝트' → '코딩' 위계가 선다(폴더 단축).
    const root = await store.findConceptByName("프로젝트");
    expect(root).not.toBeNull();
    expect(readableHierarchy()).toContain("프로젝트 -> 코딩");
  });

  // ── 가드 7 — 멱등 ──────────────────────────────────────────────────────────
  test("가드7 — 같은 글 두 번 입력 → 중복 0(행·위계·라벨)", async () => {
    const content = "#프로젝트:라이브2D #라이브2D:동글이 #인형극";
    const origin1 = await makeOrigin(content);
    await wireAll(origin1, content);
    const hierAfter1 = readableHierarchy().slice().sort();
    const entCount1 = countEntities("project");

    // 같은 글을 같은 origin 으로 다시 — 모든 하위 단계가 멱등이라 중복 0.
    await wireAll(origin1, content);
    const hierAfter2 = readableHierarchy().slice().sort();
    const entCount2 = countEntities("project");

    expect(entCount2).toBe(entCount1);
    expect(entCount2).toBe(1);
    expect(hierAfter2).toEqual(hierAfter1);
  });

  // ── 가드 8 — person 통로 무접촉(person A 결정 보존) ─────────────────────────
  test("가드8 — 사람 글 `#사람:철수 #직업:개발자` 는 project 합류와 무관하게 person 통로 그대로(행·라벨)", async () => {
    const content = "#사람:철수 #직업:개발자";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    // person 행은 전용 persons 테이블(person A) — entities project 합류가 안 건드린다.
    const personCount = (
      db.prepare("SELECT COUNT(*) AS n FROM persons").get() as { n: number }
    ).n;
    expect(personCount).toBe(1);
    // project 행은 0(사람 글이라 project 합류 무관).
    expect(countEntities("project")).toBe(0);
    // 직업 라벨이 사람에게 붙는다(person 라벨 경로 보존).
    const dev = await store.findConceptByName("개발자");
    expect(dev).not.toBeNull();
  });

  // ── 가드 9 — 프로젝트 중간 마디 k=1 v=1(2026-06-27 단계3 후속 결함 수정) ─────
  test("가드9 — `#프로젝트:라이브2D #라이브2D:동글이` → 라이브2D k=1 v=1·프로젝트 k=1 v=0·동글이 entity", async () => {
    const content = "#프로젝트:라이브2D #라이브2D:동글이";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    // 중간 마디 '라이브2D' = 분류 키이자 분류 값(8타입 병원 k=1 v=1 과 대칭).
    const live = conceptFlagsByName("라이브2D");
    expect(live).not.toBeNull();
    expect(live!.k).toBe(1); // 결함 수정 핵심 — 이전엔 k=0 이었다.
    expect(live!.v).toBe(1); // OR 누적 — value 역할 보존(전제 1).

    // 루트 '프로젝트' = 분류 키(콜론 위계 부모). value 역할은 없다(끝 마디가 아님).
    const root = conceptFlagsByName("프로젝트");
    expect(root).not.toBeNull();
    expect(root!.k).toBe(1);
    expect(root!.v).toBe(0);

    // 끝-실체 '동글이' 는 entities 행 — 개념 노드가 아니다(개념 키 부여 대상 아님).
    expect(await store.findProjectByName("동글이")).not.toBeNull();
    expect(conceptFlagsByName("동글이")).toBeNull();
  });

  test("가드9b — `#프로젝트:코딩 #코딩:디롱` → 코딩 k=1 v=1·디롱 entity", async () => {
    const content = "#프로젝트:코딩 #코딩:디롱";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    // '코딩' 이 사슬 중간 마디(`#코딩:디롱` 의 키)면 k=1 v=1. 가드6(단독 `#프로젝트:코딩`)에서
    // '코딩' 은 끝 폴더라 다른 콜론 태그의 키로 안 쓰여 k 가 안 붙는 것과 대비된다(전제 2).
    const coding = conceptFlagsByName("코딩");
    expect(coding).not.toBeNull();
    expect(coding!.k).toBe(1);
    expect(coding!.v).toBe(1);

    // 끝-실체 '디롱' 은 entities 행.
    expect(await store.findProjectByName("디롱")).not.toBeNull();
    expect(conceptFlagsByName("디롱")).toBeNull();
  });

  test("가드9c — 단독 `#프로젝트:코딩`(코딩=끝 폴더) → 코딩 k=0 v=1(중간 마디 아님·단일 분류 잎 부모는 분류 키 아님)", async () => {
    const content = "#프로젝트:코딩";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    // 단독 선언의 '코딩' 은 다른 콜론 태그의 키로 안 쓰여 isMidChainNode=false → k 안 붙임.
    const coding = conceptFlagsByName("코딩");
    expect(coding).not.toBeNull();
    expect(coding!.k).toBe(0); // 전제 2 — 끝 폴더에 분류 키 잘못 부여 금지.
    expect(coding!.v).toBe(1);
  });

  // ── 가드 10 — 장소 8타입 byte 동일(수정이 8타입 경로 무접촉) ────────────────
  test("가드10 — `#장소:병원 #병원:피부과 #피부과:무지개의원` → 병원·피부과 k=1 v=1·무지개의원 entity(8타입 무변)", async () => {
    const content = "#장소:병원 #병원:피부과 #피부과:무지개의원";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    // 8타입(장소)의 중간 마디 병원·피부과 = k=1 v=1(wireGeneralClassification 통로 유지).
    const hospital = conceptFlagsByName("병원");
    const derm = conceptFlagsByName("피부과");
    expect(hospital).not.toBeNull();
    expect(derm).not.toBeNull();
    expect(hospital!.k).toBe(1);
    expect(hospital!.v).toBe(1);
    expect(derm!.k).toBe(1);
    expect(derm!.v).toBe(1);

    // 끝-실체 무지개의원 = place entities 행. (place 행 *개수* 는 단언하지 않는다 — `#장소:` 직접
    // 입력 칸 파서의 별도 사안이 깨진 이름 행을 한 개 더 만드는 기존 동작이 있고, 이는 수정 전후
    // byte 동일이라 이 결함 수정 범위 밖이다. 여기서는 8타입 중간 마디 플래그 byte 동일만 가린다.)
    const rainbow = db
      .prepare(
        "SELECT entity_id FROM entities WHERE type_name = 'place' AND name = ?",
      )
      .get("무지개의원") as { entity_id: string } | null;
    expect(rainbow).not.toBeNull();
  });

  // ── 가드 11 — 상속 무변(resolveInheritedType 는 k 무관) ─────────────────────
  test("가드11 — 생물>동물>고양이 위계 후 `#고양이:얼룩이` → 얼룩이 creature entity(상속 k 무관)", async () => {
    const seed = "#생물:동물 #동물:고양이 #고양이:까망이";
    const seedOrigin = await makeOrigin(seed);
    await wireAll(seedOrigin, seed);

    const content = "#고양이:얼룩이";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    // 얼룩이 = creature 행(고양이 위계 상속). 상속 경로는 분류 키 플래그와 무관하게 동작한다.
    expect(countEntities("creature")).toBeGreaterThanOrEqual(2); // 까망이 + 얼룩이.
    const dalEntity = db
      .prepare(
        "SELECT entity_id FROM entities WHERE type_name = 'creature' AND name = ?",
      )
      .get("얼룩이") as { entity_id: string } | null;
    expect(dalEntity).not.toBeNull();
  });

  // ── 가드 12 — 단일 갈래 보존(라이브2D k=1 이어도 entity 행 안 됨) ───────────
  test("가드12 — 라이브2D 가 k=1 이 돼도 entities project 행으로 승격 안 됨(mid-chain 가드 유지·끝 실체만 행)", async () => {
    const content = "#프로젝트:라이브2D #라이브2D:동글이";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    // k=1 로 바뀐 라이브2D 가 1급 entities 행이 되면 안 된다(개념 폴더로만 남는다).
    expect(await store.findProjectByName("라이브2D")).toBeNull();
    expect(countEntities("project")).toBe(1); // 동글이 하나만.
    const live = conceptFlagsByName("라이브2D");
    expect(live!.k).toBe(1); // 개념 플래그는 k=1.
  });

  test("가드13 — 긴 project 사슬 뒤 짧은 선언을 넣어도 프로젝트→네스트 직통 parent_of 를 만들지 않는다", async () => {
    const longContent =
      "#프로젝트:코딩 #코딩:게임 #게임:네스트, 알 키우기 게임을 만들고싶어서 기획해두었다";
    const longOrigin = await makeOrigin(longContent);
    await wireAll(longOrigin, longContent);

    const shortContent =
      "#프로젝트:네스트, 네스트는 문지르고 두드리고 사진을 보내는 기능으로 알을 키우는 게임이 될 것이다";
    const shortOrigin = await makeOrigin(shortContent);
    await wireAll(shortOrigin, shortContent);

    const root = await store.findConceptByName("프로젝트");
    const coding = await store.findConceptByName("코딩");
    const game = await store.findConceptByName("게임");
    const nest = await store.findProjectByName("네스트");
    expect(root).not.toBeNull();
    expect(coding).not.toBeNull();
    expect(game).not.toBeNull();
    expect(nest).not.toBeNull();

    expect(countHierarchyEdge("concept", root!.conceptId, "concept", coding!.conceptId)).toBe(1);
    expect(countHierarchyEdge("concept", coding!.conceptId, "concept", game!.conceptId)).toBe(1);
    expect(countHierarchyEdge("concept", game!.conceptId, "project", nest!.projectId)).toBe(1);
    expect(countHierarchyEdge("concept", root!.conceptId, "project", nest!.projectId)).toBe(0);
    expect(await store.entitiesRepo.findByName("work", "네스트")).toBeNull();
  });

  test("가드14 — 짧은 project 선언 뒤 긴 사슬이 완성되면 프로젝트→네스트 직통 parent_of 를 소급 제거한다", async () => {
    const shortContent =
      "#프로젝트:네스트, 네스트는 문지르고 두드리고 사진을 보내는 기능으로 알을 키우는 게임이 될 것이다";
    const shortOrigin = await makeOrigin(shortContent);
    await wireAll(shortOrigin, shortContent);

    const root = await store.findConceptByName("프로젝트");
    const nest = await store.findProjectByName("네스트");
    expect(root).not.toBeNull();
    expect(nest).not.toBeNull();
    expect(countHierarchyEdge("concept", root!.conceptId, "project", nest!.projectId)).toBe(1);

    const longContent =
      "#프로젝트:코딩 #코딩:게임 #게임:네스트, 알 키우기 게임을 만들고싶어서 기획해두었다";
    const longOrigin = await makeOrigin(longContent);
    await wireAll(longOrigin, longContent);

    const coding = await store.findConceptByName("코딩");
    const game = await store.findConceptByName("게임");
    expect(coding).not.toBeNull();
    expect(game).not.toBeNull();
    expect(countHierarchyEdge("concept", root!.conceptId, "concept", coding!.conceptId)).toBe(1);
    expect(countHierarchyEdge("concept", coding!.conceptId, "concept", game!.conceptId)).toBe(1);
    expect(countHierarchyEdge("concept", game!.conceptId, "project", nest!.projectId)).toBe(1);
    expect(countHierarchyEdge("concept", root!.conceptId, "project", nest!.projectId)).toBe(0);
  });

  test("가드15 — 같은 지름길 감축이 project 외 place leaf 에도 적용된다", async () => {
    const shortContent = "#장소:무지개의원";
    const shortOrigin = await makeOrigin(shortContent);
    await wireAll(shortOrigin, shortContent);

    const root = await store.findConceptByName("장소");
    const place = await store.entitiesRepo.findByName("place", "무지개의원");
    expect(root).not.toBeNull();
    expect(place).not.toBeNull();
    expect(countHierarchyEdge("concept", root!.conceptId, "place", place!.id)).toBe(1);

    const longContent = "#장소:병원 #병원:무지개의원";
    const longOrigin = await makeOrigin(longContent);
    await wireAll(longOrigin, longContent);

    const hospital = await store.findConceptByName("병원");
    expect(hospital).not.toBeNull();
    expect(countHierarchyEdge("concept", root!.conceptId, "concept", hospital!.conceptId)).toBe(1);
    expect(countHierarchyEdge("concept", hospital!.conceptId, "place", place!.id)).toBe(1);
    expect(countHierarchyEdge("concept", root!.conceptId, "place", place!.id)).toBe(0);
  });

  test("가드16 — `#프로젝트:코딩 #코딩:게임` 은 게임이 다른 타입 어휘여도 코딩→게임 분류 다리를 만든다", async () => {
    const content = "#프로젝트:코딩 #코딩:게임";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    const root = await store.findConceptByName("프로젝트");
    const coding = await store.findConceptByName("코딩");
    const game = await store.findConceptByName("게임");
    expect(root).not.toBeNull();
    expect(coding).not.toBeNull();
    expect(game).not.toBeNull();

    expect(countHierarchyEdge("concept", root!.conceptId, "concept", coding!.conceptId)).toBe(1);
    expect(countHierarchyEdge("concept", coding!.conceptId, "concept", game!.conceptId)).toBe(1);
    expect(await store.findProjectByName("게임")).toBeNull();
    expect(await store.entitiesRepo.findByName("work", "게임")).toBeNull();
  });

  test("가드17 — `#프로젝트:코딩 #코딩:앱` 은 앱을 project 하위분류 폴더로 두고 코딩→앱 다리를 만든다", async () => {
    const content = "#프로젝트:코딩 #코딩:앱";
    const origin = await makeOrigin(content);
    await wireAll(origin, content);

    const root = await store.findConceptByName("프로젝트");
    const coding = await store.findConceptByName("코딩");
    const app = await store.findConceptByName("앱");
    expect(root).not.toBeNull();
    expect(coding).not.toBeNull();
    expect(app).not.toBeNull();

    expect(countHierarchyEdge("concept", root!.conceptId, "concept", coding!.conceptId)).toBe(1);
    expect(countHierarchyEdge("concept", coding!.conceptId, "concept", app!.conceptId)).toBe(1);
    expect(await store.findProjectByName("앱")).toBeNull();
  });
});
