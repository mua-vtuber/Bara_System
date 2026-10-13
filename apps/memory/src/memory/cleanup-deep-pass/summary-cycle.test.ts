/**
 * summary-cycle.test.ts — 요약 단계 한 사이클 글루 통합 검증 (Task 6 → Task 14 개념 발굴 정정).
 *
 * 권위 spec: docs/decisions/2026-06-05-phase7-summary-stage-spec.md 단락 3.2·3.3·4.2·4.5·4.6
 * 권위 plan: docs/decisions/2026-06-05-phase7-summary-stage-plan.md Task 6·Task 14
 *
 * 실 :memory: SQLite(실 기준 스키마 · sqlite-vec 로드) + 실 bge-m3
 * embedder + 실 EventBus 로 돈다 — mock 객체 0. infer 는 *함수 주입*(데이터 fixture 응답
 * 함수)이라 인터페이스 가짜 구현체가 아니다(CLAUDE.md mock 금지 정합). document_chunk
 * 노드·merged_into llm_extract 자식·documents 행은 raw SQL 로 직접 삽입한다(데이터 fixture).
 *
 * Task 14 정정 — 관계 발굴이 *개념 쌍* 으로 닫힌다. fixture 는 atomic 자식에
 * node_concept_edges(cpt_)·node_person_edges(psn_)를 달아 그 문서의 허용 개념 집합을
 * 만들고, infer 응답은 from_concept_id·to_concept_id(개념 id TEXT)를 회신한다. 검증은
 * relation_summaries(개념 id·source_document_id) + concept_edges(llm_relation) 기준.
 *
 * 검증 케이스:
 *   (a) infer fixture 가 청크요약 2 + 관계요약 2(개념 쌍, 하나 confidence 0.9·하나 0.4)
 *       → chunk_summaries 2행(generated_by='llm') + relation_summaries 2행(개념 id·
 *       source_document_id 동반) + concept_edges llm_relation 엣지 1개(0.9 만) + 요약 vec
 *       행 + has_embedding=1 + 정보성 emit.
 *   (b) infer=null → chunk_summaries 첫 문단 fallback 행(generated_by='first_paragraph_fallback')
 *       + 임베딩 / 관계요약 0 + 엣지 0 + emit 0.
 *   (c) from_concept_id 환각 → 그 관계 버림 + warn(rejectedHallucinations++) / 정상 관계는 살아남음.
 *   (d) LLM throw → 그 문서 건너뜀 + warn(inferFailures++) — 사이클 중단 0.
 *   (e) 멱등 — 같은 사이클 두 번 돌려도 재처리 0(청크요약 + source_document_id 관계 멱등).
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { EventBus } from "../../server-internal/event-bus.ts";
import { EventRepository } from "../../db/store-internal/event-repository.ts";
import { runSummaryCycle, type SummaryCycleDeps } from "./summary-cycle.ts";
import type { SummaryInferFn } from "./summary-gates.ts";
import type { StageInferResult } from "./stage-execution.ts";
import { getStageResult } from "./stage-results-ledger.ts";

/** 요약 raw 응답을 ok StageInferResult 로 감싸는 fixture 헬퍼(실행층 경유 계약). */
function ok(json: string): StageInferResult<string> {
  return { kind: "ok", parsed: json };
}

const MODEL_LOAD_TIMEOUT_MS = 180_000;

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
}, MODEL_LOAD_TIMEOUT_MS);

afterAll(() => {
  // embedder 는 프로세스 단위 — 별도 해제 없음.
});

/** 실 기준 스키마 + 실 embedder 로 store + raw db + eventBus 한 묶음. */
function makeFixture(): {
  db: Database;
  store: SqliteMemoryStore;
  eventBus: EventBus;
} {
  // bge-m3 1024 차원에 맞춘 vec0(요약 임베딩 테이블).
  // 가 깔려 임베딩 INSERT 가 차원 불일치로 throw 한다.
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const eventBus = new EventBus(new EventRepository(db));
  return { db, store, eventBus };
}

/** documents 행 한 개 삽입(FK 사슬 asset_files → documents). */
function insertDocument(db: Database, docId: string): void {
  const sha = `sha_${docId}`;
  db.prepare(
    `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at)
     VALUES (?, 'text', ?, 10, 0)`,
  ).run(sha, `/tmp/${sha}.md`);
  db.prepare(
    `INSERT INTO documents (document_id, asset_sha256, title, document_type, chunk_count, created_at, updated_at)
     VALUES (?, ?, ?, 'text', 0, 0, 0)`,
  ).run(docId, sha, `doc ${docId}`);
}

/** document_chunk 노드 한 개 삽입(metadata.parentId + chunkIndex). */
function insertChunk(
  db: Database,
  content: string,
  parentDocId: string,
  chunkIndex: number,
  createdAt = "2026-06-05 10:00:00",
): number {
  const meta = JSON.stringify({ parentId: parentDocId, chunkIndex });
  const info = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, metadata_json, created_at) VALUES (?, 'document_chunk', ?, ?)",
    )
    .run(content, meta, createdAt);
  return Number(info.lastInsertRowid);
}

/**
 * 청크에 atomic 자식 N건 + merged_into 엣지(child→chunk) 삽입(임계 충족). 회신은 만든
 * atomic 노드 id 목록 — 호출자가 이 atomic 에 개념·사람 엣지를 달아 허용 개념 집합을
 * 만든다(extractor 가 atomic 에 개념을 붙이는 실 흐름 정합).
 */
function attachAtomics(db: Database, chunkId: number, count: number): number[] {
  const atomicIds: number[] = [];
  for (let i = 0; i < count; i++) {
    const info = db
      .prepare(
        "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'llm_extract', '2026-06-05 10:00:01')",
      )
      .run(`atomic-${chunkId}-${i}`);
    const atomicId = Number(info.lastInsertRowid);
    db.prepare(
      "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (?, ?, 'merged_into', 'user_input', NULL)",
    ).run(atomicId, chunkId);
    atomicIds.push(atomicId);
  }
  return atomicIds;
}

/** 개념 노드(cpt_) 한 개 삽입 후 그 concept_id 회신. */
function insertConcept(db: Database, conceptId: string, name: string): string {
  db.prepare(
    "INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)",
  ).run(conceptId, name);
  return conceptId;
}

/** atomic 노드 → 개념(node_concept_edges, role='mention'). */
function linkConcept(db: Database, atomicId: number, conceptId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, 'mention', 'user_input', NULL)",
  ).run(atomicId, conceptId);
}

/** 사람 노드(psn_) 한 개 삽입 후 person_id 회신. */
function insertPerson(db: Database, personId: string, displayName: string): string {
  db.prepare(
    "INSERT INTO persons (person_id, display_name) VALUES (?, ?)",
  ).run(personId, displayName);
  return personId;
}

/** atomic 노드 → 사람(node_person_edges, relation='mentions'). collectDocumentConcepts 의
 *  node_person_edges UNION 갈래로 그 문서 허용 개념 집합에 psn_ 가 들어간다. */
function linkPerson(db: Database, atomicId: number, personId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO node_person_edges (node_id, person_id, relation, provenance, source_node_id) VALUES (?, ?, 'mentions', 'user_input', NULL)",
  ).run(atomicId, personId);
}

/** atomicThreshold=4·batchSize=50·임계 0.6·firstParagraphMaxChars=300 기본 deps. */
function baseDeps(
  fx: ReturnType<typeof makeFixture>,
  infer: SummaryInferFn | null,
): SummaryCycleDeps {
  return {
    db: fx.db,
    store: fx.store,
    embedder,
    infer,
    eventBus: fx.eventBus,
    atomicThreshold: 4,
    batchSize: 50,
    relationConfidenceThreshold: 0.6,
    firstParagraphMaxChars: 300,
    stageVersion: 1,
    maxAttemptsPerTarget: 3,
  };
}

describe("runSummaryCycle — infer 가용(통합 호출 → 게이트 → 저장·임베딩·개념 엣지)", () => {
  it(
    "청크요약 2 + 관계요약 2(개념 쌍 0.9·0.4) → chunk 2·relation 2·concept_edges 1·vec·emit",
    async () => {
      const fx = makeFixture();
      insertDocument(fx.db, "doc-a");
      const a0 = insertChunk(fx.db, "주인공 A 와 B 의 첫 만남", "doc-a", 0, "2026-06-05 10:00:00");
      const a0Atomics = attachAtomics(fx.db, a0, 4);
      const a1 = insertChunk(fx.db, "A 와 B 가 라이벌이 되는 사건", "doc-a", 1, "2026-06-05 10:01:00");
      const a1Atomics = attachAtomics(fx.db, a1, 4);

      // 이 문서의 허용 개념 집합 — 개념 cptA + cptB(둘 다 concept_nodes). Task 18 이
      // concept_edges 양 끝 FK 를 제거해 엣지 끝은 cpt_·psn_ 어느 쪽이든 받는다(사람 끝
      // 케이스는 아래 별 it 에서 검증). 여기서는 개념↔개념 기본 흐름을 확인한다. atomic 에 단다.
      const cptA = insertConcept(fx.db, "cpt_A", "인물A");
      const cptB = insertConcept(fx.db, "cpt_B", "인물B");
      linkConcept(fx.db, a0Atomics[0]!, cptA);
      linkConcept(fx.db, a1Atomics[0]!, cptB);

      // 통합 응답 fixture — chunk_id 는 *실재* 청크 노드 id / from·to 는 *실재* 개념 id(환각 0).
      const infer: SummaryInferFn = async () =>
        ok(JSON.stringify({
          chunkSummaries: [
            { chunk_id: a0, summary_text: "A 와 B 가 처음 만난다.", confidence: 0.9 },
            { chunk_id: a1, summary_text: "A 와 B 가 라이벌이 된다.", confidence: 0.8 },
          ],
          relationSummaries: [
            {
              from_concept_id: cptA,
              to_concept_id: cptB,
              relation_name: "라이벌",
              summary_text: "A 와 B 는 라이벌 관계다.",
              confidence: 0.9,
            },
            {
              from_concept_id: cptB,
              to_concept_id: cptA,
              relation_name: "동료",
              summary_text: "A 와 B 는 한때 동료였다.",
              confidence: 0.4,
            },
          ],
        }));

      const emitSpy = spyOn(fx.eventBus, "emit");
      const summary = await runSummaryCycle(baseDeps(fx, infer));

      expect(summary.chunkSummariesCreated).toBe(2);
      expect(summary.relationSummariesCreated).toBe(2);
      expect(summary.edgesCreated).toBe(1);
      expect(summary.rejectedHallucinations).toBe(0);
      expect(summary.inferFailures).toBe(0);
      // 청크 둘 다 요약됨 → summary stage 원장 completed 2건.
      expect(getStageResult(fx.db, "summary", String(a0))!.status).toBe("completed");
      expect(getStageResult(fx.db, "summary", String(a1))!.status).toBe("completed");
      // 문서 관계 발굴 → relation_discovery 원장 completed(관계 산출 있음).
      expect(getStageResult(fx.db, "relation_discovery", "doc-a")!.status).toBe("completed");

      // chunk_summaries 2행 generated_by='llm' + has_embedding=1.
      const chunkRows = fx.db
        .prepare("SELECT parent_chunk_id, generated_by, has_embedding FROM chunk_summaries ORDER BY parent_chunk_id")
        .all() as { parent_chunk_id: number; generated_by: string; has_embedding: number }[];
      expect(chunkRows.map((r) => r.parent_chunk_id)).toEqual([a0, a1]);
      expect(chunkRows.every((r) => r.generated_by === "llm")).toBe(true);
      expect(chunkRows.every((r) => r.has_embedding === 1)).toBe(true);

      // chunk_summary_vec 2행(요약 행 rowid 와 1:1).
      const chunkVec = fx.db.prepare("SELECT COUNT(*) AS n FROM chunk_summary_vec").get() as { n: number };
      expect(chunkVec.n).toBe(2);

      // relation_summaries 2행(개념 id·source_document_id 동반) + relation_summary_vec 2행.
      const relRows = fx.db
        .prepare(
          "SELECT from_concept_id, to_concept_id, confidence, source_document_id, has_embedding FROM relation_summaries ORDER BY confidence",
        )
        .all() as {
        from_concept_id: string;
        to_concept_id: string;
        confidence: number;
        source_document_id: string;
        has_embedding: number;
      }[];
      expect(relRows.map((r) => r.confidence)).toEqual([0.4, 0.9]);
      expect(relRows.every((r) => r.source_document_id === "doc-a")).toBe(true);
      expect(relRows.every((r) => r.has_embedding === 1)).toBe(true);
      // 개념 id 가 from/to 에 들어갔다(정수 노드 id 가 아니라 cpt_ TEXT).
      const idSet = new Set(relRows.flatMap((r) => [r.from_concept_id, r.to_concept_id]));
      expect(idSet).toEqual(new Set([cptA, cptB]));
      const relVec = fx.db.prepare("SELECT COUNT(*) AS n FROM relation_summary_vec").get() as { n: number };
      expect(relVec.n).toBe(2);

      // concept_edges llm_relation 엣지 1개(confidence 0.9 만 승격, 0.4 보류).
      const edges = fx.db
        .prepare(
          "SELECT source_concept_id, target_concept_id, weight FROM concept_edges WHERE relation = 'llm_relation'",
        )
        .all() as { source_concept_id: string; target_concept_id: string; weight: number }[];
      expect(edges.length).toBe(1);
      expect(edges[0]?.source_concept_id).toBe(cptA);
      expect(edges[0]?.target_concept_id).toBe(cptB);
      expect(edges[0]?.weight).toBeCloseTo(0.9, 5);

      // knowledge_edges(글 노드 관계)에는 llm_relation 이 안 들어간다(개념 채널로 이동).
      const nodeEdges = fx.db
        .prepare("SELECT COUNT(*) AS n FROM knowledge_edges WHERE relation = 'llm_relation'")
        .get() as { n: number };
      expect(nodeEdges.n).toBe(0);

      // 정보성 emit — 엣지가 생긴 사이클이라 1회.
      expect(emitSpy).toHaveBeenCalledTimes(1);
      emitSpy.mockRestore();
      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  it(
    "사람(psn_) 끝 관계 발굴 E2E — 개념 A↔사람 B '라이벌' + 사람 B↔사람 C 가 relation_summaries·concept_edges psn_ 끝까지(addConceptEdge psn_ 끝 크래시 0)",
    async () => {
      const fx = makeFixture();
      insertDocument(fx.db, "doc-a");
      const a0 = insertChunk(fx.db, "주인공 A 와 라이벌 B 의 대결", "doc-a", 0, "2026-06-05 10:00:00");
      const a0Atomics = attachAtomics(fx.db, a0, 4);
      const a1 = insertChunk(fx.db, "B 와 동료 C 가 갈라서는 사건", "doc-a", 1, "2026-06-05 10:01:00");
      const a1Atomics = attachAtomics(fx.db, a1, 4);

      // 허용 개념 집합에 개념 cptA(cpt_) + 사람 psnB·psnC(psn_) 셋이 들게 한다. cptA 는
      // node_concept_edges, 사람 둘은 node_person_edges — collectDocumentConcepts 의 UNION
      // 두 갈래가 모두 allowedConceptIds 에 들어가는지를 실 SQLite 로 확인한다.
      const cptA = insertConcept(fx.db, "cpt_A", "주인공A");
      const psnB = insertPerson(fx.db, "psn_B", "라이벌B");
      const psnC = insertPerson(fx.db, "psn_C", "동료C");
      linkConcept(fx.db, a0Atomics[0]!, cptA);
      linkPerson(fx.db, a0Atomics[1]!, psnB);
      linkPerson(fx.db, a1Atomics[0]!, psnC);

      // 통합 응답 fixture(함수 주입 — mock 객체 0). 관계 3건:
      //   (1) 개념 A → 사람 B '라이벌' confidence 0.9 — 통과·엣지 승격.
      //   (2) 사람 B → 사람 C '동료' confidence 0.85 — psn_-psn_ 통과·엣지 승격.
      //   (3) 개념 A → 사람 C '대립' confidence 0.4 — 임계 미만이라 요약 행만·엣지 없음.
      const infer: SummaryInferFn = async () =>
        ok(JSON.stringify({
          chunkSummaries: [
            { chunk_id: a0, summary_text: "A 와 B 가 대결한다.", confidence: 0.9 },
          ],
          relationSummaries: [
            {
              from_concept_id: cptA,
              to_concept_id: psnB,
              relation_name: "라이벌",
              summary_text: "주인공 A 와 라이벌 B 는 라이벌 관계다.",
              confidence: 0.9,
            },
            {
              from_concept_id: psnB,
              to_concept_id: psnC,
              relation_name: "동료",
              summary_text: "B 와 C 는 한때 동료였다.",
              confidence: 0.85,
            },
            {
              from_concept_id: cptA,
              to_concept_id: psnC,
              relation_name: "대립",
              summary_text: "A 와 C 는 살짝 대립한다.",
              confidence: 0.4,
            },
          ],
        }));

      const summary = await runSummaryCycle(baseDeps(fx, infer));

      // 관계요약 3행 전부 저장(엣지 보류분도 행은 항상 저장), 엣지는 confidence 통과 2건.
      expect(summary.relationSummariesCreated).toBe(3);
      expect(summary.edgesCreated).toBe(2);
      expect(summary.rejectedHallucinations).toBe(0);
      expect(summary.inferFailures).toBe(0);

      // (a) relation_summaries 에 from/to 가 psn_ 인 행이 source_document_id 동반 저장.
      const psnRelRows = fx.db
        .prepare(
          `SELECT from_concept_id, to_concept_id, confidence, source_document_id
           FROM relation_summaries
           WHERE from_concept_id LIKE 'psn_%' OR to_concept_id LIKE 'psn_%'
           ORDER BY confidence`,
        )
        .all() as {
        from_concept_id: string;
        to_concept_id: string;
        confidence: number;
        source_document_id: string;
      }[];
      // 사람 끝 관계 3건 중 psn_ 가 from/to 에 든 행은 (1)·(2)·(3) 전부(셋 다 psn_ 끝 포함).
      expect(psnRelRows.length).toBe(3);
      expect(psnRelRows.every((r) => r.source_document_id === "doc-a")).toBe(true);
      // 사람-사람(psn_-psn_) 행이 실재한다.
      const personPair = psnRelRows.find(
        (r) => r.from_concept_id === psnB && r.to_concept_id === psnC,
      );
      expect(personPair).toBeDefined();

      // (b) concept_edges 에 target 또는 source 가 psn_ 인 llm_relation 행 — confidence 통과
      //     2건만(addConceptEdge 가 psn_ 끝을 크래시 없이 받았다는 실증).
      const psnEdges = fx.db
        .prepare(
          `SELECT source_concept_id, target_concept_id, weight
           FROM concept_edges
           WHERE relation = 'llm_relation'
             AND (source_concept_id LIKE 'psn_%' OR target_concept_id LIKE 'psn_%')
           ORDER BY weight`,
        )
        .all() as { source_concept_id: string; target_concept_id: string; weight: number }[];
      expect(psnEdges.length).toBe(2);
      // cpt_A → psn_B '라이벌'(0.9) 엣지.
      const cptToPsn = psnEdges.find(
        (e) => e.source_concept_id === cptA && e.target_concept_id === psnB,
      );
      expect(cptToPsn).toBeDefined();
      expect(cptToPsn?.weight).toBeCloseTo(0.9, 5);
      // psn_B → psn_C '동료'(0.85) — psn_-psn_ 양 끝 사람 엣지가 들어갔다.
      const psnToPsn = psnEdges.find(
        (e) => e.source_concept_id === psnB && e.target_concept_id === psnC,
      );
      expect(psnToPsn).toBeDefined();
      expect(psnToPsn?.weight).toBeCloseTo(0.85, 5);

      // (c) confidence 미만(cpt_A → psn_C 0.4)은 요약 행만 있고 엣지는 없다.
      const lowConfEdge = fx.db
        .prepare(
          `SELECT 1 AS hit FROM concept_edges
           WHERE relation = 'llm_relation'
             AND source_concept_id = ? AND target_concept_id = ?`,
        )
        .get(cptA, psnC) as { hit: number } | null;
      expect(lowConfEdge).toBeNull();
      const lowConfRel = fx.db
        .prepare(
          `SELECT confidence FROM relation_summaries
           WHERE from_concept_id = ? AND to_concept_id = ?`,
        )
        .get(cptA, psnC) as { confidence: number } | null;
      expect(lowConfRel?.confidence).toBeCloseTo(0.4, 5);
      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  it(
    "from_concept_id 환각 관계는 버리고(rejectedHallucinations++) 정상 관계만 살린다",
    async () => {
      const fx = makeFixture();
      insertDocument(fx.db, "doc-a");
      const a0 = insertChunk(fx.db, "첫 조각", "doc-a", 0, "2026-06-05 10:00:00");
      const a0Atomics = attachAtomics(fx.db, a0, 4);
      const a1 = insertChunk(fx.db, "둘째 조각", "doc-a", 1, "2026-06-05 10:01:00");
      const a1Atomics = attachAtomics(fx.db, a1, 4);

      const cptA = insertConcept(fx.db, "cpt_A", "개념A");
      const cptB = insertConcept(fx.db, "cpt_B", "개념B");
      linkConcept(fx.db, a0Atomics[0]!, cptA);
      linkConcept(fx.db, a1Atomics[0]!, cptB);

      const infer: SummaryInferFn = async () =>
        ok(JSON.stringify({
          chunkSummaries: [],
          relationSummaries: [
            // from=cpt_HALLUCINATION 환각(허용 개념 집합 밖) → 버림.
            {
              from_concept_id: "cpt_HALLUCINATION",
              to_concept_id: cptB,
              relation_name: "환각",
              summary_text: "존재하지 않는 개념 관계.",
              confidence: 0.95,
            },
            // 정상 관계 → 살아남고 개념 엣지.
            {
              from_concept_id: cptA,
              to_concept_id: cptB,
              relation_name: "연관",
              summary_text: "A 와 B 는 같은 문서 개념.",
              confidence: 0.9,
            },
          ],
        }));

      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const summary = await runSummaryCycle(baseDeps(fx, infer));
      warn.mockRestore();

      expect(summary.rejectedHallucinations).toBe(1);
      expect(summary.relationSummariesCreated).toBe(1);
      expect(summary.edgesCreated).toBe(1);
      const relCount = fx.db.prepare("SELECT COUNT(*) AS n FROM relation_summaries").get() as { n: number };
      expect(relCount.n).toBe(1);
      // 환각 from 은 저장 안 된 채 정상 관계만 개념 엣지.
      const edge = fx.db
        .prepare(
          "SELECT source_concept_id, target_concept_id FROM concept_edges WHERE relation = 'llm_relation'",
        )
        .get() as { source_concept_id: string; target_concept_id: string } | null;
      expect(edge?.source_concept_id).toBe(cptA);
      expect(edge?.target_concept_id).toBe(cptB);
      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  it(
    "relationAutoApply=false — 관계요약 행은 저장하되 llm_relation 엣지는 보류(edgesWithheld)",
    async () => {
      const fx = makeFixture();
      insertDocument(fx.db, "doc-a");
      const a0 = insertChunk(fx.db, "A 와 B 의 만남", "doc-a", 0, "2026-06-05 10:00:00");
      const a0Atomics = attachAtomics(fx.db, a0, 4);
      const a1 = insertChunk(fx.db, "A 와 B 의 대립", "doc-a", 1, "2026-06-05 10:01:00");
      const a1Atomics = attachAtomics(fx.db, a1, 4);
      const cptA = insertConcept(fx.db, "cpt_A", "인물A");
      const cptB = insertConcept(fx.db, "cpt_B", "인물B");
      linkConcept(fx.db, a0Atomics[0]!, cptA);
      linkConcept(fx.db, a1Atomics[0]!, cptB);

      const infer: SummaryInferFn = async () =>
        ok(JSON.stringify({
          chunkSummaries: [
            { chunk_id: a0, summary_text: "A 와 B 가 만난다.", confidence: 0.9 },
          ],
          relationSummaries: [
            {
              from_concept_id: cptA,
              to_concept_id: cptB,
              relation_name: "라이벌",
              summary_text: "A 와 B 는 라이벌.",
              // 임계(0.6) 통과 — autoApply=true 였다면 엣지가 생겼을 confidence.
              confidence: 0.9,
            },
          ],
        }));

      const summary = await runSummaryCycle({
        ...baseDeps(fx, infer),
        relationAutoApply: false,
      });

      // 관계요약 행은 저장(정리 자산 유지) — relationAutoApply 와 무관.
      expect(summary.relationSummariesCreated).toBe(1);
      const relCount = fx.db
        .prepare("SELECT COUNT(*) AS n FROM relation_summaries")
        .get() as { n: number };
      expect(relCount.n).toBe(1);
      // 엣지는 자동 생성 보류 — llm_relation 개념 엣지 0, 보류 집계 1.
      expect(summary.edgesCreated).toBe(0);
      expect(summary.edgesWithheld).toBe(1);
      const edgeCount = fx.db
        .prepare("SELECT COUNT(*) AS n FROM concept_edges WHERE relation = 'llm_relation'")
        .get() as { n: number };
      expect(edgeCount.n).toBe(0);
      // relation_discovery 원장은 관계요약 산출 있음 → completed(재과금 끊김 — 엣지 보류와 무관).
      expect(getStageResult(fx.db, "relation_discovery", "doc-a")!.status).toBe("completed");
      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  it(
    "실행층 deterministic 이면 그 문서 실패 원장 + 사이클은 다음 문서로 이어간다",
    async () => {
      const fx = makeFixture();
      insertDocument(fx.db, "doc-a");
      insertDocument(fx.db, "doc-b");
      const a0 = insertChunk(fx.db, "A 조각", "doc-a", 0, "2026-06-05 10:00:00");
      const aAtomics = attachAtomics(fx.db, a0, 4);
      const b0 = insertChunk(fx.db, "B 조각", "doc-b", 0, "2026-06-05 10:02:00");
      const bAtomics = attachAtomics(fx.db, b0, 4);
      // doc-a·doc-b 각각 개념 2개(관계 발굴 대상 자격 — 묶음에 들기 위함).
      const cptA1 = insertConcept(fx.db, "cpt_A1", "개념A1");
      const cptA2 = insertConcept(fx.db, "cpt_A2", "개념A2");
      linkConcept(fx.db, aAtomics[0]!, cptA1);
      linkConcept(fx.db, aAtomics[1]!, cptA2);
      const cptB1 = insertConcept(fx.db, "cpt_B1", "개념B1");
      const cptB2 = insertConcept(fx.db, "cpt_B2", "개념B2");
      linkConcept(fx.db, bAtomics[0]!, cptB1);
      linkConcept(fx.db, bAtomics[1]!, cptB2);

      // doc-a 호출은 결정적 실패(파싱 실패 등), doc-b 호출은 청크요약 1건 정상.
      const infer: SummaryInferFn = async (prompt) => {
        if (prompt.includes("A 조각")) {
          return { kind: "deterministic", reason: "JSON 파싱 실패" };
        }
        return ok(JSON.stringify({
          chunkSummaries: [{ chunk_id: b0, summary_text: "B 요약.", confidence: 0.9 }],
          relationSummaries: [],
        }));
      };

      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const summary = await runSummaryCycle(baseDeps(fx, infer));
      warn.mockRestore();

      expect(summary.inferFailures).toBe(1);
      // doc-b 청크요약은 실패한 doc-a 와 무관하게 만들어진다(사이클 중단 0).
      expect(summary.chunkSummariesCreated).toBe(1);
      const rows = fx.db
        .prepare("SELECT parent_chunk_id FROM chunk_summaries")
        .all() as { parent_chunk_id: number }[];
      expect(rows.map((r) => r.parent_chunk_id)).toEqual([b0]);
      // doc-a 청크는 결정적 실패 원장에 남는다(retryable_failure attempt 1).
      expect(getStageResult(fx.db, "summary", String(a0))!.status).toBe("retryable_failure");
      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  it(
    "멱등 — 같은 사이클 두 번 돌려도 이미 요약·관계 발굴한 문서 재처리 0",
    async () => {
      const fx = makeFixture();
      insertDocument(fx.db, "doc-a");
      const a0 = insertChunk(fx.db, "조각 하나", "doc-a", 0, "2026-06-05 10:00:00");
      const a0Atomics = attachAtomics(fx.db, a0, 4);
      const cptA = insertConcept(fx.db, "cpt_A", "개념A");
      const cptB = insertConcept(fx.db, "cpt_B", "개념B");
      linkConcept(fx.db, a0Atomics[0]!, cptA);
      linkConcept(fx.db, a0Atomics[1]!, cptB);

      const infer: SummaryInferFn = async () =>
        ok(JSON.stringify({
          chunkSummaries: [{ chunk_id: a0, summary_text: "요약.", confidence: 0.9 }],
          relationSummaries: [
            {
              from_concept_id: cptA,
              to_concept_id: cptB,
              relation_name: "연관",
              summary_text: "A 와 B 관계.",
              confidence: 0.9,
            },
          ],
        }));

      const first = await runSummaryCycle(baseDeps(fx, infer));
      expect(first.chunkSummariesCreated).toBe(1);
      expect(first.relationSummariesCreated).toBe(1);

      // 두 번째 사이클 — 청크요약 행 존재로 후보 0(재처리 없음).
      const second = await runSummaryCycle(baseDeps(fx, infer));
      expect(second.chunkSummariesCreated).toBe(0);
      expect(second.relationSummariesCreated).toBe(0);
      const total = fx.db.prepare("SELECT COUNT(*) AS n FROM chunk_summaries").get() as { n: number };
      expect(total.n).toBe(1);
      const relTotal = fx.db.prepare("SELECT COUNT(*) AS n FROM relation_summaries").get() as { n: number };
      expect(relTotal.n).toBe(1);
      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );
});

describe("runSummaryCycle — graceful(infer=null → 첫 문단 fallback / 관계·엣지 skip)", () => {
  it(
    "infer=null 이면 청크요약은 첫 문단 fallback(generated_by 표시) + 임베딩, 관계·엣지 0·emit 0",
    async () => {
      const fx = makeFixture();
      insertDocument(fx.db, "doc-a");
      const a0 = insertChunk(
        fx.db,
        "첫 문단입니다. 핵심 내용.\n\n둘째 문단은 버려진다.",
        "doc-a",
        0,
        "2026-06-05 10:00:00",
      );
      attachAtomics(fx.db, a0, 4);

      const emitSpy = spyOn(fx.eventBus, "emit");
      const summary = await runSummaryCycle(baseDeps(fx, null));

      expect(summary.chunkSummariesCreated).toBe(1);
      expect(summary.relationSummariesCreated).toBe(0);
      expect(summary.edgesCreated).toBe(0);

      const row = fx.db
        .prepare("SELECT summary_text, generated_by, has_embedding FROM chunk_summaries WHERE parent_chunk_id = ?")
        .get(a0) as { summary_text: string; generated_by: string; has_embedding: number };
      expect(row.generated_by).toBe("first_paragraph_fallback");
      expect(row.summary_text).toBe("첫 문단입니다. 핵심 내용.");
      expect(row.has_embedding).toBe(1);

      // 관계요약·엣지 둘 다 0(개념 채널).
      const relCount = fx.db.prepare("SELECT COUNT(*) AS n FROM relation_summaries").get() as { n: number };
      expect(relCount.n).toBe(0);
      const edgeCount = fx.db
        .prepare("SELECT COUNT(*) AS n FROM concept_edges WHERE relation = 'llm_relation'")
        .get() as { n: number };
      expect(edgeCount.n).toBe(0);

      // 엣지 0건 사이클 → emit 0.
      expect(emitSpy).not.toHaveBeenCalled();
      emitSpy.mockRestore();
      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  it(
    "infer=null + 첫 문단 빈 청크는 정직하게 건너뛴다(가짜 채움 0)",
    async () => {
      const fx = makeFixture();
      insertDocument(fx.db, "doc-a");
      const empty = insertChunk(fx.db, "   \n\n  ", "doc-a", 0, "2026-06-05 10:00:00");
      attachAtomics(fx.db, empty, 4);

      const summary = await runSummaryCycle(baseDeps(fx, null));
      expect(summary.chunkSummariesCreated).toBe(0);
      const n = fx.db.prepare("SELECT COUNT(*) AS n FROM chunk_summaries").get() as { n: number };
      expect(n.n).toBe(0);
      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );
});
