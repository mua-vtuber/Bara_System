/**
 * ingest-preview.js — 떠 있는 입력 미리보기 패널(클라이언트·S7·결정 2).
 *
 * 입력창 *위에* 떠 타이핑마다 "이렇게 이해했어요"를 실시간으로 보여 주는 패널이다.
 * 종류 / 분류 사슬 / 날짜 / 장소 / 본문을 `parse-input-preview.js` 산출 그대로 비춘다.
 * 금액은 전체 입력의 기본 항목이 아니라 `#금액:` 태그를 쓴 경우에만 행을 더한다.
 * 못 알아든 값은 "못 알아들음" 으로 정직하게 표시한다 — null 을 빈칸·가짜값으로 위장하지
 * 않는다(No-fallback). 빈 입력이면 "인식된 태그 없음" 으로 정직한 빈 상태를 보인다.
 *
 * non-blocking: 입력 textarea 의 `input` 이벤트를 *듣기만* 한다 — `preventDefault` 도
 * `stopPropagation` 도 안 걸고, textarea 값을 건드리지 않는다. 패널은 그리기만 하고 타이핑을
 * 막지 않는다. 화면 위 띄움(position:absolute)·시각 디테일은 forms.css + 라이브 단계(S9)
 * 몫이라 여기선 클래스만 단다(happy-dom 은 CSS 레이아웃을 검증하지 않음).
 *
 * el 주입: 빌드 도구 없이 브라우저가 읽는 ES 모듈이라 코어 `ui/dom.ts` 를 직접 import 하지
 * 않고, 호출처가 `el` 헬퍼를 넘긴다(compute-tab.js buildComputeResultNodes 선례). 테스트는
 * 실제 `el` 과 happy-dom DOM 으로 검증한다(Mock 0).
 *
 * LLM 호출 0·now/DB 의존 0 — 순수 변환(parseInputPreview) + DOM 렌더.
 */

import { parseInputPreview } from "./parse-input-preview.js";

/** 패널 문구 단일 출처 — plain 한국어(비개발자 이해·LABELS 중앙화 양식). */
export const PREVIEW_TEXT = {
  empty: "인식된 태그 없음",
  unrecognized: "못 알아들음",
  labels: {
    kind: "종류",
    chain: "분류",
    date: "날짜",
    place: "장소",
    amount: "금액",
    body: "본문",
  },
};

/**
 * 날짜 인식 결과를 표시 문자열로. 못 알아들었으면 "못 알아들음".
 * @param {{ start: string, end: string | null } | null} date
 * @returns {string}
 */
function formatDate(date) {
  if (!date || !date.start) return PREVIEW_TEXT.unrecognized;
  return date.end ? `${date.start} ~ ${date.end}` : date.start;
}

/**
 * 분류 사슬을 "가계부 › 미용 › 머리" 한 줄로. 빈 사슬이면 "못 알아들음".
 * @param {Array<{ category: string, value: string }>} chain
 * @returns {string}
 */
function formatChain(chain) {
  if (!chain || chain.length === 0) return PREVIEW_TEXT.unrecognized;
  return chain.map((c) => c.value).join(" › ");
}

/**
 * 한 인식 결과를 패널 DOM 노드 배열로 조립한다(순수 — 부수효과 0).
 *
 * 빈 입력(태그 0·본문 빈)이면 빈 안내 한 줄. 그 밖이면 기본 항목마다 한 줄
 * (라벨 + 값/"못 알아들음"). 금액은 `#금액:` 태그가 있을 때만 표시한다.
 * null 항목은 "못 알아들음" 으로 정직 표시.
 *
 * @param {ReturnType<typeof parseInputPreview>} parsed  parseInputPreview 산출.
 * @param {typeof import("../../ui/dom.ts").el} el       DOM 헬퍼(주입).
 * @returns {HTMLElement[]}  패널 자식 노드 배열.
 */
export function buildPreviewNodes(parsed, el) {
  const L = PREVIEW_TEXT.labels;
  const hasAnyTag =
    parsed.kind !== null ||
    parsed.date !== null ||
    parsed.place !== null ||
    parsed.hasAmountTag === true ||
    parsed.amount !== null ||
    parsed.chain.length > 0;

  if (!hasAnyTag && parsed.body.length === 0) {
    return [el("div", { className: "preview-empty" }, PREVIEW_TEXT.empty)];
  }

  const rows = [];
  rows.push(row(el, "kind", L.kind, parsed.kind ?? PREVIEW_TEXT.unrecognized));
  rows.push(row(el, "chain", L.chain, formatChain(parsed.chain)));
  rows.push(row(el, "date", L.date, formatDate(parsed.date)));
  rows.push(row(el, "place", L.place, parsed.place ?? PREVIEW_TEXT.unrecognized));
  if (parsed.hasAmountTag === true || parsed.amount !== null) {
    rows.push(row(el, "amount", L.amount, parsed.amount ?? PREVIEW_TEXT.unrecognized));
  }
  rows.push(row(el, "body", L.body, parsed.body.length > 0 ? parsed.body : PREVIEW_TEXT.unrecognized));
  return rows;
}

/**
 * 한 줄(라벨 + 값) 노드. 값이 "못 알아들음" 이면 data-unrecognized 표지를 단다
 * (시각 강조는 CSS·S9 몫). textContent 만 써 XSS 안전.
 */
function row(el, fieldKey, label, value) {
  const unresolved = value === PREVIEW_TEXT.unrecognized;
  return el(
    "div",
    {
      className: "preview-row",
      dataset: { previewField: fieldKey, ...(unresolved ? { unrecognized: "1" } : {}) },
    },
    el("span", { className: "preview-label" }, label),
    el("span", { className: "preview-value" }, value),
  );
}

/**
 * 입력 textarea 에 미리보기 패널을 붙인다(결정 2).
 *
 * `input` 이벤트마다 parseInputPreview 를 돌려 패널을 다시 그린다. 첫 호출에서 현재 값을
 * 한 번 그려 초기 상태를 맞춘다. 듣기만 하고 textarea 를 건드리지 않는다(non-blocking).
 *
 * @param {object} ctx
 * @param {HTMLTextAreaElement} ctx.inputEl  입력 textarea.
 * @param {HTMLElement} ctx.panelEl          패널 컨테이너(이 함수가 내용물을 채운다).
 * @param {typeof import("../../ui/dom.ts").el} ctx.el  DOM 헬퍼(주입).
 * @param {(parsed: ReturnType<typeof parseInputPreview>) => void} [ctx.onParsed]
 *   갱신마다 인식 결과를 호출부에 알리는 콜백(S8 칸 자동 표시 배선용·optional). 종류
 *   인식(parsed.kind)에 따라 호출부가 entity-types columns 를 그 옆에 그린다(결정 6). 미입력
 *   기본 동작에는 영향 0 — 콜백이 없으면 옛 동작과 byte 동일(패널만 그린다).
 * @returns {{ refresh: () => void, dispose: () => void }}
 *          refresh=수동 갱신(S8 배선용). dispose=리스너 해제.
 */
export function mountIngestPreview(ctx) {
  const { inputEl, panelEl, el, onParsed } = ctx;
  if (!inputEl || !panelEl || typeof el !== "function") {
    throw new Error(
      `mountIngestPreview: inputEl·panelEl·el 누락 (inputEl=${!!inputEl}, panelEl=${!!panelEl}, el=${typeof el})`,
    );
  }

  const refresh = () => {
    const parsed = parseInputPreview(typeof inputEl.value === "string" ? inputEl.value : "");
    panelEl.replaceChildren(...buildPreviewNodes(parsed, el));
    if (typeof onParsed === "function") onParsed(parsed);
  };

  inputEl.addEventListener("input", refresh);
  refresh();

  return {
    refresh,
    dispose: () => inputEl.removeEventListener("input", refresh),
  };
}
