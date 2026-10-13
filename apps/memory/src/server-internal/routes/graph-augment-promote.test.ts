/**
 * graph-augment-promote.test.ts — resolvePromotionRef 승격 판정(H7 분해).
 *
 * 실 sqlite(:memory:) + 실 SqliteMemoryStore 통합 — Mock 0(프로젝트 정책 "DB 의존
 * 모듈은 실제 구현체와 통합 검증"). identity 엣지를 진짜 INSERT 로 깔고, cid 가
 * 한 타입·한 행 1:1 일 때만 승격 후보가 잡히고 여러 타입·여러 행이면 null 임을 단언한다.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { resolvePromotionRef } from "./graph-augment-promote.ts";

let db: Database;
let store: SqliteMemoryStore;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  store = new SqliteMemoryStore(db, { dimension: 384 } as never);
});
afterEach(() => {
  db.close();
});

/** FK 충족용 — 실제 concept_nodes 행 삽입. */
function insertConcept(conceptId: string, name: string): void {
  db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)").run(
    conceptId,
    name,
  );
}

/** FK 충족용 — 범용 entities 행 삽입(통합 엣지 FK 토대). */
function insertEntity(entityId: string, typeName: string, name: string): void {
  db.prepare(
    `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
     VALUES (?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(entityId, typeName, name);
}

test("identity 1:1(한 타입·한 행) — 그 행으로 승격 후보를 잡는다", () => {
  insertConcept("cpt_leaf", "괴담 (소설/백덕수)");
  insertEntity("wrk_1", "work", "괴담");
  store.addEntityConceptEdge("work", "wrk_1", "cpt_leaf", "identity", "user_input", null);

  const ref = resolvePromotionRef(store, "cpt_leaf");
  expect(ref).toEqual({ type: "work", id: "wrk_1" });
});

test("identity 0 개 — null(승격 안 함·순수 분류 글 무변)", () => {
  insertConcept("cpt_plain", "소설");
  // 어떤 엔티티도 cpt_plain 을 identity 로 안 가짐.
  expect(resolvePromotionRef(store, "cpt_plain")).toBeNull();
});

test("한 타입에서 여러 행 — 모호 → null(어느 행으로 승격할지 모름)", () => {
  insertConcept("cpt_dup", "중복잎");
  insertEntity("wrk_a", "work", "작품A");
  insertEntity("wrk_b", "work", "작품B");
  store.addEntityConceptEdge("work", "wrk_a", "cpt_dup", "identity", "user_input", null);
  store.addEntityConceptEdge("work", "wrk_b", "cpt_dup", "identity", "user_input", null);

  expect(resolvePromotionRef(store, "cpt_dup")).toBeNull();
});

test("여러 타입에 걸친 identity — 모호 → null", () => {
  insertConcept("cpt_cross", "교차잎");
  insertEntity("wrk_c", "work", "작품C");
  insertEntity("cre_c", "creature", "생물C");
  store.addEntityConceptEdge("work", "wrk_c", "cpt_cross", "identity", "user_input", null);
  store.addEntityConceptEdge("creature", "cre_c", "cpt_cross", "identity", "user_input", null);

  expect(resolvePromotionRef(store, "cpt_cross")).toBeNull();
});

test("identity 외 role(has_attribute)은 승격 후보 아님 — null", () => {
  insertConcept("cpt_attr", "액션");
  insertEntity("wrk_d", "work", "작품D");
  // identity 가 아니라 has_attribute 라벨이면 승격 대상이 아니다.
  store.addEntityConceptEdge("work", "wrk_d", "cpt_attr", "has_attribute", "user_input", null);

  expect(resolvePromotionRef(store, "cpt_attr")).toBeNull();
});
