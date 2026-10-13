/**
 * search.kind-display.test.ts — POST /search 응답 kind 한국어 표시 + 추가 조회 0 검증.
 *
 * 2026-06-28 "종류" 분류 키 그래프 허브 버그 수정(spec §4.3 (B)) — 검색 응답의 종류 배지(kind
 * 칸)는 옛 "종류" 분류 꼬리표(store.getNodeKinds 위계 JOIN) 대신 결과 글 본문의 엔티티 종류
 * (typeName)를 직접 분류해 displayKindName 으로 한국어로 바꾼다(search.ts). 그래서 테스트도
 * addClassificationTag 로 꼬리표를 심는 대신 본문에 종류 신호(`#일정:`·`#섭취:` 콜론 태그)를
 * 적어 분류기가 typeName 을 잡게 한다. classifyEntityTypeDeterministic 은 순수 함수라 결과
 * 수만큼 도는 N+1 DB 조회가 0(본문은 이미 결과에 실려 있음).
 *
 * 검증 항목:
 *   1. 본문 종류(schedule)로 분류된 글 → 응답 kind 가 한국어("일정").
 *   2. 종류 신호 없는 글 → 응답 kind null(가짜 0 금지).
 *   3. 추가 조회 0 — 배지 산출이 store.getNodeKinds·getNodeKind 를 호출하지 않는다
 *      (순수 함수 본문 분류로 옮겼으므로 분류 꼬리표 DB 조회가 사라졌다).
 *
 * 실 SqliteMemoryStore(:memory:) + 실 Bgem3Embedder + 실 Hono app. mock 없음.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import { resetConceptTypeVocabularyCache } from "../../memory/concept-type-vocabulary.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

async function search(
  app: Hono,
  body: Record<string, unknown>,
): Promise<{
  count: number;
  results: Array<{ id: number; kind: string | null }>;
}> {
  const res = await app.request("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    count: number;
    results: Array<{ id: number; kind: string | null }>;
  };
}

describe("POST /search — 종류 배지 한국어 표시 + 추가 조회 0", () => {
  let h: Harness;

  beforeEach(() => {
    resetClassifierCache();
    resetConceptTypeVocabularyCache();
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("본문 종류(schedule)로 분류된 글 → 응답 kind 가 한국어(일정)", async () => {
    const id = await h.store.addNode({ content: "#일정:장터당번 설명회 참석" });

    const data = await search(h.app, { query: "장터당번 설명회", limit: 20 });
    const row = data.results.find((r) => r.id === id);
    expect(row).toBeDefined();
    // 분류 typeName 은 영문 schedule 이지만 응답 표시는 한국어 일정(displayKindName).
    expect(row!.kind).toBe("일정");
  });

  test("평문 seed 어휘(코드)는 응답 kind 를 달지 않는다(재현·2026-07-06 P-2)", async () => {
    // 본문 "코드"가 material(자료) 2단 seed 경계 매칭에 걸려도 콜론 태그로 명시하지
    // 않았으면 배지를 달지 않는다(Task 2 저장 게이트와 같은 규칙·화면 표시 측).
    const id = await h.store.addNode({
      content: "#나, 주로 사용하는 AI는 클로드 코드, 코덱스",
    });

    const data = await search(h.app, { query: "클로드 코드 코덱스", limit: 20 });
    const row = data.results.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.kind).toBeNull();
  });

  test("종류 없는 글 → 응답 kind null(가짜 0 금지)", async () => {
    const id = await h.store.addNode({ content: "종류 없는 일반 메모" });

    const data = await search(h.app, { query: "종류 없는 일반", limit: 20 });
    const row = data.results.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.kind).toBeNull();
  });

  test("추가 조회 0 — 배지 산출이 getNodeKinds·getNodeKind 를 호출하지 않는다", async () => {
    // 결과 후보가 여럿 뜨도록 같은 토큰을 담은 글 셋을 심는다.
    await h.store.addNode({ content: "#섭취:우유 마트에서 샀다" });
    await h.store.addNode({ content: "#섭취:빵 마트에서 샀다" });
    await h.store.addNode({ content: "#일정:마트 장보기" });

    const kindsSpy = spyOn(h.store, "getNodeKinds");
    const kindSpy = spyOn(h.store, "getNodeKind");
    try {
      const data = await search(h.app, { query: "마트", limit: 20 });
      // 결과가 여럿 떠야 N+1 검증이 의미를 가진다.
      expect(data.results.length).toBeGreaterThan(1);
      // 배지를 본문 typeName 직접 분류(순수 함수)로 옮겨 분류 꼬리표 DB 조회가 0이다.
      expect(kindsSpy.mock.calls.length).toBe(0);
      expect(kindSpy.mock.calls.length).toBe(0);
    } finally {
      kindsSpy.mockRestore();
      kindSpy.mockRestore();
    }
  });
});
