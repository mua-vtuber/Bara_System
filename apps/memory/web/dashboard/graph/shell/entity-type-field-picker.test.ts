/**
 * entity-type-field-picker 단위 테스트 (그래프 입력검색 보강 S1).
 *
 * 검증 정신 — mock 0:
 *   공용 picker 의 순수 산출(getKind·getFields·getNumericColumns·onKindChange)을
 *   happy-dom 전역 위에서 검증한다. fetch 부수효과(load())는 단위 테스트에서 안
 *   건드리고 라이브로 확인한다(ingest-form.test.ts 와 같은 가름). setColumnsForTest 는
 *   picker 실구현체에 fixture columns 를 넣는 데이터 통로다 — 인터페이스 mock 구현체가
 *   아니다(프로젝트 정책).
 *
 * 검증 갈래:
 *   1) getFields — fieldsEl 의 [data-field-key] input 에서 값 있는 칸만 {칸키:값} 으로
 *      읽고 공백·빈 칸은 생략한다(buildDynamicPayload 정신).
 *   2) getKind — selectEl.value 를 영문 typeName 그대로 돌리고 빈 선택이면 "".
 *   3) getNumericColumns — 현재 종류 columns 에서 dataType==="number" 만(filterNumericColumns 재사용).
 *   4) onKindChange — selectEl 의 change 이벤트가 새 kind 로 콜백을 부른다.
 *   5) getSubcategory(S7) — 빈 선택이면 "". setSubcategoriesForTest 로 fixture 주입.
 *   6) search 모드 종류 change(S7) — subcategorySelectEl 이 그 종류 갈래로 채워지고 칸 입력(fieldsEl)은 안 그려진다.
 *   7) ingest 모드 종류 change(회귀) — 칸 입력은 그대로 그려지고 subcategorySelectEl 은 placeholder 만.
 */

import "../../../../test-setup-dom";
import { test, expect } from "bun:test";
import { createEntityTypeFieldPicker } from "./entity-type-field-picker.ts";

// getFields — 값 있는 칸만, 빈 칸 생략(buildDynamicPayload 정신)
test("getFields — 값 있는 칸만 담고 빈 칸은 생략", () => {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "ingest" });
  // load() 없이 columns 를 직접 주입하는 통로가 없으므로, fieldsEl 에 input 두 개를 직접
  // 꽂아 getFields 가 data-field-key + value 만 읽는지 검증한다(순수 DOM 읽기).
  const a = document.createElement("input");
  a.dataset["fieldKey"] = "항목";
  a.value = "우유";
  const b = document.createElement("input");
  b.dataset["fieldKey"] = "메모";
  b.value = "  "; // 공백 → 생략
  picker.fieldsEl.append(a, b);
  expect(picker.getFields()).toEqual({ 항목: "우유" });
});

// getKind — selectEl.value 가 영문 typeName 그대로
test("getKind — 빈 선택이면 빈 문자열", () => {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  expect(picker.getKind()).toBe("");
});

// getNumericColumns — filterNumericColumns 재사용(dataType==="number" 만)
test("getNumericColumns — 현재 종류 숫자형 칸만", () => {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  picker.setColumnsForTest("가계부", [
    { key: "항목", label: "항목" },
    { key: "금액", label: "금액", dataType: "number" },
  ]);
  picker.selectEl.value = "가계부";
  expect(picker.getNumericColumns()).toEqual([{ key: "금액", label: "금액" }]);
});

// onKindChange — 종류 바뀌면 콜백
test("onKindChange — 종류 변경 시 새 kind 로 콜백", () => {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  picker.setColumnsForTest("가계부", []);
  const seen: string[] = [];
  picker.onKindChange((k) => seen.push(k));
  picker.selectEl.value = "가계부";
  picker.selectEl.dispatchEvent(new Event("change"));
  expect(seen).toEqual(["가계부"]);
});

// getSubcategory(S7) — 빈 선택이면 빈 문자열
test("getSubcategory — 빈 선택이면 빈 문자열", () => {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  expect(picker.getSubcategory()).toBe("");
});

// search 모드 종류 change(S7) — subcategorySelectEl 이 그 종류 갈래로 채워지고 칸 입력은 안 그려진다
test("search 모드 종류 change — 하위분류 드롭다운 채움 + 칸 입력 안 그림", () => {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  // 같은 종류에 칸·하위분류를 둘 다 fixture 로 주입 — search 모드는 칸을 안 그리고 하위분류만 채워야 한다.
  picker.setColumnsForTest("작품", [{ key: "장르", label: "장르" }]);
  picker.setSubcategoriesForTest("작품", ["소설", "만화"]);
  picker.selectEl.value = "작품";
  picker.selectEl.dispatchEvent(new Event("change"));

  // 하위분류 드롭다운 = placeholder(value="") + 갈래 2개. getSubcategory 로 갈래를 고를 수 있다.
  const subValues = Array.from(picker.subcategorySelectEl.options).map((o) => o.value);
  expect(subValues).toEqual(["", "소설", "만화"]);
  picker.subcategorySelectEl.value = "소설";
  expect(picker.getSubcategory()).toBe("소설");

  // 검색 모드는 칸 입력을 그리지 않는다(하위분류로 대체·S7) — fieldsEl 에 [data-field-key] 0개.
  expect(picker.fieldsEl.querySelectorAll("[data-field-key]").length).toBe(0);
});

// ingest 모드 종류 change(회귀) — 칸 입력은 그대로, 하위분류 드롭다운은 placeholder 만
test("ingest 모드 종류 change — 칸 입력 그림 + 하위분류 드롭다운은 placeholder 만(회귀)", () => {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "ingest" });
  picker.setColumnsForTest("가계부", [{ key: "항목", label: "항목" }]);
  picker.setSubcategoriesForTest("가계부", ["식비", "교통"]);
  picker.selectEl.value = "가계부";
  picker.selectEl.dispatchEvent(new Event("change"));

  // ingest 모드는 칸 입력을 그린다(회귀 0) — [data-field-key] 가 그려진다.
  expect(picker.fieldsEl.querySelectorAll("[data-field-key]").length).toBe(1);
  // ingest 모드는 하위분류 드롭다운을 안 쓴다 — placeholder 한 개만 남는다(갈래 미주입).
  expect(picker.subcategorySelectEl.options.length).toBe(1);
});

// showLoadError(고칠 것 1) — load 실패 메시지가 errorEl 에 채워진다(빈 위장 0).
test("showLoadError — 메시지를 errorEl 에 채우고, 비면 errorEl 이 비어 있다", () => {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  // 평소엔 비어 있다(:empty CSS 로 화면에서 숨는다).
  expect(picker.errorEl.textContent).toBe("");
  picker.showLoadError("종류 목록을 불러오지 못했습니다: HTTP 500");
  expect(picker.errorEl.textContent).toBe("종류 목록을 불러오지 못했습니다: HTTP 500");
});

// load 후 renderFields race 복구(고칠 것 2) — load 끝의 renderFields() 와 같은 복구 경로를
// 재현한다. 사용자가 종류를 먼저 고른 뒤(빈 맵 change 로 드롭다운 빈 채 고정) 맵이 채워지고
// 다시 그려지면, 하위분류 드롭다운이 그 종류 갈래로 복구된다. load() 는 실제 fetch 라
// 단위에서 안 부르고, 같은 renderFields 복구 경로(맵 채워진 뒤 재렌더)를 change 로 검증한다.
test("race 복구 — 맵이 채워진 뒤 재렌더하면 빈 채 고정됐던 하위분류가 복구된다", () => {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  // 1) load 가 끝나기 전 사용자가 종류를 먼저 고른 상황 — 맵이 비어 있어 드롭다운이 placeholder 만.
  picker.setSubcategoriesForTest("작품", []); // option 만 생기고 갈래는 비어 있음(load 전 상태 흉내)
  picker.selectEl.value = "작품";
  picker.selectEl.dispatchEvent(new Event("change"));
  expect(picker.subcategorySelectEl.options.length).toBe(1); // placeholder 만(빈 채 고정)

  // 2) load 가 끝나 맵이 채워진 뒤 다시 그려지는 복구 경로 — change 한 번이 load 끝 renderFields()
  //    와 같은 재렌더를 일으켜 그 종류 갈래로 드롭다운이 복구된다.
  picker.setSubcategoriesForTest("작품", ["소설", "만화"]);
  picker.selectEl.dispatchEvent(new Event("change"));
  const subValues = Array.from(picker.subcategorySelectEl.options).map((o) => o.value);
  expect(subValues).toEqual(["", "소설", "만화"]); // 복구됨
});
