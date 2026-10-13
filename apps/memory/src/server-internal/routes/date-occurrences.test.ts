/**
 * date-occurrences route — query 검증 + buildMemoryApi 연결 회귀.
 *
 * 실 SqliteMemoryStore(:memory:) 위에서 라우트만 얇게 확인한다. 날짜 계산 세부 규칙은
 * memory/date-occurrences.test.ts 가 고정한다.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";

function embeddingFixture(): Float32Array {
  const vector = new Float32Array(1024);
  vector[0] = 1;
  return vector;
}

function localIsoDate(daysFromToday: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

interface Harness {
  db: Database;
  store: SqliteMemoryStore;
  app: ReturnType<typeof buildMemoryApi>;
}

let h: Harness;

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const embedder = new Bgem3Embedder();
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const app = buildMemoryApi({ store, retriever, assembler });
  return { db, store, app };
}

describe("GET /api/date-occurrences", () => {
  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  test("무효 kind 는 400", async () => {
    const res = await h.app.request("/api/date-occurrences?kind=unknown");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("kind"),
    });
  });

  test("event 발생 항목을 upcoming 응답으로 내려준다", async () => {
    const date = localIsoDate(1);
    await h.store.addNode({
      content: "라우트 일정 테스트",
      eventAt: date,
      embedding: embeddingFixture(),
    });

    const res = await h.app.request("/api/date-occurrences?days=7&pastDays=0&kind=event&limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      upcoming: Array<{ kind: string; title: string; date: string; role: string }>;
      past: unknown[];
      window: { days: number; pastDays: number };
      generatedAt: string;
    };
    expect(body.window).toMatchObject({ days: 7, pastDays: 0 });
    expect(typeof body.generatedAt).toBe("string");
    expect(body.upcoming).toContainEqual(
      expect.objectContaining({
        kind: "event",
        role: "event",
        title: "라우트 일정 테스트",
        date,
      }),
    );
    expect(body.past).toEqual([]);
  });
});
