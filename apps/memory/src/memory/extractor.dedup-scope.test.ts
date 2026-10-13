/**
 * extractor.dedup-scope.test.ts — M6: dedup 의 author/project 스코프 회귀.
 *
 * 옛 dedup 은 전역 top-1 이 임계 이상이면 author 를 무시하고 그 노드에 흡수했다.
 * 멀티 어댑터에서 다른 author 의 거의 같은 글이 새 author 의 글을 빨아들이던 흠.
 * findDedupTarget 가 같은 author·project 후보만 고르는지 결정적으로 고정한다.
 *
 * mock 0 — 실제 SqliteMemoryStore + 실제 vec_nodes KNN. 임베딩 벡터는 데이터
 * fixture(makeVec)로 직접 만들어 넣는다(모델 로드 불요 — Bgem3Embedder 는 dimension
 * 만 읽고 embed 는 안 부른다). LLM 은 tripwire(findDedupTarget 가 LLM 을 안 부름을
 * 보장하는 감지선)라 인터페이스 mock 데이터가 아니다.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { MemoryExtractor } from "./extractor.ts";
import type { LlmClient } from "../llm/types.ts";
import { inputChildSource } from "../test-utils/extraction-placement.ts";

/**
 * 저장된 원문 없이 추출 dedup 만 본다 — 자식은 이 입력(owner, test)의 직접 출처를 받는다(WP-B1-20T 설계 6.2).
 * 같은 채널·작성자의 반복 저장이라 흡수는 지금처럼 언급 +1 이다(설계 5.2).
 */
const OWNER_CHILD_SOURCE = inputChildSource({ platform: "test", author: "owner" });

/** 1024-dim 결정성 벡터(데이터 fixture) — seed 로 방향을 살짝 틀어 유사도를 만든다. */
function makeVec(seed: number, jitter = 0): Float32Array {
  const v = new Float32Array(1024);
  for (let i = 0; i < v.length; i++) {
    v[i] = Math.sin(seed + i * 0.001) + jitter * Math.cos(i * 0.002);
  }
  return v;
}

// tripwire — findDedupTarget 는 store + embedder 만 쓰고 LLM 을 안 부른다.
// 호출되면 안 되는 chat 이 호출됐는지 잡는 감지선(인터페이스 mock 데이터 아님).
const tripwireLlm: LlmClient = {
  name: "tripwire:dedup-scope",
  chat: async () => {
    throw new Error("findDedupTarget 는 LLM 을 부르면 안 된다");
  },
};

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;
let extractor: MemoryExtractor;
let loadedEmbedder: Bgem3Embedder;

describe("M6 — dedup author/project 스코프", () => {
  beforeEach(() => {
    // Bgem3Embedder 는 dimension(1024) 필드만 읽고 load()·embed()는 안 부른다.
    embedder = new Bgem3Embedder();
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    extractor = new MemoryExtractor(tripwireLlm, store, embedder, {
      duplicateSim: 0.99,
    });
  });
  afterEach(() => {
    db.close();
  });

  /** private findDedupTarget 를 테스트에서 부른다(스코프 규칙 단일 검증 지점). */
  function findDedupTarget(
    vector: Float32Array,
    author: string,
    projectId: string | null,
  ): Promise<number | null> {
    return (
      extractor as unknown as {
        findDedupTarget: (
          v: Float32Array,
          a: string,
          p: string | null,
        ) => Promise<number | null>;
      }
    ).findDedupTarget(vector, author, projectId);
  }

  test("같은 벡터·다른 author — 새 author 의 글은 남의 노드로 흡수되지 않는다", async () => {
    const vec = makeVec(1);
    // author 'A' 노드를 같은 벡터로 넣는다(전역 top-1 이 될 노드).
    const aNode = await store.addNode({
      content: "A 의 결정",
      sourceType: "llm_extract",
      author: "A",
      platform: "discord",
      embedding: vec,
    });

    // 같은 벡터로 author 'B' 가 들어온다 — top-1 은 A 노드지만 author 가 달라 흡수 X.
    const targetForB = await findDedupTarget(vec, "B", null);
    expect(targetForB).toBeNull(); // 새 노드 삽입 경로(거짓 흡수 0).

    // 같은 author 'A' 면 그 노드를 dedup 대상으로 고른다.
    const targetForA = await findDedupTarget(vec, "A", null);
    expect(targetForA).toBe(aNode);
  });

  test("같은 author·다른 project — project 가 다르면 흡수하지 않는다", async () => {
    const vec = makeVec(2);
    const projNode = await store.addNode({
      content: "프로젝트 X 의 글",
      sourceType: "llm_extract",
      author: "A",
      platform: "discord",
      embedding: vec,
      project_id: "prj_x",
    });

    // 같은 author·같은 project 면 흡수.
    expect(await findDedupTarget(vec, "A", "prj_x")).toBe(projNode);
    // 같은 author 지만 project 가 다르면(또는 무소속) 흡수 X.
    expect(await findDedupTarget(vec, "A", "prj_y")).toBeNull();
    expect(await findDedupTarget(vec, "A", null)).toBeNull();
  });

  test("author 빈 문자열 — 옛 전역 top-1 동작 보존(스코프할 author 없음)", async () => {
    const vec = makeVec(3);
    const anyNode = await store.addNode({
      content: "무명 글",
      sourceType: "llm_extract",
      author: "누군가",
      platform: "discord",
      embedding: vec,
    });
    // author 가 비면 전역 top-1 이 임계 이상이면 그 노드를 고른다(회귀 0).
    expect(await findDedupTarget(vec, "", null)).toBe(anyNode);
  });

  test("계보 무효화로 철회된 기억은 흡수 대상이 아니고, 직접 철회한 기억은 계속 흡수한다 (SL-2)", async () => {
    const vec = makeVec(7);
    await store.addNode({
      content: "원문 편집이 거둔 추출",
      sourceType: "llm_extract",
      author: "A",
      platform: "discord",
      embedding: vec,
      metadata: { sharedMemory: { status: "retracted", revision: 1, assertionKind: "ai_inference", invalidatedBy: 1 } },
    });
    // 같은 author 갈래와 author 없는 전역 갈래 모두 건너뛴다 — 편집 뒤 재추출이 새 노드가 된다.
    expect(await findDedupTarget(vec, "A", null)).toBeNull();
    expect(await findDedupTarget(vec, "", null)).toBeNull();

    // 클라이언트가 직접 거둔 기억(invalidatedBy 없음)은 흡수해 같은 주장을 되살리지 않는다.
    const withdrawn = await store.addNode({
      content: "사용자가 직접 철회한 추출",
      sourceType: "llm_extract",
      author: "A",
      platform: "discord",
      embedding: vec,
      metadata: { sharedMemory: { status: "retracted", revision: 1, assertionKind: "ai_inference" } },
    });
    expect(await findDedupTarget(vec, "A", null)).toBe(withdrawn);
    expect(await findDedupTarget(vec, "", null)).toBe(withdrawn);
  });

  test("임계 미만 — 충분히 가깝지 않으면 dedup 대상 없음(새 노드)", async () => {
    // 서로 다른 seed 로 멀리 떨어진 두 벡터(유사도 0.99 미만).
    await store.addNode({
      content: "먼 글",
      sourceType: "llm_extract",
      author: "A",
      platform: "discord",
      embedding: makeVec(100),
    });
    // 전혀 다른 방향 벡터로 같은 author 조회 — 임계 미만이라 흡수 X.
    expect(await findDedupTarget(makeVec(900), "A", null)).toBeNull();
  });

  test("같은 author 후보가 전역 top-1 이 아니어도 K 안에 있으면 고른다", async () => {
    // 거의 같은 두 벡터 — B 가 살짝 더 가깝고(top-1), A 가 그 다음(top-2)이지만
    // 둘 다 임계 이상. author 'A' 조회는 top-1(B)을 건너뛰고 A 를 골라야 한다.
    const base = makeVec(5);
    const bCloser = makeVec(5, 0.0005); // base 와 더 가까움.
    const aFarther = makeVec(5, 0.001); // base 와 조금 덜 가깝지만 여전히 임계 이상.
    await store.addNode({
      content: "B top-1",
      sourceType: "llm_extract",
      author: "B",
      platform: "discord",
      embedding: bCloser,
    });
    const aNode = await store.addNode({
      content: "A top-2",
      sourceType: "llm_extract",
      author: "A",
      platform: "discord",
      embedding: aFarther,
    });
    const target = await findDedupTarget(base, "A", null);
    // top-1(B)을 author 불일치로 건너뛰고 A 후보를 골랐다 — 전역 top-1 흡수 차단의 핵심.
    expect(target).toBe(aNode);
  });
});

describe("extractAndStore — projectId 전파 dedup 회귀", () => {
  beforeEach(async () => {
    loadedEmbedder = new Bgem3Embedder();
    await loadedEmbedder.load();
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, loadedEmbedder);
    const fixtureLlm: LlmClient = {
      name: "fixture:project-scope",
      chat: async () =>
        JSON.stringify([
          {
            content: "Bara System은 프로젝트별 메모리를 분리한다",
            memoryType: "fact",
            importance: 0.8,
          },
        ]),
    };
    extractor = new MemoryExtractor(fixtureLlm, store, loadedEmbedder, {
      duplicateSim: 0.99,
    });
  });

  afterEach(() => {
    db.close();
  });

  test("같은 author + 같은 project + 같은 내용: dedup/bump 허용", async () => {
    const first = await extractor.extractAndStore({
      text: "Bara System은 프로젝트별 메모리를 분리한다. 같은 프로젝트 안에서는 중복을 합친다.",
      author: "owner",
      platform: "test",
      projectId: " prj_same ",
      skipHashtagWiring: true,
    }, OWNER_CHILD_SOURCE);
    const second = await extractor.extractAndStore({
      text: "Bara System은 프로젝트별 메모리를 분리한다. 같은 프로젝트 안에서는 중복을 합친다.",
      author: "owner",
      platform: "test",
      projectId: "prj_same",
      skipHashtagWiring: true,
    }, OWNER_CHILD_SOURCE);

    expect(first.storedNodeIds).toHaveLength(1);
    expect(second.storedNodeIds).toHaveLength(0);
    expect(second.bumpedNodeIds).toEqual(first.storedNodeIds);

    const node = await store.getNode(first.storedNodeIds[0]!);
    expect(node?.projectId).toBe("prj_same");
    expect(node?.mentionCount).toBe(1);
  }, 120_000);

  test("같은 author + 다른 project + 같은 내용: 새 atomic 생성", async () => {
    const a = await extractor.extractAndStore({
      text: "Bara System은 프로젝트별 메모리를 분리한다. 프로젝트 A에 남긴다.",
      author: "owner",
      platform: "test",
      projectId: "prj_a",
      skipHashtagWiring: true,
    }, OWNER_CHILD_SOURCE);
    const b = await extractor.extractAndStore({
      text: "Bara System은 프로젝트별 메모리를 분리한다. 프로젝트 B에 남긴다.",
      author: "owner",
      platform: "test",
      projectId: "prj_b",
      skipHashtagWiring: true,
    }, OWNER_CHILD_SOURCE);

    expect(a.storedNodeIds).toHaveLength(1);
    expect(b.storedNodeIds).toHaveLength(1);
    expect(b.bumpedNodeIds).toEqual([]);
    expect((await store.getNode(a.storedNodeIds[0]!))?.projectId).toBe("prj_a");
    expect((await store.getNode(b.storedNodeIds[0]!))?.projectId).toBe("prj_b");
  }, 120_000);

  test("project 있는 새 기억이 project 없는 기존 기억에 흡수되지 않음", async () => {
    const global = await extractor.extractAndStore({
      text: "Bara System은 프로젝트별 메모리를 분리한다. 무소속으로 저장한다.",
      author: "owner",
      platform: "test",
      skipHashtagWiring: true,
    }, OWNER_CHILD_SOURCE);
    const scoped = await extractor.extractAndStore({
      text: "Bara System은 프로젝트별 메모리를 분리한다. 프로젝트에 저장한다.",
      author: "owner",
      platform: "test",
      projectId: "prj_scoped",
      skipHashtagWiring: true,
    }, OWNER_CHILD_SOURCE);

    expect(global.storedNodeIds).toHaveLength(1);
    expect(scoped.storedNodeIds).toHaveLength(1);
    expect(scoped.bumpedNodeIds).toEqual([]);
    expect((await store.getNode(global.storedNodeIds[0]!))?.projectId).toBeNull();
    expect((await store.getNode(scoped.storedNodeIds[0]!))?.projectId).toBe("prj_scoped");
  }, 120_000);
});
