import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { wireHashtagEntities } from "./hashtag-entity-wiring.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
let db: Database;
let store: SqliteMemoryStore;
const NOW = new Date(2026, 5, 22, 10, 0, 0);
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  db.close();
});

test("#일정시작·#일정종료 → event_at·event_until 에 direct 출처로 쓴다", async () => {
  const id = await store.addNode({ content: "여행 다녀왔다" });
  await wireHashtagEntities(store, id, "여행 #일정시작:6월 1일, #일정종료:6월 5일,", { now: NOW });
  const row = db
    .query("SELECT event_at, event_until, metadata_json FROM knowledge_nodes WHERE id = ?")
    .get(id) as { event_at: string | null; event_until: string | null; metadata_json: string };
  expect(row.event_at).toBe("2026-06-01");
  expect(row.event_until).toBe("2026-06-05");
  const fs = JSON.parse(row.metadata_json).fieldSources;
  expect(fs.event_at).toBe("direct");
  expect(fs.event_until).toBe("direct");
});

test("#날짜:A ~ B → event_at(시작)·event_until(끝) 둘 다(splitDateRange 합류·결정 5)", async () => {
  const id = await store.addNode({ content: "여행" });
  await wireHashtagEntities(store, id, "여행 #날짜:6월 1일 ~ 6월 5일,", { now: NOW });
  const row = db
    .query("SELECT event_at, event_until FROM knowledge_nodes WHERE id = ?")
    .get(id) as { event_at: string | null; event_until: string | null };
  expect(row.event_at).toBe("2026-06-01");
  expect(row.event_until).toBe("2026-06-05");
});

test("#날짜:A ~ B + 명시 #일정종료:C → 명시 종료가 ~ 끝보다 우선(덮어쓰기 0)", async () => {
  // 같은 글에 명시 #일정종료 가 있으면 그 값이 `~` 의 끝 날짜를 이긴다(hasExplicitUntil 가드).
  const id = await store.addNode({ content: "여행" });
  await wireHashtagEntities(
    store,
    id,
    "여행 #날짜:6월 1일 ~ 6월 5일, #일정종료:6월 9일,",
    { now: NOW },
  );
  const row = db
    .query("SELECT event_at, event_until FROM knowledge_nodes WHERE id = ?")
    .get(id) as { event_at: string | null; event_until: string | null };
  expect(row.event_at).toBe("2026-06-01");
  // 명시 #일정종료(6월 9일)가 ~ 의 끝(6월 5일)을 이긴다.
  expect(row.event_until).toBe("2026-06-09");
});

test("#날짜 시각 포함 → event_at 에 T<HH>:<MM>", async () => {
  const id = await store.addNode({ content: "약속" });
  await wireHashtagEntities(store, id, "약속 #날짜:6월 25일 오후 2시,", { now: NOW });
  const row = db.query("SELECT event_at FROM knowledge_nodes WHERE id = ?").get(id) as {
    event_at: string | null;
  };
  expect(row.event_at).toBe("2026-06-25T14:00");
});

test("동의어 충돌(#날짜+#일정시작 다른 값) → event_at 미반영 + 충돌 경고", async () => {
  const id = await store.addNode({ content: "메모" });
  const res = await wireHashtagEntities(store, id, "#날짜:6월 1일, #일정시작:6월 3일,", { now: NOW });
  const row = db.query("SELECT event_at FROM knowledge_nodes WHERE id = ?").get(id) as {
    event_at: string | null;
  };
  expect(row.event_at).toBeNull();
  expect(res.warnings.some((w) => w.includes("충돌"))).toBe(true);
});

test("direct 값을 의미추출(inferred)이 못 덮는다", async () => {
  const id = await store.addNode({ content: "약속" });
  await wireHashtagEntities(store, id, "#날짜:6월 25일,", { now: NOW });
  expect(await store.setEventAt(id, "2026-01-01", "inferred")).toBe(false);
  const row = db.query("SELECT event_at FROM knowledge_nodes WHERE id = ?").get(id) as {
    event_at: string | null;
  };
  expect(row.event_at).toBe("2026-06-25");
});

test("값이 일시로 안 풀리면(extractEventDateTime null) 그 칸 건너뛰고 경고 — 거짓 일시 0", async () => {
  const id = await store.addNode({ content: "메모" });
  const res = await wireHashtagEntities(store, id, "#날짜:그냥 메모,", { now: NOW });
  const row = db.query("SELECT event_at FROM knowledge_nodes WHERE id = ?").get(id) as {
    event_at: string | null;
  };
  expect(row.event_at).toBeNull();
  expect(res.warnings.length).toBeGreaterThan(0);
});

test("직접 입력 칸 안 쓴 글은 event 칸 NULL(byte 동일)", async () => {
  const id = await store.addNode({ content: "그냥 일상" });
  await wireHashtagEntities(store, id, "그냥 일상 글입니다", { now: NOW });
  const row = db
    .query("SELECT event_at, event_until FROM knowledge_nodes WHERE id = ?")
    .get(id) as { event_at: string | null; event_until: string | null };
  expect(row.event_at).toBeNull();
  expect(row.event_until).toBeNull();
});
