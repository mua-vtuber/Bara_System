/**
 * ingest-preview.test.ts — 떠 있는 미리보기 패널 DOM 검증(S7·결정 2).
 *
 * happy-dom 실제 DOM 으로 검증한다(compute-tab.dom.test.ts 양식·GlobalRegistrator + el).
 * 검증 축: input 이벤트마다 갱신 / 빈 입력 "인식된 태그 없음" / 못 알아든 값 "못 알아들음"
 * 정직 표시 / non-blocking(textarea 값·이벤트 안 건드림). CSS·시각 레이아웃은 happy-dom
 * 밖이라 라이브(S9) 몫 — 여기선 노드 존재·텍스트·data 표지만 본다. Mock 0(실제 DOM·실제 el).
 */
import { registerHappyDom } from "../../test-happy-dom.ts";
registerHappyDom();

import { test, expect, describe, afterEach } from "bun:test";
import { el } from "../../ui/dom.ts";
import {
  buildPreviewNodes,
  mountIngestPreview,
  PREVIEW_TEXT,
} from "./ingest-preview.js";
import { parseInputPreview } from "./parse-input-preview.js";

function panelFrom(text: string): HTMLElement {
  const panel = el("div");
  panel.replaceChildren(...buildPreviewNodes(parseInputPreview(text), el));
  return panel;
}

function valueOf(panel: HTMLElement, field: string): string | undefined {
  return panel
    .querySelector(`[data-preview-field="${field}"] .preview-value`)
    ?.textContent ?? undefined;
}

describe("buildPreviewNodes — 인식 결과 DOM 조립", () => {
  test("빈 입력 → '인식된 태그 없음' 한 줄(정직한 빈 상태)", () => {
    const panel = panelFrom("");
    expect(panel.querySelector(".preview-empty")?.textContent).toBe(PREVIEW_TEXT.empty);
    expect(panel.querySelectorAll(".preview-row").length).toBe(0);
  });

  test("종류·금액·날짜·본문 한 줄씩 표시", () => {
    const panel = panelFrom("#가계부:미용, #금액:28000원, #날짜:6월 28일, 투블럭");
    expect(valueOf(panel, "kind")).toBe("가계부");
    expect(valueOf(panel, "amount")).toBe("28000원");
    expect(valueOf(panel, "date")).toBe("6월 28일");
    expect(valueOf(panel, "body")).toBe("투블럭");
  });

  test("금액은 기본 행이 아니다 — `#금액:` 없으면 표시하지 않는다", () => {
    const panel = panelFrom("#소설:데뷔 못 하면 죽는 병 걸림, 재밌었다");
    expect(valueOf(panel, "kind")).toBe("소설");
    expect(valueOf(panel, "amount")).toBeUndefined();
  });

  test("빈 금액 태그는 시도한 값으로 보고 '못 알아들음'을 표시한다", () => {
    const panel = panelFrom("#가계부:미용, #금액:, 본문");
    expect(valueOf(panel, "amount")).toBe(PREVIEW_TEXT.unrecognized);
    const amountRow = panel.querySelector('[data-preview-field="amount"]');
    expect(amountRow?.getAttribute("data-unrecognized")).toBe("1");
  });

  test("분류 사슬 — '가계부 › 미용 › 머리' 한 줄", () => {
    const panel = panelFrom("#가계부:미용, #미용:머리, 컷트");
    expect(valueOf(panel, "chain")).toBe("미용 › 머리");
  });

  test("날짜 `~` 분할 → 'start ~ end' 표시", () => {
    const panel = panelFrom("#날짜:6월 28일 ~ 6월 30일");
    expect(valueOf(panel, "date")).toBe("6월 28일 ~ 6월 30일");
  });

  test("못 알아든 날짜 → '못 알아들음' + data-unrecognized 표지(가짜값 0)", () => {
    const panel = panelFrom("#가계부:미용, 본문");
    expect(valueOf(panel, "date")).toBe(PREVIEW_TEXT.unrecognized);
    const dateRow = panel.querySelector('[data-preview-field="date"]');
    expect(dateRow?.getAttribute("data-unrecognized")).toBe("1");
  });

  test("종류 못 알아듦(태그 없이 본문만) → 종류 '못 알아들음'·본문은 채움", () => {
    const panel = panelFrom("그냥 자유 메모");
    expect(valueOf(panel, "kind")).toBe(PREVIEW_TEXT.unrecognized);
    expect(valueOf(panel, "body")).toBe("그냥 자유 메모");
  });
});

describe("mountIngestPreview — input 이벤트마다 갱신·non-blocking", () => {
  let mounted: { refresh: () => void; dispose: () => void } | null = null;
  afterEach(() => { mounted?.dispose(); mounted = null; });

  function setup() {
    const inputEl = el("textarea") as HTMLTextAreaElement;
    const panelEl = el("div");
    mounted = mountIngestPreview({ inputEl, panelEl, el });
    return { inputEl, panelEl };
  }

  test("초기 빈 값 → '인식된 태그 없음'", () => {
    const { panelEl } = setup();
    expect(panelEl.querySelector(".preview-empty")?.textContent).toBe(PREVIEW_TEXT.empty);
  });

  test("input 이벤트로 값 넣으면 패널이 갱신된다", () => {
    const { inputEl, panelEl } = setup();
    inputEl.value = "#가계부:미용, 투블럭";
    inputEl.dispatchEvent(new Event("input"));
    expect(panelEl.querySelector('[data-preview-field="kind"] .preview-value')?.textContent).toBe("가계부");
    expect(panelEl.querySelector('[data-preview-field="body"] .preview-value')?.textContent).toBe("투블럭");
  });

  test("non-blocking — 패널은 textarea 값을 건드리지 않는다(타이핑 안 막음)", () => {
    const { inputEl } = setup();
    inputEl.value = "#소설:데뷔 못 하면 죽는 병 걸림";
    inputEl.dispatchEvent(new Event("input"));
    // 패널이 값을 잘라내거나 바꾸지 않았다 — 입력 그대로.
    expect(inputEl.value).toBe("#소설:데뷔 못 하면 죽는 병 걸림");
  });

  test("입력을 비우면 다시 '인식된 태그 없음' 으로 돌아온다", () => {
    const { inputEl, panelEl } = setup();
    inputEl.value = "#가계부:미용";
    inputEl.dispatchEvent(new Event("input"));
    inputEl.value = "";
    inputEl.dispatchEvent(new Event("input"));
    expect(panelEl.querySelector(".preview-empty")?.textContent).toBe(PREVIEW_TEXT.empty);
  });

  test("inputEl·panelEl·el 누락 시 식별자와 함께 throw(조용한 no-op 0)", () => {
    expect(() => {
      // @ts-expect-error 누락 테스트.
      mountIngestPreview({ inputEl: null, panelEl: el("div"), el });
    }).toThrow(/mountIngestPreview/);
  });
});
