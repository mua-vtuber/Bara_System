/**
 * entity-single-placement-leaf-e2e.test.ts — 단일 타입 배치 잎 개념 보장 끝에서 끝 실증
 * (2026-06-13 단일 타입 배치 잎 개념 보장 spec §6.2).
 *
 * 결함: `#일정:장터당번` 같은 단일 배치(타입 키 바로 다음에 어휘 밖 고유명)는 schedule
 * 엔티티 행은 생기는데 "장터당번" 잎 개념·글-연결·identity·위계가 빠져 그 행이 그래프에서
 * 외톨이였다. 근본 원인 = 콜론 태그가 타입 지시 키("일정") 하나뿐이라 잎을 만드는 두 통로
 * (wireGeneralClassification·linkSubcategoryToTypeRoot)가 모두 비껴갔다.
 *
 * 수정(S2-T1 갱신):
 *   - 잎 개념·글-연결·identity 는 행이 생긴 갈래에서 보장한다(검색 JOIN 키·mention 경로).
 *   - 위계 잎은 *엔티티 행 자체*다 — 단일 배치면 타입 루트("일정") → schedule행, 다단계면
 *     마지막 분류 단("피부과") → place행 parent_of 를 직접 쓴다(그림자 잎 개념 위계 0).
 *
 * 검증: 단일 배치 정상화(잎 개념·글-연결·identity 생김 + 타입 루트 → 행 위계·warn 없음) /
 * 다단계 회귀 0(피부과 → place행 잎·지름길 없음) / 행 게이트 막힘 보존(`#장소:카페`) / 멱등.
 *
 * mock 클래스 0 — 실제 SQLite(:memory:) + 실제 Bgem3Embedder 로만 검증한다
 * (CLAUDE.md "DB/임베딩 의존 모듈은 실제 구현체와 통합 검증"). 데이터 fixture 만 쓴다.
 * LLM 단은 saveTextInput 안에서 null(default OFF) — 결정적 1·2단 어휘로만 판정한다.
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
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";
import { saveTextInput } from "../server-internal/save-input.ts";
import type { SaveTextInputArgs } from "../server-internal/save-input.ts";
import { wireEntityPlacement } from "./entity-placement-wiring.ts";

describe("entity-single-placement-leaf-e2e — 단일 배치 외톨이 잎 합류 (spec §6.2)", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
    // 운영 yaml 단일 출처를 읽는다(다른 테스트가 fixture path 로 캐시를 오염했을 수 있어 초기화).
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

  /** 글 입력 통로 그대로 — extractor·regex 미주입 plain 경로(LLM 단 null). */
  async function ingest(content: string): Promise<number> {
    const args: SaveTextInputArgs = {
      content,
      source: "dashboard:manual",
      author: "owner",
      userId: "owner",
    };
    const result = await saveTextInput(store, args);
    return result.originNodeId!;
  }

  function hasParentOf(
    edges: { relation: string; sourceId: string; targetId: string }[],
    src: string,
    tgt: string,
  ): boolean {
    return edges.some(
      (e) =>
        e.relation === "parent_of" &&
        e.sourceId === src &&
        e.targetId === tgt,
    );
  }

  test("단일 배치 정상화 — `#일정:장터당번` 가 잎·글-연결·위계·identity 를 전부 만든다", async () => {
    // wireEntityPlacement 를 직접 불러 result.warnings 까지 확인한다(saveTextInput 은 warnings 를
    // 삼키므로). origin 노드는 입력 통로처럼 먼저 저장한다.
    // 파서 통일(방식 ②·결정 4): 값 경계가 쉼표/줄바꿈/#/줄 끝. 본문을 바로 붙이면 값이
    // "장터당번 5월 12일 마을회관 방문" 으로 통째로 삼키므로, 사용자 실데이터 양식대로
    // 쉼표로 본문을 가른다(spec §3.2) → 값이 "장터당번" 로 잘려 잎·identity 가 산다.
    const content = "#일정:장터당번, 5월 12일 마을회관 방문";
    const origin = await store.addNode({ content });
    const result = await wireEntityPlacement(store, origin, content);

    // 타입 판정 — schedule·단일 배치(subcategory 없음).
    expect(result.typeName).toBe("schedule");
    expect(result.subcategory).toBeNull();

    // 1) schedule 엔티티 행이 생긴다("장터당번").
    expect(result.entityRowCreated).toBe(true);
    const schedule = await store.entitiesRepo.findByName("schedule", "장터당번");
    expect(schedule).not.toBeNull();

    // 2) "장터당번" 잎 개념이 생긴다(L1 findOrCreateConcept 보장) — 옛 결함은 여기서 0이었다.
    const leaf = await store.findConceptByName("장터당번");
    expect(leaf).not.toBeNull();

    // 3) 글 → 잎 글-연결(node_concept_edges role classification)이 생긴다(L1).
    const nodeEdges = await store.listNodeConceptEdges({
      nodeId: origin,
      conceptId: leaf!.conceptId,
    });
    expect(nodeEdges.some((e) => e.role === "classification")).toBe(true);

    // 4) 타입 루트(일정) → schedule 행(잎) parent_of 한 단이 선다(S2-T1·weight 0.9).
    //    위계 잎은 엔티티 행 자체다 — 옛 양식의 일정 → 장터당번(그림자 잎 개념)을 행 직접
    //    위계로 대체한다(그림자 잎 위계 0). 잎 개념·글-연결·identity 는 위에서 보존 확인.
    const root = await store.findConceptByName("일정");
    expect(root).not.toBeNull();
    const edges = store.getHierarchyEdgesWithin([
      root!.conceptId,
      leaf!.conceptId,
      schedule!.id,
    ]);
    expect(hasParentOf(edges, root!.conceptId, schedule!.id)).toBe(true);
    const rootToLeaf = edges.find(
      (e) =>
        e.sourceId === root!.conceptId &&
        e.targetId === schedule!.id,
    );
    expect(rootToLeaf!.weight).toBe(0.9);
    // 그림자 잎 개념(장터당번 개념)이 위계 잎으로 쓰이는 엣지는 0.
    expect(hasParentOf(edges, root!.conceptId, leaf!.conceptId)).toBe(false);

    // 5) 엔티티 행 ↔ 잎 identity 엣지가 선다(L1·옛 결함은 0·warn "미연결"이었다).
    const identityEdges = store.getEntityConceptEdges(
      "schedule",
      schedule!.id,
      "identity",
    );
    expect(identityEdges.length).toBe(1);
    expect(identityEdges[0]!.conceptId).toBe(leaf!.conceptId);

    // 6) "identity 미연결" warn 이 사라진다(잎이 늘 보장되므로).
    expect(
      result.warnings.some((w) => w.includes("identity")),
    ).toBe(false);
  });

  test("다단계 회귀 0 — `#장소:병원 #병원:피부과 #피부과:무지개의원` 잎 1개·지름길 없음·직결 추가 0", async () => {
    // 파서 통일(방식 ②·결정 4): 마지막 태그 #피부과:무지개의원 뒤에 본문을 바로 붙이면
    // 값이 "무지개의원 오늘 무지개의원 다녀옴" 으로 삼킨다. 사용자 실데이터 양식대로 쉼표로
    // 본문을 가른다(spec §3.2) → 잎 값이 "무지개의원" 으로 잘려 사슬 4쌍이 산다. 앞 태그
    // 둘은 # 경계로 이미 각각 잡힌다(병원·피부과).
    await ingest("#장소:병원 #병원:피부과 #피부과:무지개의원, 오늘 무지개의원 다녀옴");

    // 잎 "무지개의원" 개념이 정확히 1개(중복 0 — L1 findOrCreateConcept 가 같은 노드 합류).
    const rainbow = await store.findConceptByName("무지개의원");
    expect(rainbow).not.toBeNull();
    const rainbowRows = db
      .prepare("SELECT COUNT(*) AS n FROM concept_nodes WHERE name = '무지개의원'")
      .get() as { n: number };
    expect(rainbowRows.n).toBe(1);

    // 다단계 사슬: 장소 → 병원 → 피부과 → 무지개의원 parent_of 가 선다.
    const place = await store.findConceptByName("장소");
    const hospital = await store.findConceptByName("병원");
    const derma = await store.findConceptByName("피부과");
    expect(place).not.toBeNull();
    expect(hospital).not.toBeNull();
    expect(derma).not.toBeNull();
    // place 행을 먼저 잡는다 — 위계 잎이 그 행 자체다(S2-T1·마지막 분류 단 → place행).
    const rainbowRow = await store.entitiesRepo.findByName("place", "무지개의원");
    expect(rainbowRow).not.toBeNull();

    const ids = [
      place!.conceptId,
      hospital!.conceptId,
      derma!.conceptId,
      rainbow!.conceptId,
      rainbowRow!.id,
    ];
    const edges = store.getHierarchyEdgesWithin(ids);
    expect(hasParentOf(edges, place!.conceptId, hospital!.conceptId)).toBe(true);
    expect(hasParentOf(edges, hospital!.conceptId, derma!.conceptId)).toBe(true);
    // 잎 = place 행 — 피부과 → place행 직접(그림자 잎 개념 위계 0·S2-T1).
    expect(hasParentOf(edges, derma!.conceptId, rainbowRow!.id)).toBe(true);
    expect(hasParentOf(edges, derma!.conceptId, rainbow!.conceptId)).toBe(false);

    // 지름길 없음 — 장소 → place행 직결이 생기지 않는다(2-(a)/2-(b) 보존).
    expect(hasParentOf(edges, place!.conceptId, rainbowRow!.id)).toBe(false);

    // place 행의 직접 부모는 피부과 하나뿐이어야 한다(위계 부모 단정·타입 루트→행 직결 0).
    const parentSrcs = edges
      .filter(
        (e) => e.relation === "parent_of" && e.targetId === rainbowRow!.id,
      )
      .map((e) => e.sourceId);
    expect(parentSrcs).toEqual([derma!.conceptId]);

    // 잎 ↔ place 행 identity 는 정상으로 선다(검색 JOIN 키·모든 행 생성 갈래에서 돈다).
    const identityEdges = store.getEntityConceptEdges(
      "place",
      rainbowRow!.id,
      "identity",
    );
    expect(identityEdges.length).toBe(1);
  });

  test("직접 입력 갈래 제외 — `#장소:카페`(단독 잎) 콜론 타입 배치에서 빠짐(라이브 유령 차단·직접 입력 전담)", async () => {
    // 라이브 결함 수정: `#장소`(place reserved key)의 *단독 잎* 콜론 태그는 직접 입력
    // 파서(쉼표 경계·setPlace)가 전담하므로 wireEntityPlacement 콜론 타입 배치에서 빠진다.
    // "카페" 는 다른 콜론 키로 안 이어지는 단독 잎이라 제외 대상(사슬 진입점이면 보존하나
    // 여기선 단독). 따라서 이 콜론 배치 경로로는 place 행·위계·typeName 이 안 생긴다.
    const origin = await store.addNode({ content: "#장소:카페 오늘 카페 갔다" });
    const result = await wireEntityPlacement(store, origin, "#장소:카페 오늘 카페 갔다");

    // place 단독 잎 그룹이 제외돼 콜론 타입 배치 산출 0(typeName place 아님·행 0).
    expect(result.typeName).not.toBe("place");
    expect(result.entityRowCreated).toBe(false);
    // 단계4 T4 — place 행은 전용 테이블이 아니라 범용 본체 entities(type_name='place')에 산다.
    const placeRows = db
      .prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name = 'place'")
      .get() as { n: number };
    expect(placeRows.n).toBe(0);

    // 콜론 타입 배치가 빠졌으니 타입 루트(장소) → 카페 단일 배치 직결 위계도 없다.
    const place = await store.findConceptByName("장소");
    const cafe = await store.findConceptByName("카페");
    if (place && cafe) {
      const placeToCafe = store
        .getHierarchyEdgesWithin([place.conceptId, cafe.conceptId])
        .some(
          (e) =>
            e.relation === "parent_of" &&
            e.sourceId === place.conceptId &&
            e.targetId === cafe.conceptId,
        );
      expect(placeToCafe).toBe(false);
    }
    // place 행 생성 검증은 직접 입력 경로(hashtag-entity-wiring.place.test.ts·C-1 폐기 후
    // "seed·일반명사 #장소:서울 → places 행 1")가 전담한다 — #장소 가 직접 입력 전담이 된
    // 새 설계 정합. 여기 행 0 은 wireEntityPlacement 가 place 단독 잎을 안 다뤄서지 씨앗 가드 때문이 아니다.
  });

  test("멱등 — 같은 단일 배치 글을 두 번 처리해도 잎·글-연결·위계·identity 중복 0", async () => {
    // 파서 통일(방식 ②·결정 4): 본문을 바로 붙이면 값이 삼키므로 쉼표로 가른다(spec §3.2).
    const content = "#일정:장터당번, 마을회관 방문";
    const origin = await store.addNode({ content });
    await wireEntityPlacement(store, origin, content);
    await wireEntityPlacement(store, origin, content); // 두 번째 — 멱등.

    const leaf = await store.findConceptByName("장터당번");
    expect(leaf).not.toBeNull();

    // 잎 개념 1개(name UNIQUE 합류).
    const leafRows = db
      .prepare("SELECT COUNT(*) AS n FROM concept_nodes WHERE name = '장터당번'")
      .get() as { n: number };
    expect(leafRows.n).toBe(1);

    // 글-연결 1개(INSERT OR IGNORE 멱등).
    const nodeEdges = await store.listNodeConceptEdges({
      nodeId: origin,
      conceptId: leaf!.conceptId,
      role: "classification",
    });
    expect(nodeEdges.length).toBe(1);

    // schedule 행 1개(범용 본체 entities·type_name='schedule' — 단계4 T4).
    const scheduleRows = db
      .prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name = 'schedule'")
      .get() as { n: number };
    expect(scheduleRows.n).toBe(1);
    const schedule = await store.entitiesRepo.findByName("schedule", "장터당번");

    // 타입 루트 → schedule 행 parent_of 1개(INSERT OR IGNORE 멱등·S2-T1 위계 잎 = 행).
    const root = await store.findConceptByName("일정");
    const edges = store.getHierarchyEdgesWithin([
      root!.conceptId,
      leaf!.conceptId,
      schedule!.id,
    ]);
    const rootToLeaf = edges.filter(
      (e) =>
        e.relation === "parent_of" &&
        e.sourceId === root!.conceptId &&
        e.targetId === schedule!.id,
    );
    expect(rootToLeaf.length).toBe(1);
    // identity 1개.
    const identityEdges = store.getEntityConceptEdges(
      "schedule",
      schedule!.id,
      "identity",
    );
    expect(identityEdges.length).toBe(1);
  });
});
