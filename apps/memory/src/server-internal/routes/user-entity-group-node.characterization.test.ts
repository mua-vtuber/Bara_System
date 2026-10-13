/**
 * user-entity-group-node.characterization.test.ts — 10종(8 + person + project) 그래프
 * 합류 현 동작 고정(특성 테스트·plan G0.5).
 *
 * 새 user 종류 묶음 노드 누락 버그(plan 2026-06-28)를 고치기 전에, 코드 10종의 현
 * 동작(identity 엣지 → 묶음 노드 종류 → 검색 도달 위계선)을 *수정 전 현 코드로* 고정한다.
 * G1~G3 내내 이 테스트가 green 으로 남으면 10종 회귀 0 의 기계 증명이다 — placement 통로
 * (G1)·graph-augment 명부 확장(G2)·GROUP_TYPE_KO 동적화(G3)가 8종·person·project 의
 * 동작을 바꾸지 않았음을 매 단계가 확인한다.
 *
 * user 종류(가계부·ledger)는 *별 파일*(user-entity-group-node.test.ts)에서 버그→수정을
 * 단계별로 검증한다 — 이 특성 파일은 user 종류를 *손대면 안 되는 10종*과 분리해 회귀
 * 안전망 역할만 진다(plan "특성 테스트 먼저·green 유지").
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder + 실 입력 통로(wireHashtagEntities →
 * wireEntityPlacement) — Mock 0(CLAUDE.md "DB/임베딩 의존 모듈은 실 구현체로 통합 검증").
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
import { loadEmbedder, makeGraphTestDeps } from "./graph.test-helpers.ts";
import type { GraphTestContext } from "./graph.test-helpers.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import { augmentWithEntities, buildGroupNodes } from "./graph.ts";
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

beforeEach(async () => {
  resetConceptTypeVocabularyCache();
  resetClassifierCache();
  ctx = await makeGraphTestDeps();
  store = ctx.store;
});

afterEach(() => {
  ctx.close();
});

/** 입력 한 줄을 실제 통로(사람·프로젝트 + 엔티티 배치)로 처리한다. */
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

/** 글 노드 한 개를 nodeById seed 로 넣는다(graph-augment.test.ts 양식). */
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

/** 입력 → augment → buildGroupNodes 한 번에 돌려 nodeById·edgeSet 을 돌려준다. */
async function buildGraphFor(
  content: string,
): Promise<{ nodeId: number; nodeById: Map<string, GraphNode>; edgeSet: Map<string, GraphEdge> }> {
  const nodeId = await processInput(content);
  const nodeById = seedNodeMap(nodeId, content);
  const edgeSet = new Map<string, GraphEdge>();
  const refs = await augmentWithEntities(store, nodeById, edgeSet);
  buildGroupNodes(nodeById, edgeSet, refs);
  return { nodeId, nodeById, edgeSet };
}

/**
 * nodeById 에서 한 묶음 노드를 찾는다(없으면 undefined). 묶음 노드는 두 모습 중 하나다
 * (graph-group-nodes §5.4 ④):
 *   · group:<type> 가상 노드(동명 위계 루트 개념이 없을 때 — 작품·사람 등).
 *   · 동명 위계 루트 개념 노드를 재사용(sourceType 을 entity_group 으로 올리고 groupType
 *     을 채운 노드 — `#장소:카페`·`#일정:장터당번` 처럼 타입 루트 개념이 떠 있는 단일 배치).
 * 둘 다 sourceType==="entity_group" && groupType===<type> 라 그 조건으로 가린다(키 모양에
 * 의존하지 않음 — 통합/가상 어느 쪽이든 묶음 노드의 본질은 이 두 칸이다).
 */
function groupNode(
  nodeById: Map<string, GraphNode>,
  groupType: string,
): GraphNode | undefined {
  for (const node of nodeById.values()) {
    if (node.sourceType === "entity_group" && node.groupType === groupType) {
      return node;
    }
  }
  return undefined;
}

// ── 8 타입(정적 코드 종류) — identity 엣지 + 묶음 노드 + 위계 합류 현 동작 ──────────

describe("8 타입 현 동작 고정 — identity 엣지 + 묶음 노드(가림 안 됨)", () => {
  test("creature `#생물:동물 #동물:고양이 #고양이:까망이` — entities 행 + identity 엣지 1건", async () => {
    await processInput("#생물:동물 #동물:고양이 #고양이:까망이");
    const ent = await store.entitiesRepo.findByName("creature", "까망이");
    expect(ent).not.toBe(null);
    // identity 엣지(role='identity')가 entity_concept_edges 에 정확히 1건(행 기준 조회).
    const idEdges = store
      .getEntityConceptEdges("creature", ent!.id)
      .filter((e) => e.role === "identity");
    expect(idEdges.length).toBe(1);
  });

  test("work `#작품:소설 #소설:괴담` — 묶음 노드(groupType=work)·동명 위계 루트 '작품' 재사용", async () => {
    // 매체 사슬이 타입 루트 개념('작품')을 띄우므로 묶음 노드는 그 개념을 재사용한다
    // (§5.4 ④ 통합) — 가상 group:work 가 아니라 label '작품'(접미사 없음).
    const { nodeById } = await buildGraphFor("#작품:소설 #소설:괴담 #작가:백덕수");
    const grp = groupNode(nodeById, "work");
    expect(grp).not.toBeUndefined();
    expect(grp!.sourceType).toBe("entity_group");
    expect(grp!.groupType).toBe("work");
    expect(grp!.label).toBe("작품"); // 동명 위계 루트 개념 재사용(접미사 없음).
  });

  test("place `#장소:카페` — 묶음 노드(groupType=place)·동명 위계 루트 '장소' 재사용", async () => {
    const { nodeById } = await buildGraphFor("#장소:카페");
    const grp = groupNode(nodeById, "place");
    expect(grp).not.toBeUndefined();
    expect(grp!.sourceType).toBe("entity_group");
    expect(grp!.groupType).toBe("place");
    expect(grp!.label).toBe("장소"); // 타입 루트 개념('장소') 재사용(접미사 없음).
  });

  test("schedule `#일정:장터당번` — entities 행 + 묶음 노드(groupType=schedule)·'일정' 재사용", async () => {
    const { nodeById } = await buildGraphFor("#일정:장터당번");
    const ent = await store.entitiesRepo.findByName("schedule", "장터당번");
    expect(ent).not.toBe(null);
    const grp = groupNode(nodeById, "schedule");
    expect(grp).not.toBeUndefined();
    expect(grp!.sourceType).toBe("entity_group");
    expect(grp!.groupType).toBe("schedule");
    expect(grp!.label).toBe("일정"); // 타입 루트 개념('일정') 재사용(접미사 없음).
  });
});

// ── person·project — 묶음 노드 종류·라벨 현 동작 고정 ──────────────────────────

describe("person·project 현 동작 고정 — 묶음 노드 종류·라벨", () => {
  test("person `#사람:철수 #생일:1990-01-01` — group:person·label '사람 (전체)'", async () => {
    const { nodeById } = await buildGraphFor("#사람:철수 #생일:1990-01-01");
    const grp = groupNode(nodeById, "person");
    expect(grp).not.toBeUndefined();
    expect(grp!.groupType).toBe("person");
    expect(grp!.label).toBe("사람 (전체)");
    expect(grp!.sourceType).toBe("entity_group");
  });

  test("project `#프로젝트:바라` 단독 — 현재는 묶음 노드 미합류(현 동작 고정·RC 범위 밖)", async () => {
    // 단일 `#프로젝트:바라` 는 project 행이 개념 역조회(1.6)·node_person_edges(1) 어느
    // 경로로도 그래프에 합류하지 않아 묶음 노드가 안 뜬다 — 이 버그 plan(RC1·RC2)의
    // 범위 밖이라 손대지 않는다. 현 동작을 고정해 G1~G3 가 이 동작을 바꾸지 않았음을 본다
    // (project 묶음 회복은 별 줄기). 정직한 현 상태 기록이지 정상 보증이 아니다.
    const { nodeById } = await buildGraphFor("#프로젝트:바라");
    const grp = groupNode(nodeById, "project");
    expect(grp).toBeUndefined();
  });
});

// ── 8 타입 칸 — 별개 분류 노드로 안 새는 현 동작 고정(G5 문제1a 회귀 안전망) ──────────

/** 이름이 정확히 일치하는 concept_nodes 행 수(별개 분류 노드 누수 측정). */
function conceptCount(name: string): number {
  const row = ctx.db
    .query("SELECT COUNT(*) AS c FROM concept_nodes WHERE name = ?")
    .get(name) as { c: number };
  return row.c;
}

describe("8 타입 칸 현 동작 고정 — 칸이 별개 분류 노드로 안 샌다(G5 1a 회귀 0)", () => {
  test("schedule `#일정:장터당번 #날짜:2026-07-01` — 일정 전용 날짜 칸 0·별개 '날짜'/'2026-07-01' 분류 노드 0", async () => {
    await processInput("#일정:장터당번 #날짜:2026-07-01");
    const ent = await store.entitiesRepo.findByName("schedule", "장터당번");
    expect(ent).not.toBe(null);
    // schedule 은 전용 날짜 칸을 제거한 0칸 종류다. 날짜는 엔티티 attribute 가 아니라 글
    // event_at 통로가 맡는다(entity-type-registry.test / entity-attribute-wiring.test 정합).
    const col = ctx.db
      .query(
        "SELECT attr_key, is_column FROM entity_attributes WHERE entity_id = ? AND is_column = 1",
      )
      .all(ent!.id) as { attr_key: string; is_column: number }[];
    expect(col.length).toBe(0);
    // 별개 '날짜'/'2026-07-01' 분류 개념 노드가 안 생긴다(8 타입은 수정 전후 무변·회귀 0).
    expect(conceptCount("날짜")).toBe(0);
    expect(conceptCount("2026-07-01")).toBe(0);
  });

  test("intake `#섭취:우유 #유통기한:2026-07-01` — 유통기한 칸 저장·별개 '유통기한' 분류 노드 0", async () => {
    await processInput("#섭취:우유 #유통기한:2026-07-01");
    const ent = await store.entitiesRepo.findByName("intake", "우유");
    expect(ent).not.toBe(null);
    const col = ctx.db
      .query(
        "SELECT attr_key, is_column FROM entity_attributes WHERE entity_id = ? AND is_column = 1",
      )
      .all(ent!.id) as { attr_key: string; is_column: number }[];
    expect(col.length).toBe(1);
    expect(col[0]!.attr_key).toBe("expires_at");
    expect(conceptCount("유통기한")).toBe(0);
    expect(conceptCount("2026-07-01")).toBe(0);
  });
});

// ── 위계선·검색 도달 — 8 타입 행이 위계 잎으로 합류하는 현 동작 고정 ──────────────

describe("8 타입 위계 합류 현 동작 고정 — 위계 잎 행이 노드로 떠 묶음에 든다", () => {
  test("schedule 행이 그래프 노드로 합류한다(entity:schedule:<id> 노드 존재)", async () => {
    const { nodeById } = await buildGraphFor("#일정:장터당번");
    const ent = await store.entitiesRepo.findByName("schedule", "장터당번");
    expect(ent).not.toBe(null);
    expect(nodeById.has(`entity:schedule:${ent!.id}`)).toBe(true);
  });

  test("work 행이 그래프 노드로 합류한다(entity:work:<id> 노드 존재)", async () => {
    const { nodeById } = await buildGraphFor("#작품:소설 #소설:괴담 #작가:백덕수");
    const work = await store.entitiesRepo.findByName("work", "괴담");
    expect(work).not.toBe(null);
    expect(nodeById.has(`entity:work:${work!.id}`)).toBe(true);
  });
});
