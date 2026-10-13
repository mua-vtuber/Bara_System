/**
 * graph-entity-augment.test.ts — augmentWithEntities 8 타입 행 위계 잎 직접 합류 검증.
 *
 * 위계 단일 출처 재설계 Stage 2(S2-T3). 옛 동작(identity 역조회 흡수로 8 타입 행을
 * 화면에 그리던 것)을 폐기하고, hierarchy_edges 위계 잎 행을 *직접* 노드 집합에 합류
 * 시키고 위계선을 있는 그대로 긋는다(그림자 잎 노드 0·흡수 0).
 *
 * 실제 bun:sqlite(:memory:) + 실제 SqliteMemoryStore + 실제 임베딩 통합 — Mock 클래스 0
 * (CLAUDE.md "DB/임베딩 의존 모듈은 실제 구현체와 통합 검증"). 데이터는 실제 입력 통로로
 * 깐다: wireHashtagEntities → wireEntityPlacement 가 분류 개념 → 엔티티 행 id 의
 * parent_of 를 hierarchy_edges 에 직접 쓴다(S2-T1 완료분 재사용). 그 행은 글이 직접
 * 언급 안 해도 위계 잎으로 합류해야 위계선이 닿는 닭-달걀 상황을 재현한다.
 *
 * 검증 항목(S2-T3 + S2-T4 Acceptance Criteria):
 *   1. 다단계 #장소:병원 #병원:피부과 #피부과:무지개의원 → place 행(plc_)이 위계 잎으로
 *      직접 합류(sourceType "place")·피부과 → place행 위계선 직접·그림자 잎 노드 0.
 *   2. 단일 배치 #일정:장터당번 → schedule 행(sch_)이 identity 역조회로 *자연* 합류
 *      (타입 루트 mention 인위 추가 없이)·일정 루트 → schedule 행 위계선(S2-T4·§6.3.5).
 *   3. 다단계 무영향 — identity 역조회 + 위계 자식 중복 합류 0(한 노드·entityRefs 1회).
 *   4. 과흡수 0 — 같은 이름 무관 개념/장소가 행에 안 섞인다(직접 add·합치기 0).
 *   5. entityRefs(반환값)에 합류된 행이 담긴다(Task4 인계).
 *   6. 양끝 집합 안 불변식 — 매달린 엣지(끝점이 집합 밖) 0.
 *   7. 기존 개념 합류 회귀 없음(엔티티 0개여도 개념 합류 정상).
 *
 * 참고 — '고양이'(#동물:고양이)는 씨앗 단어라 creature 행을 *안 만든다*(qa 확정·행
 * 게이트 createEntityRowIfNeeded). 행 합류 실증은 '무지개의원'·'장터당번' 같은 고유명
 * 잎으로 한다(고양이로는 행 노드가 안 떠도 정상).
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
import { loadEmbedder, makeGraphTestDeps } from "./graph.test-helpers.ts";
import type { GraphTestContext } from "./graph.test-helpers.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import { augmentWithEntities } from "./graph.ts";
import type { GraphNode, GraphEdge } from "./graph.ts";
import { wireHashtagEntities } from "../../memory/hashtag-entity-wiring.ts";
import { wireEntityPlacement } from "../../memory/entity-placement-wiring.ts";
import { resetConceptTypeVocabularyCache } from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";

beforeAll(async () => {
  await loadEmbedder();
});

afterAll(() => {});

let ctx: GraphTestContext;
let store: SqliteMemoryStore;
let db: Database;

beforeEach(async () => {
  // 운영 yaml 단일 출처를 읽는다(다른 테스트가 fixture path 로 캐시를 오염했을 수 있어 초기화).
  resetConceptTypeVocabularyCache();
  resetClassifierCache();
  ctx = await makeGraphTestDeps();
  store = ctx.store;
  db = ctx.db;
});

afterEach(() => {
  ctx.close();
});

// ── 데이터 삽입 헬퍼 ──────────────────────────────────────────────────────────

/** 글 노드 한 개를 nodeById seed 로 넣는다. */
function seedNodeMap(nodeId: number, content: string): Map<string, GraphNode> {
  const m = new Map<string, GraphNode>();
  m.set(`node:${nodeId}`, {
    id: `node:${nodeId}`,
    sourceId: nodeId,
    sourceType: "text",
    label: content.slice(0, 31),
    snippet: content,
  });
  return m;
}

/**
 * 입력 한 줄을 실제 통로(wireHashtagEntities → wireEntityPlacement)로 처리한다.
 * S2-T1 양식으로 분류 개념 → 엔티티 행 id parent_of 가 hierarchy_edges 에 직접 쓰인다.
 */
async function processInput(content: string): Promise<number> {
  const nodeId = await store.addNode({
    content,
    sourceType: "auto_capture",
    author: "owner",
    platform: "dashboard:manual",
  });
  await wireHashtagEntities(store, nodeId, content);
  await wireEntityPlacement(store, nodeId, content, { llm: null });
  return nodeId;
}

// ── 검증 ─────────────────────────────────────────────────────────────────────

describe("augmentWithEntities — 다단계 place 행 위계 잎 직접 합류 (S2-T3)", () => {
  test("#장소:병원 #병원:피부과 #피부과:무지개의원 → place 행이 위계 잎으로 직접·피부과→place행 위계선·그림자 잎 0", async () => {
    const content = "#장소:병원 #병원:피부과 #피부과:무지개의원";
    const nodeId = await processInput(content);

    // 무지개의원 place 행이 실제 생겼는지 먼저 확인(행 게이트 통과).
    const place = await store.entitiesRepo.findByName("place", "무지개의원");
    if (!place) throw new Error("무지개의원 place 행이 입력 통로 처리로 생기지 않았다");
    const dermatId = await store.findOrCreateConcept("피부과");

    const nodeById = seedNodeMap(nodeId, content);
    const edgeSet = new Map<string, GraphEdge>();

    const { entityRefs } = await augmentWithEntities(store, nodeById, edgeSet);

    // 1) place 행이 위계 잎으로 직접 합류한다(글이 행 id 를 직접 언급 안 해도).
    const placeNodeKey = `entity:place:${place.id}`;
    expect(nodeById.has(placeNodeKey)).toBe(true);
    expect(nodeById.get(placeNodeKey)!.sourceType).toBe("place");
    expect(nodeById.get(placeNodeKey)!.label).toBeTruthy();

    // 2) 피부과(개념) → place 행 위계선이 직접 그려진다(흡수 없이).
    const dermatKey = `concept:${dermatId}`;
    const hasDermatToPlace = [...edgeSet.values()].some(
      (e) => e.from === dermatKey && e.to === placeNodeKey && e.type === "parent_of",
    );
    expect(hasDermatToPlace).toBe(true);

    // 3) 위계 잎은 place 행뿐 — '무지개의원' 이름 개념은 위계 자식으로 안 그어진다.
    //    (행 ↔ 잎-개념 identity·개념 행은 검색 JOIN 키로 DB 에 남고, 글이 그 개념을
    //     classification 으로 언급해 글-mention 노드로는 합류할 수 있다. 하지만 그
    //     개념을 *끝점으로 가진 parent_of 위계선은 0* — 위계 잎 자리는 place 행이
    //     대신한다. 옛 흡수가 하던 일을 위계 단일 출처가 직접 해낸다.)
    const rainbowConcept = await store.findConceptByName("무지개의원");
    if (rainbowConcept) {
      const rainbowKey = `concept:${rainbowConcept.conceptId}`;
      const rainbowAsHierChild = [...edgeSet.values()].some(
        (e) => e.to === rainbowKey && e.type === "parent_of",
      );
      expect(rainbowAsHierChild).toBe(false);
    }

    // 4) entityRefs 에 place 행이 담긴다(Task4 인계).
    expect(entityRefs).toContainEqual({ type: "place", id: place.id });
  });
});

describe("augmentWithEntities — 단일 배치 schedule 행 위계 잎 직접 합류 (S2-T4)", () => {
  test("#일정:장터당번 → schedule 행이 identity 역조회로 자연 합류·일정 루트 → schedule 행 위계선(타입 루트 mention 인위 추가 없이)", async () => {
    // 단일 배치는 글이 잎 개념('장터당번')에만 mention 을 단다. 그 잎 개념은 위계 사슬
    // 밖이고(행과 identity 로만 옆 연결), 행의 부모인 타입 루트('일정')도 글이 직접
    // mention 하지 않는다. S2-T4(spec §6.3.5)가 identity 역조회를 노드 합류용으로
    // 되살려, 집합 안 잎 개념에서 schedule 행을 끌어와 노드로 add 하고(흡수 0), 그 행에서
    // 타입 루트 '일정' 까지 거슬러 합류시킨다. 그래서 S2-T3 가 쓰던 타입 루트 mention 인위
    // INSERT 우회 *없이* 자연 합류한다 — 그 우회 제거가 이 테스트의 핵심.
    const content = "#일정:장터당번";
    const nodeId = await processInput(content);

    const schedule = await store.entitiesRepo.findByName("schedule", "장터당번");
    if (!schedule) throw new Error("장터당번 schedule 행이 입력 통로 처리로 생기지 않았다");
    const rootId = (
      db
        .prepare("SELECT concept_id FROM concept_nodes WHERE name = '일정'")
        .get() as { concept_id: string } | null
    )?.concept_id;
    if (!rootId) throw new Error("일정 타입 루트 개념이 생기지 않았다");

    // 타입 루트 mention 인위 추가 없음 — 글이 잎 개념에만 mention 하는 단일 배치 그대로.
    const nodeById = seedNodeMap(nodeId, content);
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    // schedule 행이 identity 역조회로 노드 집합에 직접 합류한다.
    const schedKey = `entity:schedule:${schedule.id}`;
    expect(nodeById.has(schedKey)).toBe(true);
    expect(nodeById.get(schedKey)!.sourceType).toBe("schedule");

    // 타입 루트('일정')가 행에서 부모를 거슬러 합류한다(블록 1.6b 시작점에 행 추가됨).
    const rootKey = `concept:${rootId}`;
    expect(nodeById.has(rootKey)).toBe(true);

    // 일정 루트(개념) → schedule 행 위계선이 직접 그려진다(이중 위계 0·그림자 잎 0).
    const hasRootToSched = [...edgeSet.values()].some(
      (e) => e.from === rootKey && e.to === schedKey && e.type === "parent_of",
    );
    expect(hasRootToSched).toBe(true);

    // 위계 잎 자리는 schedule 행뿐 — '장터당번' 개념이 parent_of 위계 자식으로 안 그어진다.
    const marketConcept = await store.findConceptByName("장터당번");
    if (marketConcept) {
      const marketKey = `concept:${marketConcept.conceptId}`;
      const marketAsHierChild = [...edgeSet.values()].some(
        (e) => e.to === marketKey && e.type === "parent_of",
      );
      expect(marketAsHierChild).toBe(false);
    }

    // 과흡수 0 — schedule 행 노드는 잎 개념('장터당번') 노드와 *합쳐지지 않는다*.
    // 직접 add 라(흡수 0) 두 노드가 별개로 공존한다(잎 개념이 글-mention 노드로 떴다면).
    if (marketConcept) {
      const marketKey = `concept:${marketConcept.conceptId}`;
      // 잎 개념 노드가 떴으면 schedule 행과 별개 노드(합쳐 사라지지 않음).
      if (nodeById.has(marketKey)) {
        expect(nodeById.get(marketKey)!.sourceType).not.toBe("schedule");
      }
    }
  });
});

describe("augmentWithEntities — 다단계 무영향·과흡수 0 (S2-T4)", () => {
  test("다단계 place 행은 identity 역조회 + 위계 자식 중복 합류 0(한 노드)·위계선 정상", async () => {
    // 다단계(#장소:병원 #병원:피부과 #피부과:무지개의원)는 블록 1.55(위계 자식)가 이미
    // place 행을 합류한다. S2-T4 의 identity 역조회(블록 1.5b)가 같은 행을 또 잡아도
    // nodeById 중복 방지로 한 노드·collectedEntityRefs 도 중복 push 0 이어야 한다.
    const content = "#장소:병원 #병원:피부과 #피부과:무지개의원";
    const nodeId = await processInput(content);

    const place = await store.entitiesRepo.findByName("place", "무지개의원");
    if (!place) throw new Error("무지개의원 place 행이 입력 통로 처리로 생기지 않았다");
    const dermatId = await store.findOrCreateConcept("피부과");

    const nodeById = seedNodeMap(nodeId, content);
    const edgeSet = new Map<string, GraphEdge>();

    const { entityRefs } = await augmentWithEntities(store, nodeById, edgeSet);

    // place 행은 한 노드로만 합류(중복 키 없음 — Map 이라 자동, 단언으로 명시).
    const placeNodeKey = `entity:place:${place.id}`;
    expect(nodeById.has(placeNodeKey)).toBe(true);
    expect(nodeById.get(placeNodeKey)!.sourceType).toBe("place");

    // entityRefs 에 place 행이 *한 번만* 담긴다(블록 1.55 + 1.5b 이중 push 방어).
    const placeRefs = entityRefs.filter((r) => r.type === "place" && r.id === place.id);
    expect(placeRefs.length).toBe(1);

    // 피부과(개념) → place 행 위계선 정상(다단계 동작 무영향).
    const dermatKey = `concept:${dermatId}`;
    const hasDermatToPlace = [...edgeSet.values()].some(
      (e) => e.from === dermatKey && e.to === placeNodeKey && e.type === "parent_of",
    );
    expect(hasDermatToPlace).toBe(true);
  });

  test("과흡수 0 — 같은 이름 무관 개념/장소가 행에 안 섞인다(직접 add)", async () => {
    // 옛 라벨 일치 흡수는 "이름이 같다 = 같은 것" 전제로 무관 개념까지 행으로 빨아들였다.
    // S2-T4 는 identity 엣지(행 ↔ 그 행의 잎 개념)로만 역조회해 직접 add 하므로, 같은
    // 이름의 무관 개념이 행에 섞일 통로가 없다. 별개 입력으로 같은 라벨 무관 노드를 만들고
    // 그 무관 노드가 schedule 행 sourceType 으로 바뀌지 않음을 단언한다(흡수 0).
    const schedNodeId = await processInput("#일정:장터당번");
    const schedule = await store.entitiesRepo.findByName("schedule", "장터당번");
    if (!schedule) throw new Error("장터당번 schedule 행이 안 생겼다");

    // 같은 라벨 '장터당번' 를 가진 무관 일반 개념을 별도로 만들어 글에 tag 로 단다.
    // (identity 엣지 없는 순수 개념 — 흡수가 살아있었다면 라벨 일치로 빨렸을 후보.)
    const strayConcept = await store.findOrCreateConcept("장터당번메모");
    const strayNodeId = await store.addNode({
      content: "장터당번메모 무관 글",
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    db.prepare(
      "INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, 'tag', 'user_input', NULL)",
    ).run(strayNodeId, strayConcept);

    // 두 글을 한 화면에 함께 augment(흡수가 살아있었다면 화면 노드 집합 의존 과흡수).
    const nodeById = new Map<string, GraphNode>();
    nodeById.set(`node:${schedNodeId}`, {
      id: `node:${schedNodeId}`, sourceId: schedNodeId, sourceType: "text",
      label: "#일정:장터당번", snippet: "#일정:장터당번",
    });
    nodeById.set(`node:${strayNodeId}`, {
      id: `node:${strayNodeId}`, sourceId: strayNodeId, sourceType: "text",
      label: "장터당번메모 무관 글", snippet: "장터당번메모 무관 글",
    });
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    // 무관 개념 노드가 schedule 행으로 흡수돼 사라지지 않는다(직접 add 라 라벨 섞임 0).
    const strayKey = `concept:${strayConcept}`;
    expect(nodeById.has(strayKey)).toBe(true);
    expect(nodeById.get(strayKey)!.sourceType).not.toBe("schedule");

    // schedule 행은 자기 키로 별개 합류(과흡수로 무관 노드 끌어들이지 않음).
    const schedKey = `entity:schedule:${schedule.id}`;
    expect(nodeById.has(schedKey)).toBe(true);
    expect(nodeById.get(schedKey)!.sourceType).toBe("schedule");
  });
});

describe("augmentWithEntities — 양끝 집합 안 불변식 (S2-T3)", () => {
  test("8 타입 행 합류 후에도 모든 엣지의 양끝이 집합 안", async () => {
    const content = "#장소:병원 #병원:피부과 #피부과:무지개의원";
    const nodeId = await processInput(content);

    const nodeById = seedNodeMap(nodeId, content);
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    // 모든 엣지의 양끝이 nodeById 에 있다(매달린 엣지 0).
    for (const e of edgeSet.values()) {
      expect(nodeById.has(e.from)).toBe(true);
      expect(nodeById.has(e.to)).toBe(true);
    }
  });
});

describe("augmentWithEntities — 기존 합류 회귀 없음", () => {
  test("엔티티 없는 개념만 있어도 개념 노드가 정상 합류되고 entityRefs 는 빈 배열", async () => {
    const nodeId = await store.addNode({
      content: "평범한 글",
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    const plainId = await store.findOrCreateConcept("평범한개념");
    db.prepare(
      "INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, 'tag', 'user_input', NULL)",
    ).run(nodeId, plainId);

    const nodeById = seedNodeMap(nodeId, "평범한 글");
    const edgeSet = new Map<string, GraphEdge>();

    const { entityRefs } = await augmentWithEntities(store, nodeById, edgeSet);

    expect(nodeById.has(`concept:${plainId}`)).toBe(true);
    expect(entityRefs.length).toBe(0);
  });
});
