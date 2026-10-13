/**
 * server-internal/routes/memories.regex-l0.test.ts — POST /memories 안 regex
 * Level 0 단계 wiring 검증 (Phase 6a T9).
 *
 * regex L0 단계는 raw 저장·LLM extractor 분기보다 *앞*에서 한 번 추출하고, 점수
 * ≥5(auto_store) + 3~4(pending_review) 후보를 atomic 노드로 저장하면서 raw 노드에
 * merged_into 엣지를 연결한다. ≤2(ignore) 후보는 저장 대상에서 제외한다. 두
 * raw-save 갈래(immediate extractor 분기 / 옛 흐름) 모두에 같은 헬퍼로 적용한다.
 *
 * 검증 가족:
 *   (a) 점수 ≥5 한국어 입력 → regex atomic 노드 polarity 칸 채움 + merged_into + raw 보존
 *   (b) 점수 3~4 입력 → pending_review atomic 노드 저장(metadata.pending_review===true) + merged_into
 *   (c) 점수 0 입력 → regex atomic 0, raw 1
 *   (d) settings regex off / deps.regexL0 미주입 → 옛 흐름(regex atomic 0, 기존 동작)
 *   (e) immediate 분기 공존 — 가짜 Ollama + 실제 OllamaClient + 실제 MemoryExtractor 로
 *       LLM atomic + regex atomic 둘 다 같은 raw 에 merged_into (사용자 결정 #3)
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 RegexL0Extractor. mock 객체 없음
 * (CLAUDE.md "테스트 정책"). (e) 는 가짜 Ollama HTTP 서버(Bun.serve) + 실 OllamaClient
 * — LlmClient 인터페이스 가짜 구현이 아니라 진짜 HTTP 통로 (server.test.ts 선례 정합).
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
import { Hono as HonoCtor } from "hono";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import { RegexL0Extractor } from "../../memory/regex-l0/extractor.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-schema.ts";

// builtin yaml 의 실제 경로 (regex-l0 디렉토리 기준 — extractor.test.ts 선례 정합).
const regexL0Dir = fileURLToPath(new URL("../../memory/regex-l0/", import.meta.url));
const PATTERNS_YAML = join(regexL0Dir, "regex-patterns.yaml");
const BOOSTERS_YAML = join(regexL0Dir, "booster-dictionary.yaml");

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

/** 한국어 양식만 가동하는 default regex L0 추출기. */
function makeKoRegexL0(): RegexL0Extractor {
  return new RegexL0Extractor({
    patternPaths: [PATTERNS_YAML],
    boosterPaths: [BOOSTERS_YAML],
    langs: ["ko"],
  });
}

/** regex 가동 settings 한 벌 (regex.enabled=true / llm.extractor mode=backfill 기본). */
function buildSettings(regexEnabled: boolean, mode: "immediate" | "backfill" = "backfill"): MemorySettings {
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.extractor.regex.enabled = regexEnabled;
  settings.llm.extractor.mode = mode;
  return settings;
}

interface MemoryNodeShape {
  id: number;
  content: string;
  importance: number;
  polarity: string | null;
  metadata: Record<string, unknown>;
}

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

async function jsonBody(res: Response): Promise<unknown> {
  return res.json();
}

/** POST /memories 한 통로. id + node 반환. */
async function postMemory(
  h: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; id: number; node: MemoryNodeShape }> {
  const res = await h.app.request("/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await jsonBody(res)) as { id: number; node: MemoryNodeShape };
  return { status: res.status, id: parsed.id, node: parsed.node };
}

/** raw 노드 id 로 merged_into 자식(=regex/llm atomic) 노드들을 찾는다. */
async function childrenMergedInto(store: SqliteMemoryStore, rawId: number): Promise<MemoryNodeShape[]> {
  // merged_into 엣지는 sourceId=child, targetId=raw (line 131-138 패턴).
  // getNeighbors 는 source_id=raw OR target_id=raw 둘 다 반환하므로 targetId=raw 만 거른다.
  const edges = await store.getNeighbors(rawId, 1000);
  const childIds = edges
    .filter((e) => e.relation === "merged_into" && e.targetId === rawId)
    .map((e) => e.sourceId);
  const out: MemoryNodeShape[] = [];
  for (const cid of childIds) {
    const node = await store.getNode(cid);
    if (node) out.push(node as unknown as MemoryNodeShape);
  }
  return out;
}

// ── 옛 흐름 갈래(path B) — regex L0 단계 ───────────────────────────────────

describe("POST /memories — regex L0 단계 (옛 흐름 / path B)", () => {
  let h: Harness;

  function makeHarness(opts: { regexEnabled: boolean; withRegexL0: boolean }): Harness {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const retriever = new HybridRetriever(store, embedder);
    const assembler = new ContextAssembler();
    const app = buildMemoryApi({
      store,
      retriever,
      assembler,
      regexL0: opts.withRegexL0 ? makeKoRegexL0() : undefined,
      getSettings: () => buildSettings(opts.regexEnabled),
    });
    return { app, db, store };
  }

  afterEach(() => {
    if (h) h.db.close();
  });

  test("(a) 점수 ≥5 입력 → auto_store atomic 노드 polarity 채움 + merged_into + raw 보존", async () => {
    h = makeHarness({ regexEnabled: true, withRegexL0: true });
    // "앞으로(+3) + 확정(+3)" booster + decision 양식(base 3) = 9 → auto_store.
    const r = await postMemory(h, { content: "앞으로 디스코드 봇 자동 추출 끄기로 확정" });
    expect(r.status).toBe(201);

    // raw 노드는 항상 보존.
    const raw = await h.store.getNode(r.id);
    expect(raw).not.toBeNull();
    expect(raw!.content).toBe("앞으로 디스코드 봇 자동 추출 끄기로 확정");

    // regex atomic 자식 — auto_store 1개 이상, polarity 칸 채움, source=regex.
    const children = await childrenMergedInto(h.store, r.id);
    const autoStored = children.filter((c) => c.metadata.source === "regex" && c.metadata.auto_stored === true);
    expect(autoStored.length).toBeGreaterThanOrEqual(1);
    const child = autoStored[0]!;
    expect(child.polarity).toBe("positive"); // decision 양식 default polarity
    expect(child.metadata.regex_score).toBeGreaterThanOrEqual(5);
    expect(child.metadata.pending_review).toBeUndefined();
    // importance = scoreToImportance(finalScore) = clamp(9/10) = 0.9.
    expect(child.importance).toBeGreaterThan(0.5);
  });

  test("(b) 점수 3~4 입력 → pending_review atomic 노드 저장 + merged_into", async () => {
    h = makeHarness({ regexEnabled: true, withRegexL0: true });
    // decision 양식 단독(base 3) + booster 0 = 3 → pending_review.
    const r = await postMemory(h, { content: "RRF 합산 방식을 채택했어" });
    expect(r.status).toBe(201);

    const children = await childrenMergedInto(h.store, r.id);
    const pending = children.filter((c) => c.metadata.source === "regex" && c.metadata.pending_review === true);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const child = pending[0]!;
    expect(child.metadata.auto_stored).toBe(false);
    expect(child.metadata.regex_score).toBe(3);
    // pending_review 도 저장은 됨 (검색 비노출은 T9.5 책임).
    const stored = await h.store.getNode(child.id);
    expect(stored).not.toBeNull();
  });

  test("(c) 점수 0(ignore) 입력 → regex atomic 0, raw 1", async () => {
    h = makeHarness({ regexEnabled: true, withRegexL0: true });
    // "임시(-2) + ㅋㅋ(-1)" → 저장 후보 0.
    const r = await postMemory(h, { content: "이거 임시로 SQLite 쓰기로 했어 ㅋㅋ" });
    expect(r.status).toBe(201);

    const raw = await h.store.getNode(r.id);
    expect(raw).not.toBeNull();
    const children = await childrenMergedInto(h.store, r.id);
    const regexChildren = children.filter((c) => c.metadata.source === "regex");
    expect(regexChildren.length).toBe(0);
  });

  test("(d-1) settings regex off → 옛 흐름 (regex atomic 0)", async () => {
    h = makeHarness({ regexEnabled: false, withRegexL0: true });
    const r = await postMemory(h, { content: "앞으로 디스코드 봇 자동 추출 끄기로 확정" });
    expect(r.status).toBe(201);
    const children = await childrenMergedInto(h.store, r.id);
    expect(children.filter((c) => c.metadata.source === "regex").length).toBe(0);
  });

  test("(d-2) deps.regexL0 미주입 → 옛 흐름 (regex atomic 0)", async () => {
    h = makeHarness({ regexEnabled: true, withRegexL0: false });
    const r = await postMemory(h, { content: "앞으로 디스코드 봇 자동 추출 끄기로 확정" });
    expect(r.status).toBe(201);
    const children = await childrenMergedInto(h.store, r.id);
    expect(children.filter((c) => c.metadata.source === "regex").length).toBe(0);
  });

  test("(d-3) getSettings 미주입 → 옛 흐름 (regex atomic 0, 기존 동작 보존)", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const retriever = new HybridRetriever(store, embedder);
    const assembler = new ContextAssembler();
    const app = buildMemoryApi({ store, retriever, assembler, regexL0: makeKoRegexL0() });
    const local: Harness = { app, db, store };
    const r = await postMemory(local, { content: "앞으로 디스코드 봇 자동 추출 끄기로 확정" });
    expect(r.status).toBe(201);
    const children = await childrenMergedInto(store, r.id);
    expect(children.filter((c) => c.metadata.source === "regex").length).toBe(0);
    db.close();
  });
});

// ── immediate 분기 공존(path A) — 사용자 결정 #3 ───────────────────────────
//
// 가짜 Ollama HTTP 서버 + 실 OllamaClient + 실 MemoryExtractor 로 LLM atomic 을
// 만들고, 같은 입력에 regex atomic 도 같은 raw 에 merged_into 됨을 검증한다.
// merged_into 대상은 둘 다 같은 raw 노드다.

interface FakeOllamaState {
  nextContent: string;
  callCount: number;
}

function buildFakeOllamaServer(state: FakeOllamaState): ReturnType<typeof Bun.serve> {
  const app = new HonoCtor();
  app.post("/api/chat", async (c) => {
    state.callCount += 1;
    return c.json({
      model: "fake-extractor-model",
      message: { role: "assistant", content: state.nextContent },
      done: true,
    });
  });
  return Bun.serve({ port: 0, fetch: app.fetch });
}

describe("POST /memories — immediate 분기 + regex 공존 (path A / 사용자 결정 #3)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let app: Hono;
  let ollamaServer: ReturnType<typeof Bun.serve>;
  let fakeState: FakeOllamaState;

  beforeEach(() => {
    fakeState = { nextContent: "[]", callCount: 0 };
    ollamaServer = buildFakeOllamaServer(fakeState);

    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    const retriever = new HybridRetriever(store, embedder);
    const assembler = new ContextAssembler();
    const llm = new OllamaClient({
      baseUrl: `http://127.0.0.1:${ollamaServer.port}`,
      model: "fake-extractor-model",
    });
    const extractor = new MemoryExtractor(llm, store, embedder, {
      duplicateSim: 0.999,
      minImportance: 0,
    });
    app = buildMemoryApi({
      store,
      retriever,
      assembler,
      extractor,
      regexL0: makeKoRegexL0(),
      getSettings: () => buildSettings(true, "immediate"),
    });
  });

  afterEach(() => {
    ollamaServer.stop(true);
    db.close();
  });

  test("(e) immediate LLM atomic + regex atomic 둘 다 같은 raw 에 merged_into", async () => {
    // LLM 추출은 atomic 1개 송출 (importance 0.5).
    fakeState.nextContent = JSON.stringify([
      { content: "디스코드 봇 자동 추출을 끈다", type: "fact", importance: 0.5 },
    ]);

    // 2026-06-02 Q2 — short-text-gate 통과 형태 입력. 이 테스트 의도는 "LLM 추출이
    // 실제로 가서 atomic 을 만들고, regex atomic 과 같은 raw 에 공존한다"이므로 입력이
    // LLM 호출까지 도달해야 한다. 옛 입력("앞으로 디스코드 봇 자동 추출 끄기로 확정",
    // 19자·절 접속어미 없음·단일 종결)은 shouldSkipExtraction 게이트에 걸려 LLM 호출
    // 전 스킵돼(callCount=0) 공존 검증의 전제가 무너졌다. 인과 절("시끄러워서")을 더해
    // hasClauseConnector=true 로 게이트를 통과시킨다. regex 점수의 핵심 어휘(앞으로/
    // 확정/끄기로)는 보존 — regex auto_store 검증 의도 유지(프로덕션 동작 0 변경, 테스트만 정합).
    const res = await app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "앞으로 디스코드 봇 자동 추출이 시끄러워서 끄기로 확정",
      }),
    });
    expect(res.status).toBe(201);
    const parsed = (await jsonBody(res)) as { id: number; extracted: number[] };
    const rawId = parsed.id;

    // immediate 분기 응답 — LLM extracted 칸 보존.
    expect(Array.isArray(parsed.extracted)).toBe(true);
    expect(fakeState.callCount).toBe(1); // LLM 호출 1회 (extractAndStore 안).

    // 같은 raw 에 LLM atomic + regex atomic 둘 다 merged_into.
    const children = await childrenMergedInto(store, rawId);
    const regexChildren = children.filter((c) => c.metadata.source === "regex");
    // regex auto_store atomic 1개 이상.
    expect(regexChildren.length).toBeGreaterThanOrEqual(1);
    expect(regexChildren.some((c) => c.metadata.auto_stored === true)).toBe(true);
    // LLM atomic 도 raw 에 연결 (extracted 와 교집합).
    const extractedIds = new Set(parsed.extracted);
    const llmChildren = children.filter((c) => extractedIds.has(c.id));
    expect(llmChildren.length).toBeGreaterThanOrEqual(1);

    // merged_into 대상은 둘 다 같은 raw 노드.
    const raw = await store.getNode(rawId);
    expect(raw).not.toBeNull();
  });
});
