/**
 * place-provenance-flow.test.ts — 활용 단계2 ③ 장소 출처 진입점 통합 검증(C-1 폐기 후).
 *
 * 실제 store + Bgem3Embedder(mock 0). source 분기 검증:
 *  - direct 고유명사("속초"·"강남 A마트") → 행 게이트 통과 → places 행 1(콜론 수렴).
 *  - direct seed·일반명사("서울") → 명시 선언이라 결정 D 로 places 행 1 + 출처 direct
 *    (2026-06-27 사용자 결정·옛 C-1 "일반명사 장소 행 0" 폐기).
 *  - system/inferred → concept(장소)→concept(value) 위계만(places 행 0·거짓 엔티티 0).
 *    비-explicit 씨앗 가드는 그대로 — 추론된 일반명사가 게이트 없이 1급 카드로 승격되는 것을 차단.
 *  - direct 보호 — direct 위 system/inferred 거부({wrote:false,skipReason:"source-conflict"}).
 * 데이터 fixture 만 — 인터페이스 가짜 구현(mock 클래스) 없음(CLAUDE.md 테스트 정책).
 */

import { beforeAll, beforeEach, afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";

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

// 분류 단계4 T4 — place 엔티티는 죽은 전용 places 테이블이 아니라 범용 본체 entities
// (type_name='place')에 산다. 행 수 단정을 그 통로로 옮긴다.
function placesCount(name?: string): number {
  if (name) {
    return db
      .query("SELECT name FROM entities WHERE type_name='place' AND name=?")
      .all(name).length;
  }
  return db.query("SELECT name FROM entities WHERE type_name='place'").all().length;
}

function placeSource(id: number): string | undefined {
  const row = db
    .query("SELECT metadata_json FROM knowledge_nodes WHERE id=?")
    .get(id) as { metadata_json: string | null } | null;
  if (!row?.metadata_json) return undefined;
  return JSON.parse(row.metadata_json).fieldSources?.place;
}

function nodeConceptProvenance(nodeId: number, conceptId: string) {
  return db
    .query<{ provenance: string; source_node_id: number | null }, [number, string]>(
      `SELECT provenance, source_node_id
         FROM node_concept_edges
        WHERE node_id=? AND concept_id=? AND role='classification'`,
    )
    .get(nodeId, conceptId);
}

test("direct 고유명사 '속초' → 행 게이트 통과 → places 행 1 + 출처 direct", async () => {
  const id = await store.addNode({ content: "여행" });
  const res = await store.setPlace(id, "속초", "direct");
  expect(res.wrote).toBe(true);
  expect(placesCount("속초")).toBe(1);
  expect(placeSource(id)).toBe("direct");
});

test("direct 공백 고유명사 '강남 A마트' → places 행 1 + 출처 direct", async () => {
  const id = await store.addNode({ content: "쇼핑" });
  const res = await store.setPlace(id, "강남 A마트", "direct");
  expect(res.wrote).toBe(true);
  expect(placesCount("강남 A마트")).toBe(1);
  expect(placeSource(id)).toBe("direct");
});

test("direct seed '서울' → places 행 1 + 출처 direct (C-1 폐기·명시 선언이 씨앗 이김)", async () => {
  // (2026-06-27 사용자 결정·C-1 폐기) 직접 입력 장소는 명시 선언이라 일반명사 씨앗 '서울'도
  // 결정 D 로 1급 place 행이 된다. 옛 "게이트 거부·행 0(C-1)" 폐기.
  const id = await store.addNode({ content: "여행" });
  const res = await store.setPlace(id, "서울", "direct");
  expect(res.wrote).toBe(true);
  expect(placesCount("서울")).toBe(1);
  // 출처 direct 기록(행 + 출처 둘 다 생성).
  expect(placeSource(id)).toBe("direct");
});

test("system '속초' → concept 위계만 + places 행 0(③ 전 거동·거짓 엔티티 방지)", async () => {
  const id = await store.addNode({ content: "거기 갔다" });
  const res = await store.setPlace(id, "속초", "system");
  expect(res.wrote).toBe(true);
  // 추출은 1급 places 행으로 승격하지 않는다 — concept 위계만.
  expect(placesCount("속초")).toBe(0);
  // concept(value) 노드는 생긴다(addClassificationTag 위계).
  const concept = await store.findConceptByName("속초");
  expect(concept).not.toBeNull();
  expect(nodeConceptProvenance(id, concept!.conceptId)).toEqual({
    provenance: "llm_extract",
    source_node_id: id,
  });
  // 출처는 글에 기록(가드용).
  expect(placeSource(id)).toBe("system");
});

test("inferred '서울'(일반명사) → places 행 0(추론은 명시 선언 아님·씨앗 가드 유지·C-1 폐기 후에도 보존)", async () => {
  // C-1(직접 입력 일반명사 장소 행 0)은 폐기됐지만, *비-explicit 씨앗 가드*는 그대로다 —
  // 추론(inferred)으로 들어온 일반명사 '서울'은 명시 선언이 아니라 게이트 없이 1급 엔티티로
  // 승격하지 않는다(거짓 카드 차단·핵심 가드). direct 명시 선언만 결정 D 로 행을 만든다.
  const id = await store.addNode({ content: "거기" });
  const res = await store.setPlace(id, "서울", "inferred");
  expect(res.wrote).toBe(true);
  expect(placesCount("서울")).toBe(0); // 거짓 1급 엔티티 0
  const concept = await store.findConceptByName("서울");
  expect(concept).not.toBeNull(); // concept 위계는 생김
  expect(nodeConceptProvenance(id, concept!.conceptId)).toEqual({
    provenance: "evolver",
    source_node_id: id,
  });
  expect(placeSource(id)).toBe("inferred");
});

test("setPlace: direct 값을 system·inferred 가 못 덮는다(source-conflict·둘 다 skip)", async () => {
  const id = await store.addNode({ content: "여행" });
  expect((await store.setPlace(id, "속초", "direct")).wrote).toBe(true);
  expect(await store.setPlace(id, "부산", "system")).toEqual({
    wrote: false,
    skipReason: "source-conflict",
  });
  expect(await store.setPlace(id, "부산", "inferred")).toEqual({
    wrote: false,
    skipReason: "source-conflict",
  });
  // 출처는 여전히 direct, 거부된 '부산' 은 행도 concept 위계도 안 만듦(가드가 합류 전 차단).
  expect(placeSource(id)).toBe("direct");
  expect(placesCount("부산")).toBe(0);
  expect(await store.findConceptByName("부산")).toBeNull();
});

test("setPlace: system 값을 direct 가 덮는다 + 고유명사면 places 행 승격", async () => {
  const id = await store.addNode({ content: "여행" });
  await store.setPlace(id, "속초", "system"); // concept 위계만(places 0)
  expect(placesCount("속초")).toBe(0);
  const res = await store.setPlace(id, "강남 A마트", "direct"); // 고유명사 → 행 승격
  expect(res.wrote).toBe(true);
  expect(placeSource(id)).toBe("direct");
  expect(placesCount("강남 A마트")).toBe(1);
});

test("setPlace: 같은 direct 고유명사 두 번 → place 행 1개(멱등)", async () => {
  const id = await store.addNode({ content: "여행" });
  await store.setPlace(id, "속초", "direct");
  await store.setPlace(id, "속초", "direct");
  expect(placesCount("속초")).toBe(1);
});

test("setPlace: 없는 노드면 {wrote:false}(사유 없음·노드 부재)", async () => {
  expect(await store.setPlace(999999, "속초", "direct")).toEqual({
    wrote: false,
  });
});

test("setPlace: direct 고유명사 place 행이 개념 identity 로 잇힌다(콜론 경로와 같은 결과)", async () => {
  const id = await store.addNode({ content: "여행" });
  await store.setPlace(id, "속초", "direct");
  // 단계4 T4 — place 엔티티는 범용 본체 entities(type_name='place')에 산다.
  const placeRow = db
    .query("SELECT entity_id FROM entities WHERE type_name='place' AND name='속초'")
    .get() as { entity_id: string };
  // identity 엣지 — place 행 ↔ 잎 개념(검색 JOIN 키·콜론 #장소 경로와 같은 통로).
  const identityEdges = store.getEntityConceptEdges(
    "place",
    placeRow.entity_id,
    "identity",
  );
  expect(identityEdges.length).toBe(1);
  const identity = db
    .query<{ provenance: string; source_node_id: number | null }, [string]>(
      `SELECT provenance, source_node_id
         FROM entity_concept_edges
        WHERE entity_id=? AND role='identity'`,
    )
    .get(placeRow.entity_id);
  expect(identity).toEqual({ provenance: "user_input", source_node_id: id });
});
