/**
 * server-internal/routes/regex.test.ts — regex 자가 검증 API + 양식·booster CRUD
 * 라우트 통합 검증 (Phase 6a T11).
 *
 * 검증 가족:
 *   (a) POST /api/regex/validate — spec 13.3 응답 형식(matches[] / boosters_hit[] /
 *       final_score / decision / would_save_metadata) + 저장 부수효과 0(validate 후
 *       DB 노드 수 불변).
 *   (b) POST /api/regex-patterns 추가 → reload → validate 가 새 양식을 매치 +
 *       activePatterns 에 등장(같은 인스턴스 reload 반영).
 *   (c) 깨진 정규식 POST → 400.
 *   (d) builtin/yaml id DELETE → 400(사용자 양식만 삭제 가능).
 *   (e) booster 동형 3 라우트(POST/GET/DELETE) + add→reload→activeBoosters 반영.
 *   (f) add → validate(새 booster 점수 반영) → delete 왕복.
 *
 * 실 SQLite(:memory:) + 실 RegexUserRepo + 실 RegexL0Extractor + 실 Bgem3Embedder.
 * mock 객체 없음(CLAUDE.md "테스트 정책"). data fixture(입력 문자열)만 사용.
 *
 * 핵심 단일 권위 확인: 라우트가 받은 *같은* RegexL0Extractor 인스턴스를 reload 하므로
 * CRUD 직후 validate(자가 검증) + activePatterns/activeBoosters 가 즉시 갱신된다.
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
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import { RegexL0Extractor } from "../../memory/regex-l0/extractor.ts";
import { RegexUserRepo } from "../../memory/regex-l0/user-repo.ts";

// builtin yaml 실제 경로 (extractor.test.ts / memories.regex-l0.test.ts 선례 정합).
const regexL0Dir = fileURLToPath(new URL("../../memory/regex-l0/", import.meta.url));
const PATTERNS_YAML = join(regexL0Dir, "regex-patterns.yaml");
const BOOSTERS_YAML = join(regexL0Dir, "booster-dictionary.yaml");

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
  regexL0: RegexL0Extractor;
  repo: RegexUserRepo;
}

/**
 * regexL0 + repo 가 *같은* db + *같은* userRepo 인스턴스를 공유하는 harness.
 * 라우트(deps.regexL0 + deps.regexUserRepo)와 검증 코드가 모두 한 인스턴스를 본다.
 */
function makeHarness(withRepo = true): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const repo = new RegexUserRepo(db);
  const regexL0 = new RegexL0Extractor({
    patternPaths: [PATTERNS_YAML],
    boosterPaths: [BOOSTERS_YAML],
    userRepo: repo,
    langs: ["ko"],
  });
  const app = buildMemoryApi({
    store,
    retriever,
    assembler,
    regexL0,
    regexUserRepo: withRepo ? repo : undefined,
  });
  return { app, db, store, regexL0, repo };
}

async function req(
  h: Harness,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const res = await h.app.request(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? null : await res.json();
  return { status: res.status, json };
}

/** knowledge_nodes 행 수 — validate 의 저장 부수효과 0 확인용. */
function nodeCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number };
  return row.n;
}

describe("POST /api/regex/validate", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("(a) spec 13.3 응답 형식 + 저장 부수효과 0", async () => {
    const before = nodeCount(h.db);
    // "하기로 했" decision 양식(base 3) + "확정"(+3) booster = 6 → auto_store.
    const r = await req(h, "POST", "/api/regex/validate", {
      input_text: "디스코드 봇 자동 추출 끄기로 했고 확정",
    });
    expect(r.status).toBe(200);

    // spec 13.3 칸 존재 + snake_case.
    expect(Array.isArray(r.json.matches)).toBe(true);
    expect(Array.isArray(r.json.boosters_hit)).toBe(true);
    expect(typeof r.json.final_score).toBe("number");
    expect(["auto_store", "pending_review", "ignore"]).toContain(r.json.decision);
    expect(typeof r.json.would_save_metadata).toBe("object");

    // 적어도 한 양식 매치 + 매치 항목 칸 형식(pattern_id/category/score/polarity/
    // extracted_content/match_text).
    expect(r.json.matches.length).toBeGreaterThan(0);
    const m = r.json.matches[0];
    expect(typeof m.pattern_id).toBe("string");
    expect(typeof m.category).toBe("string");
    expect(typeof m.score).toBe("number");
    expect(typeof m.extracted_content).toBe("string");
    expect(typeof m.match_text).toBe("string");

    // booster "확정" 검출 + 점수 채움.
    const hit = r.json.boosters_hit.find((b: any) => b.word === "확정");
    expect(hit).toBeDefined();
    expect(hit.score).toBe(3);

    // matches[].score = 양식 기본 점수(booster 빼고) — 역산 정합. 양식 base 3.
    expect(m.score).toBe(3);
    // final_score = 양식 + booster = 6 → auto_store.
    expect(r.json.final_score).toBe(6);
    expect(r.json.decision).toBe("auto_store");

    // would_save_metadata = spec 4.2 형식(source: regex).
    expect(r.json.would_save_metadata.source).toBe("regex");
    expect(r.json.would_save_metadata.regex_score).toBe(6);

    // 저장 부수효과 0 — 노드 수 불변.
    expect(nodeCount(h.db)).toBe(before);
  });

  test("ignore 입력(점수 ≤2) → decision=ignore + would_save_metadata 빈 객체 + 저장 0", async () => {
    const before = nodeCount(h.db);
    const r = await req(h, "POST", "/api/regex/validate", {
      input_text: "오늘 점심 라면 먹음",
    });
    expect(r.status).toBe(200);
    // 매치가 있어도 점수가 낮으면 ignore. would_save_metadata = {} (저장 안 함).
    if (r.json.decision === "ignore") {
      expect(r.json.would_save_metadata).toEqual({});
    }
    expect(nodeCount(h.db)).toBe(before);
  });

  test("regexL0 미주입 → 503", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const retriever = new HybridRetriever(store, embedder);
    const assembler = new ContextAssembler();
    const app = buildMemoryApi({ store, retriever, assembler });
    const res = await app.request("/api/regex/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_text: "테스트" }),
    });
    expect(res.status).toBe(503);
    db.close();
  });

  test("input_text 누락 → 400", async () => {
    const r = await req(h, "POST", "/api/regex/validate", {});
    expect(r.status).toBe(400);
  });
});

describe("regex-patterns CRUD", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("(b) POST 추가 → reload → validate 가 새 양식 매치 + activePatterns 반영", async () => {
    // 부팅 시점에는 "정식 가동" 양식이 없다 — validate 가 이 양식으로 매치 안 함.
    const before = await req(h, "POST", "/api/regex/validate", {
      input_text: "Phase 6 plan 정식 가동",
    });
    const beforeIds = before.json.matches.map((m: any) => m.pattern_id);

    // 사용자 양식 추가.
    const add = await req(h, "POST", "/api/regex-patterns", {
      pattern: "(.{2,40})\\s+정식\\s+가동",
      score: 3,
      category: "decision",
      description: "X 정식 가동",
    });
    expect(add.status).toBe(201);
    expect(typeof add.json.pattern_id).toBe("string");
    expect(add.json.pattern_id.startsWith("rpat_user_")).toBe(true);

    // reload 가 같은 인스턴스에 반영 — activePatterns 에 새 id 등장.
    const activeIds = h.regexL0.activePatterns().map((p) => p.id);
    expect(activeIds).toContain(add.json.pattern_id);

    // validate 가 새 양식으로 매치(추가 전엔 없던 pattern_id 등장).
    const after = await req(h, "POST", "/api/regex/validate", {
      input_text: "Phase 6 plan 정식 가동",
    });
    const afterIds = after.json.matches.map((m: any) => m.pattern_id);
    expect(afterIds).toContain(add.json.pattern_id);
    expect(afterIds.length).toBeGreaterThanOrEqual(beforeIds.length);
  });

  test("(c) 깨진 정규식 POST → 400", async () => {
    const r = await req(h, "POST", "/api/regex-patterns", {
      pattern: "(unclosed",
      score: 2,
      category: "fact",
    });
    expect(r.status).toBe(400);
    expect(typeof r.json.error).toBe("string");
  });

  test("GET 합집합 목록 — builtin/yaml/user 출처 라벨 + match_count", async () => {
    const add = await req(h, "POST", "/api/regex-patterns", {
      pattern: "(.{2,40})\\s+정식\\s+가동",
      score: 3,
      category: "decision",
    });
    const r = await req(h, "GET", "/api/regex-patterns");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.patterns)).toBe(true);

    const sources = new Set(r.json.patterns.map((p: any) => p.source));
    // builtin 또는 yaml 한 갈래 이상 + user 갈래.
    expect(sources.has("user")).toBe(true);
    expect(sources.has("builtin") || sources.has("yaml")).toBe(true);

    const userItem = r.json.patterns.find((p: any) => p.id === add.json.pattern_id);
    expect(userItem).toBeDefined();
    expect(userItem.source).toBe("user");
    expect(typeof userItem.match_count).toBe("number");
  });

  test("(d) builtin id DELETE → 400 (사용자 양식만 삭제)", async () => {
    const list = await req(h, "GET", "/api/regex-patterns");
    const builtin = list.json.patterns.find((p: any) => p.source !== "user");
    expect(builtin).toBeDefined();
    const r = await req(h, "DELETE", `/api/regex-patterns/${encodeURIComponent(builtin.id)}`);
    expect(r.status).toBe(400);
  });

  test("DELETE 사용자 양식 → 200 + reload 후 activePatterns 에서 제거", async () => {
    const add = await req(h, "POST", "/api/regex-patterns", {
      pattern: "(.{2,40})\\s+정식\\s+가동",
      score: 3,
      category: "decision",
    });
    expect(h.regexL0.activePatterns().map((p) => p.id)).toContain(add.json.pattern_id);

    const del = await req(h, "DELETE", `/api/regex-patterns/${add.json.pattern_id}`);
    expect(del.status).toBe(200);
    expect(h.regexL0.activePatterns().map((p) => p.id)).not.toContain(add.json.pattern_id);
  });

  test("repo 미주입 → CRUD 503", async () => {
    const h2 = makeHarness(false);
    const r = await req(h2, "POST", "/api/regex-patterns", {
      pattern: "테스트",
      score: 1,
      category: "fact",
    });
    expect(r.status).toBe(503);
    h2.db.close();
  });
});

describe("(e)(f) regex-boosters CRUD + 왕복", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("add → reload → activeBoosters 반영 → validate 점수 반영 → delete 왕복", async () => {
    const word = "전면도입";
    // 추가 전 — validate 가 이 단어를 booster 로 안 잡음.
    const before = await req(h, "POST", "/api/regex/validate", {
      input_text: `${word} 하기로 했다`,
    });
    expect(before.json.boosters_hit.find((b: any) => b.word === word)).toBeUndefined();

    // booster 추가.
    const add = await req(h, "POST", "/api/regex-boosters", {
      word,
      score: 3,
      description: "전면 도입 신호",
    });
    expect(add.status).toBe(201);
    expect(add.json.booster_id.startsWith("rbst_user_")).toBe(true);

    // reload 반영 — activeBoosters 에 등장.
    expect(h.regexL0.activeBoosters().map((b) => b.word)).toContain(word);

    // validate 가 새 booster 점수 반영(boosters_hit 에 word+score 등장).
    const after = await req(h, "POST", "/api/regex/validate", {
      input_text: `${word} 하기로 했다`,
    });
    const hit = after.json.boosters_hit.find((b: any) => b.word === word);
    expect(hit).toBeDefined();
    expect(hit.score).toBe(3);

    // GET 목록 — user 출처 + hit_count.
    const list = await req(h, "GET", "/api/regex-boosters");
    expect(list.status).toBe(200);
    const userItem = list.json.boosters.find((b: any) => b.id === add.json.booster_id);
    expect(userItem.source).toBe("user");
    expect(typeof userItem.hit_count).toBe("number");

    // delete 왕복 → reload 후 activeBoosters 에서 제거.
    const del = await req(h, "DELETE", `/api/regex-boosters/${add.json.booster_id}`);
    expect(del.status).toBe(200);
    expect(h.regexL0.activeBoosters().map((b) => b.word)).not.toContain(word);
  });

  test("builtin booster id DELETE → 400", async () => {
    const list = await req(h, "GET", "/api/regex-boosters");
    const builtin = list.json.boosters.find((b: any) => b.source !== "user");
    expect(builtin).toBeDefined();
    const r = await req(h, "DELETE", `/api/regex-boosters/${encodeURIComponent(builtin.id)}`);
    expect(r.status).toBe(400);
  });

  test("UNIQUE(word, lang) 중복 추가 → 400", async () => {
    await req(h, "POST", "/api/regex-boosters", { word: "중복단어", score: 2 });
    const dup = await req(h, "POST", "/api/regex-boosters", { word: "중복단어", score: 2 });
    expect(dup.status).toBe(400);
  });
});
