// 묶음 펼침 토글 순수 로직 — WebGL 비의존이라 graph-controller 와 graph-interaction 이 공유하고
// graph-controller.test.ts 가 직접 검증한다. 컨트롤러에서 분리해 import 순환을 피한다.

/** 묶음 펼침 집합을 in-place 토글한다(있으면 빼고 없으면 더한다). 순수 로직·WebGL 비의존. */
export function toggleGroupExpansion(set: Set<string>, groupType: string): void {
  if (set.has(groupType)) set.delete(groupType);
  else set.add(groupType);
}
