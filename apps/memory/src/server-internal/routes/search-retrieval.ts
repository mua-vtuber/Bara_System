/**
 * routes/search-retrieval.ts — POST /search 의 캐시 키 조립 + retriever 실행 +
 * 명시 relaxed 2-pass.
 *
 * routes/search.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). settings 노브(imageVecBoost·
 * precisionStrengthWeight·mentionBoost·baseline floor 가족)를 retriever 옵션과 캐시
 * 키 구조체 양쪽에 같은 값으로 흘려보내고, strict 0건 + relaxFilters=true 일 때만
 * 제거 가능한 필터를 풀어 한 번 더 검색한다. RRF 코어(rrf.ts / search-tuning.ts /
 * retriever.ts)는 상수 import 만 하고 수정하지 않는다(점수식 6파일 diff 0 불변식).
 * body 파싱·응답 조립은 search.ts 파사드가 진다.
 */

import type { MemoryApiDeps } from "../types.ts";
import type { RetrievalResult, RetrieveStats } from "../../memory/retriever.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import type { EventDateRange } from "../../memory/event-date.ts";
import { RRF_BLEND_WEIGHT, BM25_CROSS_WEIGHT } from "../../memory/search-tuning.ts";
import {
  buildCacheKey,
  type SearchCacheKeyInput,
} from "../../memory/search-cache.ts";
import { mergeFilters } from "../../memory/classification-filter.ts";
import {
  parsePolarity,
  parseMemoryType,
  parseKind,
  parseFieldFilters,
  resolveDateRange,
} from "./search-params.ts";
import { filterOcrIncompleteResults } from "./search-enrich.ts";
import type { ResolvedMemoryScope } from "../../memory/shared-memory-contract.ts";
import { getMemoryVisibilitySnapshot } from "../../memory/shared-memory-read.ts";
import { StageTimer, type RetrieveStageTimings } from "../../memory/stage-timer.ts";
import type { SearchRetrievalPassTrace } from "./search-timing.ts";

export type SearchMode = "strict" | "relaxed";

/** 파사드(search.ts)의 body 파싱 단계가 만든 검증 완료 검색 인자 묶음. */
export interface SearchRetrievalArgs {
  scope?: ResolvedMemoryScope;
  includeInactive?: boolean;
  query: string;
  limit: number;
  contextBudget: number;
  project: string | undefined;
  polarity: ReturnType<typeof parsePolarity>;
  filter: ReturnType<typeof mergeFilters>;
  dateRange: ReturnType<typeof resolveDateRange>;
  memoryType: ReturnType<typeof parseMemoryType>;
  placeValue: string | undefined;
  kindFilter: ReturnType<typeof parseKind>;
  fieldFilters: ReturnType<typeof parseFieldFilters>;
  /** true 일 때만 SigLIP image_vec 채널을 켠다. 기본 검색은 메모리 보호를 위해 OFF. */
  imageSearch: boolean;
  /** body.relaxFilters === true 일 때만 relaxed 2-pass 허용. */
  relaxFilters: boolean;
}

/**
 * T10 — 실제 적용된 필터 echo(spec B 항목1 appliedFilters). relaxed 2-pass 가
 * 필터를 제거한 재검색을 만들면 그 남은 값만 담아 반환한다(브리핑 항목4 —
 * appliedFilters 는 *결과를 만든* pass 를 반영, removedFilters 와 짝을 이룬다).
 * 축은 미지정 시 undefined 로 남긴다(null 아님 — "칸 없음" 을 그대로 직렬화해
 * 응답 JSON 에서 생략되게 한다. search-service.ts 가 값 채택).
 */
export interface AppliedFilters {
  scope?: ResolvedMemoryScope;
  includeInactive?: boolean;
  dateRange?: EventDateRange;
  place?: string;
  polarity?: string;
  memoryType?: string;
  kind?: string;
  fieldFilters?: Array<{ key: string; value: string }>;
  filter?: Record<string, string>;
}

export interface SearchRetrievalOutcome {
  results: RetrievalResult[];
  searchMode: SearchMode;
  relaxed: boolean;
  strictCount: number;
  removedFilters: string[];
  /** T10 — retrieveWithStats() 가 낸 계측값(캐시 hit 이면 캐시에 저장된 값). */
  stats: RetrieveStats;
  /** T10 — 반환된 results 를 만든 pass 의 실제 적용 필터 echo. */
  appliedFilters: AppliedFilters;
  /** speed-step1 5.2 — pass(strict, 필요하면 relaxed)마다 캐시 적중 여부·걸린 시간·retriever 단계 시간. */
  passes: SearchRetrievalPassTrace[];
}

function buildRemovedFilters(args: {
  dateRange: unknown;
  placeValue: unknown;
  filter: unknown;
  polarity: unknown;
  memoryType: unknown;
  kindFilter: unknown;
  fieldFilters: unknown;
}): string[] {
  const removed: string[] = [];
  if (args.dateRange !== undefined) removed.push("dateRange");
  if (args.placeValue !== undefined) removed.push("placeValue");
  if (args.filter !== undefined) removed.push("filter");
  if (args.polarity !== undefined) removed.push("polarity");
  if (args.memoryType !== undefined) removed.push("memoryType");
  if (args.kindFilter !== undefined) removed.push("kind");
  if (args.fieldFilters !== undefined) removed.push("fieldFilters");
  return removed;
}

export async function runSearchRetrieval(
  deps: MemoryApiDeps,
  store: SqliteMemoryStore,
  retriever: MemoryApiDeps["retriever"],
  settings: MemorySettings | undefined,
  args: SearchRetrievalArgs,
): Promise<SearchRetrievalOutcome> {
  const {
    query,
    limit,
    contextBudget,
    project,
    polarity,
    filter,
    dateRange,
    memoryType,
    placeValue,
    kindFilter,
    fieldFilters,
    imageSearch,
  } = args;

  // ── R4 검색 캐시 (6b T3 / spec 10.2 / M10·T3) ─────────────────────────
  // retriever 밖 한 겹. 캐시는 *리랭커 이전* RRF 결과를 보관한다(spec 10.2.3) —
  // 리랭커(T6)는 캐시 hit 뒤에 오는 별도 단계라 여기서 호출하지 않는다.
  //
  // 캐시 키(buildCacheKey)는 검색 결과를 가르는 모든 식별 값을 한 구조체로 받는다
  // (M10·T3). 옛 버전은 retrieve 옵션 8칸을 buildCacheKey 에 넣고 limit·contextBudget·
  // 점수 운영 설정·거름망 칸 등 12개 값을 파이프 문자열 suffix 로 따로 이어 붙였는데,
  // 새 식별 값을 더할 때 suffix 합성을 잊으면 서로 다른 검색이 같은 키로 충돌해 캐시
  // 오적중이 났다. 이제 그 12칸을 SearchCacheKeyInput 칸으로 흡수해 한 번에 직렬화한다.
  //
  // db_revision 이 키에 들어가므로 데이터 갱신 직후 같은 query 는 키가 달라져
  // 자연히 miss 가 된다(spec 10.2.4 — 옛 결과 재사용 차단 / silent fallback 금지).
  // channels·weights 는 라우트가 retriever 에 오버라이드를 안 넘기므로 운영
  // default(전 채널 ON / search-tuning.ts blend 상수) 고정값으로 직렬화한다.
  const searchCache = deps.searchCache;
  const reranker = settings?.reranker;
  // image-search-foundation T7 (c-C1) — 이미지 유사도 채널 전용 boost 를
  // settings 에서 읽어 retriever 로 흘려보낸다. settings 미주입(테스트 직호출)이면
  // 미전달 = retriever 가 SOURCE_BOOST.imageVec 운영 default 를 쓴다(자연 degrade).
  // 이 값은 검색 *결과 점수*를 바꾸므로 캐시 키 구조체 칸에 넣어 stale 을 막는다
  // (글 검색은 imageVec 기여 0 이라 불변이지만, 이미지 섞인 검색은 순위가 바뀐다).
  const imageVecBoost = settings?.images?.searchSimilarityBoost;
  // 강도-반영 정밀 재채점 가중치 λ(설계 §4.2 / T4) — settings 에서 읽어 retriever
  // 로 흘려보낸다. settings 미주입(테스트 직호출)이면 미전달 = retriever 가
  // PRECISION_STRENGTH_WEIGHT 모듈 default 를 쓴다(자연 degrade). 이 값은 검색
  // 결과 점수(글·이미지 모두)를 바꾸므로 캐시 키 구조체 칸에 넣어 stale 을 막는다.
  const precisionStrengthWeight = settings?.search?.precisionStrengthWeight;
  // 재언급 1회당 검색 점수 가산량(P3 G3-d) — settings.search.mentionBoost 노브를
  // 읽어 retriever 로 흘려보낸다. settings 미주입(테스트 직호출)이면 미전달 =
  // retriever 가 MENTION_BOOST_PER_COUNT 모듈 default(0.05)를 쓴다(자연 degrade).
  // 이 값은 검색 결과 점수(재언급 많은 노드 순위)를 바꾸므로 캐시 키 구조체 칸에
  // 넣어 stale 을 막는다 — 노브를 바꾸면 같은 query 라도 캐시가 miss 로 갈린다.
  const mentionBoostPerCount = settings?.search?.mentionBoost;
  // 채널별 절대 baseline floor(강도-반영 융합 §8.3·§8.6 후속 / D-N2) — settings 에서
  // 읽어 retriever 로 흘려보낸다. settings 미주입(테스트 직호출)이면 미전달 =
  // retriever 가 BASELINE_FLOOR_* 모듈 default 를 쓴다(자연 degrade). 이 값들은
  // 검색 결과 점수를 바꾸므로 캐시 키 구조체 칸에 넣어 stale 을 막는다.
  const baselineFloorMode = settings?.search?.baselineFloorMode;
  // 글 유사도 baseline 은 모델에 연동된다(2026-06-01 bge-m3 정식 전환). settings 의
  // baselineVectorCosine 음수(예 -1 default)는 "미지정 = 모델 연동 default 따름"
  // 의미라 retriever 로 흘리지 않는다 — 그러면 retriever 가 server.ts 가 주입한
  // 모델 baseline(bge-m3 0.5)을 쓴다. 0..1 로 명시되면 그 값을 흘려
  // 사용자 오버라이드가 모델 default 를 이긴다. imageVec 은 SigLIP 한 모델 고정이라
  // 모델 연동 없이 settings 값을 그대로 흘린다(음수 sentinel 불필요).
  const baselineVectorCosineRaw = settings?.search?.baselineVectorCosine;
  const baselineVectorCosine =
    baselineVectorCosineRaw !== undefined && baselineVectorCosineRaw >= 0
      ? baselineVectorCosineRaw
      : undefined;
  const baselineImageVecCosine = settings?.search?.baselineImageVecCosine;
  // 검색 결과를 가르는 모든 식별 값을 한 구조체로 모은다(M10·T3 — 옛 suffix 제거).
  // 옵션 칸이 undefined 면 buildCacheKey 가 ?? null 로 고정 토큰화하므로 라우트는
  // 값을 그대로 넘기면 된다(spread 분기 불필요). 새 식별 값은 여기 칸 한 곳만
  // 더하면 자동으로 키에 반영된다(suffix 합성 누락 위험 제거).
  // 가시성 두 칸은 retriever·최종 필터가 다시 쓰는 같은 스냅샷에서 읽는다(재스캔 0).
  const visibility = getMemoryVisibilitySnapshot(store);
  const cacheKeyInput: SearchCacheKeyInput = {
    scope: args.scope,
    includeInactive: args.includeInactive,
    validityEpoch: visibility.view(args.scope, args.includeInactive).validityEpoch,
    visibilityGeneration: visibility.generation,
    query,
    channels: { vector: true, fts: true, graph: true, concept: true },
    weights: { rrf: RRF_BLEND_WEIGHT, bm25: BM25_CROSS_WEIGHT },
    ...(polarity ? { polarity } : {}),
    ...(project ? { projectId: project } : {}),
    // include = 학술 분류 filter 의 *값* 목록(순서 무관 — buildCacheKey 가
    // 정렬). filter 미지정이면 빈 배열(필터 미적용 = 1.1c 동작 불변).
    include: filter ? Object.values(filter) : [],
    // reranker 상태는 캐시된 리랭커 이전 결과 자체를 안 바꾸지만, 키에 넣어
    // 토글·topK 변경 시 stale 회피(spec 10.2.2). settings 미주입(테스트
    // buildMemoryApi 직호출)이면 default OFF/0 상태로 직렬화 — 한 부팅 안
    // 에서는 reranker 칸이 안 바뀌므로 hit/miss 판정에 영향 없다.
    reranker: {
      enabled: reranker?.enabled ?? false,
      topK_input: reranker?.topK_input ?? 0,
      topK_output: reranker?.topK_output ?? 0,
    },
    dbRevision: store.getDbRevision(),
    // 라우트가 결과를 가르는 12칸(옛 suffix 흡수). undefined 는 buildCacheKey 가
    // null 로 고정 토큰화 = 옛 suffix 의 "default"·"none" 토큰과 같은 식별 동작.
    limit,
    contextBudget,
    imageSearch,
    imageVecBoost,
    precisionStrengthWeight,
    mentionBoostPerCount,
    baselineFloorMode,
    baselineVectorCosine,
    baselineImageVecCosine,
    dateRange,
    memoryType,
    placeValue,
    kind: kindFilter,
    fieldFilters,
  };
  const cacheKey = searchCache ? buildCacheKey(cacheKeyInput) : undefined;

  const passes: SearchRetrievalPassTrace[] = [];
  const strictTimer = new StageTimer();
  // 새로 돈 retriever 의 단계 시간. 캐시에는 넣지 않으므로 캐시 적중이면 null 로 남는다.
  let strictTimings: RetrieveStageTimings | null = null;
  let results: RetrievalResult[];
  let stats: RetrieveStats;
  const cached =
    searchCache && cacheKey ? searchCache.get(cacheKey) : undefined;
  if (cached) {
    // 캐시 hit — 보관된 리랭커 이전 결과를 그대로 재생(retriever 재실행 0).
    // stats 도 캐시 저장분을 그대로 재생한다 — 캐시 hit/miss 가 동일 입력에
    // 대해 동일 processing_info 를 내야 하므로(T10 brief 항목5) 여기서
    // 재계산하지 않는다(D-D).
    results = filterOcrIncompleteResults(store, cached.results);
    stats = cached.stats;
  } else {
    // 캐시 miss(또는 캐시 미주입) — 실제 retriever 1회 실행 후 그 진짜 결과를
    // 보관한다. miss 는 fallback 이 아니라 "아직 캐시 안 됨" 의 정직한 상태다.
    const retrieved = await retriever.retrieveWithStats(query, {
      scope: args.scope,
      includeInactive: args.includeInactive,
      limit,
      ...(project ? { project } : {}),
      ...(polarity ? { polarity } : {}),
      ...(filter ? { filter } : {}),
      ...(imageVecBoost !== undefined ? { imageVecBoost } : {}),
      ...(precisionStrengthWeight !== undefined
        ? { precisionStrengthWeight }
        : {}),
      ...(mentionBoostPerCount !== undefined
        ? { mentionBoostPerCount }
        : {}),
      ...(baselineFloorMode !== undefined ? { baselineFloorMode } : {}),
      ...(baselineVectorCosine !== undefined
        ? { vectorBaseline: baselineVectorCosine }
        : {}),
      ...(baselineImageVecCosine !== undefined
        ? { imageVecBaseline: baselineImageVecCosine }
        : {}),
      ...(dateRange ? { dateRange } : {}),
      ...(memoryType ? { memoryType } : {}),
      ...(placeValue ? { placeValue } : {}),
      ...(kindFilter ? { kind: kindFilter } : {}),
      ...(fieldFilters ? { fieldFilters } : {}),
      channelMask: {
        vector: true,
        fts: true,
        graph: true,
        concept: true,
        imageVec: imageSearch,
        project: true,
        person: true,
      },
    });
    results = filterOcrIncompleteResults(store, retrieved.results);
    stats = retrieved.stats;
    strictTimings = retrieved.timings;
    if (searchCache && cacheKey) {
      searchCache.set(cacheKey, { results, stats });
    }
  }

  passes.push({
    pass: "strict",
    cacheHit: cached !== undefined,
    ms: strictTimer.elapsed(),
    timings: strictTimings,
  });
  const strictCount = results.length;

  // T10 — strict pass 의 appliedFilters(relaxed 로 갈리면 아래에서 덮어씀).
  let appliedFilters: AppliedFilters = {
    ...(args.scope ? { scope: args.scope } : {}),
    ...(args.includeInactive ? { includeInactive: true } : {}),
    ...(dateRange ? { dateRange } : {}),
    ...(placeValue ? { place: placeValue } : {}),
    ...(polarity ? { polarity } : {}),
    ...(memoryType ? { memoryType } : {}),
    ...(kindFilter ? { kind: kindFilter } : {}),
    ...(fieldFilters ? { fieldFilters } : {}),
    ...(filter ? { filter } : {}),
  };

  // ── 명시 relaxed 2-pass (2026-06-28 검색 정직화) ───────────────────────
  // 기본은 strict mode 다. 조건 검색 결과가 0건이면 0건 그대로 회신하고, 조건을
  // 풀어 비슷한 결과를 찾는 2-pass 는 body.relaxFilters === true 일 때만 실행한다.
  // relaxed 검색은 제거 가능한 필터만 떼고 query·limit·project·점수 운영 설정은
  // 유지한다. strict 키와 relaxed 키는 fallbackPass 구조체 칸으로 분리한다.
  const hadFieldFilter =
    dateRange !== undefined ||
    placeValue !== undefined ||
    filter !== undefined ||
    polarity !== undefined ||
    memoryType !== undefined ||
    kindFilter !== undefined ||
    fieldFilters !== undefined;
  let searchMode: SearchMode = "strict";
  let relaxed = false;
  let removedFilters: string[] = [];
  if (results.length === 0 && hadFieldFilter && args.relaxFilters === true) {
    const relaxedTimer = new StageTimer();
    let relaxedTimings: RetrieveStageTimings | null = null;
    removedFilters = buildRemovedFilters({
      dateRange,
      placeValue,
      filter,
      polarity,
      memoryType,
      kindFilter,
      fieldFilters,
    });
    const fallbackKey = searchCache
      ? buildCacheKey({ ...cacheKeyInput, fallbackPass: true })
      : undefined;
    const cachedFallback =
      searchCache && fallbackKey ? searchCache.get(fallbackKey) : undefined;
    if (cachedFallback) {
      results = filterOcrIncompleteResults(store, cachedFallback.results);
      stats = cachedFallback.stats;
    } else {
      // 제거 가능한 필터만 제거 — project 는 작업 맥락 경계라 relaxed 에서도 유지한다.
      const retrievedFallback = await retriever.retrieveWithStats(query, {
        scope: args.scope,
        includeInactive: args.includeInactive,
        limit,
        ...(project ? { project } : {}),
        ...(imageVecBoost !== undefined ? { imageVecBoost } : {}),
        ...(precisionStrengthWeight !== undefined
          ? { precisionStrengthWeight }
          : {}),
        ...(mentionBoostPerCount !== undefined
          ? { mentionBoostPerCount }
          : {}),
        ...(baselineFloorMode !== undefined ? { baselineFloorMode } : {}),
        ...(baselineVectorCosine !== undefined
          ? { vectorBaseline: baselineVectorCosine }
          : {}),
        ...(baselineImageVecCosine !== undefined
          ? { imageVecBaseline: baselineImageVecCosine }
          : {}),
        channelMask: {
          vector: true,
          fts: true,
          graph: true,
          concept: true,
          imageVec: imageSearch,
          project: true,
          person: true,
        },
      });
      results = filterOcrIncompleteResults(store, retrievedFallback.results);
      stats = retrievedFallback.stats;
      relaxedTimings = retrievedFallback.timings;
      if (searchCache && fallbackKey) {
        searchCache.set(fallbackKey, { results, stats });
      }
    }
    passes.push({
      pass: "relaxed",
      cacheHit: cachedFallback !== undefined,
      ms: relaxedTimer.elapsed(),
      timings: relaxedTimings,
    });
    searchMode = "relaxed";
    relaxed = true;
    // T10 브리핑 항목4 — appliedFilters 는 *반환된 결과를 만든* pass 를 반영한다.
    // relaxed pass 는 project 를 제외한 모든 축을 제거했으므로(위 retrieveWithStats
    // 호출에 dateRange·placeValue·polarity·memoryType·kind·fieldFilters·filter 가
    // 하나도 없음) 남은 필터 축이 없다 — 빈 객체(모든 키 생략)로 덮어쓴다.
    appliedFilters = { ...(args.scope ? { scope: args.scope } : {}), ...(args.includeInactive ? { includeInactive: true } : {}) };
  }

  return {
    results,
    searchMode,
    relaxed,
    strictCount,
    removedFilters,
    stats,
    appliedFilters,
    passes,
  };
}
