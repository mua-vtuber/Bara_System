/**
 * search.caption-mapping.test.ts — Phase 11e G2-2 (T4): 캡션 노드 → 부모 이미지
 * 검색 매핑(치환 + dedup + 점수 승계 + 고아 graceful) E2E 검증.
 *
 * 설계 권위 = `docs/decisions/2026-05-31-image-search-quality-spec.md` §10.3 (D4) /
 * §7 Flow C / §8.3 invariants. 후처리는 search 라우트 enriched 단계(RRF·리랭커 뒤,
 * 캐시 밖 — neighbor-chunks 와 같은 라인)에 들어가며 RRF 코어·리랭커·순위 계산을
 * 호출조차 하지 않는다. 이 테스트는 그 변환만 검증한다(점수 산출은 retriever 책임).
 *
 * 검증 항목:
 *   1. image_caption 노드가 검색되면 부모 image_asset 으로 치환돼 결과에 나온다.
 *   2. 같은 이미지가 캡션 경로 + 이미지 경로 둘 다면 dedup 으로 1건.
 *   3. 점수 승계 — 두 경로 중 높은 점수를 부모 이미지가 받는다.
 *   4. 고아 캡션(parent_of 엣지 없음) → 캡션 노드 그대로(가짜 부모 0).
 *   5. 캡션 노드가 0건인 일반 글 검색은 이 단계 전후 결과 불변(회귀 0).
 *
 * 실 Bgem3Embedder + bun:sqlite :memory: — mock 0. 운영 DB 절대 비접근.
 * image_asset 노드는 store.addNode 로 직접 적재(SigLIP·실 이미지 디코드 불요 —
 * 이 후처리는 노드가 검색 결과에 든 *뒤* 의 표시 변환이라 텍스트 검색만으로 충분).
 * parent_of 엣지는 store.addImageCaption 이 만든다(addImageCaption JSDoc).
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
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";

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
  // reranker 미주입 — 라우트가 리랭커 단계를 건너뛰어 RRF 순서·점수가 그대로다.
  // 이 테스트는 캡션 치환 후처리만 보므로 리랭커 없는 통로가 적합(코어 불변 단언).
  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

interface SearchResultItem {
  id: number;
  content: string;
  score: number;
  sourceType: string;
  assetSha256: string | null;
  captions: { user: string | null; auto: string | null };
}

interface SearchResponse {
  query: string;
  count: number;
  results: SearchResultItem[];
}

async function search(
  app: Hono,
  query: string,
  limit = 10,
): Promise<SearchResponse> {
  const res = await app.request("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResponse;
}

/** content 로 검색에 걸리는 image_asset 노드를 적재하고 node id 를 돌려준다. */
async function addImageAsset(
  store: SqliteMemoryStore,
  content: string,
  sha256: string,
): Promise<number> {
  return store.addNode({
    content,
    memoryType: "fact",
    sourceType: "image_asset",
    metadata: { asset_sha256: sha256 },
  });
}

describe("POST /search — 11e G2-2 캡션 → 부모 이미지 치환 매핑", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("캡션 노드가 검색되면 부모 image_asset 으로 치환돼 나온다", async () => {
    // 부모 image_asset — content 는 검색어와 안 겹치는 짧은 라벨(캡션 경로로만 뜨게).
    const sha = "a".repeat(64);
    const parentId = await addImageAsset(h.store, "이미지 자산 라벨 zzz", sha);
    // 한국어 캡션 자식 + parent_of 엣지(addImageCaption 이 함께 만든다).
    await h.store.addImageCaption({
      parentNodeId: parentId,
      assetSha256: sha,
      caption: "노란 후드를 입은 흰머리 여자 캐릭터 일러스트",
      captionRole: "auto",
    });

    const body = await search(h.app, "노란 후드 여자");

    // 결과에 부모 image_asset 이 나온다(캡션 노드가 아니라).
    const imageHit = body.results.find((r) => r.sourceType === "image_asset");
    expect(imageHit).toBeDefined();
    expect(imageHit!.id).toBe(parentId);
    expect(imageHit!.assetSha256).toBe(sha);
    // 캡션 글이 부모 이미지의 caption 칸으로 함께 회수된다(getImageCaptions).
    expect(imageHit!.captions.auto).toBe(
      "노란 후드를 입은 흰머리 여자 캐릭터 일러스트",
    );
    // 캡션 노드(source_type='image_caption') 자체는 결과에 안 남는다(치환됨).
    expect(body.results.some((r) => r.sourceType === "image_caption")).toBe(
      false,
    );
  });

  test("같은 이미지가 캡션 + 이미지 두 경로면 dedup 으로 1건", async () => {
    // 부모 image_asset 의 content 도 검색어와 매칭되게 → 이미지 노드가 직접
    // (vector/fts 경로로) 결과에 들고, 캡션도 같은 부모를 가리켜 결과에 든다.
    // 두 경로가 같은 부모를 가리키므로 dedup 후 1건이어야 한다.
    const sha = "b".repeat(64);
    const parentId = await addImageAsset(
      h.store,
      "파란 모자 강아지 사진",
      sha,
    );
    await h.store.addImageCaption({
      parentNodeId: parentId,
      assetSha256: sha,
      caption: "파란 모자를 쓴 강아지 사진",
      captionRole: "auto",
    });

    const body = await search(h.app, "파란 모자 강아지");

    // 같은 부모 image_asset id 가 결과에 정확히 한 번만 나온다.
    const imageHits = body.results.filter(
      (r) => r.sourceType === "image_asset" && r.id === parentId,
    );
    expect(imageHits.length).toBe(1);
    // 캡션 노드는 치환·dedup 으로 결과에 안 남는다.
    expect(body.results.some((r) => r.sourceType === "image_caption")).toBe(
      false,
    );
  });

  test("점수 승계 — 두 경로 중 높은 점수를 부모 이미지가 받는다", async () => {
    // image_asset content 와 캡션을 둘 다 검색어와 매칭. retriever 가 두 노드에
    // 각각 RRF 점수를 매기고, 치환·dedup 후 부모 이미지는 둘 중 *높은* 점수를 받는다.
    const sha = "c".repeat(64);
    const parentId = await addImageAsset(
      h.store,
      "빨간 우산 비 오는 거리",
      sha,
    );
    await h.store.addImageCaption({
      parentNodeId: parentId,
      assetSha256: sha,
      caption: "빨간 우산을 든 사람이 비 오는 거리를 걷는 그림",
      captionRole: "auto",
    });

    // 치환·dedup 적용된 응답.
    const body = await search(h.app, "빨간 우산 비");
    const merged = body.results.find(
      (r) => r.sourceType === "image_asset" && r.id === parentId,
    );
    expect(merged).toBeDefined();

    // 같은 query 를 retriever 로 직접 돌려 두 노드(이미지·캡션)의 원본 RRF 점수를
    // 확인하고, 치환된 부모의 점수가 그중 최댓값과 일치하는지 단언한다(임의 고정
    // 점수가 아니라 실제 RRF 순위 근거 — invariant 5).
    const retriever = new HybridRetriever(h.store, embedder);
    const raw = await retriever.retrieve("빨간 우산 비", { limit: 10 });
    const imageRaw = raw.find((r) => r.node.id === parentId);
    const captionRaw = raw.find(
      (r) => r.node.sourceType === "image_caption",
    );
    const expectedScore = Math.max(
      imageRaw ? imageRaw.score : -Infinity,
      captionRaw ? captionRaw.score : -Infinity,
    );
    expect(merged!.score).toBeCloseTo(expectedScore, 10);
  });

  test("고아 캡션(parent_of 엣지 없음) → 캡션 노드 그대로 표시(가짜 부모 0)", async () => {
    // parent_of 엣지·부모 노드 없이 캡션 노드만 직접 적재(데이터 이상 재현).
    // addImageCaption 을 안 쓰고 addNode 로 image_caption 노드만 만든다.
    const orphanId = await h.store.addNode({
      content: "초록 머리 마법사 소녀 캡션 글",
      memoryType: "fact",
      sourceType: "image_caption",
      metadata: { parentId: 999999, captionRole: "auto" },
    });

    const body = await search(h.app, "초록 머리 마법사");

    // 고아 캡션은 치환 안 되고 캡션 노드 그대로 결과에 남는다(가짜 부모 안 만듦).
    const orphan = body.results.find((r) => r.id === orphanId);
    expect(orphan).toBeDefined();
    expect(orphan!.sourceType).toBe("image_caption");
    // image_asset 으로 둔갑한 가짜 항목이 없다.
    expect(body.results.some((r) => r.sourceType === "image_asset")).toBe(
      false,
    );
  });

  test("캡션 0건 일반 글 검색 — 치환 단계 전후 결과 불변(회귀 0)", async () => {
    // 이미지·캡션 노드가 전혀 없는 순수 글 코퍼스. 치환 단계는 image_caption·
    // image_asset 항목이 0건이라 모든 항목을 그대로 통과시켜야 한다(byte 동일).
    await h.store.addNode({ content: "오늘 회의록 요약입니다" });
    await h.store.addNode({ content: "내일 일정 정리" });
    await h.store.addNode({ content: "커피를 마셨다" });

    // retriever 직접 결과(치환 전 RRF 순서·점수)와 라우트 응답(치환 후)을 대조.
    const retriever = new HybridRetriever(h.store, embedder);
    const raw = await retriever.retrieve("회의록 일정", { limit: 10 });
    const body = await search(h.app, "회의록 일정");

    // 항목 수·순서·id·점수가 retriever 원본과 완전히 같다(치환 단계가 글에 무해).
    expect(body.count).toBe(raw.length);
    for (let i = 0; i < raw.length; i++) {
      expect(body.results[i]!.id).toBe(raw[i]!.node.id);
      expect(body.results[i]!.score).toBeCloseTo(raw[i]!.score, 10);
      expect(body.results[i]!.sourceType).not.toBe("image_asset");
      expect(body.results[i]!.sourceType).not.toBe("image_caption");
    }
  });
});
