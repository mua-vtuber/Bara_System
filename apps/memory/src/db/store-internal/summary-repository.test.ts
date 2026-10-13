/**
 * summary-repository.test.ts — Phase 7 둘째 단계 "요약" 저장소 통합 검증.
 *
 * 권위 plan: docs/decisions/2026-06-05-phase7-summary-stage-plan.md Task 14·20.
 *
 * Task 20 초점: listRelationSummariesForConcept(id) 가 id 종류를 안 가린다 —
 * from_concept_id/to_concept_id 는 TEXT 칸이라 cpt_(개념) 든 psn_(사람) 든 같은
 * 텍스트 매칭으로 회신한다. 사람 노드 상세가 신규 메서드 없이 이 메서드를 그대로
 * 재사용한다는 사실을 저장소 계층에서 직접 확인한다(라우트·UI 와 별개로 동결).
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder. mock 0. 운영 DB 비접근.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { SummaryRepository } from "./summary-repository.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

/** relation_summaries.source_document_id 가 가리킬 documents 행 하나를 만든다. */
function makeDocument(db: Database, tag: string): string {
  const sha = `sha_doc_${tag}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at)
     VALUES (?, 'text', ?, 1, ?)`,
  ).run(sha, `/assets/${sha}.md`, now);
  const docId = `doc_${tag}`;
  db.prepare(
    `INSERT INTO documents (document_id, asset_sha256, title, document_type, created_at, updated_at)
     VALUES (?, ?, ?, 'text', ?, ?)`,
  ).run(docId, sha, `문서 ${tag}`, now, now);
  return docId;
}

describe("SummaryRepository.listRelationSummariesForConcept — id 종류 무관(Task 20)", () => {
  let db: Database;
  let repo: SummaryRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new SummaryRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("psn_(사람) id 가 from 인 관계가 그대로 회신된다(텍스트 매칭)", async () => {
    const docId = makeDocument(db, "person_from");
    await repo.insertRelationSummary({
      summaryId: "rs_psn_a_cpt_x",
      fromConceptId: "psn_a",
      toConceptId: "cpt_x",
      relationName: "취미",
      summaryText: "사람A 는 등산을 한다",
      confidence: 0.8,
      generatedBy: "llm",
      sourceDocumentId: docId,
    });

    const rows = repo.listRelationSummariesForConcept("psn_a");
    expect(rows.length).toBe(1);
    expect(rows[0]!.fromConceptId).toBe("psn_a");
    expect(rows[0]!.toConceptId).toBe("cpt_x");
    expect(rows[0]!.relationName).toBe("취미");
  });

  test("psn_ id 가 to 인 관계도 양방향으로 회신된다", async () => {
    const docId = makeDocument(db, "person_to");
    await repo.insertRelationSummary({
      summaryId: "rs_cpt_y_psn_b",
      fromConceptId: "cpt_y",
      toConceptId: "psn_b",
      relationName: "연주자",
      summaryText: "사람B 는 기타를 친다",
      confidence: 0.4,
      generatedBy: "llm",
      sourceDocumentId: docId,
    });

    const rows = repo.listRelationSummariesForConcept("psn_b");
    expect(rows.length).toBe(1);
    expect(rows[0]!.toConceptId).toBe("psn_b");
    expect(rows[0]!.confidence).toBeCloseTo(0.4, 10);
  });

  test("관계 0건 사람 id → 빈 배열(정직한 빈 결과)", () => {
    const rows = repo.listRelationSummariesForConcept("psn_lonely");
    expect(rows).toEqual([]);
  });

  test("사람-사람(psn_-psn_) 관계도 양 끝에서 회신된다", async () => {
    const docId = makeDocument(db, "person_person");
    await repo.insertRelationSummary({
      summaryId: "rs_psn_c_psn_d",
      fromConceptId: "psn_c",
      toConceptId: "psn_d",
      relationName: "친구",
      summaryText: "사람C 와 사람D 는 오랜 친구다",
      confidence: 0.9,
      generatedBy: "llm",
      sourceDocumentId: docId,
    });

    expect(repo.listRelationSummariesForConcept("psn_c").length).toBe(1);
    expect(repo.listRelationSummariesForConcept("psn_d").length).toBe(1);
  });
});
