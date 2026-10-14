/**
 * server-internal/routes/ingest.test.ts — POST /ingest 통합 검증 (Phase 14a T12).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 AssetStore(tmp dir).
 * mock 객체 없음(CLAUDE.md "테스트 정책").
 *
 * 검증 가족:
 *   (a) 순수 글(type='text') → 원본 노드 1개(content=원문) + 자산·documents 없음 (Task 3)
 *   (b) 같은 글 두 번 → asset_files 0 + 노드 각각 (글은 자산 dedup 통로 아님)
 *   (c) base64 docx → canonicalize Tier1 → document + chunk + detection.kind='docx'
 *   (d) base64 scanned PDF → markdown=null → document 노드만(청크 0) + warnings 포함
 *   (e) Discord attribution → 메타데이터만 보존 / 다른 출처 → authored_by 엣지
 *   (f) 잘못된 body(content 없음) → 400
 *   (g) 자동 type 감지(파일 통로 type='auto') — 회의 일시: → meeting_log / [Scene → scenario / 기본 free
 *   (L) 대시보드 경로 — type="auto" + image mimeType + base64 → image 분기 정상 저장
 *       (Phase 11d 회귀 게이트 — 옛 봇 전용 type="image" 케이스가 못 잡던 갭).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
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
import type { ImageEmbedder } from "../../embedding/types.ts";
import {
  setEntityTypeOverride,
  setConceptVocabOverride,
  clearConceptVocabularyOverrides,
  loadConceptTypeVocabulary,
  type ConceptTypeVocabulary,
  type PlacementTypeName,
} from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import { originalExt } from "./ingest.ts";
import { createAuthGate } from "../auth-gate.ts";
import { SseTokenStore } from "../../federation/sse-tokens.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import { startProviderStandIn } from "../../test-utils/provider-stand-in.ts";

// ── 테스트 전역 ─────────────────────────────────────────────────────────────

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

// ── 테스트별 harness ────────────────────────────────────────────────────────

let dir: string;
let db: Database;
let store: SqliteMemoryStore;
let app: Hono;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-ingest-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const assetStore = new AssetStore(dir);
  // getMemorySettings 는 nonexistent path 에서 default 반환 (settings.ts 동작 정합).
  const settings = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
  app = buildMemoryApi({ store, retriever, assembler, assetStore, getSettings: () => settings });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── 응답 타입 (검증 전용) ────────────────────────────────────────────────────

interface IngestResponse {
  ok: boolean;
  assetSha256: string;
  documentId: string;
  nodeIds: number[];
  cacheHit: boolean;
  warnings: string[];
  detection: { kind: string; extractedCharCount: number; scannedPdf?: boolean; pageCount?: number } | null;
  parse: {
    status: string;
    method: string;
    originalAssetSha256: string;
    canonicalAssetSha256?: string;
    errorMessage?: string;
  };
  // spec §5 일관성 — 문서 청크(source_type='document_chunk')의 backfill 추출 대기 수.
  // 텍스트 갈래 pendingChunks 와 칸 이름 정합. 스캔 PDF 등 청크 0 이면 0.
  pendingChunks: number;
}

/**
 * content.type='text'(순수 타이핑 글) 응답 — 입력 통로 통합 spec §3 / Task 3.
 * 글은 자산·documents 행을 만들지 않으므로 assetSha256/documentId/detection 이 없고,
 * saveTextInput 산출(원본 노드 + 길이 조건부 청크)을 그대로 회신한다.
 */
interface TextIngestResponse {
  ok: boolean;
  type: "text";
  nodeIds: number[];
  originNodeId: number;
  chunkNodeIds: number[];
  title: string;
}

interface EntityPatchIngestResponse {
  ok: boolean;
  type: "entity_patch";
  id: null;
  nodeIds: [];
  originNodeId: null;
  entities: Array<{ typeName: string; id: string }>;
  warnings: string[];
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────

/**
 * /search 로 종류 배지(kind 칸)를 확인한다(2026-06-28 "종류" 허브 버그 수정 spec §4.3 B —
 * 배지는 결과 글 본문 typeName 으로 산출). query 로 검색해 nodeId 결과의 kind 를 반환한다.
 * 결과에 안 들면 null(검색 미도달 — 호출처가 판정).
 */
async function searchKind(
  app: Hono,
  query: string,
  nodeId: number,
): Promise<string | null> {
  const res = await app.request("/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, limit: 20 }),
  });
  const json = (await res.json()) as {
    results: Array<{ id: number; kind: string | null }>;
  };
  return json.results.find((r) => r.id === nodeId)?.kind ?? null;
}

// ── 테스트 가족 ─────────────────────────────────────────────────────────────

describe("POST /ingest", () => {
  test("secret guard proves a rejected text write without persisting the raw node", async () => {
    const res = await app.request("/ingest", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "123e4567-e89b-42d3-a456-426614174999", source: "pet",
        content: { type: "text", data: `토큰 ghp_${"x".repeat(36)}` } }) });
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe("SECRET_DETECTED");
    expect(res.headers.get("X-Ingest-Retryable")).toBe("true");
    expect((db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n).toBe(0);
    const corrected = await app.request("/ingest", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "123e4567-e89b-42d3-a456-426614174999", source: "pet",
        content: { type: "text", data: "비밀값을 지운 기록" } }) });
    expect(corrected.status).toBe(201);
    expect((db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n).toBe(1);
  });

  test("authenticated receipt lookup is scoped to the writing adapter", async () => {
    const tokens = new SseTokenStore(join(dir, "receipt-tokens.json"));
    const owner = tokens.issueToken("pet-a", undefined, undefined, "mcp-standard");
    const other = tokens.issueToken("pet-b", undefined, undefined, "read-only");
    const secured = new Hono();
    secured.use(
      "*",
      createAuthGate({
        sseTokens: tokens,
        remoteAddrOf: () => "127.0.0.1",
        getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
      }),
    );
    secured.route("/", app);
    const requestId = "123e4567-e89b-42d3-a456-426614174001";
    const saved = await secured.request("/ingest", { method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId, source: "pet", content: { type: "text", data: "같은 요청은 작성자만 확인한다" } }) });
    expect(saved.status).toBe(201);
    const own = await secured.request(`/ingest/status/${requestId}`, { headers: { authorization: `Bearer ${owner}` } });
    expect(await own.json()).toMatchObject({ state: "saved" });
    const stranger = await secured.request(`/ingest/status/${requestId}`, { headers: { authorization: `Bearer ${other}` } });
    expect(await stranger.json()).toEqual({ state: "unknown" });
    expect((await secured.request(`/ingest/status/${requestId}`)).status).toBe(401);
  });

  test("explicit capture is stored on the raw origin and invalid capture writes nothing", async () => {
    const content = { type: "text", data: "반려 새 UI는 조금 더 작게 만들자" };
    const bad = await app.request("/ingest", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "pet", content, capture: { kind: "auto", source: "ai" } }) });
    expect(bad.status).toBe(400);
    expect((db.query("SELECT count(*) AS count FROM knowledge_nodes").get() as { count: number }).count).toBe(0);

    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    const good = await app.request("/ingest", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, source: "pet", content, capture: { kind: "decision", source: "user" } }) });
    expect(good.status).toBe(201);
    const saved = await good.json() as { originNodeId: number };
    expect((await store.getNode(saved.originNodeId))?.metadata.capture).toEqual({ kind: "decision", source: "user" });
    const receipt = await app.request(`/ingest/status/${requestId}`);
    expect(await receipt.json()).toMatchObject({ state: "saved", result: { originNodeId: saved.originNodeId } });

    const ai = await app.request("/ingest", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "pet", content, capture: { kind: "task", source: "ai" } }) });
    expect(ai.status).toBe(201);
    expect((await store.getNode(saved.originNodeId))?.metadata.capture).toEqual({ kind: "decision", source: "user" });

    const cleared = await app.request("/ingest", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "pet", content, capture: null }) });
    expect(cleared.status).toBe(201);
    expect((await store.getNode(saved.originNodeId))?.metadata.capture).toBeUndefined();
  });

  test("file ingest attaches capture to its document origin", async () => {
    const res = await app.request("/ingest", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "pet", content: { type: "text", data: "파일 안의 결정 원문", originalName: "decision.md" },
        capture: { kind: "decision", source: "user" } }) });
    expect(res.status).toBe(201);
    const body = await res.json() as { nodeIds: number[] };
    expect((await store.getNode(body.nodeIds[0]!))?.metadata.capture).toEqual({ kind: "decision", source: "user" });
  });

  // ── (a) 순수 타이핑 글 ingest 기본 흐름 (입력 통로 통합 spec §3·D1) ──────────
  // content.type='text' 이고 originalName 이 없을 때만 "사용자가 친 글"이다.
  // 자산·documents 없이 원본 한 노드만(짧으면). originalName 있는 .txt/.md 는 (a2) 가
  // 파일 통로(자산 보존 + documents)로 검증한다(spec D4 정합).
  test("짧은 타이핑 글(type='text', originalName 없음) → ok + 원본 노드 1개 + 자산·documents 없음", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "text",
          data: "바라 시스템 개요\n\n바라는 콘텐츠 어디든 붙어 쓸 수 있는 메모리 모듈입니다.",
          // 순수 타이핑 글 = originalName 없음(대시보드 buildTextPayload 정합).
        },
        attribution: { author: "테스터", userId: "u-test-1" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;
    expect(json.ok).toBe(true);
    expect(json.type).toBe("text");
    // 짧은 글 → 원본 노드 1개만 (청크 0)
    expect(json.nodeIds.length).toBe(1);
    expect(json.chunkNodeIds.length).toBe(0);
    expect(json.nodeIds[0]).toBe(json.originNodeId);
    // 원본 노드 content = 원문 전체 (안 잘림)
    const node = await store.getNode(json.originNodeId);
    expect(node?.content).toBe(
      "바라 시스템 개요\n\n바라는 콘텐츠 어디든 붙어 쓸 수 있는 메모리 모듈입니다.",
    );
    expect(node?.sourceType).toBe("auto_capture");
    // 타이핑 글은 자산·documents 행을 만들지 않는다 (고아 메타 회피 / spec §3 P1)
    const assetCnt = (
      db.prepare("SELECT COUNT(*) AS c FROM asset_files").get() as { c: number }
    ).c;
    expect(assetCnt).toBe(0);
    const docCnt = (
      db.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number }
    ).c;
    expect(docCnt).toBe(0);
  });

  // ── (a1.5) entity-only 순수 타이핑 → 글 노드 없이 엔티티 패치 ────────────────
  // 본문 없이 `#사람:`·`#직업:` 같은 엔티티 정보만 있는 입력은 글이 아니므로
  // /ingest 텍스트 갈래도 saveTextInput 공통 판정을 따라 entity_patch 로 응답한다.
  // 라벨만 등록(F3 Q21) 규칙은 유지되어 철수 persons 행과 '직업:개발자' 라벨은 생긴다.
  test("(a1.5) 순수 타이핑 entity-only #사람:철수 #직업:개발자 → entity_patch + 사람/라벨", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "text",
          data: "#사람:철수 #직업:개발자",
          // 순수 타이핑 글 = originalName 없음.
        },
        attribution: { author: "테스터", userId: "u-entity-1" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as EntityPatchIngestResponse;
    expect(json.ok).toBe(true);
    expect(json.type).toBe("entity_patch");
    expect(json.id).toBeNull();
    expect(json.originNodeId).toBeNull();
    expect(json.nodeIds).toEqual([]);

    // 라벨만 있어도 철수가 persons 행으로 등록된다(F3 Q21 — 라벨만으로 등록).
    const person = await store.findPersonByName("철수");
    expect(person).not.toBeNull();
    expect(json.entities).toContainEqual({ typeName: "person", id: person!.personId });

    // 직업:개발자 라벨이 has_attribute 로 철수에 잇혔다(value 개념 '개발자').
    const devId = await store.findOrCreateConcept("개발자");
    const personsWithDev = store.getPersonsByAttributeConcept(devId);
    expect(personsWithDev).toContain(person!.personId);
    const nodeCount = (
      db.prepare("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }
    ).n;
    expect(nodeCount).toBe(0);
  });

  // ── (a1.6) 엔티티 해시태그 없는 타이핑 글 → 엔티티 wiring no-op ───────────────
  // 엔티티 해시태그(`#사람:`·`#직업:` 등)가 없으면 wireHashtagEntitiesSafe 가 새 사람·
  // 라벨을 만들지 않는다 — 기존 동작이 그대로 유지됨을 단언(회귀 불변 / 가짜 사람 0).
  // 작성자(author) 사람 노드는 linkAuthorPerson 이 만드는 *별 갈래*라 본 wiring 무관 —
  // 여기선 엔티티 선언이 만든 사람·라벨이 0임을 정확히 단언한다.
  test("(a1.6) 엔티티 해시태그 없는 타이핑 글 → 엔티티 선언 사람·라벨 0 (wiring no-op)", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "text",
          data: "오늘 메모리 모듈 설계를 정리했습니다.",
        },
        attribution: { author: "테스터", userId: "u-entity-2" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;
    expect(json.type).toBe("text");
    // 엔티티 선언이 없으니 '철수' 같은 선언 사람은 0 (가짜 사람 생성 0).
    expect(await store.findPersonByName("철수")).toBeNull();
    // 엔티티 라벨 0 — '개발자' 라벨을 가진 사람이 없다(가짜 라벨 0).
    const devId = await store.findOrCreateConcept("개발자");
    expect(store.getPersonsByAttributeConcept(devId)).toEqual([]);
  });

  // ── (a3) 종류 영속화(②④) + 글-칸 + 일정 날짜 저장 (단계6 T3b / 2026-06-28 후보 b) ──
  // 2026-06-28 "종류" 허브 버그 수정(spec §4.2·§4.3 B) — 자동 인식한 종류는 ②값 개념 +
  // ④글 엣지만 만든다(①"종류" 부모 키·③위계선은 안 만듦). 그래서 검색(getNodeIdsByConcept
  // Name·④)은 그대로 잡히지만, 표시 통로가 옛 getNodeKind(③위계 JOIN)에서 글 본문 typeName
  // 배지(검색 응답 kind 칸)로 옮겨갔다. 종류 신호는 본문 콜론(`#가계부:`)으로 적는다 —
  // 드롭다운 body.kind 통로는 S8 에서 UI 가 사라진 옛 통로다(spec §2.2). 글-칸·event_at 은
  // 본문 # 태그 통로로 그대로 채워진다.
  test("(a3) 본문 #일정 종류 → 종류 분류 링크가 검색(getNodeIdsByConceptName)·표시(응답 kind) 양쪽에 잡힌다(②④ 보존)", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: { type: "text", data: "#일정:치과, 예약 메모" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;
    // ②④ — 종류값("일정") 개념이 글에 잇혀 검색 통로(개념명→글 id)에 잡힌다(kind 검색 출처).
    expect(store.getNodeIdsByConceptName("일정").has(json.originNodeId)).toBe(true);
    // 표시 통로 — 검색 응답 kind 배지가 본문 typeName(schedule→일정)으로 종류를 보여준다.
    const badge = await searchKind(app, "치과 예약", json.originNodeId);
    expect(badge).toBe("일정");
  });

  test("(a3) 종류 멱등 — 같은 본문이 두 번 분류돼도 종류 링크 중복 0", async () => {
    // 같은 본문을 두 번 입력해도 종류 round-trip 이 한 번과 같다(addNodeKindValue 멱등 —
    // findOrCreateConcept 이름 UNIQUE + INSERT OR IGNORE). 두 번째는 별 글·별 originNodeId.
    const post = () =>
      app.request("/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "dashboard:manual",
          content: { type: "text", data: "#일정:병원, 정기 검진" },
        }),
      });
    const a = (await (await post()).json()) as TextIngestResponse;
    const b = (await (await post()).json()) as TextIngestResponse;
    // 두 글 모두 같은 종류 개념(이름 UNIQUE 한 행 재사용)에 검색으로 잡힌다(②④).
    const ids = store.getNodeIdsByConceptName("일정");
    expect(ids.has(a.originNodeId)).toBe(true);
    expect(ids.has(b.originNodeId)).toBe(true);
  });

  test("(a3) intake 칸(유통기한) — fields 와 #유통기한 해시태그가 같은 metadata_json.fields 칸으로 수렴", async () => {
    // 폼 fields={유통기한} 과 본문 #유통기한:... 이 같은 칸 키로 수렴(spec §5). intake 종류는
    // columnLabels 에 {유통기한: expiresAt} 가 있어 그 칸만 글-칸으로 받는다. 종류는 본문
    // `#섭취:` 콜론으로 자동 인식돼 글-칸 게이트(contentTypeName=intake)가 열린다.
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: { type: "text", data: "#섭취:우유, 한 통" },
        fields: { 유통기한: "2026-07-01" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;
    const node = await store.getNode(json.originNodeId);
    expect((node?.metadata.fields as Record<string, string>)?.유통기한).toBe("2026-07-01");
    const sources = node?.metadata.fieldSources as Record<string, string>;
    expect(sources["fields.유통기한"]).toBe("direct");
  });

  test("(a3) 정의 밖 칸 키는 글-칸으로 안 들어간다(intake 의 칸 아닌 #금액)", async () => {
    // intake 종류 칸은 {유통기한} 뿐 — 본문 #금액:3000 은 intake 칸이 아니라 글-칸 0.
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: { type: "text", data: "우유 한 통 #금액:3000" },
        kind: "intake",
      }),
    });
    const json = (await res.json()) as TextIngestResponse;
    const node = await store.getNode(json.originNodeId);
    // 글-칸이 0이면 fields 키 자체가 없거나 빈 객체 — 둘 다 "금액 칸 없음" 의 정직한 사실.
    const fields = (node?.metadata.fields as Record<string, string> | undefined) ?? {};
    expect(fields.금액).toBeUndefined();
  });

  test("(a3) eventAt·eventUntil → event_at/event_until 에 direct 로 저장", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: { type: "text", data: "여행 일정" },
        kind: "schedule",
        eventAt: "2026-07-10",
        eventUntil: "2026-07-15",
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;
    const node = await store.getNode(json.originNodeId);
    expect(node?.eventAt).toBe("2026-07-10");
    expect(node?.eventUntil).toBe("2026-07-15");
    const sources = node?.metadata.fieldSources as Record<string, string>;
    expect(sources.event_at).toBe("direct");
    expect(sources.event_until).toBe("direct");
  });

  test("(a3) kind 미전달이면 종류 분류 0개 + 글-칸 0 (0 diff·정직한 빈 상태)", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: { type: "text", data: "그냥 메모" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;
    expect(store.getNodeKind(json.originNodeId)).toBeNull();
    const node = await store.getNode(json.originNodeId);
    // kind 미전달 = 글-칸 추출 자체를 건너뜀(fields 키 없음).
    expect(node?.metadata.fields).toBeUndefined();
  });

  test("(a3 충돌점검) 본문 #일정 종류 → 종류 분류값('일정')이 schedule 콜론 위계와 안 엉킨다", async () => {
    // 충돌 경고 점검 — 자동 인식 종류값 '일정'(②) 이 schedule placement 위계('일정' 콜론
    // 위계)와 같은 concept_nodes 행(이름 UNIQUE)을 공유한다. ②④만 만들고 ①③ 허브 위계는
    // 안 만드므로 위계가 엉키지 않고 종류값 round-trip(검색 매칭)이 깨지지 않음을 실증한다.
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: { type: "text", data: "#일정:병원, 예약" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;
    // 종류값 '일정'(②④) 이 그대로 round-trip 된다(검색 매칭).
    expect(store.getNodeIdsByConceptName("일정").has(json.originNodeId)).toBe(true);
    // 표시 배지도 본문 typeName 으로 '일정'.
    const badge = await searchKind(app, "병원 예약", json.originNodeId);
    expect(badge).toBe("일정");
  });

  // ── (a3 옵션 B·spec 2026-06-28 S3) 일정 전용 날짜 칸 제거 통합 검증 ────────────────
  // 본문 `#일정:치과 #날짜:...` 입력을 실 DB·실 임베딩 라우트로 흘려, 일정의 전용 날짜 칸을
  // 뺀 결과를 끝-끝으로 증명한다. 핵심(spec Completion Criteria 3 옵션 B):
  //   ① 종류=schedule 으로 정상 분류된다(일정 종류는 칸을 잃어도 그대로 산다).
  //   ② "날짜" 가 schedule 글-칸(metadata.fields)으로 안 들어간다 — kindColumnKeys('schedule')
  //      가 []라 collectGlobFields 의 allowed 에 '날짜' 가 없다(옛 함정 글-칸 경로 닫힘).
  //
  // 일정 날짜의 정상 통로는 글 event_at 하나다(spec 일원화). 본문 #날짜: 는 reserved key
  // node_field 통로(hashtag-reserved-keys '날짜' → event_at)로 글 event_at 을 채우는데, 그
  // 통로의 값 풀이(extractEventDateTime)는 *한국어 날짜 표현*("7월 15일")을 푼다(ISO 문자열은
  // 안 푼다). 그 통로가 schedule 칸과 별개로 살아 있음을 둘째 테스트가 한국어 날짜로 증명한다.
  test("(a3 옵션 B) 본문 #일정:치과 #날짜:2026-07-15 → 분류 정상·schedule 글-칸 0(함정 경로 닫힘)", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: { type: "text", data: "#일정:치과 #날짜:2026-07-15, 정기 검진" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;

    // ① 종류=일정 분류 정상(일정 종류는 칸을 잃어도 종류로 남는다). 본문 `#일정:` 의 사용자
    //    어휘로 자동 인식돼 종류값('일정') 검색 매칭(②④)이 산다. 표시 배지도 본문 typeName
    //    (schedule→일정)으로 산출된다(2026-06-28 spec §4.3 B — 옛 getNodeKind ③위계 통로 폐기).
    expect(store.getNodeIdsByConceptName("일정").has(json.originNodeId)).toBe(true);
    const badge = await searchKind(app, "치과 정기 검진", json.originNodeId);
    expect(badge).toBe("일정");

    // ② "날짜" 가 schedule 글-칸으로 안 들어간다 — 글-칸 0(함정 경로 닫힘·spec §2.2 ①).
    const node = await store.getNode(json.originNodeId);
    const fields = (node?.metadata.fields as Record<string, string> | undefined) ?? {};
    expect(fields.날짜).toBeUndefined();
  });

  test("(a3 옵션 B) 본문 #일정:치과 #날짜:<한국어 날짜> → 글 event_at 으로 direct(정상 통로 살아 있음)", async () => {
    // 일정 날짜의 단일 정상 통로 = 글 event_at. reserved key '날짜' 가 event_at 으로 흐르고
    // extractEventDateTime 이 한국어 날짜를 푼다 — schedule 전용 칸과 별개라 칸 제거 뒤에도 산다.
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: { type: "text", data: "#일정:치과 #날짜:7월 15일, 정기 검진" },
        kind: "schedule",
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;
    const node = await store.getNode(json.originNodeId);

    // 글 event_at 이 채워진다(연도는 입력 시점 기준 — 날짜 부분 -07-15 만 단언해 시점 의존 회피).
    expect(node?.eventAt).not.toBeNull();
    expect(node?.eventAt).toContain("-07-15");
    const sources = node?.metadata.fieldSources as Record<string, string>;
    expect(sources.event_at).toBe("direct");
    // 글-칸(schedule 칸)에는 여전히 "날짜" 가 안 들어간다(칸 통로는 닫힘).
    const fields = (node?.metadata.fields as Record<string, string> | undefined) ?? {};
    expect(fields.날짜).toBeUndefined();
  });

  // ── (a2) .txt/.md 텍스트 파일 (type='text' + originalName) → 파일 통로 (spec D4) ──
  // content.type='text' 이지만 originalName 이 있으면 사용자가 파일을 올린 보관 의도다.
  // spec §3/D4("파일은 길이 무관하게 원본 자산까지 보존")에 따라 PDF·docx 와 같은 파일
  // 취급 — 원본 자산(asset_files) 보존 + canonicalize passthrough + documents 행 +
  // document/chunk 노드 + documentId 응답. 텍스트라 canonicalize 가 passthrough 다.
  test(".md 텍스트 파일(type='text' + originalName) → 원본 자산 보존 + documents + documentId", async () => {
    const data = "바라 시스템 개요\n\n바라는 콘텐츠 어디든 붙어 쓸 수 있는 메모리 모듈입니다.";
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "text",
          data,
          mimeType: "text/markdown",
          originalName: "overview.md",
        },
        attribution: { author: "테스터", userId: "u-test-1" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse;
    expect(json.ok).toBe(true);
    // 파일 통로 응답 — documentId + assetSha256 + passthrough detection.
    expect(json.documentId).toMatch(/^doc_/);
    expect(json.assetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(json.detection).not.toBeNull();
    expect(json.detection!.kind).toBe("passthrough");
    // 텍스트 파일도 원본 자산을 보존한다 (spec D4)
    const assetCnt = (
      db.prepare("SELECT COUNT(*) AS c FROM asset_files").get() as { c: number }
    ).c;
    expect(assetCnt).toBeGreaterThanOrEqual(1);
    // documents 행 + document 노드 — passthrough markdown 원문 보존.
    const doc = store.getDocument(json.documentId);
    expect(doc).not.toBeNull();
    expect(doc!.assetSha256).toBe(json.assetSha256);
    const documentNode = await store.getNode(json.nodeIds[0] as number);
    expect(documentNode?.content).toBe(data);
  });

  test("Markdown 파일에 heading 이 있으면 heading_path metadata 를 청크에 저장한다", async () => {
    const data = "# 바라 시스템\n\n콘텐츠 어디든 붙어 쓸 수 있는 메모리 모듈입니다.";
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "text",
          data,
          mimeType: "text/markdown",
          originalName: "heading-overview.md",
        },
        attribution: { author: "테스터", userId: "u-test-heading" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse;
    expect(json.nodeIds.length).toBeGreaterThanOrEqual(2);

    const chunk = await store.getNode(json.nodeIds[1] as number);
    expect(chunk?.sourceType).toBe("document_chunk");
    expect(chunk?.content.startsWith("# 바라 시스템\n")).toBe(true);
    const metadata = chunk?.metadata as Record<string, unknown>;
    expect(metadata.chunkingStrategy).toBe("heading_path");
    expect(metadata.headingPath).toEqual(["바라 시스템"]);
    expect(metadata.headingTitle).toBe("바라 시스템");
    expect(metadata.headingDepth).toBe(1);
    expect(metadata.parentHeadingPath).toEqual([]);
    expect(metadata.sectionChunkIndex).toBe(0);
    expect(metadata.sectionChunkCount).toBe(1);
  });

  // ── (b) 같은 .md 파일 두 번 → 원본 자산 dedup (같은 sha 재사용) ──────────────
  // .txt/.md 텍스트 파일은 파일 통로라 원본 자산을 보존하고, 같은 내용이면 sha 가 같아
  // 자산이 한 번만 저장된다(cacheHit). documents 행은 입력마다 새로 생긴다.
  test("같은 .md 파일 두 번 → asset_files 1행(sha dedup) + documents 두 개", async () => {
    const requestBody = JSON.stringify({
      source: "dashboard:manual",
      content: { type: "text", data: "같은 내용입니다.", mimeType: "text/markdown", originalName: "s.md" },
      attribution: { author: "u", userId: "u1" },
    });
    const r1 = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    const j1 = (await r1.json()) as IngestResponse;
    expect(r1.status).toBe(201);
    expect(j1.cacheHit).toBe(false);

    const r2 = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    const j2 = (await r2.json()) as IngestResponse;
    expect(r2.status).toBe(201);
    // 같은 내용 = 같은 sha → 두 번째는 원본 자산 재사용(cacheHit).
    expect(j2.cacheHit).toBe(true);
    // asset_files 는 한 sha 한 행만 (자산 dedup).
    const assetCnt = (
      db.prepare("SELECT COUNT(*) AS c FROM asset_files").get() as { c: number }
    ).c;
    expect(assetCnt).toBe(1);
    // documents 행은 입력마다 새로 생긴다 (서로 다른 documentId).
    expect(j2.documentId).not.toBe(j1.documentId);
  });

  // ── (c) base64 docx → Tier1 변환 + detection.kind='docx' ────────────────
  test("base64 docx → canonicalize Tier1 → detection.kind='docx'", async () => {
    const docxPath = join(
      import.meta.dir,
      "../../memory/canonicalize/__fixtures__/minimal.docx",
    );
    const docxBytes = readFileSync(docxPath);
    const base64 = Buffer.from(docxBytes).toString("base64");

    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "auto",
          data: base64,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          originalName: "minimal.docx",
        },
        attribution: { author: "테스터", userId: "u-docx-1" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse;
    expect(json.ok).toBe(true);
    expect(json.detection).not.toBeNull();
    expect(json.detection!.kind).toBe("docx");
    expect(json.documentId).toMatch(/^doc_/);
    // docx 변환 성공 → chunk 있음
    expect(json.nodeIds.length).toBeGreaterThanOrEqual(1);
    expect(json.warnings).toEqual([]);
    // spec §5 일관성 — pendingChunks = 청크 수(= nodeIds 에서 document 노드 1 뺀 수).
    // 문서 청크도 backfill 추출 대상이라 대시보드가 "추출 대기 N개"를 같은 규칙으로 표시.
    expect(json.pendingChunks).toBe(json.nodeIds.length - 1);
  });

  test("텍스트 레이어 PDF ingest 는 paragraph 전략 metadata 로 저장하고 heading metadata 를 만들지 않는다", async () => {
    const pdfPath = join(
      import.meta.dir,
      "../../memory/canonicalize/__fixtures__/text.pdf",
    );
    const pdfBytes = readFileSync(pdfPath);
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "auto",
          data: Buffer.from(pdfBytes).toString("base64"),
          mimeType: "application/pdf",
          originalName: "text.pdf",
        },
        attribution: { author: "테스터", userId: "u-pdf-text" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse;
    expect(json.detection?.kind).toBe("pdf");
    expect(json.detection?.scannedPdf).toBe(false);
    expect(json.nodeIds.length).toBeGreaterThanOrEqual(2);

    const chunk = await store.getNode(json.nodeIds[1] as number);
    expect(chunk?.sourceType).toBe("document_chunk");
    const metadata = chunk?.metadata as Record<string, unknown>;
    expect(metadata.chunkingStrategy).toBe("paragraph");
    expect(metadata.headingPath).toBeUndefined();
    expect(metadata.headingTitle).toBeUndefined();
    expect(metadata.headingDepth).toBeUndefined();
    expect(metadata.sectionChunkIndex).toBeUndefined();
    expect(metadata.sectionChunkCount).toBeUndefined();
  });

  // ── (d) 스캔 PDF → markdown=null → document 노드만 + warnings ──────────────
  test("스캔 PDF → document 노드만(청크 0) + warnings에 '검색 안 됨' 포함", async () => {
    const scannedPath = join(
      import.meta.dir,
      "../../memory/canonicalize/__fixtures__/scanned.pdf",
    );
    const pdfBytes = readFileSync(scannedPath);
    const base64 = Buffer.from(pdfBytes).toString("base64");

    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "auto",
          data: base64,
          mimeType: "application/pdf",
          originalName: "scanned.pdf",
        },
        attribution: { author: "테스터", userId: "u-scan-1" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse;
    expect(json.ok).toBe(true);
    expect(json.detection).not.toBeNull();
    expect(json.detection!.scannedPdf).toBe(true);
    expect(json.parse.status).toBe("needs_ocr");
    expect(json.parse.method).toBe("tier1");
    expect(json.parse.originalAssetSha256).toBe(json.assetSha256);
    // 스캔 PDF → 청크 0 → document 노드 1개만
    expect(json.nodeIds.length).toBe(1);
    // 청크 0 → pendingChunks 0 (대시보드가 "추출 대기" 줄을 만들지 않는다 — 정직한 0).
    expect(json.pendingChunks).toBe(0);
    // warnings 에 "검색 안 됨" 포함
    expect(json.warnings.some((w) => w.includes("검색 안 됨"))).toBe(true);
    // documents.asset_sha256 = 원본(orig.sha256) 가리킴
    const doc = store.getDocument(json.documentId);
    expect(doc).not.toBeNull();
    expect(doc!.assetSha256).toBe(json.assetSha256);
    expect((doc!.sourceMetadata.parse as { status: string }).status).toBe("needs_ocr");
  });

  test("깨진 PDF → parse_failed 문서로 원본 보존 + OCR 후보 노출", async () => {
    const brokenBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x62, 0x72, 0x6f, 0x6b]);
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "auto",
          data: Buffer.from(brokenBytes).toString("base64"),
          mimeType: "application/pdf",
          originalName: "broken.pdf",
        },
        attribution: { author: "테스터", userId: "u-broken-1" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse;
    expect(json.detection).toBeNull();
    expect(json.parse.status).toBe("parse_failed");
    expect(json.nodeIds.length).toBe(1);
    expect(json.pendingChunks).toBe(0);

    const doc = store.getDocument(json.documentId);
    expect(doc).not.toBeNull();
    expect(doc!.assetSha256).toBe(json.assetSha256);

    const candidatesRes = await app.request("/api/documents/ocr-candidates");
    expect(candidatesRes.status).toBe(200);
    const candidatesJson = (await candidatesRes.json()) as {
      candidates: Array<{ documentId: string; parse: { status: string } | null }>;
    };
    expect(
      candidatesJson.candidates.some(
        (candidate) =>
          candidate.documentId === json.documentId &&
          candidate.parse?.status === "parse_failed",
      ),
    ).toBe(true);
  });

  test.each([
    {
      name: "짧은 글",
      source: "discord-channel",
      content: { type: "text", data: "디스코드에서 작성한 메모를 보존합니다." },
      parseStatus: null,
    },
    {
      name: "Markdown 문서",
      source: "discord:dm",
      content: {
        type: "text",
        data: "# 디스코드 문서\n\n파일의 작성자 정보도 함께 보존합니다.",
        mimeType: "text/markdown",
        originalName: "discord-attribution.md",
      },
      parseStatus: "text_succeeded",
    },
    {
      name: "파싱 실패 문서",
      source: "discord",
      content: {
        type: "auto",
        data: Buffer.from("%PDF-broken").toString("base64"),
        mimeType: "application/pdf",
        originalName: "discord-broken.pdf",
      },
      parseStatus: "parse_failed",
    },
  ])("Discord $name → 작성자 메타데이터 보존 + 자동 사람 생성 없음", async ({ source, content, parseStatus }) => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source,
        content,
        attribution: { author: "디스코드 작성자", userId: "discord-user-attribution" },
        hashtags: ["보존검증"],
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse | TextIngestResponse;
    if (parseStatus !== null) {
      expect((json as IngestResponse).parse.status).toBe(parseStatus);
    } else {
      expect((json as TextIngestResponse).type).toBe("text");
    }

    const nodeId = json.nodeIds[0]!;
    const node = await store.getNode(nodeId);
    expect(node?.author).toBe("디스코드 작성자");
    expect(node?.metadata).toMatchObject({
      user_id: "discord-user-attribution",
      source,
      tags: ["보존검증"],
    });
    expect(await store.listPersons({ limit: 10 })).toHaveLength(0);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
    expect(db.prepare("SELECT entity_id FROM entities WHERE type_name = 'person'").get()).toBeNull();
  });

  // ── (e) 다른 출처의 attribution → authored_by 엣지 ────────────────────────
  test("attribution author+userId → authored_by 엣지 생성", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "text",
          data: "작성자 추적 검증용 문서입니다.",
          mimeType: "text/markdown",
          originalName: "attr.md",
        },
        attribution: { author: "작성자이름", userId: "u-attr-99" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse;
    expect(json.nodeIds.length).toBeGreaterThanOrEqual(1);
    const documentNodeId = json.nodeIds[0] as number;

    // node_person_edges 에 authored_by 엣지가 생겼는지 확인
    const edge = db
      .prepare(
        "SELECT * FROM node_person_edges WHERE node_id=? AND relation='authored_by'",
      )
      .get(documentNodeId) as { node_id: number; person_id: string; relation: string } | null;
    expect(edge).not.toBeNull();
    expect(edge!.relation).toBe("authored_by");
  });

  // ── (f) 잘못된 body → 400 ──────────────────────────────────────────────────
  test("content 없음 → 400 구체 에러", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "x", attribution: { author: "u", userId: "u1" } }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(typeof json.error).toBe("string");
    expect(json.error.length).toBeGreaterThan(0);
  });

  test("content.data 빈 문자열 → 400", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "x",
        content: { type: "text", data: "" },
        attribution: { author: "u", userId: "u1" },
      }),
    });
    expect(res.status).toBe(400);
  });

  // ── (g) 자동 type 감지 (파일 통로 — type='auto') ──────────────────────────
  // detectDocumentType 은 파일(documents 행)에만 적용된다. 순수 글(type='text')은
  // documents 를 만들지 않으므로(spec §3), 감지 로직은 파일 통로(type='auto')로 검증한다.
  test("'회의 일시:' 포함 파일 → documentType=meeting_log", async () => {
    const md = "회의 일시: 2026-05-27\n\n참석자: 김철수\n\n안건: 메모리 모듈 정착 여부.";
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "auto",
          data: md,
          mimeType: "text/markdown",
          originalName: "meeting.md",
        },
        attribution: { author: "u", userId: "u1" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse;
    expect(store.getDocument(json.documentId)?.documentType).toBe("meeting_log");
  });

  test("'[Scene' 포함 파일 → documentType=scenario", async () => {
    const md = "[Scene 1 - 도입부]\n\n캐릭터 A가 등장한다.";
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "auto",
          data: md,
          mimeType: "text/markdown",
          originalName: "scenario.md",
        },
        attribution: { author: "u", userId: "u1" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse;
    expect(store.getDocument(json.documentId)?.documentType).toBe("scenario");
  });

  test("특이 사항 없는 파일 → documentType=free", async () => {
    const md = "임의의 메모입니다. 특별한 패턴 없음.";
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "auto",
          data: md,
          mimeType: "text/markdown",
          originalName: "free.md",
        },
        attribution: { author: "u", userId: "u1" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse;
    expect(store.getDocument(json.documentId)?.documentType).toBe("free");
  });

  // ── (h) hashtags → document 노드 metadata.tags 보존 ──────────────────────
  test("hashtags → document 노드 metadata.tags 로 저장(유실 차단)", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "text",
          data: "태그 보존 검증용 문서입니다.",
          mimeType: "text/markdown",
          originalName: "tagged.md",
        },
        attribution: { author: "u", userId: "u1" },
        hashtags: ["메모리모듈", "바라", ""], // 빈 문자열은 걸러져야 한다
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse;
    const documentNodeId = json.nodeIds[0] as number;
    const node = await store.getNode(documentNodeId);
    expect(node).not.toBeNull();
    expect(node!.metadata.tags).toEqual(["메모리모듈", "바라"]);
  });

  test("hashtags 의 #프로젝트:값 → document/chunk project_id 로 반영", async () => {
    const data = "# 문서 제목\n\n프로젝트에 속해야 하는 문서 본문입니다.";
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "text",
          data,
          mimeType: "text/markdown",
          originalName: "project-tagged.md",
        },
        attribution: { author: "u", userId: "u1" },
        // 대시보드 파일 첨부 경로는 입력창 태그를 hashtags 배열로만 보낸다.
        hashtags: ["프로젝트:바라문서프로젝트", "메모"],
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse;
    const project = await store.findProjectByName("바라문서프로젝트");
    expect(project).not.toBeNull();

    const documentNode = await store.getNode(json.nodeIds[0] as number);
    expect(documentNode?.sourceType).toBe("document");
    expect(documentNode?.projectId).toBe(project!.projectId);
    expect(documentNode?.metadata.tags).toEqual(["프로젝트:바라문서프로젝트", "메모"]);

    const chunkIds = json.nodeIds.slice(1);
    expect(chunkIds.length).toBeGreaterThan(0);
    for (const nodeId of chunkIds) {
      const chunk = await store.getNode(nodeId as number);
      expect(chunk?.sourceType).toBe("document_chunk");
      expect(chunk?.projectId).toBe(project!.projectId);
    }
  });

  test("hashtags 의 평면 태그/콜론 분류 → document/chunk 개념 엣지로 반영", async () => {
    const data = "# 고양이 사진 묶음\n\n고등어 무늬 고양이 자료입니다.";
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "text",
          data,
          mimeType: "text/markdown",
          originalName: "cat.md",
        },
        attribution: { author: "u", userId: "u1" },
        // 대시보드는 #을 떼고 보낸다: 입력창 "#고양이 #고양이:고등어" 재현.
        hashtags: ["고양이", "고양이:고등어"],
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as IngestResponse;
    expect(json.nodeIds.length).toBeGreaterThan(1);

    const cat = await store.findConceptByName("고양이");
    const tabby = await store.findConceptByName("고등어");
    expect(cat).not.toBeNull();
    expect(tabby).not.toBeNull();

    const tabbyParents = store.getHierarchyDirectParents(tabby!.conceptId);
    expect(tabbyParents).toContain(cat!.conceptId);

    for (const nodeId of json.nodeIds) {
      const tagEdges = await store.listNodeConceptEdges({
        nodeId: nodeId as number,
        role: "tag",
      });
      expect(tagEdges.some((e) => e.conceptId === cat!.conceptId)).toBe(true);

      const classEdges = await store.listNodeConceptEdges({
        nodeId: nodeId as number,
        role: "classification",
      });
      expect(classEdges.some((e) => e.conceptId === tabby!.conceptId)).toBe(true);
    }
  });

  // ── (i) 순수 타이핑 글(originalName 없음) → 자산·디스크 파일 0 (글은 자산 통로 아님) ──
  // originalName 없는 타이핑 글만 자산을 만들지 않는다. .txt/.md 파일(originalName 있음)은
  // (a2) 가 자산 보존을 검증한다(spec D4).
  test("짧은 타이핑 글(originalName 없음) → asset_files 0행 (글은 자산을 만들지 않음)", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "text",
          data: "재사용 검증용 단일 문단 텍스트입니다.",
          // 순수 타이핑 글 = originalName 없음.
        },
        attribution: { author: "u", userId: "u1" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;
    expect(json.type).toBe("text");
    // 타이핑 글은 자산을 만들지 않으므로 asset_files 0행 (고아 메타 회피).
    const cnt = (
      db.prepare("SELECT COUNT(*) AS c FROM asset_files").get() as { c: number }
    ).c;
    expect(cnt).toBe(0);
  });

  // ── (k) content.type='text' + mimeType 없음 → 글 분기 (운영 실패 재현 게이트) ──
  // 옛 운영 실패(글이 document+chunk 두 노드로 잘려 저장)를 재현하던 입력이, 이제는
  // 원본 한 노드만 남는지 확인한다(증상1 제거 게이트).
  test("type='text' 단독(mimeType·originalName 없음) → 원본 노드 1개(짧은 글)", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "discord:dm",
        content: {
          type: "text",
          data: "첫 문단.\n\n둘째 문단.",
          // mimeType 없음, originalName 없음 — 운영 실패 재현 형태
        },
        attribution: { author: "u", userId: "u1" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;
    expect(json.ok).toBe(true);
    expect(json.type).toBe("text");
    // 짧은 글(토큰 ≤ tokenCap) → 원본 한 노드만 (옛 document+chunk 두 노드 아님).
    expect(json.nodeIds.length).toBe(1);
    expect(json.chunkNodeIds.length).toBe(0);
    // 원본 노드 content = 두 문단 원문 전체 (안 잘림).
    const node = await store.getNode(json.originNodeId);
    expect(node?.content).toBe("첫 문단.\n\n둘째 문단.");
  });

  // ── (k) Phase 11b T1 — image 분기 + `#category:value` hashtag 자동 합류 ──
  test("(k) image 분기 + colon hashtag → concept 노드 + node_concept_edges(classification) 자연 합류", async () => {
    // stub image embedder — SigLIP 2 다운로드 비용 회피 (옛 ingest-image.int.test.ts (f) 양식 정합).
    // embedding=null 분기는 image_vec 만 skip — image_asset 노드는 정합 추가라 classification 흐름 검증 정합.
    const stubImageEmbedder: ImageEmbedder = {
      dim: 768,
      modelId: "stub:null-for-test",
      async embedImage() {
        return null;
      },
    };
    const settings = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
    const appWithImage = buildMemoryApi({
      store,
      retriever: new HybridRetriever(store, embedder),
      assembler: new ContextAssembler(),
      assetStore: new AssetStore(dir),
      imageEmbedder: stubImageEmbedder,
      getSettings: () => settings,
    });

    const pngBuffer = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "memory",
        "image-preserve",
        "__fixtures__",
        "static-small.png",
      ),
    );
    const pngBase64 = pngBuffer.toString("base64");

    const res = await appWithImage.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "discord:test",
        content: {
          type: "image",
          data: pngBase64,
          mimeType: "image/png",
          originalName: "rabbit.png",
        },
        attribution: { author: "user", userId: "u1" },
        // colon 양식 + 평면 해시태그 섞임 — colon 한 갈래만 classification 합류.
        hashtags: ["#character:흰머리토끼귀", "#style:수채화", "#봄"],
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      ok: boolean;
      type: string;
      images: Array<{ nodeId: number; assetSha256: string }>;
    };
    expect(json.type).toBe("image");
    expect(json.images).toHaveLength(1);
    const imageNodeId = json.images[0]!.nodeId;

    // colon 갈래 concept 노드 4개 (character, 흰머리토끼귀, style, 수채화)
    expect(await store.findConceptByName("character")).not.toBeNull();
    expect(await store.findConceptByName("흰머리토끼귀")).not.toBeNull();
    expect(await store.findConceptByName("style")).not.toBeNull();
    expect(await store.findConceptByName("수채화")).not.toBeNull();
    // 이미지 검색 토대 T1 — 평면 #봄 도 이제 tag 개념으로 연결된다(글 흐름 정합).
    expect(await store.findConceptByName("봄")).not.toBeNull();

    // node_concept_edges(role='classification') 2 행 — image_asset → 흰머리토끼귀 / 수채화
    const nodeEdges = await store.listNodeConceptEdges({
      nodeId: imageNodeId,
      role: "classification",
    });
    expect(nodeEdges).toHaveLength(2);

    // node_concept_edges(role='tag') 1 행 — image_asset → 봄 (평면 태그 합류)
    const tagEdges = await store.listNodeConceptEdges({
      nodeId: imageNodeId,
      role: "tag",
    });
    expect(tagEdges).toHaveLength(1);

    // hierarchy_edges(parent_of) — character → 흰머리토끼귀 / style → 수채화.
    // 평면 태그 위계는 태그가 1개뿐이라(#봄) 추가 parent_of 없음. S0-T4 단일 출처라
    // 옛 listConceptEdges 가 아니라 getHierarchyDirectParents 로 값 개념의 부모를 센다.
    const valueConceptIds = [...new Set(nodeEdges.map((e) => e.conceptId))];
    const withParent = valueConceptIds.filter(
      (id) => store.getHierarchyDirectParents(id).length > 0,
    );
    expect(withParent).toHaveLength(2);
  });

  // ── (k1.5) 이미지 검색 토대 T1 — image 분기 평면 태그(role='tag') 개념 연결 ──
  // 평면 해시태그(`#노란후드`처럼 colon 없는 태그)가 글 흐름과 동일하게
  // findOrCreateTagConcept + addNodeConceptEdge(role='tag')로 연결되어 개념 채널·
  // 연결검색에 합류함을 단언한다. colon 갈래 불변 / 중복·가짜 0 / 위계 동작 포함.
  test("(k1.5) image 분기 평면 태그 → tag 개념 + node_concept_edges(tag) 합류 + 위계", async () => {
    const stubImageEmbedder: ImageEmbedder = {
      dim: 768,
      modelId: "stub:null-for-test",
      async embedImage() {
        return null;
      },
    };
    const settings = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
    const appWithImage = buildMemoryApi({
      store,
      retriever: new HybridRetriever(store, embedder),
      assembler: new ContextAssembler(),
      assetStore: new AssetStore(dir),
      imageEmbedder: stubImageEmbedder,
      getSettings: () => settings,
    });

    const pngBuffer = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "memory",
        "image-preserve",
        "__fixtures__",
        "static-small.png",
      ),
    );
    const pngBase64 = pngBuffer.toString("base64");

    // 평면 태그 2개(#노란후드 #후드) + colon 태그 1개(#category:value) 섞음.
    // 대시보드 파일 첨부는 #을 떼고 보내므로, 서버 정규화까지 같이 검증한다.
    // 같은 평면 태그(#노란후드)를 두 번 적어 idempotent(엣지 중복 0) 도 검증.
    const res = await appWithImage.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "discord:test",
        content: {
          type: "image",
          data: pngBase64,
          mimeType: "image/png",
          originalName: "hoodie.png",
        },
        attribution: { author: "user", userId: "u1" },
        hashtags: ["노란후드", "후드", "노란후드", "character:토끼"],
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      ok: boolean;
      type: string;
      images: Array<{ nodeId: number }>;
    };
    expect(json.type).toBe("image");
    const imageNodeId = json.images[0]!.nodeId;

    // 평면 태그 2개 tag 개념 생성 — 노란후드 / 후드 (중복 #노란후드 = 1개)
    expect(await store.findConceptByName("노란후드")).not.toBeNull();
    expect(await store.findConceptByName("후드")).not.toBeNull();

    // node_concept_edges(role='tag') 정확히 2 행 — 같은 태그 두 번 입력해도 엣지 중복 0
    const tagEdges = await store.listNodeConceptEdges({
      nodeId: imageNodeId,
      role: "tag",
    });
    expect(tagEdges).toHaveLength(2);
    const tagConceptIds = new Set(tagEdges.map((e) => e.conceptId));
    expect(tagConceptIds.size).toBe(2);

    // 연결검색/개념 채널 합류 — 이미지 노드가 tag 개념 엣지를 가짐(채널 진입 단언)
    const yellowHoodie = await store.findConceptByName("노란후드");
    const edgesForConcept = await store.listNodeConceptEdges({
      conceptId: yellowHoodie!.conceptId,
      role: "tag",
    });
    expect(edgesForConcept.some((e) => e.nodeId === imageNodeId)).toBe(true);

    // colon 갈래 불변 — character:토끼 는 classification 으로만 처리
    const classEdges = await store.listNodeConceptEdges({
      nodeId: imageNodeId,
      role: "classification",
    });
    expect(classEdges).toHaveLength(1);

    // 콜론 없는 평면 태그 나열(노란후드·후드)은 위계(parent_of)를 만들지 않는다
    // (spec §4.1 I1 — 위계는 콜론 선언에서만 생긴다). 글 흐름과 동일하게 평면
    // 태그끼리는 위계 0개.
    const noranId = (await store.findConceptByName("노란후드"))!.conceptId;
    const hoodId = (await store.findConceptByName("후드"))!.conceptId;
    // S0-T4 단일 출처 — 위계는 hierarchy_edges 에서 본다. 두 평면 태그 사이 parent_of 0.
    const flatHierarchy = store
      .getHierarchyEdgesWithin([noranId, hoodId])
      .filter((e) => e.sourceId === noranId && e.targetId === hoodId);
    expect(flatHierarchy).toHaveLength(0);
  });

  // ── (k1.6) 이미지 검색 토대 T1 — 평면 태그 0개면 tag 엣지 0 (가짜 태그 0) ──
  test("(k1.6) image 분기 평면 태그 0개 → tag 엣지 0 (가짜 태그 생성 0)", async () => {
    const stubImageEmbedder: ImageEmbedder = {
      dim: 768,
      modelId: "stub:null-for-test",
      async embedImage() {
        return null;
      },
    };
    const settings = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
    const appWithImage = buildMemoryApi({
      store,
      retriever: new HybridRetriever(store, embedder),
      assembler: new ContextAssembler(),
      assetStore: new AssetStore(dir),
      imageEmbedder: stubImageEmbedder,
      getSettings: () => settings,
    });

    const pngBuffer = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "memory",
        "image-preserve",
        "__fixtures__",
        "static-small.png",
      ),
    );
    const pngBase64 = pngBuffer.toString("base64");

    // hashtags 칸에 colon 태그만(평면 태그 0개). # 없는 대시보드 형태도 정규화된다.
    const res = await appWithImage.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "discord:test",
        content: {
          type: "image",
          data: pngBase64,
          mimeType: "image/png",
          originalName: "noflat.png",
        },
        attribution: { author: "user", userId: "u1" },
        hashtags: ["style:수채화"],
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { images: Array<{ nodeId: number }> };
    const imageNodeId = json.images[0]!.nodeId;

    const tagEdges = await store.listNodeConceptEdges({
      nodeId: imageNodeId,
      role: "tag",
    });
    expect(tagEdges).toHaveLength(0);
  });

  test("(k1.6b) image options.attachToNodeId → 글 노드 아래 parent_of 연결 + detail 이미지 첨부 노출", async () => {
    const stubImageEmbedder: ImageEmbedder = {
      dim: 768,
      modelId: "stub:null-for-test",
      async embedImage() {
        return null;
      },
    };
    const settings = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
    const appWithImage = buildMemoryApi({
      store,
      retriever: new HybridRetriever(store, embedder),
      assembler: new ContextAssembler(),
      assetStore: new AssetStore(dir),
      imageEmbedder: stubImageEmbedder,
      getSettings: () => settings,
    });

    const textRes = await appWithImage.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "text",
          data:
            "#컴퓨터사양:작업컴, 주로 사용하는 작업 컴퓨터의 그래픽카드는 4080S\n" +
            "메모리는 96gb",
        },
        attribution: { author: "user", userId: "u1" },
      }),
    });
    expect(textRes.status).toBe(201);
    const textJson = (await textRes.json()) as TextIngestResponse;
    const parentNodeId = textJson.originNodeId;

    const pngBuffer = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "memory",
        "image-preserve",
        "__fixtures__",
        "static-small.png",
      ),
    );
    const imageRes = await appWithImage.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "auto",
          data: pngBuffer.toString("base64"),
          mimeType: "image/png",
          originalName: "workstation.png",
        },
        attribution: { author: "user", userId: "u1" },
        hashtags: ["컴퓨터사양:작업컴"],
        options: { attachToNodeId: parentNodeId },
      }),
    });
    expect(imageRes.status).toBe(201);
    const imageJson = (await imageRes.json()) as {
      type: string;
      attachedToNodeId: number | null;
      images: Array<{ nodeId: number; assetSha256: string; thumbSha256: string }>;
    };
    expect(imageJson.type).toBe("image");
    expect(imageJson.attachedToNodeId).toBe(parentNodeId);
    const imageNodeId = imageJson.images[0]!.nodeId;

    const parentEdges = db
      .prepare(
        `SELECT source_id, target_id, relation, provenance
           FROM knowledge_edges
          WHERE source_id = ? AND target_id = ? AND relation = 'parent_of'`,
      )
      .all(imageNodeId, parentNodeId) as Array<{
      source_id: number;
      target_id: number;
      relation: string;
      provenance: string;
    }>;
    expect(parentEdges).toHaveLength(1);
    expect(parentEdges[0]!.provenance).toBe("user_input");

    const detailRes = await appWithImage.request(`/memories/${parentNodeId}`);
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as {
      memory: { imageAttachments: Array<{ nodeId: number; assetSha256: string }> };
    };
    expect(detailJson.memory.imageAttachments).toHaveLength(1);
    expect(detailJson.memory.imageAttachments[0]!.nodeId).toBe(imageNodeId);
    expect(detailJson.memory.imageAttachments[0]!.assetSha256).toBe(
      imageJson.images[0]!.assetSha256,
    );
  });

  test("(k1.6c) 명시 해시태그가 있으면 SigLIP visual 자동 연결을 건너뛴다", async () => {
    const imageVec = new Float32Array(768);
    imageVec[0] = 1;
    db.run("INSERT INTO concept_nodes(concept_id, name, is_tag) VALUES (?, ?, 1)", [
      "cpt_visual_match",
      "컴퓨터사양",
    ]);
    const conceptRowid = Number(
      (
        db
          .prepare("SELECT rowid AS r FROM concept_nodes WHERE concept_id = ?")
          .get("cpt_visual_match") as { r: number }
      ).r,
    );
    db.run("INSERT INTO concept_siglip_vec(concept_rowid, embedding) VALUES (?, ?)", [
      conceptRowid,
      imageVec,
    ]);

    const stubImageEmbedder: ImageEmbedder = {
      dim: 768,
      modelId: "stub:visual-match-for-test",
      async embedImage() {
        return imageVec;
      },
    };
    const settings = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
    const appWithImage = buildMemoryApi({
      store,
      retriever: new HybridRetriever(store, embedder),
      assembler: new ContextAssembler(),
      assetStore: new AssetStore(dir),
      imageEmbedder: stubImageEmbedder,
      getSettings: () => settings,
    });
    const pngBuffer = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "memory",
        "image-preserve",
        "__fixtures__",
        "static-small.png",
      ),
    );

    const res = await appWithImage.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "auto",
          data: pngBuffer.toString("base64"),
          mimeType: "image/png",
          originalName: "tagged-workstation.png",
        },
        attribution: { author: "user", userId: "u1" },
        hashtags: ["컴퓨터사양:작업컴"],
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { images: Array<{ nodeId: number }> };
    const imageNodeId = json.images[0]!.nodeId;

    const visualEdges = await store.listNodeConceptEdges({
      nodeId: imageNodeId,
      role: "visual",
    });
    expect(visualEdges).toHaveLength(0);

    const classEdges = await store.listNodeConceptEdges({
      nodeId: imageNodeId,
      role: "classification",
    });
    const workComputer = await store.findConceptByName("작업컴");
    expect(workComputer).not.toBeNull();
    expect(classEdges.some((edge) => edge.conceptId === workComputer!.conceptId)).toBe(true);
  });

  // ── (k1.7) 이미지 분기 → 엔티티 망 합류 (두 wiring 호출이 각각 건다) ───────────
  // 이미지를 엔티티 해시태그와 함께 올리면, 텍스트 경로가 받는 wireHashtagEntitiesSafe +
  // wireEntityPlacementSafe 가 이미지 분기에도 걸린다. 두 호출을 두 입력으로 나눠 각각의
  // 효과를 정확히 단언한다 — 한 글에 `#프로젝트:`와 `#작품:`을 같이 넣으면 분류기가 첫
  // 매치(project)로 가버려 작품 배치를 건너뛰므로(텍스트 경로와 같은 기존 거동), 두 측면을
  // 갈라 증명한다. 엔티티 정보가 본문이 아니라 hashtags 칸에만 있어 wiring 은 hashtagsJoined
  // 를 파싱한다. 설정 게이트(autoConceptLink/vision) OFF(default nonexistent path) 여도 이
  // wiring 은 걸려야 한다 — stub embedder 로 그 점을 같이 확인한다.

  /** stub embedder + default settings 로 이미지 분기를 태우는 app 을 만든다(테스트 공용). */
  function buildEntityWiringApp(): Hono {
    const stubImageEmbedder: ImageEmbedder = {
      dim: 768,
      modelId: "stub:null-for-test",
      async embedImage() {
        return null;
      },
    };
    const settings = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
    return buildMemoryApi({
      store,
      retriever: new HybridRetriever(store, embedder),
      assembler: new ContextAssembler(),
      assetStore: new AssetStore(dir),
      imageEmbedder: stubImageEmbedder,
      getSettings: () => settings,
    });
  }

  /** 작은 png 를 엔티티 해시태그와 함께 이미지 분기로 보내 image 노드 id 를 회수한다. */
  async function ingestImageEntity(
    app: Hono,
    hashtags: string[],
    originalName: string,
  ): Promise<number> {
    const pngBuffer = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "memory",
        "image-preserve",
        "__fixtures__",
        "static-small.png",
      ),
    );
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "discord:test",
        content: {
          type: "image",
          data: pngBuffer.toString("base64"),
          mimeType: "image/png",
          originalName,
        },
        attribution: { author: "user", userId: "u1" },
        hashtags,
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { type: string; images: Array<{ nodeId: number }> };
    expect(json.type).toBe("image");
    return json.images[0]!.nodeId;
  }

  test("(k1.7a) image 분기 프로젝트 태그 → image_asset 노드에 project_id 설정 (owns_memory 토대)", async () => {
    const app2 = buildEntityWiringApp();
    const imageNodeId = await ingestImageEntity(app2, ["프로젝트:테스트프로젝트"], "art.png");

    // 대시보드형 프로젝트 선언이 image_asset 노드에 project_id 를 세웠다(wireHashtagEntitiesSafe 효과).
    const project = await store.findProjectByName("테스트프로젝트");
    expect(project).not.toBeNull();
    const imageNode = await store.getNode(imageNodeId);
    expect(imageNode).not.toBeNull();
    expect(imageNode!.projectId).toBe(project!.projectId);
    // 그래프 라우트가 읽는 project_id 역인덱스에도 이미지 노드가 잡힌다(owns_memory 자동
    // 연결의 토대 — getProjectMemberNodes 가 image_asset 을 제외하지 않으므로 이 한 줄로 충분).
    expect(store.getNodesByProjectId(project!.projectId, 100)).toContain(imageNodeId);
  });

  test("(k1.7b) image 분기 #작품:·#작가: → 작품 행 + 작품→작가 created_by 관계 (wireEntityPlacementSafe)", async () => {
    const app2 = buildEntityWiringApp();
    // 프로젝트 선언 없이 작품 + 작가만 — 분류기가 work 로 가 신규 8 타입 배치가 돈다.
    // 작가=창작자=제작자=만든사람 동의어라 #작가: 는 work→person created_by 로 떨어진다.
    await ingestImageEntity(app2, ["작품:테스트작품", "작가:테스트작가"], "art2.png");

    // 작품 엔티티 행이 생겼다(#작품:테스트작품 → work 1급 행, source='explicit').
    const work = await store.entitiesRepo.findByName("work", "테스트작품");
    expect(work).not.toBeNull();

    // 작품 → 작가(person) created_by 관계 엣지가 생겼다(#작가: = created_by 동의어).
    const relations = store.getRelationsFromSource("work", work!.id);
    const createdByEdges = relations.filter((e) => e.relation === "created_by");
    expect(createdByEdges.length).toBe(1);
    const author = await store.findPersonByName("테스트작가");
    expect(author).not.toBeNull();
    expect(createdByEdges[0]!.targetId).toBe(author!.personId);
    expect(createdByEdges[0]!.targetType).toBe("person");
  });

  // ── (k1.7c) C3 회귀 가드 — 같은 #작품:X 를 텍스트·이미지로 넣으면 같은 work 처리 ──
  // 감사 보고서 C3: 옛 이미지 분기가 parseClassificationTags 의 *정규화된* category(작품→
  // series)를 손수 addClassificationTag 에 넣어, 같은 `#작품:데못죽` 태그가 텍스트(work 엔티티
  // 행)와 이미지(series → 데못죽 엉뚱한 분류 위계)로 갈렸다. 손수 콜론 분류 루프를 제거하고
  // wireEntityPlacementSafe 단일 출처에 맡긴 뒤, 두 통로가 같은 work 엔티티로 합류하고
  // series 분류 위계가 더는 안 생김을 단언한다(통로별 데이터 갈림 차단).
  test("(k1.7c) 같은 #작품:데못죽 → 텍스트·이미지 모두 같은 work 행 + series 분류 위계 0", async () => {
    const app2 = buildEntityWiringApp();

    // 1) 텍스트로 #작품:데못죽 입력 → work 엔티티 행 생성(텍스트 경로 wireEntityPlacement).
    const textRes = await app2.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "discord:test",
        content: { type: "text", data: "오늘 본 작품. #작품:데못죽" },
        attribution: { author: "user", userId: "u1" },
      }),
    });
    expect(textRes.status).toBe(201);

    const workAfterText = await store.entitiesRepo.findByName("work", "데못죽");
    expect(workAfterText).not.toBeNull();
    const workIdFromText = workAfterText!.id;

    // 2) 같은 #작품:데못죽 을 이미지로 입력 → 새 work 행을 만들지 않고 같은 행을 가리킨다
    //    (이름 UNIQUE 멱등). 이미지 경로도 텍스트와 같은 wireEntityPlacementSafe 를 탄다.
    await ingestImageEntity(app2, ["#작품:데못죽"], "demotjuk.png");

    const workAfterImage = await store.entitiesRepo.findByName("work", "데못죽");
    expect(workAfterImage).not.toBeNull();
    // 같은 work 행 — 통로가 갈라져 두 행이 생기지 않는다(C3 핵심).
    expect(workAfterImage!.id).toBe(workIdFromText);

    // 3) 회귀 가드 — 옛 버그가 만들던 'series' 분류 키 개념과 'series → 데못죽' 분류 위계가
    //    더는 생기지 않는다. 'series' 는 image-categories.yaml 의 작품 동의어 정규화값으로,
    //    옛 이미지 손수 루프만이 만들던 엉뚱한 분류 뿌리다.
    expect(await store.findConceptByName("series")).toBeNull();
    // 작품 이름 '데못죽' 이 분류 값 개념으로 새로 매달리지도 않는다(work 행이 잎을 진다).
    // series 개념이 없으니 series→데못죽 위계도 구조적으로 불가하지만, 데못죽 개념이 분류
    // value 로 떠 있지 않음을 직접 확인한다(통로별 갈림 0).
    const demotjukConcept = await store.findConceptByName("데못죽");
    if (demotjukConcept) {
      const parents = store.getHierarchyDirectParents(demotjukConcept.conceptId);
      const seriesConcept = await store.findConceptByName("series");
      // series 가 없으니 부모로 잡힐 수 없다 — 방어적 이중 단언.
      expect(seriesConcept).toBeNull();
      expect(parents.length).toBe(0);
    }
  });

  // ── (k1.8) 이미지 분기 엔티티 해시태그 없음 → 엔티티 wiring no-op (가짜 행 0) ──
  // 엔티티 해시태그가 없으면(평면 태그만) wiring 이 사람·프로젝트·작품 행을 만들지 않는다 —
  // 기존 동작(평면 태그 개념 연결만)이 그대로 유지됨을 단언한다(회귀 불변 / 가짜 엔티티 0).
  test("(k1.8) image 분기 평면 태그만(엔티티 해시태그 없음) → project_id null + 작품 행 0", async () => {
    const stubImageEmbedder: ImageEmbedder = {
      dim: 768,
      modelId: "stub:null-for-test",
      async embedImage() {
        return null;
      },
    };
    const settings = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
    const appWithImage = buildMemoryApi({
      store,
      retriever: new HybridRetriever(store, embedder),
      assembler: new ContextAssembler(),
      assetStore: new AssetStore(dir),
      imageEmbedder: stubImageEmbedder,
      getSettings: () => settings,
    });

    const pngBuffer = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "memory",
        "image-preserve",
        "__fixtures__",
        "static-small.png",
      ),
    );
    const res = await appWithImage.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "discord:test",
        content: {
          type: "image",
          data: pngBuffer.toString("base64"),
          mimeType: "image/png",
          originalName: "plain.png",
        },
        attribution: { author: "user", userId: "u1" },
        hashtags: ["#봄", "#수채화"],
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { images: Array<{ nodeId: number }> };
    const imageNodeId = json.images[0]!.nodeId;

    // 엔티티 선언이 없으니 project_id 는 안 세워진다(null) — 가짜 프로젝트 연결 0.
    const imageNode = await store.getNode(imageNodeId);
    expect(imageNode?.projectId).toBeNull();
    // 작품 행도 0 — 평면 태그는 작품 엔티티를 만들지 않는다.
    expect(await store.entitiesRepo.findByName("work", "봄")).toBeNull();
    expect(await store.entitiesRepo.findByName("work", "수채화")).toBeNull();
  });

  // ── (k2) 동작 방식(mode) 분기 — 업로드 즉시 캡션 블록 진입 / backfill skip ──
  //
  // 동작 방식·주기는 의미추출 AI 수준 공통이라 권위 = extractor 슬롯
  // (extractor-vision-unified-clock-scheduler 결정 3·5). extractor.mode='backfill'
  // 이면 업로드 통로는 캡션 블록에 진입조차 안 함 (captionFlow=null — 스케줄러가 T7
  // 에서 채움). extractor.mode='immediate' + vision.enabled 면 블록 진입 — 여기서
  // forceCall=false + SigLIP 임베딩 가용(embedImage 가 Float32Array 회수) 갈래를 둬서
  // decideVlmInvocation 이 token 절약 skip(false)을 회수하게 하면 (captionFlow.called=false)
  // 실제 VLM 네트워크 호출 0 으로 "블록 진입 여부" 만 정직하게 구분된다. 가짜 provider
  // 클래스 0 (CLAUDE.md mock 금지 정합) — 실제 ingest 라우트 + 실제 settings 갈래 검증.
  function makeVisionSettings(
    base: ReturnType<typeof getMemorySettings>,
    extractorMode: "immediate" | "backfill",
    visionEnabled: boolean,
  ): ReturnType<typeof getMemorySettings> {
    return {
      ...base,
      llm: {
        ...base.llm,
        extractor: { ...base.llm.extractor, mode: extractorMode },
        vision: { ...base.llm.vision, enabled: visionEnabled },
      },
    };
  }

  async function ingestImageWith(
    settings: ReturnType<typeof getMemorySettings>,
    embedImageResult: () => Promise<Float32Array | null> = async () => null,
  ): Promise<{ captionFlow: { called: boolean; caption?: string | null; captionNodeId?: number } | null }> {
    const stubImageEmbedder: ImageEmbedder = {
      dim: 768,
      modelId: "stub:for-test",
      embedImage: embedImageResult,
    };
    const appWithImage = buildMemoryApi({
      store,
      retriever: new HybridRetriever(store, embedder),
      assembler: new ContextAssembler(),
      assetStore: new AssetStore(dir),
      imageEmbedder: stubImageEmbedder,
      getSettings: () => settings,
    });
    const pngBuffer = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "memory",
        "image-preserve",
        "__fixtures__",
        "static-small.png",
      ),
    );
    const res = await appWithImage.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "discord:test",
        content: {
          type: "image",
          data: pngBuffer.toString("base64"),
          mimeType: "image/png",
          originalName: "rabbit.png",
        },
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { captionFlow: { called: boolean; caption?: string | null; captionNodeId?: number } | null };
  }

  test("(k2) extractor.mode='backfill' → 업로드 캡션 블록 진입 0 (captionFlow=null — 스케줄러가 T7 에서 채움)", async () => {
    const base = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
    // vision.enabled=true 라도 extractor.mode='backfill' 이면 업로드 통로는 캡션을 건너뛴다.
    const settings = makeVisionSettings(base, "backfill", true);
    const json = await ingestImageWith(settings);
    expect(json.captionFlow).toBeNull();
  });

  test("(k2) extractor.mode='backfill' + vision.enabled=false → 진입 0 (captionFlow=null)", async () => {
    const base = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
    // vision.enabled=false → 켜기 게이트로 막힘. extractor.mode 무관 진입 0.
    const settings = makeVisionSettings(base, "immediate", false);
    const json = await ingestImageWith(settings);
    expect(json.captionFlow).toBeNull();
  });

  test("(k2) extractor.mode='immediate' + vision.enabled=true → 업로드 캡션 블록 진입 (captionFlow 객체). SigLIP 임베딩 가용 → token 절약 skip (called=false / 네트워크 0)", async () => {
    const base = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
    // extractor.mode='immediate' + vision.enabled=true → 블록 진입. forceCall=false +
    // SigLIP 임베딩 가용(embedImage 가 768-dim Float32Array 회수) → decideVlmInvocation
    // 가 token 절약 skip 으로 false 회수 → 실제 VLM 네트워크 호출 0.
    const settings = makeVisionSettings(base, "immediate", true);
    const json = await ingestImageWith(
      settings,
      async () => new Float32Array(768),
    );
    // 블록 진입 신호 = captionFlow 가 null 아님. called=false = decideVlmInvocation OFF.
    expect(json.captionFlow).not.toBeNull();
    expect(json.captionFlow!.called).toBe(false);
  });

  test("(k3) 업로드 즉시 캡션이 실패해도 저장은 성공하고, 응답 captionFlow 에 실패 원인 칸이 없다 (2026-10-14 spec 4.6)", async () => {
    const vlm = startProviderStandIn();
    vlm.reply = () => ({ status: 500, body: { error: "vlm down" } });
    try {
      const base = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
      const settings = makeVisionSettings(base, "immediate", true);
      settings.llm.vision = { ...settings.llm.vision, provider: "ollama", ollamaUrl: vlm.origin, forceCall: true };
      const json = await ingestImageWith(settings);
      expect(json.captionFlow).toEqual({ called: true, caption: null });
      expect(vlm.requests.length).toBeGreaterThan(0);
    } finally {
      vlm.stop();
    }
  });

  // ── (L) 대시보드 경로 — type="auto" + image mimeType + base64 (Phase 11d 회귀) ──
  // 대시보드 ingest-form.js 는 이미지를 content.type="auto" + image mimeType + base64
  // 로 보낸다(봇만 type="image"). 옛 isBinaryContent 는 contentType==="image" 일 때만
  // base64 디코드해서, type="auto" 이미지는 base64 가 텍스트로 인코딩돼 버퍼가
  // "/9j/..."(0x2f 0x39) 가 되고 디코더가 전멸했다(A1 실측 "Not a JPEG file").
  // 수정(mimeType.startsWith("image/") 추가)이 실제 base64 를 디코드하는지 검증한다.
  //
  // 핵심 단언 = "자산 sha 가 원본 png 바이트 sha 와 일치". 텍스트로 인코딩됐으면
  // 버퍼 내용이 달라 sha 가 어긋나거나 디코드(probeMeta/applyPreserveMode) 가 throw →
  // 400 이 된다. smart 보존 모드(default)에서 작은 png 는 passthrough 라
  // assetBuffer === 입력 buffer → 자산 sha = 원본 바이트 sha.
  describe("(L) 대시보드 경로 — type='auto' image", () => {
    // stub embedder — SigLIP 2 다운로드 비용 회피. embedding=null 이어도 보존 모드의
    // 실제 디코드(probeMeta)는 그대로 수행되므로 base64 디코드 검증에는 무관.
    const stubImageEmbedder: ImageEmbedder = {
      dim: 768,
      modelId: "stub:null-for-test",
      async embedImage() {
        return null;
      },
    };

    function buildAppWithImage(): Hono {
      const settings = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
      return buildMemoryApi({
        store,
        retriever: new HybridRetriever(store, embedder),
        assembler: new ContextAssembler(),
        assetStore: new AssetStore(dir),
        imageEmbedder: stubImageEmbedder,
        getSettings: () => settings,
      });
    }

    const fixtureDir = join(
      import.meta.dir,
      "..",
      "..",
      "memory",
      "image-preserve",
      "__fixtures__",
    );

    test("type='auto' + image/png + base64 → 201 + type='image' + 자산 sha 가 원본 png 바이트와 일치", async () => {
      const appWithImage = buildAppWithImage();
      const pngBytes = readFileSync(join(fixtureDir, "static-small.png"));
      const expectedSha = createHash("sha256").update(pngBytes).digest("hex");
      const pngBase64 = Buffer.from(pngBytes).toString("base64");

      const res = await appWithImage.request("/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "dashboard:manual",
          content: {
            // 대시보드 실제 전송 양식 — type="auto" (봇의 "image" 아님)
            type: "auto",
            data: pngBase64,
            mimeType: "image/png",
            originalName: "dashboard-drop.png",
          },
          attribution: { author: "테스터", userId: "u-auto-png" },
        }),
      });
      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        ok: boolean;
        type: string;
        images: Array<{ nodeId: number; assetSha256: string }>;
      };
      expect(json.ok).toBe(true);
      expect(json.type).toBe("image");
      expect(json.images).toHaveLength(1);
      // 핵심 — 저장된 자산 sha 가 원본 png 바이트 sha 와 일치 (base64 가 제대로 디코드됨).
      // 수정 전이면 버퍼가 base64 문자열의 UTF-8 인코딩이라 sha 가 어긋나거나
      // 보존 모드 디코드가 throw → 400.
      expect(json.images[0]!.assetSha256).toBe(expectedSha);
      // asset_files 에 원본 sha 행이 실제로 들어갔는지 확인.
      const assetRow = db
        .prepare("SELECT sha256, asset_type FROM asset_files WHERE sha256=?")
        .get(expectedSha) as { sha256: string; asset_type: string } | null;
      expect(assetRow).not.toBeNull();
      expect(assetRow!.asset_type).toBe("image");
    });

    test("type='auto' + image/webp + base64 → 201 + 저장 (옛 jimp 미지원 형식, @jsquash+base64 통과)", async () => {
      const appWithImage = buildAppWithImage();
      const webpBytes = readFileSync(join(fixtureDir, "static-small.webp"));
      const expectedSha = createHash("sha256").update(webpBytes).digest("hex");
      const webpBase64 = Buffer.from(webpBytes).toString("base64");

      const res = await appWithImage.request("/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "dashboard:manual",
          content: {
            type: "auto",
            data: webpBase64,
            mimeType: "image/webp",
            originalName: "dashboard-drop.webp",
          },
          attribution: { author: "테스터", userId: "u-auto-webp" },
        }),
      });
      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        ok: boolean;
        type: string;
        images: Array<{ nodeId: number; assetSha256: string }>;
      };
      expect(json.ok).toBe(true);
      expect(json.type).toBe("image");
      expect(json.images).toHaveLength(1);
      // webp 도 smart passthrough(작은 파일) → 자산 sha = 원본 webp 바이트 sha.
      // base64 디코드 + @jsquash webp 디코드 둘 다 통과했다는 증거.
      expect(json.images[0]!.assetSha256).toBe(expectedSha);
      const assetRow = db
        .prepare("SELECT sha256 FROM asset_files WHERE sha256=?")
        .get(expectedSha) as { sha256: string } | null;
      expect(assetRow).not.toBeNull();
    });

    test("type='auto' + image/png 인데 data 가 깨진 비-base64 → 400 정직 에러(silent 아님)", async () => {
      const appWithImage = buildAppWithImage();
      // base64 가 아닌 텍스트 + 디코드 후 png 가 못 되는 깨진 데이터.
      // Buffer.from(...,"base64") 는 비-base64 문자를 버려 짧은 깨진 바이트를 만들고,
      // 보존 모드 디코드(probeMeta)가 png 로 못 읽어 throw → 라우트가 400 으로 노출.
      const res = await appWithImage.request("/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "dashboard:manual",
          content: {
            type: "auto",
            data: "이건 base64 도 png 도 아닌 깨진 문자열입니다 !!!@@@",
            mimeType: "image/png",
            originalName: "broken.png",
          },
          attribution: { author: "테스터", userId: "u-auto-broken" },
        }),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(typeof json.error).toBe("string");
      expect(json.error.length).toBeGreaterThan(0);
    });
  });

  // ── (j) assetStore 미주입 → 503 ─────────────────────────────────────────
  test("assetStore 미주입이면 503 (정직한 비활성)", async () => {
    // assetStore 없는 app 별도 구성
    const db2 = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store2 = new SqliteMemoryStore(db2, embedder);
    const app2 = buildMemoryApi({
      store: store2,
      retriever: new HybridRetriever(store2, embedder),
      assembler: new ContextAssembler(),
      // assetStore 미주입
    });
    const res = await app2.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "x",
        content: { type: "text", data: "테스트" },
        attribution: { author: "u", userId: "u1" },
      }),
    });
    expect(res.status).toBe(503);
    db2.close();
  });
});

// ── S5(결정 1·5·6) — 본문 # 태그 인식 전환 (폼 kind/fields/eventAt 없이) ──────────
// 폼이 종류 드롭다운·날짜 필드를 없애 body.kind/fields/eventAt 을 더는 안 보내므로
// (S8 프론트), 서버가 글 본문 `#가계부:미용` `#금액:28000원` `#날짜:6월 28일` 만으로
// 종류·칸·event_at 을 인식한다. user 종류 "가계부"(household_ledger·칸 '금액')를 동적
// 명부·어휘 캐시에 등록해 classifier 가 본문 `#가계부:` 를 종류로 인식하게 한다 — 전역
// 캐시를 건드리므로 별 describe 로 격리하고 afterEach 에서 정적 10종으로 되돌린다(2-reset).
describe("POST /ingest — S5 본문 # 태그 인식(폼 전송 없이)", () => {
  let embedder2: Bgem3Embedder;
  beforeAll(async () => {
    embedder2 = new Bgem3Embedder();
    await embedder2.load();
  });

  let dir2: string;
  let db3: Database;
  let store3: SqliteMemoryStore;
  let app3: Hono;

  beforeEach(() => {
    dir2 = mkdtempSync(join(tmpdir(), "bara-ingest-s5-"));
    db3 = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store3 = new SqliteMemoryStore(db3, embedder2);
    const retriever = new HybridRetriever(store3, embedder2);
    const assembler = new ContextAssembler();
    const assetStore = new AssetStore(dir2);
    const settings = getMemorySettings("/nonexistent-default-ingest-s5", "/nonexistent-default-ingest-s5.secrets.json");
    app3 = buildMemoryApi({
      store: store3,
      retriever,
      assembler,
      assetStore,
      getSettings: () => settings,
    });

    // user 종류 "가계부"(household_ledger) 등록 + 칸 어휘 '금액' 주입(라우트 mergeConceptVocab
    // 통로를 단위 테스트가 흉내냄·yaml 파일 무수정). server 부팅·CRUD 순서대로 동적 명부 주입을
    // yaml 로드·복제 *전* 에 한다.
    store3.entityTypeRegistryDb.addEntityType({
      typeName: "household_ledger",
      koName: "가계부",
      idPrefix: "hhl_",
    });
    setEntityTypeOverride(store3.entityTypeRegistryDb.listUserEntityTypes());
    clearConceptVocabularyOverrides();
    resetClassifierCache();
    const yamlVocab = loadConceptTypeVocabulary();
    const merged: ConceptTypeVocabulary = new Map(yamlVocab);
    merged.set("household_ledger" as PlacementTypeName, {
      synonyms: [],
      subcategories: [],
      attributes: [],
      columns: ["금액"],
    });
    setConceptVocabOverride(merged);
    resetClassifierCache();
  });

  afterEach(() => {
    // 동적 명부·어휘·분류기 캐시를 정적 10종으로 되돌린다(전역 누출 차단·2-reset 양식).
    setEntityTypeOverride([]);
    clearConceptVocabularyOverrides();
    resetClassifierCache();
    db3.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  test("본문 # 태그만으로 종류·칸·event_at 채움(폼 kind/fields/eventAt 없이)", async () => {
    const res = await app3.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "test",
        content: {
          type: "text",
          data: "#가계부:미용, #금액:28000원, #날짜:6월 28일, 투블럭",
        },
        attribution: { author: "", userId: "owner" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;

    // 종류=가계부 분류값(②④)이 글에 잇혀 검색(개념명→글 id)에 잡힌다(kind 검색 캡슐 출처).
    expect(store3.getNodeIdsByConceptName("가계부").has(json.originNodeId)).toBe(true);
    // 표시 배지는 본문 typeName(household_ledger→가계부)으로 산출된다(spec §4.3 B).
    const badge = await searchKind(app3, "투블럭 미용", json.originNodeId);
    expect(badge).toBe("가계부");

    // 금액 칸(가계부 columns)이 글-칸으로 채워진다 — 본문 #금액:28000원 인식.
    const node = await store3.getNode(json.originNodeId);
    const fields = (node?.metadata.fields as Record<string, string> | undefined) ?? {};
    expect(fields.금액).toBe("28000원");

    // event_at 이 채워진다(본문 #날짜:6월 28일 → reserved key 통로·연도는 시점 의존이라
    // 날짜 부분만 단언).
    expect(node?.eventAt).not.toBeNull();
    expect(node?.eventAt).toContain("-06-28");
    const sources = node?.metadata.fieldSources as Record<string, string>;
    expect(sources.event_at).toBe("direct");
  });

  test("본문 #날짜:A ~ B → event_at(시작)·event_until(끝) 둘 다(splitDateRange 경유)", async () => {
    const res = await app3.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "test",
        content: {
          type: "text",
          data: "#가계부:여행, #날짜:6월 28일 ~ 6월 30일, 부산",
        },
        attribution: { author: "", userId: "owner" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;
    const node = await store3.getNode(json.originNodeId);

    // 시작 → event_at, 끝 → event_until 둘 다 채워진다(연도 시점 의존이라 날짜만 단언).
    expect(node?.eventAt).toContain("-06-28");
    expect(node?.eventUntil).toContain("-06-30");
    const sources = node?.metadata.fieldSources as Record<string, string>;
    expect(sources.event_at).toBe("direct");
    expect(sources.event_until).toBe("direct");
  });

  test("날짜를 못 풀면(애매) event_at 미설정 — 거짓 ISO 0(정직한 null)", async () => {
    const res = await app3.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "test",
        // "언젠가" 는 닫힌 날짜가 아니라 extractEventDate 가 null — event_at 미설정이어야 한다.
        content: { type: "text", data: "#가계부:미용, #날짜:언젠가, 메모" },
        attribution: { author: "", userId: "owner" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;
    const node = await store3.getNode(json.originNodeId);
    expect(node?.eventAt).toBeNull();
    expect(node?.eventUntil).toBeNull();
  });

  test("본문 인식이 폼 전송을 무시한다(본문 단일 출처) — 종류·칸 한 값", async () => {
    // 폼이 아직 kind/fields/eventAt 을 보내도(pre-S8), 본문 인식이 단일 출처라 본문 통로가
    // 종류·칸을 채운다. 종류는 본문 #가계부 자동 인식(②④), event_at 은 본문 #날짜 가 채우면
    // 폼 ISO 가 안 덮는다(본문 우선). body.kind 드롭다운 폴백은 폐기됐다(spec §2.2 옛 통로).
    const res = await app3.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "test",
        content: {
          type: "text",
          data: "#가계부:미용, #금액:28000원, #날짜:6월 28일, 투블럭",
        },
        // 폼 전송(옛 경로) — 본문과 다른 ISO 날짜(본문 우선으로 무시되는지 본다).
        eventAt: "2026-12-31",
        attribution: { author: "", userId: "owner" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TextIngestResponse;

    // 종류값('가계부')이 본문 자동 인식(②④)으로 한 개념에 잡힌다(이름 UNIQUE 한 행).
    const ids = store3.getNodeIdsByConceptName("가계부");
    expect(ids.has(json.originNodeId)).toBe(true);
    // 표시 배지도 본문 typeName 으로 '가계부'.
    const badge = await searchKind(app3, "투블럭 미용", json.originNodeId);
    expect(badge).toBe("가계부");

    // 금액 칸은 한 값("28000원") — 본문 #금액 인식(이중 0).
    const node = await store3.getNode(json.originNodeId);
    const fields = (node?.metadata.fields as Record<string, string> | undefined) ?? {};
    expect(fields.금액).toBe("28000원");

    // event_at 은 본문 #날짜:6월 28일 이 이긴다 — 폼 ISO(2026-12-31)가 안 덮는다(본문 우선).
    expect(node?.eventAt).toContain("-06-28");
    expect(node?.eventAt).not.toContain("2026-12-31");
  });
});

// ── Path Traversal 취약점 수정 검증 (2026-07-02, 보안 결함) ──────────────────────
// originalExt(mimeType, originalName) 는 원본 파일 확장자를 뽑아 asset-store.ts 의
// path()/write() 로 그대로 넘어간다. 화이트리스트(SAFE_EXT_PATTERN) 강화 전에는
// originalName 에 `/`·`\`·`..`·`:` 등 경로 조작 문자가 섞이면 그 문자열이 그대로
// ext 로 반환돼 join(contentDir, `${sha256}.${ext}`) 이 지정 폴더 밖 경로를 만들 수
// 있었다(임의 파일 쓰기). 순수 함수라 서버·DB 없이 직접 호출해 검증한다.
describe("originalExt — Path Traversal 방어(진입점 화이트리스트 강등)", () => {
  test("경로 조작 문자열(`x.../../../../evil`) → 안전한 값으로 강등(원본 그대로 반환 금지)", () => {
    const ext = originalExt("text/plain", "x.../../../../evil");
    expect(ext).not.toContain("/");
    expect(ext).not.toContain("..");
    // 화이트리스트 불통과 → mimeType 기반 fallback 도 안 맞으니 최종 "md" 로 강등.
    expect(ext).toBe("md");
  });

  test("Windows 역슬래시 경로 조작(`evil\\..\\..\\config`) → 안전한 값으로 강등", () => {
    const ext = originalExt("text/plain", "evil\\..\\..\\config");
    expect(ext).not.toContain("\\");
    expect(ext).not.toContain("..");
    expect(ext).toBe("md");
  });

  test("드라이브 문자 포함(`file.C:\\Windows\\system32`) → 안전한 값으로 강등", () => {
    const ext = originalExt("text/plain", "file.C:\\Windows\\system32");
    expect(ext).not.toContain(":");
    expect(ext).not.toContain("\\");
    expect(ext).toBe("md");
  });

  test("경로 조작 + PDF mimeType → 화이트리스트 불통과 시 mimeType fallback('pdf')로 강등", () => {
    const ext = originalExt("application/pdf", "x.../../../../evil");
    expect(ext).toBe("pdf");
  });

  test("경로 조작 + docx mimeType → 화이트리스트 불통과 시 mimeType fallback('docx')로 강등", () => {
    const ext = originalExt(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "evil\\..\\..\\config",
    );
    expect(ext).toBe("docx");
  });

  test("정상 다중 확장자(`x.tar.gz`) → 마지막 확장자('gz')가 회귀 없이 그대로 반환", () => {
    expect(originalExt("application/gzip", "x.tar.gz")).toBe("gz");
  });

  test("기존 정상 케이스 회귀 없음 — pdf/docx/md/png", () => {
    expect(originalExt("application/pdf", "report.pdf")).toBe("pdf");
    expect(
      originalExt(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "minutes.docx",
      ),
    ).toBe("docx");
    expect(originalExt("text/markdown", "notes.md")).toBe("md");
    expect(originalExt("image/png", "photo.png")).toBe("png");
  });

  test("originalName 없음 + mimeType 도 특수 아님 → 기존 default 'md' 그대로", () => {
    expect(originalExt("application/octet-stream", "")).toBe("md");
  });
});
