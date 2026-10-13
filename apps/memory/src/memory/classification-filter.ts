/**
 * classification-filter.ts — Phase 11b T6
 *
 * 검색 라우트가 받은 URL query string 안 `?filter.<카테고리>=<값>` 양식을
 * 파싱해서, 옛 `body.filter` (Record<string, string>) 양식과 합쳐서 retriever
 * 가 옛부터 받아온 `filter` 칸으로 흘려보낸다. retriever 안 학술 분류 축소
 * 로직(옛 1.1c T4/T5 에서 retriever.ts 라인 217 `filter?: Record<string,
 * string>` + 라인 494~502 `Object.values(filter)` 순회 양식으로 이미 정착)
 * 자체는 한 글자도 안 건드린다.
 *
 * 동작 둘:
 *  - parseClassificationFiltersFromSearchParams: URLSearchParams 안 'filter.'
 *    접두 키만 골라서 `{ category, value }` 항목 배열로 변환. 옛 키(q / limit
 *    / topK / project / polarity 등)는 RESERVED_QUERY_KEYS 로 자연 제외.
 *  - mergeFilters: body 양식과 URL 양식을 한 Record 로 합친다. 같은 카테고리
 *    가 두 번 이상 들어오면 (예: `filter.character=A&filter.character=B`),
 *    키 충돌 회피를 위해 두 번째부터 `${카테고리}__${index}` 접미를 붙여서
 *    별 키로 보관 — retriever 가 키가 아니라 값만 순회하는 양식이라 결과는
 *    모든 값이 passSets 에 추가되어 AND 교집합으로 적용된다.
 *
 * 회귀 0 불변식:
 *  - rrf.ts / search-tuning.ts / retriever.ts 한 글자도 안 건드림.
 *  - 옛 body.filter 통로는 그대로 가동 — 본 모듈은 URL 양식 통로를 *추가*
 *    하기만 한다.
 */

/** 학술 분류 filter 한 항목(category=값). */
export interface ClassificationFilter {
  category: string;
  value: string;
}

/** URL searchParams 파싱 시 자연 제외하는 옛 키 묶음. */
const RESERVED_QUERY_KEYS = new Set([
  "q",
  "query",
  "limit",
  "topK",
  "top_k",
  "mode",
  "project",
  "polarity",
  "contextBudget",
  "context_budget",
]);

/**
 * URLSearchParams 안 `filter.<category>=<값>` 양식을 파싱해서 항목 배열로
 * 회신.
 *
 * 흐름:
 *  1. 키를 하나씩 보면서 RESERVED_QUERY_KEYS 에 든 옛 키는 건너뛴다.
 *  2. 'filter.' 접두가 없는 키도 건너뛴다.
 *  3. 'filter.' 접두를 잘라낸 뒤 남은 부분을 category 로 본다. 비었으면
 *     건너뛴다.
 *  4. 값은 trim 후 1자 이상일 때만 채택. 빈 값과 공백 한 가지 값은 무시.
 *  5. `filter.character=A&filter.character=B` 같이 같은 키가 두 번 들어오면
 *     URLSearchParams 가 두 항목으로 자연 순회하므로 별도 처리 없이 두 항목
 *     이 그대로 배열에 들어간다.
 */
export function parseClassificationFiltersFromSearchParams(
  searchParams: URLSearchParams,
): ClassificationFilter[] {
  const out: ClassificationFilter[] = [];
  for (const [key, value] of searchParams) {
    if (RESERVED_QUERY_KEYS.has(key)) continue;
    if (!key.startsWith("filter.")) continue;
    const category = key.slice("filter.".length);
    if (category.length === 0) continue;
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length === 0) continue;
    out.push({ category, value: trimmed });
  }
  return out;
}

/**
 * ClassificationFilter[] 를 retriever 가 옛부터 받아오는 `Record<string,
 * string>` 양식으로 변환.
 *
 * retriever step 4.5 (c) 는 `Object.values(filter)` 만 순회해서 값 하나하나
 * 를 passSet 에 추가한다 — 즉 *키는 무관*, 모든 값이 등장하면 결과 동일.
 *
 * 따라서 같은 category 가 여러 값으로 들어와도 키 충돌만 피하면 결과가
 * 보존된다. 두 번째부터 `${category}__${index}` 접미를 붙여서 별 키로
 * 보관하는 양식이 그 회피.
 *
 * 빈 배열 = undefined 반환 → retriever 가 "필터 미적용" 으로 자연 분기.
 */
export function toRetrieverFilter(
  filters: ClassificationFilter[],
): Record<string, string> | undefined {
  if (filters.length === 0) return undefined;
  const out: Record<string, string> = {};
  const seenCategoryCount = new Map<string, number>();
  for (const f of filters) {
    const count = seenCategoryCount.get(f.category) ?? 0;
    // 첫 등장 = 카테고리 이름 그대로 키 사용 / 두 번째 이상 = `${category}__${index}`
    // 접미로 별 키 한 가지로 보관. retriever 가 키가 아니라 값만 순회하기
    // 때문에 결과는 동일하다.
    const key = count === 0 ? f.category : `${f.category}__${count}`;
    out[key] = f.value;
    seenCategoryCount.set(f.category, count + 1);
  }
  return out;
}

/**
 * 옛 body.filter (Record<string, string>) 와 URL 양식 (ClassificationFilter[])
 * 을 한 Record 로 합쳐서 retriever 에 흘려보낸다.
 *
 * 흐름:
 *  1. body.filter 의 entries 를 base 로 깐다 — 옛 양식 그대로 보존.
 *  2. URL filters 항목을 하나씩 덧붙인다 — toRetrieverFilter 와 같은 양식으로
 *     키 충돌 회피.
 *
 * 둘 다 비어 있으면 undefined 반환.
 */
export function mergeFilters(
  bodyFilter: Record<string, string> | undefined,
  urlFilters: ClassificationFilter[],
): Record<string, string> | undefined {
  const bodyEntries: ClassificationFilter[] = bodyFilter
    ? Object.entries(bodyFilter).map(([category, value]) => ({ category, value }))
    : [];
  const combined = [...bodyEntries, ...urlFilters];
  return toRetrieverFilter(combined);
}
