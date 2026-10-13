/**
 * save-input.idempotency.test.ts — P0-A 입력 멱등성 호출처 배선(T4).
 *
 * saveTextInput 이 같은 정규화 내용을 재입력받으면 origin 을 재사용하고(cacheHit),
 * 이어지는 청크·wiring·regex atomic 을 다시 돌리지 않아 DB 가 부풀지 않는지
 * 실제 bun:sqlite + Bgem3Embedder 통합으로 검증한다(mock 없음, LLM 무관 경로).
 *
 * plain 갈래(긴 글 포함)와 wiring skip 을 다룬다. immediate LLM 갈래의 프리체크는
 * Ollama 필요라 e2e(T6)에서 다룬다 — 여기선 LLM 없이 도는 경로만.
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
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { saveTextInput } from "./save-input.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

function count(db: Database, sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

let db: Database;
let store: SqliteMemoryStore;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  db.close();
});

describe("saveTextInput 멱등 — 짧은 글(plain 갈래)", () => {
  test("같은 글 2회 → 노드 1개 불변 + 둘째 cacheHit=true + 같은 originNodeId", async () => {
    const content = "오늘 회의에서 결정한 사항 세 가지";
    const r1 = await saveTextInput(store, {
      content,
      source: "dashboard:manual",
      chunking: { tokenCap: 2000 },
    });
    const r2 = await saveTextInput(store, {
      content,
      source: "dashboard:manual",
      chunking: { tokenCap: 2000 },
    });

    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
    expect(r2.originNodeId).toBe(r1.originNodeId);
    expect(count(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS c FROM vec_nodes")).toBe(1);
  });

  test("재입력이 mention_count 를 1 올린다(0→1)", async () => {
    const content = "반복되는 주제 문장";
    const r1 = await saveTextInput(store, { content, source: "x" });
    await saveTextInput(store, { content, source: "x" });
    const row = db
      .prepare("SELECT mention_count FROM knowledge_nodes WHERE id = ?")
      .get(r1.originNodeId!) as { mention_count: number };
    expect(row.mention_count).toBe(1);
  });

  test("재입력 시 wiring(mentions/author 엣지)이 부풀지 않는다", async () => {
    // 비-Discord 출처를 사용해 첫 저장 때 authored_by 사람 엣지가 생기게 한다.
    // Discord 출처는 정책상 authored_by 를 만들지 않으므로, 사람 연결이 부는지 검증하려면
    // 비-Discord 출처를 써야 한다(정책 2026-09-20).
    const content = "민수와 함께 작업한 회의록";
    await saveTextInput(store, {
      content,
      source: "slack",
      author: "민수",
      userId: "u-123",
    });
    const edgesAfterFirst = count(
      db,
      "SELECT COUNT(*) AS c FROM node_person_edges",
    );
    expect(edgesAfterFirst).toBe(1); // 비-Discord 출처이므로 authored_by 1개.
    const conceptEdgesAfterFirst = count(
      db,
      "SELECT COUNT(*) AS c FROM node_concept_edges",
    );

    // 재입력 — wiring skip 이므로 엣지 수가 그대로여야 한다.
    const r2 = await saveTextInput(store, {
      content,
      source: "slack",
      author: "민수",
      userId: "u-123",
    });
    expect(r2.cacheHit).toBe(true);
    expect(count(db, "SELECT COUNT(*) AS c FROM node_person_edges")).toBe(
      edgesAfterFirst,
    );
    expect(count(db, "SELECT COUNT(*) AS c FROM node_concept_edges")).toBe(
      conceptEdgesAfterFirst,
    );
  });

  test("다른 글은 별 노드(회귀 0)", async () => {
    await saveTextInput(store, { content: "첫 번째 글", source: "x" });
    const r2 = await saveTextInput(store, { content: "두 번째 다른 글", source: "x" });
    expect(r2.cacheHit).toBe(false);
    expect(count(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(2);
  });
});

describe("saveTextInput 멱등 — 긴 글(청크 갈래)", () => {
  test("같은 긴 글 2회 → origin·청크 모두 흡수(중복 0)", async () => {
    // tokenCap 을 낮춰 청크가 생기게 한다. 여러 문단을 이어 긴 글로 만든다.
    const para = (n: number) =>
      `문단 ${n} 입니다. 이 문단은 검색용 청크로 나뉠 만큼 충분히 길게 작성한 문장을 담고 있습니다. 반복 입력 시 흡수되어야 합니다.`;
    const content = [para(1), para(2), para(3), para(4)].join("\n\n");
    const chunking = { tokenCap: 20, strategy: "paragraph" as const };

    const r1 = await saveTextInput(store, { content, source: "x", chunking });
    expect(r1.chunkNodeIds.length).toBeGreaterThan(0);
    const nodesAfterFirst = count(
      db,
      "SELECT COUNT(*) AS c FROM knowledge_nodes",
    );

    const r2 = await saveTextInput(store, { content, source: "x", chunking });
    expect(r2.cacheHit).toBe(true);
    expect(r2.originNodeId).toBe(r1.originNodeId);
    // origin + 청크 모두 재생성 0 — 노드 수 불변.
    expect(count(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(
      nodesAfterFirst,
    );
    expect(count(db, "SELECT COUNT(*) AS c FROM vec_nodes")).toBe(
      nodesAfterFirst,
    );
  });
});
