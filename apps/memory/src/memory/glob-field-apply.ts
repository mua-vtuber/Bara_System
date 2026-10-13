/**
 * glob-field-apply.ts — 종류별 동적 폼 글-칸 추출·저장 (단계6 단일 출처).
 *
 * T1a 가 KIND_CATEGORY 상수를, T3b 가 칸 추출(collectGlobFields)·저장(applyGlobFields)을
 * 더한다. 폼 fields(동적 칸 위젯)와 본문 `#키:값` 해시태그가 한 추출기로 수렴해(spec §5),
 * 어느 통로로 적든 같은 글-칸이 나온다. 칸 권위 = 그 종류의 columns(allowedKeys) — 정의
 * 밖 키는 글-칸이 아니라 일반 라벨 통로로 떨어진다(spec §4.4).
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import { parseClassificationTags } from "./parsers/classification-tag.ts";

/** node_concept_edges(role='classification') 위계에서 종류를 찾을 때 쓰는 카테고리 이름. */
export const KIND_CATEGORY = "종류";

/**
 * 폼 fields 와 본문 `#키:값` 해시태그를 한 글-칸 맵으로 수렴시킨다(spec §5).
 *
 * 칸 키 권위 = allowedKeys(그 종류의 columns). allowedKeys 에 없는 키는 글-칸으로
 * 안 들어간다 — 일반 라벨 통로(wireEntityPlacement)가 따로 처리할 몫이다(spec §4.4).
 * 해시태그는 rawCategory(정규화 전 원본 칸 키)로 매칭한다 — 칸 키는 사용자 종류 어휘
 * 그대로라 동의어 정규화(작품→series)를 거치면 안 된다.
 *
 * 두 통로가 같은 키를 주면 폼 값이 이긴다(직접 위젯 입력 우선) — 폼을 해시태그 뒤에
 * 합쳐 같은 키를 덮어쓴다. 빈/공백 값은 칸으로 안 들어간다(정직한 미입력).
 *
 * @param formFields  폼 동적 칸 위젯이 보낸 {칸키: 값} (미전달이면 해시태그만).
 * @param content     글 본문 — `#키:값` 해시태그를 다시 파싱한다.
 * @param allowedKeys 이 종류의 칸 키 집합(columns ∪ columnLabels 키).
 */
export function collectGlobFields(
  formFields: Record<string, string> | undefined,
  content: string,
  allowedKeys: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  // 본문 `#키:값` — rawCategory(원본 칸 키)로 allowedKeys 매칭.
  for (const tag of parseClassificationTags(content ?? "")) {
    const key = tag.rawCategory.trim();
    const value = tag.value.trim();
    if (key && value && allowedKeys.has(key)) out[key] = value;
  }
  // 폼 fields 를 뒤에 합쳐 같은 키면 폼 값이 이긴다(직접 위젯 우선).
  if (formFields) {
    for (const [k, v] of Object.entries(formFields)) {
      const key = k.trim();
      const value = typeof v === "string" ? v.trim() : "";
      if (key && value && allowedKeys.has(key)) out[key] = value;
    }
  }
  return out;
}

/**
 * 수렴된 글-칸 맵을 한 노드에 출처=직접(direct)으로 저장한다. canWriteField 가드를
 * 거쳐(store.setGlobField), 더 높은 출처가 이미 채운 칸은 못 덮으면 그 칸을 사유와 함께
 * warnings 에 남긴다 — silent skip 금지(CLAUDE.md "실패 ≠ 빈 결과" 정신). 적용 수(applied)와
 * 거부 사유(warnings)를 돌려 호출처가 정직한 결과를 회신하게 한다.
 */
export async function applyGlobFields(
  store: SqliteMemoryStore,
  nodeId: number,
  fields: Record<string, string>,
): Promise<{ applied: number; warnings: string[] }> {
  let applied = 0;
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const wrote = await store.setGlobField(nodeId, key, value, "direct");
    if (wrote) applied += 1;
    else warnings.push(`글-칸 '${key}' 쓰기 거부(더 높은 출처가 이미 채움)`);
  }
  return { applied, warnings };
}
