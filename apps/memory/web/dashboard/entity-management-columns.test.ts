/**
 * entity-management-columns.test.ts — 칸 섹션 DOM 검증 (엔티티 관리 통합 S8).
 *
 * 검증 정신 — fetch mock 0·Mock 객체 0:
 *   renderColumnSection 은 addColumn/removeColumn/onReload/latestColumns(plain 함수)를
 *   주입받는다. 칸 칩 데이터를 넘겨받아(새 fetch 0) 칩·타입 배지·추가 폼을 그린다. 콜백
 *   호출·라디오 기본값·source 가름(code 읽기전용 / user 편집)을 데이터·콜백 fixture 로 본다.
 *
 * 핵심 갈래:
 *   - 칩 키·타입 배지([숫자]/[글자]/[날짜]) 텍스트.
 *   - 추가 폼 라디오 기본 선택 = 글자형.
 *   - 추가 클릭 → addColumn(columnKey, dataType) 콜백.
 *   - ✕ 삭제 → removeColumn(id) 콜백(user 칩만).
 *   - code 종류 = 읽기전용(추가 폼·삭제 버튼 0), user 종류 = 편집.
 */

import "../../test-setup-dom";
import { describe, test, expect } from "bun:test";
import { renderColumnSection, type ColumnSectionDeps } from "./entity-management-columns";
import type { ColumnChip, AddColumnApiResult } from "./entity-management-api";

function freshHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

/** 기본 콜백 한 벌 — 칸 검증 테스트가 개별로 덮는다(plain 함수·Mock 0). */
function baseDeps(overrides: Partial<ColumnSectionDeps> = {}): ColumnSectionDeps {
  return {
    typeName: "ledger",
    source: "user",
    columns: [],
    addColumn: async (): Promise<AddColumnApiResult> => ({
      columnsResult: { ok: true, message: "" },
    }),
    removeColumn: async () => {},
    onReload: () => {},
    latestColumns: (): ColumnChip[] => [],
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe("renderColumnSection — 칸 섹션 DOM(S8)", () => {
  test("칩 키 + 타입 배지([숫자]/[글자]/[날짜]) 텍스트가 그려진다", () => {
    const host = freshHost();
    const section = renderColumnSection(
      baseDeps({
        columns: [
          { key: "금액", dataType: "number", id: "c1" },
          { key: "메모", dataType: "text", id: "c2" },
          { key: "구입일", dataType: "date", id: "c3" },
          {
            key: "별칭",
            dataType: "text",
            semantic: "alias",
            helpText: "이름 대신 사용 할 수 있음",
            id: null,
          },
        ],
      }),
    );
    host.appendChild(section);
    const chips = Array.from(section.querySelectorAll("[data-column-chip]"));
    expect(chips.length).toBe(4);
    const numberChip = chips.find((c) => c.textContent?.includes("금액"))!;
    const textChip = chips.find((c) => c.textContent?.includes("메모"))!;
    const dateChip = chips.find((c) => c.textContent?.includes("구입일"))!;
    // 숫자형 칩은 [숫자] 배지, 글자형 칩은 [글자] 배지, 날짜형 칩은 [날짜] 배지(dataType 으로 그린다).
    expect(numberChip.querySelector('[data-data-type="number"]')).not.toBeNull();
    expect(numberChip.textContent).toContain("숫자");
    expect(textChip.querySelector('[data-data-type="text"]')).not.toBeNull();
    expect(textChip.textContent).toContain("글자");
    expect(dateChip.querySelector('[data-data-type="date"]')).not.toBeNull();
    expect(dateChip.textContent).toContain("날짜");
    const aliasChip = chips.find((c) => c.textContent?.includes("별칭")) as HTMLElement;
    expect(aliasChip.dataset.semantic).toBe("alias");
    expect(aliasChip.title).toBe("이름 대신 사용 할 수 있음");
  });

  test("추가 폼 라디오 기본 선택 = 글자형(라우트 text 기본 일치)", () => {
    const host = freshHost();
    const section = renderColumnSection(baseDeps());
    host.appendChild(section);
    const textRadio = section.querySelector('[data-column-type="text"]') as HTMLInputElement;
    const numberRadio = section.querySelector('[data-column-type="number"]') as HTMLInputElement;
    const dateRadio = section.querySelector('[data-column-type="date"]') as HTMLInputElement;
    expect(textRadio.checked).toBe(true);
    expect(numberRadio.checked).toBe(false);
    expect(dateRadio.checked).toBe(false);
  });

  test("칸 이름 입력 + 추가 클릭 → addColumn(key, 글자형) 콜백(기본)", async () => {
    const host = freshHost();
    const calls: Array<[string, string]> = [];
    const section = renderColumnSection(
      baseDeps({
        addColumn: async (columnKey, dataType) => {
          calls.push([columnKey, dataType]);
          return { columnsResult: { ok: true, message: "" } };
        },
      }),
    );
    host.appendChild(section);
    (section.querySelector("[data-column-key-input]") as HTMLInputElement).value = "메모";
    const form = section.querySelector(".entity-mgmt-column-add") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(calls).toEqual([["메모", "text"]]);
  });

  test("숫자형 라디오 선택 후 추가 → addColumn(key, 숫자형) 콜백", async () => {
    const host = freshHost();
    const calls: Array<[string, string]> = [];
    const section = renderColumnSection(
      baseDeps({
        addColumn: async (columnKey, dataType) => {
          calls.push([columnKey, dataType]);
          return {
            columnsResult: { ok: true, message: "" },
            columnTypesResult: { ok: true, message: "" },
          };
        },
      }),
    );
    host.appendChild(section);
    (section.querySelector("[data-column-key-input]") as HTMLInputElement).value = "금액";
    (section.querySelector('[data-column-type="number"]') as HTMLInputElement).checked = true;
    const form = section.querySelector(".entity-mgmt-column-add") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(calls).toEqual([["금액", "number"]]);
  });

  test("날짜형 라디오 선택 후 추가 → addColumn(key, 날짜형) 콜백", async () => {
    const host = freshHost();
    const calls: Array<[string, string]> = [];
    const section = renderColumnSection(
      baseDeps({
        addColumn: async (columnKey, dataType) => {
          calls.push([columnKey, dataType]);
          return {
            columnsResult: { ok: true, message: "" },
            columnTypesResult: { ok: true, message: "" },
          };
        },
      }),
    );
    host.appendChild(section);
    (section.querySelector("[data-column-key-input]") as HTMLInputElement).value = "구입일";
    (section.querySelector('[data-column-type="date"]') as HTMLInputElement).checked = true;
    const form = section.querySelector(".entity-mgmt-column-add") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(calls).toEqual([["구입일", "date"]]);
  });

  test("user 칩 ✕ 삭제 → removeColumn(id) 콜백", async () => {
    const host = freshHost();
    const removed: string[] = [];
    const section = renderColumnSection(
      baseDeps({
        columns: [{ key: "금액", dataType: "number", id: "c1" }],
        removeColumn: async (id) => void removed.push(id),
      }),
    );
    host.appendChild(section);
    const delBtn = section.querySelector("[data-column-delete]") as HTMLButtonElement;
    expect(delBtn).not.toBeNull();
    delBtn.click();
    await flush();
    expect(removed).toEqual(["c1"]);
  });

  test("code 종류 = 읽기전용(추가 폼·삭제 버튼 0·타입 배지만)", () => {
    const host = freshHost();
    const section = renderColumnSection(
      baseDeps({
        source: "code",
        columns: [{ key: "유통기한", dataType: "date", id: null }],
      }),
    );
    host.appendChild(section);
    // 추가 폼·삭제 버튼이 없다(읽기전용).
    expect(section.querySelector("[data-column-key-input]")).toBeNull();
    expect(section.querySelector("[data-column-delete]")).toBeNull();
    // 타입 배지는 보인다(칸 자체는 그려진다).
    expect(section.querySelector("[data-column-chip]")).not.toBeNull();
    expect(section.textContent).toContain("유통기한");
  });

  test("삭제 id 가 null 인 user 칩은 삭제 버튼 없음(읽기전용 칸)", () => {
    const host = freshHost();
    const section = renderColumnSection(
      baseDeps({
        source: "user",
        columns: [{ key: "코드칸", dataType: "text", id: null }],
      }),
    );
    host.appendChild(section);
    // user 종류여도 그 칸의 삭제 id 가 null 이면 삭제 버튼이 안 붙는다(buildColumnChips 조인 결과).
    const chip = section.querySelector("[data-column-chip]")!;
    expect(chip.querySelector("[data-column-delete]")).toBeNull();
  });

  test("칸 0개면 '칸 없음' 안내(가짜 칩 0·정직한 빈 상태)", () => {
    const host = freshHost();
    const section = renderColumnSection(baseDeps({ columns: [] }));
    host.appendChild(section);
    expect(section.querySelector("[data-column-empty]")).not.toBeNull();
  });

  test("부분 실패(칸 성공·숫자형 실패) → 칸 살리고 실패 박스 안내(롤백 0)", async () => {
    const host = freshHost();
    const section = renderColumnSection(
      baseDeps({
        columns: [],
        addColumn: async () => ({
          columnsResult: { ok: true, message: "" },
          columnTypesResult: { ok: false, message: "datatype 거부" },
        }),
        // reload 후 칸이 글자형으로 살아 보이도록 latestColumns 가 그 칸을 돌려준다(흉내).
        latestColumns: () => [{ key: "금액", dataType: "text", id: "c1" }],
      }),
    );
    host.appendChild(section);
    (section.querySelector("[data-column-key-input]") as HTMLInputElement).value = "금액";
    (section.querySelector('[data-column-type="number"]') as HTMLInputElement).checked = true;
    const form = section.querySelector(".entity-mgmt-column-add") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    // 실패 박스가 보이고, 칸은 글자형으로 살아 칩에 그려진다(롤백 DELETE 0).
    const failBox = section.querySelector("[data-column-fail]") as HTMLElement;
    expect(failBox.style.display).not.toBe("none");
    expect(failBox.textContent).toContain("금액");
    expect(failBox.textContent).toContain("datatype 거부");
    expect(section.textContent).toContain("금액");
  });
});
