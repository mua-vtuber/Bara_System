/**
 * user-entity-group-node.test.ts — 새 user 종류 묶음 노드 누락 버그 수정 검증
 * (plan 2026-06-28 · G1 identity 통로 · G2 묶음 노드 출현 · G3 한글 라벨).
 *
 * 사용자가 화면으로 더한 새 종류(가계부·ledger)에 `#가계부:배달 #금액:17000` 같은 글을
 * 입력하면, 8 타입과 달리 그래프에 묶음 노드(가계부)로 안 뜨던 버그를 고친 뒤의 동작을
 * 검증한다:
 *   - G1: placeOneUserEntityType 이 잎 개념 + addNodeConceptEdge + user identity 엣지를
 *         8 타입과 대칭으로 깐다(role='identity' 엣지 1건).
 *   - G2: augmentWithEntities 가 런타임 명부(listUserEntityTypes)로 user 행을 entityRefs 에
 *         넣어 buildGroupNodes 가 묶음 노드(groupType=ledger)를 만든다.
 *   - G3: 묶음 노드 라벨이 koName('가계부')로 뜬다(GROUP_TYPE_KO 동적화).
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder + 실 입력 통로 — Mock 0. 새 종류 어휘는
 * entity-placement-loop.test.ts 의 registerEquipmentType 양식을 graph 환경으로 옮겨 주입한다
 * (yaml 파일 미변경·라우트 mergeConceptVocab 통로의 단위 등가물).
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
import {
  setEntityTypeOverride,
  setConceptVocabOverride,
  clearConceptVocabularyOverrides,
  loadConceptTypeVocabulary,
  type ConceptTypeVocabulary,
  type PlacementTypeName,
} from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";

beforeAll(async () => {
  await loadEmbedder();
});
afterAll(() => {});

let ctx: GraphTestContext;
let store: SqliteMemoryStore;

beforeEach(async () => {
  clearConceptVocabularyOverrides();
  resetClassifierCache();
  ctx = await makeGraphTestDeps();
  store = ctx.store;
});

afterEach(() => {
  // 동적 명부·어휘·분류기 캐시를 정적 10종으로 되돌린다(전역 누출 차단·2-reset 양식).
  setEntityTypeOverride([]);
  clearConceptVocabularyOverrides();
  resetClassifierCache();
  ctx.close();
});

/**
 * 새 종류 "가계부"(ledger·koName '가계부')를 DB 명부 + 동적 명부 + 어휘 캐시에 등록한다
 * (entity-placement-loop.test.ts registerEquipmentType 의 graph 환경 이식). server 부팅·
 * 종류 CRUD 와 같은 순서로 주입한다(동적 명부 → yaml 재파싱 → 어휘 override).
 */
function registerLedgerType(
  opts: { subcategories?: string[]; attributes?: string[]; columns?: string[] } = {},
): void {
  store.entityTypeRegistryDb.addEntityType({
    typeName: "ledger",
    koName: "가계부",
    idPrefix: "ldg_",
  });
  setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
  clearConceptVocabularyOverrides();
  resetClassifierCache();
  const yamlVocab = loadConceptTypeVocabulary();
  const merged: ConceptTypeVocabulary = new Map(yamlVocab);
  merged.set("ledger" as PlacementTypeName, {
    synonyms: [],
    subcategories: opts.subcategories ?? [],
    attributes: opts.attributes ?? [],
    columns: opts.columns ?? [],
  });
  setConceptVocabOverride(merged);
  resetClassifierCache();
}

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

/** sourceType==='entity_group' && groupType===<type> 인 묶음 노드를 찾는다. */
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

// ── G1 — identity 통로(잎 개념 + addNodeConceptEdge + user identity 엣지) ──────────

describe("G1 — user 종류 identity 통로(8 타입 대칭)", () => {
  test("`#가계부:배달` — entities 행 + role='identity' 엣지 정확히 1건", async () => {
    registerLedgerType();
    await processInput("#가계부:배달");

    const ent = await store.entitiesRepo.findByName("ledger", "배달");
    expect(ent).not.toBe(null);
    expect(ent!.id.startsWith("ldg_")).toBe(true);

    // G1 핵심 — user 행에 role='identity' 엣지가 1건 생긴다(수정 전엔 0건이었다).
    const idEdges = store
      .getEntityConceptEdges("ledger" as never, ent!.id)
      .filter((e) => e.role === "identity");
    expect(idEdges.length).toBe(1);

    // 잎 개념('배달')도 만들어져 글→잎개념 mention(addNodeConceptEdge classification)이 선다.
    const leaf = await store.findConceptByName("배달");
    expect(leaf).not.toBe(null);
    // identity 엣지가 가리키는 개념이 그 잎 개념과 같다(8 타입과 같은 키 — 검색 JOIN 도달).
    expect(idEdges[0]!.conceptId).toBe(leaf!.conceptId);
  });

  test("후보가 분류 단어로 끝나면(`#가계부:식비`·subcategory) identity 엣지 0(거짓 행 0)", async () => {
    registerLedgerType({ subcategories: ["식비"] });
    await processInput("#가계부:식비"); // 사슬이 분류 단어에서 끝남 — 잎 고유명 없음.
    const cnt = ctx.db
      .query("SELECT COUNT(*) AS c FROM entities WHERE type_name = 'ledger'")
      .get() as { c: number };
    expect(cnt.c).toBe(0);
  });
});

// ── G2 — 묶음 노드 출현(graph-augment 명부 확장) ─────────────────────────────

describe("G2 — user 종류 묶음 노드 출현", () => {
  test("`#가계부:배달` — 묶음 노드(groupType=ledger)가 뜬다", async () => {
    registerLedgerType();
    const { nodeById } = await buildGraphFor("#가계부:배달");

    const ent = await store.entitiesRepo.findByName("ledger", "배달");
    expect(ent).not.toBe(null);
    // user 행이 그래프 노드로 합류한다(entity:ledger:<id>).
    expect(nodeById.has(`entity:ledger:${ent!.id}`)).toBe(true);

    // G2 핵심 — buildGroupNodes 가 묶음 노드(groupType=ledger)를 만든다(수정 전엔 안 떴다).
    const grp = groupNode(nodeById, "ledger");
    expect(grp).not.toBeUndefined();
    expect(grp!.sourceType).toBe("entity_group");
    expect(grp!.groupType).toBe("ledger");
  });

  test("`#금액:17000` 동반 — 금액은 칸/라벨로 붙고 묶음 노드는 그대로 가계부", async () => {
    registerLedgerType({ columns: ["금액"] });
    const { nodeById } = await buildGraphFor("#가계부:배달 #금액:17000");

    const ent = await store.entitiesRepo.findByName("ledger", "배달");
    expect(ent).not.toBe(null);
    // 금액 칸이 is_column=1 로 저장(코어 범용 number 칸·plan 금액 정상 확정).
    const amt = ctx.db
      .query("SELECT attr_value, is_column FROM entity_attributes WHERE entity_id = ? AND attr_key = ?")
      .get(ent!.id, "금액") as { attr_value: string; is_column: number } | null;
    expect(amt).not.toBe(null);
    expect(amt!.attr_value).toBe("17000");
    expect(amt!.is_column).toBe(1);

    // 묶음 노드는 '금액 17000' 이 아니라 가계부(배달) 한 묶음으로 뜬다.
    const grp = groupNode(nodeById, "ledger");
    expect(grp).not.toBeUndefined();
  });
});

// ── G3 — 한글 라벨(GROUP_TYPE_KO 동적화) ────────────────────────────────────

describe("G3 — user 종류 묶음 노드 한글 라벨", () => {
  test("`#가계부:배달` 묶음 노드 라벨이 koName '가계부' 로 뜬다", async () => {
    registerLedgerType();
    const { nodeById } = await buildGraphFor("#가계부:배달");
    const grp = groupNode(nodeById, "ledger");
    expect(grp).not.toBeUndefined();
    // 동명 위계 루트 개념('가계부') 재사용이면 접미사 없는 '가계부', 가상 노드면 '가계부 (전체)'.
    // 둘 다 영문 코드명('ledger')이 아니라 한글 koName 으로 시작해야 한다(G3 핵심).
    expect(grp!.label.startsWith("가계부")).toBe(true);
    expect(grp!.label).not.toContain("ledger");
  });
});

// ── G5 문제1a — user 칸이 별개 분류 노드로 안 샌다(wireGeneralClassification 칸 제외 확장) ──

/** 이름이 정확히 일치하는 concept_nodes 행 수(별개 분류 노드 누수 측정). */
function conceptCount(name: string): number {
  const row = ctx.db
    .query("SELECT COUNT(*) AS c FROM concept_nodes WHERE name = ?")
    .get(name) as { c: number };
  return row.c;
}

/** sourceName(개념) → targetName(개념) parent_of 위계 엣지 수. */
function conceptHierEdgeCount(sourceName: string, targetName: string): number {
  const row = ctx.db
    .query(
      `SELECT COUNT(*) AS c FROM hierarchy_edges he
       JOIN concept_nodes sc ON sc.concept_id = he.source_id AND he.source_type = 'concept'
       JOIN concept_nodes tc ON tc.concept_id = he.target_id AND he.target_type = 'concept'
       WHERE sc.name = ? AND tc.name = ? AND he.relation = 'parent_of'`,
    )
    .get(sourceName, targetName) as { c: number };
  return row.c;
}

describe("G5 문제1a — user 칸이 별개 분류 노드로 안 샌다", () => {
  test("`#가계부:배달 #금액:17000` — '금액'·'17000' 분류 노드 0·`금액→17000` 위계 0·칸만 1건", async () => {
    registerLedgerType({ columns: ["금액"] });
    await processInput("#가계부:배달 #금액:17000");

    const ent = await store.entitiesRepo.findByName("ledger", "배달");
    expect(ent).not.toBe(null);

    // ① 금액 칸이 is_column=1 로 entities 칸에 정확히 1건(코어 범용 number 칸).
    const amtRows = ctx.db
      .query(
        "SELECT attr_value, is_column FROM entity_attributes WHERE entity_id = ? AND attr_key = '금액'",
      )
      .all(ent!.id) as { attr_value: string; is_column: number }[];
    expect(amtRows.length).toBe(1);
    expect(amtRows[0]!.attr_value).toBe("17000");
    expect(amtRows[0]!.is_column).toBe(1);

    // ② '금액'·'17000' 별개 분류 개념 노드가 안 생긴다(수정 전엔 addClassificationTag 가 만들었다).
    expect(conceptCount("금액")).toBe(0);
    expect(conceptCount("17000")).toBe(0);

    // ③ `금액 → 17000` 위계 엣지가 0(별개 분류 노드 쌍의 부산물도 없음).
    expect(conceptHierEdgeCount("금액", "17000")).toBe(0);
  });
});

// ── G5 문제1b — 다단 사슬 머리가 라벨(is_column=0)로 안 샌다 ───────────────────

describe("G5 문제1b — 다단 사슬 타입 머리 라벨 누수 0", () => {
  test("`#가계부:배달 #배달:돈까스 #금액:17000` — 머리 '가계부'·중간 '배달' 라벨 0·잎 '돈까스' 행", async () => {
    registerLedgerType({ columns: ["금액"] });
    await processInput("#가계부:배달 #배달:돈까스 #금액:17000");

    // 사슬 잎(돈까스)이 1급 행, 머리(가계부)·중간(배달)은 위계 폴더라 행이 아니다.
    const leaf = await store.entitiesRepo.findByName("ledger", "돈까스");
    expect(leaf).not.toBe(null);

    // 머리 '가계부' 가 entity_attributes 라벨(is_column=0)로 안 떨어진다(수정 전 실측 누수).
    const headLabel = ctx.db
      .query(
        "SELECT COUNT(*) AS c FROM entity_attributes WHERE entity_id = ? AND attr_key = '가계부'",
      )
      .get(leaf!.id) as { c: number };
    expect(headLabel.c).toBe(0);

    // 중간 마디 '배달' 도 라벨로 안 떨어진다(사슬 마디 키는 타입 선언이라 속성 아님).
    const midLabel = ctx.db
      .query(
        "SELECT COUNT(*) AS c FROM entity_attributes WHERE entity_id = ? AND attr_key = '배달'",
      )
      .get(leaf!.id) as { c: number };
    expect(midLabel.c).toBe(0);

    // 금액 칸은 그대로 is_column=1 로 잎 행에 붙는다(속성 귀속 보존).
    const amt = ctx.db
      .query(
        "SELECT attr_value, is_column FROM entity_attributes WHERE entity_id = ? AND attr_key = '금액'",
      )
      .get(leaf!.id) as { attr_value: string; is_column: number } | null;
    expect(amt).not.toBe(null);
    expect(amt!.attr_value).toBe("17000");
    expect(amt!.is_column).toBe(1);
  });
});

// ── G5 문제2 — user 묶음 노드 장식 = ring(8 종 동등·decorations 단위 테스트는 별 파일) ──
// 장식(ring)은 graph/render/decorations.test.ts 가 순수 함수로 검증한다(WebGL 비의존).
// 여기서는 placement+graph 합류만 보고, 장식 분기는 그 단위 테스트가 8 종 동등을 고정한다.
