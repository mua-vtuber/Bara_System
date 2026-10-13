/**
 * graph.test-helpers.ts — GET /graph/overview 라우트 테스트용 실제 store 셋업.
 *
 * Mock 금지. Bgem3Embedder + bun:sqlite(:memory:) + SqliteMemoryStore 실 구현체.
 * makeGraphTestDeps() 한 번 호출 → MemoryApiDeps(store 포함) + 정리 핸들 반환.
 */

import type { Database } from "bun:sqlite";
import type { MemoryApiDeps } from "../types.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";

/** makeGraphTestDeps 반환값 — deps + DB 정리 핸들. */
export interface GraphTestContext {
  deps: MemoryApiDeps;
  store: SqliteMemoryStore;
  db: Database;
  /** 테스트 끝에 호출해 DB 핸들을 닫는다. */
  close: () => void;
}

let sharedEmbedder: Bgem3Embedder | undefined;

/**
 * Bgem3Embedder 를 한 번만 로드해 재사용한다.
 * beforeAll 단계에서 한 번 올리면 이후 makeGraphTestDeps 가 공유한다.
 */
export async function loadEmbedder(): Promise<Bgem3Embedder> {
  if (!sharedEmbedder) {
    sharedEmbedder = new Bgem3Embedder();
    await sharedEmbedder.load();
  }
  return sharedEmbedder;
}

/**
 * 격리된 bun:sqlite(:memory:) + SqliteMemoryStore + MemoryApiDeps 를 만든다.
 * 각 테스트가 beforeEach 에서 호출해 독립된 DB 를 얻는다.
 */
export async function makeGraphTestDeps(): Promise<GraphTestContext> {
  const embedder = await loadEmbedder();
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const deps: MemoryApiDeps = { store, retriever, assembler };
  return {
    deps,
    store,
    db,
    close: () => db.close(),
  };
}
