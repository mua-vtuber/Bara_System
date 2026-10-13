/**
 * plaintext-kind-scope.test.ts — 평문 자동 분류 종류 확정 범위 축소 통합 증명
 * (Task 2 — 콜론 태그 없이 명시하지 않은 평문 단어까지 종류로 자동 확정하던 오작동 수정).
 *
 * 사용자가 `#나, 주로 사용하는 AI는 클로드 코드, 코덱스`를 저장하면 본문 "클로드 코드"의
 * "코드"가 concept_type_vocabulary.yaml material(자료) 하위 어휘(문서·논문·회의록·교재·
 * 코드·데이터)와 겹쳐 글 전체가 material 로 자동 분류되고 "자료" 종류값 노드가 생겼다.
 * 원인은 ingest-text-flow.ts 가 classifyEntityTypeDeterministic 을 직접 불러 콜론 태그 없이도
 * 2단 평문 단어 경계 매칭(source:"seed")만으로 종류를 확정했기 때문이다.
 *
 * Task 2 수정 = explicitContentTypeName(source==='explicit' 일 때만 typeName 인정) 게이트를
 * ingest-text-flow.ts 가 쓰도록 교체. 이 파일은 *실제 POST /ingest 라우트*로 글을 저장해
 * (classification-key-kind-search.test.ts 와 같은 통합 스타일 — 실 SQLite + 실 Bgem3Embedder
 * + buildMemoryApi 전체 앱. Mock 0) 다음을 잠근다:
 *
 *   1. 평문 '클로드 코드, 코덱스' 저장 시 '자료' 종류값 노드가 생기지 않는다(count 0).
 *   2. `#자료:코드` 콜론 명시 저장 시 '자료' 종류값 노드가 생기고 getNodeIdsByConceptName
 *      ('자료') 로 회수된다(explicit 경로는 그대로 살아있다).
 *   3. `#일정:치과` 콜론 명시 저장 시 '일정' 종류값 노드가 생긴다(explicit 게이트가 콜론
 *      경로엔 무영향 — 회귀 0).
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
import { resetConceptTypeVocabularyCache } from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";

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
  dir = mkdtempSync(join(tmpdir(), "bara-plaintext-kind-scope-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const assetStore = new AssetStore(dir);
  const settings = getMemorySettings("/nonexistent-default-plaintext-kind-scope-test", "/nonexistent-default-plaintext-kind-scope-test.secrets.json");
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

/** name 을 가진 종류값(isClassificationValue) 개념 노드 수. */
function kindValueConceptCount(name: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM concept_nodes WHERE name = ? AND is_classification_value = 1",
      )
      .get(name) as { c: number }
  ).c;
}

// ── 1. 평문(콜론 없음) — 종류 확정 0 (버그 재현·수정 증명) ────────────────────

describe("평문 자동 분류 범위 축소 — 콜론 명시 없으면 종류값 0", () => {
  test("평문 '클로드 코드, 코덱스 주로 사용' 저장 시 '자료' 종류값 노드가 생기지 않는다", async () => {
    await ingestText("나, 주로 사용하는 AI는 클로드 코드, 코덱스");

    expect(kindValueConceptCount("자료")).toBe(0);
  });
});

// ── 2. 콜론 명시 — explicit 경로는 그대로 산다 (회귀 0) ───────────────────────

describe("콜론 명시 태그 — explicit 경로 회귀 0", () => {
  test("#자료:코드 콜론 명시 저장 시 '자료' 종류값 노드 생성 + getNodeIdsByConceptName 회수", async () => {
    const nodeId = await ingestText("#자료:코드, 오늘 정리하다가 발견");

    expect(kindValueConceptCount("자료")).toBe(1);
    const recalled = store.getNodeIdsByConceptName("자료");
    expect(recalled.has(nodeId)).toBe(true);
  });

  test("#일정:치과 콜론 명시 저장 시 '일정' 종류값 노드가 생긴다(explicit 게이트 무영향)", async () => {
    const nodeId = await ingestText("#일정:치과, 예약 잡음");

    expect(kindValueConceptCount("일정")).toBe(1);
    const recalled = store.getNodeIdsByConceptName("일정");
    expect(recalled.has(nodeId)).toBe(true);
  });
});
