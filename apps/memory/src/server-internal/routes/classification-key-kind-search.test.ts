/**
 * classification-key-kind-search.test.ts — ②④ 보존 + ①③ 제거 라우트 통합 증명
 * (2026-06-28 "종류" 분류 키 그래프 허브 버그 수정 spec §4.2·§4.5·§7 함정 2·3·8·S0·S4).
 *
 * 채택 해법(후보 b)은 자동 종류 인식이 ①"종류" 부모 키·③"종류"→값 위계선(허브)은 안 만들고
 * ②koName 값 개념·④글→값 classification 엣지(kind 검색 출처)는 그대로 만들게 한다
 * (store.addNodeKindValue 좁은 통로). 이 파일은 *실제 POST /ingest 라우트*로 글을 저장해
 * (ingest 가 addNodeKindValue 를 부르는 통합 경로) 다음을 한꺼번에 잠근다:
 *
 *   1. ②④ 보존(함정 2·완료 기준 4) — 자동 인식된 일정 글이 store.getNodeIdsByConceptName
 *      ("일정") 으로 회수된다(kind 검색 캡슐 retriever.ts:467 의 의존 통로). 검색 회상 복구.
 *   2. ①③ 제거(완료 기준 1) — 같은 글 저장 뒤 "종류"(KIND_CATEGORY) 부모 키 개념 노드 0 +
 *      "종류"→값 위계선(parent_of) 0. 허브가 애초에 안 생긴다.
 *   3. 계산 탭 종류 필터(완료 기준 4 절반) — resolveComputeCandidates 의 .candidates Set 이
 *      자동 인식 글 id 를 담는다(②④ 보존이 갈래값·종류값 모으기를 살린다).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 AssetStore + buildMemoryApi 전체 앱. Mock 0.
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { AssetStore } from "../../assets/asset-store.ts";
import { getMemorySettings } from "../../settings/memory-settings.ts";
import { buildMemoryApi } from "../../server.ts";
import { resolveComputeCandidates } from "../../memory/compute-candidates.ts";
import { resetConceptTypeVocabularyCache } from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import { KIND_CATEGORY } from "../../memory/glob-field-apply.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

let dir: string;
let db: Database;
let store: SqliteMemoryStore;
let app: Hono;

beforeEach(() => {
  resetConceptTypeVocabularyCache();
  resetClassifierCache();
  dir = mkdtempSync(join(tmpdir(), "bara-kind-search-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const assetStore = new AssetStore(dir);
  const settings = getMemorySettings("/nonexistent-default-kind-search-test", "/nonexistent-default-kind-search-test.secrets.json");
  app = buildMemoryApi({
    store,
    retriever,
    assembler,
    assetStore,
    getSettings: () => settings,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── 헬퍼 ────────────────────────────────────────────────────────────────────

/** POST /ingest 텍스트 통로로 글을 저장하고 originNodeId 를 반환한다. */
async function ingestText(data: string): Promise<number> {
  const res = await app.request("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "dashboard:manual",
      content: { type: "text", data },
    }),
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { originNodeId: number | null };
  expect(json.originNodeId).not.toBeNull();
  return json.originNodeId!;
}

/** "종류"(KIND_CATEGORY) 부모 키 개념 행 수(① 허브 키 존재 판정). */
function kindKeyConceptCount(): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM concept_nodes WHERE name = ? AND is_classification_key = 1",
      )
      .get(KIND_CATEGORY) as { c: number }
  ).c;
}

/** "종류" 부모를 source 로 가진 parent_of 위계선 수(③ 허브 선 존재 판정). */
function kindHierarchyEdgeCount(): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM hierarchy_edges h
           JOIN concept_nodes ck ON ck.concept_id = h.source_id
          WHERE h.source_type = 'concept' AND ck.name = ? AND h.relation = 'parent_of'`,
      )
      .get(KIND_CATEGORY) as { c: number }
  ).c;
}

// ── 1. ②④ 보존 — kind 검색이 다시 회상한다 (함정 2·완료 기준 4) ──────────────

describe("②④ 보존 — kind 검색 회상 복구", () => {
  test("자동 인식 일정 글 → getNodeIdsByConceptName('일정') 으로 회수된다(②④ 출처 보존)", async () => {
    const nodeId = await ingestText("#일정:장터당번 설명회 참석, 참석 메모");

    // ② "일정" 값 개념 + ④ 글→값 classification 엣지가 살아 kind 검색 캡슐의 의존 통로
    // (retriever.ts:467 → getNodeIdsByConceptName)가 그 글을 회수한다.
    const recalled = store.getNodeIdsByConceptName("일정");
    expect(recalled.has(nodeId)).toBe(true);
  });

  test("자동 인식 장소 글 → getNodeIdsByConceptName('장소') 으로 회수된다", async () => {
    const nodeId = await ingestText("#장소:한빛의원, 다녀옴");
    const recalled = store.getNodeIdsByConceptName("장소");
    expect(recalled.has(nodeId)).toBe(true);
  });

  test("retriever kind 캡슐 — kind='일정' 검색이 자동 인식 일정 글을 회상한다", async () => {
    const nodeId = await ingestText("#일정:장터당번 설명회 참석, 참석 메모");
    await ingestText("#장소:한빛의원, 다녀옴");

    // retriever 직접 호출(검색 라우트와 같은 통로). kind 캡슐이 "일정" 개념(②)으로 후보를
    // 줄여 일정 글을 회상한다 — ②④ 보존 전이라면 빈 결과였던 그 회상이 살아났다.
    const retriever = new HybridRetriever(store, embedder);
    const hits = await retriever.retrieve("장터당번 설명회", {
      limit: 10,
      kind: "일정",
    });
    expect(hits.map((h) => h.node.id)).toContain(nodeId);
  });
});

// ── 2. ①③ 제거 — 허브 키·위계선이 안 생긴다 (완료 기준 1) ────────────────────

describe("①③ 제거 — 허브 키·위계선 0", () => {
  test('자동 인식 일정 글 저장 뒤 "종류" 부모 키 개념(①)·위계선(③)이 0이다', async () => {
    await ingestText("#일정:장터당번 설명회 참석, 참석 메모");

    // ① "종류" 부모 키 개념이 안 생겼다(허브 키 0).
    expect(kindKeyConceptCount()).toBe(0);
    // ③ "종류"→값 위계선이 안 생겼다(허브 선 0).
    expect(kindHierarchyEdgeCount()).toBe(0);
  });

  test('서로 다른 종류 글 여러 개를 저장해도 "종류" 부모 키·위계선이 0으로 유지된다', async () => {
    await ingestText("#일정:장터당번 설명회 참석, 참석 메모");
    await ingestText("#장소:한빛의원, 다녀옴");
    await ingestText("#작품:데못죽, 재밌게 봤다");

    expect(kindKeyConceptCount()).toBe(0);
    expect(kindHierarchyEdgeCount()).toBe(0);
  });
});

// ── 3. 계산 탭 종류 필터 — ②④ 보존이 후보 모으기를 살린다 (완료 기준 4 절반) ──

describe("계산 탭 종류 필터 — .candidates Set 보존", () => {
  test("자동 인식 일정 글이 resolveComputeCandidates({conceptValue:'일정'}).candidates 에 든다", async () => {
    const a = await ingestText("#일정:장터당번 설명회 참석, 참석 메모");
    const b = await ingestText("#일정:치과, 예약");
    await ingestText("그냥 평범한 메모");

    // ComputeCandidates 의 필드는 candidates(Set)·needsCondition 둘뿐 — nodeIds 없음
    // (spec §7 S4 노트). 자동 인식 ②④가 "일정" 개념을 살려 계산 탭이 두 일정 글을 모은다.
    const cand = resolveComputeCandidates(store, { conceptValue: "일정" });
    expect(cand.needsCondition).toBe(false);
    expect(cand.candidates.has(a)).toBe(true);
    expect(cand.candidates.has(b)).toBe(true);
  });
});
