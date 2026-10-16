import { afterEach, beforeEach, expect, test } from "bun:test";
import { registerHappyDom } from "../test-happy-dom.ts";
import { _resetTokenCacheForTest } from "../api-fetch.ts";
import { renderArchiveItem } from "./archive-item.ts";

registerHappyDom();

beforeEach(() => {
  document.body.replaceChildren();
  window.sessionStorage.removeItem("bara.dashboard.token");
  _resetTokenCacheForTest();
});
afterEach(() => document.body.replaceChildren());

test("복구 전에 긴 기억의 마지막 문장까지 확인할 수 있다", () => {
  const content = "긴 기억입니다. ".repeat(30) + "마지막 확인 문장";
  const row = renderArchiveItem({ id: 1, content, archivedAt: "2026-09-22 10:00:00" }, async () => {});
  expect(row.querySelector(".archive-item-content")?.textContent).toBe(content);
  expect(row.textContent).toContain("휴지통 이동: 2026-09-22 10:00:00");
});

test("기억에 포함된 HTML은 실행 가능한 요소가 되지 않는다", () => {
  const content = '<img src=x onerror="alert(1)">';
  const row = renderArchiveItem({ id: 2, content }, async () => {});
  expect(row.querySelector("img")).toBeNull();
  expect(row.textContent).toContain(content);
});

test("응답을 확인할 수 없으면 재복구 대신 상태 확인을 제공한다", async () => {
  const row = renderArchiveItem({ id: 3, content: "확인할 기억" }, async () => {});
  document.body.append(row);
  const button = row.querySelector("button")!;
  button.click();
  expect(button.disabled).toBe(true);
  expect(row.getAttribute("aria-busy")).toBe("true");
  expect(row.querySelector('[role="status"]')?.textContent).toContain("복구 중");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(button.disabled).toBe(true);
  const check = row.querySelectorAll("button")[1]!;
  expect(check.hidden).toBe(false);
  expect(check.textContent).toBe("복구 결과 확인");
  expect(row.querySelector('[role="status"]')?.textContent).toContain("복구 결과를 확인하지 못했습니다");
  expect(row.getAttribute("aria-busy")).toBe("false");
  check.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(button.disabled).toBe(true);
  expect(check.disabled).toBe(false);
});

test("휴지통 항목에도 정리 제안과 같은 기억 번호가 보인다", () => {
  const row = renderArchiveItem({ id: 87, content: "번호 확인" }, async () => {});
  expect(row.querySelector(".memory-no")?.textContent).toBe("#87");
});
