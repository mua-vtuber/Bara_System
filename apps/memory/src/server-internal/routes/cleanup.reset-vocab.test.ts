/**
 * cleanup.reset-vocab.test.ts — POST /admin/reset-memory 가 사용자 사전을 DB 에서 지울 뿐 아니라
 * 부팅·CRUD 가 모듈 캐시와 검색 사전에 얹어 둔 사본도 함께 되돌리는지 확인한다.
 * (DB 만 비우면 재시작 전까지 분류·검색이 지워진 사전을 계속 쓴다.)
 *
 * Mock 0: 실제 메모리 SQLite + 실제 store·retriever·사전 repo + 실제 라우트 등록기. 모델 적재가 필요
 * 없다 — 초기화는 임베딩을 쓰지 않으므로 적재 안 한 실제 Bgem3Embedder 를 넘긴다. 전역 모듈 캐시는 매
 * 테스트 뒤 기본 상태로 되돌린다.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Hono } from "hono";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ClassifyVocabOverrideRepo } from "../../memory/classify-vocab/classify-vocab-override-repo.ts";
import { ClassifyVocabUserRepo } from "../../memory/classify-vocab/classify-vocab-user-repo.ts";
import { mergeConceptVocab } from "../../memory/classify-vocab/merge-classify-vocab.ts";
import {
  loadConceptTypeVocabulary,
  placementTypeNames,
  getTypeSynonyms,
  clearConceptVocabularyOverrides,
  setConceptVocabOverride,
  setEntityTypeOverride,
} from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import {
  relationTagKeySet,
  resetRelationVocabCache,
  setRelationVocabOverride,
} from "../../memory/entity-relation-vocabulary.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { mergeRelationVocab } from "../../memory/relation-vocab/relation-vocab-merge.ts";
import { loadRelationVocabularySeed } from "../../memory/relation-vocab/relation-vocab-loader.ts";
import { RelationNameUserRepo } from "../../memory/relation-vocab/relation-name-user-repo.ts";
import { mergeSynonymDict } from "../../memory/synonyms/merge-synonym-dict.ts";
import { SynonymUserRepo } from "../../memory/synonyms/synonym-user-repo.ts";
import { loadSynonymDictionary, type SynonymDictionary } from "../../memory/synonym-dictionary.ts";
import type { MemoryApiDeps } from "../types.ts";
import { registerCleanupRoutes } from "./cleanup.ts";
import { memoryMutationsPending, withMemoryMutationLock, withMemoryWriteActivity } from "../../memory/shared-memory-mutation-lock.ts";
import { startAutoCleanupTrigger } from "../../memory/auto-cleanup-trigger.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { registerMemoriesFromTextRoutes } from "./memories-from-text.ts";

const typeNames = (): string[] => placementTypeNames();

let db: Database;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
});

afterEach(() => {
  // 전역 모듈 캐시를 기본(주입 없음) 상태로.
  setEntityTypeOverride([]);
  setRelationVocabOverride(null);
  resetRelationVocabCache();
  clearConceptVocabularyOverrides();
  resetClassifierCache();
  db.close();
});

describe("POST /admin/reset-memory — 사용자 사전 캐시 되돌리기", () => {
  test("DB 의 사용자 사전과 함께 부팅이 얹은 캐시·검색 동의어 사본이 기본으로 돌아간다", async () => {
    const embedder = new Bgem3Embedder();
    const store = new SqliteMemoryStore(db, embedder);

    // 부팅과 같은 순서로 사용자 사전을 DB 에 넣고 캐시에 얹는다.
    const synonymYamlDict = loadSynonymDictionary(
      join(import.meta.dir, "..", "..", "memory", "synonym_dictionary.yaml"),
    );
    const synonymUserRepo = new SynonymUserRepo(db);
    synonymUserRepo.addEntry({ term: "리셋시험용", synonym: "리셋동의어", lang: "ko" });
    const retriever = new HybridRetriever(store, embedder, {
      synonymDict: mergeSynonymDict(synonymYamlDict, synonymUserRepo.listEntries()),
    });
    const synonymDictOf = (): SynonymDictionary | undefined =>
      (retriever as unknown as { synonymDict?: SynonymDictionary }).synonymDict;
    expect(synonymDictOf()?.has("리셋시험용")).toBe(true);

    store.entityTypeRegistryDb.addEntityType({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
    setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
    expect(typeNames()).toContain("vehicle");

    const relationNameUserRepo = new RelationNameUserRepo(db);
    relationNameUserRepo.addEntry({
      relationKey: "리셋관계",
      relationName: "reset_rel",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
    setRelationVocabOverride(
      mergeRelationVocab(loadRelationVocabularySeed(), relationNameUserRepo.listEntries()),
    );
    resetRelationVocabCache();
    expect(relationTagKeySet().has("리셋관계")).toBe(true);

    const conceptVocabYaml = structuredClone(loadConceptTypeVocabulary());
    const classifyVocabUserRepo = new ClassifyVocabUserRepo(db);
    const classifyVocabOverrideRepo = new ClassifyVocabOverrideRepo(db);
    classifyVocabUserRepo.addEntry({ typeName: "work", slot: "synonyms", value: "리셋분류단어" });
    setConceptVocabOverride(
      mergeConceptVocab(
        conceptVocabYaml,
        classifyVocabUserRepo.listEntries(),
        classifyVocabOverrideRepo.listOverrides(),
      ),
    );
    resetClassifierCache();
    expect(getTypeSynonyms("work")).toContain("리셋분류단어");

    const app = new Hono();
    registerCleanupRoutes(app, {
      store,
      retriever,
      synonymUserRepo,
      synonymYamlDict,
      classifyVocabUserRepo,
      classifyVocabOverrideRepo,
      conceptVocabYaml,
      relationNameUserRepo,
    } as unknown as MemoryApiDeps);

    const res = await app.request("/admin/reset-memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "RESET ALL MEMORY" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: { userVocabulary: number; totalRowsDeleted: number } };
    // 동의어 1 + 분류 어휘 1 + 관계명 1 + 새 종류 1.
    expect(body.deleted.userVocabulary).toBe(4);
    expect(body.deleted.totalRowsDeleted).toBe(4);

    // DB 는 비었고 캐시·검색 사전도 기본으로 돌아왔다.
    expect(synonymUserRepo.listEntries()).toEqual([]);
    expect(synonymDictOf()?.has("리셋시험용")).toBe(false);
    expect(typeNames()).not.toContain("vehicle");
    expect(relationTagKeySet().has("리셋관계")).toBe(false);
    expect(getTypeSynonyms("work")).not.toContain("리셋분류단어");
    // 기본 사전(yaml)은 그대로 살아 있다.
    expect(synonymDictOf()?.size).toBe(synonymYamlDict.size);
    expect(typeNames()).toContain("work");
  });
});

describe("POST /admin/reset-memory — 백그라운드 작업 진행 중", () => {
  test("재임베딩 요청 전체를 초기화와 겹치지 않게 하고 실패 응답 뒤 활동을 해제한다", async () => {
    const store = new SqliteMemoryStore(db, new Bgem3Embedder());
    const vocabulary = new SynonymUserRepo(db);
    vocabulary.addEntry({ term: "재임베딩", synonym: "보존값", lang: "ko" });
    const app = new Hono();
    registerCleanupRoutes(app, { store } as unknown as MemoryApiDeps);
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      finish = () => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ confirm: "REEMBED-ALL-IMAGES" })));
        controller.close();
      };
    } });
    const request = app.request("/admin/re-embed-images", { method: "POST", body });
    const reset = () => app.request("/admin/reset-memory", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "RESET ALL MEMORY" }),
    });
    try {
      expect((await reset()).status).toBe(409);
      expect(vocabulary.listEntries()).toHaveLength(1);
    } finally {
      finish();
      // No model or asset directory configured: a real validation failure must release activity.
      expect((await request).status).toBe(503);
    }
    expect((await reset()).status).toBe(200);
  });

  test("쓰기 준비 실패도 활동을 해제하며 다른 DB의 초기화는 막지 않는다", async () => {
    const other = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writing = withMemoryWriteActivity({ db }, async () => {
      await gate;
      throw new Error("preparation failed");
    });
    try {
      expect(memoryMutationsPending({ db })).toBe(true);
      expect(memoryMutationsPending({ db: other })).toBe(false);
      release();
      await expect(writing).rejects.toThrow("preparation failed");
      expect(memoryMutationsPending({ db })).toBe(false);
      await withMemoryWriteActivity({ db }, async () => {
        await withMemoryWriteActivity({ db }, async () => {});
        expect(memoryMutationsPending({ db })).toBe(true);
      });
      expect(memoryMutationsPending({ db })).toBe(false);
    } finally {
      release();
      await writing.catch(() => {});
      other.close();
    }
  });

  test("잠금 밖에서 즉시 AI 추출 응답을 기다리는 입력이 있으면 초기화를 거절한다", async () => {
    const embedder = new Bgem3Embedder();
    const store = new SqliteMemoryStore(db, embedder);
    const vocabulary = new SynonymUserRepo(db);
    vocabulary.addEntry({ term: "AI진행중", synonym: "보존값", lang: "ko" });
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
      started();
      await gate;
      return Response.json({ model: "fixture", message: { role: "assistant", content: "[]" }, done: true });
    } });
    const extractor = new MemoryExtractor(new OllamaClient({ baseUrl: `http://127.0.0.1:${server.port}`, model: "fixture" }), store, embedder);
    const app = new Hono();
    const deps = { store, extractor } as unknown as MemoryApiDeps;
    registerCleanupRoutes(app, deps);
    registerMemoriesFromTextRoutes(app, deps);
    const saving = app.request("/memories/from-text", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "배포 창구는 금요일 오후로 정했다. 롤백 담당은 운영팀이 맡는다.", preserveRaw: false }),
    });
    const reset = () => app.request("/admin/reset-memory", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "RESET ALL MEMORY" }),
    });
    try {
      await ready;
      expect((await reset()).status).toBe(409);
      expect(vocabulary.listEntries()).toHaveLength(1);
    } finally {
      release();
      expect((await saving).status).toBe(201);
      server.stop(true);
    }
    expect((await reset()).status).toBe(200);
    expect(vocabulary.listEntries()).toEqual([]);
  });

  test("비동기 쓰기와 자동 정리가 큐에 있으면 초기화를 거절하고 완료 후에만 비운다", async () => {
    const store = new SqliteMemoryStore(db, new Bgem3Embedder());
    const vocabulary = new SynonymUserRepo(db);
    vocabulary.addEntry({ term: "동시쓰기", synonym: "기존값", lang: "ko" });
    const app = new Hono();
    registerCleanupRoutes(app, { store } as unknown as MemoryApiDeps);
    const reset = () => app.request("/admin/reset-memory", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "RESET ALL MEMORY" }),
    });
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writing = withMemoryMutationLock(store, async () => {
      started();
      await gate;
      vocabulary.addEntry({ term: "동시쓰기", synonym: "완료값", lang: "ko" });
    });
    const trigger = startAutoCleanupTrigger({ store, enabled: () => true, throttleMs: 0 });
    try {
      await ready;
      trigger.emit("external-sdk-write");
      expect((await reset()).status).toBe(409);
      expect(vocabulary.listEntries()).toHaveLength(1);
    } finally {
      release();
      await writing;
      await withMemoryMutationLock(store, async () => {});
      await trigger.stop();
    }
    expect(vocabulary.listEntries()).toHaveLength(2);
    expect((await reset()).status).toBe(200);
    expect(vocabulary.listEntries()).toEqual([]);
    expect(await store.getEvolverActivity(10)).toEqual([]);
  });

  test("결과를 쓰는 백그라운드 작업이 사이클을 돌고 있으면 409 로 물러나고 아무것도 지우지 않는다", async () => {
    const store = new SqliteMemoryStore(db, new Bgem3Embedder());
    new SynonymUserRepo(db).addEntry({ term: "진행중시험", synonym: "진행중동의어", lang: "ko" });
    // index.ts 가 얹는 것과 같은 모양: 추출 백필·이미지 분석 백필·정리 깊은 패스 중 하나라도 돌면 true.
    const running = { extractor: false, vision: false, cleanup: false };
    const app = new Hono();
    registerCleanupRoutes(app, {
      store,
      backgroundWritersRunning: () => running.extractor || running.vision || running.cleanup,
    } as unknown as MemoryApiDeps);
    const reset = () =>
      app.request("/admin/reset-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "RESET ALL MEMORY" }),
      });
    const count = () =>
      (db.query("SELECT COUNT(*) AS c FROM synonym_user_entries").get() as { c: number }).c;

    for (const writer of ["extractor", "vision", "cleanup"] as const) {
      running[writer] = true;
      const refused = await reset();
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toContain(
        "백그라운드 작업(정리·추출·이미지 분석·문서 OCR)이 진행 중",
      );
      expect(count()).toBe(1);
      running[writer] = false;
    }

    // 작업이 끝나면 같은 요청이 그대로 진행된다.
    expect((await reset()).status).toBe(200);
    expect(count()).toBe(0);
  });
});
