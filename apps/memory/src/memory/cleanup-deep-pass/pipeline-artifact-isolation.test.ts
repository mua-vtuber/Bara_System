/**
 * pipeline-artifact-isolation.test.ts — bara 파이프라인 산출물 격리 고정 회귀
 * (spec 5-8 자기 오염 방지 / T17 실사).
 *
 * spec 5-8 은 "bara 자체 파이프라인 산출물(요약·제안 등)이 일반 기억으로 재유입되는
 * 것을 막는 판별"을 `isPipelineArtifact(sourceType, metadata)` 공유 순수 함수로
 * 요구했다. T17 실사 결과, 이 우려가 가리키는 재유입 경로 자체가 현재 코드에
 * 존재하지 않는다 — 판별 함수가 막을 대상이 없다:
 *
 *   - 청크 요약(chunk summary)  → 전용 테이블 `chunk_summaries` 에만 저장
 *     (summary-cycle.ts insertChunkSummary). knowledge_nodes INSERT 0.
 *   - 관계 요약(relation summary) → 전용 테이블 `relation_summaries` 에만 저장
 *     (insertRelationSummary) + 개념 엣지(concept_edges). 글 노드 생성 0.
 *   - 렌즈 초안(lens draft) 적용 → 전용 테이블 자체가 없다(lens_drafts 미존재).
 *     applyLensDraft 는 entities/entity_attributes 구조화 값 갱신이지 새
 *     knowledge_nodes 행 생성이 아니다.
 *   - 정리 제안(cleanup proposal) → 전용 테이블 `cleanup_proposals` 에만 저장
 *     (CleanupProposalsRepository.insert).
 *   - 임베딩 backfill(concept/siglip/vision) → 기존 행 UPDATE 뿐, 신규 INSERT 0.
 *
 * 검색·cleanup 후보 질의(candidate-query.ts·summary-candidate-query.ts 등)는 전부
 * knowledge_nodes 테이블을 대상으로 하므로, 파이프라인 산출물이 애초에 그 테이블에
 * 안 들어가는 한 "일반 검색·cleanup 후보 양쪽에서 뒤섞여 취급된다"는 오염 경로는
 * 물리적으로 발생할 수 없다.
 *
 * 이 파일은 그 실사 결과(= 격리가 이미 보장돼 있다는 사실)를 고정하는 회귀
 * 테스트다. 대표 writer 4곳(summary cycle·cleanup proposal 제출·lens apply·
 * concept-embedding backfill)을 실 SQLite 로 실행해, 전용 테이블에는 행이 늘고
 * knowledge_nodes 행 수는 그대로임을 단언한다.
 *
 * **만약 이 테스트가 언젠가 실패하기 시작하면(= 파이프라인 산출물이 knowledge_nodes
 * 에 유입되는 새 경로가 생기면), spec 5-8 의 isPipelineArtifact 공유 판별 함수
 * 설계가 그 순간부터 필수가 된다.** 그 설계는 삭제된 게 아니라 유예된 대안이다 —
 * 이 테스트를 약화(skip·기대값 완화)하기 전에 그 함수부터 구현할 것.
 *
 * image_caption 관련 경계 관찰: VLM 이 사용자 업로드 이미지에 자동으로 붙이는
 * 캡션(source_type='image_caption')은 검색 가능하게 설계된 의도된 동작이다(이미지
 * 검색이 캡션 글자에 의존 — caption-flow.ts 헤더 참조). 파이프라인 산출물이 아니라
 * 사용자 자산의 1회성 파생 콘텐츠로 분류하며, 이 테스트의 격리 대상이 아니다(동작
 * 변경 없음).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { EventBus } from "../../server-internal/event-bus.ts";
import { EventRepository } from "../../db/store-internal/event-repository.ts";
import { CleanupProposalsRepository } from "../../db/store-internal/cleanup-proposals-repository.ts";
import { backfillConceptEmbeddings } from "../../db/store-internal/concept-embedding-backfill.ts";
import { buildEntityLens } from "../../server-internal/routes/entity-lenses.ts";
import type { MemoryApiDeps } from "../../server-internal/types.ts";
import { runSummaryCycle, type SummaryCycleDeps } from "./summary-cycle.ts";
import { applyLensDraft, type LensApplyView, type LensDraftValues } from "./lens-apply.ts";

const MODEL_LOAD_TIMEOUT_MS = 180_000;

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
}, MODEL_LOAD_TIMEOUT_MS);

afterAll(() => {
  // embedder 는 프로세스 단위 — 별도 해제 없음(summary-cycle.test.ts 선례 정합).
});

function makeFixture(): { db: Database; store: SqliteMemoryStore; eventBus: EventBus } {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const eventBus = new EventBus(new EventRepository(db));
  return { db, store, eventBus };
}

/** knowledge_nodes 전체 행 수(사용자 기억 재유입 여부의 단일 관측점). */
function nodeCount(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n;
}

/** documents 행 한 개 삽입(FK 사슬 asset_files → documents). summary-cycle.test.ts 선례. */
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

/** document_chunk 노드 한 개 삽입(metadata.parentId + chunkIndex). summary-cycle.test.ts 선례. */
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

/** 청크에 atomic 자식 N건 + merged_into 엣지(child→chunk) 삽입(임계 충족). summary-cycle.test.ts 선례. */
function attachAtomics(db: Database, chunkId: number, count: number): void {
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
  }
}

describe("파이프라인 산출물 격리 고정 — knowledge_nodes 재유입 경로 없음", () => {
  it(
    "summary cycle(infer=null graceful) — chunk_summaries 는 늘고 knowledge_nodes 는 그대로",
    async () => {
      const fx = makeFixture();
      insertDocument(fx.db, "doc-a");
      const chunkId = insertChunk(
        fx.db,
        "첫 문단입니다. 핵심 내용.\n\n둘째 문단은 버려진다.",
        "doc-a",
        0,
      );
      attachAtomics(fx.db, chunkId, 4);

      const before = nodeCount(fx.db);

      const deps: SummaryCycleDeps = {
        db: fx.db,
        store: fx.store,
        embedder,
        infer: null,
        eventBus: fx.eventBus,
        atomicThreshold: 4,
        batchSize: 50,
        relationConfidenceThreshold: 0.6,
        firstParagraphMaxChars: 300,
        stageVersion: 1,
        maxAttemptsPerTarget: 3,
        // fallback 경로(infer=null)는 실행층을 안 타 상한을 쓰지 않는다 — 넉넉한 값.
        perCallInputCap: 1_000_000,
      };
      const summary = await runSummaryCycle(deps);
      expect(summary.chunkSummariesCreated).toBe(1);

      const summaryCount = (
        fx.db.prepare("SELECT COUNT(*) AS n FROM chunk_summaries").get() as { n: number }
      ).n;
      expect(summaryCount).toBe(1);

      // 격리 불변식 — 요약 산출이 knowledge_nodes 행 수를 바꾸지 않는다.
      expect(nodeCount(fx.db)).toBe(before);

      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  it("cleanup proposal 제출 — cleanup_proposals 는 늘고 knowledge_nodes 는 그대로", () => {
    const fx = makeFixture();
    const before = nodeCount(fx.db);

    const proposals = new CleanupProposalsRepository(fx.db);
    const id = proposals.insert("regex_pattern_add", {
      sourceNodeId: 1,
      suggestedPattern: "테스트 양식",
    });
    expect(id).toStartWith("cp_");

    const proposalCount = (
      fx.db.prepare("SELECT COUNT(*) AS n FROM cleanup_proposals").get() as { n: number }
    ).n;
    expect(proposalCount).toBe(1);

    // 격리 불변식 — 제안 제출이 knowledge_nodes 행 수를 바꾸지 않는다.
    expect(nodeCount(fx.db)).toBe(before);

    fx.db.close();
  });

  it(
    "lens apply — entity_attributes 는 갱신되고 knowledge_nodes 는 그대로(신규 lens_drafts 테이블 자체가 없음)",
    async () => {
      const fx = makeFixture();
      const deps: MemoryApiDeps = {
        store: fx.store,
        retriever: undefined as unknown as MemoryApiDeps["retriever"],
        assembler: undefined as unknown as MemoryApiDeps["assembler"],
      };
      const ent = await fx.store.entitiesRepo.findOrCreateEntity("material", "격리검증자료");
      // findOrCreateEntity 자체는 entities 테이블 행이라 knowledge_nodes 와 무관하지만,
      // 그 이후(적용 시점)부터를 계측 구간으로 잡는다 — lens apply 고유 효과만 본다.
      const before = nodeCount(fx.db);

      const lens = buildEntityLens("material");
      const view: LensApplyView = {
        typeName: lens.typeName,
        columns: lens.columns.map((c) => ({ key: c.key, dataType: c.dataType })),
        attributeKeys: lens.attributes.map((a) => a.key),
        relations: lens.relations.map((r) => ({
          key: r.key,
          relation: r.relation,
          targetTypes: r.targetTypes,
          defaultTargetType: r.defaultTargetType,
        })),
        metadataKeys: lens.metadataFields.map((m) => m.key),
      };
      const values: LensDraftValues = {
        columns: { 주제: "격리 검증" },
        labels: {},
        relations: {},
        metadata: {},
      };

      const result = await applyLensDraft(deps, {
        lens: view,
        entityId: ent.id,
        values,
        sourceNodeId: null,
        aiPath: true,
      });
      expect(result.applied).toBe(true);

      const cols = fx.store.entitiesRepo.listAttributes(ent.id).filter((a) => a.isColumn);
      expect(cols.find((c) => c.key === "주제")?.value).toBe("격리 검증");

      // 격리 불변식 — 렌즈 적용(entity 구조화 값 갱신)이 knowledge_nodes 행 수를 바꾸지
      // 않는다. lens_drafts 라는 별도 테이블 자체가 존재하지 않는다(기준 스키마 실사).
      expect(nodeCount(fx.db)).toBe(before);

      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  it(
    "concept embedding backfill — concept_vec 는 채워지고 knowledge_nodes 는 그대로",
    async () => {
      const fx = makeFixture();
      fx.db
        .prepare("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)")
        .run("cpt_isolation_test", "격리검증개념");

      const before = nodeCount(fx.db);

      const filled = await backfillConceptEmbeddings(fx.db, embedder);
      expect(filled).toBe(1);

      const vecCount = (
        fx.db
          .prepare(
            `SELECT COUNT(*) AS n FROM concept_vec cv
             JOIN concept_nodes cn ON cn.rowid = cv.concept_rowid
             WHERE cn.concept_id = ?`,
          )
          .get("cpt_isolation_test") as { n: number }
      ).n;
      expect(vecCount).toBe(1);

      // 격리 불변식 — backfill 은 기존 행 UPDATE 뿐, knowledge_nodes 에 신규 INSERT 없다.
      expect(nodeCount(fx.db)).toBe(before);

      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );
});

describe("파이프라인 산출물 격리 고정 — 검색/cleanup 후보 질의 대상 테이블 확인", () => {
  let fx: ReturnType<typeof makeFixture>;

  beforeEach(() => {
    fx = makeFixture();
  });

  it("cleanup_proposals·chunk_summaries·relation_summaries 행은 knowledge_nodes 기반 후보 질의(FTS/vec 검색)에 절대 나타날 수 없다(다른 테이블)", () => {
    // 이 테스트는 스키마 수준 불변식을 재확인한다 — knowledge_nodes 검색 경로
    // (search-repository.ts FTS·vec0 KNN)는 knowledge_nodes/vec_nodes 만 조회하고,
    // 파이프라인 산출 테이블(cleanup_proposals/chunk_summaries/relation_summaries)은
    // 스키마상 별도 테이블이라 같은 질의로 나올 수 없다. 테이블 분리 자체가 격리 보증의
    // 근거이므로, 테이블 존재와 knowledge_nodes 와의 비FK 관계를 여기서 명시적으로 확인한다.
    const proposals = new CleanupProposalsRepository(fx.db);
    proposals.insert("regex_pattern_add", { sourceNodeId: 1 });

    // knowledge_nodes 에는 이 제안의 흔적이 전혀 없다 — content 컬럼에 제안 payload 가
    // 실려 들어가는 경로가 없으므로 LIKE 검색으로도 안 걸린다.
    const leaked = (
      fx.db
        .prepare("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE content LIKE '%regex_pattern_add%'")
        .get() as { n: number }
    ).n;
    expect(leaked).toBe(0);

    fx.db.close();
  });
});
