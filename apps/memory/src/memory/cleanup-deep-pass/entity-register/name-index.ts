/**
 * entity-register/name-index.ts — 기존 사람·항목의 이름·별명 색인. 판정(judge.ts)이 같은 이름·비슷한
 * 이름을 찾는 입력이다. 사람은 persons(별명 JSON), 그 밖 종류는 entities + ko/en 별명 속성을 전량 읽는다
 * (목록 상한으로 잘라 내면 동명이인·비슷한 이름을 조용히 놓친다). 별명 칸이 깨졌으면 그 행 id 로 멈춘다.
 */
import type { Database } from "bun:sqlite";
import { EN_ALIASES_ATTR_KEY, KO_ALIASES_ATTR_KEY } from "../../../db/store-internal/entities-repository.ts";
import type { EntityNameIndex, NameIndexEntry } from "./types.ts";

function aliasList(raw: string | null, where: string): string[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`entity-register 이름 색인: ${where} 별명 칸이 JSON 이 아님`);
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`entity-register 이름 색인: ${where} 별명 칸이 문자열 배열이 아님`);
  }
  return value as string[];
}

export function addToNameIndex(index: EntityNameIndex, entry: NameIndexEntry): void {
  const list = index.byType.get(entry.typeName) ?? [];
  list.push(entry);
  index.byType.set(entry.typeName, list);
}

export function addAliasToNameIndex(index: EntityNameIndex, typeName: string, id: string, alias: string): void {
  const entry = index.byType.get(typeName)?.find((e) => e.id === id);
  if (!entry) throw new Error(`entity-register 이름 색인: ${typeName}/${id} 가 색인에 없음`);
  if (!entry.aliases.includes(alias)) entry.aliases.push(alias);
}

export function loadEntityNameIndex(db: Database, allowedTypes: ReadonlySet<string>): EntityNameIndex {
  const index: EntityNameIndex = { byType: new Map() };
  if (allowedTypes.has("person")) {
    const people = db.query("SELECT person_id, display_name, aliases FROM persons ORDER BY rowid").all() as Array<{
      person_id: string; display_name: string; aliases: string | null;
    }>;
    for (const p of people) {
      addToNameIndex(index, { typeName: "person", id: p.person_id, name: p.display_name, aliases: aliasList(p.aliases, `persons.${p.person_id}`) });
    }
  }
  const rows = db
    .query(
      `SELECT e.entity_id, e.type_name, e.name, ko.attr_value AS ko_aliases, en.attr_value AS en_aliases
         FROM entities e
         LEFT JOIN entity_attributes ko ON ko.entity_id = e.entity_id AND ko.attr_key = ?
         LEFT JOIN entity_attributes en ON en.entity_id = e.entity_id AND en.attr_key = ?
        ORDER BY e.rowid`,
    )
    .all(KO_ALIASES_ATTR_KEY, EN_ALIASES_ATTR_KEY) as Array<{
      entity_id: string; type_name: string; name: string; ko_aliases: string | null; en_aliases: string | null;
    }>;
  for (const r of rows) {
    // 사람은 persons 가 단일 출처(createEntityRow("person") → persons). entities 의 person 행은 보지 않는다.
    if (r.type_name === "person" || !allowedTypes.has(r.type_name)) continue;
    const where = `entities.${r.entity_id}`;
    addToNameIndex(index, {
      typeName: r.type_name, id: r.entity_id, name: r.name,
      aliases: [...aliasList(r.ko_aliases, where), ...aliasList(r.en_aliases, where)],
    });
  }
  return index;
}
