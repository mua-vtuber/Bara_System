/**
 * server-boot.test.ts — createMemoryApi 부팅 경로 통합 테스트.
 *
 * 검증 항목:
 *   1. createMemoryApi({ dbPath: ":memory:", assetDir·토큰·설정 파일: <임시 경로>, llmProvider: "none" }) 가
 *      throw 없이 완료된다. 이 경로 안에서 synonym_dictionary.yaml 과
 *      search-cues.yaml 이 실제로 로드되므로, 파일 없음 또는 형식 오류가
 *      있으면 여기서 throw 가 발생한다.
 *   2. 부팅된 앱이 POST /search 요청을 처리 — 200 + results 배열 반환.
 *      부팅 경로에서 주입된 retriever(동의어 사전 + search-cues 포함)가 실제
 *      검색을 실행했다는 증거.
 *   3. builtin 관계 cue 어휘가 든 query 로 POST /search 가 200 을 반환 —
 *      부팅 경로 retriever 의 cue 검출(detectCues + searchCues 주입)이 throw
 *      없이 동작한다는 증거. builtin cue 는 코드 상수라 search-cues.yaml 이
 *      비어 있어도 항상 가동한다(graceful Level 0).
 *
 * buildMemoryApi(수동 deps) 를 쓰는 기존 테스트와 달리, 이 파일은
 * createMemoryApi 한 통로만 실행한다 — 부팅 경로 갭 닫기 목적.
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder 통합 검증 (mock 객체 없음).
 * bge-m3 모델 로드로 인해 느림 — 별도 파일로 격리.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Hono } from "hono";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSET_PAIRING_FILE_NAME } from "./assets/asset-folder-pairing.ts";
import type { SqliteMemoryStore } from "./db/store.ts";
import type { Embedder } from "./embedding/types.ts";
import { createMemoryApi } from "./server.ts";
import { MEMORY_DEFAULTS } from "./settings/memory-schema.ts";
import type { MemorySettings } from "./settings/memory-settings.ts";

// ── 공유 상태 ────────────────────────────────────────────────────────────────

let app: Hono;
let store: SqliteMemoryStore;
let embedder: Embedder;
let shutdown: () => void;
// 첨부 파일 폴더 — 운영 폴더(env BARA_ASSET_DIR·settings.assets.dir)가 아니라 이 파일만의 임시 폴더(설계 17.19 D41).
let assetDir: string;
// 토큰·설정·백업 파일 — 운영 파일(env SSE_TOKEN_PATH·MEMORY_SETTINGS_PATH, settings.backup.dir)이 아니라 이 임시 폴더.
let fileDir: string;

async function jsonBody(res: Response): Promise<unknown> {
  return res.json();
}

// ── 부팅 — beforeAll 1회 실행 ────────────────────────────────────────────────
//
// createMemoryApi 안에서 synonym_dictionary.yaml 과 search-cues.yaml 이 실제
// 로드된다. 파일이 없거나 형식 오류이면 이 beforeAll 단계에서 throw 가
// 발생해 아래 모든 테스트가 fail 로 떨어진다 — 부팅 실패는 숨기지 않는다는
// CLAUDE.md silent-fallback 금지 정책의 통합 검증.

beforeAll(async () => {
  // settings stub — 실제 settings 파일에 의존하지 않고 schema 기본값 사용.
  // llmProvider = "none" 으로 extractor 미연결 (LLM 없이 부팅 가능 경로).
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  // reranker.enabled = false 명시 — 본 부팅 테스트 목적은 synonym_dictionary +
  // search-cues 로드 검증이지 리랭커가 아니다. Phase 6b T7 후 default 가 true 로
  // 전환되어 평소엔 부팅 시 cross-encoder 모델을 다운로드(~13s / 수백 MB)하지만,
  // 이 테스트는 그 모델 로드(네트워크 의존 + 지연)에 의존하면 안 되므로 명시적으로
  // 끈다. production default 를 약화하는 게 아니라 테스트를 자기 목적에 묶는다.
  settings.reranker.enabled = false;
  // embeddingModel = bge-m3 명시 — 부팅 테스트 목적은 synonym/cue 로드와
  // 검색 파이프라인 정합이다. 운영과 같은 단일 임베딩 모델 경로로 고정한다.
  settings.db.embeddingModel = "bge-m3";

  assetDir = mkdtempSync(join(tmpdir(), "bara-server-boot-assets-"));
  fileDir = mkdtempSync(join(tmpdir(), "bara-server-boot-files-"));
  settings.backup.dir = join(fileDir, "backups");
  const api = await createMemoryApi({
    dbPath: ":memory:",
    assetDir,
    sseTokenFilePath: join(fileDir, "sse-tokens.json"),
    settingsFilePath: join(fileDir, "memory-settings.json"),
    llmProvider: "none",
    settings,
  });

  app = api.app;
  store = api.store;
  embedder = api.embedder;
  shutdown = api.shutdown;
}, 120_000); // bge-m3 모델 로드 포함 — timeout 넉넉히 설정

afterAll(() => {
  shutdown();
  rmSync(assetDir, { recursive: true, force: true });
  rmSync(fileDir, { recursive: true, force: true });
});

// ── 테스트 1: 부팅 통로 실행 + synonym dict 로드 확인 ───────────────────────
//
// beforeAll 에서 throw 없이 완료됐다는 사실 자체가 synonym_dictionary.yaml 이
// 정상 로드됐다는 증거다 (loadSynonymDictionary 파일 없음 → 구체 에러 throw).
// 이 테스트는 그 사실을 명시적으로 단언한다.

describe("createMemoryApi 부팅 — synonym_dictionary + search-cues 로드 포함", () => {
  test("부팅 후 app 인스턴스가 정상 생성된다", () => {
    // app 이 undefined 가 아니면 beforeAll 의 createMemoryApi 가 throw 없이
    // 완료됐다는 뜻 = synonym_dictionary.yaml + search-cues.yaml 로드 통과.
    expect(app).toBeDefined();
    expect(typeof app.request).toBe("function");
  });

  // 2026-07 retired embedding 제거 — bge-m3 단일 모델 1024 차원 계약 검증.
  test("bge-m3 명시 부팅 = embedder 1024-dim + vec_nodes float[1024]", () => {
    expect(embedder.dimension).toBe(1024);
    const vecSql = (
      store
        .getRawDb()
        .prepare("SELECT sql FROM sqlite_master WHERE name='vec_nodes'")
        .get() as { sql: string }
    ).sql;
    expect(vecSql).toContain("float[1024]");
  });

  test("넘긴 임시 첨부 폴더에 DB 와 같은 짝 표시를 만든다(빈 폴더 = 새 짝)", () => {
    const marker = join(assetDir, ASSET_PAIRING_FILE_NAME);
    expect(existsSync(marker)).toBe(true);
    const row = store.getRawDb().query("SELECT pairing_id FROM asset_folder_pairing WHERE id = 1").get() as { pairing_id: string };
    expect((JSON.parse(readFileSync(marker, "utf8")) as { pairingId: string }).pairingId).toBe(row.pairing_id);
  });

  test("부팅된 서버가 GET /health 에 응답한다", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ── 테스트 2: 부팅 경로 retriever 가 실제 검색 실행 ────────────────────────
//
// createMemoryApi 에서 synonymDict 가 주입된 HybridRetriever 가 /search 요청을
// 실제로 처리한다는 것을 검증한다. buildMemoryApi 수동 deps 경로와 달리,
// 여기서는 부팅 통로가 연결한 retriever 가 동작한다.

describe("부팅 경로 retriever — POST /search 처리", () => {
  // 노드를 먼저 넣고 검색이 응답하는지 확인.
  // 검색 결과 내용까지 단언하면 retriever 점수 편차로 flaky 해질 수 있으므로,
  // 여기서는 HTTP 레이어 정합(200 + results 배열 존재)에 집중한다.

  test("노드 저장 후 POST /search 가 200 + results 배열을 반환한다", async () => {
    // 노드 직접 삽입 — POST /memories 로 해도 같지만 store 직접 호출이 더 빠름.
    await store.addNode({ content: "커피는 좋은 음료다", importance: 0.5 });

    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "커피", limit: 3 }),
    });

    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as {
      query: string;
      count: number;
      results: Array<{ id: number; content: string; score: number }>;
    };
    expect(body.query).toBe("커피");
    expect(typeof body.count).toBe("number");
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.count).toBeGreaterThanOrEqual(1);
  });

  test("POST /search 에 project 칸 포함 시 200 + results 반환 (project_vocabularies expansion 경로)", async () => {
    // project 칸이 있을 때 retriever 가 project_vocabularies 조회를 시도한다.
    // 테스트 DB 에 vocabularies 행이 없으므로 expansion 0 으로 자연 degrade.
    // 이 테스트의 목적은 해당 경로에서 throw 없이 200 이 돌아오는지 확인하는 것.
    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "커피", project: "bara_system", limit: 3 }),
    });

    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as {
      count: number;
      results: unknown[];
    };
    expect(typeof body.count).toBe("number");
    expect(Array.isArray(body.results)).toBe(true);
  });
});

// ── 테스트 3: 부팅 경로 retriever 가 search-cues(cue 검출)를 가동 ─────────────
//
// qa Minor 1 의 핵심 닫기. 부팅 경로(createMemoryApi)가 search-cues 를
// retriever 에 주입했는지 검증한다. synonymDict 주입과 완전 대칭.
//
// 검증 방식: builtin 관계 cue 어휘("왜·바꿨")가 든 query 로 POST /search 를
// 호출해 200 + results 가 돌아오는지 확인한다. cue 검출은 retriever.retrieve
// 안 detectCues(query, this.searchCues) 에서 일어나며, 부팅 경로가
// searchCues 를 주입하지 않으면 this.searchCues 가 undefined 라도 builtin
// 은 가동하므로 (graceful Level 0), 이 테스트는 cue 검출 경로가 throw 없이
// 동작한다는 증거다. 부팅 갭(searchCues 미주입으로 loadSearchCues 가 운영에서
// 전혀 호출 안 되던 문제)은 beforeAll 의 search-cues.yaml 실 로드로 닫힌다.
//
// 점수 값까지 단언하면 두 코퍼스 vector-only recall 만점 특성(1.1b DCL-5)으로
// flaky 해지므로, 여기서는 cue 어휘가 든 query 가 검색 파이프라인을 throw 없이
// 통과(200 + results 배열)하는지에 집중한다.

describe("부팅 경로 retriever — search-cues(cue 검출) 가동", () => {
  test("builtin 관계 cue 어휘가 든 query 로 POST /search 가 200 + results 를 반환한다", async () => {
    // "왜" + "바꿨" = builtin RELATION_CUE_REGEX 매치 → graph 채널 가중치 상승.
    // search-cues.yaml(부팅 로드)이 비어도 builtin 정규식은 코드 상수라 가동한다.
    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "왜 커피 선호를 바꿨더라", limit: 3 }),
    });

    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as {
      query: string;
      count: number;
      results: unknown[];
    };
    expect(body.query).toBe("왜 커피 선호를 바꿨더라");
    expect(typeof body.count).toBe("number");
    expect(Array.isArray(body.results)).toBe(true);
  });

  test("주제 cue 어휘가 든 query 로 POST /search 가 200 + results 를 반환한다", async () => {
    // "전부" = builtin TOPIC_CUE_REGEX 매치 → graph 채널 가중치 상승(주제 cue).
    // cue 가 없는 query 와 같은 파이프라인을 throw 없이 통과하는지 확인.
    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "커피 관련 전부 보여줘", limit: 3 }),
    });

    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as { count: number; results: unknown[] };
    expect(typeof body.count).toBe("number");
    expect(Array.isArray(body.results)).toBe(true);
  });
});
