/**
 * SqliteMemoryStore integration tests.
 *
 * Real bun:sqlite + sqlite-vec + real Bgem3Embedder. No mocks (per
 * docs/CLAUDE.md test policy — past incidents with mock/real drift).
 *
 * Caveats:
 *  - bge-m3 multilingual (dim 1024)는 HF 캐시에서 첫 호출 시 로드.
 *  - Tests share one embedder instance to avoid re-loading the model per
 *    test.
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
import { openMemoryDatabase } from "./migrations.ts";
import {
  MAX_IMPORTANCE,
  MENTION_BOOST,
  SqliteMemoryStore,
  sanitizeFtsQuery,
} from "./store.ts";
import { ENTITY_TYPE_METAS } from "./store-internal/entity-type-registry.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

// Bun's afterAll runs synchronously; the embedder has no explicit close.
// Leaving this stub here in case future versions need teardown.
afterAll(() => {});

describe("sanitizeFtsQuery", () => {
  test("strips FTS5 metacharacters and applies prefix match", () => {
    expect(sanitizeFtsQuery('hello "world" -test')).toBe(
      "hello* OR world* OR test*",
    );
  });

  test("empty / whitespace-only / punctuation-only → empty string", () => {
    expect(sanitizeFtsQuery("")).toBe("");
    expect(sanitizeFtsQuery("   ")).toBe("");
    expect(sanitizeFtsQuery("*+-")).toBe("");
    expect(sanitizeFtsQuery("...?!")).toBe("");
  });

  test("preserves CJK tokens with prefix suffix", () => {
    expect(sanitizeFtsQuery("바라 시스템 메모리")).toBe(
      "바라* OR 시스템* OR 메모리*",
    );
  });

  test("OR-joins multiple tokens", () => {
    expect(sanitizeFtsQuery("alpha beta")).toBe("alpha* OR beta*");
  });

  test("collapses repeated whitespace", () => {
    expect(sanitizeFtsQuery("a    b\tc")).toBe("a* OR b* OR c*");
  });

  test("preserves digits as part of tokens", () => {
    expect(sanitizeFtsQuery("test123 4567")).toBe("test123* OR 4567*");
  });
});

describe("addNode + getNode round-trip", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => { db.close(); });

  test("addNode returns positive id and persists content", async () => {
    const id = await store.addNode({ content: "사용자는 커피를 좋아한다" });
    expect(id).toBeGreaterThan(0);

    const node = await store.getNode(id);
    expect(node).not.toBeNull();
    expect(node!.content).toBe("사용자는 커피를 좋아한다");
    expect(node!.memoryType).toBe("fact");
    expect(node!.sourceType).toBe("auto_capture");
    expect(node!.importance).toBe(0.5);
    expect(node!.confidence).toBe(0.7);
    expect(node!.accessCount).toBe(0);
    expect(node!.mentionCount).toBe(0);
    expect(node!.lastMentionedAt).toBeNull();
  });

  test("metadata round-trips as parsed JSON object", async () => {
    const id = await store.addNode({
      content: "테스트",
      metadata: { source: "telegram", chatId: 42, tags: ["work", "ai"] },
    });
    const node = await store.getNode(id);
    expect(node!.metadata).toEqual({
      source: "telegram",
      chatId: 42,
      tags: ["work", "ai"],
    });
  });

  test("getNode returns null for missing id", async () => {
    const node = await store.getNode(99999);
    expect(node).toBeNull();
  });

  // D1 (프로젝트 노드) — rowToNode 가 row.project_id 를 MemoryNode.projectId 로
  // 끌어 올린다. 그래프 조립이 프로젝트 → 글 연결선을 그릴 입력이고 검색·RRF 와
  // 무관하다. setNodeProjectId 로 채운 글은 그 값, 안 채운 글은 null 이어야 한다.
  test("projectId 매핑 — project_id 채운 글은 그 값, 안 채운 글은 null", async () => {
    const linkedId = await store.addNode({ content: "좀비 로그라이크 진행 메모" });
    await store.setNodeProjectId(linkedId, "prj_zombie");
    const unlinkedId = await store.addNode({ content: "프로젝트 없는 일상 글" });

    const linked = await store.getNode(linkedId);
    const unlinked = await store.getNode(unlinkedId);

    expect(linked!.projectId).toBe("prj_zombie");
    expect(unlinked!.projectId).toBeNull();
  });

  test("projectId 매핑 — getRecent 도 같은 칸을 싣는다", async () => {
    const id = await store.addNode({ content: "최근 목록 프로젝트 글" });
    await store.setNodeProjectId(id, "prj_recent");

    const recent = await store.getRecent(10);
    const found = recent.find((n) => n.id === id);
    expect(found).toBeDefined();
    expect(found!.projectId).toBe("prj_recent");
  });

  test("explicit overrides are stored", async () => {
    const id = await store.addNode({
      content: "선호 정보",
      memoryType: "preference",
      sourceType: "user_explicit",
      importance: 0.9,
      confidence: 0.95,
      platform: "telegram",
      author: "user123",
    });
    const node = await store.getNode(id);
    expect(node!.memoryType).toBe("preference");
    expect(node!.sourceType).toBe("user_explicit");
    expect(node!.importance).toBe(0.9);
    expect(node!.confidence).toBe(0.95);
    expect(node!.platform).toBe("telegram");
    expect(node!.author).toBe("user123");
  });

  test("pre-computed embedding short-circuits the embedder", async () => {
    const precomputed = await embedder.embed("미리 계산된 벡터");
    const id = await store.addNode({
      content: "다른 텍스트이지만 같은 벡터",
      embedding: precomputed,
    });
    const stored = await store.getVectorById(id);
    expect(stored).not.toBeNull();
    expect(stored!.length).toBe(precomputed.length);
    for (let i = 0; i < precomputed.length; i++) {
      expect(stored![i]).toBeCloseTo(precomputed[i] as number, 6);
    }
  });

  test("embedding dim mismatch throws", async () => {
    const bad = new Float32Array(10);
    let thrown: unknown = null;
    try {
      await store.addNode({ content: "x", embedding: bad });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/dim mismatch/);
  });
});

describe("getNodesByIds", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => { db.close(); });

  test("returns empty array for empty input", async () => {
    expect(await store.getNodesByIds([])).toEqual([]);
  });

  test("fetches multiple nodes in one query", async () => {
    const id1 = await store.addNode({ content: "첫째" });
    const id2 = await store.addNode({ content: "둘째" });
    const id3 = await store.addNode({ content: "셋째" });

    const nodes = await store.getNodesByIds([id1, id3]);
    expect(nodes.length).toBe(2);
    const contents = new Set(nodes.map((n) => n.content));
    expect(contents.has("첫째")).toBe(true);
    expect(contents.has("셋째")).toBe(true);
    expect(nodes.some((n) => n.id === id2)).toBe(false);
  });

  test("silently skips missing ids", async () => {
    const id = await store.addNode({ content: "존재함" });
    const nodes = await store.getNodesByIds([id, 99999]);
    expect(nodes.length).toBe(1);
    expect(nodes[0]!.id).toBe(id);
  });
});

describe("vec_nodes integration", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => { db.close(); });

  test("addNode populates vec_nodes (vector retrievable)", async () => {
    const id = await store.addNode({ content: "벡터가 저장되어야 한다" });
    const vec = await store.getVectorById(id);
    expect(vec).not.toBeNull();
    expect(vec!.length).toBe(embedder.dimension);
  });

  test("getVectorById returns null for missing node", async () => {
    expect(await store.getVectorById(99999)).toBeNull();
  });

  test("getVectorsByIds bulk fetch", async () => {
    const id1 = await store.addNode({ content: "A" });
    const id2 = await store.addNode({ content: "B" });
    const vectors = await store.getVectorsByIds([id1, id2, 99999]);
    expect(vectors.size).toBe(2);
    expect(vectors.has(id1)).toBe(true);
    expect(vectors.has(id2)).toBe(true);
    expect(vectors.has(99999)).toBe(false);
  });

  test("deleteNode cascades to vec_nodes", async () => {
    const id = await store.addNode({ content: "삭제됨" });
    expect(await store.getVectorById(id)).not.toBeNull();
    await store.deleteNode(id);
    expect(await store.getVectorById(id)).toBeNull();
    expect(await store.getNode(id)).toBeNull();
  });
});

describe("searchByVector — semantic retrieval", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let idCoffee: number;
  let idTea: number;
  let idCar: number;

  beforeEach(async () => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    idCoffee = await store.addNode({ content: "사용자는 커피를 좋아한다" });
    idTea = await store.addNode({ content: "녹차도 즐겨 마신다" });
    idCar = await store.addNode({ content: "어제 자동차를 새로 샀다" });
  });
  afterEach(() => { db.close(); });

  test("returns nearest neighbor first", async () => {
    const hits = await store.searchByVector("좋아하는 음료", 3);
    expect(hits.length).toBe(3);
    // 커피/녹차 둘 중 하나가 1위, 자동차는 마지막
    const last = hits[hits.length - 1]!;
    expect(last.nodeId).toBe(idCar);
    const topId = hits[0]!.nodeId;
    expect([idCoffee, idTea]).toContain(topId);
  });

  test("distances are monotonically non-decreasing", async () => {
    const hits = await store.searchByVector("음료수 선호", 3);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.distance).toBeGreaterThanOrEqual(hits[i - 1]!.distance);
    }
  });

  test("k <= 0 returns empty", async () => {
    expect(await store.searchByVector("x", 0)).toEqual([]);
  });

  test("searchByVectorRaw with pre-embedded query", async () => {
    const queryVec = await embedder.embed("커피 마시기");
    const hits = await store.searchByVectorRaw(queryVec, 1);
    expect(hits.length).toBe(1);
    expect(hits[0]!.nodeId).toBe(idCoffee);
  });
});

describe("searchByFts — lexical retrieval", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(async () => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    await store.addNode({ content: "사용자는 커피를 좋아한다" });
    await store.addNode({ content: "녹차도 즐겨 마신다" });
    await store.addNode({ content: "자동차를 새로 샀다" });
  });
  afterEach(() => { db.close(); });

  test("finds Korean token match", async () => {
    const hits = await store.searchByFts("커피", 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  test("OR semantics: any token matches", async () => {
    const hits = await store.searchByFts("커피 자동차", 10);
    expect(hits.length).toBe(2); // 커피 row + 자동차 row
  });

  test("survives FTS5 metacharacters in input", async () => {
    // No throw, even with quotes / wildcards
    const hits = await store.searchByFts('"커피*" + 자동차', 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  test("empty / metachar-only query returns empty", async () => {
    expect(await store.searchByFts("", 10)).toEqual([]);
    expect(await store.searchByFts("*+-", 10)).toEqual([]);
  });

  test("limit <= 0 returns empty", async () => {
    expect(await store.searchByFts("커피", 0)).toEqual([]);
  });

  test("ftsSearch contract method returns tuples", async () => {
    const tuples = await store.ftsSearch("커피", 10);
    expect(tuples.length).toBeGreaterThanOrEqual(1);
    expect(tuples[0]!.length).toBe(2);
    expect(typeof tuples[0]![0]).toBe("number");
    expect(typeof tuples[0]![1]).toBe("number");
  });
});

describe("touch / bumpMention bookkeeping", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let id: number;

  beforeEach(async () => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    id = await store.addNode({ content: "추적 대상" });
  });
  afterEach(() => { db.close(); });

  test("touchNodesBatch handles empty input", async () => {
    await store.touchNodesBatch([]);
    const node = await store.getNode(id);
    expect(node!.accessCount).toBe(0);
  });

  test("touchNodesBatch increments all listed ids", async () => {
    const id2 = await store.addNode({ content: "두번째" });
    await store.touchNodesBatch([id, id2]);
    expect((await store.getNode(id))!.accessCount).toBe(1);
    expect((await store.getNode(id2))!.accessCount).toBe(1);
  });

  test("bumpMention increases mention_count and importance by MENTION_BOOST", async () => {
    const before = await store.getNode(id);
    await store.bumpMention(id);
    const after = await store.getNode(id);
    expect(after!.mentionCount).toBe(before!.mentionCount + 1);
    expect(after!.importance).toBeCloseTo(before!.importance + MENTION_BOOST, 5);
    expect(after!.lastMentionedAt).not.toBeNull();
  });

  test("bumpMention caps importance at MAX_IMPORTANCE", async () => {
    await store.updateNodeImportance(id, MAX_IMPORTANCE - 0.001);
    await store.bumpMention(id);
    const node = await store.getNode(id);
    expect(node!.importance).toBe(MAX_IMPORTANCE);
  });

  test("updateNodeImportance writes the new value verbatim", async () => {
    await store.updateNodeImportance(id, 0.42);
    const node = await store.getNode(id);
    expect(node!.importance).toBe(0.42);
  });
});

describe("edges + graph traversal", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => { db.close(); });

  test("addEdge persists, getNeighbors returns it", async () => {
    const a = await store.addNode({ content: "A" });
    const b = await store.addNode({ content: "B" });
    await store.addEdge({ sourceId: a, targetId: b, relation: "related_to", weight: 0.8 ,
    provenance: "user_input",
    sourceNodeId: null,
});

    const edges = await store.getNeighbors(a);
    expect(edges.length).toBe(1);
    expect(edges[0]!.sourceId).toBe(a);
    expect(edges[0]!.targetId).toBe(b);
    expect(edges[0]!.relation).toBe("related_to");
    expect(edges[0]!.weight).toBe(0.8);
  });

  test("addEdge with duplicate (source, target, relation) is silently ignored", async () => {
    const a = await store.addNode({ content: "A" });
    const b = await store.addNode({ content: "B" });
    await store.addEdge({ sourceId: a, targetId: b, relation: "related_to", weight: 0.5 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    await store.addEdge({ sourceId: a, targetId: b, relation: "related_to", weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    const edges = await store.getNeighbors(a);
    expect(edges.length).toBe(1);
    expect(edges[0]!.weight).toBe(0.5);
  });

  test("getConnectedNodes — BFS within maxHops", async () => {
    const a = await store.addNode({ content: "A" });
    const b = await store.addNode({ content: "B" });
    const c = await store.addNode({ content: "C" });
    const d = await store.addNode({ content: "D" });

    // A -> B -> C -> D
    await store.addEdge({ sourceId: a, targetId: b, relation: "related_to", weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    await store.addEdge({ sourceId: b, targetId: c, relation: "related_to", weight: 0.6 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    await store.addEdge({ sourceId: c, targetId: d, relation: "related_to", weight: 0.4 ,
    provenance: "user_input",
    sourceNodeId: null,
});

    const hops1 = await store.getConnectedNodes([a], { maxHops: 1 });
    expect(hops1.map((p) => p[0])).toEqual([b]);

    const hops2 = await store.getConnectedNodes([a], { maxHops: 2 });
    expect(hops2.map((p) => p[0]).sort()).toEqual([b, c].sort());

    const hops3 = await store.getConnectedNodes([a], { maxHops: 3 });
    expect(hops3.map((p) => p[0]).sort()).toEqual([b, c, d].sort());
  });

  test("getConnectedNodes — accumulates max edge weight per path", async () => {
    const a = await store.addNode({ content: "A" });
    const b = await store.addNode({ content: "B" });
    const c = await store.addNode({ content: "C" });

    await store.addEdge({ sourceId: a, targetId: b, relation: "related_to", weight: 0.3 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    await store.addEdge({ sourceId: a, targetId: c, relation: "related_to", weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    await store.addEdge({ sourceId: b, targetId: c, relation: "related_to", weight: 0.7 ,
    provenance: "user_input",
    sourceNodeId: null,
});

    const results = await store.getConnectedNodes([a], { maxHops: 1 });
    // Two direct neighbors at hop=1; both should show, sorted by weight
    expect(results[0]).toEqual([c, 0.9]);
    expect(results[1]).toEqual([b, 0.3]);
  });

  test("getConnectedNodes — empty seeds returns empty", async () => {
    expect(await store.getConnectedNodes([])).toEqual([]);
  });

  test("getSupersededNodeIds returns superseded targets only", async () => {
    const a = await store.addNode({ content: "A" });
    const b = await store.addNode({ content: "B" });
    const c = await store.addNode({ content: "C" });

    await store.addEdge({ sourceId: a, targetId: b, relation: "supersedes", weight: 0.7 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    await store.addEdge({ sourceId: a, targetId: c, relation: "related_to", weight: 0.5 ,
    provenance: "user_input",
    sourceNodeId: null,
});

    const superseded = await store.getSupersededNodeIds([b, c]);
    expect(superseded.has(b)).toBe(true);
    expect(superseded.has(c)).toBe(false);
  });

  test("getSupersedingNodeIds returns superseding sources only", async () => {
    // sibling 의 대칭 — source 측(새 노드 = 덮는 쪽) 판별. supersedes source 만
    // 반환하고 다른 relation source 는 배제하는지 `AND relation = 'supersedes'`
    // 절을 회귀 방어한다.
    const a = await store.addNode({ content: "A" });
    const b = await store.addNode({ content: "B" });
    const c = await store.addNode({ content: "C" });

    // a 가 b 를 supersede(a = 새/덮는 source). c 는 related_to source(배제 대상).
    await store.addEdge({ sourceId: a, targetId: b, relation: "supersedes", weight: 0.7 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    await store.addEdge({ sourceId: c, targetId: b, relation: "related_to", weight: 0.5 ,
    provenance: "user_input",
    sourceNodeId: null,
});

    const superseding = await store.getSupersedingNodeIds([a, c]);
    expect(superseding.has(a)).toBe(true); // supersedes source 포함
    expect(superseding.has(c)).toBe(false); // related_to source 배제
  });

  test("getSupersedingNodeIds — 빈 입력은 빈 Set", async () => {
    const superseding = await store.getSupersedingNodeIds([]);
    expect(superseding.size).toBe(0);
  });
});

describe("misc", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => { db.close(); });

  test("countNodesSince filters by created_at", async () => {
    await store.addNode({ content: "오래된" });
    // Store now writes KST naive timestamps ("YYYY-MM-DD HH:MM:SS"), so the
    // comparison value must match that format/timezone.
    const future = new Date(Date.now() + 60_000).toLocaleString("sv-SE", {
      timeZone: "Asia/Seoul",
      hour12: false,
    });
    expect(await store.countNodesSince(future)).toBe(0);

    // Past "since" → all included
    const past = "1970-01-01 00:00:00";
    expect(await store.countNodesSince(past)).toBe(1);
  });

  test("getBackfillCandidates: auto_capture + document_chunk 만 후보, 다른 종류는 제외", async () => {
    // 입력 통로 통합 Task 5 — raw(짧은 글)와 청크(긴 글) 둘 다 추출 후보.
    const raw = await store.addNode({
      content: "Phase 1 원문 메모리",
      sourceType: "auto_capture",
    });
    const chunk = await store.addNode({
      content: "긴 글의 검색용 청크",
      sourceType: "document_chunk",
    });
    // 자식·명시 입력 종류는 후보 아님.
    await store.addNode({
      content: "LLM이 추출한 메모리",
      sourceType: "llm_extract",
    });
    await store.addNode({
      content: "유저가 명시 입력",
      sourceType: "user_explicit",
    });

    const candidates = await store.getBackfillCandidates({ limit: 10 });
    expect(candidates.map((c) => c.id).sort()).toEqual([raw, chunk].sort());
  });

  test("getBackfillCandidates: 청크가 추출 후보로 합류한다 (Task 5)", async () => {
    const chunk = await store.addNode({
      content: "문서 청크 본문 — 아직 추출 안 됨",
      sourceType: "document_chunk",
      metadata: { parentNodeId: 999, chunkIndex: 0 },
    });
    const candidates = await store.getBackfillCandidates({ limit: 10 });
    expect(candidates.map((c) => c.id)).toContain(chunk);
  });

  test("getBackfillCandidates: OCR 미완료 문서 청크는 자동 추출 후보에서 제외", async () => {
    const sha = "a".repeat(64);
    db.prepare(
      `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at)
       VALUES (?, 'document', ?, 10, 0)`,
    ).run(sha, `/assets/${sha}.pdf`);
    const docId = store.createDocument({
      assetSha256: sha,
      title: "scan.pdf",
      documentType: "pdf",
      sourceMetadata: {
        parse: {
          status: "needs_ocr",
          method: "tier1",
          originalAssetSha256: sha,
          warnings: [],
        },
      },
    });
    const chunk = await store.addNode({
      content: "OCR 전 문서 청크 — 추출되면 안 됨",
      sourceType: "document_chunk",
      metadata: { parentId: docId, chunkIndex: 0 },
    });

    const candidates = await store.getBackfillCandidates({ limit: 10 });
    expect(candidates.map((c) => c.id)).not.toContain(chunk);
  });

  test("getBackfillCandidates: 청크를 가진 긴 글의 원본은 후보에서 제외 (D5 — 청크가 단위)", async () => {
    // 긴 글 = 원본(auto_capture) + 청크 자식(parent_of: 청크→원본).
    const origin = await store.addNode({
      content: "긴 글 원문 전체 — 청크로 나뉨",
      sourceType: "auto_capture",
    });
    const chunk = await store.addNode({
      content: "이 글의 청크 1",
      sourceType: "document_chunk",
      metadata: { parentNodeId: origin, chunkIndex: 0 },
    });
    await store.addEdge({
      sourceId: chunk,
      targetId: origin,
      relation: "parent_of",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 1.0,
    });

    const candidates = await store.getBackfillCandidates({ limit: 10 });
    // 원본은 제외(Ollama 한계 — 통째 추출 안 함), 청크만 후보.
    expect(candidates.map((c) => c.id)).toEqual([chunk]);
    expect(candidates.map((c) => c.id)).not.toContain(origin);
  });

  test("getBackfillCandidates: markNodeExtracted 후 같은 노드가 다시 안 줍힘 (metadata 플래그)", async () => {
    const chunk = await store.addNode({
      content: "청크 — 추출 완료 표시 예정",
      sourceType: "document_chunk",
      metadata: { parentNodeId: 1, chunkIndex: 0 },
    });
    const raw = await store.addNode({
      content: "raw — 추출 완료 표시 예정",
      sourceType: "auto_capture",
    });
    // 처음엔 둘 다 후보.
    expect(
      (await store.getBackfillCandidates({ limit: 10 }))
        .map((c) => c.id)
        .sort(),
    ).toEqual([chunk, raw].sort());

    // 추출 완료 마킹 — atomic id 배열은 비어 있어도 "처리 시도 완료" 표시로 제외.
    await store.markNodeExtracted(chunk, [42, 43]);
    await store.markNodeExtracted(raw, []);

    // 마킹 후 둘 다 후보에서 빠짐.
    expect(await store.getBackfillCandidates({ limit: 10 })).toHaveLength(0);
  });

  test("markNodeExtracted: 기존 metadata 보존 + extracted/extractedTo 만 덧붙임", async () => {
    const node = await store.addNode({
      content: "청크 — 기존 metadata 있음",
      sourceType: "document_chunk",
      metadata: { parentNodeId: 7, chunkIndex: 2 },
    });
    await store.markNodeExtracted(node, [101, 102]);
    const after = await store.getNode(node);
    const meta = after?.metadata as Record<string, unknown>;
    // 기존 칸 유실 0.
    expect(meta.parentNodeId).toBe(7);
    expect(meta.chunkIndex).toBe(2);
    // 완료 플래그 추가 — extracted 는 정수 1 로 저장(->> 정수 비교 정합 / Task 5 리뷰 fix).
    expect(meta.extracted).toBe(1);
    expect(meta.extractedTo).toEqual([101, 102]);
  });

  test("getBackfillCandidates: extracted=1 단독으로 제외된다 (extractedTo 없이 — 417 조건 단독 작동)", async () => {
    // 리뷰 fix 검증 — extracted 플래그만으로 제외되는지 보조 조건(extractedTo IS NULL)에
    // 기대지 않고 단정한다. extractedTo 칸이 *아예 없는* 상태(extracted=1 만)에서도
    // 417 의 `metadata_json->>'$.extracted' != 1` 가 제외시켜야 한다. 옛 json('true')
    // 저장이면 ->> 가 TEXT 'true' 라 != 1 이 항상 참 → 제외 실패(계약 깨짐)를 잡는다.
    const markedNoExtractedTo = await store.addNode({
      content: "extracted=1 만 있고 extractedTo 칸 없음",
      sourceType: "document_chunk",
      metadata: { parentNodeId: 1, chunkIndex: 0, extracted: 1 },
    });
    const fresh = await store.addNode({
      content: "미추출 청크",
      sourceType: "document_chunk",
      metadata: { parentNodeId: 1, chunkIndex: 1 },
    });
    const candidates = await store.getBackfillCandidates({ limit: 10 });
    expect(candidates.map((c) => c.id)).toEqual([fresh]);
    expect(candidates.map((c) => c.id)).not.toContain(markedNoExtractedTo);
  });

  test("getBackfillCandidates: markNodeExtracted(node, []) — 0건 추출 마킹도 extracted=1 단독으로 제외", async () => {
    // markNodeExtracted 가 실제로 쓰는 형식(extracted=1 + extractedTo=[])이 제외되는지.
    // extractedTo=[] 는 IS NULL 이 아니므로 보조 조건은 통과 — extracted=1 단독이 막아야 한다.
    const node = await store.addNode({
      content: "0건 추출 마킹 노드",
      sourceType: "auto_capture",
    });
    expect(
      (await store.getBackfillCandidates({ limit: 10 })).map((c) => c.id),
    ).toContain(node);
    await store.markNodeExtracted(node, []);
    // extractedTo=[] 라 extractedTo IS NULL 조건은 false(통과 안 함) → extracted=1 이
    // 제외를 책임진다. 둘 중 하나라도 작동하면 제외되지만, 여기선 extracted 가 핵심.
    expect(
      (await store.getBackfillCandidates({ limit: 10 })).map((c) => c.id),
    ).not.toContain(node);
  });

  test("getBackfillCandidates: metadata.extractedTo 있는 노드도 제외", async () => {
    const marked = await store.addNode({
      content: "extractedTo 만 있는 raw",
      sourceType: "auto_capture",
      metadata: { extractedTo: [5, 6] },
    });
    const fresh = await store.addNode({
      content: "미추출 raw",
      sourceType: "auto_capture",
    });
    const candidates = await store.getBackfillCandidates({ limit: 10 });
    expect(candidates.map((c) => c.id)).toEqual([fresh]);
    expect(candidates.map((c) => c.id)).not.toContain(marked);
  });

  test("getBackfillCandidates: limit 적용", async () => {
    for (let i = 0; i < 5; i++) {
      await store.addNode({
        content: `노드 ${i}`,
        sourceType: "auto_capture",
      });
    }
    expect(await store.getBackfillCandidates({ limit: 3 })).toHaveLength(3);
  });

  test("getBackfillCandidates: minImportance 적용", async () => {
    await store.addNode({
      content: "낮은 중요도",
      sourceType: "auto_capture",
      importance: 0.1,
    });
    await store.addNode({
      content: "높은 중요도",
      sourceType: "auto_capture",
      importance: 0.8,
    });

    const filtered = await store.getBackfillCandidates({
      limit: 10,
      minImportance: 0.5,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.content).toBe("높은 중요도");
  });

  test("getBackfillCandidates: limit=0 → 빈 배열", async () => {
    await store.addNode({ content: "x", sourceType: "auto_capture" });
    expect(await store.getBackfillCandidates({ limit: 0 })).toEqual([]);
  });

  test("Phase 5.6 W5 — merged_into edge 가 가리키는 raw 는 후보에서 제외", async () => {
    // 옛 raw 1: atomic 자식이 연결됨 (merged_into edge target).
    const rawWithChild = await store.addNode({
      content: "raw 본문 1 — 이미 분해됨",
      sourceType: "auto_capture",
    });
    const atomic = await store.addNode({
      content: "atomic 자식",
      sourceType: "llm_extract",
    });
    await store.addEdge({
      sourceId: atomic,
      targetId: rawWithChild,
      relation: "merged_into",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 1.0,
    });

    // 옛 raw 2: 아직 분해 안 됨.
    const rawWithoutChild = await store.addNode({
      content: "raw 본문 2 — 미분해",
      sourceType: "auto_capture",
    });

    const candidates = await store.getBackfillCandidates({ limit: 10 });
    // merged_into 있는 raw 는 제외, 없는 raw 만 후보.
    expect(candidates.map((c) => c.id)).toEqual([rawWithoutChild]);
  });

  test("Phase 5.6 W5 — merged_into 없는 raw 는 옛 흐름 그대로 후보 포함", async () => {
    const id1 = await store.addNode({
      content: "raw 본문 A",
      sourceType: "auto_capture",
    });
    const id2 = await store.addNode({
      content: "raw 본문 B",
      sourceType: "auto_capture",
    });
    const candidates = await store.getBackfillCandidates({ limit: 10 });
    expect(candidates.map((c) => c.id).sort()).toEqual([id1, id2].sort());
  });
});

describe("getRecent — 자식 노드 숨김 (입력 통로 통합 Task 4 / spec §5 / D8)", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => { db.close(); });

  test("자식 종류(document_chunk·llm_extract·image_caption)는 최근 목록에서 제외, 원본만 노출", async () => {
    // 원본 네 종류 — 전부 노출돼야 한다.
    const origin = await store.addNode({
      content: "타이핑한 짧은 글",
      sourceType: "auto_capture",
    });
    const doc = await store.addNode({
      content: "올린 문서 제목",
      sourceType: "document",
    });
    const img = await store.addNode({
      content: "이미지 자산 라벨",
      sourceType: "image_asset",
      metadata: { asset_sha256: "a".repeat(64) },
    });
    const explicit = await store.addNode({
      content: "유저가 명시 입력",
      sourceType: "user_explicit",
    });

    // 자식 세 종류 — 전부 숨겨져야 한다.
    await store.addNode({
      content: "검색용 청크 내용",
      sourceType: "document_chunk",
      metadata: { parentId: String(doc), chunkIndex: 0 },
    });
    await store.addNode({
      content: "LLM 이 추출한 atomic 사실",
      sourceType: "llm_extract",
    });
    await store.addNode({
      content: "VLM 자동 캡션 글",
      sourceType: "image_caption",
      metadata: { parentId: img, captionRole: "auto" },
    });

    const recent = await store.getRecent(50);
    const ids = recent.map((n) => n.id).sort((a, b) => a - b);
    // 원본 네 종류만 — 자식 셋은 빠진다.
    expect(ids).toEqual([origin, doc, img, explicit].sort((a, b) => a - b));
    for (const n of recent) {
      expect(
        ["document_chunk", "llm_extract", "image_caption"].includes(
          n.sourceType,
        ),
      ).toBe(false);
    }
  });

  test("짧은 글 1건 입력 후 최근 목록에 원본 1건만 (자식 0)", async () => {
    await store.addNode({
      content: "짧은 한 줄 글",
      sourceType: "auto_capture",
    });
    const recent = await store.getRecent(50);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.content).toBe("짧은 한 줄 글");
  });

  test("문서 1건 + 청크 다수 입력 후 최근 목록에 원본 문서 1건만", async () => {
    const doc = await store.addNode({
      content: "긴 문서 제목",
      sourceType: "document",
    });
    for (let i = 0; i < 5; i++) {
      await store.addNode({
        content: `문서 청크 ${i}`,
        sourceType: "document_chunk",
        metadata: { parentId: String(doc), chunkIndex: i },
      });
    }
    const recent = await store.getRecent(50);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe(doc);
  });

  test("limit <= 0 → 빈 배열 (필터와 무관하게 옛 동작 보존)", async () => {
    await store.addNode({ content: "글", sourceType: "auto_capture" });
    expect(await store.getRecent(0)).toEqual([]);
    expect(await store.getRecent(-1)).toEqual([]);
  });
});

describe("getRawParentOfExtract — llm_extract 자식 → 부모 원본 역추적 (Task 4)", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => { db.close(); });

  test("merged_into 엣지로 부모 원본 id 를 돌려준다", async () => {
    const raw = await store.addNode({
      content: "원본 글 — 추출 대상",
      sourceType: "auto_capture",
    });
    const atomic = await store.addNode({
      content: "추출된 atomic 사실",
      sourceType: "llm_extract",
    });
    await store.addEdge({
      sourceId: atomic,
      targetId: raw,
      relation: "merged_into",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 1.0,
    });
    expect(store.getRawParentOfExtract(atomic)).toBe(raw);
  });

  test("merged_into 엣지 없는 고아 자식 → null (가짜 부모 안 만듦)", async () => {
    const orphan = await store.addNode({
      content: "엣지 없는 추출 노드",
      sourceType: "llm_extract",
    });
    expect(store.getRawParentOfExtract(orphan)).toBeNull();
  });

  test("부모가 표시 불가 자식 종류면 null (원본 종류만 인정)", async () => {
    // merged_into 가 (데이터 이상으로) 또 다른 자식 종류를 가리키는 경우.
    const chunkParent = await store.addNode({
      content: "청크 노드 — 원본 아님",
      sourceType: "document_chunk",
      metadata: { parentId: "1", chunkIndex: 0 },
    });
    const atomic = await store.addNode({
      content: "추출 노드",
      sourceType: "llm_extract",
    });
    await store.addEdge({
      sourceId: atomic,
      targetId: chunkParent,
      relation: "merged_into",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 1.0,
    });
    expect(store.getRawParentOfExtract(atomic)).toBeNull();
  });

  test("부모가 document 원본이면 그 id 를 돌려준다", async () => {
    const doc = await store.addNode({
      content: "문서 원본",
      sourceType: "document",
    });
    const atomic = await store.addNode({
      content: "문서 청크에서 추출된 사실",
      sourceType: "llm_extract",
    });
    await store.addEdge({
      sourceId: atomic,
      targetId: doc,
      relation: "merged_into",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 1.0,
    });
    expect(store.getRawParentOfExtract(atomic)).toBe(doc);
  });
});

describe("getUncaptionedImageCandidates — Phase 11e G2-3 (T7)", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => { db.close(); });

  /**
   * image_asset 노드 + images row 한 쌍을 직접 만든다 (ingestImage 의 두 row 양식
   * 재현). re-embed-images.test.ts seedImageAsset 선례 정합 — 단일 권위는
   * image-asset.ts / ingest-image.ts 이고 본 fixture 는 그 양식을 따라간다.
   * createdAt 은 images.created_at 칸을 명시 지정해 정렬(ASC) 검증을 결정적으로.
   */
  async function seedImage(args: {
    sha256: string;
    mime: string;
    hasCaptionAuto: 0 | 1;
    createdAt: string;
  }): Promise<number> {
    db.prepare(
      `INSERT OR IGNORE INTO asset_files
         (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
       VALUES (?, 'image', ?, 64, ?, NULL, ?)`,
    ).run(args.sha256, `fixture://${args.sha256}`, args.mime, Date.now());
    db.prepare(
      `INSERT INTO images
         (asset_sha256, thumb_sha256, width, height, mime, preserve_mode,
          is_animated, warnings_json, has_caption_auto, created_at)
       VALUES (?, ?, 1, 1, ?, 'smart', 0, '[]', ?, ?)`,
    ).run(
      args.sha256,
      args.sha256,
      args.mime,
      args.hasCaptionAuto,
      args.createdAt,
    );
    return store.addNode({
      content: `이미지 자산 ${args.sha256.slice(0, 12)}`,
      sourceType: "image_asset",
      metadata: { asset_sha256: args.sha256 },
    });
  }

  test("has_caption_auto=0 만 반환 (캡션 있는 이미지 제외)", async () => {
    const a = await seedImage({
      sha256: "a".repeat(64),
      mime: "image/png",
      hasCaptionAuto: 0,
      createdAt: "2026-05-30 10:00:00",
    });
    await seedImage({
      sha256: "b".repeat(64),
      mime: "image/jpeg",
      hasCaptionAuto: 1, // 이미 캡션 있음 — 후보 제외
      createdAt: "2026-05-30 11:00:00",
    });

    const candidates = store.getUncaptionedImageCandidates({ limit: 10 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.nodeId).toBe(a);
    expect(candidates[0]!.assetSha256).toBe("a".repeat(64));
    expect(candidates[0]!.mime).toBe("image/png");
  });

  test("created_at ASC — 먼저 들어온 미캡션부터", async () => {
    const newer = await seedImage({
      sha256: "c".repeat(64),
      mime: "image/png",
      hasCaptionAuto: 0,
      createdAt: "2026-05-30 12:00:00",
    });
    const older = await seedImage({
      sha256: "d".repeat(64),
      mime: "image/png",
      hasCaptionAuto: 0,
      createdAt: "2026-05-30 09:00:00",
    });
    const mid = await seedImage({
      sha256: "e".repeat(64),
      mime: "image/png",
      hasCaptionAuto: 0,
      createdAt: "2026-05-30 10:30:00",
    });

    const candidates = store.getUncaptionedImageCandidates({ limit: 10 });
    expect(candidates.map((c) => c.nodeId)).toEqual([older, mid, newer]);
  });

  test("LIMIT batchSize 적용 — 오래된 것부터 batchSize 만큼", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedImage({
          sha256: String(i).repeat(64),
          mime: "image/png",
          hasCaptionAuto: 0,
          // 시각 ASC = i ASC (먼저 들어온 순)
          createdAt: `2026-05-30 1${i}:00:00`,
        }),
      );
    }
    const candidates = store.getUncaptionedImageCandidates({ limit: 2 });
    expect(candidates).toHaveLength(2);
    // 오래된 두 개 (i=0, i=1).
    expect(candidates.map((c) => c.nodeId)).toEqual([ids[0]!, ids[1]!]);
  });

  test("limit=0 → 빈 배열", async () => {
    await seedImage({
      sha256: "f".repeat(64),
      mime: "image/png",
      hasCaptionAuto: 0,
      createdAt: "2026-05-30 10:00:00",
    });
    expect(store.getUncaptionedImageCandidates({ limit: 0 })).toEqual([]);
  });

  test("addImageCaption 호출 후 has_caption_auto=1 전이 → 후보에서 빠짐", async () => {
    const sha = "9".repeat(64);
    const nodeId = await seedImage({
      sha256: sha,
      mime: "image/png",
      hasCaptionAuto: 0,
      createdAt: "2026-05-30 10:00:00",
    });
    // 처음엔 후보.
    expect(store.getUncaptionedImageCandidates({ limit: 10 })).toHaveLength(1);

    // 캡션 추가 → has_caption_auto=1 갱신 (store.addImageCaption 책임).
    await store.addImageCaption({
      parentNodeId: nodeId,
      assetSha256: sha,
      caption: "노란 후드 캐릭터",
      captionRole: "auto",
    });

    // 후보에서 자연 제외 (0→1 전이).
    expect(store.getUncaptionedImageCandidates({ limit: 10 })).toHaveLength(0);
  });

  test("image_asset 아닌 노드 + images row 없는 노드는 후보 아님", async () => {
    // 일반 글 노드 — join 대상 아님.
    await store.addNode({ content: "그냥 글", sourceType: "auto_capture" });
    // image_asset 노드인데 images row 가 없는 손상 — INNER JOIN 으로 자연 탈락.
    await store.addNode({
      content: "이미지인데 images row 없음",
      sourceType: "image_asset",
      metadata: { asset_sha256: "z".repeat(64) },
    });
    expect(store.getUncaptionedImageCandidates({ limit: 10 })).toEqual([]);
  });
});

describe("images_node_delete 트리거 — 고아 images 행 정리 (image-search-foundation Task 2)", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => { db.close(); });

  /**
   * image_asset 노드 + images row 한 쌍을 직접 만든다 (ingestImage 의 두 row 양식
   * 재현). getUncaptionedImageCandidates 테스트 seedImage 선례 정합 — 단일 권위는
   * image-asset.ts / ingest-image.ts. 같은 sha256 을 다른 노드가 공유하는 경우를
   * 검증하려고 images 행은 INSERT OR IGNORE 로 한 번만 만든다(asset_sha256 PK).
   */
  async function seedImageNode(args: {
    sha256: string;
    content: string;
  }): Promise<number> {
    db.prepare(
      `INSERT OR IGNORE INTO asset_files
         (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
       VALUES (?, 'image', ?, 64, 'image/png', NULL, ?)`,
    ).run(args.sha256, `fixture://${args.sha256}`, Date.now());
    db.prepare(
      `INSERT OR IGNORE INTO images
         (asset_sha256, thumb_sha256, width, height, mime, preserve_mode,
          is_animated, warnings_json, has_caption_auto, created_at)
       VALUES (?, ?, 1, 1, 'image/png', 'smart', 0, '[]', 0, datetime('now'))`,
    ).run(args.sha256, args.sha256);
    return store.addNode({
      content: args.content,
      sourceType: "image_asset",
      metadata: { asset_sha256: args.sha256 },
    });
  }

  function imagesCount(sha256: string): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM images WHERE asset_sha256=?").get(sha256) as { c: number }).c;
  }

  test("image_asset 노드 단독 삭제 시 images 행 삭제 (고아 0)", async () => {
    const sha = "a".repeat(64);
    const nodeId = await seedImageNode({ sha256: sha, content: "이미지 단독" });
    expect(imagesCount(sha)).toBe(1);

    await store.deleteNode(nodeId);
    expect(imagesCount(sha)).toBe(0);
  });

  test("공유 자산 — 노드 2개가 같은 asset, 하나 삭제 시 images 행 보존", async () => {
    const sha = "b".repeat(64);
    const node1 = await seedImageNode({ sha256: sha, content: "공유 이미지 1차 입력" });
    const node2 = await seedImageNode({ sha256: sha, content: "공유 이미지 2차 입력" });
    // images 행은 asset_sha256 PK 라 하나만 존재(두 번째 INSERT OR IGNORE 무시).
    expect(imagesCount(sha)).toBe(1);

    // 첫 노드만 삭제 — 두 번째 노드가 같은 asset 을 아직 쓰므로 images 행 보존.
    await store.deleteNode(node1);
    expect(imagesCount(sha)).toBe(1);

    // 마지막 노드까지 삭제하면 images 행도 정리(고아 0).
    await store.deleteNode(node2);
    expect(imagesCount(sha)).toBe(0);
  });

  test("비-image_asset 노드 삭제는 images 행에 무영향", async () => {
    const sha = "c".repeat(64);
    await seedImageNode({ sha256: sha, content: "이미지" });
    // 같은 asset_sha256 을 metadata 에 가진 일반 글 노드(source_type != 'image_asset').
    // WHEN 가드로 트리거가 안 돌아야 하고, 설령 돌아도 NOT EXISTS 가 image_asset 노드를
    // 본다 — 두 방어선 모두 images 행을 보존해야 한다.
    const plainId = await store.addNode({
      content: "이미지 아님 — 같은 sha 가 metadata 에",
      sourceType: "auto_capture",
      metadata: { asset_sha256: sha },
    });

    await store.deleteNode(plainId);
    expect(imagesCount(sha)).toBe(1);
  });

  test("metadata.asset_sha256 없는 image_asset 노드 삭제는 다른 images 행 무영향", async () => {
    const sha = "d".repeat(64);
    await seedImageNode({ sha256: sha, content: "정상 이미지" });
    // asset_sha256 metadata 가 없는 손상 image_asset 노드. json_extract 가 NULL →
    // images 행 매칭 0 (NULL = ? 는 거짓) → 다른 정상 이미지 행 보존.
    const brokenId = await store.addNode({
      content: "asset_sha256 없는 손상 노드",
      sourceType: "image_asset",
    });
    await store.deleteNode(brokenId);
    expect(imagesCount(sha)).toBe(1);
  });
});

describe("deleteBySource — messageId 기반 삭제", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => { db.close(); });

  test("messageId 일치 노드 단건 삭제 + vec_nodes 캐스케이드", async () => {
    const id = await store.addNode({
      content: "디스코드에서 보낸 메모",
      metadata: { source: "discord-dm", messageId: "msg-123" },
    });
    expect(await store.getVectorById(id)).not.toBeNull();

    const result = await store.deleteBySource({ messageId: "msg-123" });
    expect(result.deletedIds).toEqual([id]);
    expect(await store.getNode(id)).toBeNull();
    expect(await store.getVectorById(id)).toBeNull();
  });

  test("messageId 무관 노드는 보존", async () => {
    const keepId = await store.addNode({
      content: "다른 메시지",
      metadata: { source: "discord-channel", messageId: "msg-other" },
    });
    const killId = await store.addNode({
      content: "지울 메시지",
      metadata: { source: "discord-channel", messageId: "msg-target" },
    });

    const result = await store.deleteBySource({ messageId: "msg-target" });
    expect(result.deletedIds).toEqual([killId]);
    expect(await store.getNode(keepId)).not.toBeNull();
  });

  // WP-B1-20T 설계 3.4·5.3 — 추출 자식은 원문 metadata 의 messageId 복사가 아니라 계보 엣지(원문
  // 쪽 merged_into, 실제 추출 저장이 남기는 모양)로 따라간다. 메시지 출처 행을 가진 원문만 뿌리이고,
  // 자식은 계보로 함께 지워진다(derivedDeletedIds).
  test("같은 messageId에서 파생된 LLM 추출 자식들도 함께 삭제", async () => {
    const rawId = await store.addNode({
      content: "복합 메모",
      metadata: { source: "discord-channel", messageId: "msg-x" },
    });
    const childOf = (content: string) => store.addNode({
      content,
      sourceType: "llm_extract",
      metadata: {
        source: "llm_extract",
        platform: "discord",
        messageId: "msg-x",
      },
      provenance: { kind: "derived", parentId: rawId, relation: "merged_into", edgeProvenance: "system" },
    });
    const child1 = await childOf("추출 사실 1");
    const child2 = await childOf("추출 사실 2");

    const result = await store.deleteBySource({ messageId: "msg-x" });
    expect(result).toEqual({
      deletedIds: [rawId],
      derivedDeletedIds: [child1, child2].sort((a, b) => a - b),
      keptIds: [],
      archivePurgedIds: [],
      revisionBodiesCleared: 0,
      retractedDerivedDeletedIds: [], assetCleanup: { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] },
    });
    expect(await store.getNode(rawId)).toBeNull();
    expect(await store.getNode(child1)).toBeNull();
    expect(await store.getNode(child2)).toBeNull();
  });

  test("platform 필터: 다른 플랫폼 동일 messageId는 보존", async () => {
    const discordId = await store.addNode({
      content: "디스코드 메모",
      metadata: { source: "discord-dm", messageId: "1234" },
    });
    const telegramId = await store.addNode({
      content: "텔레그램 메모",
      metadata: { source: "telegram-private", messageId: "1234" },
    });

    const result = await store.deleteBySource({
      messageId: "1234",
      platform: "discord",
    });
    expect(result.deletedIds).toEqual([discordId]);
    expect(await store.getNode(telegramId)).not.toBeNull();
  });

  test("매칭 없으면 빈 배열, DB 변경 없음", async () => {
    const id = await store.addNode({
      content: "혼자 있는 메모",
      metadata: { source: "discord-channel", messageId: "msg-A" },
    });
    const result = await store.deleteBySource({ messageId: "msg-none" });
    expect(result.deletedIds).toEqual([]);
    expect(await store.getNode(id)).not.toBeNull();
  });

  test("빈 messageId는 즉시 빈 배열 (no-op 안전)", async () => {
    await store.addNode({
      content: "어떤 메모",
      metadata: { source: "discord-channel", messageId: "msg-A" },
    });
    const result = await store.deleteBySource({ messageId: "" });
    expect(result.deletedIds).toEqual([]);
  });

  test("metadata 없는 노드는 매칭 후보에 안 들어옴", async () => {
    const orphan = await store.addNode({
      content: "manual 입력",
      sourceType: "user_explicit",
      // metadata 생략 → 기본 {} 으로 저장됨
    });
    const result = await store.deleteBySource({ messageId: "anything" });
    expect(result.deletedIds).toEqual([]);
    expect(await store.getNode(orphan)).not.toBeNull();
  });
});

describe("archive 관련 메서드", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });

  afterEach(() => {
    db.close();
  });

  test("trashNodes: 노드를 archive로 이동 + knowledge_nodes에서 삭제", async () => {
    const id = await store.addNode({
      content: "테스트 메모",
      importance: 0.2,
    });
    const result = await store.trashNodes([id], "cascade");
    expect(result).toEqual({ rootIds: [id], movedIds: [id], cascadeMovedIds: [], blockedIds: [] });
    expect(await store.getNode(id)).toBeNull();
    const archive = await store.getArchive();
    expect(archive).toHaveLength(1);
    expect(archive[0]!.id).toBe(id);
    expect(archive[0]!.content).toBe("테스트 메모");
  });

  test("getArchive: limit + since 옵션", async () => {
    for (let i = 0; i < 5; i++) {
      const id = await store.addNode({ content: `메모 ${i}`, importance: 0.2 });
      await store.trashNodes([id], "cascade");
    }
    const all = await store.getArchive({ limit: 3 });
    expect(all).toHaveLength(3);
  });

  test("restoreArchived: archive에서 knowledge_nodes로 복원 + 임베딩 재생성", async () => {
    const id = await store.addNode({
      content: "복원 테스트 메모",
      importance: 0.3,
    });
    await store.trashNodes([id], "cascade");
    const restored = await store.restoreArchived(id, "store-test");
    expect(restored).not.toBeNull();
    expect(restored!.content).toBe("복원 테스트 메모");
    expect(await store.getArchive()).toHaveLength(0);
    expect(await store.getNode(id)).not.toBeNull();
    const vec = await store.getVectorById(id);
    expect(vec).not.toBeNull();
  });

  test("보관→복원 원래대로 — embedding_text / polarity / project_id / event_at 4칸 보존 (1.2 T13 A-5)", async () => {
    const id = await store.addNode({
      content: "보존 검증 메모",
      importance: 0.3,
      polarity: "negative",
      project_id: "prj_archive_roundtrip",
      eventAt: "2026-03-05 09:00:00",
    });
    // embedding_text 는 addNode 입력 통로가 없으므로 직접 채워 보존 대상에 넣는다.
    db.prepare("UPDATE knowledge_nodes SET embedding_text = ? WHERE id = ?").run(
      "임베딩 입력 본문",
      id,
    );

    // archive INSERT 가 4칸을 보존하는지 확인.
    await store.trashNodes([id], "cascade");
    const archRow = db
      .prepare(
        "SELECT embedding_text, polarity, project_id, event_at FROM knowledge_nodes_archive WHERE id = ?",
      )
      .get(id) as {
      embedding_text: string | null;
      polarity: string | null;
      project_id: string | null;
      event_at: string | null;
    };
    expect(archRow.embedding_text).toBe("임베딩 입력 본문");
    expect(archRow.polarity).toBe("negative");
    expect(archRow.project_id).toBe("prj_archive_roundtrip");
    expect(archRow.event_at).toBe("2026-03-05 09:00:00");

    // restore 가 4칸을 그대로 회복하는지 확인.
    const restored = await store.restoreArchived(id, "store-test");
    expect(restored).not.toBeNull();
    expect(restored!.polarity).toBe("negative");
    expect(restored!.eventAt).toBe("2026-03-05 09:00:00");
    const back = db
      .prepare(
        "SELECT embedding_text, project_id FROM knowledge_nodes WHERE id = ?",
      )
      .get(id) as { embedding_text: string | null; project_id: string | null };
    expect(back.embedding_text).toBe("임베딩 입력 본문");
    expect(back.project_id).toBe("prj_archive_roundtrip");
  });

  test("restoreArchived: 없는 id면 null", async () => {
    expect(await store.restoreArchived(99999, "store-test")).toBeNull();
  });

  test("purgeOldArchive: 30일 지난 archive 영구 삭제", async () => {
    const id = await store.addNode({ content: "오래된 메모", importance: 0.2 });
    await store.trashNodes([id], "cascade");
    // archived_at를 35일 전으로 강제 설정
    const past = new Date(Date.now() - 35 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    db.prepare(
      "UPDATE knowledge_nodes_archive SET archived_at = ? WHERE id = ?",
    ).run(past, id);

    const purged = await store.purgeOldArchive(30);
    // WP-B1-20U 설계 17.17 — 문서·이미지 노드가 아니라 해제한 첨부가 없다.
    expect(purged).toEqual({ nodesPurged: 1, assetCleanup: { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] } });
    expect(await store.getArchive()).toHaveLength(0);
  });

  test("getArchiveSoonToPurge: 영구 삭제 임박 노드 반환", async () => {
    const id = await store.addNode({ content: "임박 메모", importance: 0.2 });
    await store.trashNodes([id], "cascade");
    // archived_at를 25일 전으로 설정 (30일 한계, 7일 경고 → 23~30일 사이)
    const past = new Date(Date.now() - 25 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    db.prepare(
      "UPDATE knowledge_nodes_archive SET archived_at = ? WHERE id = ?",
    ).run(past, id);

    const soon = await store.getArchiveSoonToPurge(7, 30);
    expect(soon).toHaveLength(1);
    expect(soon[0]!.id).toBe(id);
  });

  test("logAutoCleanupActivity + getEvolverActivity 라운드트립", async () => {
    await store.logAutoCleanupActivity({
      clusterEdgesAdded: 5,
      nodesArchived: 3,
    });
    const acts = await store.getEvolverActivity(7);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.clusterEdgesAdded).toBe(5);
    expect(acts[0]!.nodesArchived).toBe(3);
  });

  test("logTrashActivity + getEvolverActivity 라운드트립", async () => {
    await store.logTrashActivity({
      nodesPurged: 4,
      soonToPurgeCount: 2,
    });
    const acts = await store.getEvolverActivity(7);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.nodesPurged).toBe(4);
    expect(acts[0]!.soonToPurgeCount).toBe(2);
  });
});

describe("resetAllMemory — 데이터 초기화 (휴지통 포함)", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });

  afterEach(() => {
    db.close();
  });

  test("다섯 테이블 한 묶음 비우기 — knowledge_nodes / edges / archive / activity / revisions", async () => {
    const a = await store.addNode({ content: "메모 A", importance: 0.5 });
    const b = await store.addNode({ content: "메모 B", importance: 0.5 });
    const c = await store.addNode({ content: "휴지통행 메모", importance: 0.2 });
    await store.addEdge({ sourceId: a, targetId: b, relation: "related_to", weight: 0.5 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    await store.trashNodes([c], "cascade");
    await store.logAutoCleanupActivity({
      clusterEdgesAdded: 1,
      nodesArchived: 1,
    });
    await store.insertRevision({
      oldNodeId: a,
      newNodeId: b,
      revisionType: "manual",
      reason: "reset 테스트용",
    });

    const counts = store.resetAllMemory();

    expect(counts.knowledgeNodes).toBe(2);
    expect(counts.knowledgeEdges).toBe(1);
    expect(counts.knowledgeNodesArchive).toBe(1);
    // 묶음 집계(§7.2): activity 1 + revision 1 = logs 2. 나머지 그룹은 0.
    expect(counts.logs).toBe(2);
    expect(counts.conceptsAndPersons).toBe(0);
    expect(counts.entities).toBe(0);
    expect(counts.entityEdges).toBe(0);
    expect(counts.summaries).toBe(0);
    expect(counts.assets).toBe(0);
    expect(counts.boundary).toBe(0);
    expect(counts.totalRowsDeleted).toBe(2 + 1 + 1 + 2);

    const stats = await store.getStats();
    expect(stats.totalMemories).toBe(0);
    expect(stats.totalEdges).toBe(0);
    expect(await store.getArchive()).toHaveLength(0);
    expect(await store.getEvolverActivity(7)).toHaveLength(0);
  });

  test("자산·개념·사람·엣지 전부 비우고 schema_version 보존", async () => {
    const mem = await store.addNode({ content: "글", importance: 0.5 });
    const cid = await store.findOrCreateTagConcept("만화");
    await store.addNodeConceptEdge(mem, cid, "tag", "user_input", mem);
    const p = await store.findOrCreatePerson({ displayName: "나", userId: "u1", source: "discord" });
    await store.addNodePersonEdge(mem, p.personId, "authored_by", "user_input", mem);
    const c2 = await store.findOrCreateTagConcept("주술회전");
    await store.addConceptEdge({ sourceConceptId: c2, targetConceptId: cid, relation: "parent_of" ,
    provenance: "user_input",
    sourceNodeId: null,
});

    const counts = store.resetAllMemory();
    expect(counts.knowledgeNodes).toBe(1);
    // conceptsAndPersons = concept_nodes 2 + persons 1 + node_concept_edges 1
    //   + node_person_edges 1 + concept_edges 1 = 6 (묶음 집계 §7.2).
    expect(counts.conceptsAndPersons).toBe(6);

    expect((await store.listConcepts()).length).toBe(0);
    expect((await store.getRecent(10)).length).toBe(0);
    const v = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(v.v).toBeGreaterThanOrEqual(1);
  });

  test("자산·문서·이미지 메타 + sqlite_sequence 비우기 → 새 노드 id=1", async () => {
    // 노드 + 자산/문서/이미지 메타를 채운다. 자산 메타는 데이터 fixture 로 직접
    // INSERT (ingest 파이프라인의 임베딩·네트워크 의존 회피 — 정리 범위만 검증).
    await store.addNode({ content: "초기화 전 노드 A", importance: 0.5 });
    await store.addNode({ content: "초기화 전 노드 B", importance: 0.5 });

    const sha = "a".repeat(64);
    const now = Date.now();
    db.run(
      `INSERT INTO asset_files
        (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
       VALUES (?, 'document', ?, 10, 'text/markdown', 'doc.md', ?)`,
      [sha, `/content/${sha}.md`, now],
    );
    db.run(
      `INSERT INTO asset_file_imports
        (import_id, asset_sha256, source, source_ref, original_name, imported_at, author, user_id)
       VALUES ('imp-1', ?, 'dashboard', NULL, 'doc.md', ?, 'me', 'u1')`,
      [sha, now],
    );
    db.run(
      `INSERT INTO documents
        (document_id, asset_sha256, title, document_type, chunk_count, created_at, updated_at)
       VALUES ('doc-1', ?, '문서 제목', 'markdown', 0, ?, ?)`,
      [sha, now, now],
    );
    db.run(
      `INSERT INTO images
        (asset_sha256, thumb_sha256, width, height, mime, preserve_mode, is_animated)
       VALUES (?, NULL, 100, 100, 'image/png', 'smart', 0)`,
      [sha],
    );

    const counts = store.resetAllMemory();

    expect(counts.knowledgeNodes).toBe(2);
    // assets = images 1 + documents 1 + asset_file_imports 1 + asset_files 1 = 4.
    expect(counts.assets).toBe(4);

    // 모든 대상 테이블이 0 행.
    for (const table of [
      "knowledge_nodes",
      "images",
      "documents",
      "asset_file_imports",
      "asset_files",
    ]) {
      const row = db
        .prepare(`SELECT COUNT(*) AS c FROM ${table}`)
        .get() as { c: number };
      expect(row.c).toBe(0);
    }

    // sqlite_sequence 가 비었고, 초기화 후 새 노드 id 가 1 부터 시작.
    const seqRow = db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_sequence")
      .get() as { c: number };
    expect(seqRow.c).toBe(0);

    const newId = await store.addNode({ content: "초기화 후 첫 노드", importance: 0.5 });
    expect(newId).toBe(1);
  });

  test("트리거 cascade — vec_nodes + FTS 미러 자동 정리", async () => {
    const id = await store.addNode({ content: "검색 가능한 메모", importance: 0.5 });
    const vecBefore = await store.getVectorById(id);
    expect(vecBefore).not.toBeNull();

    store.resetAllMemory();

    expect(await store.getVectorById(id)).toBeNull();
    const ftsRow = db
      .prepare("SELECT COUNT(*) AS c FROM knowledge_nodes_fts")
      .get() as { c: number };
    expect(ftsRow.c).toBe(0);
  });

  test("schema_version 보존 — 마이그레이션 재진입 차단", () => {
    const before = (
      db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null }
    ).v;
    expect(before).not.toBeNull();

    store.resetAllMemory();

    const after = (
      db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null }
    ).v;
    expect(after).toBe(before);
  });

  test("빈 DB 에서 호출해도 안전 — 모두 0", () => {
    const counts = store.resetAllMemory();
    expect(counts.knowledgeNodes).toBe(0);
    expect(counts.knowledgeEdges).toBe(0);
    expect(counts.knowledgeNodesArchive).toBe(0);
    expect(counts.entities).toBe(0);
    expect(counts.entityEdges).toBe(0);
    expect(counts.summaries).toBe(0);
    expect(counts.conceptsAndPersons).toBe(0);
    expect(counts.assets).toBe(0);
    expect(counts.logs).toBe(0);
    expect(counts.boundary).toBe(0);
    expect(counts.userVocabulary).toBe(0);
    expect(counts.totalRowsDeleted).toBe(0);
  });

  // ── §9.1 엔티티 9 본체 + 라벨/관계 엣지 + 요약 + 미러까지 0행 ──────────────
  test("엔티티 9 본체·라벨/관계 엣지·요약 + FTS/vec 미러 전부 0행", async () => {
    // stage4 T4: 8 타입을 범용 본체 entities 로 흡수한 뒤이므로, 8 타입은
    // store.entitiesRepo.findOrCreateEntity(typeName, name) 로 만든다(이게 entities
    // 본체 + entities_fts·entities_vec 미러를 같이 채운다). 사람·프로젝트는 1급이라
    // 전용 facade·전용 테이블(persons·projects) 그대로다(데이터 fixture·mock 0).
    const cre = await store.entitiesRepo.findOrCreateEntity("creature", "고양이");
    await store.entitiesRepo.findOrCreateEntity("thing", "의자");
    const itk = await store.entitiesRepo.findOrCreateEntity("intake", "우유");
    await store.entitiesRepo.findOrCreateEntity("usable", "드라이버");
    const wrk = await store.entitiesRepo.findOrCreateEntity("work", "주술회전");
    await store.entitiesRepo.findOrCreateEntity("material", "논문");
    await store.entitiesRepo.findOrCreateEntity("place", "서울");
    await store.entitiesRepo.findOrCreateEntity("schedule", "회의");
    const prj = await store.findOrCreateProject({ name: "바라" });
    const psn = await store.findOrCreatePersonByName("아쿠타미");

    // stage4 T4 reset 증명 보강 — entity_attributes(칸·별칭)·entities_vec(임베딩)를 실제로
    // 채워, reset 후 0행이 "비운 결과"임을 실증한다(빈 채로 시작해 vacuous 0 이 되는 걸 차단).
    // 칸 attr(is_column=1)·별칭 attr·임베딩을 더하면 entity_attributes·entities_vec 가 1+ 행이 되고,
    // entities_fts 는 ent_*_트리거가 합성 색인으로 늘 채운다(8 entities 가 곧 8 fts 행).
    store.entitiesRepo.setAttribute(itk.id, "expires_at", "2026-07-01", true);
    store.entitiesRepo.setKoAliases(wrk.id, ["주회"]);
    await store.entitiesRepo.applyEmbedding(wrk.id); // entities_vec 1행 적재(실 bge-m3).

    // 라벨 엣지(role='has_attribute') — 엔티티 행 ↔ 라벨 개념.
    const labelConcept = await store.findOrCreateTagConcept("재밌음");
    store.addEntityConceptEdge("work", wrk.id, labelConcept, "has_attribute", "user_input", null);
    store.addEntityConceptEdge("creature", cre.id, labelConcept, "has_attribute", "user_input", null);

    // 프로젝트 라벨(통합 entity_concept_edges) + 참여자(범용 entity_relation_edges
    // participated_by — store.addProjectPersonEdge mixin 이 그리로 쓴다·S2·S3·S4).
    const projConcept = await store.findOrCreateTagConcept("ai");
    await store.addProjectConceptEdge(prj.projectId, projConcept, "tag", "user_input", null);
    await store.addProjectPersonEdge(prj.projectId, psn.personId, "owner", "user_input", null);

    // entity_relation_edges — 작품 → 사람 created_by.
    store.addEntityRelationEdge("work", wrk.id, "person", psn.personId, "created_by", "user_input", null);

    // hierarchy_edges(S0-T1 위계 단일 출처) — 개념 → 작품 parent_of 한 줄.
    // FK 0 이라 데이터 fixture 로 직접 INSERT (끝점 실재는 위 facade 행이 보장).
    db.run(
      `INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, weight, provenance, source_node_id) VALUES ('concept', ?, 'work', ?, 'parent_of', 0.9, 'user_input', NULL)`,
      [String(labelConcept), String(wrk.id)],
    );

    // 요약 2종 — chunk_summaries 는 실제 document + chunk(knowledge_node) FK 필요.
    const chunkNodeId = await store.addNode({ content: "청크 본문", importance: 0.5 });
    const sha = "b".repeat(64);
    const now = Date.now();
    db.run(
      `INSERT INTO asset_files
        (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
       VALUES (?, 'document', ?, 10, 'text/markdown', 'd.md', ?)`,
      [sha, `/content/${sha}.md`, now],
    );
    db.run(
      `INSERT INTO documents
        (document_id, asset_sha256, title, document_type, chunk_count, created_at, updated_at)
       VALUES ('doc-s', ?, '문서', 'markdown', 1, ?, ?)`,
      [sha, now, now],
    );
    await store.insertChunkSummary({
      summaryId: "cs_1",
      parentChunkId: chunkNodeId,
      parentDocumentId: "doc-s",
      summaryText: "청크 요약 문장",
      generatedBy: "llm",
    });
    await store.insertRelationSummary({
      summaryId: "rs_1",
      fromConceptId: labelConcept,
      toConceptId: projConcept,
      relationName: "related_to",
      summaryText: "관계 요약 문장",
      confidence: 0.9,
      generatedBy: "llm",
      sourceDocumentId: "doc-s",
    });

    const countOf = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

    // reset 직전 — 단계4 T7'b: 8 타입 + 프로젝트가 모두 범용 entities 본체에 9행으로
    // 산다(프로젝트가 옛 projects 에서 entities(type_name='project')로 옮겨짐). 옛 projects
    // 테이블은 단계4 T9'(v30)이 DROP 했으므로 더는 검사 대상이 아니다.
    expect(countOf("entities")).toBe(9);
    // 미러·칸도 reset 전에 실제로 채워져 있다(0→0 vacuous 가 아님을 단정으로 남긴다).
    // 프로젝트 status·summary 도 entity_attributes 칸으로 들어가 행 수가 더 는다.
    expect(countOf("entity_attributes")).toBeGreaterThanOrEqual(2); // 칸 expires_at + 별칭 ko_aliases
    expect(countOf("entities_fts")).toBe(9); // 합성 색인 — 엔티티당 한 문서(8 타입 + 프로젝트)
    expect(countOf("entities_vec")).toBe(1); // wrk 임베딩 1행(프로젝트는 이 테스트서 임베딩 안 함)

    const counts = store.resetAllMemory();

    // 엔티티 본체 9(범용 entities 9 — 8 타입 + 프로젝트)가 비워졌다(옛 projects 는 v30 DROP).
    expect(counts.entities).toBe(9); // 범용 entities 9행(8 타입 + 프로젝트)
    // 라벨 엣지 2(work·creature) + project_concept 1(통합 entity_concept_edges 로 합류)
    //   = entity_concept_edges 3 / entity_relation_edges 2(created_by 작품→사람 +
    //   participated_by 프로젝트→사람·S2·S3·S4) + hierarchy 1 = 6.
    expect(counts.entityEdges).toBe(6);
    // chunk 1 + relation 1 = 2.
    expect(counts.summaries).toBe(2);

    // 범용 본체 entities + FTS/vec 미러 + entity_attributes 전부 0행
    // (stage4 T4 후 8 타입의 실제 거처 — 트리거·FK cascade 가 미러·칸을 따라 정리).
    expect(countOf("entities")).toBe(0);
    expect(countOf("entities_fts")).toBe(0);
    expect(countOf("entities_vec")).toBe(0);
    expect(countOf("entity_attributes")).toBe(0);

    // 라벨/identity 엣지(8 타입 + 프로젝트) — stage4 T4 통합 테이블 entity_concept_edges 0행.
    // (옛 per-type <type>_concept_edges·project_concept_edges 는 단계4 T9'(v30)이 DROP 한
    //  죽은 테이블이라 검사 대상이 아니다 — 라벨은 entity_concept_edges 로 통합됐다.)
    expect(countOf("entity_concept_edges")).toBe(0);
    // 프로젝트 본체·검색 미러는 범용 entities/entities_fts/entities_vec 로 통일됐고(T7'b),
    // 옛 projects·projects_fts·project_summary_vec 는 v30 DROP 으로 사라졌다(검사 대상 아님).
    // persons + 미러(person A 완전 보존).
    expect(countOf("persons")).toBe(0);
    expect(countOf("persons_fts")).toBe(0);
    expect(countOf("person_vec")).toBe(0);

    // 관계·참여자 엣지 0행. 참여자(participated_by)는 범용 entity_relation_edges 에
    // 산다(옛 전용 project_person_edges 는 S4(v31)가 DROP — 검사 대상 아님).
    expect(countOf("entity_relation_edges")).toBe(0);
    // 위계 단일 출처(S0-T2) — reset 후 찌꺼기 0행.
    expect(countOf("hierarchy_edges")).toBe(0);

    // 요약 본체 + vec 미러 0행.
    expect(countOf("chunk_summaries")).toBe(0);
    expect(countOf("relation_summaries")).toBe(0);
    expect(countOf("chunk_summary_vec")).toBe(0);
    expect(countOf("relation_summary_vec")).toBe(0);
  });

  // ── §9.2 보존 단언 — 정규식 학습 자산·schema_version 생존 ──────────────────
  test("정규식 학습 자산(regex_user_*) 보존 — reset 후 생존", () => {
    const now = "2026-06-11 00:00:00";
    db.run(
      `INSERT INTO regex_user_patterns
        (pattern_id, pattern_text, score, category, created_at, updated_at)
       VALUES ('rp_1', '내?\\s*생일', 3, 'fact', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO regex_user_boosters
        (booster_id, word, score, created_at, updated_at)
       VALUES ('rb_1', '중요', 2, ?, ?)`,
      [now, now],
    );

    const schemaBefore = (
      db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }
    ).v;

    store.resetAllMemory();

    const countOf = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    expect(countOf("regex_user_patterns")).toBe(1); // 학습 자산 — 보존.
    expect(countOf("regex_user_boosters")).toBe(1); // 학습 자산 — 보존.

    const schemaAfter = (
      db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }
    ).v;
    expect(schemaAfter).toBe(schemaBefore); // schema_version 행 생존.
  });

  // ── §9.1 (경계) 경계 테이블 전부 "비움"(D-1~D-5) ──────────────────────────
  test("경계 테이블(경계 5종) 전부 비움 — D-1~D-5", async () => {
    const now = "2026-06-11 00:00:00";
    // concept_alias_suggestions 는 concept_nodes(concept_id) FK 를 가지므로 실제
    // 개념 두 개를 먼저 만든다(데이터 fixture).
    const cptA = await store.findOrCreateTagConcept("개념가");
    const cptB = await store.findOrCreateTagConcept("개념나");
    db.run(
      "INSERT INTO project_vocabularies (project_id, term, expanded_meaning) VALUES ('prj_x', '바라', '메모리 모듈')",
    );
    db.run(
      "INSERT INTO cleanup_proposals (id, kind, payload_json) VALUES ('cp_1', 'merge', '{}')",
    );
    db.run(
      `INSERT INTO concept_alias_suggestions
        (suggestion_id, new_concept_id, candidate_concept_id, cosine, created_at)
       VALUES ('sg_1', ?, ?, 0.95, ?)`,
      [cptA, cptB, now],
    );
    db.run("INSERT INTO events (type, payload_json) VALUES ('notify', '{}')");
    db.run(
      `INSERT INTO tag_reflow_log
        (log_id, node_id, parent_concept_id, trigger_hierarchy, detached_at)
       VALUES ('lg_1', 1, ?, '만화:주술회전', ?)`,
      [cptA, now],
    );

    const boundaryTables = [
      "project_vocabularies",
      "cleanup_proposals",
      "concept_alias_suggestions",
      "events",
      "tag_reflow_log",
    ];
    const countOf = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

    // reset 전 경계 테이블 합 — findOrCreateTagConcept 가 부수적으로 alias
    // suggestion 을 만들 수 있어 정확한 행 수는 미리 합산해 기대값으로 쓴다.
    const boundaryBefore = boundaryTables.reduce((s, t) => s + countOf(t), 0);
    expect(boundaryBefore).toBeGreaterThanOrEqual(5); // 적어도 fixture 5행은 존재.

    const counts = store.resetAllMemory();
    // boundary 그룹 합 = reset 전 경계 테이블 행 수와 일치(전부 비움 — D-1~D-5).
    expect(counts.boundary).toBe(boundaryBefore);

    // reset 후 5종 경계 테이블 전부 0행.
    for (const t of boundaryTables) {
      expect(countOf(t)).toBe(0);
    }
  });

  // ── §9.3 단계4 T9' — registry 4 테이블 필드는 동결 스냅샷(죽은 테이블·부재) ──────
  test("ENTITY_TYPE_METAS 의 table/fts/vec/conceptEdge 가 v30 이후 sqlite_master 에 부재(동결 스냅샷)", () => {
    // 단계4 전면 통일에서 8 타입 본체·검색 미러·전용 라벨 엣지가 범용 통로로 흡수돼
    // T9'(v30)이 DROP 했다. registry 의 4 테이블 필드는 동결 스냅샷 값으로 남았으나(레지스트리
    // 길이 8 보존), 가리키는 테이블은 더는 실재하지 않는다. 런타임 권위는 범용
    // entities/entity_concept_edges 다 — 그 둘은 실재하고 4 필드가 가리키던 테이블은 부재.
    const tableNames = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    expect(ENTITY_TYPE_METAS.length).toBe(8); // 동결 스냅샷 — 정적 8 타입 보존.
    for (const m of ENTITY_TYPE_METAS) {
      expect(tableNames.has(m.table)).toBe(false);
      expect(tableNames.has(m.ftsTable)).toBe(false);
      expect(tableNames.has(m.vecTable)).toBe(false);
      expect(tableNames.has(m.conceptEdgeTable)).toBe(false);
    }
    // 런타임 권위(통합 통로)는 실재.
    expect(tableNames.has("entities")).toBe(true);
    expect(tableNames.has("entity_concept_edges")).toBe(true);
  });

  // ── §9.4 반환 묶음 집계 — totalRowsDeleted 가 그룹 합과 일치 ───────────────
  test("묶음 집계 totalRowsDeleted = 모든 그룹 합", async () => {
    await store.addNode({ content: "글 1", importance: 0.5 });
    await store.entitiesRepo.findOrCreateEntity("work", "작품 A");
    await store.findOrCreatePersonByName("사람 A");

    const c = store.resetAllMemory();
    const groupSum =
      c.knowledgeNodes +
      c.knowledgeEdges +
      c.knowledgeNodesArchive +
      c.entities +
      c.entityEdges +
      c.summaries +
      c.conceptsAndPersons +
      c.assets +
      c.logs +
      c.boundary;
    expect(c.totalRowsDeleted).toBe(groupSum);
    // work 1 + person 1 = entities 1 + conceptsAndPersons 1, knowledgeNodes 1.
    expect(c.entities).toBe(1);
    expect(c.conceptsAndPersons).toBe(1);
    expect(c.knowledgeNodes).toBe(1);
  });
});

describe("schema — archive + activity 테이블 초기화", () => {
  test("archive + activity 테이블이 새 DB에 자동 생성된다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("knowledge_nodes_archive");
    expect(names).toContain("evolver_activity");
    db.close();
  });

  test("knowledge_nodes_archive는 올바른 스키마를 갖는다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const info = db
      .prepare("PRAGMA table_info(knowledge_nodes_archive)")
      .all() as Array<{ name: string; type: string }>;
    const columnNames = new Set(info.map((col) => col.name));
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("content");
    expect(columnNames).toContain("memory_type");
    expect(columnNames).toContain("source_type");
    expect(columnNames).toContain("importance");
    expect(columnNames).toContain("confidence");
    expect(columnNames).toContain("platform");
    expect(columnNames).toContain("author");
    expect(columnNames).toContain("created_at");
    expect(columnNames).toContain("last_accessed_at");
    expect(columnNames).toContain("access_count");
    expect(columnNames).toContain("mention_count");
    expect(columnNames).toContain("last_mentioned_at");
    expect(columnNames).toContain("metadata_json");
    expect(columnNames).toContain("archived_at");
    // 1.2 T13(spec 10.3 A-5): 보존 4칸이 archive 테이블에 있다.
    expect(columnNames).toContain("embedding_text");
    expect(columnNames).toContain("polarity");
    expect(columnNames).toContain("project_id");
    expect(columnNames).toContain("event_at");
    db.close();
  });

  test("evolver_activity는 올바른 스키마를 갖는다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const info = db
      .prepare("PRAGMA table_info(evolver_activity)")
      .all() as Array<{ name: string; type: string }>;
    const columnNames = new Set(info.map((col) => col.name));
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("ran_at");
    expect(columnNames).toContain("cluster_edges_added");
    expect(columnNames).toContain("nodes_archived");
    expect(columnNames).toContain("nodes_purged");
    expect(columnNames).toContain("soon_to_purge_count");
    // 1.2 T13(spec 10.2 A-3): 옛 concepts_emerged / concepts_archived 죽은 칸 제거됨.
    expect(columnNames).not.toContain("concepts_emerged");
    expect(columnNames).not.toContain("concepts_archived");
    db.close();
  });

  test("archive 테이블에 archived_at 인덱스가 있다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='knowledge_nodes_archive'"
      )
      .all() as { name: string }[];
    const indexNames = indexes.map((idx) => idx.name);
    expect(indexNames).toContain("idx_archive_archived_at");
    db.close();
  });

  test("activity 테이블에 ran_at 인덱스가 있다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='evolver_activity'"
      )
      .all() as { name: string }[];
    const indexNames = indexes.map((idx) => idx.name);
    expect(indexNames).toContain("idx_activity_ran_at");
    db.close();
  });

  test("기존 DB에 재적용해도 IF NOT EXISTS로 인해 에러 없음", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    // 첫 초기화
    let tables1 = db
      .prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table'")
      .get() as { cnt: number };
    // 재적용 (migrations.ts 패턴)
    const { runMigrations } = await import("./migrations.ts");
    expect(() => {
      runMigrations(db);
    }).not.toThrow();
    let tables2 = db
      .prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table'")
      .get() as { cnt: number };
    // 테이블 개수는 동일 (새로 만들어지지 않음)
    expect(tables2.cnt).toBe(tables1.cnt);
    db.close();
  });
});

// ── Task 7: 개념 노드 CRUD (spec 4.2) ──────────────────────────────────

describe("개념 노드 (concept_nodes)", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("findOrCreateTagConcept 는 cpt_ id 반환 + 같은 이름 재사용", async () => {
    const a = await store.findOrCreateTagConcept("만화");
    const b = await store.findOrCreateTagConcept("만화");
    expect(a).toBe(b);
    expect(a.startsWith("cpt_")).toBe(true);
    expect((await store.listConcepts()).length).toBe(1);
  });

  test("findOrCreateConcept — 역할 플래그 OR 합류 (isTag → isClassificationKey 추가)", async () => {
    const id = await store.findOrCreateConcept("커피", { isTag: true });
    expect(id.startsWith("cpt_")).toBe(true);
    const sameId = await store.findOrCreateConcept("커피", {
      isClassificationKey: true,
    });
    expect(sameId).toBe(id);
    const concept = await store.getConcept(id);
    expect(concept).not.toBeNull();
    expect(concept!.isTag).toBe(true);
    expect(concept!.isClassificationKey).toBe(true);
  });

  test("findConceptByName — 정확 매칭 / 없으면 null", async () => {
    await store.findOrCreateTagConcept("라테");
    expect((await store.findConceptByName("라테"))?.name).toBe("라테");
    expect(await store.findConceptByName("아메리카노")).toBeNull();
  });

  test("getConcept — id 로 회수 / 없으면 null", async () => {
    const id = await store.findOrCreateTagConcept("고양이");
    const found = await store.getConcept(id);
    expect(found?.conceptId).toBe(id);
    expect(found?.name).toBe("고양이");
    expect(await store.getConcept("cpt_없는id")).toBeNull();
  });

  test("listConcepts 는 ConceptNode[] 반환 (자산 글은 섞이지 않음)", async () => {
    await store.addNode({ content: "일반 메모리" });
    const idA = await store.findOrCreateTagConcept("개념 A");
    const idB = await store.findOrCreateTagConcept("개념 B");

    const concepts = await store.listConcepts();
    const ids = concepts.map((c) => c.conceptId).sort();
    expect(ids).toEqual([idA, idB].sort());
  });

  test("findMentionedConcepts — 텍스트 부분 일치, 매치 0 → 빈 배열", async () => {
    await store.findOrCreateTagConcept("커피");
    await store.findOrCreateTagConcept("고양이");
    await store.findOrCreateTagConcept("강아지");

    const single = await store.findMentionedConcepts("오늘 커피 한 잔");
    expect(single.map((c) => c.name)).toEqual(["커피"]);

    const multi = await store.findMentionedConcepts(
      "고양이는 좋고 강아지도 좋다",
    );
    expect(multi.map((c) => c.name).sort()).toEqual(["강아지", "고양이"]);

    const none = await store.findMentionedConcepts("아무 관련 없는 문장");
    expect(none).toEqual([]);

    const empty = await store.findMentionedConcepts("");
    expect(empty).toEqual([]);
  });

  test("addNodeConceptEdge — 중복 호출 silently ignore (복합 PK)", async () => {
    const mem = await store.addNode({ content: "글" });
    const conc = await store.findOrCreateTagConcept("개념");
    expect(await store.addNodeConceptEdge(mem, conc, "mention", "user_input", mem)).toBe(true);
    expect(await store.addNodeConceptEdge(mem, conc, "mention", "user_input", mem)).toBe(false);
  });

  test("listNodeConceptEdges — nodeId / conceptId / role 필터", async () => {
    const mem = await store.addNode({ content: "오늘 커피 마심" });
    const coffee = await store.findOrCreateTagConcept("커피");
    const cat = await store.findOrCreateTagConcept("고양이");
    await store.addNodeConceptEdge(mem, coffee, "tag", "user_input", mem);
    await store.addNodeConceptEdge(mem, cat, "mention", "user_input", mem);

    const byNode = await store.listNodeConceptEdges({ nodeId: mem });
    expect(byNode).toHaveLength(2);

    const byConcept = await store.listNodeConceptEdges({ conceptId: coffee });
    expect(byConcept).toHaveLength(1);
    expect(byConcept[0]!.role).toBe("tag");

    const byRole = await store.listNodeConceptEdges({ role: "mention" });
    expect(byRole).toHaveLength(1);
    expect(byRole[0]!.conceptId).toBe(cat);
  });
});

// ── Task 15: 사람 신원 (persons) ───────────────────────────────────────

describe("findOrCreatePerson", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("새 user_id → 사람 신규 생성 + psn_ id + external_refs 정합", async () => {
    const person = await store.findOrCreatePerson({
      displayName: "친구B",
      userId: "discord_friend_b_id_123",
      source: "discord-channel",
    });
    expect(person.personId.startsWith("psn_")).toBe(true);
    expect(person.displayName).toBe("친구B");
    expect(person.externalRefs["discord-channel"]).toBe(
      "discord_friend_b_id_123",
    );
    expect(person.aliases).toEqual(["친구B"]);
  });

  test("같은 user_id 두 번째 호출 → 새 사람 안 만들고 기존 반환", async () => {
    const first = await store.findOrCreatePerson({
      displayName: "친구B",
      userId: "id_123",
    });
    const second = await store.findOrCreatePerson({
      displayName: "친구B",
      userId: "id_123",
    });
    expect(second.personId).toBe(first.personId);
    const refreshed = await store.getPerson(first.personId);
    expect(refreshed?.personId).toBe(first.personId);
  });

  test("같은 user_id 다른 displayName → 같은 사람 + aliases 누적", async () => {
    const original = await store.findOrCreatePerson({
      displayName: "친구B",
      userId: "id_123",
    });
    const renamed = await store.findOrCreatePerson({
      displayName: "B닉바꿈",
      userId: "id_123",
    });
    expect(renamed.personId).toBe(original.personId);
    expect(renamed.aliases).toEqual(["친구B", "B닉바꿈"]);
    // 또 한 번 옛 닉으로 와도 중복 추가 X
    const back = await store.findOrCreatePerson({
      displayName: "친구B",
      userId: "id_123",
    });
    expect(back.aliases).toEqual(["친구B", "B닉바꿈"]);
  });

  test("source 미지정 → default 키로 저장", async () => {
    const person = await store.findOrCreatePerson({
      displayName: "owner",
      userId: "self_id",
    });
    expect(person.externalRefs["default"]).toBe("self_id");
  });

  test("userId 빈 문자열 / displayName 빈 → throw", async () => {
    await expect(
      store.findOrCreatePerson({ displayName: "x", userId: "" }),
    ).rejects.toThrow(/userId is required/);
    await expect(
      store.findOrCreatePerson({ displayName: "   ", userId: "id" }),
    ).rejects.toThrow(/displayName must be non-empty/);
  });

  test("addNodePersonEdge / listNodePersonEdges — 중복 silently ignore + 필터", async () => {
    const mem = await store.addNode({ content: "친구가 한 말" });
    const person = await store.findOrCreatePerson({
      displayName: "친구B",
      userId: "id_123",
    });
    expect(await store.addNodePersonEdge(mem, person.personId, "mentions", "user_input", mem)).toBe(
      true,
    );
    expect(await store.addNodePersonEdge(mem, person.personId, "mentions", "user_input", mem)).toBe(
      false,
    );

    const edges = await store.listNodePersonEdges({ nodeId: mem });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("mentions");
    expect(edges[0]!.personId).toBe(person.personId);
  });
});

describe("findOrCreateTagConcept", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("같은 태그 두 번 호출 → 같은 cpt_ id 반환 (idempotent)", async () => {
    const first = await store.findOrCreateTagConcept("만화");
    const second = await store.findOrCreateTagConcept("만화");
    expect(second).toBe(first);
    expect(first.startsWith("cpt_")).toBe(true);
    const concepts = await store.listConcepts();
    expect(concepts).toHaveLength(1);
  });

  test("신규 태그 개념 — is_tag=1 + name 소문자 정규화", async () => {
    const id = await store.findOrCreateTagConcept("주술회전");
    const concept = await store.getConcept(id);
    expect(concept).not.toBeNull();
    if (!concept) return;
    expect(concept.isTag).toBe(true);
    expect(concept.name).toBe("주술회전");
  });

  test("다른 태그는 다른 id 발급", async () => {
    const a = await store.findOrCreateTagConcept("만화");
    const b = await store.findOrCreateTagConcept("애니");
    expect(a).not.toBe(b);
    const concepts = await store.listConcepts();
    expect(concepts).toHaveLength(2);
  });

  test("빈 문자열 / 공백만 입력 → throw", async () => {
    await expect(store.findOrCreateTagConcept("")).rejects.toThrow(
      /tag must be non-empty/,
    );
    await expect(store.findOrCreateTagConcept("   ")).rejects.toThrow(
      /tag must be non-empty/,
    );
  });
});

// ── concept_edges (개념 ↔ 개념 위계) ─────────────────────────────────────

describe("concept_edges — listConceptEdges + countConceptCoOccurrence", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("listConceptEdges relation 필터 — parent_of 만 반환", async () => {
    const parentTag = await store.findOrCreateTagConcept("만화");
    const childTag = await store.findOrCreateTagConcept("주술회전");

    await store.addConceptEdge({
      sourceConceptId: parentTag,
      targetConceptId: childTag,
      relation: "parent_of",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.3,
    });

    const parentOf = await store.listConceptEdges({ relation: "parent_of" });
    expect(parentOf).toHaveLength(1);
    expect(parentOf[0]!.sourceConceptId).toBe(parentTag);
    expect(parentOf[0]!.targetConceptId).toBe(childTag);
    expect(parentOf[0]!.weight).toBeCloseTo(0.3, 5);

    const all = await store.listConceptEdges();
    expect(all).toHaveLength(1);
  });

  test("getConceptNeighbors — 한 개념의 직접 이웃 엣지", async () => {
    const parentTag = await store.findOrCreateTagConcept("만화");
    const childTag = await store.findOrCreateTagConcept("주술회전");
    const otherTag = await store.findOrCreateTagConcept("애니");

    await store.addConceptEdge({
      sourceConceptId: parentTag,
      targetConceptId: childTag,
      relation: "parent_of",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.3,
    });
    await store.addConceptEdge({
      sourceConceptId: parentTag,
      targetConceptId: otherTag,
      relation: "parent_of",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.5,
    });

    const neighbors = await store.getConceptNeighbors(parentTag);
    expect(neighbors).toHaveLength(2);
    // weight DESC 정렬 — 애니(0.5) 가 주술회전(0.3) 보다 앞
    expect(neighbors[0]!.targetConceptId).toBe(otherTag);
  });

  test("countConceptCoOccurrence — 두 태그 공출현 자산 글 distinct count", async () => {
    const parentTag = await store.findOrCreateTagConcept("만화");
    const childTag = await store.findOrCreateTagConcept("주술회전");

    // 자산 글 3개 — 만화 + 주술회전 둘 다 태그로 연결
    for (let i = 0; i < 3; i++) {
      const bodyId = await store.addNode({
        content: `글 ${i}`,
        memoryType: "fact",
      });
      await store.addNodeConceptEdge(bodyId, parentTag, "tag", "user_input", bodyId);
      await store.addNodeConceptEdge(bodyId, childTag, "tag", "user_input", bodyId);
    }

    // 자산 글 1개 — 만화 만 (child 쪽 연결 안 함)
    const soloBody = await store.addNode({
      content: "만화만",
      memoryType: "fact",
    });
    await store.addNodeConceptEdge(soloBody, parentTag, "tag", "user_input", soloBody);

    const cnt = await store.countConceptCoOccurrence(parentTag, childTag);
    expect(cnt).toBe(3);

    // 역방향 카운트 — 같은 그래프 구조면 결과 동일 (SQL self-join 대칭)
    const reverseCnt = await store.countConceptCoOccurrence(childTag, parentTag);
    expect(reverseCnt).toBe(3);
  });

  test("countConceptCoOccurrence — 공출현 0 이면 0 반환 (throw 안 함)", async () => {
    const a = await store.findOrCreateTagConcept("만화");
    const b = await store.findOrCreateTagConcept("애니");
    const cnt = await store.countConceptCoOccurrence(a, b);
    expect(cnt).toBe(0);
  });

});

// ── Task 8: Revision 이력 CRUD (spec 4.3) ──────────────────────────────

describe("memory_revisions CRUD", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("insertRevision 은 새 id 반환 + DB 행 저장 (RETURNING)", async () => {
    const oldId = await store.addNode({ content: "옛 사실" });
    const newId = await store.addNode({ content: "갱신된 사실" });
    const revId = await store.insertRevision({
      oldNodeId: oldId,
      newNodeId: newId,
      revisionType: "conflict_supersede",
      reason: "더 최근 출처",
      similarityScore: 0.91,
    });
    expect(revId).toBeGreaterThan(0);
    const row = db
      .prepare("SELECT * FROM memory_revisions WHERE id = ?")
      .get(revId) as {
      old_node_id: number;
      new_node_id: number | null;
      revision_type: string;
      reason: string | null;
      similarity_score: number | null;
    };
    expect(row.old_node_id).toBe(oldId);
    expect(row.new_node_id).toBe(newId);
    expect(row.revision_type).toBe("conflict_supersede");
    expect(row.reason).toBe("더 최근 출처");
    expect(row.similarity_score).toBe(0.91);
  });

  test("insertRevision: newNodeId=null + reason 미지정 → 순수 비활성화 시나리오", async () => {
    const oldId = await store.addNode({ content: "삭제 예정" });
    const revId = await store.insertRevision({
      oldNodeId: oldId,
      newNodeId: null,
      revisionType: "manual",
    });
    const revisions = await store.getRevisionsForNode(oldId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.id).toBe(revId);
    expect(revisions[0]!.newNodeId).toBeNull();
    expect(revisions[0]!.reason).toBeNull();
    expect(revisions[0]!.similarityScore).toBeNull();
    expect(revisions[0]!.revisionType).toBe("manual");
  });

  test("getRevisionsForNode 는 old_node_id / new_node_id 양쪽 매칭", async () => {
    const a = await store.addNode({ content: "A" });
    const b = await store.addNode({ content: "B" });
    const c = await store.addNode({ content: "C" });
    // a → b supersede
    await store.insertRevision({
      oldNodeId: a,
      newNodeId: b,
      revisionType: "conflict_supersede",
    });
    // b → c supersede
    await store.insertRevision({
      oldNodeId: b,
      newNodeId: c,
      revisionType: "conflict_supersede",
    });
    // b는 두 revision 모두에 등장 (new로 한 번, old로 한 번)
    const bRevisions = await store.getRevisionsForNode(b);
    expect(bRevisions).toHaveLength(2);
    // a는 첫 번째만 (old로)
    const aRevisions = await store.getRevisionsForNode(a);
    expect(aRevisions).toHaveLength(1);
    expect(aRevisions[0]!.oldNodeId).toBe(a);
    expect(aRevisions[0]!.newNodeId).toBe(b);
  });

  test("listRecentRevisions — revisionType 필터", async () => {
    const x = await store.addNode({ content: "X" });
    const y = await store.addNode({ content: "Y" });
    await store.insertRevision({
      oldNodeId: x,
      newNodeId: y,
      revisionType: "conflict_supersede",
    });
    await store.insertRevision({
      oldNodeId: y,
      newNodeId: null,
      revisionType: "evolution",
    });
    await store.insertRevision({
      oldNodeId: x,
      newNodeId: null,
      revisionType: "manual",
    });

    const onlySupersede = await store.listRecentRevisions({
      revisionType: "conflict_supersede",
    });
    expect(onlySupersede).toHaveLength(1);
    expect(onlySupersede[0]!.revisionType).toBe("conflict_supersede");

    const onlyEvolution = await store.listRecentRevisions({
      revisionType: "evolution",
    });
    expect(onlyEvolution).toHaveLength(1);

    const all = await store.listRecentRevisions();
    expect(all).toHaveLength(3);
  });

  test("listRecentRevisions — since 필터 + limit", async () => {
    const x = await store.addNode({ content: "X" });
    // 옛 시점 강제 INSERT
    db.prepare(
      `INSERT INTO memory_revisions
        (old_node_id, new_node_id, revision_type, reason, similarity_score, created_at)
       VALUES (?, NULL, 'manual', NULL, NULL, ?)`,
    ).run(x, "2026-01-01 00:00:00");

    await store.insertRevision({
      oldNodeId: x,
      newNodeId: null,
      revisionType: "manual",
    });

    const recent = await store.listRecentRevisions({
      since: "2026-05-01 00:00:00",
    });
    expect(recent).toHaveLength(1);

    const limited = await store.listRecentRevisions({ limit: 1 });
    expect(limited).toHaveLength(1);
  });

  test("CHECK 제약 — 잘못된 revision_type 은 throw", async () => {
    const x = await store.addNode({ content: "X" });
    expect(() => {
      db.prepare(
        `INSERT INTO memory_revisions
          (old_node_id, revision_type)
         VALUES (?, 'invalid_type')`,
      ).run(x);
    }).toThrow();
  });
});

describe("프로젝트 facade 위임 (1.2 T6)", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => { db.close(); });

  test("create → getProject → 개념 라벨 → 참여자 흐름이 facade 통로로 이어진다", async () => {
    // 프로젝트 생성 + 같은 이름 재호출은 같은 행 재사용(name UNIQUE).
    const project = await store.findOrCreateProject({
      name: "바라 메모리 모듈",
      summary: "어디든 붙는 메모리",
    });
    expect(project.projectId.startsWith("prj_")).toBe(true);
    expect(project.name).toBe("바라 메모리 모듈");
    expect(project.status).toBe("active");

    const again = await store.findOrCreateProject({ name: "바라 메모리 모듈" });
    expect(again.projectId).toBe(project.projectId);

    const fetched = await store.getProject(project.projectId);
    expect(fetched).not.toBeNull();
    expect(fetched!.summary).toBe("어디든 붙는 메모리");

    const byName = await store.findProjectByName("바라 메모리 모듈");
    expect(byName!.projectId).toBe(project.projectId);

    // 특성 라벨(개념) 연결 + 회수.
    const conceptId = await store.findOrCreateConcept("타입스크립트");
    const added = await store.addProjectConceptEdge(
      project.projectId,
      conceptId,
      "tag",
      "user_input",
      null,
    );
    expect(added).toBe(true);
    // 같은 (project, concept, role) 중복은 false.
    expect(
      await store.addProjectConceptEdge(project.projectId, conceptId, "tag", "user_input", null),
    ).toBe(false);

    const concepts = await store.listProjectConcepts(project.projectId);
    expect(concepts.map((c) => c.conceptId)).toEqual([conceptId]);
    expect(concepts[0]!.role).toBe("tag");

    // 참여자(사람) 연결 + 양방향 회수.
    const person = await store.findOrCreatePerson({
      displayName: "타니아",
      userId: "u-001",
      source: "discord",
    });
    const linked = await store.addProjectPersonEdge(
      project.projectId,
      person.personId,
      "creator",
      "user_input",
      null,
    );
    expect(linked).toBe(true);

    const participants = await store.listProjectParticipants(project.projectId);
    expect(participants.map((p) => p.personId)).toEqual([person.personId]);
    // role 통합 후 버림(빈 값) — 사용자 결정.
    expect(participants[0]!.role).toBe("");

    const personProjects = await store.listPersonProjects(person.personId);
    expect(personProjects.map((p) => p.projectId)).toEqual([
      project.projectId,
    ]);
  });

  test("updateProject 부분 수정 + applyProjectEmbedding 적재", async () => {
    const project = await store.findOrCreateProject({ name: "임베딩 대상" });
    const updated = await store.updateProject(project.projectId, {
      summary: "갱신된 요약",
      status: "done",
    });
    expect(updated).not.toBeNull();
    expect(updated!.summary).toBe("갱신된 요약");
    expect(updated!.status).toBe("done");

    // 요약 임베딩 적재 — facade 통로로 project_summary_vec 채워짐.
    expect(await store.applyProjectEmbedding(project.projectId)).toBe(true);

    // status 필터 목록도 facade 로 회수.
    const doneOnly = await store.listProjects({ status: "done" });
    expect(doneOnly.map((p) => p.projectId)).toContain(project.projectId);
  });

  test("미존재 프로젝트 id 는 getProject·updateProject 둘 다 null", async () => {
    expect(await store.getProject("prj_nope")).toBeNull();
    expect(await store.updateProject("prj_nope", { status: "paused" })).toBeNull();
  });
});

describe("사람 확장 facade 위임 (1.2 T6)", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => { db.close(); });

  test("updatePersonFacts → persons_fts 색인에 생일이 반영된다(트리거)", async () => {
    const person = await store.findOrCreatePerson({
      displayName: "홍길동",
      userId: "u-99",
      source: "discord",
    });

    const updated = await store.updatePersonFacts(person.personId, {
      birthday: "0000-00-00",
      gender: "남",
    });
    expect(updated).not.toBeNull();

    // persons_fts 는 display_name/aliases/birthday UPDATE 시 트리거가 재색인한다.
    // facade 위임이 실제 PersonRepository 동작을 그대로 태우는지 글자 검색으로 확인.
    const hit = db
      .prepare(
        "SELECT person_id FROM persons_fts WHERE persons_fts MATCH ? LIMIT 1",
      )
      .get("0000*") as { person_id: string } | null;
    expect(hit).not.toBeNull();
    expect(hit!.person_id).toBe(person.personId);
  });

  test("addPersonAttributeConcept → getPersonsByAttributeConcept 역방향 회수", async () => {
    const person = await store.findOrCreatePerson({
      displayName: "이순신",
      userId: "u-77",
      source: "discord",
    });
    const jobConcept = await store.findOrCreateConcept("개발자");

    expect(
      await store.addPersonAttributeConcept(person.personId, jobConcept, "user_input", null),
    ).toBe(true);

    // EdgeRepository 가 보유한 역방향 조회로 위임되는지 확인.
    const people = store.getPersonsByAttributeConcept(jobConcept);
    expect(people).toEqual([person.personId]);
  });

  test("addPersonAlias 누적 + applyPersonEmbedding 적재", async () => {
    const person = await store.findOrCreatePerson({
      displayName: "강감찬",
      userId: "u-55",
      source: "discord",
    });
    const aliased = await store.addPersonAlias(person.personId, "장군");
    expect(aliased).not.toBeNull();
    expect(aliased!.aliases).toContain("장군");

    expect(await store.applyPersonEmbedding(person.personId)).toBe(true);
  });
});
