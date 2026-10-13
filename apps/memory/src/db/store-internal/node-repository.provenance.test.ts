/**
 * node-repository.provenance.test.ts — setEventAt 출처 우선순위 가드 검증.
 *
 * 활용 spec §4.2·§4.3: 직접 입력(direct) > 시스템(system) > 추론(inferred).
 * - 빈 칸은 누구든 채운다.
 * - 낮은 출처는 높은 출처가 채운 칸을 못 덮는다.
 * - 같은 출처는 갱신 허용.
 */

import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { NodeRepository } from "./node-repository.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let repo: NodeRepository;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  repo = new NodeRepository(db, embedder);
});
afterEach(() => {
  db.close();
});

test("setEventAt: 빈 칸엔 system 이 쓰인다", async () => {
  const id = await repo.addNode({ content: "약속 메모" });
  const wrote = await repo.setEventAt(id, "2026-06-20", "system");
  expect(wrote).toBe(true);
  expect((await repo.getNode(id))?.eventAt).toBe("2026-06-20");
});

test("setEventAt: direct 값을 system 이 못 덮는다", async () => {
  const id = await repo.addNode({ content: "약속 메모" });
  await repo.setEventAt(id, "2026-06-20", "direct");
  expect(await repo.setEventAt(id, "2026-01-01", "system")).toBe(false);
  expect((await repo.getNode(id))?.eventAt).toBe("2026-06-20");
});

test("setEventAt: system 값을 direct 가 덮는다", async () => {
  const id = await repo.addNode({ content: "약속 메모" });
  await repo.setEventAt(id, "2026-06-20", "system");
  expect(await repo.setEventAt(id, "2026-07-01", "direct")).toBe(true);
  expect((await repo.getNode(id))?.eventAt).toBe("2026-07-01");
});

test("setEventAt: system 값을 inferred 가 못 덮는다 (현 구멍 수정)", async () => {
  const id = await repo.addNode({ content: "약속 메모" });
  await repo.setEventAt(id, "2026-06-20", "system");
  expect(await repo.setEventAt(id, "2026-09-09", "inferred")).toBe(false);
  expect((await repo.getNode(id))?.eventAt).toBe("2026-06-20");
});

test("setEventAt: fieldSources.event_at 이 metadata_json 에 기록된다", async () => {
  const id = await repo.addNode({ content: "약속 메모" });
  await repo.setEventAt(id, "2026-06-20", "system");
  const row = db
    .query("SELECT metadata_json FROM knowledge_nodes WHERE id = ?")
    .get(id) as { metadata_json: string };
  expect(JSON.parse(row.metadata_json).fieldSources.event_at).toBe("system");
});

// 활용 단계2 ② — event_until(일정 종료 일시) 쓰기 진입점. setEventAt 와 같은 출처
// 우선순위 가드(direct>system>inferred)를 따른다. direct 로 채운 종료 일시를
// 시스템 추정·LLM 추론이 덮지 못하게 막는다(직접 입력값 보호).

test("setEventUntil: 빈 칸엔 system 이 쓰인다", async () => {
  const id = await repo.addNode({ content: "여행 메모" });
  expect(await repo.setEventUntil(id, "2026-06-05", "system")).toBe(true);
  const row = db.query("SELECT event_until FROM knowledge_nodes WHERE id = ?")
    .get(id) as { event_until: string | null };
  expect(row.event_until).toBe("2026-06-05");
});

test("setEventUntil: direct 값을 system·inferred 가 못 덮는다", async () => {
  const id = await repo.addNode({ content: "여행 메모" });
  await repo.setEventUntil(id, "2026-06-05", "direct");
  expect(await repo.setEventUntil(id, "2026-01-01", "system")).toBe(false);
  expect(await repo.setEventUntil(id, "2026-01-01", "inferred")).toBe(false);
  const row = db.query("SELECT event_until FROM knowledge_nodes WHERE id = ?")
    .get(id) as { event_until: string | null };
  expect(row.event_until).toBe("2026-06-05");
});

test("setEventUntil: system 값을 direct 가 덮는다 + fieldSources.event_until 기록", async () => {
  const id = await repo.addNode({ content: "여행 메모" });
  await repo.setEventUntil(id, "2026-06-05", "system");
  expect(await repo.setEventUntil(id, "2026-07-01", "direct")).toBe(true);
  const row = db.query("SELECT event_until, metadata_json FROM knowledge_nodes WHERE id = ?")
    .get(id) as { event_until: string | null; metadata_json: string };
  expect(row.event_until).toBe("2026-07-01");
  expect(JSON.parse(row.metadata_json).fieldSources.event_until).toBe("direct");
});

test("setEventUntil: 같은 출처는 갱신 허용", async () => {
  const id = await repo.addNode({ content: "여행 메모" });
  await repo.setEventUntil(id, "2026-06-05", "direct");
  expect(await repo.setEventUntil(id, "2026-06-09", "direct")).toBe(true);
  const row = db.query("SELECT event_until FROM knowledge_nodes WHERE id = ?")
    .get(id) as { event_until: string | null };
  expect(row.event_until).toBe("2026-06-09");
});

test("setEventUntil: 없는 노드면 false", async () => {
  expect(await repo.setEventUntil(999999, "2026-06-05", "direct")).toBe(false);
});

test("setEventUntil: content·임베딩 무접촉 (메타 칸만)", async () => {
  const id = await repo.addNode({ content: "여행 메모 원문" });
  const before = await repo.getNode(id);
  await repo.setEventUntil(id, "2026-06-05", "direct");
  const after = await repo.getNode(id);
  expect(after?.content).toBe(before?.content);
  expect(after?.content).toBe("여행 메모 원문");
});
