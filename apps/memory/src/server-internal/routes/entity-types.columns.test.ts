/**
 * entity-types.columns.test.ts — GET /api/entity-types 응답 columns 메타 검증 (단계6 T2).
 *
 * 검증 가족:
 *   (a) 코드 종류(intake) 에 columnLabels 키가 columns 로 내려온다.
 *   (b) 칸 없는 코드 종류(creature·work·project) 는 columns: [].
 *   (c) 새 종류(DB·user) 에 columns slot 값이 오고, slot 0개면 [].
 *   (d) 기존 응답 칸(typeName·koName·idPrefix·source) 이 불변이다.
 *   (e) EntityTypeListing 모양 — columns 가 Array<{ key, label }> 이다.
 *
 * 실 SqliteMemoryStore(:memory:) + 실 buildMemoryApi. Mock 0.
 * entity-types.test.ts 의 harness 양식을 그대로 재사용한다.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import {
  setEntityTypeOverride,
  resetConceptTypeVocabularyCache,
} from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

afterEach(() => {
  setEntityTypeOverride([]);
  resetConceptTypeVocabularyCache();
  resetClassifierCache();
});

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

  setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
  resetConceptTypeVocabularyCache();
  resetClassifierCache();

  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

describe("GET /api/entity-types columns 메타", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  test("intake 에 columnLabels 키가 columns 로 온다", async () => {
    const res = await h.app.request("/api/entity-types");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entityTypes: Array<{ typeName: string; columns: Array<{ key: string; label: string; dataType: "text" | "number" | "date" }> }>;
    };
    const intake = body.entityTypes.find((t) => t.typeName === "intake");
    expect(intake).toBeDefined();
    // intake 의 columnLabels = { 유통기한: "expiresAt" } — 칸 키 '유통기한' 이 온다.
    expect(intake!.columns).toContainEqual({ key: "유통기한", label: "유통기한", dataType: "date" });
  });

  test("칸 없는 코드 종류(creature·work) 는 columns: []", async () => {
    const res = await h.app.request("/api/entity-types");
    const body = (await res.json()) as {
      entityTypes: Array<{ typeName: string; columns: Array<{ key: string; label: string; dataType: "text" | "number" | "date" }> }>;
    };
    for (const typeName of ["creature", "work"]) {
      const row = body.entityTypes.find((t) => t.typeName === typeName);
      expect(row).toBeDefined();
      expect(row!.columns).toEqual([]);
    }
  });

  test("person 은 생일 날짜 칸을, project 는 columns: [] 를 내려준다", async () => {
    const res = await h.app.request("/api/entity-types");
    const body = (await res.json()) as {
      entityTypes: Array<{ typeName: string; columns: Array<{ key: string; label: string; dataType: "text" | "number" | "date" }> }>;
    };
    const person = body.entityTypes.find((t) => t.typeName === "person");
    expect(person).toBeDefined();
    expect(person!.columns).toEqual([{ key: "생일", label: "생일", dataType: "date" }]);

    const project = body.entityTypes.find((t) => t.typeName === "project");
    expect(project).toBeDefined();
    expect(project!.columns).toEqual([]);
  });

  test("usable 에 사용법 칸이 온다", async () => {
    const res = await h.app.request("/api/entity-types");
    const body = (await res.json()) as {
      entityTypes: Array<{ typeName: string; columns: Array<{ key: string; label: string; dataType: "text" | "number" | "date" }> }>;
    };
    const usable = body.entityTypes.find((t) => t.typeName === "usable");
    expect(usable).toBeDefined();
    // 단계6b — 코드 8종 칸은 전부 글자형이라 dataType:"text".
    expect(usable!.columns).toEqual([{ key: "사용법", label: "사용법", dataType: "text" }]);
  });

  test("material 에 주제 칸이 온다", async () => {
    const res = await h.app.request("/api/entity-types");
    const body = (await res.json()) as {
      entityTypes: Array<{ typeName: string; columns: Array<{ key: string; label: string; dataType: "text" | "number" | "date" }> }>;
    };
    const material = body.entityTypes.find((t) => t.typeName === "material");
    expect(material).toBeDefined();
    expect(material!.columns).toEqual([{ key: "주제", label: "주제", dataType: "text" }]);
  });

  test("새 종류(DB user) — columns slot 0개면 columns: []", async () => {
    // 새 종류 추가 — concept-type-vocabulary yaml 칸 slot 없으면 빈 배열.
    await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", koName: "장비", idPrefix: "eqp_" }),
    });

    const res = await h.app.request("/api/entity-types");
    const body = (await res.json()) as {
      entityTypes: Array<{ typeName: string; columns: Array<{ key: string; label: string; dataType: "text" | "number" | "date" }> }>;
    };
    const equipment = body.entityTypes.find((t) => t.typeName === "equipment");
    expect(equipment).toBeDefined();
    // 새 종류는 yaml slot 없으면 정직한 빈 배열(가짜 칸 0개 금지).
    expect(equipment!.columns).toEqual([]);
  });

  test("기존 응답 칸(typeName·koName·idPrefix·source) 불변", async () => {
    const res = await h.app.request("/api/entity-types");
    const body = (await res.json()) as {
      entityTypes: Array<{
        typeName: string;
        koName: string;
        idPrefix: string | null;
        source: string;
        columns: Array<{ key: string; label: string; dataType: "text" | "number" | "date" }>;
      }>;
    };
    const work = body.entityTypes.find((t) => t.typeName === "work");
    expect(work).toBeDefined();
    expect(work!.koName).toBe("작품");
    expect(work!.idPrefix).toBeNull();
    expect(work!.source).toBe("code");
    // columns 필드도 존재한다.
    expect(Array.isArray(work!.columns)).toBe(true);
  });
});
