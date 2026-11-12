import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { CleanupProposalsRepository } from "../../db/store-internal/cleanup-proposals-repository.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { detectLensDraftCandidates } from "../../memory/cleanup-deep-pass/lens-draft-candidate-query.ts";
import type { MemoryApiDeps } from "../types.ts";
import { registerCleanupProposalsRoutes } from "./cleanup-proposals.ts";

let db: Database;
let repo: CleanupProposalsRepository;
let app: Hono;
let store: SqliteMemoryStore;
type ProposalPage = { total: number; proposals: Array<{ id: string }> };

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  // These routes read SQLite or update a date; no embedding inference is needed.
  store = new SqliteMemoryStore(db, new Bgem3Embedder());
  repo = new CleanupProposalsRepository(db);
  app = new Hono();
  registerCleanupProposalsRoutes(app, { store } as MemoryApiDeps);
});
afterEach(() => db.close());

function memo(platform: string, projectId: string | null): number {
  const row = db.query(
    "INSERT INTO knowledge_nodes (content, platform, project_id) VALUES (?, ?, ?) RETURNING id",
  ).get("프로젝트 작업 기록", platform, projectId) as { id: number };
  return row.id;
}

function proposalsFor(nodeId: number): string[] {
  return [
    repo.insert("entity_register", { nodeId, items: [] }),
    repo.insert("person_link", { nodeId, personId: "psn_example" }),
    repo.insert("metadata_fill", { nodeId, field: "event_at", value: "2026-11-13" }),
    repo.insert("regex_pattern_add", { sourceNodeId: nodeId }),
    repo.insert("lens_draft", { fingerprintGuard: { evidenceNodeIds: [nodeId] } }),
  ];
}

test("pending list and total skip AI project proposals before pagination without deleting them", async () => {
  const excluded = memo("mcp", "prj_work");
  const oldIds = proposalsFor(excluded);
  const humanProject = memo("dashboard", "prj_work");
  const personalAi = memo("mcp", null);
  const first = repo.insert("metadata_fill", { nodeId: humanProject, field: "event_at", value: "2026-11-13" });
  const second = repo.insert("metadata_fill", { nodeId: personalAi, field: "event_at", value: "2026-11-14" });

  const page1 = await (await app.request("/cleanup-proposals?limit=1")).json() as ProposalPage;
  expect(page1.total).toBe(2);
  expect(page1.proposals.map((p: { id: string }) => p.id)).toEqual([first]);
  const page2 = await (await app.request("/cleanup-proposals?limit=1&offset=1")).json() as ProposalPage;
  expect(page2.total).toBe(2);
  expect(page2.proposals.map((p: { id: string }) => p.id)).toEqual([second]);
  for (const id of oldIds) expect(repo.findById(id)?.status).toBe("pending");
  expect(db.query("SELECT content FROM knowledge_nodes WHERE id = ?").get(excluded)).toEqual({ content: "프로젝트 작업 기록" });
});

test("old direct approval links cannot apply excluded memories and detail explains the exclusion", async () => {
  const nodeId = memo("mcp", "prj_work");
  for (const id of proposalsFor(nodeId)) {
    const detail = await (await app.request(`/cleanup-proposals/${id}`)).json() as { cleanupExcluded?: boolean };
    expect(detail.cleanupExcluded).toBe(true);
    const response = await app.request(`/cleanup-proposals/${id}/approve`, { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("정리 대상에서 제외");
    expect(repo.findById(id)?.status).toBe("pending");
    expect(repo.listJournal(id)).toEqual([]);
  }
  expect(db.query("SELECT event_at FROM knowledge_nodes WHERE id = ?").get(nodeId)).toEqual({ event_at: null });
});

test("human project and personal AI proposals can still be approved", async () => {
  for (const nodeId of [memo("dashboard", "prj_work"), memo("mcp", null)]) {
    const id = repo.insert("metadata_fill", { nodeId, field: "event_at", value: "2026-11-13" });
    const response = await app.request(`/cleanup-proposals/${id}/approve`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(db.query("SELECT event_at FROM knowledge_nodes WHERE id = ?").get(nodeId)).toEqual({ event_at: "2026-11-13" });
  }
});

test("a mixed-evidence old lens draft is withheld while history and unrelated proposals remain available", async () => {
  const excluded = memo("mcp", "prj_work");
  const personal = memo("dashboard", null);
  const stale = repo.insert("lens_draft", { fingerprintGuard: { evidenceNodeIds: [personal, excluded] } });
  const eligible = repo.insert("lens_draft", { fingerprintGuard: { evidenceNodeIds: [personal] } });
  const unknown = repo.insert("future_kind", { nodeId: excluded });
  expect(repo.findPending(10).map((p) => p.id)).toEqual([eligible, unknown]);
  expect((await app.request(`/cleanup-proposals/${stale}`)).status).toBe(200);
});

test("a malformed historical lens draft does not stop other lens candidates", async () => {
  db.run("INSERT INTO cleanup_proposals (id, kind, payload_json) VALUES ('cp_broken', 'lens_draft', '{')");
  db.run("INSERT INTO entities (entity_id, type_name, name) VALUES ('plc_normal', 'place', '강남역')");
  const candidates = await detectLensDraftCandidates({ deps: { store }, batchSize: 10, stageVersion: 1 });
  expect(candidates.map((c) => c.entityId)).toContain("plc_normal");
});
