/**
 * lineage-removal.test.ts — 제거 계획 planSourceRemoval(WP-B1-20T 설계 6.3·3.4·5.4, 12절 Minor 2건).
 *
 * 실제 SQLite(:memory:, 실제 스키마·마이그레이션) + 실제 bge-m3 + 실제 저장 경로(store.addNode 의 출처·계보
 * 기록). 긴 사슬은 SQL 로 직접 넣는 순수 데이터 픽스처다(노드·계보 엣지 행만 — 계획은 임베딩을 읽지 않는다).
 *
 *  - 선형 고정: 3,000·6,000 노드 사슬에서 세는 값(방문 노드 + 읽은 엣지 + 출처 행 조회)이 노드 수 + 엣지 수의
 *    상수 배 이하이고, 6,000 값이 3,000 값의 2.2배 이하. 출처 행 조회는 BFS 층마다 한 번(노드마다가 아님).
 *  - 계획은 출처 사건 표(memory_source_events)를 읽지 않는다 — 표 이름을 바꿔 치워도 같은 계획이 나온다.
 *  - message 방아쇠: 뿌리도 생존 규칙(자기 출처 행 또는 살아 남는 계보 부모)을 따른다. 출처 행으로 남는
 *    노드 아래로는 내려가지 않는다.
 *  - explicit 방아쇠 cascade(옛 trash 방아쇠, 설계 17.3): 뿌리는 출처 행이 있어도 옮기고, 자손은 자기 출처
 *    행·계획 밖 부모가 있으면 남는다. extractedTo 에만 남은 자식은 목록을 가진 노드를 부모로 함께 옮긴다.
 *  - explicit 방아쇠 selected_only(자동 정리): 고른 노드만 없애고, 고르지 않은 노드의 마지막 부모인 뿌리는
 *    막는다(blockedIds). 출처 행 없는 막힌 뿌리 위의 고른 부모도 막는다. 막기 걷기는 DB 를 더 읽지 않는다.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { NodeSourceRepository } from "../db/store-internal/node-source-repository.ts";
import { describeInputSource, sourceKeyOf } from "./node-sources/source-ref.ts";
import { planSourceRemoval, type RemovalPlan } from "./lineage-removal.ts";

const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";
/** 설계 7 T4 — 세는 값은 노드 수 + 엣지 수의 이 배수 이하여야 한다. */
const WORK_PER_ELEMENT = 3;
/** 설계 7 T4 — 노드 수를 두 배로 늘렸을 때 세는 값이 늘 수 있는 상한 배수. */
const DOUBLING_LIMIT = 2.2;
/** message 방아쇠의 BFS 한 층이 쓰는 SQL 문 수(출처 행 1 + 부모 엣지 1 + 자식 엣지 1). */
const QUERIES_PER_MESSAGE_LAYER = 3;

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function openDb(): Database {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  databases.push(db);
  return db;
}

function openStore(): { db: Database; store: SqliteMemoryStore } {
  const db = openDb();
  return { db, store: new SqliteMemoryStore(db, embedder) };
}

/**
 * 뿌리 → 자식 → 손자 ... 사슬(각 노드는 바로 앞 노드를 계보 부모로 둔다). 뿌리는 출처 행이 없다 —
 * deleteBySource 가 메시지 행을 지운 직후 계획에 넘기는 상태다. 반환: 노드 id(뿌리부터).
 */
function insertChain(db: Database, length: number): number[] {
  const insertNode = db.query("INSERT INTO knowledge_nodes (content, source_type) VALUES (?, ?) RETURNING id");
  const insertEdge = db.query(
    `INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id, weight)
     VALUES (?, ?, 'merged_into', 'system', ?, 1.0)`,
  );
  const ids: number[] = [];
  db.transaction(() => {
    for (let index = 0; index < length; index += 1) {
      const { id } = insertNode.get(`사슬 노드 ${index}`, index === 0 ? "auto_capture" : "llm_extract") as { id: number };
      if (index > 0) insertEdge.run(id, ids[index - 1]!, id);
      ids.push(id);
    }
  })();
  return ids;
}

function work(plan: RemovalPlan): number {
  return plan.stats.nodesVisited + plan.stats.edgesRead + plan.stats.sourceLookups;
}

function lineage(parentId: number, relation: "merged_into" | "parent_of" = "merged_into") {
  return { kind: "derived", parentId, relation, edgeProvenance: "system" } as const;
}

function messageRef(messageId: string) {
  return describeInputSource({ source: PLATFORM, metadata: { messageId, source: DISCORD_SOURCE } });
}

/** 메시지 출처로 저장한 노드(실제 store.addNode — 출처 행 기록 포함). */
async function saveMessage(store: SqliteMemoryStore, content: string, messageId: string): Promise<number> {
  return store.addNode({ content, platform: PLATFORM, metadata: { messageId, source: DISCORD_SOURCE } });
}

/** deleteBySource 1단계처럼 메시지 행을 지운다(계획은 그 뒤 상태를 받는다). */
function dropMessageRow(db: Database, nodeId: number, messageId: string): void {
  new NodeSourceRepository(db).deleteSync(nodeId, sourceKeyOf({ kind: "message", platform: PLATFORM, messageId }));
}

describe("선형 계획 고정 (설계 12절 Minor)", () => {
  test("3,000·6,000 노드 사슬: 세는 값이 노드 + 엣지의 상수 배 이하이고, 두 배 사슬에서 2.2배 이하", () => {
    const plans = [3000, 6000].map((length) => {
      const db = openDb();
      const chain = insertChain(db, length);
      const plan = planSourceRemoval(db, { kind: "message", rootIds: [chain[0]!] });
      expect(plan.rootIds).toEqual([chain[0]!]);
      expect(plan.removeIds).toEqual(chain);
      expect(plan.keptIds).toEqual([]);
      const edges = length - 1;
      expect(plan.stats.nodesVisited).toBe(length);
      // 출처 행은 BFS 층마다 한 번 묶어 읽는다 — 사슬은 층마다 노드 하나라 층 수 = 노드 수.
      expect(plan.stats.sourceLookups).toBe(length);
      expect(work(plan)).toBeLessThanOrEqual(WORK_PER_ELEMENT * (length + edges));
      // 뿌리 존재 확인 1번 + 층마다 상수 개의 문장 — 노드마다 따로 읽는 문장이 없다.
      expect(plan.stats.queries).toBeLessThanOrEqual(1 + QUERIES_PER_MESSAGE_LAYER * length);
      return plan;
    });
    const [small, large] = plans as [RemovalPlan, RemovalPlan];
    expect(work(large)).toBeLessThanOrEqual(DOUBLING_LIMIT * work(small));
  });

  test("넓은 층은 500개씩 묶어 읽는다 — 한 원문의 자식 1,200개는 출처 행 조회 1 + 3번", () => {
    const db = openDb();
    const [root] = insertChain(db, 1);
    const insertNode = db.query("INSERT INTO knowledge_nodes (content, source_type) VALUES (?, 'llm_extract') RETURNING id");
    const insertEdge = db.query(
      `INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id, weight)
       VALUES (?, ?, 'merged_into', 'system', ?, 1.0)`,
    );
    const children: number[] = [];
    db.transaction(() => {
      for (let index = 0; index < 1200; index += 1) {
        const { id } = insertNode.get(`넓은 자식 ${index}`) as { id: number };
        insertEdge.run(id, root!, id);
        children.push(id);
      }
    })();
    const plan = planSourceRemoval(db, { kind: "message", rootIds: [root!] });
    expect(plan.removeIds).toEqual([root!, ...children]);
    expect(plan.stats.sourceLookups).toBe(1 + Math.ceil(1200 / 500));
  });
});

describe("출처 사건 표를 읽지 않는다 (설계 12절 Minor)", () => {
  test("memory_source_events 를 치워도 같은 계획이 나온다", async () => {
    const { db, store } = openStore();
    const origin = await saveMessage(store, "사건 표 없이 계획하는 원문", "msg-events");
    const child = await store.addNode({ content: "원문에서 뽑은 사실", sourceType: "llm_extract", provenance: lineage(origin) });
    // 자식에 AI 저장 사건 행이 있어도 생존은 출처 행만 본다(설계 3.3·D5).
    db.query("INSERT INTO memory_source_events (event_key, node_id, evidence_json, created_at) VALUES (?, ?, '{}', ?)")
      .run("event-for-child", child, "2026-10-01T00:00:00+09:00");
    dropMessageRow(db, origin, "msg-events");
    const before = planSourceRemoval(db, { kind: "message", rootIds: [origin] });

    db.run("ALTER TABLE memory_source_events RENAME TO memory_source_events_hidden");
    const hidden = planSourceRemoval(db, { kind: "message", rootIds: [origin] });
    db.run("ALTER TABLE memory_source_events_hidden RENAME TO memory_source_events");

    expect(hidden).toEqual(before);
    expect(hidden.removeIds).toEqual([origin, child].sort((a, b) => a - b));
  }, 120_000);
});

describe("message 방아쇠 — 생존 규칙 (설계 3.4·5.3)", () => {
  test("다른 출처 행이 남은 뿌리는 남고, 그 아래로는 내려가지 않는다", async () => {
    const { db, store } = openStore();
    const origin = await saveMessage(store, "두 메시지가 같은 본문을 보냈다", "msg-1");
    expect(await saveMessage(store, "두 메시지가 같은 본문을 보냈다", "msg-2")).toBe(origin);
    const child = await store.addNode({ content: "같은 본문에서 뽑은 사실", sourceType: "llm_extract", provenance: lineage(origin) });
    dropMessageRow(db, origin, "msg-1");

    const plan = planSourceRemoval(db, { kind: "message", rootIds: [origin] });
    expect(plan).toMatchObject({ rootIds: [origin], removeIds: [], keptIds: [origin] });
    expect(plan.stats.nodesVisited).toBe(1);
    expect(await store.getNode(child)).not.toBeNull();
  }, 120_000);

  test("출처 행을 잃은 뿌리라도 살아 남는 계보 부모가 있으면 남고, 그 자손도 남는다", async () => {
    const { db, store } = openStore();
    const survivingOrigin = await store.addNode({ content: "살아 남는 다른 원문" });
    // 메시지 M 의 본문이 다른 원문의 파생 사실로 이미 있던 노드에 흡수된 모양: 행 {M} + 계보 부모.
    const root = await store.addNode({
      content: "다른 원문에서도 뽑힌 사실", sourceType: "llm_extract", provenance: lineage(survivingOrigin),
    });
    new NodeSourceRepository(db).insertSync(root, messageRef("msg-derived-root"));
    const grandChild = await store.addNode({ content: "그 사실의 자식", sourceType: "llm_extract", provenance: lineage(root) });
    dropMessageRow(db, root, "msg-derived-root");

    const plan = planSourceRemoval(db, { kind: "message", rootIds: [root] });
    expect(plan.removeIds).toEqual([]);
    expect(plan.keptIds).toEqual([root, grandChild].sort((a, b) => a - b));
  }, 120_000);

  test("자기 출처 행이 있는 자손은 남고 그 아래는 방문하지 않는다. 행 없는 형제는 지워진다", async () => {
    const { db, store } = openStore();
    const origin = await saveMessage(store, "자손 판정 원문", "msg-descendants");
    const heldChild = await store.addNode({ content: "대시보드에도 저장된 사실", sourceType: "llm_extract", provenance: lineage(origin) });
    new NodeSourceRepository(db).insertSync(
      heldChild,
      describeInputSource({ source: "dashboard", author: "owner" }),
    );
    const underHeld = await store.addNode({ content: "붙잡힌 사실의 자식", sourceType: "llm_extract", provenance: lineage(heldChild) });
    const bareChild = await store.addNode({ content: "원문에만 기댄 사실", sourceType: "llm_extract", provenance: lineage(origin) });
    dropMessageRow(db, origin, "msg-descendants");

    const plan = planSourceRemoval(db, { kind: "message", rootIds: [origin] });
    expect(plan.removeIds).toEqual([origin, bareChild].sort((a, b) => a - b));
    expect(plan.keptIds).toEqual([heldChild]);
    // 뿌리 + 자식 둘. 붙잡힌 자식의 자식(underHeld)은 방문하지 않는다.
    expect(plan.stats.nodesVisited).toBe(3);
    expect(plan.keptIds).not.toContain(underHeld);
  }, 120_000);

  test("없는 id·중복 id 는 뿌리가 되지 않는다", () => {
    const db = openDb();
    const [root] = insertChain(db, 1);
    const plan = planSourceRemoval(db, { kind: "message", rootIds: [root!, root!, 999_999] });
    expect(plan.rootIds).toEqual([root!]);
    expect(plan.removeIds).toEqual([root!]);
  });
});

describe("explicit 방아쇠 cascade 정책 — 사용자 휴지통·단건 영구 삭제 (설계 5.4·17.3)", () => {
  test("뿌리는 출처 행이 있어도 옮기고, 자손은 자기 출처 행·계획 밖 부모가 있으면 남는다", async () => {
    const { db, store } = openStore();
    const origin = await saveMessage(store, "휴지통으로 옮길 원문", "msg-trash");
    const otherOrigin = await store.addNode({ content: "옮기지 않는 다른 원문" });
    const bare = await store.addNode({ content: "원문에만 기댄 사실", sourceType: "llm_extract", provenance: lineage(origin) });
    const bareGrandChild = await store.addNode({ content: "그 사실의 자식", sourceType: "llm_extract", provenance: lineage(bare) });
    const held = await store.addNode({ content: "대시보드에도 저장된 사실", sourceType: "llm_extract", provenance: lineage(origin) });
    new NodeSourceRepository(db).insertSync(held, describeInputSource({ source: "dashboard", author: "owner" }));
    const shared = await store.addNode({ content: "두 원문이 공유한 사실", sourceType: "llm_extract", provenance: lineage(origin) });
    await store.absorbInput(shared, lineage(otherOrigin));

    const plan = planSourceRemoval(db, { kind: "explicit", rootIds: [origin], policy: "cascade" });
    expect(plan.rootIds).toEqual([origin]);
    expect(plan.removeIds).toEqual([origin, bare, bareGrandChild].sort((a, b) => a - b));
    expect(plan.keptIds).toEqual([held, shared].sort((a, b) => a - b));
    expect(plan.declaredParents.size).toBe(0);
  }, 120_000);

  test("extractedTo 에만 남은 자식은 목록을 가진 노드를 부모로 함께 옮기고, 출처 행이 있으면 남긴다", async () => {
    const { db, store } = openStore();
    const declaredOnly = await store.addNode({ content: "계보 엣지 없는 옛 자식", sourceType: "llm_extract" });
    const declaredHeld = await store.addNode({ content: "대시보드 저장이 붙잡은 옛 자식", sourceType: "llm_extract" });
    new NodeSourceRepository(db).insertSync(declaredHeld, describeInputSource({ source: "dashboard", author: "owner" }));
    const otherOrigin = await store.addNode({ content: "다른 원문" });
    const linkedElsewhere = await store.addNode({
      content: "다른 원문의 계보 자식", sourceType: "llm_extract", provenance: lineage(otherOrigin),
    });
    const origin = await store.addNode({
      content: "extractedTo 를 가진 원문",
      metadata: { extractedTo: [declaredOnly, declaredHeld, linkedElsewhere, 999_999, "x"] },
    });

    const plan = planSourceRemoval(db, { kind: "explicit", rootIds: [origin], policy: "cascade" });
    expect(plan.removeIds).toEqual([declaredOnly, origin].sort((a, b) => a - b));
    expect(plan.keptIds).toEqual([declaredHeld]);
    expect([...plan.declaredParents]).toEqual([[declaredOnly, [origin]]]);
    expect(plan.removeIds).not.toContain(linkedElsewhere);
  }, 120_000);

  test("없는 노드면 빈 계획", () => {
    const db = openDb();
    const plan = planSourceRemoval(db, { kind: "explicit", rootIds: [123_456], policy: "cascade" });
    expect(plan).toMatchObject({ rootIds: [], removeIds: [], keptIds: [], blockedIds: [] });
  });
});

describe("explicit 방아쇠 selected_only 정책 — 자동 정리 (설계 17.3 Q3 기본값)", () => {
  const selectedOnly = (rootIds: number[]) => ({ kind: "explicit", rootIds, policy: "selected_only" }) as const;

  test("고르지 않은 출처 없는 자식의 마지막 부모인 원문은 막고 아무것도 없애지 않는다", async () => {
    const { db, store } = openStore();
    const origin = await saveMessage(store, "가치가 낮아진 원문", "msg-auto-1");
    const child = await store.addNode({ content: "아직 쓸모 있는 추출 사실", sourceType: "llm_extract", provenance: lineage(origin) });

    const plan = planSourceRemoval(db, selectedOnly([origin]));
    expect(plan).toMatchObject({ rootIds: [origin], removeIds: [], blockedIds: [origin] });
    expect(plan.keptIds).toEqual([origin, child].sort((a, b) => a - b));
    // cascade 였다면 자식도 함께 없앴다 — 두 정책의 차이.
    expect(planSourceRemoval(db, { kind: "explicit", rootIds: [origin], policy: "cascade" }).removeIds)
      .toEqual([origin, child].sort((a, b) => a - b));
  }, 120_000);

  test("원문과 자식을 모두 고르면 함께 없앤다(막지 않음)", async () => {
    const { db, store } = openStore();
    const origin = await saveMessage(store, "함께 낮아진 원문", "msg-auto-2");
    const child = await store.addNode({ content: "함께 낮아진 추출 사실", sourceType: "llm_extract", provenance: lineage(origin) });

    const plan = planSourceRemoval(db, selectedOnly([origin, child]));
    expect(plan).toMatchObject({ removeIds: [origin, child].sort((a, b) => a - b), blockedIds: [] });
  }, 120_000);

  test("자기 출처 행이 있는 고르지 않은 자식과, 다른 원문에도 기대는 자식은 원문을 막지 않는다", async () => {
    const { db, store } = openStore();
    const origin = await saveMessage(store, "옮겨도 되는 원문", "msg-auto-3");
    const otherOrigin = await store.addNode({ content: "고르지 않은 다른 원문" });
    const held = await store.addNode({ content: "대시보드에도 저장된 사실", sourceType: "llm_extract", provenance: lineage(origin) });
    new NodeSourceRepository(db).insertSync(held, describeInputSource({ source: "dashboard", author: "owner" }));
    const shared = await store.addNode({ content: "두 원문이 공유한 사실", sourceType: "llm_extract", provenance: lineage(origin) });
    await store.absorbInput(shared, lineage(otherOrigin));

    const plan = planSourceRemoval(db, selectedOnly([origin]));
    expect(plan).toMatchObject({ removeIds: [origin], blockedIds: [] });
  }, 120_000);

  test("출처 행 없는 막힌 뿌리 위의 고른 부모도 막는다 — 막힌 노드가 부모 없이 남지 않게", async () => {
    const { db, store } = openStore();
    const origin = await saveMessage(store, "맨 위 원문", "msg-auto-4");
    const chunk = await store.addNode({ content: "고른 청크", sourceType: "document_chunk", provenance: lineage(origin, "parent_of") });
    const fact = await store.addNode({ content: "청크에서 뽑은 쓸모 있는 사실", sourceType: "llm_extract", provenance: lineage(chunk) });

    const plan = planSourceRemoval(db, selectedOnly([origin, chunk]));
    expect(plan.removeIds).toEqual([]);
    expect(plan.blockedIds).toEqual([origin, chunk].sort((a, b) => a - b));
    expect(plan.keptIds).toEqual([origin, chunk, fact].sort((a, b) => a - b));
  }, 120_000);

  test("막힌 뿌리 아래의 다른 고른 노드는 혼자 옮겨진다", async () => {
    const { db, store } = openStore();
    const origin = await saveMessage(store, "막힐 원문", "msg-auto-5");
    const useful = await store.addNode({ content: "고르지 않은 쓸모 있는 사실", sourceType: "llm_extract", provenance: lineage(origin) });
    const stale = await store.addNode({ content: "고른 낡은 사실", sourceType: "llm_extract", provenance: lineage(origin) });

    const plan = planSourceRemoval(db, selectedOnly([origin, stale]));
    expect(plan).toMatchObject({ removeIds: [stale], blockedIds: [origin] });
    expect(plan.keptIds).toEqual([origin, useful].sort((a, b) => a - b));
  }, 120_000);

  test("선형 고정: 뿌리만 고른 3,000·6,000 노드 사슬도 세는 값이 노드 + 엣지의 상수 배 이하, 두 배에서 2.2배 이하", () => {
    const plans = [3000, 6000].map((length) => {
      const db = openDb();
      const chain = insertChain(db, length);
      const plan = planSourceRemoval(db, selectedOnly([chain[0]!]));
      // 사슬 전체가 뿌리에 기대므로 뿌리를 막고 아무것도 없애지 않는다.
      expect(plan.removeIds).toEqual([]);
      expect(plan.blockedIds).toEqual([chain[0]!]);
      expect(plan.keptIds).toEqual(chain);
      expect(plan.stats.nodesVisited).toBe(length);
      expect(work(plan)).toBeLessThanOrEqual(WORK_PER_ELEMENT * (length + length - 1));
      return plan;
    });
    const [small, large] = plans as [RemovalPlan, RemovalPlan];
    expect(work(large)).toBeLessThanOrEqual(DOUBLING_LIMIT * work(small));
  });
});
