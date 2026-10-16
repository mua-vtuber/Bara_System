import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../db/migrations.ts";
import { recordStageSuccess, recordStageTerminal } from "../stage-results-ledger.ts";
import { collectEntityRegisterCandidates, listAlreadyLinkedNames, readMemoEventAt } from "./candidate-query.ts";

let db: Database;
beforeEach(() => { db = openMemoryDatabase(":memory:", { embeddingDim: 8 }); });
afterEach(() => db.close());

function memo(content: string, opts: { sourceType?: string; metadata?: Record<string, unknown>; rawMetadata?: string; createdAt?: string } = {}): number {
  const at = opts.createdAt ?? "2026-10-10 09:00:00";
  db.run(
    "INSERT INTO knowledge_nodes (content, source_type, metadata_json, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)",
    [content, opts.sourceType ?? "auto_capture", opts.rawMetadata ?? JSON.stringify(opts.metadata ?? {}), at, at],
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

test("only the user's original memos are candidates", () => {
  const original = memo("민수가 11월 3일 결혼한다더라");
  memo("민수 결혼", { sourceType: "llm_extract" });
  memo("조각", { sourceType: "document_chunk" });
  memo("정규식 조각", { metadata: { source: "regex" } });
  memo("민수 결혼", { metadata: { scheduleOccurrence: true } });
  memo("   ");
  const rows = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 50 });
  expect(rows.map((r) => r.nodeId)).toEqual([original]);
  expect(rows[0]!.createdAt).toBe("2026-10-10 09:00:00");
});

test("a metadata column that is not an object stops with the node id", () => {
  const id = memo("메모", { rawMetadata: "[]" });
  expect(() => collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 50 })).toThrow(`id=${id}`);
  db.run("UPDATE knowledge_nodes SET metadata_json = 'null' WHERE id = ?", [id]);
  expect(() => collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 50 })).toThrow(`id=${id}`);
});

test("processed memos are skipped until their content changes or the stage version rises", () => {
  const id = memo("금목서를 키우고 있다");
  const [row] = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 50 });
  recordStageSuccess(db, { stage: "entity_register", targetKey: row!.targetKey, inputFingerprint: row!.inputFingerprint, stageVersion: 1, noop: true });
  expect(collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 50 })).toEqual([]);
  expect(collectEntityRegisterCandidates({ db, stageVersion: 2, limit: 50 }).map((r) => r.nodeId)).toEqual([id]);
  db.run("UPDATE knowledge_nodes SET content = '금목서와 은목서를 키운다' WHERE id = ?", [id]);
  expect(collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 50 }).map((r) => r.nodeId)).toEqual([id]);
});

test("a terminal memo is not retried while unchanged", () => {
  memo("x 메모");
  const [row] = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 50 });
  recordStageTerminal(db, { stage: "entity_register", targetKey: row!.targetKey, inputFingerprint: row!.inputFingerprint, stageVersion: 1, lastError: "형식 오류 3회" });
  expect(collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 50 })).toEqual([]);
});

test("the scan pages past already processed memos to fill the limit", () => {
  const ids: number[] = [];
  for (let i = 0; i < 12; i++) ids.push(memo(`메모 ${i}`));
  for (const row of collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 })) {
    recordStageSuccess(db, { stage: "entity_register", targetKey: row.targetKey, inputFingerprint: row.inputFingerprint, stageVersion: 1, noop: true });
  }
  expect(collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 }).map((r) => r.nodeId)).toEqual(ids.slice(10));
});

test("readMemoEventAt reads the column itself, even without a field source", () => {
  const empty = memo("1월 5일까지 제출");
  const legacy = memo("옛 메모");
  db.run("UPDATE knowledge_nodes SET event_at = '2026-01-05' WHERE id = ?", [legacy]);
  expect(readMemoEventAt(db, empty)).toEqual({ found: true, eventAt: null, source: null });
  expect(readMemoEventAt(db, legacy)).toEqual({ found: true, eventAt: "2026-01-05", source: null });
  expect(readMemoEventAt(db, 999_999)).toEqual({ found: false });
});

test("nodeIds limits the candidates to those memos", () => {
  memo("a 메모");
  const b = memo("b 메모");
  expect(collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 50, nodeIds: [b] }).map((r) => r.nodeId)).toEqual([b]);
});

test("already linked names cover mentioned people, tag concepts and identity entities", () => {
  const id = memo("#피부과:무지개의원 민수랑 갔다");
  db.run(`INSERT INTO persons (person_id, display_name, aliases, external_refs) VALUES ('psn_1', '민수', '["민수"]', '{}')`);
  db.run("INSERT INTO node_person_edges (node_id, person_id, relation, provenance) VALUES (?, 'psn_1', 'mentions', 'hashtag')", [id]);
  db.run("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_1', '피부과')");
  db.run("INSERT INTO node_concept_edges (node_id, concept_id, role, provenance) VALUES (?, 'cpt_1', 'tag', 'hashtag')", [id]);
  db.run("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_2', '무지개의원')");
  db.run("INSERT INTO node_concept_edges (node_id, concept_id, role, provenance) VALUES (?, 'cpt_2', 'classification', 'hashtag')", [id]);
  db.run("INSERT INTO entities (entity_id, type_name, name) VALUES ('plc_1', 'place', '무지개의원')");
  db.run("INSERT INTO entity_concept_edges (entity_id, concept_id, role, provenance) VALUES ('plc_1', 'cpt_2', 'identity', 'hashtag')");
  expect(listAlreadyLinkedNames(db, id).sort()).toEqual(["무지개의원", "민수", "피부과"]);
});
