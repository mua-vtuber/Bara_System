/**
 * entity-management-table.test.ts — 엔티티 관리 통합 표 순수 렌더 검증 (엔티티 관리 통합 S6).
 *
 * 검증 정신 — fetch mock 0·Mock 객체 0:
 *   renderEntityManagementTable 은 *순수 DOM 조립* 함수다. 행 배열(데이터 fixture)을 받아
 *   표 DOM 만 만들고 네트워크는 일절 안 건드린다. 삭제 콜백은 인자로 주입한 함수가 user
 *   행·user 칩에서만 호출되는지 확인한다.
 *
 * 검증 갈래:
 *   1) 0건 → 빈 안내.
 *   2) 영문키 칸 = typeName 직출력.
 *   3) code 행은 종류 삭제 버튼 없음(읽기전용).
 *   4) user 행은 종류 삭제 버튼 + 콜백(typeName) 호출.
 *   5) user 칩만 어휘 삭제 버튼 + 콜백(id) 호출, yaml 칩은 읽기전용.
 *   6) 하위분류·칸·라벨 칸에 데이터 계층이 준 결과가 순서대로 보인다.
 *   7) S7a — 수정 버튼은 모든 종류(code·user)에 붙고 onEditType(typeName)을 부른다.
 */

import "../../test-setup-dom";
import { describe, test, expect } from "bun:test";
import { renderEntityManagementTable } from "./entity-management-table";
import type {
  EntityManagementRow,
  VocabChip,
} from "./entity-management-api";

function chip(overrides: Partial<VocabChip> = {}): VocabChip {
  return { value: "소설", source: "yaml", id: null, ...overrides };
}

function row(overrides: Partial<EntityManagementRow> = {}): EntityManagementRow {
  return {
    typeName: "work",
    koName: "작품",
    source: "code",
    synonyms: [],
    subcategories: [],
    columns: [],
    labels: [],
    deletableTypeName: null,
    ...overrides,
  };
}

const noop = (): void => {};

describe("renderEntityManagementTable — 순수 렌더", () => {
  test("0건이면 빈 안내(가짜 샘플 0)", () => {
    const table = renderEntityManagementTable([], noop, noop, noop);
    const empty = table.querySelector("[data-entity-mgmt-empty]");
    expect(empty).not.toBeNull();
    expect(table.querySelectorAll("[data-entity-mgmt-row]").length).toBe(0);
  });

  test("영문키 칸 = typeName 직출력", () => {
    const table = renderEntityManagementTable(
      [row({ typeName: "equipment", koName: "장비" })],
      noop,
      noop,
      noop,
    );
    const tr = table.querySelector("[data-entity-mgmt-row]")!;
    expect(tr.querySelector(".entity-mgmt-key")!.textContent).toBe("equipment");
    expect(tr.querySelector(".entity-mgmt-ko")!.textContent).toBe("장비");
  });

  test("code 행은 '코드' 배지 + 종류 삭제 버튼 없음(읽기전용)", () => {
    const table = renderEntityManagementTable([row({ source: "code" })], noop, noop, noop);
    const tr = table.querySelector("[data-entity-mgmt-row]")!;
    expect(tr.querySelector(".entity-mgmt-source-badge")!.textContent).toBe("코드");
    expect(tr.querySelector("[data-delete-type]")).toBeNull();
  });

  test("user 행은 '추가' 배지 + 종류 삭제 버튼 + 콜백(typeName) 호출", () => {
    const captured: string[] = [];
    const table = renderEntityManagementTable(
      [row({ typeName: "vehicle", koName: "탈것", source: "user", deletableTypeName: "vehicle" })],
      (typeName) => captured.push(typeName),
      noop,
      noop,
    );
    const tr = table.querySelector('[data-entity-mgmt-row][data-source="user"]')!;
    expect(tr.querySelector(".entity-mgmt-source-badge")!.textContent).toBe("추가");
    const btn = tr.querySelector("[data-delete-type]") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(captured).toEqual(["vehicle"]);
  });

  test("user 출처 칩만 어휘 삭제 버튼 + 콜백(id) 호출, yaml 칩은 읽기전용", () => {
    const captured: string[] = [];
    const table = renderEntityManagementTable(
      [
        row({
          typeName: "work",
          synonyms: [
            chip({ value: "소설", source: "yaml", id: null }),
            chip({ value: "장편소설", source: "user", id: "u1" }),
          ],
        }),
      ],
      noop,
      (id) => captured.push(id),
      noop,
    );
    const tr = table.querySelector("[data-entity-mgmt-row]")!;
    const chips = Array.from(tr.querySelectorAll('[data-chip]'));
    const yamlChip = chips.find((c) => c.textContent?.includes("소설") && !c.textContent?.includes("장편"))!;
    const userChip = chips.find((c) => c.textContent?.includes("장편소설"))!;
    // yaml 칩엔 삭제 버튼 없음.
    expect(yamlChip.querySelector("[data-chip-delete]")).toBeNull();
    // user 칩엔 삭제 버튼 + 콜백(그 id) 호출.
    const delBtn = userChip.querySelector("[data-chip-delete]") as HTMLButtonElement;
    expect(delBtn).not.toBeNull();
    delBtn.click();
    expect(captured).toEqual(["u1"]);
  });

  test("하위분류·칸·라벨 칸에 칩이 그려진다", () => {
    const table = renderEntityManagementTable(
      [
        row({
          subcategories: [chip({ value: "장편" })],
          columns: [{ key: "발매일", dataType: "text", id: null }],
          labels: [chip({ value: "연재중" })],
        }),
      ],
      noop,
      noop,
      noop,
    );
    const tr = table.querySelector("[data-entity-mgmt-row]")!;
    const text = tr.textContent ?? "";
    expect(text).toContain("장편");
    expect(text).toContain("발매일");
    expect(text).toContain("글자");
    expect(text).toContain("연재중");
  });

  test("표 헤더 6칸(분류 이름·영문키·하위분류·칸·라벨·수정)", () => {
    const table = renderEntityManagementTable([row()], noop, noop, noop);
    const headers = Array.from(table.querySelectorAll("thead th")).map(
      (th) => th.textContent ?? "",
    );
    expect(headers).toEqual(["분류 이름", "영문키", "하위분류", "칸", "라벨", "수정"]);
  });

  test("칸 셀은 숫자형/글자형/날짜형 배지를 보이고 삭제 버튼은 붙이지 않는다", () => {
    const table = renderEntityManagementTable(
      [
        row({
          columns: [
            { key: "금액", dataType: "number", id: "col1" },
            { key: "메모", dataType: "text", id: "col2" },
            { key: "구입일", dataType: "date", id: "col3" },
            {
              key: "별칭",
              dataType: "text",
              semantic: "alias",
              helpText: "이름 대신 사용 할 수 있음",
              id: null,
            },
          ],
        }),
      ],
      noop,
      noop,
      noop,
    );
    const cell = table.querySelector("[data-column-cell]")!;
    expect(cell.textContent).toContain("금액");
    expect(cell.textContent).toContain("숫자");
    expect(cell.textContent).toContain("메모");
    expect(cell.textContent).toContain("글자");
    expect(cell.textContent).toContain("구입일");
    expect(cell.textContent).toContain("날짜");
    const aliasChip = cell.querySelector('[data-semantic="alias"]') as HTMLElement;
    expect(aliasChip).not.toBeNull();
    expect(aliasChip.textContent).toContain("별칭");
    expect(aliasChip.title).toBe("이름 대신 사용 할 수 있음");
    expect(cell.querySelector("[data-column-delete]")).toBeNull();
  });

  test("S7a — 수정 버튼은 code 종류에도 붙고 onEditType(typeName)을 부른다", () => {
    const captured: string[] = [];
    const table = renderEntityManagementTable(
      [row({ typeName: "work", source: "code" })],
      noop,
      noop,
      (typeName) => captured.push(typeName),
    );
    const tr = table.querySelector("[data-entity-mgmt-row]")!;
    const editBtn = tr.querySelector("[data-edit-type]") as HTMLButtonElement;
    expect(editBtn).not.toBeNull();
    editBtn.click();
    expect(captured).toEqual(["work"]);
  });

  test("S7a — 수정 버튼은 user 종류에도 붙고 onEditType(typeName)을 부른다", () => {
    const captured: string[] = [];
    const table = renderEntityManagementTable(
      [row({ typeName: "vehicle", source: "user", deletableTypeName: "vehicle" })],
      noop,
      noop,
      (typeName) => captured.push(typeName),
    );
    const tr = table.querySelector('[data-entity-mgmt-row][data-source="user"]')!;
    const editBtn = tr.querySelector("[data-edit-type]") as HTMLButtonElement;
    expect(editBtn).not.toBeNull();
    editBtn.click();
    expect(captured).toEqual(["vehicle"]);
    // user 행은 수정 + 삭제 둘 다 붙는다.
    expect(tr.querySelector("[data-delete-type]")).not.toBeNull();
  });
});
