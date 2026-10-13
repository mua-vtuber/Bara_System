/**
 * retrieve-visibility-pushdown — 벡터·FTS 채널에 가시성·필터 제한을 공급하는 세 갈래.
 *
 * retriever.ts 에서 옮겨 왔다(통과 집합 계산 computeVectorPassSet · FTS 보충 공급). 갈래는
 * 결과를 바꾸지 않고 비용만 바꾼다 — 어느 갈래든 "허용 노드 중 거리·BM25 상위" 를 돌려준다.
 *
 *   - unfiltered : 필터도 가시성 제외도 없다. 현행 전역 KNN(ORDER BY distance LIMIT k)·FTS 를
 *                  글자 그대로 돌린다(추가 조회 0).
 *   - exclusion  : scope 없음 + 다른 필터 없음 + 제외 노드가 있고, 여유분(제외 노드 수 +
 *                  pending_review 노드 수) + vectorK <= VEC0_MAX_K 일 때. 전역 KNN 을
 *                  k = vectorK + 여유분으로 한 번만 돌리고 제외 노드·pending_review 를 버린 뒤
 *                  vectorK 로 자른다. 상위 k 개 안의 비허용 노드는 여유분을 넘지 못하므로
 *                  허용 노드 상위 vectorK 가 반드시 그 안에 있다 = pass-set 경로와 같은 결과.
 *                  여유분 밖 행(노드 없는 벡터 행 등)이 창을 채워 증명이 서지 않는 드문
 *                  경우에만 pass-set 경로로 다시 순위화한다.
 *   - passSet    : 그 밖(scope 검색·다른 필터·큰 제외 집합). 통과 집합을 미리 계산해
 *                  searchByVectorRaw 가 VEC0_MAX_K 조각으로 나눠 순위화한다(T4 재판정 계약).
 *
 * 왜 exclusion 갈래가 필요한가(SL-8): 운영 DB 는 disputed·retracted 노드가 늘 있어 가시성
 * 제외가 1개라도 생기면 통과 집합이 "거의 전체" 가 되고, 벡터 KNN 이 ceil(N/4096) 조각으로
 * 쪼개진다(3만 노드 8조각 194.7 ms 대 필터 없는 KNN 41.3 ms). 제외 집합이 작으면 전역 KNN
 * 1회로 같은 결과를 얻는다.
 *
 * pending_review 판정: 통과 집합 경로의 selectNodeIdsNotPendingReview 와 같은 SQL 술어
 * (filterOutPendingReview)로 후보만 다시 확인한다. 스냅샷의 pending_review 목록은 여유분
 * 크기를 정하는 데만 쓴다 — 두 판정이 어긋나도 결과는 SQL 쪽을 따르고, 어긋남은 되돌이
 * 비용으로만 드러난다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import type { FtsHit, VectorHit } from "../db/store-internal/args-types.ts";
import { VEC0_MAX_K } from "../db/store-internal/search-repo-vec-fts.ts";
import type { RetrieveOptions } from "./retrieve-config.ts";
import type { MemoryVisibilitySnapshot, MemoryVisibilityView } from "./shared-memory-read.ts";

/** 벡터·FTS 채널 공급 방식. 세 갈래의 결과는 같고 비용만 다르다(모듈 헤더). */
export type VisibleSupply =
  | { readonly mode: "unfiltered" }
  | { readonly mode: "passSet"; readonly ids: readonly number[] }
  | {
      readonly mode: "exclusion";
      readonly view: MemoryVisibilityView;
      readonly allowedIds: ReadonlySet<number>;
      readonly knnK: number;
    };

/**
 * 학술 분류 filter(options.filter)가 실제로 지정됐는지 — 빈 객체는 미지정으로 본다.
 * step 4.5 (c) 갈래와 pushdown 통과 집합 계산이 같은 판정을 써야 하므로 단일 출처로 둔다.
 */
export function hasClassificationFilter(options: RetrieveOptions): boolean {
  return (
    options.filter !== undefined && Object.keys(options.filter).length > 0
  );
}

/** 가시성 밖의 후보 축소 필터(step 4.5 (b)~(g) 축)가 하나라도 걸렸는지. */
function hasCandidateFilter(options: RetrieveOptions): boolean {
  return (
    hasClassificationFilter(options) ||
    (options.kind !== undefined && options.kind.trim().length > 0) ||
    (options.fieldFilters !== undefined && options.fieldFilters.length > 0) ||
    options.polarity !== undefined ||
    options.dateRange !== undefined ||
    options.memoryType !== undefined
  );
}

/**
 * 벡터 채널에 공급할 통과 집합을 계산한다(T4 통과 집합 적응형 공급 / 재판정 계약).
 *
 * 회신 규약 — 세 상태를 구분한다:
 *   - `undefined` : 적응형 공급 미적용 — 필터 미지정(현행 경로 그대로 / 회귀 0).
 *                   (B) 재정(2026-08-03) 이후 크기로 사후 필터 갈래로 내려가는
 *                   경로는 없다 — 통과 집합이 아무리 커도 그대로 반환한다
 *                   (searchByVectorRaw 가 VEC0_MAX_K 조각으로 나눠 처리).
 *   - `[]`        : 필터는 걸렸으나 통과 0건 → 벡터 채널이 정직하게 빈 결과가 된다
 *                   (KNN 자체를 생략 — 필터 무시가 아니다).
 *   - `number[]`  : 그 id 집합 안에서 순위화.
 *
 * 여러 필터의 AND 는 JS 교집합으로 접는다 — sqlite-vec 은 질의당 `node_id IN` 을
 * 하나만 허용하므로 SQL 로 여러 번 AND 할 수 없다. 이는 step 4.5 의
 * `passSets.every(...)` 와 같은 의미다(모든 통과 Set 을 만족하는 id).
 *
 * **여기 나열된 축은 step 4.5 의 통과 Set 축과 정확히 일치해야 한다.** 한 축이라도
 * 빠지면 벡터 채널이 필터에 걸릴 글까지 통과 집합에 담아 k 칸을 낭비하고(정확성은
 * 사후 필터가 지키지만 회수가 준다), 반대로 여기만 있는 축이 생기면 벡터 채널이
 * 다른 채널보다 더 좁게 걸러져 채널 간 후보가 어긋난다. 축 추가 시 양쪽을 함께 고칠 것.
 *
 * pending_review 제외를 항상 포함하는 이유: step 4.5 (a) 가 이 필터를 *무조건*
 * 적용하므로, 통과 집합에서 빼지 않으면 KNN 이 검토 대기 글로 k 칸을 채우고 그것이
 * 사후에 제거돼 결과가 실제보다 얇아진다. 단 이 조회는 *다른 필터가 하나라도 있을
 * 때만* 돈다 — 필터 없는 검색은 아래 첫 줄에서 즉시 빠져나가 비용이 0 이다.
 *
 * 가시성 제한(visibleIds)이 주어지면 그 자체가 필터라 항상 배열을 돌려준다(첫 overload).
 */
export function computeVectorPassSet(
  store: SqliteMemoryStore,
  options: RetrieveOptions,
  visibleIds: ReadonlySet<number>,
): number[];
export function computeVectorPassSet(
  store: SqliteMemoryStore,
  options: RetrieveOptions,
  visibleIds?: ReadonlySet<number>,
): number[] | undefined;
export function computeVectorPassSet(
  store: SqliteMemoryStore,
  options: RetrieveOptions,
  visibleIds?: ReadonlySet<number>,
): number[] | undefined {
  // 필터 없는 검색 = 현행 경로. 여기서 즉시 빠져나가 전역 조회를 한 번도 안 돌린다 —
  // 회귀 0 과 "필터 없으면 추가 비용 0" 이 이 한 줄에 걸려 있다.
  const hasClassification = hasClassificationFilter(options);
  const hasKind =
    options.kind !== undefined && options.kind.trim().length > 0;
  const hasFieldFilters =
    options.fieldFilters !== undefined && options.fieldFilters.length > 0;
  if (!hasCandidateFilter(options) && visibleIds === undefined) return undefined;

  // 통과 Set 들을 모은다(AND). step 4.5 의 passSets 와 같은 축·같은 출처 함수.
  const passSets: ReadonlySet<number>[] = [];
  if (visibleIds !== undefined) passSets.push(visibleIds);

  // (a) pending_review 무조건 제외 — step 4.5 (a) 와 짝. 전역 변형.
  passSets.push(store.selectNodeIdsNotPendingReview());

  // (b) polarity — step 4.5 (b) 와 짝. 전역 변형(NULL 라벨 제외 규칙 동일).
  if (options.polarity) {
    passSets.push(store.selectNodeIdsByPolarity(options.polarity));
  }

  // (c) 학술 분류 filter — step 4.5 (c) 와 같은 함수(원래 전역 조회).
  if (hasClassification) {
    for (const value of Object.values(options.filter!)) {
      passSets.push(store.getNodeIdsByConceptName(value));
    }
  }

  // (d) 시간 범위 — step 4.5 (d) 와 짝. 상한 없는 전역 변형(자르면 조용한 누락).
  if (options.dateRange) {
    passSets.push(
      store.selectAllNodeIdsByDateRange(
        options.dateRange.since,
        options.dateRange.until,
      ),
    );
  }

  // (e) memory_type — step 4.5 (e) 와 짝. 커버링 색인을 타는 전역 변형.
  if (options.memoryType) {
    passSets.push(store.selectNodeIdsByMemoryType(options.memoryType));
  }

  // (f) 종류 — step 4.5 (f) 와 짝. 원래 전역 조회.
  if (hasKind) {
    passSets.push(store.getNodeIdsByConceptName(options.kind!));
  }

  // (g) 종류별 칸 — step 4.5 (g) 와 짝. 원래 전역 조회.
  if (hasFieldFilters) {
    for (const ff of options.fieldFilters!) {
      passSets.push(store.getNodeIdsByMetadataField(ff.key, ff.value));
    }
  }

  // 교집합 — 가장 작은 Set 부터 훑어 비교 횟수를 줄인다(결과는 순서 무관).
  passSets.sort((a, b) => a.size - b.size);
  const smallest = passSets[0];
  if (smallest === undefined) return undefined;
  const intersection: number[] = [];
  for (const id of smallest) {
    let inAll = true;
    for (let i = 1; i < passSets.length; i++) {
      if (!passSets[i]!.has(id)) {
        inAll = false;
        break;
      }
    }
    if (inAll) intersection.push(id);
  }
  // 크기와 무관하게 그대로 돌려준다 — 통과 집합이 아무리 커도 사후 필터로 내리지
  // 않는다(T4 (B) 재정 2026-08-03). 큰 집합은 searchByVectorRaw 가 VEC0_MAX_K
  // 조각으로 나눠 처리하며, 조각 수만 늘 뿐 회수는 구조적으로 보장된다.
  return intersection;
}

/**
 * 공급 갈래를 고른다. exclusion 은 scope 없는 보기(excludedIds 가 있는 보기)에서 다른
 * 필터가 없고 여유분이 VEC0_MAX_K 안에 들 때만 — 그 밖은 기존 통과 집합 계산 그대로다.
 */
export function planVisibleSupply(
  store: SqliteMemoryStore,
  options: RetrieveOptions,
  snapshot: MemoryVisibilitySnapshot,
  view: MemoryVisibilityView,
  vectorK: number,
): VisibleSupply {
  const excluded = view.excludedIds;
  const allowedIds = view.allowedIds;
  if (excluded !== undefined && allowedIds !== undefined && !hasCandidateFilter(options)) {
    let margin = excluded.size;
    for (const id of snapshot.pendingReviewIds) if (!excluded.has(id)) margin += 1;
    const knnK = vectorK + margin;
    if (knnK <= VEC0_MAX_K) return { mode: "exclusion", view, allowedIds, knnK };
  }
  const ids = computeVectorPassSet(store, options, allowedIds);
  return ids === undefined ? { mode: "unfiltered" } : { mode: "passSet", ids };
}

/**
 * 가시성 → pending_review(통과 집합 경로와 같은 SQL 술어) 순서로 거른다. 입력 순서 보존.
 * 한 문장에 묶는 id 는 통과 집합 KNN 조각과 같은 VEC0_MAX_K 이하 — FTS 보충이 커져도
 * SQLite 바인딩 변수 벽에 닿지 않는다.
 */
function keepSupplied<T extends { nodeId: number }>(
  store: SqliteMemoryStore,
  view: MemoryVisibilityView,
  hits: readonly T[],
): T[] {
  const visible = hits.filter((hit) => view.isAllowed(hit.nodeId));
  const notPending = new Set<number>();
  for (let offset = 0; offset < visible.length; offset += VEC0_MAX_K) {
    const ids = visible.slice(offset, offset + VEC0_MAX_K).map((hit) => hit.nodeId);
    for (const id of store.filterOutPendingReview(ids)) notPending.add(id);
  }
  return visible.filter((hit) => notPending.has(hit.nodeId));
}

/**
 * 벡터 채널 공급 — 거리 오름차순 상위 vectorK. passSet 이면 searchByVectorRaw 가 통과
 * 집합 전체를 순위화해 돌려주므로 여기서 자른다(절단은 호출자 몫 — 그 함수 JSDoc).
 * unfiltered 는 함수가 이미 k=vectorK 로 잘라 돌려주므로 slice 가 아무것도 안 바꾼다.
 */
export async function searchVisibleVectors(
  store: SqliteMemoryStore,
  supply: VisibleSupply,
  options: RetrieveOptions,
  queryVec: Float32Array,
  vectorK: number,
): Promise<VectorHit[]> {
  if (supply.mode !== "exclusion") {
    const ids = supply.mode === "passSet" ? supply.ids : undefined;
    return (await store.searchByVectorRaw(queryVec, vectorK, ids)).slice(0, vectorK);
  }
  if (vectorK <= 0) return [];
  const hits = await store.searchByVectorRaw(queryVec, supply.knnK);
  const kept = keepSupplied(store, supply.view, hits);
  // 허용 노드가 vectorK 개 모였거나 벡터 행을 다 읽었으면 상위 vectorK 가 확정이다.
  if (kept.length >= vectorK || hits.length < supply.knnK) return kept.slice(0, vectorK);
  // 여유분 밖 행이 창을 채웠다 — 통과 집합만이 나머지를 정확히 순위화한다.
  const ids = computeVectorPassSet(store, options, supply.allowedIds);
  return (await store.searchByVectorRaw(queryVec, vectorK, ids)).slice(0, vectorK);
}

/**
 * FTS 채널 공급. FTS 에는 scope 색인이 없어 허용 hit 가 ftsLimit 개 모이거나 실제 색인이
 * 바닥날 때까지 가져오는 양을 두 배씩 늘린다 — 경계 전에 자르지 않는다.
 */
export async function searchVisibleFts(
  store: SqliteMemoryStore,
  supply: VisibleSupply,
  ftsQuery: string,
  ftsLimit: number,
): Promise<FtsHit[]> {
  if (supply.mode === "unfiltered") return store.searchByFts(ftsQuery, ftsLimit);
  if (supply.mode === "passSet" && supply.ids.length === 0) return [];
  let accept: (hits: FtsHit[]) => FtsHit[];
  if (supply.mode === "passSet") {
    const allowed = new Set(supply.ids);
    accept = (hits) => hits.filter((hit) => allowed.has(hit.nodeId));
  } else {
    accept = (hits) => keepSupplied(store, supply.view, hits);
  }
  let fetchLimit = Math.max(1, ftsLimit);
  for (;;) {
    const hits = await store.searchByFts(ftsQuery, fetchLimit);
    const passed = accept(hits);
    if (passed.length >= ftsLimit || hits.length < fetchLimit) return passed.slice(0, ftsLimit);
    fetchLimit *= 2;
  }
}
