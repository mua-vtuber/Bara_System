/**
 * web/dashboard/ui/dom.test.ts
 * el() 헬퍼 단위 테스트 — happy-dom 실제 DOM 구현 사용.
 */
import { registerHappyDom } from "../test-happy-dom.ts";
registerHappyDom();

import { test, expect } from "bun:test";
import { el } from "./dom.ts";

// ──────────────────────────────────────────────
// 1. className 적용 + 자식 텍스트
// ──────────────────────────────────────────────
test("className 과 텍스트 자식을 적용한다", () => {
  const node = el("div", { className: "card" }, "안녕");
  expect(node.className).toBe("card");
  expect(node.textContent).toBe("안녕");
});

// ──────────────────────────────────────────────
// 2. dataset 적용 + null 자식 생략
// ──────────────────────────────────────────────
test("dataset 을 적용하고 null 자식은 생략한다", () => {
  const node = el("span", { dataset: { id: "42", kind: "memory" } }, null, "텍스트", null);
  expect(node.dataset["id"]).toBe("42");
  expect(node.dataset["kind"]).toBe("memory");
  expect(node.textContent).toBe("텍스트");
  expect(node.childNodes.length).toBe(1);
});

// ──────────────────────────────────────────────
// 3. on<Event> 이벤트 바인딩
// ──────────────────────────────────────────────
test("onClick 이벤트 핸들러를 등록하고 dispatchEvent 로 호출된다", () => {
  let called = false;
  const btn = el("button", { onClick: () => { called = true; } });
  btn.dispatchEvent(new Event("click"));
  expect(called).toBe(true);
});

test("onMouseenter 이벤트도 소문자 변환 후 등록된다", () => {
  let count = 0;
  const div = el("div", { onMouseenter: () => { count++; } });
  div.dispatchEvent(new Event("mouseenter"));
  expect(count).toBe(1);
});

// ──────────────────────────────────────────────
// 4. 중첩 배열 자식 flat 처리
// ──────────────────────────────────────────────
test("중첩 배열 자식을 flat 하게 추가한다", () => {
  const items = ["사과", "배", "딸기"];
  const ul = el("ul", {}, ...items.map((t) => el("li", {}, t)));
  expect(ul.children.length).toBe(3);
  expect(ul.children[1]!.textContent).toBe("배");
});

test("배열을 직접 자식으로 전달해도 flat 처리한다", () => {
  const children = [el("span", {}, "A"), el("span", {}, "B")];
  // unknown[] 로 받으므로 배열 하나를 단일 자식 인수로 전달
  const div = el("div", {}, children);
  expect(div.children.length).toBe(2);
});

// ──────────────────────────────────────────────
// 5. 일반 속성 적용
// ──────────────────────────────────────────────
test("일반 속성(href, id)을 setAttribute 로 적용한다", () => {
  const a = el("a", { href: "/path", id: "link1" });
  expect(a.getAttribute("href")).toBe("/path");
  expect(a.getAttribute("id")).toBe("link1");
});

// ──────────────────────────────────────────────
// 6. null 값 속성은 무시
// ──────────────────────────────────────────────
test("null 값 속성은 setAttribute 하지 않는다", () => {
  const div = el("div", { title: null });
  expect(div.hasAttribute("title")).toBe(false);
});

// ──────────────────────────────────────────────
// 7. style 문자열 적용 (기존 graph/shell/dom.ts 케이스 포함)
// ──────────────────────────────────────────────
test("style 문자열을 setAttribute 로 적용한다", () => {
  const div = el("div", { style: "color:red;font-size:14px" });
  expect(div.getAttribute("style")).toBe("color:red;font-size:14px");
});

// ──────────────────────────────────────────────
// 8. Node 자식 직접 추가
// ──────────────────────────────────────────────
test("Node 자식은 textContent 없이 직접 append 된다", () => {
  const inner = el("strong", {}, "굵게");
  const outer = el("p", {}, inner);
  expect(outer.querySelector("strong")).not.toBeNull();
  expect(outer.querySelector("strong")!.textContent).toBe("굵게");
});

// ──────────────────────────────────────────────
// 9. 반환 타입 태그 정합
// ──────────────────────────────────────────────
test("반환 타입이 태그에 맞는 HTMLElement 서브타입이다", () => {
  const btn = el("button", {});
  // instanceof 로 정확한 타입 확인
  expect(btn instanceof HTMLButtonElement).toBe(true);
});
