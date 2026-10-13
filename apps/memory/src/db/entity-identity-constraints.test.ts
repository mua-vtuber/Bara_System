/**
 * entity-identity-constraints.test.ts — entities 정체성 UNIQUE 와 entity_concept_edges 제약 가드.
 *
 * 분류 단계4 의 범용 본체 entities 는 work 정체성(medium·created_by)·person 신원(external_refs)
 * 보조 칼럼과, 종류로 가른 partial UNIQUE 인덱스 둘(비-work·work)을 가진다. 범용 통합 엣지
 * entity_concept_edges 는 entities·concept_nodes 두 CASCADE FK 를 가진다. 이 파일은 그 제약이
 * 실제로 도는지 — 인덱스 존재가 아니라 실 SQLite INSERT 의 거부·허용 — 를 본다.
 *
 * 옛 stage4-v28-migration.test.ts 에서 옮겼다(칼럼·인덱스 정의·FK 정의 확인과 정체성 UNIQUE 동작).
 * v28.up() 을 직접 부르는 장수 DB 경로와 버전 상수 대조는 압축으로 사라져 옮기지 않았다.
 * 이 파일은 runMigrations 만 쓰므로 마이그레이션 압축 전후 모두 통과한다.
 *
 * Mock 0: 실제 bun:sqlite + sqlite-vec. 행은 원시 INSERT 데이터 fixture.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { runMigrations } from "./migrations.ts";

/** 한 객체(테이블·인덱스)의 저장된 CREATE 문(sqlite_master.sql)을 돌려준다. */
function objectSql(db: Database, name: string, type: string): string | null {
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
    .get(type, name) as { sql: string } | null;
  return row ? row.sql : null;
}

test("entities PRAGMA 에 medium·created_by·external_refs 보조 칼럼이 있다", () => {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  runMigrations(db);

  const cols = (db.query("PRAGMA table_info(entities)").all() as Array<{ name: string }>)
    .map((c) => c.name);
  expect(cols).toContain("medium");
  expect(cols).toContain("created_by");
  expect(cols).toContain("external_refs");
  db.close();
});

test("idx_entities_work_identity 는 work 한정 partial UNIQUE 다", () => {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  runMigrations(db);

  const sql = objectSql(db, "idx_entities_work_identity", "index");
  expect(sql).not.toBeNull();
  // partial 인덱스 조건 — work 종류에만 정체성 복합 UNIQUE 가 걸린다.
  expect(sql).toContain("type_name = 'work'");
  expect(sql!.toUpperCase()).toContain("UNIQUE");
  db.close();
});

test("entity_concept_edges 는 entities·concept_nodes 두 CASCADE FK 를 가진다", () => {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  runMigrations(db);

  const sql = objectSql(db, "entity_concept_edges", "table");
  expect(sql).not.toBeNull();
  // 엔티티 끝점 = entities 단일 FK CASCADE(C2 구조적 소멸).
  expect(sql).toContain("REFERENCES entities(entity_id) ON DELETE CASCADE");
  // concept 끝점 = concept_nodes CASCADE.
  expect(sql).toContain("REFERENCES concept_nodes(concept_id) ON DELETE CASCADE");

  // 출처 칸까지 포함한 최종 칸 구성 + PK(entity_id, concept_id, role).
  const cols = (db.query("PRAGMA table_info(entity_concept_edges)").all() as Array<{
    name: string;
    pk: number;
  }>);
  const names = cols.map((c) => c.name).sort();
  expect(names).toEqual(
    [
      "entity_id",
      "concept_id",
      "role",
      "provenance",
      "source_node_id",
      "weight",
      "created_at",
    ].sort(),
  );
  const pkOrder = cols
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  expect(pkOrder).toEqual(["entity_id", "concept_id", "role"]);
  db.close();
});

// ── 정체성 UNIQUE 동작 검증 (인덱스 존재가 아니라 실제 INSERT 거부·허용) ──────
// Critical C1: 옛 테이블 제약 UNIQUE(type_name, name) 가 work 행도 먼저 막아 partial
// 인덱스가 작동할 기회조차 없었다. 교정 = 테이블 제약 제거 + 종류로 가른 partial UNIQUE
// 2개(비-work=(type_name,name) / work=4-tuple). 아래는 그 두 partial 이 실제로 도는지
// 실 SQLite INSERT 로 검증한다(spec §4.2(A)·§10 게이트 7 동명이매체 별개 보존).

/** entities 에 한 행을 INSERT 한다. NOT NULL 칸(entity_id·type_name·name)을 채우고
 *  created_at·updated_at 은 default 에 맡긴다. 같은 행 둘째 INSERT 의 throw 여부로
 *  partial UNIQUE 동작을 가른다. */
function insertEntity(
  db: Database,
  id: string,
  typeName: string,
  name: string,
  medium: string | null = null,
  createdBy: string | null = null,
): void {
  db.query(
    `INSERT INTO entities (entity_id, type_name, name, medium, created_by)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, typeName, name, medium, createdBy);
}

test("work 동명이매체는 별개 행으로 보존된다 (소설 괴담 ≠ 웹툰 괴담)", () => {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  runMigrations(db);

  // 소설 괴담 입력 성공.
  expect(() =>
    insertEntity(db, "work_a", "work", "괴담", "소설", "백덕수"),
  ).not.toThrow();
  // 같은 이름·다른 매체 웹툰 괴담 입력 성공(동명이매체 별개 행).
  expect(() =>
    insertEntity(db, "work_b", "work", "괴담", "웹툰", "백덕수"),
  ).not.toThrow();

  const rows = db
    .query("SELECT entity_id, medium FROM entities WHERE type_name = 'work' AND name = '괴담' ORDER BY medium")
    .all() as Array<{ entity_id: string; medium: string }>;
  expect(rows.length).toBe(2);
  expect(rows.map((r) => r.medium).sort()).toEqual(["소설", "웹툰"]);
  // 두 행이 서로 다른 id 의 별개 엔티티인지(매체만 다른 동명 작품).
  const ids = new Set(rows.map((r) => r.entity_id));
  expect(ids.size).toBe(2);
  db.close();
});

test("work 같은 4-tuple 재입력은 거부된다 (정체성 중복)", () => {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  runMigrations(db);

  insertEntity(db, "work_a", "work", "괴담", "소설", "백덕수");
  // 종류·이름·매체·작가가 모두 같은 둘째 행 = 같은 작품 중복 → UNIQUE 위반.
  expect(() =>
    insertEntity(db, "work_b", "work", "괴담", "소설", "백덕수"),
  ).toThrow();
  db.close();
});

test("비-work 는 (type_name, name) 둘째 행이 거부된다 (place 강남 중복)", () => {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  runMigrations(db);

  expect(() => insertEntity(db, "place_a", "place", "강남")).not.toThrow();
  // 같은 (place, 강남) 둘째 행 → 비-work partial UNIQUE 위반.
  expect(() => insertEntity(db, "place_b", "place", "강남")).toThrow();
  db.close();
});

test("다른 종류 같은 이름은 허용된다 (place 강남 ≠ person 강남)", () => {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  runMigrations(db);

  insertEntity(db, "place_a", "place", "강남");
  // type_name 이 달라 비-work partial UNIQUE(type_name, name)에 충돌하지 않는다.
  expect(() => insertEntity(db, "person_a", "person", "강남")).not.toThrow();
  db.close();
});

test("person 동명이인은 같은 이름 둘째 행도 허용된다 (철수 ≠ 철수·신원=external_refs)", () => {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  runMigrations(db);

  // person 은 work 와 함께 (type_name, name) 유일성에서 면제 — 같은 이름 두 사람을
  // 별개 행으로 보존한다(신원은 entity_id PK + external_refs). 둘째 person 철수가
  // partial UNIQUE 에 막히지 않는다(옛 persons display_name UNIQUE 없음 동작 보존).
  expect(() => insertEntity(db, "psn_a", "person", "철수")).not.toThrow();
  expect(() => insertEntity(db, "psn_b", "person", "철수")).not.toThrow();
  const rows = db
    .query("SELECT entity_id FROM entities WHERE type_name = 'person' AND name = '철수'")
    .all() as Array<{ entity_id: string }>;
  expect(rows.length).toBe(2);
  db.close();
});

test("idx_entities_nonwork_identity 는 work·person 면제 partial UNIQUE 다", () => {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  runMigrations(db);

  const sql = objectSql(db, "idx_entities_nonwork_identity", "index");
  expect(sql).not.toBeNull();
  // work=4-tuple / person=동명이인 허용(external_refs 신원)이라 둘 다 (type_name, name)
  // 유일성에서 면제한다 — 나머지 종류만 이 partial UNIQUE 에 든다.
  expect(sql).toContain("type_name NOT IN ('work', 'person')");
  expect(sql!.toUpperCase()).toContain("UNIQUE");
  db.close();
});
