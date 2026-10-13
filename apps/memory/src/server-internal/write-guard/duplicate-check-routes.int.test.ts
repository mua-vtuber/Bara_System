/**
 * duplicate-check-routes.int.test.ts — 유사-중복 차단의 REST 통로 통합 검증
 * (T16 / 결정 D-A).
 *
 * write-guard-routes.int.test.ts(T15) harness 양식을 그대로 따른다 — 실
 * SqliteMemoryStore(:memory:) + 실 Bgem3Embedder + 실 Hono app, mock 클래스 0.
 * 거부됐다는 사실을 상태 코드만이 아니라 **DB 행 수가 안 늘었다**로 직접
 * 확인한다("에러를 냈지만 저장은 됐다" 반쪽 실패 차단).
 *
 * 문장 쌍은 T14 실측 갈래 기준 — "진짜 중복(verbatim 변형)"은 임계 위,
 * "관련-비중복"은 아래. 실측 여유가 커 q8 수치 흔들림에 흔들리지 않는다.
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

const ORIGINAL = "배포는 매주 화요일 오후 3시에 하기로 정했다.";
const NEAR_DUPLICATE = "배포는 매주 화요일 오후 3시에 진행하기로 했다.";
const RELATED_DISTINCT = "배포 실패 시 롤백은 이전 태그로 되돌리기로 정했다.";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

const openDbs: Database[] = [];

interface Harness {
  app: Hono;
  db: Database;
}

/**
 * duplicateCheck 설정을 원하는 값으로 둔 harness. settings 미지정이면
 * getSettings 자체를 안 넘긴다 — 검사가 fail-safe 로 가동해야 한다.
 */
function makeHarness(duplicateCheck?: {
  enabled?: boolean;
  threshold?: number;
}): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  openDbs.push(db);
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  if (duplicateCheck === undefined) {
    return { app: buildMemoryApi({ store, retriever, assembler }), db };
  }
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  if (duplicateCheck.enabled !== undefined) {
    settings.writeGuard.duplicateCheck.enabled = duplicateCheck.enabled;
  }
  if (duplicateCheck.threshold !== undefined) {
    settings.writeGuard.duplicateCheck.threshold = duplicateCheck.threshold;
  }
  const app = buildMemoryApi({
    store,
    retriever,
    assembler,
    getSettings: () => settings,
  });
  return { app, db };
}

function nodeCount(db: Database): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }
  ).n;
}

async function postMemory(
  app: Hono,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("/memories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

describe("POST /memories — 유사-중복 차단", () => {
  test("유사-중복 → 409 + { code, message, details } + 저장 0", async () => {
    const h = makeHarness();
    const firstRes = await postMemory(h.app, { content: ORIGINAL });
    expect(firstRes.status).toBe(201);
    const firstId = ((await firstRes.json()) as { id: number }).id;
    const before = nodeCount(h.db);

    const res = await postMemory(h.app, { content: NEAR_DUPLICATE });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      message: string;
      details: {
        existingId: number;
        similarity: number;
        excerpt: string;
        existingCreatedAt: string;
      };
    };
    expect(body.code).toBe("DUPLICATE");
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.details.existingId).toBe(firstId);
    expect(body.details.similarity).toBeGreaterThanOrEqual(0.89);
    expect(body.details.excerpt).toContain("화요일");
    expect(body.details.existingCreatedAt.length).toBeGreaterThan(0);
    // 진짜로 아무것도 안 남았다.
    expect(nodeCount(h.db)).toBe(before);
  });

  test("force:true → 201 저장(중복 검사만 우회)", async () => {
    const h = makeHarness();
    await postMemory(h.app, { content: ORIGINAL });
    const res = await postMemory(h.app, {
      content: NEAR_DUPLICATE,
      force: true,
    });

    expect(res.status).toBe(201);
    expect(nodeCount(h.db)).toBe(2);
  });

  test("관련-비중복 쌍은 임계 아래라 201 로 저장된다", async () => {
    const h = makeHarness();
    await postMemory(h.app, { content: ORIGINAL });
    const res = await postMemory(h.app, { content: RELATED_DISTINCT });

    expect(res.status).toBe(201);
    expect(nodeCount(h.db)).toBe(2);
  });

  test("정확 재입력은 409 가 아니라 201 흡수(cacheHit) — 게이트 순서", async () => {
    const h = makeHarness();
    await postMemory(h.app, { content: ORIGINAL });
    const res = await postMemory(h.app, { content: ORIGINAL });

    expect(res.status).toBe(201);
    expect(((await res.json()) as { cacheHit: boolean }).cacheHit).toBe(true);
    expect(nodeCount(h.db)).toBe(1);
  });

  test("getSettings 미주입이어도 검사가 가동한다(fail-safe)", async () => {
    const h = makeHarness();
    await postMemory(h.app, { content: ORIGINAL });
    const res = await postMemory(h.app, { content: NEAR_DUPLICATE });
    expect(res.status).toBe(409);
  });
});

describe("POST /memories — 프로젝트 경계 (수정 1회차 High)", () => {
  test("같은 글을 다른 project 로 보내면 201 저장(둘째 프로젝트 저장 가능)", async () => {
    const h = makeHarness();
    const first = await postMemory(h.app, {
      content: ORIGINAL,
      projectId: "project-a",
    });
    expect(first.status).toBe(201);

    const res = await postMemory(h.app, {
      content: ORIGINAL,
      projectId: "project-b",
    });
    expect(res.status).toBe(201);
    expect(nodeCount(h.db)).toBe(2);
  });

  test("닮은 글도 다른 project 면 409 가 아니다 + 남의 기억 정보가 안 샌다", async () => {
    const h = makeHarness();
    await postMemory(h.app, { content: ORIGINAL, projectId: "project-a" });
    const res = await postMemory(h.app, {
      content: NEAR_DUPLICATE,
      projectId: "project-b",
    });

    expect(res.status).toBe(201);
    // 409 였다면 본문에 project-a 노드 id·발췌가 실려 나갔을 것이다.
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain("화요일 오후 3시에 하기로");
  });

  test("같은 project 안에서는 그대로 409(기존 동작 불변)", async () => {
    const h = makeHarness();
    await postMemory(h.app, { content: ORIGINAL, projectId: "project-a" });
    const res = await postMemory(h.app, {
      content: NEAR_DUPLICATE,
      projectId: "project-a",
    });

    expect(res.status).toBe(409);
    expect(nodeCount(h.db)).toBe(1);
  });
});

describe("POST /memories — 설정 반영", () => {
  test("enabled:false 면 유사-중복도 201 로 저장된다", async () => {
    const h = makeHarness({ enabled: false });
    await postMemory(h.app, { content: ORIGINAL });
    const res = await postMemory(h.app, { content: NEAR_DUPLICATE });

    expect(res.status).toBe(201);
    expect(nodeCount(h.db)).toBe(2);
  });

  test("threshold 사용자 오버라이드가 모델 연동값을 이긴다", async () => {
    // 0.89 default 로는 통과하던 관련-비중복 쌍이 낮춘 임계에서는 막힌다.
    const h = makeHarness({ threshold: 0.3 });
    await postMemory(h.app, { content: ORIGINAL });
    const res = await postMemory(h.app, { content: RELATED_DISTINCT });

    expect(res.status).toBe(409);
    expect(nodeCount(h.db)).toBe(1);
  });

  test("threshold 음수 sentinel 은 모델 연동값 사용 — 관련-비중복 통과", async () => {
    const h = makeHarness({ threshold: -1 });
    await postMemory(h.app, { content: ORIGINAL });
    const res = await postMemory(h.app, { content: RELATED_DISTINCT });

    expect(res.status).toBe(201);
    expect(nodeCount(h.db)).toBe(2);
  });
});
