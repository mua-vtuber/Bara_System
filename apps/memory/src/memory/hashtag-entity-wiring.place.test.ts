/**
 * hashtag-entity-wiring.place.test.ts — 활용 단계2 ③ 장소 직접 입력 wiring 통합 검증
 * (C-1 수정 후).
 *
 * wireHashtagEntities 가 parseHashtagEntities 의 placeFields 를 setPlace(…, "direct")
 * 로 처리해 장소를 places 행으로 승격하는지 검증한다. (2026-06-27 사용자 결정·C-1 폐기)
 * 직접 입력 장소는 명시 선언이라 고유명사("강남 A마트"·"속초")뿐 아니라 일반명사 씨앗
 * ("서울")도 결정 D 로 1급 place 행이 된다. 출처 direct 를 기록하는지, 여러 장소를 다
 * 처리하는지, 직접 입력(direct)을 추론(inferred)이 못 덮는지, 직접 입력 안 쓴 글은 추가
 * 쓰기 0(byte 동일)인지, place 가 now 와 무관한지(일정과 다름)를 검증한다. 실제 store +
 * Bgem3Embedder(mock 0·places 행 실제 생성 검증).
 */

import { beforeAll, beforeEach, afterEach, expect, test } from "bun:test";
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
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  db.close();
});

test("#장소 직접 입력 → place 엔티티 + 출처 direct", async () => {
  const id = await store.addNode({ content: "여행 다녀왔다" });
  await wireHashtagEntities(store, id, "여행 #장소:강남 A마트,", {});
  expect(
    db.query("SELECT name FROM entities WHERE type_name='place' AND name='강남 A마트'").all().length,
  ).toBe(1);
  const row = db
    .query("SELECT metadata_json FROM knowledge_nodes WHERE id=?")
    .get(id) as { metadata_json: string };
  expect(JSON.parse(row.metadata_json).fieldSources.place).toBe("direct");
});

test("여러 고유명사 #장소 → 다 처리(places 행 2개)", async () => {
  const id = await store.addNode({ content: "여행" });
  await wireHashtagEntities(store, id, "#장소:속초, #장소:부산,", {});
  expect(db.query("SELECT name FROM entities WHERE type_name='place'").all().length).toBe(2);
});

test("seed·일반명사 #장소:서울 직접 입력 → places 행 1 + 출처 direct (C-1 폐기·결정 D 적용)", async () => {
  // (2026-06-27 사용자 결정·C-1 폐기) 직접 입력 장소도 명시 선언이라 일반명사 씨앗('서울')도
  // 결정 D 로 1급 place 행이 된다. 옛 "일반명사 장소는 거짓 엔티티로 안 승격(C-1)" 폐기.
  const id = await store.addNode({ content: "여행" });
  await wireHashtagEntities(store, id, "#장소:서울,", {});
  expect(
    db.query("SELECT name FROM entities WHERE type_name='place' AND name='서울'").all().length,
  ).toBe(1);
  const row = db
    .query("SELECT metadata_json FROM knowledge_nodes WHERE id=?")
    .get(id) as { metadata_json: string };
  expect(JSON.parse(row.metadata_json).fieldSources.place).toBe("direct");
});

test("직접 입력 place(direct)를 inferred 가 못 덮는다", async () => {
  const id = await store.addNode({ content: "여행" });
  await wireHashtagEntities(store, id, "#장소:속초,", {});
  expect(await store.setPlace(id, "부산", "inferred")).toEqual({
    wrote: false,
    skipReason: "source-conflict",
  });
  const row = db
    .query("SELECT metadata_json FROM knowledge_nodes WHERE id=?")
    .get(id) as { metadata_json: string };
  expect(JSON.parse(row.metadata_json).fieldSources.place).toBe("direct");
});

test("#장소 안 쓴 글은 place 행 0 + place 출처 0(byte 동일)", async () => {
  const id = await store.addNode({ content: "그냥 일상 글" });
  await wireHashtagEntities(store, id, "그냥 일상 글입니다", {});
  expect(db.query("SELECT name FROM entities WHERE type_name='place'").all().length).toBe(0);
  const row = db
    .query("SELECT metadata_json FROM knowledge_nodes WHERE id=?")
    .get(id) as { metadata_json: string | null };
  const fs = row.metadata_json
    ? JSON.parse(row.metadata_json).fieldSources
    : undefined;
  expect(fs?.place).toBeUndefined();
});

test("now 없이도 place 처리(일정과 다름·place 는 시각 해석 안 함)", async () => {
  const id = await store.addNode({ content: "여행" });
  await wireHashtagEntities(store, id, "#장소:속초,", {}); // now 미주입
  expect(db.query("SELECT name FROM entities WHERE type_name='place' AND name='속초'").all().length).toBe(
    1,
  );
});

test("회귀 0 — #장소:속초(공백 없음) 직접 입력 + 엔티티 배치 = place 행 1개로 수렴", async () => {
  const { wireEntityPlacement } = await import("./entity-placement-wiring.ts");
  const id = await store.addNode({ content: "여행 #장소:속초" });
  await wireHashtagEntities(store, id, "여행 #장소:속초", {}); // 직접 입력(direct·출처 기록)
  await wireEntityPlacement(store, id, "여행 #장소:속초"); // 엔티티 배치(기존·place 행)
  expect(db.query("SELECT name FROM entities WHERE type_name='place' AND name='속초'").all().length).toBe(
    1,
  ); // 중복 0
  const row = db
    .query("SELECT metadata_json FROM knowledge_nodes WHERE id=?")
    .get(id) as { metadata_json: string };
  expect(JSON.parse(row.metadata_json).fieldSources.place).toBe("direct");
});

// ── 라이브 유령 차단 — 공백 장소명 + 두 wiring 다 호출(실제 입력 재현) ─────────────
// 라이브 결함: `#장소:강남 A마트,` 직접 입력 글이 (a) 직접 입력 파서(쉼표 경계·setPlace)
// 로 "강남 A마트" place 행, (b) 콜론 정규식이 공백 전까지 잘라 `#장소:강남` 으로 매칭 →
// wireEntityPlacement 의 place 타입 배치가 "강남" 유령 place 행, 둘을 만들었다. 이전 probe
// 가 wireHashtagEntities 만 호출해 놓쳤다 — 유령은 wireEntityPlacement 에서 나오므로 실제
// 입력 경로(두 Safe 래퍼)와 같은 순서로 둘 다 호출해야 잡힌다.

test("라이브 유령 차단 — #장소:강남 A마트 두 wiring 다 호출 → '강남 A마트' 1개·'강남' 0개", async () => {
  const { wireEntityPlacement } = await import("./entity-placement-wiring.ts");
  const content = "#일정 장 봤다 #장소:강남 A마트,";
  const id = await store.addNode({ content });
  // 실제 입력 순서 재현(memories.ts:155·168) — wireHashtagEntities → wireEntityPlacement.
  await wireHashtagEntities(store, id, content, {});
  await wireEntityPlacement(store, id, content);

  // 직접 입력 파서가 받은 공백 장소명만 place 행.
  expect(
    db.query("SELECT name FROM entities WHERE type_name='place' AND name='강남 A마트'").all().length,
  ).toBe(1);
  // 콜론 정규식이 잘라 만들던 '강남' 유령은 없다(place 갈래 콜론 배치 제외).
  expect(db.query("SELECT name FROM entities WHERE type_name='place' AND name='강남'").all().length).toBe(
    0,
  );
  // places 행은 정확히 1개(유령 0).
  expect(db.query("SELECT name FROM entities WHERE type_name='place'").all().length).toBe(1);
  // 출처 direct.
  const row = db
    .query("SELECT metadata_json FROM knowledge_nodes WHERE id=?")
    .get(id) as { metadata_json: string };
  expect(JSON.parse(row.metadata_json).fieldSources.place).toBe("direct");
});

test("라이브 수렴 — #장소:속초(공백 없음·줄 끝) 두 wiring 다 호출 → '속초' 1개(콜론 배치 빠져도 직접 입력이 받음)", async () => {
  const { wireEntityPlacement } = await import("./entity-placement-wiring.ts");
  const content = "여행 #장소:속초";
  const id = await store.addNode({ content });
  await wireHashtagEntities(store, id, content, {});
  await wireEntityPlacement(store, id, content);
  // 콜론 배치를 빼도 직접 입력 파서가 "속초"(고유명사)를 받아 place 행 1개(수렴·회귀 0).
  expect(db.query("SELECT name FROM entities WHERE type_name='place' AND name='속초'").all().length).toBe(
    1,
  );
  expect(db.query("SELECT name FROM entities WHERE type_name='place'").all().length).toBe(1);
});

test("회귀 0 — 다른 타입 콜론 배치 무영향(#생물:고양이 위계 + #작품 work 행 그대로)", async () => {
  const { wireEntityPlacement } = await import("./entity-placement-wiring.ts");
  // "고양이"는 creature seed 라 1급 행은 안 생기지만, 위계(생물→고양이)는 콜론 배치가 세운다.
  const content = "#생물:고양이 #작품:소설 #소설:데못죽";
  const id = await store.addNode({ content });
  await wireHashtagEntities(store, id, content, {});
  const result = await wireEntityPlacement(store, id, content);
  // place 갈래 제외가 다른 타입(creature·work) 배치에 영향 0 — 위계 엣지가 세워진다.
  expect(result.hierarchyEdges).toBeGreaterThan(0);
  // work 행("데못죽")은 콜론 타입 배치 그대로 생긴다(고유명사·게이트 통과).
  expect(db.query("SELECT name FROM entities WHERE type_name='work' AND name='데못죽'").all().length).toBe(
    1,
  );
  // place 행은 0(이 글에 #장소 없음).
  expect(db.query("SELECT name FROM entities WHERE type_name='place'").all().length).toBe(0);
});
