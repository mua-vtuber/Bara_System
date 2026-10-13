/**
 * kinship-synonyms.ts — 친족 호칭 기본 동의어 사전 (spec 2026-06-14 D9).
 *
 * 같은 사람을 다른 호칭으로 부르는 흔한 친족어를 표준형으로 모은다(어머니·모친 →
 * 엄마). 소유자(나) 기준 1인칭 호칭이라 "가족" 분류 안에서 같은 한 사람으로 모으는
 * 데 쓴다. 사전에 없는 호칭은 사용자가 #별명: 으로 확장한다(두 통로).
 */

/** 동의어 그룹 — 각 그룹의 첫 원소가 표준형. 외부 fork 가 그룹을 늘릴 수 있다. */
const KINSHIP_GROUPS: readonly (readonly string[])[] = [
  ["엄마", "어머니", "모친"],
  ["아빠", "아버지", "부친"],
  ["할머니", "조모"],
  ["할아버지", "조부"],
];

const TO_CANONICAL: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const group of KINSHIP_GROUPS) {
    const canonical = group[0]!;
    for (const term of group) m.set(term, canonical);
  }
  return m;
})();

/** 친족 호칭을 표준형으로 정규화. 사전에 없으면 입력 그대로(false 합침 0). */
export function canonicalKinship(word: string): string {
  const key = (word ?? "").trim();
  return TO_CANONICAL.get(key) ?? key;
}
