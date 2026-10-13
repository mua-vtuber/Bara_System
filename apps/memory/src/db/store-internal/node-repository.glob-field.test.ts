/**
 * node-repository.glob-field.test.ts — setGlobField 글-칸 쓰기 + 출처 우선순위 가드 검증.
 *
 * 활용 단계6 T3b: 종류별 동적 칸 값을 knowledge_nodes.metadata_json.fields 에 출처와
 * 함께 저장한다. setEventAt 선례 정합(direct>system>inferred · 더 높은 출처가 채운
 * 칸은 낮은 출처가 못 덮음 · 빈 칸은 누구든 채움 · 같은 출처는 갱신 허용).
 *
 * 칸 값은 fields.<키> 로, 출처는 fieldSources["fields.<키>"] 로 metadata_json 안에
 * 둔다(스키마 무변경 — event_at 출처가 fieldSources.event_at 에 들어가는 양식과 동일).
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

test("setGlobField — fields 맵 + fieldSources 가 함께 갱신된다", async () => {
  const id = await repo.addNode({ content: "우유 메모" });
  const wrote = await repo.setGlobField(id, "항목", "우유", "direct");
  expect(wrote).toBe(true);
  const node = await repo.getNode(id);
  expect(node?.metadata.fields).toEqual({ 항목: "우유" });
  const sources = node?.metadata.fieldSources as Record<string, string>;
  expect(sources["fields.항목"]).toBe("direct");
});

test("setGlobField — direct 로 채운 칸은 inferred 가 못 덮는다", async () => {
  const id = await repo.addNode({ content: "금액 메모" });
  await repo.setGlobField(id, "금액", "3000", "direct");
  const wrote = await repo.setGlobField(id, "금액", "9999", "inferred");
  expect(wrote).toBe(false);
  const node = await repo.getNode(id);
  expect((node?.metadata.fields as Record<string, string>).금액).toBe("3000");
});

test("setGlobField — 빈 칸엔 system 이 쓰이고, 같은 출처는 갱신 허용", async () => {
  const id = await repo.addNode({ content: "유통기한 메모" });
  expect(await repo.setGlobField(id, "유통기한", "2026-07-01", "system")).toBe(true);
  expect(await repo.setGlobField(id, "유통기한", "2026-08-01", "system")).toBe(true);
  const node = await repo.getNode(id);
  expect((node?.metadata.fields as Record<string, string>).유통기한).toBe("2026-08-01");
});

test("setGlobField — system 칸을 direct 가 덮는다", async () => {
  const id = await repo.addNode({ content: "주소 메모" });
  await repo.setGlobField(id, "주소", "옛 주소", "system");
  expect(await repo.setGlobField(id, "주소", "새 주소", "direct")).toBe(true);
  const node = await repo.getNode(id);
  expect((node?.metadata.fields as Record<string, string>).주소).toBe("새 주소");
  const sources = node?.metadata.fieldSources as Record<string, string>;
  expect(sources["fields.주소"]).toBe("direct");
});

test("setGlobField — 여러 칸이 한 노드 fields 맵에 누적된다(서로 안 지움)", async () => {
  const id = await repo.addNode({ content: "사용물 메모" });
  await repo.setGlobField(id, "사용법", "흔들어 사용", "direct");
  await repo.setGlobField(id, "주의사항", "직사광선 피하기", "direct");
  const node = await repo.getNode(id);
  expect(node?.metadata.fields).toEqual({
    사용법: "흔들어 사용",
    주의사항: "직사광선 피하기",
  });
});

test("setGlobField — 없는 노드면 false", async () => {
  expect(await repo.setGlobField(999999, "항목", "우유", "direct")).toBe(false);
});

test("setGlobField — content·임베딩 무접촉 (메타 칸만 갱신)", async () => {
  const id = await repo.addNode({ content: "원문 보존 메모" });
  const before = await repo.getNode(id);
  await repo.setGlobField(id, "항목", "우유", "direct");
  const after = await repo.getNode(id);
  expect(after?.content).toBe(before?.content);
  expect(after?.content).toBe("원문 보존 메모");
});
