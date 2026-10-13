/**
 * wire-ingest-form.test.ts — 입력 미리보기 부가 배선 검증.
 *
 * "이 종류 칸" 칩은 별도 입력칸이 아니라 본문 `#칸:` 입력을 돕는 버튼이다.
 * happy-dom 실제 DOM + apiFetch 경로를 쓰고, fetch 응답만 fixture 로 둔다(Mock 객체 0).
 */
import { registerHappyDom } from "../../test-happy-dom.ts";
registerHappyDom();

import { afterEach, expect, test } from "bun:test";
import { _resetTokenCacheForTest } from "../../api-fetch.js";
import { el } from "../../ui/dom.ts";
import { wireIngestExtras } from "./wire-ingest-form.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  window.sessionStorage.removeItem("bara.dashboard.token");
  globalThis.fetch = realFetch;
  _resetTokenCacheForTest();
  document.body.replaceChildren();
});

function installFixtureFetch() {
  window.sessionStorage.setItem("bara.dashboard.token", "test-token");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/dashboard/sse-token")) {
      return new Response(JSON.stringify({ token: "test-token" }), { status: 200 });
    }
    if (url.includes("/api/entity-types")) {
      return new Response(
        JSON.stringify({
          entityTypes: [
            {
              typeName: "household_ledger",
              koName: "가계부",
              source: "user",
              columns: [
                { key: "금액", label: "금액", dataType: "number" },
                { key: "메모", label: "메모", dataType: "text" },
              ],
            },
            {
              typeName: "person",
              koName: "사람",
              source: "code",
              columns: [{ key: "생일", label: "생일", dataType: "date" }],
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/tag-suggest")) {
      return new Response(JSON.stringify({ tags: [] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function waitForFieldChip(previewEl: HTMLElement, key: string): Promise<HTMLElement> {
  for (let i = 0; i < 20; i += 1) {
    const chip = previewEl.querySelector<HTMLElement>(`[data-field-key="${key}"]`);
    if (chip) return chip;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`field chip not found: ${key}`);
}

function mount(value: string) {
  installFixtureFetch();
  const inputEl = el("textarea") as HTMLTextAreaElement;
  const inputWrapEl = el("div");
  const previewEl = el("div");
  inputEl.value = value;
  inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
  document.body.append(inputWrapEl, previewEl);
  const wired = wireIngestExtras({ inputEl, inputWrapEl, previewEl, apiBase: "", el });
  return { inputEl, previewEl, wired };
}

test("이 종류 칸 칩 클릭 → textarea 에 `#칸:` 을 삽입하고 caret 을 콜론 뒤에 둔다", async () => {
  const { inputEl, previewEl, wired } = mount("#가계부:미용");
  const chip = await waitForFieldChip(previewEl, "금액");

  chip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

  expect(inputEl.value).toBe("#가계부:미용 #금액:");
  expect(inputEl.selectionStart).toBe(inputEl.value.length);
  expect(inputEl.selectionEnd).toBe(inputEl.value.length);
  wired.preview.dispose();
});

test("칩 클릭은 caret 앞에서 치던 `#접두` 를 같은 칸 태그로 대체한다", async () => {
  const { inputEl, previewEl, wired } = mount("#가계부:미용 #금");
  const chip = await waitForFieldChip(previewEl, "금액");

  chip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

  expect(inputEl.value).toBe("#가계부:미용 #금액:");
  expect(inputEl.selectionStart).toBe(inputEl.value.length);
  wired.preview.dispose();
});

test("본문에 이미 있는 칸은 `이 종류 칸` 안에서 값과 함께 보여준다", async () => {
  const { previewEl, wired } = mount("#가계부:미용 #금액:23425원");

  const amount = await waitForFieldChip(previewEl, "금액");

  expect(amount.textContent).toBe("금액: 23425원");
  expect(amount.dataset.fieldPreview).toBe("1");
  expect(previewEl.querySelector('[data-field-key="메모"]')?.textContent).toBe("#메모:");
  expect(previewEl.querySelector('[data-preview-field="amount"] .preview-value')?.textContent).toBe("23425원");
  wired.preview.dispose();
});

test("사람 생일 입력값은 미리보기 칸에 `생일: 값`으로 보여준다", async () => {
  const { previewEl, wired } = mount("#사람:철수 #생일:2000년 1월 2일");

  const birthday = await waitForFieldChip(previewEl, "생일");

  expect(birthday.textContent).toBe("생일: 2000년 1월 2일");
  expect(birthday.dataset.fieldPreview).toBe("1");
  wired.preview.dispose();
});

test("값을 치기 전 `#사람:` 상태에서도 사람 칸 `#생일:`을 보여준다", async () => {
  const { previewEl, wired } = mount("#사람:");

  const chip = await waitForFieldChip(previewEl, "생일");

  expect(chip.textContent).toBe("#생일:");
  wired.preview.dispose();
});

test("정확히 `#사람`을 치는 중에도 사람 칸 `#생일:`을 보여준다", async () => {
  const { previewEl, wired } = mount("#사람");

  const chip = await waitForFieldChip(previewEl, "생일");

  expect(chip.textContent).toBe("#생일:");
  wired.preview.dispose();
});
