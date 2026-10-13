/**
 * colon-chain-structural-leaf-stage2.test.ts — 콜론 사슬 구조 기반 leaf 판정 단계2 회귀 가드
 * (2026-06-27 colon-chain-structural-placement spec §6-B·단계2 D1).
 *
 * mock 클래스 0 — 실제 SQLite(:memory:) + 실제 Bgem3Embedder + 실제 어휘 사전 +
 * 실제 wireEntityPlacement·wireHashtagEntities·setPlaceFlow 를 진짜 호출한다(CLAUDE.md
 * "DB/임베딩 의존 모듈은 실제 구현체와 통합 검증"). LLM 단은 null(default OFF).
 *
 * 단계2 핵심 = *두 통로*(콜론 사슬 wireEntityPlacement + 직접 입력 장소 wireHashtagEntities)가
 * 같은 구조 신호(isMidChainNode)를 보아, `#장소:병원` 같은 reserved place 키가 두 통로에서
 * 각자 해석돼 갈래가 둘로 쪼개지던 누수를 막는지 끝에서 끝으로 실증한다.
 *
 * 빈 DB 실험으로 debugger 가 확정한 누수 통로 = 직접 입력 장소 통로(place-provenance-flow
 * setPlaceFlow direct). `#장소` 가 reserved place 키라 wireHashtagEntities 가
 * setPlace(nodeId,"병원","direct") 를 불러 "병원" place 행 + 장소→병원(엔티티) 직결 +
 * identity 를 만들었다. 구조 신호 주입 후 그 갈래가 막혀야 단일 갈래가 된다.
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
  resetConceptTypeVocabularyCache,
  setEntityTypeOverride,
} from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";

describe("콜론 사슬 구조 leaf 단계2 회귀 가드 (§6-B 두 통로)", () => {
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
    // 새 종류 override 를 비워 다음 테스트·다른 파일로 명부가 새지 않게 한다(케이스 10 대비).
    setEntityTypeOverride([]);
    resetConceptTypeVocabularyCache();
    resetClassifierCache();
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

  /** 두 통로(직접 입력 장소 → 콜론 사슬)를 실제 입력 순서대로 함께 태운다. */
  async function runBothLanes(
    origin: number,
    content: string,
  ): Promise<Awaited<ReturnType<typeof wireEntityPlacement>>> {
    // 입력 통로 순서 — 사람·프로젝트·장소 직접 입력(wireHashtagEntities) 먼저, 그 다음
    // 엔티티 배치(wireEntityPlacement). 실제 saveTextInput 흐름과 같다.
    await wireHashtagEntities(store, origin, content, {});
    return wireEntityPlacement(store, origin, content, { llm: null });
  }

  function countEntities(typeName: string): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name = ?")
        .get(typeName) as { n: number }
    ).n;
  }

  function hasHierarchyEdge(srcId: string, tgtId: string): boolean {
    const edges = store.getHierarchyEdgesWithin([srcId, tgtId]);
    return edges.some(
      (e) =>
        e.relation === "parent_of" && e.sourceId === srcId && e.targetId === tgtId,
    );
  }

  // 1. 장소 단일 갈래(핵심) — 두 통로 함께 태워도 place:무지개의원만·중간 누수 0.
  test("1. 장소 단일 갈래 — 두 통로 함께 태워도 병원 엔티티 누수 0", async () => {
    const content =
      "#장소:병원, #병원:피부과, #피부과:무지개의원, #날짜:5월 12일, 보습 관리 받음";
    const origin = await makeOrigin(content);
    await runBothLanes(origin, content);

    // place 행 — 무지개의원만(끝 실체). 병원·피부과(중간 마디)는 행 0.
    expect(await store.entitiesRepo.findByName("place", "무지개의원")).not.toBeNull();
    expect(await store.entitiesRepo.findByName("place", "병원")).toBeNull();
    expect(await store.entitiesRepo.findByName("place", "피부과")).toBeNull();
    expect(countEntities("place")).toBe(1);

    // 단일 갈래 위계 — 장소 → 병원(개념) → 피부과(개념) → 무지개의원(엔티티 행).
    const jangso = await store.findConceptByName("장소");
    const byeongwon = await store.findConceptByName("병원");
    const pibugwa = await store.findConceptByName("피부과");
    const rainbowRow = await store.entitiesRepo.findByName("place", "무지개의원");
    expect(jangso).not.toBeNull();
    expect(byeongwon).not.toBeNull();
    expect(pibugwa).not.toBeNull();
    expect(rainbowRow).not.toBeNull();

    expect(hasHierarchyEdge(jangso!.conceptId, byeongwon!.conceptId)).toBe(true);
    expect(hasHierarchyEdge(byeongwon!.conceptId, pibugwa!.conceptId)).toBe(true);
    expect(hasHierarchyEdge(pibugwa!.conceptId, rainbowRow!.id)).toBe(true);

    // 장소 → 병원(엔티티) 직결 없음 — 병원 엔티티 행이 아예 없으니 직결 대상도 없다.
    // (누수가 있었다면 place:병원 행이 있고 장소→병원행 parent_of 가 생긴다.)
    const placeRows = db
      .query("SELECT name FROM entities WHERE type_name='place'")
      .all() as { name: string }[];
    expect(placeRows.map((r) => r.name).sort()).toEqual(["무지개의원"]);
  });

  // 2. 생물 byte 동일 — 정답 모델이 수정 전후 그대로.
  test("2. 생물 사슬 byte 동일 — 생물>동물>고양이>까망이(엔티티), 까망이만 행", async () => {
    const content = "#생물:동물 #동물:고양이 #고양이:까망이";
    const origin = await makeOrigin(content);
    const result = await runBothLanes(origin, content);

    expect(result.typeName).toBe("creature");
    expect(result.entityRowCreated).toBe(true);
    expect(await store.entitiesRepo.findByName("creature", "까망이")).not.toBeNull();
    expect(await store.entitiesRepo.findByName("creature", "동물")).toBeNull();
    expect(await store.entitiesRepo.findByName("creature", "고양이")).toBeNull();
    expect(countEntities("creature")).toBe(1);
  });

  // 3. #고양이:얼룩이 상속 유지 — 선행 글로 생물>동물>고양이 위계를 세운 뒤, #고양이:얼룩이 가
  //    상속으로 creature 로 잡히고 얼룩이는 mid-chain 아님 → 행 통과.
  //    (빈 DB 단독 #고양이:얼룩이 는 "고양이" 가 어휘 subcategory 가 아니라 분류 안 됨 — 상속
  //    전제가 핵심이라 선행 글을 먼저 태운다.)
  test("3. #고양이:얼룩이 — 선행 위계 상속 후 얼룩이 끝 마디라 creature 행 통과", async () => {
    // 글5 — 생물>동물>고양이>까망이 위계를 세운다("고양이" 가 DB 위계에 등록된다).
    const seed = "#생물:동물 #동물:고양이 #고양이:까망이";
    const seedOrigin = await makeOrigin(seed);
    await runBothLanes(seedOrigin, seed);

    // 글9 — #고양이:얼룩이. "고양이" 상속으로 creature, 얼룩이는 끝 마디라 행 통과.
    const content = "#고양이:얼룩이";
    const origin = await makeOrigin(content);
    const result = await runBothLanes(origin, content);

    expect(result.typeName).toBe("creature");
    expect(result.entityRowCreated).toBe(true);
    expect(await store.entitiesRepo.findByName("creature", "얼룩이")).not.toBeNull();
  });

  // 4. 고유명 직접 장소 보존(과제거 방지) — 뒤에 콜론 안 이어지면 mid-chain=false → 행 생성.
  test("4. #장소:강남마트 단독 — 뒤 콜론 없어 mid-chain 아님 → place 행 생성", async () => {
    const content = "#장소:강남마트, 장 보러 다녀옴";
    const origin = await makeOrigin(content);
    await runBothLanes(origin, content);

    expect(await store.entitiesRepo.findByName("place", "강남마트")).not.toBeNull();
    const row = db
      .query("SELECT metadata_json FROM knowledge_nodes WHERE id=?")
      .get(origin) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json).fieldSources.place).toBe("direct");
  });

  // 5. 분류서 끝나는 사슬 — 병원 mid-chain(행 0), 피부과는 끝이라 I3 상 실체.
  //    Phase 3 사용자 확인 대상(분류 단어로 끝나면 실체 만들지 여부) — 기본은 I3(끝=실체).
  test("5. #장소:병원 #병원:피부과 — 병원 mid-chain 행 0, 피부과는 끝이라 실체(I3 기본)", async () => {
    const content = "#장소:병원, #병원:피부과,";
    const origin = await makeOrigin(content);
    await runBothLanes(origin, content);

    // 병원 = mid-chain(뒤에 #병원: 이어짐) → place 행 0.
    expect(await store.entitiesRepo.findByName("place", "병원")).toBeNull();
    // 피부과 = 끝 마디(뒤에 #피부과: 없음) → I3 기본상 실체. place.subcategories 가 비어
    // 어휘 폴더 가드도 안 걸리므로 끝 고유명으로 행 생성된다.
    // (Phase 3 사용자 확인 대상: 분류 단어로 끝나면 실체 만들지 여부.)
    expect(await store.entitiesRepo.findByName("place", "피부과")).not.toBeNull();
    expect(countEntities("place")).toBe(1);
  });

  // 6. subcategory 단축 회귀 0 — #동물:나비 첫 입력 → 동물 subcategory 라 creature, 나비 leaf.
  test("6. #동물:나비 첫 입력 — subcategory 단축 유지, 나비 leaf 행", async () => {
    const content = "#동물:나비";
    const origin = await makeOrigin(content);
    const result = await runBothLanes(origin, content);

    expect(result.typeName).toBe("creature");
    expect(result.entityRowCreated).toBe(true);
    expect(await store.entitiesRepo.findByName("creature", "나비")).not.toBeNull();
    expect(await store.entitiesRepo.findByName("creature", "동물")).toBeNull();
  });

  // 7. synonyms 종류 판정 회귀 0 — #작업:바라 → project.
  test("7. #작업:바라 — synonyms 종류 판정 유지, project", async () => {
    const content = "#작업:바라";
    const origin = await makeOrigin(content);
    const result = await runBothLanes(origin, content);

    expect(result.typeName).toBe("project");
  });

  // 8. work 4-tuple·매체 분리 회귀 0 — 소설 mid-chain(행 0), 데못죽 leaf work + created_by.
  test("8. #작품:소설 #소설:데못죽 #작가:백덕수 — 소설 mid-chain 행 0, 데못죽 work + created_by", async () => {
    const content = "#작품:소설 #소설:데못죽 #작가:백덕수";
    const origin = await makeOrigin(content);
    const result = await runBothLanes(origin, content);

    expect(result.typeName).toBe("work");
    expect(result.subcategory).toBe("소설");
    expect(result.entityRowCreated).toBe(true);
    expect(await store.entitiesRepo.findByName("work", "데못죽")).not.toBeNull();
    expect(await store.entitiesRepo.findByName("work", "소설")).toBeNull();
    // created_by 관계 — 작가 백덕수.
    expect(result.relationEdges.length).toBe(1);
    expect(result.relationEdges[0]!.relation).toBe("created_by");
    expect(result.relationEdges[0]!.targetName).toBe("백덕수");
  });

  // 9. 멱등 — 같은 글 두 번 처리해도 중복 0.
  test("9. 멱등 — 장소 사슬 글을 두 통로로 두 번 처리해도 중복 0", async () => {
    const content =
      "#장소:병원, #병원:피부과, #피부과:무지개의원, #날짜:5월 12일, 보습";
    const origin = await makeOrigin(content);
    await runBothLanes(origin, content);
    await runBothLanes(origin, content); // 두 번째 — 멱등이라 새 행·중복 0.

    expect(countEntities("place")).toBe(1);
    expect(await store.entitiesRepo.findByName("place", "무지개의원")).not.toBeNull();
    expect(await store.entitiesRepo.findByName("place", "병원")).toBeNull();
  });

  // 10. 새 종류 통로 중간 마디 가드(통로 대칭 I6) — 새 종류 사슬에서도 중간 마디는 행 0.
  //     placeOneUserEntityType 은 8타입과 달리 shouldCreateEntityRow 게이트를 안 거쳐, 같은
  //     isMidChainNode 신호를 직접 적용한다(통로별 비대칭 차단). chainEntriesOf 가 진입점에서
  //     중간 마디를 이미 걸러 후보가 leaf 라 방어적 이중 안전이지만, 통로 대칭을 회귀로 고정한다.
  test("10. 새 종류 사슬 — 중간 마디 즈낙폴더는 행 0, 끝 즈낙실체만 행", async () => {
    // 새 종류 '장치류'(gizmo) 등록 + 명부 주입(어휘 어디에도 안 겹치는 단어로 사슬).
    store.entityTypeRegistryDb.addEntityType({
      typeName: "gizmo",
      koName: "장치류",
      idPrefix: "gzm",
    });
    resetConceptTypeVocabularyCache();
    setEntityTypeOverride([{ typeName: "gizmo", koName: "장치류" }]);
    resetClassifierCache();

    const content = "#장치류:즈낙폴더 #즈낙폴더:즈낙실체";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.typeName as string).toBe("gizmo");
    expect(result.entityRowCreated).toBe(true);
    // 끝 마디 즈낙실체만 행. 중간 마디 즈낙폴더(뒤에 #즈낙폴더: 이어짐)는 행 0(I2).
    expect(await store.entitiesRepo.findByName("gizmo", "즈낙실체")).not.toBeNull();
    expect(await store.entitiesRepo.findByName("gizmo", "즈낙폴더")).toBeNull();
    expect(countEntities("gizmo")).toBe(1);
  });
});
