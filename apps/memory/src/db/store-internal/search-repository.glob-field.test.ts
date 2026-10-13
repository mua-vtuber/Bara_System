/**
 * search-repository.glob-field.test.ts — getNodeIdsByMetadataField 글-칸 매칭 검증.
 *
 * 활용 단계6 T4(검색 종류·칸 거름망 캡슐): T3b 가 metadata_json.fields.<키>=<값> 으로
 * 저장한 글-칸을 검색 캡슐의 fieldFilters 가 매칭한다. getNodeIdsByMetadataField 는
 * getNodeIdsByConceptName 의 *글-칸* 짝 — concept name 이 아니라 metadata_json.fields
 * 안의 (키 → 값) 정확 일치로 글 node_id Set 을 회수한다(RRF 합산 전 후보 *축소*).
 *
 * 실 SqliteMemoryStore(:memory:) + 실 Bgem3Embedder. mock 없음. setGlobField(T3b)로
 * 칸을 채운 글을 만들어 매칭한다(fixture 데이터 입력 → 출력 검증).
 */

import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { SqliteMemoryStore } from "../store.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let store: SqliteMemoryStore;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  db.close();
});

test("getNodeIdsByMetadataField — fields.항목 매칭 글만", async () => {
  const milk = await store.addNode({ content: "우유 메모" });
  const bread = await store.addNode({ content: "빵 메모" });
  await store.setGlobField(milk, "항목", "우유", "direct");
  await store.setGlobField(bread, "항목", "빵", "direct");

  const ids = store.getNodeIdsByMetadataField("항목", "우유");
  expect(ids.has(milk)).toBe(true);
  expect(ids.has(bread)).toBe(false);
  expect(ids.size).toBe(1);
});

test("getNodeIdsByMetadataField — 매칭 0건이면 빈 Set(정직)", async () => {
  const milk = await store.addNode({ content: "우유 메모" });
  await store.setGlobField(milk, "항목", "우유", "direct");
  expect(store.getNodeIdsByMetadataField("항목", "없는값").size).toBe(0);
  expect(store.getNodeIdsByMetadataField("없는칸", "우유").size).toBe(0);
});

test("getNodeIdsByMetadataField — 빈 키·빈 값이면 빈 Set(쿼리 진입 안 함)", async () => {
  const milk = await store.addNode({ content: "우유 메모" });
  await store.setGlobField(milk, "항목", "우유", "direct");
  expect(store.getNodeIdsByMetadataField("", "우유").size).toBe(0);
  expect(store.getNodeIdsByMetadataField("항목", "  ").size).toBe(0);
});

test("getNodeIdsByMetadataField — 같은 키 여러 값이면 그 값만 잡는다", async () => {
  const milk = await store.addNode({ content: "우유 메모" });
  const milk2 = await store.addNode({ content: "우유 또 메모" });
  const water = await store.addNode({ content: "물 메모" });
  await store.setGlobField(milk, "항목", "우유", "direct");
  await store.setGlobField(milk2, "항목", "우유", "direct");
  await store.setGlobField(water, "항목", "물", "direct");

  const ids = store.getNodeIdsByMetadataField("항목", "우유");
  expect(ids.has(milk)).toBe(true);
  expect(ids.has(milk2)).toBe(true);
  expect(ids.has(water)).toBe(false);
  expect(ids.size).toBe(2);
});

test("getNodeIdsByMetadataField — 값 trim 후 정확 일치(공백 흔들림 흡수)", async () => {
  const milk = await store.addNode({ content: "우유 메모" });
  await store.setGlobField(milk, "항목", "우유", "direct");
  // 입력 키·값에 양끝 공백이 와도 trim 후 일치한다(저장값은 setGlobField 가 trim).
  expect(store.getNodeIdsByMetadataField("  항목 ", " 우유 ").has(milk)).toBe(true);
});
