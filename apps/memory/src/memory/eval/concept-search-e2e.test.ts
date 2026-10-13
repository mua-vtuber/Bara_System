/**
 * 1.1a E2E — 개념 색인 적재 → 검색어→개념 매칭→자산 글 잡힘 → 1단계 펼침 →
 * harness sweep 한 흐름. 실 SqliteMemoryStore + bge-m3(축소·mock 없음).
 *
 * T2 듀얼 색인 / T3 개념 색인 schema / T4 임베딩 / T5 매칭 채널 / T6 펼침이
 * 이 한 흐름에 자연 포함된다.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";
import { applyHashtagWiring } from "../extractor.ts";
import { runHarness } from "./harness.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

describe("1.1a E2E — 개념 매칭 + 펼침 + harness", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    retriever = new HybridRetriever(store, embedder);
  });
  afterEach(() => db.close());

  test("#태그 입력 → 개념 색인 → 검색 시 개념 채널로 자산 글 잡힘", async () => {
    await applyHashtagWiring(store, "#만화 #주술회전 고죠가 죽었어", { embedder });
    const results = await retriever.retrieve("만화", { limit: 10 });
    const hit = results.find((r) => r.node.content.includes("고죠"));
    expect(hit).toBeDefined();
    // "만화"(2글자) FTS trigram 매치 0건이라도 searchConceptsByVector 가 개념
    // "만화"를 의미로 찾아 연결 자산 글을 끌어온다 → sources 에 'concept' 등장.
    expect(hit!.sources).toContain("concept");
  });

  // ⚠️ plan Step 2 의 E2E #2 단언("#만화 #주술회전" → neighbors 에 만화)은
  // 실제 applyHashtagWiring 동작과 어긋난다. 두 태그를 함께 입력하면 본문 노드가
  // 만화·주술회전 둘 다에 직접 연결되고, getNodeConceptExpansion 은 직접 개념을
  // 이웃에서 제외하므로 만화가 neighbors 에 들어올 수 없다.
  // 그래서 *단일 직접 개념 + 그 개념의 직접 태그 안 된 1단계 이웃* 시나리오로 고친다.
  // (의도 보존: 1단계 펼침 등장 + 2단계 생략 검증. T6 단위 테스트 패턴을 흐름에 맞춤.)
  test("검색 결과 개념 1단계 펼침 (2단계 생략)", async () => {
    // 본문 노드 = 단일 태그 #주술회전(단일이라 위계 엣지 자동 생성 없음).
    const r = await applyHashtagWiring(store, "#주술회전 고죠", { embedder });
    expect(r.bodyNodeId).not.toBeNull();
    // 주술회전 → 만화 → 엔터테인먼트 위계를 명시적으로 구성.
    const jjk = await store.findOrCreateTagConcept("주술회전");
    const manga = await store.findOrCreateTagConcept("만화");
    const ent = await store.findOrCreateTagConcept("엔터테인먼트");
    await store.addConceptEdge({ sourceConceptId: jjk, targetConceptId: manga, relation: "parent_of" ,
    provenance: "user_input",
    sourceNodeId: null,
});
    await store.addConceptEdge({ sourceConceptId: manga, targetConceptId: ent, relation: "parent_of" ,
    provenance: "user_input",
    sourceNodeId: null,
});

    const exp = await store.getNodeConceptExpansion(r.bodyNodeId!);
    const directNames = exp.direct.map((d) => d.concept.name);
    expect(directNames).toContain("주술회전");
    const neighborNames = exp.neighbors.map((n) => n.concept.name);
    expect(neighborNames).toContain("만화"); // 주술회전의 1단계 이웃
    expect(neighborNames).not.toContain("엔터테인먼트"); // 2단계 → 생략
  });

  test("harness sweep — 4 variant snapshot 산출", async () => {
    const snap = await runHarness(embedder);
    expect(snap.variants.length).toBe(4); // vector-only/fts-only/graph-only/full-rrf
    for (const v of snap.variants) {
      expect(Number.isFinite(v.avgNdcg)).toBe(true);
    }
  });
});
