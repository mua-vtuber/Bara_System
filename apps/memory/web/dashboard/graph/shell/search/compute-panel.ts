/**
 * web/dashboard/graph/shell/search/compute-panel.ts
 * 검색 모달 [계산] 탭 UI 배선(spec §7.2). compute-tab.js 순수 함수를 재사용하고 문구는
 * COMPUTE_TEXT 한 곳에서 그린다(하드코딩 0). 계산 버튼이 buildComputePayloadOpts 로 opts 를
 * 만들어 compute-api 의 postCompute 로 POST /compute 를 부르고, 성공 시 결과 DOM 노드를
 * onResult 로 호출부(graph-entry)에 넘겨 우측 결과 패널에 표시한다. 실패는 onError 로
 * 한국어 문구를 넘긴다(localizeComputeError·원문 안 가림).
 *
 * 기간(since/until)은 search-modal 의 필터 행 기간 두 칸을 검색·계산이 공유한다 — compute-panel
 * 은 그 DOM 을 직접 모르고(의존 방향 일방), 호출부가 ctx.getPeriod 로 현재 기간 값을 넘긴다.
 *
 * 의존: dom.ts(el) + entity-type-field-picker(FieldPicker 타입) + compute-tab.js 순수 함수
 * + compute-api(postCompute). graph/render·three.js 미의존(공유 shell 층).
 */
import { el } from "../dom.ts";
import type { FieldPicker } from "../entity-type-field-picker.ts";
import {
  COMPUTE_TEXT,
  buildComputePayloadOpts,
  buildComputeResultNodes,
  localizeComputeError,
} from "../../../compute-tab.js";
import { postCompute } from "./compute-api.ts";

export interface ComputePanelCtx {
  /** 계산 UI 를 끼울 컨테이너(search-modal 의 computeSlot). */
  slot: HTMLElement;
  /** 공용 picker — 종류(getKind)·숫자형 칸(getNumericColumns)·종류 변경(onKindChange) 공유. */
  picker: FieldPicker;
  apiBase: string;
  /** 검색·계산이 공유하는 필터 행 기간 두 칸의 현재 값(호출부가 search-modal DOM 에서 읽어 넘긴다). */
  getPeriod: () => { since?: string; until?: string };
  /**
   * 검색 입력칸의 현재 검색어(호출부가 search-modal DOM 에서 읽어 넘긴다 — getPeriod 와 같은
   * 양식·compute-panel 이 search-modal DOM 을 직접 읽지 않게 의존 방향을 일방으로 유지).
   * /compute 라우트가 query 를 필수로 요구하므로(빈 query 는 400), 계산 버튼이 이 검색어(없으면
   * 종류값)로 query 를 채워 보낸다. index.html runCompute 의 `검색어 || 종류값` 정합.
   */
  getQueryText: () => string;
  /** 계산 성공 — 결과 DOM 노드 배열을 우측 결과 패널에 표시할 호출부 콜백. */
  onResult: (nodes: HTMLElement[]) => void;
  /** 계산 실패 — 한국어 에러 문구(localizeComputeError 산출). */
  onError: (message: string) => void;
}

export function mountComputePanel(ctx: ComputePanelCtx): void {
  const { slot, picker, apiBase, getPeriod, getQueryText, onResult, onError } = ctx;

  // compute-tab.js 의 buildComputeResultNodes 는 el(tag, props?: object, ...) 을 기대하는데
  // dom.ts 의 el 은 props 가 Record<string, unknown> 로 더 좁다(함수 파라미터 반공변).
  // 런타임은 호환되나 타입만 안 맞아, 넓은 시그니처로 감싼 어댑터를 한 번만 만들어 재사용한다.
  const elForCompute = (
    tag: string,
    props?: object,
    ...children: Array<Node | string | null>
  ): HTMLElement => el(tag, (props ?? {}) as Record<string, unknown>, ...children);

  // 연산 셀렉트(개수/더하기/평균) — COMPUTE_TEXT.ops 한 출처.
  const opSel = el("select", {
    className: "compute-op",
    dataset: { cpOp: "1" },
    "aria-label": COMPUTE_TEXT.opLabel,
  }) as HTMLSelectElement;
  for (const o of COMPUTE_TEXT.ops) {
    opSel.appendChild(el("option", { value: o.value }, o.label));
  }

  // 숫자형 칸 셀렉트(sum/avg 일 때만 보임) — picker.getNumericColumns() 로 채운다.
  const fieldSel = el("select", {
    className: "compute-field",
    dataset: { cpField: "1" },
    "aria-label": "숫자형 칸",
  }) as HTMLSelectElement;
  const fieldRow = el(
    "div",
    { className: "compute-numeric-field-row", dataset: { cpFieldRow: "1" }, style: "display:none" },
    fieldSel,
  );

  // 분모 셀렉트(평균 기준·avg 일 때만 보임) — COMPUTE_TEXT.divisors 한 출처.
  const divSel = el("select", {
    className: "compute-divisor",
    dataset: { cpDivisor: "1" },
    "aria-label": COMPUTE_TEXT.divisorLabel,
  }) as HTMLSelectElement;
  for (const d of COMPUTE_TEXT.divisors) {
    divSel.appendChild(el("option", { value: d.value }, d.label));
  }
  const divRow = el(
    "div",
    { className: "compute-divisor-row", dataset: { cpDivisorRow: "1" }, style: "display:none" },
    divSel,
  );

  const runBtn = el(
    "button",
    { type: "button", className: "compute-run", dataset: { cpRun: "1" } },
    COMPUTE_TEXT.computeButton,
  ) as HTMLButtonElement;

  /** 현재 종류의 숫자형 칸으로 셀렉트를 다시 채운다(종류·연산이 바뀔 때). */
  function refreshNumericColumns(): void {
    fieldSel.replaceChildren();
    for (const col of picker.getNumericColumns()) {
      fieldSel.appendChild(el("option", { value: col.key }, col.label));
    }
  }

  /** 연산에 따라 숫자칸 행(sum/avg)·분모 행(avg)을 보이거나 숨긴다. */
  function refreshRows(): void {
    const op = opSel.value;
    const showField = op === "sum" || op === "avg";
    fieldRow.style.display = showField ? "" : "none";
    divRow.style.display = op === "avg" ? "" : "none";
    if (showField) refreshNumericColumns();
  }

  opSel.addEventListener("change", refreshRows);
  // 종류가 바뀌면 숫자칸 셀렉트도 새 종류 칸으로 갱신한다(sum/avg 상태일 때만 실제로 보임).
  picker.onKindChange(() => refreshRows());

  runBtn.addEventListener("click", () => {
    const period = getPeriod();
    // /compute 라우트는 query 를 필수로 요구한다(빈 query 는 400). 검색어를 우선 쓰고, 없으면
    // 종류값을 query 로 보낸다(index.html runCompute 의 `검색어.trim() || 종류값.trim()` 정합).
    // 둘 다 비면 빈 query 로 400 을 받기 전에 멈추고 정직하게 안내한다(400 화면 회피).
    const query = getQueryText().trim() || picker.getKind().trim();
    if (!query) {
      onError("검색어나 종류를 입력해주세요");
      return;
    }
    const opts = buildComputePayloadOpts({
      op: opSel.value,
      concept: picker.getKind(),
      field: fieldSel.value,
      divisor: divSel.value,
      since: period.since,
      until: period.until,
    });
    // buildComputePayloadOpts 산출(kind=op·concept·field·avgDivisor·since·until)에 query 를
    // 더해 postCompute 로 넘긴다 — compute-api 의 buildComputeBody 가 query 를 body.query 로,
    // concept 를 filter:{종류} 로 감싼다(함정 A).
    void postCompute(apiBase, { ...opts, query })
      .then((data) => {
        onResult(buildComputeResultNodes(data, elForCompute));
      })
      .catch((err: unknown) => {
        onError(localizeComputeError(err instanceof Error ? err.message : String(err)));
      });
  });

  slot.replaceChildren(
    el("div", { className: "compute-widget" }, opSel, fieldRow, divRow, runBtn),
  );
  refreshRows();
}
