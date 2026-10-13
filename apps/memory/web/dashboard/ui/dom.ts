/** apps/memory/web/dashboard/ui/dom.ts — el() 단일 출처. */

/**
 * DOM 요소를 태그·속성·자식 목록으로 만든다.
 *
 * 처리 규칙:
 * - className  → node.className 직접 대입
 * - dataset    → node.dataset 에 Object.assign
 * - style      → setAttribute("style", 문자열값)
 * - on<Event>  → addEventListener (소문자 이벤트명)
 * - 그 외      → setAttribute (v 가 null 이면 생략)
 * - 자식       → Node 는 직접 append, 나머지는 TextNode 생성
 *               null/undefined 는 생략, 배열은 flat 처리
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: unknown[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "className") {
      node.className = String(v);
    } else if (k === "dataset") {
      Object.assign(node.dataset, v as Record<string, string>);
    } else if (k === "style") {
      node.setAttribute("style", String(v));
    } else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else {
      node.setAttribute(k, String(v));
    }
  }

  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}
