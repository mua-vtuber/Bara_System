/**
 * apps/memory/web/dashboard/ui/memory-number.ts
 *
 * 기억 번호(knowledge_nodes.id) 표시 조각. 정리 제안의 "기억 #87" 과 같은 번호다.
 * 목록·카드·상세가 한 모양(#87)으로 같은 번호를 보여 주도록 단일 출처로 둔다.
 * 색은 토큰만(.memory-no — components.css), 인라인 색 0.
 */

import { el } from "./dom.ts";

/** 그래프 글 노드 키 "node:87" 에서 번호를 뽑는다. 사람·개념 등 다른 키는 undefined. */
export function memoryNumberFromNodeKey(key: string | undefined): number | undefined {
  if (key == null) return undefined;
  const m = /^node:([1-9][0-9]*)$/.exec(key);
  if (!m) return undefined;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}

/** 검색창에 정확히 "#87" 만 입력했을 때 그 번호를 돌려준다. 그 외 입력은 null. */
export function parseMemoryNumberQuery(query: string): number | null {
  const m = /^#([1-9][0-9]*)$/.exec(query.trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) ? id : null;
}

export function memoryNumberText(id: number): string {
  return `#${id}`;
}

/** 작고 흐린 "#87" 조각. 스크린리더에는 "기억 번호 87" 로 읽힌다. */
export function memoryNumberChip(id: number): HTMLElement {
  return el(
    "span",
    {
      className: "memory-no",
      title: `기억 번호 ${id}`,
      "aria-label": `기억 번호 ${id}`,
      dataset: { memoryNo: String(id) },
    },
    memoryNumberText(id),
  );
}
