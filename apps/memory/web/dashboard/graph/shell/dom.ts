/**
 * web/dashboard/graph/shell/dom.ts
 * 작은 DOM 조립 헬퍼 — el() 단일 함수.
 * web/index.html 인라인 el() 과 동등 양식, TypeScript 타입 추가.
 */

export function el(
  tag: string,
  props: Record<string, unknown> = {},
  ...children: Array<Node | string | null>
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "className") {
      node.className = String(v);
    } else if (k === "dataset") {
      Object.assign(node.dataset, v as Record<string, string>);
    } else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (v != null) {
      node.setAttribute(k, String(v));
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
