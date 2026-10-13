/**
 * column-type-map.test.ts — buildColumnTypeMap datatype 맵 빌드 검증 (단계6b T1).
 *
 * column_types 행을 Map<타입, Map<칸키, "number" | "date">> 로 빌드한다. 다른 slot 무시·빈
 * 입력 빈 맵·무효 value(tab 없음·datatype 이 number/date 아님) 명시 에러. 순수 함수·fixture.
 */
import { test, expect } from "bun:test";
import { buildColumnTypeMap } from "./merge-classify-vocab.ts";

test("column_types 행만 Map<칸키, datatype> 로 빌드(다른 slot 무시)", () => {
  const map = buildColumnTypeMap([
    { typeName: "장비", slot: "column_types", value: "무게\tnumber" },
    { typeName: "장비", slot: "column_types", value: "구입일\tdate" },
    { typeName: "장비", slot: "columns", value: "무게" },
    { typeName: "장비", slot: "synonyms", value: "기구" },
  ]);
  expect(map.get("장비")?.get("무게")).toBe("number");
  expect(map.get("장비")?.get("구입일")).toBe("date");
  // columns·synonyms 행은 datatype 맵에 안 들어간다.
});

test("빈 입력이면 빈 맵(no-op)", () => {
  expect(buildColumnTypeMap([]).size).toBe(0);
});

test("tab 없거나 datatype 토큰이 number/date 아니면 명시 에러(silent skip 금지)", () => {
  expect(() =>
    buildColumnTypeMap([{ typeName: "장비", slot: "column_types", value: "무게없음" }]),
  ).toThrow();
  expect(() =>
    buildColumnTypeMap([{ typeName: "장비", slot: "column_types", value: "무게\ttext" }]),
  ).toThrow();
});

test("여러 타입의 같은 칸 키는 각 타입 맵에 독립 저장(타입별 분리)", () => {
  const map = buildColumnTypeMap([
    { typeName: "가계부", slot: "column_types", value: "금액\tnumber" },
    { typeName: "장비", slot: "column_types", value: "금액\tnumber" },
  ]);
  // 같은 '금액' 칸 키라도 타입마다 별 Map 에 들어간다(타입 경계로 분리).
  expect(map.get("가계부")?.get("금액")).toBe("number");
  expect(map.get("장비")?.get("금액")).toBe("number");
  expect(map.size).toBe(2);
  // 한 타입 맵이 다른 타입 칸을 보지 않는다(독립).
  expect(map.get("가계부")?.size).toBe(1);
});

test("같은 (타입,칸키) 가 두 번 와도 결정적(멱등 덮어쓰기)", () => {
  const map = buildColumnTypeMap([
    { typeName: "장비", slot: "column_types", value: "무게\tnumber" },
    { typeName: "장비", slot: "column_types", value: "무게\tnumber" },
  ]);
  // perType.set 이 같은 키를 마지막 값으로 덮어써 항상 'number' — 한 칸만 남는다(중복 무해).
  expect(map.get("장비")?.get("무게")).toBe("number");
  expect(map.get("장비")?.size).toBe(1);
});

test("column_types 외 slot(synonyms·item_synonym·columns) 섞여 와도 무시되고 column_types 만 빌드", () => {
  const map = buildColumnTypeMap([
    { typeName: "가계부", slot: "synonyms", value: "지출" },
    { typeName: "가계부", slot: "column_types", value: "금액\tnumber" },
    { typeName: "장비", slot: "item_synonym", value: "키보드\t기계식" },
    { typeName: "장비", slot: "columns", value: "무게" },
    { typeName: "장비", slot: "column_types", value: "무게\tnumber" },
  ]);
  // column_types 행만 두 타입 맵에 빌드된다 — synonyms·item_synonym·columns 행은 안 들어간다.
  expect(map.size).toBe(2);
  expect(map.get("가계부")?.get("금액")).toBe("number");
  expect(map.get("장비")?.get("무게")).toBe("number");
  // 비-column_types slot 값(지출·키보드·무게 라벨)은 datatype 맵에 흔적이 없다.
  expect(map.get("가계부")?.size).toBe(1);
  expect(map.get("장비")?.size).toBe(1);
});
