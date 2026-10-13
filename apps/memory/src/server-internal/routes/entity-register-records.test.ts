/**
 * routes/entity-register-records.test.ts — "최근 자동 등록" 목록·되돌리기 API(spec 7.3).
 *
 * 실 SQLite(:memory:) + 실 저장소 + 실 Hono 앱. 라우트는 registerCleanupRunsRoutes 를 거쳐 등록한다 —
 * 정리 스케줄러가 꺼져 있어도(deps.cleanupRuns 없음) 지난 기록을 보고 되돌릴 수 있어야 하기 때문이다.
 * 모델은 부르지 않는다(기록·행을 SQL 로 직접 준비) — 저장소에는 실제 임베더 구현을 싣지 않고 넣는다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { CleanupRunsLedger } from "../../memory/cleanup-deep-pass/cleanup-runs-ledger.ts";
import { ENTITY_REGISTER_LIMITS } from "../../memory/cleanup-deep-pass/entity-register/constants.ts";
import {
  emptyRecordDetail, EntityRegisterRecordsRepository,
} from "../../memory/cleanup-deep-pass/entity-register/records-repository.ts";
import type { MemoryApiDeps } from "../types.ts";
import { registerCleanupRunsRoutes, type CleanupRunsRouteDeps } from "./cleanup-runs.ts";
import type { RecentAutoRegisterItem } from "./entity-register-records.ts";

let db: Database;
let deps: MemoryApiDeps;
let records: EntityRegisterRecordsRepository;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const embedder = new Bgem3Embedder();
  const store = new SqliteMemoryStore(db, embedder);
  deps = { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() };
  records = new EntityRegisterRecordsRepository(db);
});
afterEach(() => db.close());

/** 스케줄러 꺼짐(deps.cleanupRuns 없음) 배선의 앱. */
function appWithSchedulerOff(): Hono {
  const app = new Hono();
  registerCleanupRunsRoutes(app, deps);
  return app;
}

function insertMemo(content: string): number {
  return Number(db.query("INSERT INTO knowledge_nodes (content, memory_type, created_at) VALUES (?, 'note', '2026-10-10 09:00:00')").run(content).lastInsertRowid);
}

function insertPerson(personId: string, name: string): void {
  db.query("INSERT INTO persons (person_id, display_name, aliases) VALUES (?, ?, '[]')").run(personId, name);
}

/** 메모 하나와 그 메모에서 자동으로 만든 사람 행·연결·기록. */
function seedAutoPerson(personId: string, name: string, memoContent: string): { memoId: number; recordId: number } {
  const memoId = insertMemo(memoContent);
  insertPerson(personId, name);
  db.query("INSERT INTO node_person_edges (node_id, person_id, relation, provenance, source_node_id) VALUES (?, ?, 'mentions', 'llm_extract', ?)")
    .run(memoId, personId, memoId);
  const recordId = records.insert({
    runId: "run_1", proposalId: null, sourceNodeId: memoId, itemKind: "entity_created", targetType: "person", targetId: personId,
    name, decidedBy: "auto",
    detail: {
      ...emptyRecordDetail(),
      createdRow: { typeName: "person", id: personId },
      edges: [{ table: "node_person_edges", nodeId: memoId, personId, relation: "mentions" }],
    },
  });
  return { memoId, recordId };
}

async function getList(app: Hono, query = ""): Promise<Response> {
  return app.request(`/api/entity-register/records${query}`);
}

describe("GET /api/entity-register/records", () => {
  test("returns an empty page when nothing was auto-registered", async () => {
    const res = await getList(appWithSchedulerOff());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ records: [], total: 0 });
  });

  test("lists auto records with their memo, and shows a purged memo as memoContent null instead of hiding it", async () => {
    const kept = seedAutoPerson("psn_a", "민수", "민수가 왔다");
    const purged = seedAutoPerson("psn_b", "지은", "지은이랑 밥");
    db.query("DELETE FROM knowledge_nodes WHERE id = ?").run(purged.memoId);
    records.insert({
      runId: null, proposalId: "prop_1", sourceNodeId: kept.memoId, itemKind: "entity_linked", targetType: "person", targetId: "psn_a",
      name: "민수", decidedBy: "approved", detail: emptyRecordDetail(),
    });
    const res = await getList(appWithSchedulerOff());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: RecentAutoRegisterItem[]; total: number };
    expect(body.total).toBe(2);
    const byId = new Map(body.records.map((r) => [r.id, r]));
    expect(byId.get(kept.recordId)).toMatchObject({
      itemKind: "entity_created", targetType: "person", targetId: "psn_a", name: "민수", sourceNodeId: kept.memoId,
      memoContent: "민수가 왔다", date: null, runId: "run_1",
    });
    expect(byId.get(purged.recordId)).toMatchObject({ name: "지은", sourceNodeId: purged.memoId, memoContent: null });
  });

  test("omitting limit uses the server default and a too-large limit is cut to the maximum", async () => {
    const memoId = insertMemo("많은 기록");
    const total = ENTITY_REGISTER_LIMITS.recentListMaxLimit + 1;
    for (let i = 0; i < total; i++) {
      records.insert({
        runId: "run_1", proposalId: null, sourceNodeId: memoId, itemKind: "entity_linked", targetType: "person", targetId: `psn_${i}`,
        name: `이름${i}`, decidedBy: "auto", detail: emptyRecordDetail(),
      });
    }
    const app = appWithSchedulerOff();
    const byDefault = (await (await getList(app)).json()) as { records: unknown[]; total: number };
    expect(byDefault.records.length).toBe(ENTITY_REGISTER_LIMITS.recentListDefaultLimit);
    expect(byDefault.total).toBe(total);
    const capped = (await (await getList(app, "?limit=1000")).json()) as { records: unknown[] };
    expect(capped.records.length).toBe(ENTITY_REGISTER_LIMITS.recentListMaxLimit);
    const paged = (await (await getList(app, `?limit=5&offset=${total - 2}`)).json()) as { records: unknown[] };
    expect(paged.records.length).toBe(2);
  });

  test("rejects negative, zero and non-integer paging values with 400", async () => {
    const app = appWithSchedulerOff();
    for (const q of ["?limit=-1", "?limit=0", "?limit=abc", "?limit=1.5", "?offset=-1", "?offset=x"]) {
      expect((await getList(app, q)).status).toBe(400);
    }
  });

  test("is also registered when the cleanup scheduler is wired", async () => {
    const app = new Hono();
    const routeDeps: CleanupRunsRouteDeps = {
      ledger: new CleanupRunsLedger(db),
      gateReasons: () => [],
      triggerRun: () => "started",
      registerCancel: () => new AbortController().signal,
      cancelRun: () => false,
      isRunning: () => false,
    };
    registerCleanupRunsRoutes(app, { ...deps, cleanupRuns: routeDeps });
    expect((await getList(app)).status).toBe(200);
  });
});

describe("POST /api/entity-register/records/:id/revert", () => {
  test("reverts a record with the scheduler off and drops it from the list", async () => {
    const app = appWithSchedulerOff();
    const { memoId, recordId } = seedAutoPerson("psn_a", "민수", "민수가 왔다");
    const res = await app.request(`/api/entity-register/records/${recordId}/revert`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reverted: recordId,
      result: { recordId, removedEdges: 1, deletedRow: { typeName: "person", id: "psn_a" }, keptRowReason: null, removedAlias: null, trashedScheduleNodeId: null },
    });
    expect(db.query("SELECT COUNT(*) AS n FROM persons WHERE person_id = 'psn_a'").get()).toEqual({ n: 0 });
    expect([...records.ignoredNameKeys(memoId)]).toEqual(["민수"]);
    expect(await (await getList(app)).json()).toEqual({ records: [], total: 0 });
  });

  test("an unknown id is 404 and a second revert is 409", async () => {
    const app = appWithSchedulerOff();
    expect((await app.request("/api/entity-register/records/999/revert", { method: "POST" })).status).toBe(404);
    const { recordId } = seedAutoPerson("psn_a", "민수", "민수가 왔다");
    expect((await app.request(`/api/entity-register/records/${recordId}/revert`, { method: "POST" })).status).toBe(200);
    const again = await app.request(`/api/entity-register/records/${recordId}/revert`, { method: "POST" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain("이미 되돌림");
  });

  test("a malformed id is 400", async () => {
    const app = appWithSchedulerOff();
    for (const id of ["0", "-3", "abc", "1.5"]) {
      expect((await app.request(`/api/entity-register/records/${id}/revert`, { method: "POST" })).status).toBe(400);
    }
  });
});
