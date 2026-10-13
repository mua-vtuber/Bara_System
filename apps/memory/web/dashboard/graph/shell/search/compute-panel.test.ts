/**
 * compute-panel 단위 테스트 (그래프 입력검색 보강 S5).
 *
 * 검색 모달 [계산] 탭 UI 배선을 검증한다 — 연산 셀렉트가 COMPUTE_TEXT.ops 로 채워지고
 * (문구 하드코딩 0), 분모 셀렉트가 COMPUTE_TEXT.divisors 로 채워지며, 연산이 sum/avg 일
 * 때만 숫자칸 행이 보이고 avg 일 때만 분모 행이 보이는지 본다.
 *
 * compute-panel.ts 는 @huggingface/transformers 를 import 하지 않지만 happy-dom 전역을
 * 쓰므로, 이 파일은 단독 명령으로 돌린다([[memory-suite-test-network-flaky]]).
 * picker 는 T1 실구현체를 setColumnsForTest 로 채워 주입한다(인터페이스 mock 0·데이터 fixture).
 * 계산 버튼 클릭(postCompute fetch)은 단위 테스트에서 안 건드리고 라이브로 검증한다.
 */
import "../../../../../test-setup-dom";
import { test, expect } from "bun:test";
import { createEntityTypeFieldPicker } from "../entity-type-field-picker.ts";
import { mountComputePanel } from "./compute-panel.ts";
import { COMPUTE_TEXT } from "../../../compute-tab.js";
import { _resetTokenCacheForTest } from "../../../api-fetch.ts";

function makePanel(): { slot: HTMLElement; picker: ReturnType<typeof createEntityTypeFieldPicker> } {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  const slot = document.createElement("div");
  mountComputePanel({
    slot,
    picker,
    apiBase: "",
    getPeriod: () => ({}),
    getQueryText: () => "",
    onResult: () => {},
    onError: () => {},
  });
  return { slot, picker };
}

test("연산 셀렉트가 COMPUTE_TEXT.ops 로 채워짐(하드코딩 0)", () => {
  const { slot } = makePanel();
  const opSel = slot.querySelector<HTMLSelectElement>("[data-cp-op]")!;
  expect([...opSel.options].map((o) => o.value)).toEqual(COMPUTE_TEXT.ops.map((o) => o.value));
  expect([...opSel.options].map((o) => o.textContent)).toEqual(COMPUTE_TEXT.ops.map((o) => o.label));
});

test("분모 셀렉트가 COMPUTE_TEXT.divisors 로 채워짐(하드코딩 0)", () => {
  const { slot } = makePanel();
  const divSel = slot.querySelector<HTMLSelectElement>("[data-cp-divisor]")!;
  expect([...divSel.options].map((o) => o.value)).toEqual(COMPUTE_TEXT.divisors.map((d) => d.value));
});

test("기본(count) — 숫자칸 행·분모 행 둘 다 숨김", () => {
  const { slot } = makePanel();
  const fieldRow = slot.querySelector<HTMLElement>("[data-cp-field-row]")!;
  const divRow = slot.querySelector<HTMLElement>("[data-cp-divisor-row]")!;
  expect(fieldRow.style.display).toBe("none");
  expect(divRow.style.display).toBe("none");
});

test("연산=sum 이면 숫자칸 행 보임(분모 행은 계속 숨김)", () => {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  picker.setColumnsForTest("가계부", [{ key: "금액", label: "금액", dataType: "number" }]);
  picker.selectEl.value = "가계부";
  const slot = document.createElement("div");
  mountComputePanel({ slot, picker, apiBase: "", getPeriod: () => ({}), getQueryText: () => "", onResult: () => {}, onError: () => {} });
  const opSel = slot.querySelector<HTMLSelectElement>("[data-cp-op]")!;
  opSel.value = "sum";
  opSel.dispatchEvent(new Event("change"));
  const fieldRow = slot.querySelector<HTMLElement>("[data-cp-field-row]")!;
  const divRow = slot.querySelector<HTMLElement>("[data-cp-divisor-row]")!;
  expect(fieldRow.style.display).not.toBe("none");
  expect(divRow.style.display).toBe("none");
  // 숫자칸 셀렉트가 picker 의 숫자형 칸으로 채워졌는지(getNumericColumns 재사용).
  const fieldSel = slot.querySelector<HTMLSelectElement>("[data-cp-field]")!;
  expect([...fieldSel.options].map((o) => o.value)).toEqual(["금액"]);
});

test("연산=avg 이면 숫자칸 행·분모 행 둘 다 보임", () => {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  picker.setColumnsForTest("가계부", [{ key: "금액", label: "금액", dataType: "number" }]);
  picker.selectEl.value = "가계부";
  const slot = document.createElement("div");
  mountComputePanel({ slot, picker, apiBase: "", getPeriod: () => ({}), getQueryText: () => "", onResult: () => {}, onError: () => {} });
  const opSel = slot.querySelector<HTMLSelectElement>("[data-cp-op]")!;
  opSel.value = "avg";
  opSel.dispatchEvent(new Event("change"));
  const fieldRow = slot.querySelector<HTMLElement>("[data-cp-field-row]")!;
  const divRow = slot.querySelector<HTMLElement>("[data-cp-divisor-row]")!;
  expect(fieldRow.style.display).not.toBe("none");
  expect(divRow.style.display).not.toBe("none");
});

test("종류 변경 시 숫자칸 셀렉트가 새 종류로 갱신(picker.onKindChange 배선)", () => {
  const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  picker.setColumnsForTest("가계부", [{ key: "금액", label: "금액", dataType: "number" }]);
  picker.setColumnsForTest("운동", [{ key: "거리", label: "거리", dataType: "number" }]);
  const slot = document.createElement("div");
  mountComputePanel({ slot, picker, apiBase: "", getPeriod: () => ({}), getQueryText: () => "", onResult: () => {}, onError: () => {} });
  const opSel = slot.querySelector<HTMLSelectElement>("[data-cp-op]")!;
  opSel.value = "sum";
  opSel.dispatchEvent(new Event("change"));
  picker.selectEl.value = "가계부";
  picker.selectEl.dispatchEvent(new Event("change"));
  let fieldSel = slot.querySelector<HTMLSelectElement>("[data-cp-field]")!;
  expect([...fieldSel.options].map((o) => o.value)).toEqual(["금액"]);
  picker.selectEl.value = "운동";
  picker.selectEl.dispatchEvent(new Event("change"));
  fieldSel = slot.querySelector<HTMLSelectElement>("[data-cp-field]")!;
  expect([...fieldSel.options].map((o) => o.value)).toEqual(["거리"]);
});

test("계산 버튼이 COMPUTE_TEXT.computeButton 문구를 쓴다(하드코딩 0)", () => {
  const { slot } = makePanel();
  const runBtn = slot.querySelector<HTMLButtonElement>("[data-cp-run]")!;
  expect(runBtn.textContent).toBe(COMPUTE_TEXT.computeButton);
});

// ── query 합류(빈 query 400 버그 차단·S5) ─────────────────────────────────────
// 계산 버튼 클릭 → getQueryText(없으면 종류값)로 query 를 채워 /compute body 로 보내는지 본다.
// 실제 네트워크 대신 전역 fetch 슬롯을 캡처용 함수로 갈아끼운다(인터페이스 mock 클래스 0 —
// 전역 함수 부수효과만 가로채 호출 body 를 fixture 로 검증). apiFetch 는 먼저
// /dashboard/sse-token 으로 토큰을 받으므로 그 경로는 토큰 JSON 을, /compute 는 body 를
// 캡처하고 빈 집계 응답을 돌려준다(2xx). 토큰 캐시는 케이스마다 초기화한다.

/** 전역 fetch 를 캡처용으로 갈아끼우고, 잡힌 /compute body·호출 횟수와 복원 함수를 돌려준다. */
function captureComputeFetch(): {
  getComputeBody: () => Record<string, unknown> | null;
  getComputeCallCount: () => number;
  restore: () => void;
} {
  _resetTokenCacheForTest();
  window.sessionStorage.setItem("bara.dashboard.token", "t");
  const original = globalThis.fetch;
  let computeBody: Record<string, unknown> | null = null;
  let computeCalls = 0;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/dashboard/sse-token")) {
      return new Response(JSON.stringify({ token: "t" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/compute")) {
      computeCalls += 1;
      computeBody =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      // 빈 집계 응답(2xx) — query 조립만 검증하므로 결과 모양은 최소.
      return new Response(JSON.stringify({ kind: "count", count: 0, items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`예상치 못한 fetch 경로: ${url}`);
  }) as typeof fetch;
  return {
    getComputeBody: () => computeBody,
    getComputeCallCount: () => computeCalls,
    restore: () => {
      window.sessionStorage.removeItem("bara.dashboard.token");
      globalThis.fetch = original;
      _resetTokenCacheForTest();
    },
  };
}

/** runBtn 클릭 후 비동기 fetch 체인(토큰→compute)이 끝나도록 한 박자 기다린다. */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

test("검색어가 있으면 그 검색어가 query 로 합류한다", async () => {
  const cap = captureComputeFetch();
  try {
    const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
    const slot = document.createElement("div");
    mountComputePanel({
      slot,
      picker,
      apiBase: "",
      getPeriod: () => ({}),
      getQueryText: () => "마트 영수증",
      onResult: () => {},
      onError: () => {},
    });
    slot.querySelector<HTMLButtonElement>("[data-cp-run]")!.click();
    await flushAsync();
    expect(cap.getComputeCallCount()).toBe(1);
    expect(cap.getComputeBody()?.["query"]).toBe("마트 영수증");
  } finally {
    cap.restore();
  }
});

test("검색어 없고 종류 있으면 종류값이 query 로 합류한다", async () => {
  const cap = captureComputeFetch();
  try {
    const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
    picker.setColumnsForTest("가계부", [{ key: "금액", label: "금액", dataType: "number" }]);
    picker.selectEl.value = "가계부";
    const slot = document.createElement("div");
    mountComputePanel({
      slot,
      picker,
      apiBase: "",
      getPeriod: () => ({}),
      getQueryText: () => "",
      onResult: () => {},
      onError: () => {},
    });
    slot.querySelector<HTMLButtonElement>("[data-cp-run]")!.click();
    await flushAsync();
    expect(cap.getComputeCallCount()).toBe(1);
    expect(cap.getComputeBody()?.["query"]).toBe("가계부");
    // 종류값은 filter:{종류} 로도 감싸진다(함정 A·compute-api).
    expect(cap.getComputeBody()?.["filter"]).toEqual({ 종류: "가계부" });
  } finally {
    cap.restore();
  }
});

test("검색어·종류 둘 다 없으면 postCompute 안 부르고 onError 로 안내한다", async () => {
  const cap = captureComputeFetch();
  const errors: string[] = [];
  try {
    const picker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
    const slot = document.createElement("div");
    mountComputePanel({
      slot,
      picker,
      apiBase: "",
      getPeriod: () => ({}),
      getQueryText: () => "",
      onResult: () => {},
      onError: (m) => { errors.push(m); },
    });
    slot.querySelector<HTMLButtonElement>("[data-cp-run]")!.click();
    await flushAsync();
    expect(cap.getComputeCallCount()).toBe(0);
    expect(errors).toEqual(["검색어나 종류를 입력해주세요"]);
  } finally {
    cap.restore();
  }
});
