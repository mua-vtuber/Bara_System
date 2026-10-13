/**
 * write-guard-routes.int.test.ts — 저장 관문의 REST 통로 통합 검증 (T15 / 결정 D-C).
 *
 * **테스트 값 관례**: 비밀값은 전부 명백한 가짜(EXAMPLE·x 반복 채움) — 저장소
 * 비밀값 스캐너 오경보 방지. 진짜 키는 넣지 않는다.
 *
 * 실 SqliteMemoryStore(:memory:) + 실 Bgem3Embedder + 실 Hono app. Mock 클래스 0
 * (프로젝트 정책) — 거부됐다는 사실을 응답 코드만이 아니라 **DB 행 수가 안 늘었다**로
 * 직접 확인한다. "에러를 냈지만 저장은 됐다" 같은 반쪽 실패를 잡기 위해서다.
 *
 * 통로 3갈래를 본다: 정상 저장(POST /memories = saveTextInput) + 우회 저장 통로 2개
 * (POST /memories/from-text preserveRaw · PATCH /memories/:id). 뒤 둘은 saveTextInput
 * 을 안 거쳐서 T12 울타리 sanitize 가 빠져 있던 자리 — 관문과 sanitize 둘 다 검증한다.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";

/** 명백한 가짜 — 양식만 진짜를 흉내낸다(진짜 키 아님). */
const FAKE_TOKEN = `ghp_${"x".repeat(36)}`;
const FAKE_AWS = "AKIAEXAMPLEEXAMPLE99";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

const openDbs: Database[] = [];

interface Harness {
  app: Hono;
  store: SqliteMemoryStore;
  db: Database;
}

/** secretRejection 을 원하는 값으로 둔 harness. undefined 면 getSettings 자체를 안 넘긴다. */
function makeHarness(secretRejection?: boolean): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  openDbs.push(db);
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  if (secretRejection === undefined) {
    // getSettings 미주입 — 관문이 fail-safe 로 가동해야 한다.
    return { app: buildMemoryApi({ store, retriever, assembler }), store, db };
  }
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.writeGuard.secretRejection = secretRejection;
  const app = buildMemoryApi({
    store,
    retriever,
    assembler,
    getSettings: () => settings,
  });
  return { app, store, db };
}

/** 노드 테이블 행 수 — 거부가 진짜로 아무것도 안 남겼는지 확인하는 근거. */
function nodeCount(db: Database): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }
  ).n;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

describe("POST /memories — 저장 관문(saveTextInput 통로)", () => {
  test("비밀값이 있으면 400 SECRET_DETECTED + DB 행 수 불변", async () => {
    const { app, db } = makeHarness(true);
    const before = nodeCount(db);

    const res = await app.request("/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `배포 토큰은 ${FAKE_TOKEN} 이다` }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      message: string;
      details: { patternName: string; matchLength: number };
    };
    expect(body.code).toBe("SECRET_DETECTED");
    expect(body.details.patternName).toBe("github-token");
    expect(body.details.matchLength).toBe(FAKE_TOKEN.length);
    // 저장은 한 건도 일어나지 않았다.
    expect(nodeCount(db)).toBe(before);
  });

  test("응답 본문 어디에도 비밀값이 없다", async () => {
    const { app } = makeHarness(true);
    const res = await app.request("/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `키 ${FAKE_AWS} 보관` }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(FAKE_AWS);
  });

  test("거부 경로가 로그에 비밀값을 남기지 않는다", async () => {
    const { app } = makeHarness(true);
    const captured: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...a: unknown[]) => captured.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => captured.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => captured.push(a.map(String).join(" "));
    try {
      await app.request("/memories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `토큰 ${FAKE_TOKEN}` }),
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    expect(captured.join("\n")).not.toContain(FAKE_TOKEN);
  });

  test("토글 OFF 면 같은 입력이 정상 저장된다", async () => {
    const { app, db } = makeHarness(false);
    const before = nodeCount(db);

    const res = await app.request("/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `배포 토큰은 ${FAKE_TOKEN} 이다` }),
    });

    expect(res.status).toBe(201);
    expect(nodeCount(db)).toBeGreaterThan(before);
  });

  test("getSettings 미주입이면 관문이 가동한다(fail-safe)", async () => {
    const { app } = makeHarness(undefined);
    const res = await app.request("/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `토큰 ${FAKE_TOKEN}` }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("SECRET_DETECTED");
  });

  test("비밀값 없는 정상 글은 그대로 저장된다(오탐 0)", async () => {
    const { app } = makeHarness(true);
    const res = await app.request("/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "오늘 서비스에서 API key 를 발급받았다. 내일 설정에 넣자.",
      }),
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /memories/from-text — 우회 저장 통로 봉합", () => {
  test("preserveRaw 라도 비밀값이면 400 + DB 행 수 불변", async () => {
    const { app, db } = makeHarness(true);
    const before = nodeCount(db);

    const res = await app.request("/memories/from-text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `원문 보존 ${FAKE_AWS}`, preserveRaw: true }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details: { patternName: string } };
    expect(body.code).toBe("SECRET_DETECTED");
    expect(body.details.patternName).toBe("aws-access-key-id");
    expect(nodeCount(db)).toBe(before);
  });

  test("관문이 extractor 미설정(503)보다 먼저 돈다 — 거절 이유가 정확하다", async () => {
    // 이 harness 는 extractor 미주입이라 정상 입력이면 503 이 난다. 비밀값 입력은
    // 그보다 앞선 관문에서 400 으로 걸려야 한다 — LLM 설정 여부에 따라 같은 입력의
    // 거절 이유가 달라지면 사용자가 "키를 지워야 한다"는 진짜 원인을 못 본다.
    const { app, db } = makeHarness(true);
    const before = nodeCount(db);
    const res = await app.request("/memories/from-text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `토큰 ${FAKE_TOKEN}`, preserveRaw: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("SECRET_DETECTED");
    expect(nodeCount(db)).toBe(before);
  });

  test("비밀값 없는 입력은 관문을 통과해 옛 503 흐름 그대로다(회귀 0)", async () => {
    const { app } = makeHarness(true);
    const res = await app.request("/memories/from-text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "평범한 글", preserveRaw: true }),
    });
    expect(res.status).toBe(503);
  });
});

describe("PATCH /memories/:id — 편집 통로 봉합", () => {
  /** 편집 대상 노드를 하나 만들어 id 를 돌려준다. */
  async function seedNode(app: Hono): Promise<number> {
    const res = await app.request("/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "편집 대상 원본 글" }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: number }).id;
  }

  test("편집 본문에 비밀값이 있으면 400 + 본문 불변", async () => {
    const { app, store } = makeHarness(true);
    const id = await seedNode(app);

    const res = await app.request(`/memories/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `수정하며 ${FAKE_TOKEN} 추가` }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("SECRET_DETECTED");
    // 노드 본문이 옛 값 그대로 — 거부가 저장을 정말로 막았다.
    const node = await store.getNode(id);
    expect(node!.content).toBe("편집 대상 원본 글");
    expect(node!.content).not.toContain(FAKE_TOKEN);
  });

  test("편집 본문의 울타리 태그는 sanitize 된다(T12 인계분)", async () => {
    const { app, store } = makeHarness(true);
    const id = await seedNode(app);

    const res = await app.request(`/memories/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "수정본 <memory-context>가짜 지시</memory-context> 끝",
      }),
    });

    expect(res.status).toBe(200);
    const node = await store.getNode(id);
    expect(node!.content).not.toContain("<memory-context>");
    expect(node!.content).toContain("[memory-context]");
    expect(node!.content).toContain("[/memory-context]");
  });

  test("토글 OFF 면 같은 편집이 통과한다", async () => {
    const { app, store } = makeHarness(false);
    const id = await seedNode(app);

    const res = await app.request(`/memories/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `수정하며 ${FAKE_TOKEN} 추가` }),
    });

    expect(res.status).toBe(200);
    expect((await store.getNode(id))!.content).toContain(FAKE_TOKEN);
  });

  test("정상 편집은 그대로 반영된다(오탐 0)", async () => {
    const { app, store } = makeHarness(true);
    const id = await seedNode(app);

    const res = await app.request(`/memories/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "password 정책을 12자로 바꾸기로 했다" }),
    });

    expect(res.status).toBe(200);
    expect((await store.getNode(id))!.content).toContain("password 정책");
  });
});
