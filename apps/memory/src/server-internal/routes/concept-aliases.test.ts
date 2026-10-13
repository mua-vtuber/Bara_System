/**
 * server-internal/routes/concept-aliases.test.ts — D2 별칭 후보 게이트 API 통합 검증
 * (Phase 6b T10 / 사용자 결정 1 = 대시보드 게이트).
 *
 * 검증 가족:
 *   (a) GET /api/concept-aliases?status=pending — 임계 이상 후보 목록. 두 개념 이름
 *       (new_concept name + candidate name) + cosine 노출. 후보 0 = 빈 목록(정직).
 *   (b) POST /api/concept-aliases/:id/resolve { action: 'merged' } — 합류 실행 +
 *       방금 만든 개념(new)이 흡수되어 사라지고 기존 개념(candidate) 보존 + pending 0.
 *   (c) POST .../resolve { action: 'rejected' } — 합류 없이 status 만 rejected,
 *       두 개념 모두 보존.
 *   (d) 잘못된 action → 400(구체 에러). 없는 id → 404. 미존재 store 메서드 silent
 *       fallback 없음.
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 SqliteMemoryStore.
 * mock 객체 없음(CLAUDE.md "테스트 정책"). findOrCreateTagConcept 두 번 호출로
 * 임계(CONCEPT_ALIAS_THRESHOLD) 이상 후보가 자연 발생한다 — 자동차/automobile
 * 0.8774 (2026-07-10 실 bge-m3 측정, concept-repository.test.ts 선례 정합).
 *
 * 핵심: GET 은 부수효과 0(합류 트리거 안 함). 합류는 POST resolve(merged) 한 통로뿐.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { CONCEPT_ALIAS_THRESHOLD } from "../../memory/concept-alias-detect.ts";
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
  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

/**
 * 임계 이상 별칭 후보 한 건을 자연 발생시킨다 — 기존 개념(자동차) + 의미가 가까운
 * 신규 개념(automobile, cosine 0.8774 — 2026-07-10 실 bge-m3 측정)을 만들면 D2
 * 검출이 concept_alias_suggestions 에 pending 적재한다.
 * 반환: { candidateId(=기존 자동차), newId(=신규 automobile) }.
 */
async function seedSuggestion(
  store: SqliteMemoryStore,
): Promise<{ candidateId: string; newId: string }> {
  const candidateId = await store.findOrCreateTagConcept("자동차");
  const newId = await store.findOrCreateTagConcept("automobile");
  return { candidateId, newId };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});

describe("GET /api/concept-aliases — 후보 목록 + 두 개념 이름 + cosine", () => {
  test("후보 0건이면 빈 목록(정직한 빈 게이트 — 가짜 후보 0)", async () => {
    const res = await harness.app.request("/api/concept-aliases?status=pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: unknown[] };
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates.length).toBe(0);
  });

  test("임계 이상 후보를 두 개념 이름 + cosine 과 함께 반환", async () => {
    await seedSuggestion(harness.store);
    const res = await harness.app.request("/api/concept-aliases?status=pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: {
        suggestion_id: string;
        new_concept_id: string;
        new_concept_name: string;
        candidate_concept_id: string;
        candidate_concept_name: string;
        cosine: number;
        status: string;
      }[];
    };
    expect(body.candidates.length).toBe(1);
    const c = body.candidates[0]!;
    expect(c.status).toBe("pending");
    // 두 개념 이름이 사람이 읽을 수 있는 형태로 노출 — id 만이 아니라.
    expect(c.new_concept_name).toBe("automobile");
    expect(c.candidate_concept_name).toBe("자동차");
    expect(c.cosine).toBeGreaterThanOrEqual(CONCEPT_ALIAS_THRESHOLD);
    expect(c.suggestion_id.length).toBeGreaterThan(0);
  });

  test("GET 은 부수효과 0 — 합류 트리거 안 함(두 개념 모두 보존)", async () => {
    const { candidateId, newId } = await seedSuggestion(harness.store);
    await harness.app.request("/api/concept-aliases?status=pending");
    // GET 후에도 두 개념 모두 살아 있어야 한다(GET 이 merge 를 부르면 안 됨).
    expect(await harness.store.getConcept(candidateId)).not.toBeNull();
    expect(await harness.store.getConcept(newId)).not.toBeNull();
  });
});

describe("POST /api/concept-aliases/:id/resolve — 합치기/거절", () => {
  test("merged → 신규 개념 흡수 + 기존 개념 보존 + pending 0", async () => {
    const { candidateId, newId } = await seedSuggestion(harness.store);
    const sug = (await harness.store.listAliasSuggestions("pending"))[0]!;

    const res = await harness.app.request(
      `/api/concept-aliases/${sug.suggestionId}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "merged" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolved: string; action: string };
    expect(body.action).toBe("merged");

    // candidate(자동차) 보존, new(automobile) 흡수되어 사라짐.
    expect(await harness.store.getConcept(candidateId)).not.toBeNull();
    expect(await harness.store.getConcept(newId)).toBeNull();
    const target = await harness.store.getConcept(candidateId);
    expect(target!.enAliases).toContain("automobile");
    // pending 후보가 사라짐.
    expect((await harness.store.listAliasSuggestions("pending")).length).toBe(0);
  });

  test("rejected → 합류 없이 status 만 rejected + 두 개념 보존", async () => {
    const { candidateId, newId } = await seedSuggestion(harness.store);
    const sug = (await harness.store.listAliasSuggestions("pending"))[0]!;

    const res = await harness.app.request(
      `/api/concept-aliases/${sug.suggestionId}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rejected" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("rejected");

    // 합류 안 함 — 두 개념 모두 보존.
    expect(await harness.store.getConcept(candidateId)).not.toBeNull();
    expect(await harness.store.getConcept(newId)).not.toBeNull();
    const rejected = await harness.store.listAliasSuggestions("rejected");
    expect(rejected.length).toBe(1);
    expect((await harness.store.listAliasSuggestions("pending")).length).toBe(0);
  });

  test("잘못된 action → 400(구체 에러)", async () => {
    await seedSuggestion(harness.store);
    const sug = (await harness.store.listAliasSuggestions("pending"))[0]!;
    const res = await harness.app.request(
      `/api/concept-aliases/${sug.suggestionId}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "frobnicate" }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("action");
  });

  test("action 누락 → 400", async () => {
    await seedSuggestion(harness.store);
    const sug = (await harness.store.listAliasSuggestions("pending"))[0]!;
    const res = await harness.app.request(
      `/api/concept-aliases/${sug.suggestionId}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
  });

  test("없는 suggestion id → 404(silent fallback 금지 — 구체 에러)", async () => {
    const res = await harness.app.request(
      "/api/concept-aliases/casug_nope/resolve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "merged" }),
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("casug_nope");
  });
});
