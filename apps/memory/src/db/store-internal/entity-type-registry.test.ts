import { test, expect } from "bun:test";
import {
  ENTITY_TYPE_METAS,
  getEntityTypeMeta,
  isEntityTypeName,
  columnLabelKeysOf,
  type EntityTypeName,
} from "./entity-type-registry.ts";

test("8 타입 메타가 모두 등록돼 있다", () => {
  const names = ENTITY_TYPE_METAS.map((m) => m.typeName as string).sort();
  expect(names).toEqual(
    ["creature", "intake", "material", "place", "schedule", "thing", "usable", "work"].sort(),
  );
});

// 옛 schema-equivalence.test.ts 에서 옮김(설계 2026-10-02 마이그레이션 압축 7절).
test("registry 길이 8 동결 스냅샷 — 4 테이블 필드는 더는 liveness 가 아니다", () => {
  // 8 타입 union·메타는 동결 스냅샷으로 남는다(필드 삭제 = 동결 깨짐). 이 길이 단언이
  // 깨지면 누군가 정적 8 타입을 더하거나 뺀 것이라 단계4 경계를 다시 봐야 한다.
  expect(ENTITY_TYPE_METAS.length).toBe(8);
});

// 옛 entity-concept-edges-migration.test.ts 에서 옮김(설계 2026-10-02 마이그레이션 압축 7절).
test("8 conceptEdgeTable 이름은 <stem>_concept_edges 양식(동결 스냅샷)", () => {
  // registry 의 conceptEdgeTable 4 필드는 단계4 T9' 후 동결 스냅샷 값이다(테이블은
  // 죽었으나 이름 양식 권위는 보존).
  const edgeTables = ENTITY_TYPE_METAS.map((m) => m.conceptEdgeTable);
  expect([...edgeTables].sort()).toEqual(
    [
      "creature_concept_edges",
      "thing_concept_edges",
      "intake_concept_edges",
      "usable_concept_edges",
      "work_concept_edges",
      "material_concept_edges",
      "place_concept_edges",
      "schedule_concept_edges",
    ].sort(),
  );
});

test("메타 확정값 — work", () => {
  const m = getEntityTypeMeta("work");
  expect(m.koName).toBe("작품");
  expect(m.idPrefix).toBe("wrk_");
  expect(m.table).toBe("works");
  expect(m.ftsTable).toBe("works_fts");
  expect(m.vecTable).toBe("work_vec");
  expect(m.vecRowidColumn).toBe("work_rowid");
  expect(m.idColumn).toBe("work_id");
  expect(m.ownColumns).toEqual([]);
});

test("고유 칸 — intake/usable/material/place", () => {
  expect(getEntityTypeMeta("intake").ownColumns.map((c) => c.name)).toEqual(["expires_at"]);
  expect(getEntityTypeMeta("usable").ownColumns.map((c) => c.name)).toEqual(["usage_instructions"]);
  expect(getEntityTypeMeta("material").ownColumns.map((c) => c.name)).toEqual(["topic"]);
  expect(getEntityTypeMeta("place").ownColumns.map((c) => c.name)).toEqual(["address"]);
});

// 일정(schedule)은 전용 날짜 칸을 뺀 0칸 종류다 — 날짜는 글 event_at 으로 모은다
// (spec 2026-06-28-schedule-date-column-removal §2.3·R1). 옛날엔 ownColumns=['event_at']
// 였으나 그 칸이 글 event_at 과 연동 안 돼 시간 검색에 안 잡히는 함정이라 제거했다.
test("일정(schedule)은 0칸 종류 — 전용 날짜 칸 제거(글 event_at 일원화)", () => {
  expect(getEntityTypeMeta("schedule").ownColumns).toEqual([]);
  expect(getEntityTypeMeta("schedule").columnLabels).toEqual({});
  expect(columnLabelKeysOf("schedule")).toEqual([]);
});

test("getEntityTypeMeta 는 미등록 타입에 구체 에러를 throw 한다", () => {
  expect(() => getEntityTypeMeta("nope" as EntityTypeName)).toThrow(/unknown entity type/);
});

test("isEntityTypeName — 코드 8 타입만 true, person·project·미등록은 false", () => {
  // 8 타입은 전부 멤버.
  for (const m of ENTITY_TYPE_METAS) {
    expect(isEntityTypeName(m.typeName)).toBe(true);
  }
  // 1급(person·project)·새 종류·미등록 koName 은 멤버 밖.
  expect(isEntityTypeName("person")).toBe(false);
  expect(isEntityTypeName("project")).toBe(false);
  expect(isEntityTypeName("가계부")).toBe(false);
  expect(isEntityTypeName("nope")).toBe(false);
  expect(isEntityTypeName("")).toBe(false);
});

test("columnLabelKeysOf — 칸 있는 타입은 키 목록, 칸 없는 타입·미등록은 빈 배열", () => {
  // 칸 보유 4 타입 — columnLabels 키(한국어 칸 키).
  expect(columnLabelKeysOf("intake")).toEqual(["유통기한"]);
  expect(columnLabelKeysOf("usable")).toEqual(["사용법"]);
  expect(columnLabelKeysOf("material")).toEqual(["주제"]);
  expect(columnLabelKeysOf("place")).toEqual(["주소"]);
  // 칸 없는 코드 타입 — 빈 매핑이라 빈 배열(throw 아님). 일정(schedule)도 전용 날짜 칸을
  // 빼 0칸 종류가 됐다(spec 2026-06-28 — 날짜는 글 event_at 으로 모음).
  expect(columnLabelKeysOf("schedule")).toEqual([]);
  expect(columnLabelKeysOf("work")).toEqual([]);
  expect(columnLabelKeysOf("creature")).toEqual([]);
  expect(columnLabelKeysOf("thing")).toEqual([]);
  // person·project·미등록 — Set 밖이라 빈 배열(graceful, throw 차단).
  expect(columnLabelKeysOf("person")).toEqual([]);
  expect(columnLabelKeysOf("project")).toEqual([]);
  expect(columnLabelKeysOf("가계부")).toEqual([]);
  expect(columnLabelKeysOf("")).toEqual([]);
});
