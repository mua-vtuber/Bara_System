/**
 * relation-name-user-repo.test.ts — relation_name_user_entries 별 테이블 CRUD 동행 테스트
 * (분류 단계3 T7a). 실제 :memory: DB(v26 relation_name_user_entries 테이블 신설 포함).
 *
 * Mock 0 — 실제 sqlite + 실제 마이그레이션 경로. 임베딩 무관(관계명 CRUD 만 본다).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { EMBEDDING_DIMENSIONS } from "../../embedding/factory.ts";
import {
  RelationNameUserRepo,
  serializeTypeList,
  deserializeTypeList,
} from "./relation-name-user-repo.ts";

let db: Database;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
});
afterEach(() => {
  db.close();
});

test("addEntry — 새 관계명 한 행 추가 후 listEntries 에 나온다(타입 목록 역직렬화)", () => {
  const repo = new RelationNameUserRepo(db);
  repo.addEntry({
    relationKey: "구독처",
    relationName: "subscribed_to",
    sourceTypes: ["usable"],
    targetTypes: ["person", "project"],
    defaultTargetType: "person",
  });
  const rows = repo.listEntries();
  expect(rows.length).toBe(1);
  const first = rows[0]!;
  expect(first.relationKey).toBe("구독처");
  expect(first.relationName).toBe("subscribed_to");
  expect(first.sourceTypes).toEqual(["usable"]);
  expect(first.targetTypes).toEqual(["person", "project"]);
  expect(first.defaultTargetType).toBe("person");
  expect(first.entryId.startsWith("rel_user_")).toBe(true);
});

test("addEntry — 같은 값 재등록은 멱등(같은 entry_id·행 1개)", () => {
  const repo = new RelationNameUserRepo(db);
  const input = {
    relationKey: "구독처",
    relationName: "subscribed_to",
    sourceTypes: ["usable"],
    targetTypes: ["person"],
    defaultTargetType: "person",
  };
  const id1 = repo.addEntry(input);
  const id2 = repo.addEntry(input);
  expect(id1).toBe(id2);
  expect(repo.listEntries().length).toBe(1);
});

test("addEntry — 같은 키 다른 값 재등록은 덮어쓰기 금지 throw(식별자 담음)", () => {
  const repo = new RelationNameUserRepo(db);
  repo.addEntry({
    relationKey: "구독처",
    relationName: "subscribed_to",
    sourceTypes: ["usable"],
    targetTypes: ["person"],
    defaultTargetType: "person",
  });
  expect(() =>
    repo.addEntry({
      relationKey: "구독처",
      relationName: "follows",
      sourceTypes: ["usable"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    }),
  ).toThrow(/구독처/);
});

test("addEntry — 빈 relationKey·relationName 은 throw(silent skip 0)", () => {
  const repo = new RelationNameUserRepo(db);
  expect(() =>
    repo.addEntry({
      relationKey: "  ",
      relationName: "x",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    }),
  ).toThrow(/relationKey/);
  expect(() =>
    repo.addEntry({
      relationKey: "키",
      relationName: "  ",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    }),
  ).toThrow(/relationName/);
});

test("deleteByKey — 관계명 삭제 후 목록에서 사라짐. 없는 키는 멱등(에러 0)", () => {
  const repo = new RelationNameUserRepo(db);
  repo.addEntry({
    relationKey: "구독처",
    relationName: "subscribed_to",
    sourceTypes: ["usable"],
    targetTypes: ["person"],
    defaultTargetType: "person",
  });
  repo.deleteByKey("구독처");
  expect(repo.listEntries().length).toBe(0);
  expect(() => repo.deleteByKey("없는키")).not.toThrow();
});

test("listEntries — 추가 순서(created_at·rowid) 보존", () => {
  const repo = new RelationNameUserRepo(db);
  repo.addEntry({ relationKey: "가", relationName: "rel_a", sourceTypes: ["work"], targetTypes: ["person"], defaultTargetType: "person" });
  repo.addEntry({ relationKey: "나", relationName: "rel_b", sourceTypes: ["work"], targetTypes: ["person"], defaultTargetType: "person" });
  const keys = repo.listEntries().map((r) => r.relationKey);
  expect(keys).toEqual(["가", "나"]);
});

test("serializeTypeList / deserializeTypeList — tab 직렬화 왕복(빈 토큰 제거)", () => {
  expect(serializeTypeList(["schedule", "usable", "intake"])).toBe("schedule\tusable\tintake");
  expect(deserializeTypeList("schedule\tusable\tintake")).toEqual(["schedule", "usable", "intake"]);
  expect(deserializeTypeList("")).toEqual([]);
  expect(deserializeTypeList("a\t\tb")).toEqual(["a", "b"]);
});

test("빈 DB(관계명 0개) = listEntries 빈 배열(씨앗 byte 동일 토대)", () => {
  const repo = new RelationNameUserRepo(db);
  expect(repo.listEntries()).toEqual([]);
});
