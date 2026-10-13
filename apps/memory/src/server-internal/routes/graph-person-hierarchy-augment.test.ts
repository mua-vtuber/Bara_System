/**
 * graph-person-hierarchy-augment.test.ts — person 행 위계 잎 직접 합류 검증 (S1-T3).
 *
 * spec 2026-06-14 §6(그래프 빌드) · plan §6 S1-T3. 위계 단일 출처 재설계 Stage 1 의
 * 그래프 쪽 마지막 작업: person 행을 위계 잎으로 *직접* 그린다(그림자 인영희 개념 0).
 *
 * 실제 bun:sqlite(:memory:) + 실제 SqliteMemoryStore + 실제 임베딩 통합 테스트 —
 * Mock 클래스 0(CLAUDE.md "DB/임베딩 의존 모듈은 실제 구현체와 통합 검증"). 데이터는
 * 실제 입력 통로로 깐다: findOrCreatePersonByName 으로 사람 행을 먼저 만들고,
 * wirePersonHierarchy 로 `엄마(개념) → psn_인영희(person)` 위계 엣지를 hierarchy_edges
 * 에 직접 쓴다(S1-T1 완료분 재사용). 그 person 행은 글이 직접 언급하지 않아
 * node_person_edges 0 이라, 합류가 없으면 위계선이 닿지 않는 닭-달걀 상황을 재현한다.
 *
 * 검증 항목(S1-T3 Acceptance Criteria):
 *   1. 사람>가족>엄마>인영희(person 행) 4단이 별개 노드로 직접 위계선으로 이어진다
 *      (엄마→psn_인영희 엣지가 from=엄마 conceptKey·to=psn_인영희 personKey).
 *   2. 과흡수 회귀 0 — 같은 이름 무관 장소 개념이 person 노드로 빨려들지 않는다.
 *   3. 양끝 집합 안 불변식 — 매달린 엣지(끝점이 집합 밖) 0.
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
import { wirePersonHierarchy } from "../../memory/person-hierarchy-wiring.ts";
import { wireEntityPlacement } from "../../memory/entity-placement-wiring.ts";
import { wireHashtagEntities } from "../../memory/hashtag-entity-wiring.ts";
import { resetConceptTypeVocabularyCache } from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import { buildHierarchy } from "../../../web/dashboard/graph/layout/radial-hierarchy.ts";
import type {
  GraphNode as VmNode,
  GraphEdge as VmEdge,
} from "../../../web/dashboard/graph/graph-view-model.ts";

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

/** 글 노드 한 개를 nodeById seed 로 넣는다(글이 직접 언급한 개념을 함께 잇는다). */
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

/** 글이 직접 언급한 개념을 node_concept_edges 로 잇는다(집합 안 개념 seed). */
function linkNodeConcept(nodeId: number, conceptId: string, role = "tag"): void {
  db.prepare(
    "INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, ?, 'user_input', NULL)",
  ).run(nodeId, conceptId, role);
}

/**
 * 사람 4단 위계(`#사람:인영희 #관계:가족 #가족:엄마`)를 실제 입력 통로로 깐다.
 * - findOrCreatePersonByName 으로 인영희 person 행을 먼저 만든다(입력 통로의 행→위계 순서 재현).
 * - wirePersonHierarchy 로 사람→가족·가족→인영희 parent_of 를 hierarchy_edges 에 쓴다.
 *
 * 회신: { personId, momConceptId, familyConceptId, personRootId } — 테스트가 끝점을 단언하게.
 */
async function seedPersonHierarchy(): Promise<{
  personId: string;
  momConceptId: string;
  familyConceptId: string;
  personRootId: string;
}> {
  const person = await store.findOrCreatePersonByName("인영희");
  const content = "#사람:인영희 #관계:가족 #가족:엄마";
  const origin = await store.addNode({
    content,
    sourceType: "auto_capture",
    author: "owner",
    platform: "dashboard:manual",
  });
  await wirePersonHierarchy(store, origin, content);

  const family = await store.findOrCreateConcept("가족", {
    isClassificationValue: true,
  });
  const mom = await store.findOrCreateConcept("엄마", {
    isClassificationValue: true,
  });
  // person 타입 루트 개념 — wirePersonHierarchy 가 linkSubcategoryToTypeRoot 로 세운다.
  const personRoot = (
    db
      .prepare("SELECT concept_id FROM concept_nodes WHERE name = '사람'")
      .get() as { concept_id: string } | null
  )?.concept_id;
  return {
    personId: person.personId,
    momConceptId: mom,
    familyConceptId: family,
    personRootId: personRoot ?? "",
  };
}

// ── 검증 ─────────────────────────────────────────────────────────────────────

describe("augmentWithEntities — person 행 위계 잎 직접 합류 (S1-T3)", () => {
  test("엄마→psn_인영희 위계선이 직접 그려진다(글이 인영희를 직접 언급 안 해도)", async () => {
    const { personId, momConceptId } = await seedPersonHierarchy();

    // 글은 '엄마' 개념만 직접 언급한다 — 인영희 person 은 위계로만 걸린다(닭-달걀 재현).
    const nodeId = await store.addNode({
      content: "엄마 생각이 났다",
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    linkNodeConcept(nodeId, momConceptId);

    const nodeById = seedNodeMap(nodeId, "엄마 생각이 났다");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    // 1) 인영희 person 행이 위계 잎으로 합류했다(글이 직접 언급 안 했어도).
    const personNodeKey = `person:${personId}`;
    expect(nodeById.has(personNodeKey)).toBe(true);
    expect(nodeById.get(personNodeKey)!.sourceType).toBe("person");

    // 2) 엄마(개념) → psn_인영희(person) 위계선이 직접 그려진다.
    const momKey = `concept:${momConceptId}`;
    const hasMomToPerson = [...edgeSet.values()].some(
      (e) => e.from === momKey && e.to === personNodeKey && e.type === "parent_of",
    );
    expect(hasMomToPerson).toBe(true);
  });

  test("4단 사람>가족>엄마>인영희가 별개 노드로 사슬을 이룬다", async () => {
    const { personId, momConceptId, familyConceptId, personRootId } =
      await seedPersonHierarchy();

    // 글이 사람 루트·가족·엄마 세 개념을 다 직접 언급해 집합 안에 들어오게 한다 —
    // 그러면 사람→가족·가족→엄마·엄마→인영희 네 노드 사슬 전체가 한 화면에 모인다.
    const nodeId = await store.addNode({
      content: "가족 엄마 사람 이야기",
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    linkNodeConcept(nodeId, personRootId);
    linkNodeConcept(nodeId, familyConceptId);
    linkNodeConcept(nodeId, momConceptId);

    const nodeById = seedNodeMap(nodeId, "가족 엄마 사람 이야기");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const rootKey = `concept:${personRootId}`;
    const familyKey = `concept:${familyConceptId}`;
    const momKey = `concept:${momConceptId}`;
    const personNodeKey = `person:${personId}`;

    // 네 노드가 다 별개로 존재한다.
    expect(nodeById.has(rootKey)).toBe(true);
    expect(nodeById.has(familyKey)).toBe(true);
    expect(nodeById.has(momKey)).toBe(true);
    expect(nodeById.has(personNodeKey)).toBe(true);

    const hasEdge = (from: string, to: string): boolean =>
      [...edgeSet.values()].some(
        (e) => e.from === from && e.to === to && e.type === "parent_of",
      );
    // 사람>가족>엄마>인영희 세 단의 위계선이 다 그려진다.
    expect(hasEdge(rootKey, familyKey)).toBe(true);
    expect(hasEdge(familyKey, momKey)).toBe(true);
    expect(hasEdge(momKey, personNodeKey)).toBe(true);
  });

  test("과흡수 0 — 같은 이름 무관 장소 개념이 person 노드와 안 섞인다", async () => {
    const { personId, momConceptId } = await seedPersonHierarchy();

    // 인영희와 무관한 동명 장소 개념 '엄마네분식'을 별개로 깐다(흡수 단서 0 확인용).
    const placeNodeId = await store.addNode({
      content: "#장소:엄마네분식 점심 먹음",
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    await wireEntityPlacement(store, placeNodeId, "#장소:엄마네분식 점심 먹음");

    // 글이 엄마 개념을 직접 언급 → person 위계 잎 합류 경로를 탄다.
    const nodeId = await store.addNode({
      content: "엄마와 엄마네분식 갔다",
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    linkNodeConcept(nodeId, momConceptId);

    const nodeById = seedNodeMap(nodeId, "엄마와 엄마네분식 갔다");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    // person 노드는 인영희 한 명만 — 장소가 person 노드로 빨려들지 않는다.
    const personKeys = [...nodeById.keys()].filter((k) => k.startsWith("person:"));
    expect(personKeys).toEqual([`person:${personId}`]);
    // 인영희 person 노드의 sourceType 은 'person' 그대로(장소로 오염 안 됨).
    expect(nodeById.get(`person:${personId}`)!.sourceType).toBe("person");
  });

  test("양끝 집합 안 불변식 — 매달린 위계 엣지 0(끝점이 다 집합 안)", async () => {
    const { momConceptId } = await seedPersonHierarchy();

    const nodeId = await store.addNode({
      content: "엄마 메모",
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    linkNodeConcept(nodeId, momConceptId);

    const nodeById = seedNodeMap(nodeId, "엄마 메모");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    // 모든 엣지의 양끝이 nodeById 에 있다(매달린 엣지 0).
    for (const e of edgeSet.values()) {
      expect(nodeById.has(e.from)).toBe(true);
      expect(nodeById.has(e.to)).toBe(true);
    }
  });
});

// ── S1-T3b: 위계 상위 개념 합류(잎→루트 ancestor join) ───────────────────────

/**
 * augment 가 만든 노드/엣지(sourceType 칸)를 buildHierarchy 가 보는 view-model 노드
 * (type 칸)로 바꾼다. 글(auto_capture)은 'text', 그 밖은 sourceType 그대로 type 으로.
 * buildHierarchy 는 type 으로 1급/2급(person·concept)을 가른다.
 */
function toViewModel(
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
): { nodes: VmNode[]; edges: VmEdge[] } {
  const nodes: VmNode[] = [];
  for (const n of nodeById.values()) {
    const st = n.sourceType ?? "text";
    const type =
      st === "auto_capture" || st === "manual" || st === "text" ? "text" : st;
    nodes.push({ id: n.id, type, label: n.label ?? n.id, sourceType: st } as VmNode);
  }
  const edges: VmEdge[] = [];
  for (const e of edgeSet.values()) {
    edges.push({ id: e.id, from: e.from, to: e.to, type: e.type, weight: e.weight });
  }
  return { nodes, edges };
}

describe("augmentWithEntities — 위계 상위 개념 합류 (S1-T3b)", () => {
  test("글이 '엄마'만 언급해도 상위 개념 '사람'·'가족'이 노드로 합류한다", async () => {
    const { momConceptId, familyConceptId, personRootId } =
      await seedPersonHierarchy();

    // 글은 '엄마' 개념만 직접 언급한다 — '가족'·'사람' 상위 개념은 언급 0.
    const nodeId = await store.addNode({
      content: "엄마 생각이 났다",
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    linkNodeConcept(nodeId, momConceptId);

    const nodeById = seedNodeMap(nodeId, "엄마 생각이 났다");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    // 글이 직접 언급 안 한 '가족'·'사람' 이 부모 방향으로 거슬러 올라가 합류한다.
    expect(nodeById.has(`concept:${familyConceptId}`)).toBe(true);
    expect(nodeById.has(`concept:${personRootId}`)).toBe(true);
  });

  test("상위 합류로 buildHierarchy 가 사람→가족→엄마→인영희 정상 사슬·사람이 루트", async () => {
    const { personId, momConceptId, familyConceptId, personRootId } =
      await seedPersonHierarchy();

    const nodeId = await store.addNode({
      content: "엄마 생각이 났다",
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    linkNodeConcept(nodeId, momConceptId);

    const nodeById = seedNodeMap(nodeId, "엄마 생각이 났다");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const { nodes, edges } = toViewModel(nodeById, edgeSet);
    const h = buildHierarchy(nodes, edges);

    const rootKey = `concept:${personRootId}`;
    const familyKey = `concept:${familyConceptId}`;
    const momKey = `concept:${momConceptId}`;
    const personNodeKey = `person:${personId}`;

    // 사람이 사슬 루트다(엄마가 루트로 끊기던 옛 꼬임이 사라졌다).
    expect(h.roots).toContain(rootKey);
    expect(h.roots).not.toContain(momKey);
    // 정상 사슬: 가족←사람 · 엄마←가족 · 인영희←엄마.
    expect(h.parentOf.get(familyKey)).toBe(rootKey);
    expect(h.parentOf.get(momKey)).toBe(familyKey);
    expect(h.parentOf.get(personNodeKey)).toBe(momKey);
  });

  test("글이 인영희(person 잎)를 직접 언급해도 위계가 mention prio 60 에 안 뒤집힌다", async () => {
    const { personId, momConceptId } = await seedPersonHierarchy();

    // 글이 엄마 개념 + 인영희 person 을 둘 다 직접 언급(prio 60 mention 경합 재현).
    const nodeId = await store.addNode({
      content: "엄마랑 인영희 만났다",
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    linkNodeConcept(nodeId, momConceptId);
    db.prepare(
      "INSERT INTO node_person_edges (node_id, person_id, relation, provenance, source_node_id) VALUES (?, ?, ?, 'user_input', NULL)",
    ).run(nodeId, personId, "mentions");

    const nodeById = seedNodeMap(nodeId, "엄마랑 인영희 만났다");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const { nodes, edges } = toViewModel(nodeById, edgeSet);
    const h = buildHierarchy(nodes, edges);

    // 인영희 부모는 글(prio 60)이 아니라 엄마(위계 prio 40)다 — (d) 상위 합류가
    // 사슬 양끝을 채워 위계선이 그어진 덕에 prio 경합이 위계 손으로 풀린다((b) 불요).
    expect(h.parentOf.get(`person:${personId}`)).toBe(`concept:${momConceptId}`);
  });

  test("상위 합류 재귀 — visited·상한 방어(깊은 사슬에서 노드 폭증·무한 루프 0)", async () => {
    const { momConceptId, familyConceptId, personRootId } =
      await seedPersonHierarchy();

    const nodeId = await store.addNode({
      content: "엄마 메모",
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    linkNodeConcept(nodeId, momConceptId);

    const nodeById = seedNodeMap(nodeId, "엄마 메모");
    const edgeSet = new Map<string, GraphEdge>();

    // 무한 루프 없이 정상 종료(거슬러 올라가는 사슬이 루트에서 멈춘다).
    await augmentWithEntities(store, nodeById, edgeSet);

    // 사슬 노드는 정확히 한 번씩만 합류한다(visited 중복 0).
    const familyKey = `concept:${familyConceptId}`;
    const rootKey = `concept:${personRootId}`;
    expect([...nodeById.keys()].filter((k) => k === familyKey)).toHaveLength(1);
    expect([...nodeById.keys()].filter((k) => k === rootKey)).toHaveLength(1);

    // 위계선도 종류별로 한 번씩(중복 엣지 0).
    const parentEdges = [...edgeSet.values()].filter((e) => e.type === "parent_of");
    const seen = new Set<string>();
    for (const e of parentEdges) {
      const k = `${e.from}->${e.to}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});

// ── S1-LIVE 결함 가드: 등록 글의 주 사람 mentions → buildHierarchy 글 부모 정합 ──

describe("augmentWithEntities — 등록 글이 주 사람에 매달린다 (S1-LIVE 결함 가드)", () => {
  /**
   * 이놀부 등록 글(#사람:이놀부 #관계:가족 #가족:막내 #별명:놀부 #별명:셋째 #생일:..)을
   * 실제 입력 통로 순서(wireHashtagEntities → wireEntityPlacement→wirePersonHierarchy)로
   * 처리하고, 그 글 노드 하나를 seed 로 augment→buildHierarchy 한다. 회신은 글 노드 id 와
   * 이놀부 personId 다.
   */
  async function processRegistrationGlobal(content: string): Promise<{
    nodeId: number;
    personId: string;
  }> {
    const nodeId = await store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    await wireHashtagEntities(store, nodeId, content);
    await wireEntityPlacement(store, nodeId, content, { llm: null });
    const person = await store.findPersonByName("이놀부");
    if (!person) throw new Error("이놀부 person 행이 등록 글 처리로 생기지 않았다");
    return { nodeId, personId: person.personId };
  }

  test("이놀부 등록 글의 부모는 막내(역할 개념)가 아니라 이놀부(위계 잎)다", async () => {
    // S1-LIVE 실측 결함 재현: 옛 동작은 등록 글에 mentions 가 없어 글이 이놀부에 못
    // 매달리고 막내(classification prio 30)로 떨어졌다. 등록 글의 주 사람 mentions
    // (prio 60)이 서면 글의 부모가 이놀부가 되고, 이놀부 위로 막내→가족→사람 사슬이
    // 이어진다(사람>가족>막내>이놀부>글). 표시(buildHierarchy)까지 데이터로 흐른다.
    const content =
      "#사람:이놀부 #관계:가족 #가족:막내 #별명:놀부 #별명:셋째 #생일:1991년8월19일";
    const { nodeId, personId } = await processRegistrationGlobal(content);

    const nodeById = seedNodeMap(nodeId, content);
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    const { nodes, edges } = toViewModel(nodeById, edgeSet);
    const h = buildHierarchy(nodes, edges);

    const nodeKey = `node:${nodeId}`;
    const personNodeKey = `person:${personId}`;
    const momConceptId = await store.findOrCreateConcept("막내");
    const momKey = `concept:${momConceptId}`;

    // 글의 부모는 이놀부(위계 잎) — 막내(역할 개념)가 아니다.
    expect(h.parentOf.get(nodeKey)).toBe(personNodeKey);
    expect(h.parentOf.get(nodeKey)).not.toBe(momKey);

    // 이놀부 위로 막내→가족→사람 사슬이 정상으로 이어진다(글까지 합치면 5단).
    const familyConceptId = await store.findOrCreateConcept("가족");
    const personRootId = (
      db
        .prepare("SELECT concept_id FROM concept_nodes WHERE name = '사람'")
        .get() as { concept_id: string } | null
    )?.concept_id;
    expect(h.parentOf.get(personNodeKey)).toBe(momKey);
    expect(h.parentOf.get(momKey)).toBe(`concept:${familyConceptId}`);
    if (personRootId) {
      expect(h.parentOf.get(`concept:${familyConceptId}`)).toBe(
        `concept:${personRootId}`,
      );
    }

    const personMetaJson = JSON.stringify(nodeById.get(personNodeKey)!.meta);
    expect(personMetaJson).toContain("기본 정보");
    expect(personMetaJson).toContain("별칭");
    expect(personMetaJson).toContain("생일");
    expect(personMetaJson).toContain("놀부");
    expect(personMetaJson).toContain("셋째");
  });
});
