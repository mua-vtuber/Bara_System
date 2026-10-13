import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../db/migrations.ts";
import { addAliasToNameIndex, addToNameIndex, loadEntityNameIndex } from "./name-index.ts";

let db: Database;
beforeEach(() => { db = openMemoryDatabase(":memory:", { embeddingDim: 8 }); });
afterEach(() => db.close());

test("people come from persons with their aliases, other kinds from entities with ko/en aliases", () => {
  db.run(`INSERT INTO persons (person_id, display_name, aliases, external_refs) VALUES ('psn_1', '이몽룡', '["이몽룡","몽룡"]', '{}')`);
  db.run(`INSERT INTO entities (entity_id, type_name, name) VALUES ('plc_1', 'place', '무지개의원')`);
  db.run(`INSERT INTO entity_attributes (entity_id, attr_key, attr_value, is_column) VALUES ('plc_1', 'ko_aliases', '["이룬"]', 1)`);
  db.run(`INSERT INTO entities (entity_id, type_name, name) VALUES ('prj_1', 'project', '바라')`);
  const index = loadEntityNameIndex(db, new Set(["person", "place"]));
  expect(index.byType.get("person")).toEqual([{ typeName: "person", id: "psn_1", name: "이몽룡", aliases: ["이몽룡", "몽룡"] }]);
  expect(index.byType.get("place")).toEqual([{ typeName: "place", id: "plc_1", name: "무지개의원", aliases: ["이룬"] }]);
  expect(index.byType.has("project")).toBe(false);
});

test("a broken aliases column stops with the row id instead of being treated as empty", () => {
  db.run(`INSERT INTO persons (person_id, display_name, aliases, external_refs) VALUES ('psn_x', '민수', 'not json', '{}')`);
  expect(() => loadEntityNameIndex(db, new Set(["person"]))).toThrow("psn_x");
});

test("rows created during a cycle can be added so later memos in the same batch see them", () => {
  const index = loadEntityNameIndex(db, new Set(["person"]));
  addToNameIndex(index, { typeName: "person", id: "psn_2", name: "민수", aliases: [] });
  addAliasToNameIndex(index, "person", "psn_2", "민수형");
  expect(index.byType.get("person")).toEqual([{ typeName: "person", id: "psn_2", name: "민수", aliases: ["민수형"] }]);
});
