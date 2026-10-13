/**
 * search-modal 단위 테스트 (그래프 입력검색 보강 S4).
 *
 * 검색 모달 골격을 검증한다 — onSearch payload 분기(query·mode·kind·subcategory·기간),
 * 빈 query 차단, 기간 두 칸 합류, [계산] 탭 activeMode 전환.
 * picker 는 T1 실구현체를 fixture(setColumnsForTest·setSubcategoriesForTest)로 채워 주입한다
 * (인터페이스 mock 아님·프로젝트 정책). happy-dom 단독 — @huggingface/transformers
 * 를 import 하지 않으므로 이 파일은 단독 명령으로 돌린다([[memory-suite-test-network-flaky]]).
 *
 * S7 — 검색 탭은 칸(fields) 입력 대신 하위분류 단일 드롭다운(subcategory)을 보낸다. payload 에
 * fields 키는 더는 없다.
 */
import "../../../../../test-setup-dom";
import { test, expect } from "bun:test";
import { renderSearchModal } from "./search-modal.ts";
import type { SearchModalSearchPayload } from "./search-modal.ts";
import { createEntityTypeFieldPicker } from "../entity-type-field-picker.ts";

function makePicker() {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  picker.setColumnsForTest("가계부", [{ key: "항목", label: "항목" }]);
  picker.setSubcategoriesForTest("가계부", ["식비", "교통"]);
  return picker;
}

test("검색 실행 — onSearch 가 query·mode·kind·subcategory payload 로 호출(fields 키 없음·S7)", () => {
  const picker = makePicker();
  const calls: SearchModalSearchPayload[] = [];
  const { root } = renderSearchModal({
    picker,
    onSearch: (p) => calls.push(p),
    onCompute: () => {},
  });
  document.body.appendChild(root);
  // 종류 선택 → change 발화로 그 종류 하위분류가 picker.subcategorySelectEl 에 채워진다(search 모드).
  picker.selectEl.value = "가계부";
  picker.selectEl.dispatchEvent(new Event("change"));
  // 하위분류 갈래 선택.
  picker.subcategorySelectEl.value = "식비";
  const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
  input.value = "마트";
  root.querySelector<HTMLButtonElement>("[data-so-search-btn]")!.click();
  expect(calls).toEqual([
    {
      query: "마트",
      mode: "search",
      kind: "가계부",
      subcategory: "식비",
    },
  ]);
  // fields 키는 검색 payload 에서 빠졌다(S7 — 칸 입력 제거·하위분류로 대체).
  expect("fields" in calls[0]!).toBe(false);
});

test("필터 행 순서 — 종류·하위분류를 붙이고 그 뒤에 기간을 둔다", () => {
  const picker = makePicker();
  const { root } = renderSearchModal({
    picker,
    onSearch: () => {},
    onCompute: () => {},
  });
  document.body.appendChild(root);
  const filterRow = root.querySelector<HTMLElement>(".so-filter-row")!;
  const order = Array.from(filterRow.children).map((child) => {
    if (child === picker.selectEl) return "kind";
    if (child === picker.subcategorySelectEl) return "subcategory";
    if (child === picker.errorEl) return "error";
    if ((child as HTMLElement).dataset["soSince"] === "1") return "since";
    if ((child as HTMLElement).dataset["soUntil"] === "1") return "until";
    if (child.classList.contains("ingest-event-sep")) return "sep";
    return child.tagName.toLowerCase();
  });
  expect(order).toEqual(["kind", "subcategory", "since", "sep", "until", "error"]);
});

test("하위분류 미선택 — payload 에 subcategory 키 없음", () => {
  const picker = makePicker();
  const calls: SearchModalSearchPayload[] = [];
  const { root } = renderSearchModal({
    picker,
    onSearch: (p) => calls.push(p),
    onCompute: () => {},
  });
  document.body.appendChild(root);
  picker.selectEl.value = "가계부";
  picker.selectEl.dispatchEvent(new Event("change"));
  // 하위분류는 placeholder(빈 선택) 그대로 둔다.
  root.querySelector<HTMLInputElement>('input[type="search"]')!.value = "마트";
  root.querySelector<HTMLButtonElement>("[data-so-search-btn]")!.click();
  expect("subcategory" in calls[0]!).toBe(false);
  expect(calls[0]!.kind).toBe("가계부");
});

test("빈 query — onSearch 안 부름", () => {
  const picker = makePicker();
  let n = 0;
  const { root } = renderSearchModal({
    picker,
    onSearch: () => {
      n++;
    },
    onCompute: () => {},
  });
  document.body.appendChild(root);
  root.querySelector<HTMLButtonElement>("[data-so-search-btn]")!.click();
  expect(n).toBe(0);
});

test("기간 두 칸 채우면 since·until 합류", () => {
  const picker = makePicker();
  const calls: SearchModalSearchPayload[] = [];
  const { root } = renderSearchModal({
    picker,
    onSearch: (p) => calls.push(p),
    onCompute: () => {},
  });
  document.body.appendChild(root);
  root.querySelector<HTMLInputElement>("[data-so-since]")!.value = "2026-05-01";
  root.querySelector<HTMLInputElement>("[data-so-until]")!.value = "2026-05-31";
  root.querySelector<HTMLInputElement>('input[type="search"]')!.value = "마트";
  root.querySelector<HTMLButtonElement>("[data-so-search-btn]")!.click();
  expect(calls[0]!.since).toBe("2026-05-01");
  expect(calls[0]!.until).toBe("2026-05-31");
});

test("getPeriod — 기간 두 칸 채우면 {since,until}, 비면 빈 객체", () => {
  const picker = makePicker();
  const { root, getPeriod } = renderSearchModal({ picker, onSearch: () => {}, onCompute: () => {} });
  document.body.appendChild(root);
  expect(getPeriod()).toEqual({});
  root.querySelector<HTMLInputElement>("[data-so-since]")!.value = "2026-05-01";
  root.querySelector<HTMLInputElement>("[data-so-until]")!.value = "2026-05-31";
  expect(getPeriod()).toEqual({ since: "2026-05-01", until: "2026-05-31" });
});

test("[계산] 탭 누르면 activeMode=compute (검색 payload 와 분리)", () => {
  const picker = makePicker();
  const { root, getActiveMode } = renderSearchModal({
    picker,
    onSearch: () => {},
    onCompute: () => {},
  });
  document.body.appendChild(root);
  root.querySelector<HTMLButtonElement>('[data-so-tab="compute"]')!.click();
  expect(root.querySelector('[data-so-tab="compute"]')!.classList.contains("active")).toBe(true);
  expect(getActiveMode()).toBe("compute");
});

test("[계산] 탭 — 하위분류 드롭다운 숨김, 검색 탭 복귀 시 다시 보임(S7·계산은 하위분류 안 씀)", () => {
  const picker = makePicker();
  const { root } = renderSearchModal({
    picker,
    onSearch: () => {},
    onCompute: () => {},
  });
  document.body.appendChild(root);
  // 기본(검색 탭) — 하위분류 드롭다운이 보인다.
  expect(picker.subcategorySelectEl.style.display).not.toBe("none");
  // 계산 탭 — 하위분류 드롭다운을 숨긴다(종류·기간만 공유).
  root.querySelector<HTMLButtonElement>('[data-so-tab="compute"]')!.click();
  expect(picker.subcategorySelectEl.style.display).toBe("none");
  // 검색 탭 복귀 — 다시 보인다.
  root.querySelector<HTMLButtonElement>('[data-so-tab="search"]')!.click();
  expect(picker.subcategorySelectEl.style.display).not.toBe("none");
});
