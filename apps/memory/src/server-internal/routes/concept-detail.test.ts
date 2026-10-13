/**
 * concept-detail.test.ts — Phase 7 둘째 단계 Task 16: 개념 노드 상세 열람 API 통합 검증.
 *
 * 설계 권위 = docs/decisions/2026-06-05-phase7-summary-stage-spec.md §5.4(열람 표시 —
 * 개념·사람 중심), plan Task 16.
 *
 * GET /api/concepts/:id 는 한 개념(또는 사람) 노드 상세를 회신한다:
 *   - "AI 가 찾은 관계"(llm_relation 발굴 요약) 목록 — 상대 개념 이름 보강 + confidence +
 *     edge_present(임계 미만이면 "발굴됨/연결 보류" 라벨 판정).
 *   - parent_of 위계 이웃 — "AI 가 찾은 관계" 와 별도 칸으로 회신(표시 구분).
 *
 * 검증 항목:
 *   1. from·to 양방향 — 그 개념이 from 이든 to 든 관계가 회신되고, 상대 개념 이름이 보강된다.
 *   2. confidence 보류분 → edge_present=false / 임계 이상 → true.
 *   3. parent_of 위계는 relation_summaries 와 *다른 칸*(hierarchy)으로 분리되고 방향(parent/
 *      child) 라벨을 동반한다.
 *   4. 관계 0건 개념 → relation_summaries 빈 배열(정직한 빈 표시).
 *   5. 없는 개념 id → 404(빈 상세 위장 금지).
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder. mock 0. 운영 DB 비접근.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
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

/** documents 행 하나를 만들고 그 document_id 를 회신(관계요약 source_document_id 용). */
function makeDocument(h: Harness, tag: string): string {
  const sha = `sha_doc_${tag}`;
  h.db
    .prepare(
      `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at)
       VALUES (?, 'text', '/assets/${sha}.md', 1, ?)`,
    )
    .run(sha, Date.now());
  return h.store.createDocument({
    assetSha256: sha,
    title: `문서 ${tag}`,
    documentType: "text",
  });
}

interface RelationEntry {
  summary_id: string;
  relation_name: string;
  summary_text: string;
  confidence: number;
  edge_present: boolean;
  from_concept_id: string;
  to_concept_id: string;
  other_concept_id: string;
  other_concept_name: string;
}

interface HierarchyEntry {
  concept_id: string;
  name: string;
  direction: "parent" | "child";
  weight: number;
}

interface ConceptDetailResponse {
  concept: { concept_id: string; name: string };
  relation_summaries: RelationEntry[];
  hierarchy: HierarchyEntry[];
}

async function getConceptDetail(
  app: Hono,
  conceptId: string,
): Promise<{ status: number; body: ConceptDetailResponse }> {
  const res = await app.request(`/api/concepts/${encodeURIComponent(conceptId)}`);
  const body = (await res.json()) as ConceptDetailResponse;
  return { status: res.status, body };
}

describe("GET /api/concepts/:id — 개념 노드 상세 (Task 16 열람 표시)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("from·to 양방향 관계 + 상대 개념 이름 보강 + edge_present 판정", async () => {
    const a = await h.store.findOrCreateConcept("팀에이");
    const b = await h.store.findOrCreateConcept("팀비");
    const docId = makeDocument(h, "rivals");
    // confidence 0.8 ≥ 임계(default 0.6) → 엣지 승격(연결됨).
    await h.store.insertRelationSummary({
      summaryId: `rs_${a}_${b}`,
      fromConceptId: a,
      toConceptId: b,
      relationName: "라이벌",
      summaryText: "두 팀은 오랜 라이벌 관계다",
      confidence: 0.8,
      generatedBy: "llm",
      sourceDocumentId: docId,
    });

    // from 쪽(팀에이) 상세 — 상대는 팀비.
    const fromA = await getConceptDetail(h.app, a);
    expect(fromA.status).toBe(200);
    expect(fromA.body.concept.name).toBe("팀에이");
    expect(fromA.body.relation_summaries.length).toBe(1);
    const relA = fromA.body.relation_summaries[0]!;
    expect(relA.relation_name).toBe("라이벌");
    expect(relA.summary_text).toBe("두 팀은 오랜 라이벌 관계다");
    expect(relA.confidence).toBeCloseTo(0.8, 10);
    expect(relA.edge_present).toBe(true);
    expect(relA.other_concept_id).toBe(b);
    expect(relA.other_concept_name).toBe("팀비");

    // to 쪽(팀비) 상세 — 같은 관계가 양방향으로 보이고 상대는 팀에이.
    const fromB = await getConceptDetail(h.app, b);
    expect(fromB.status).toBe(200);
    expect(fromB.body.relation_summaries.length).toBe(1);
    expect(fromB.body.relation_summaries[0]!.other_concept_name).toBe("팀에이");
  });

  test("confidence 보류분 → edge_present=false (발굴됨/연결 보류)", async () => {
    const p = await h.store.findOrCreateConcept("도자기");
    const q = await h.store.findOrCreateConcept("유화");
    const docId = makeDocument(h, "hobby");
    // confidence 0.4 < 임계(default 0.6) → 엣지 미승격(보류).
    await h.store.insertRelationSummary({
      summaryId: `rs_${p}_${q}_low`,
      fromConceptId: p,
      toConceptId: q,
      relationName: "취미관련",
      summaryText: "두 취미는 손으로 만드는 공예라는 점에서 닿아 있다",
      confidence: 0.4,
      generatedBy: "llm",
      sourceDocumentId: docId,
    });

    const detail = await getConceptDetail(h.app, p);
    expect(detail.status).toBe(200);
    expect(detail.body.relation_summaries.length).toBe(1);
    expect(detail.body.relation_summaries[0]!.confidence).toBeCloseTo(0.4, 10);
    expect(detail.body.relation_summaries[0]!.edge_present).toBe(false);
  });

  test("parent_of 위계는 별도 칸 + 방향 라벨로 분리(AI 관계와 구분)", async () => {
    // 부모(상위 분류) → 자식(하위) parent_of 엣지.
    const parent = await h.store.findOrCreateConcept("동물", {
      isClassificationKey: true,
    });
    const child = await h.store.findOrCreateConcept("고양이", {
      isClassificationValue: true,
    });
    // S0-T4(위계 단일 출처) — 위계 parent_of 는 hierarchy_edges 에 쓴다. concept-detail
    // 상세가 그 테이블에서 실제 weight 를 그대로 싣는지 본다(0.5 보존).
    h.store.addHierarchyEdge({
      sourceType: "concept",
      sourceId: parent,
      targetType: "concept",
      targetId: child,
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.5,
    });
    // 같은 자식에 AI 가 찾은 관계도 하나 — 두 칸이 섞이지 않는지 본다.
    const sibling = await h.store.findOrCreateConcept("강아지");
    const docId = makeDocument(h, "pets");
    await h.store.insertRelationSummary({
      summaryId: `rs_${child}_${sibling}`,
      fromConceptId: child,
      toConceptId: sibling,
      relationName: "비슷한반려동물",
      summaryText: "고양이와 강아지는 흔한 반려동물이다",
      confidence: 0.7,
      generatedBy: "llm",
      sourceDocumentId: docId,
    });

    // 자식(고양이) 상세 — hierarchy 에 부모(동물·direction=parent), relation_summaries 에 강아지.
    const detail = await getConceptDetail(h.app, child);
    expect(detail.status).toBe(200);

    expect(detail.body.hierarchy.length).toBe(1);
    const h0 = detail.body.hierarchy[0]!;
    expect(h0.concept_id).toBe(parent);
    expect(h0.name).toBe("동물");
    expect(h0.direction).toBe("parent");

    expect(detail.body.relation_summaries.length).toBe(1);
    expect(detail.body.relation_summaries[0]!.relation_name).toBe("비슷한반려동물");

    // 부모(동물) 상세 — hierarchy 에 자식(고양이·direction=child).
    const parentDetail = await getConceptDetail(h.app, parent);
    expect(parentDetail.body.hierarchy.length).toBe(1);
    expect(parentDetail.body.hierarchy[0]!.concept_id).toBe(child);
    expect(parentDetail.body.hierarchy[0]!.direction).toBe("child");
  });

  test("관계 0건 개념 → relation_summaries 빈 배열(정직한 빈 표시)", async () => {
    const lonely = await h.store.findOrCreateConcept("외톨이개념");
    const detail = await getConceptDetail(h.app, lonely);
    expect(detail.status).toBe(200);
    expect(detail.body.concept.name).toBe("외톨이개념");
    expect(detail.body.relation_summaries).toEqual([]);
    expect(detail.body.hierarchy).toEqual([]);
  });

  test("없는 개념 id → 404 (빈 상세 위장 금지)", async () => {
    const res = await h.app.request("/api/concepts/cpt_does_not_exist");
    expect(res.status).toBe(404);
  });
});

// ── Task 20: 사람(psn_) 노드 상세에도 같은 관계 목록 ────────────────────────────
// concept_edges 양 끝 FK 제거(Task 18)로 관계요약 from/to 가 사람(psn_)일 수 있다.
// 같은 GET /api/concepts/:id 라우트가 psn_ id 면 persons.display_name 으로 이름을
// 풀고(getPerson), 그 사람이 from·to 어느 쪽에든 든 관계요약(텍스트 매칭 — Task 14 의
// listRelationSummariesForConcept 재사용)을 회신한다. 신규 메서드 없이 라우트가 이름
// 조회만 psn_ 으로 분기한다(getConcept 은 개념 전용 유지).
describe("GET /api/concepts/:id — 사람(psn_) 노드 상세 (Task 20)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("사람(psn_)이 from 인 관계 + 사람 이름(display_name) 회신", async () => {
    const person = await h.store.findOrCreatePerson({
      userId: "u_alice",
      displayName: "앨리스",
    });
    const concept = await h.store.findOrCreateConcept("등산");
    const docId = makeDocument(h, "alice");
    // 사람(앨리스) → 개념(등산) 관계요약. from 이 psn_ id.
    await h.store.insertRelationSummary({
      summaryId: `rs_${person.personId}_${concept}`,
      fromConceptId: person.personId,
      toConceptId: concept,
      relationName: "취미",
      summaryText: "앨리스는 주말마다 등산을 한다",
      confidence: 0.8,
      generatedBy: "llm",
      sourceDocumentId: docId,
    });

    const detail = await getConceptDetail(h.app, person.personId);
    expect(detail.status).toBe(200);
    // 사람 이름이 정직하게 회신된다(persons.display_name).
    expect(detail.body.concept.concept_id).toBe(person.personId);
    expect(detail.body.concept.name).toBe("앨리스");
    // 그 사람의 관계가 회신되고 상대(개념 등산) 이름이 보강된다.
    expect(detail.body.relation_summaries.length).toBe(1);
    const rel = detail.body.relation_summaries[0]!;
    expect(rel.relation_name).toBe("취미");
    expect(rel.summary_text).toBe("앨리스는 주말마다 등산을 한다");
    expect(rel.edge_present).toBe(true);
    expect(rel.other_concept_id).toBe(concept);
    expect(rel.other_concept_name).toBe("등산");
  });

  test("개념 상세에서 상대가 사람(psn_)이면 그 사람 이름이 보강된다", async () => {
    const person = await h.store.findOrCreatePerson({
      userId: "u_bob",
      displayName: "밥",
    });
    const concept = await h.store.findOrCreateConcept("기타");
    const docId = makeDocument(h, "bob");
    // 개념(기타) → 사람(밥). 개념 상세에서 상대(밥) 이름이 persons 로 풀려야 한다.
    await h.store.insertRelationSummary({
      summaryId: `rs_${concept}_${person.personId}`,
      fromConceptId: concept,
      toConceptId: person.personId,
      relationName: "연주자",
      summaryText: "밥은 기타를 친다",
      confidence: 0.4,
      generatedBy: "llm",
      sourceDocumentId: docId,
    });

    const detail = await getConceptDetail(h.app, concept);
    expect(detail.status).toBe(200);
    expect(detail.body.relation_summaries.length).toBe(1);
    const rel = detail.body.relation_summaries[0]!;
    expect(rel.other_concept_id).toBe(person.personId);
    // 상대가 사람이라도 이름이 빈 문자열이 아니라 display_name 으로 보강된다.
    expect(rel.other_concept_name).toBe("밥");
    // confidence 0.4 < 임계 → 보류 라벨.
    expect(rel.edge_present).toBe(false);
  });

  test("관계 0건 사람 → relation_summaries 빈 배열(정직한 빈 표시)", async () => {
    const person = await h.store.findOrCreatePerson({
      userId: "u_carol",
      displayName: "캐럴",
    });
    const detail = await getConceptDetail(h.app, person.personId);
    expect(detail.status).toBe(200);
    expect(detail.body.concept.name).toBe("캐럴");
    expect(detail.body.relation_summaries).toEqual([]);
    expect(detail.body.hierarchy).toEqual([]);
  });

  test("없는 사람 id(psn_) → 404 (빈 상세 위장 금지)", async () => {
    const res = await h.app.request("/api/concepts/psn_does_not_exist");
    expect(res.status).toBe(404);
  });
});
