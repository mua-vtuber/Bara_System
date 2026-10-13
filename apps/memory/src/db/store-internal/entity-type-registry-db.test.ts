import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../migrations.ts";
import { EMBEDDING_DIMENSIONS } from "../../embedding/factory.ts";
import { ENTITY_TYPE_METAS } from "./entity-type-registry.ts";
import {
  EntityTypeRegistryDb,
  STATIC_PLACEMENT_TYPE_NAMES,
} from "./entity-type-registry-db.ts";

// 실제 :memory: DB(v25 entity_types 테이블 신설 포함). 임베딩 무관 — 종류 명부
// CRUD 만 본다. 차원은 글 모델 단일 출처(EMBEDDING_DIMENSIONS)에서 읽어 하드코딩 0.
let db: Database;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", {
    embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"],
  });
});
afterEach(() => {
  db.close();
});

test("STATIC_PLACEMENT_TYPE_NAMES = ENTITY_TYPE_METAS 8 + person + project", () => {
  const expected = [
    ...ENTITY_TYPE_METAS.map((m) => m.typeName),
    "person",
    "project",
  ].sort();
  expect([...STATIC_PLACEMENT_TYPE_NAMES].sort()).toEqual(expected);
  // 10 종(8 메타 + 사람 + 프로젝트).
  expect(STATIC_PLACEMENT_TYPE_NAMES.length).toBe(10);
});

test("addEntityType — 새 종류 한 행 추가 후 listUserEntityTypes 에 나온다", () => {
  const reg = new EntityTypeRegistryDb(db);
  reg.addEntityType({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
  const rows = reg.listUserEntityTypes();
  expect(rows.length).toBe(1);
  const first = rows[0]!;
  expect(first.typeName).toBe("vehicle");
  expect(first.koName).toBe("탈것");
  expect(first.idPrefix).toBe("veh_");
  expect(first.createdAt).toBeTruthy();
});

test("addEntityType — 코드 상수 10종과 충돌하면 throw (entities 본체 미오염)", () => {
  const reg = new EntityTypeRegistryDb(db);
  for (const taken of [...STATIC_PLACEMENT_TYPE_NAMES]) {
    expect(() =>
      reg.addEntityType({ typeName: taken, koName: "x", idPrefix: "x_" }),
    ).toThrow(/코드 상수/);
  }
  expect(reg.listUserEntityTypes().length).toBe(0);
});

test("addEntityType — 같은 값 재등록은 멱등(무해 통과·새 행 없음)", () => {
  const reg = new EntityTypeRegistryDb(db);
  reg.addEntityType({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
  reg.addEntityType({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
  expect(reg.listUserEntityTypes().length).toBe(1);
});

test("addEntityType — 같은 이름 다른 값 재등록은 silent 덮어쓰기 금지(throw)", () => {
  const reg = new EntityTypeRegistryDb(db);
  reg.addEntityType({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
  expect(() =>
    reg.addEntityType({ typeName: "vehicle", koName: "차량", idPrefix: "veh_" }),
  ).toThrow(/이미 등록/);
  // 원래 값이 보존된다(덮어쓰기 안 함).
  expect(reg.listUserEntityTypes()[0]!.koName).toBe("탈것");
});

test("addEntityType — 빈 typeName 은 명시 throw(silent skip 금지)", () => {
  const reg = new EntityTypeRegistryDb(db);
  expect(() =>
    reg.addEntityType({ typeName: "   ", koName: "x", idPrefix: "x_" }),
  ).toThrow(/typeName/);
});

test("deleteEntityType — 새 종류만 삭제, 코드 상수 삭제 시도는 throw", () => {
  const reg = new EntityTypeRegistryDb(db);
  reg.addEntityType({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
  expect(() => reg.deleteEntityType("work")).toThrow(/코드 상수/);
  reg.deleteEntityType("vehicle");
  expect(reg.listUserEntityTypes().length).toBe(0);
});

test("deleteEntityType — 없는 새 종류 삭제는 멱등(에러 아님)", () => {
  const reg = new EntityTypeRegistryDb(db);
  expect(() => reg.deleteEntityType("vehicle")).not.toThrow();
});

test("allPlacementTypeNames — 정적 10종 + DB 새 종류 합집합", () => {
  const reg = new EntityTypeRegistryDb(db);
  expect(reg.allPlacementTypeNames().sort()).toEqual(
    [...STATIC_PLACEMENT_TYPE_NAMES].sort(),
  );
  reg.addEntityType({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
  reg.addEntityType({ typeName: "tool", koName: "공구", idPrefix: "tul_" });
  const all = reg.allPlacementTypeNames();
  expect(all.length).toBe(12);
  expect(all).toContain("vehicle");
  expect(all).toContain("tool");
  expect(all).toContain("work");
  expect(all).toContain("person");
});

test("koNameOf — 코드 상수는 메타에서, 새 종류는 DB 에서(합집합)", () => {
  const reg = new EntityTypeRegistryDb(db);
  // 코드 상수 koName 은 ENTITY_TYPE_METAS 권위.
  const workKo = ENTITY_TYPE_METAS.find((m) => m.typeName === "work")!.koName;
  expect(reg.koNameOf("work")).toBe(workKo);
  // 새 종류 koName 은 DB 에서.
  reg.addEntityType({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
  expect(reg.koNameOf("vehicle")).toBe("탈것");
  // 미등록 종류는 null.
  expect(reg.koNameOf("nonexistent")).toBe(null);
});

test("isUserEntityType — 새 종류만 true, 코드 상수·미등록은 false", () => {
  const reg = new EntityTypeRegistryDb(db);
  reg.addEntityType({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
  expect(reg.isUserEntityType("vehicle")).toBe(true);
  expect(reg.isUserEntityType("work")).toBe(false);
  expect(reg.isUserEntityType("person")).toBe(false);
  expect(reg.isUserEntityType("nonexistent")).toBe(false);
});

test("idPrefixOf — 정적 10종은 메타 권위, 새 종류는 DB, 미등록은 null(단계4 T3)", () => {
  const reg = new EntityTypeRegistryDb(db);
  // 정적 8 타입 prefix 는 ENTITY_TYPE_METAS 권위 — DB 행 없이도 메타에서 잡힌다.
  for (const m of ENTITY_TYPE_METAS) {
    expect(reg.idPrefixOf(m.typeName)).toBe(m.idPrefix);
  }
  // 사람·프로젝트는 별 repository 의 접두사와 정합('psn_'·'prj_').
  expect(reg.idPrefixOf("person")).toBe("psn_");
  expect(reg.idPrefixOf("project")).toBe("prj_");
  // 새 종류는 DB 에서.
  reg.addEntityType({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
  expect(reg.idPrefixOf("vehicle")).toBe("veh_");
  // 미등록은 null.
  expect(reg.idPrefixOf("nonexistent")).toBe(null);
});
