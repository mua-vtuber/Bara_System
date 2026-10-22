/**
 * search-cache.ts — RRF 검색 결과 캐시 (Phase 6b R4 / T2 / spec 10.2).
 *
 * 같은 검색 요청이 짧은 시간 안에 반복될 때 retriever.retrieve() 의 RRF 합산을
 * 다시 돌리지 않도록 결과를 캐시한다. 캐시 값은 *리랭커 이전* 점수 결과다(spec
 * 10.2.3) — 리랭커는 캐시 hit 뒤에 오는 별도 단계이므로 그 산출은 캐시에 넣지
 * 않는다. 이렇게 두면 리랭커 토글이 바뀌어도 캐시된 RRF 결과를 재활용하면서
 * 재정렬만 다시 적용할 수 있다(단, 키에는 리랭커 상태를 넣어 토글 시 stale 회피).
 *
 * 순수 모듈 — LLM·임베딩·네트워크·DB 접근 0. invalidateAll 은 외부 호출자(T3 가
 * wiring 하는 DB 갱신 콜백)가 부른다. 이 모듈은 스스로 바깥으로 나가지 않는다.
 *
 * 캐시 키(buildCacheKey) = 22개 식별 차원의 결정적 직렬화(spec 10.2.2 / M10·T3).
 * 옛 버전은 8요소 구조체 직렬화 뒤에 라우트가 12개 식별 값을 파이프 문자열 suffix
 * 로 따로 이어 붙였는데, 새 식별 값을 더할 때 suffix 합성을 잊으면 서로 다른 검색이
 * 같은 키로 충돌해 캐시 오적중이 났다(silent 결함). 그 두 군데를 한 구조체로 모은다 —
 * 새 식별 값은 인터페이스 칸 한 곳만 더하면 자동으로 키에 반영된다.
 *
 * retrieve() 옵션을 식별하는 8칸(spec 10.2.2 옛 설명):
 *   (1) query        — 정규화(앞뒤 공백 제거 + 소문자)
 *   (2) channels     — 채널 토글
 *   (3) weights      — RRF blend 가중치
 *   (4) polarity     — polarity 필터
 *   (5) project_id   — 프로젝트 어휘 expansion 대상
 *   (6) include      — 학술 분류 filter 값 목록(순서 무관 — 정렬)
 *   (7) reranker     — { enabled, topK_input, topK_output } (model/host 제외 —
 *                      재정렬 순서·여부에만 영향하는 칸만 / spec 10.2.2)
 *   (8) db_revision  — DB 변경 카운터(T3 공급). 한 칸이라도 다르면 키가 달라진다.
 *
 * 라우트가 검색 결과를 가르는 12칸(옛 suffix — M10 이 구조체로 흡수):
 *   (9)  limit                  — 결과 trim 길이·context 조립이 limit 별로 다름
 *   (10) contextBudget          — context 조립 분기(limit 와 함께 라우트 후처리)
 *   (11) imageVecBoost          — 이미지 유사도 채널 boost(점수 변경 → stale 회피)
 *   (12) precisionStrengthWeight— 강도-반영 정밀 재채점 가중치 λ(점수 변경)
 *   (13) baselineFloorMode      — baseline floor 적용 방식(점수 변경)
 *   (14) baselineVectorCosine   — vector 채널 절대 baseline cosine(점수 변경)
 *   (15) baselineImageVecCosine — imageVec 채널 절대 baseline cosine(점수 변경)
 *   (16) dateRange              — 닫힌 시간 구간 하드 필터(후보 축소)
 *   (17) memoryType             — memory_type 한정 하드 필터(후보 축소)
 *   (18) placeValue             — 장소 칸 소프트 가산 신호(점수 변경)
 *   (19) kind                   — 종류 분류 하드 필터(후보 축소)
 *   (20) fieldFilters           — 종류별 칸값 하드 필터 목록(후보 축소·순서 무관)
 *   (21) fallbackPass           — 0건 폴백 2-pass 키(옛 suffix '|fb:1' 흡수). 1차
 *                                 (좁힌) 결과와 폴백(칸 제거) 결과를 다른 키로 가른다.
 *   (22) mentionBoostPerCount   — 재언급 1회당 검색 점수 가산량(P3 G3-d / 점수 변경).
 *                                 settings.search.mentionBoost 노브가 바뀌면 재언급
 *                                 많은 노드 순위가 갈리므로 키에 넣어 stale 회피.
 *
 * 객체 키 순서는 직렬화 전에 정렬해 안정화한다(JSON.stringify 가 삽입 순서를
 * 보존하므로, 정렬 없이는 같은 의미의 입력이 다른 키가 될 수 있다). stableStringify
 * 가 중첩 객체(dateRange)·배열(fieldFilters)도 재귀로 정렬 직렬화한다.
 */
import type { RetrievalResult, RetrieveStats } from "./retriever.ts";
import type { Polarity, MemoryType } from "./types.ts";
import type { EventDateRange } from "./event-date.ts";
import type { BaselineFloorMode } from "./search-tuning.ts";
import { resolvedScopeKey, type ResolvedMemoryScope } from "./shared-memory-contract.ts";

// ── 캐시 키 입력 계약 ─────────────────────────────────────────────────────────

/**
 * 리랭커 상태 중 *재정렬 순서·여부* 에 영향하는 칸만 키에 넣는다(spec 10.2.2).
 * model / host 는 캐시된 *리랭커 이전* 결과의 RRF 순위를 바꾸지 않으므로 제외 —
 * enabled / topK_input / topK_output 만 토글 시 캐시를 무효화해야 한다.
 */
export interface RerankerKeyState {
  enabled: boolean;
  topK_input: number;
  topK_output: number;
}

/**
 * 캐시 키 입력. 검색 결과를 유일하게 식별하는 21개 값 집합(M10·T3). retrieve()
 * 옵션 8칸 + 라우트가 결과를 가르는 12칸 + 폴백 패스 1칸을 한 구조체로 모은다 —
 * 옛 버전이 8칸 구조체와 12칸 suffix 로 쪼갰던 두 군데를 합친다. 새 식별 값은 칸
 * 한 곳만 더하면 buildCacheKey 가 자동으로 직렬화한다(suffix 합성 누락 위험 제거).
 *
 * 옵션 칸(imageVecBoost·precisionStrengthWeight·baseline 셋·dateRange·memoryType·
 * placeValue·kind·fieldFilters)은 라우트가 미지정 시 undefined 를 넘기고, buildCacheKey
 * 가 ?? null 로 고정 토큰화해 "미지정" 이 안정 값을 갖는다(polarity·projectId 선례 정합).
 */
export interface SearchCacheKeyInput {
  scope?: ResolvedMemoryScope;
  includeInactive?: boolean;
  validityEpoch?: number;
  /**
   * 가시성 변경 번호(memory_visibility_state.generation — v43 트리거가 올린다). dbRevision 은
   * 이 프로세스의 저장소 메서드만 올리므로, 원시 SQL·다른 프로세스·extractedTo 표시처럼
   * dbRevision 을 안 올리는 가시성 변경도 이 칸이 캐시를 가른다.
   */
  visibilityGeneration?: number;
  /** (1) 원본 query. 직렬화 전 정규화(trim + lowercase)된다. */
  query: string;
  /** (2) 채널 토글(미지정 채널 없이 4칸 모두 명시). */
  channels: { vector: boolean; fts: boolean; graph: boolean; concept: boolean };
  /** (3) RRF blend 가중치(rrf / bm25 cross). */
  weights: { rrf: number; bm25: number };
  /** (4) polarity 필터 — 미지정 시 undefined. */
  polarity?: Polarity;
  /** (5) 프로젝트 어휘 expansion 대상 id — 미지정 시 undefined. */
  projectId?: string;
  /** (6) 학술 분류 filter 값 목록 — 순서 무관(정렬 후 직렬화). */
  include: string[];
  /** (7) 리랭커 상태(enabled + topK 두 칸). */
  reranker: RerankerKeyState;
  /** (8) DB 변경 카운터(T3 공급). */
  dbRevision: number;
  /** (9) 결과 trim 길이·context 조립이 limit 별로 다르다(라우트 후처리 식별). */
  limit: number;
  /** (10) context 조립 분기(contextBudget>0 일 때만 context 포함 — 라우트 후처리). */
  contextBudget: number;
  /** (11) 이미지 유사도 채널 boost — 미지정 시 undefined(retriever default). */
  imageVecBoost?: number;
  /** 이미지 유사도 채널 실행 여부. false/undefined 가 기본 일반 검색. */
  imageSearch?: boolean;
  /** (12) 강도-반영 정밀 재채점 가중치 λ — 미지정 시 undefined(모듈 default). */
  precisionStrengthWeight?: number;
  /**
   * (22) 재언급 1회당 검색 점수 가산량(P3 G3-d) — 미지정 시 undefined(모듈
   * default 0.05). settings.search.mentionBoost 노브를 바꾸면 재언급 많은 노드
   * 순위가 바뀌므로 키에 넣어 stale 을 막는다.
   */
  mentionBoostPerCount?: number;
  /** (13) baseline floor 적용 방식 — 미지정 시 undefined(모듈 default). */
  baselineFloorMode?: BaselineFloorMode;
  /** (14) vector 채널 절대 baseline cosine — 미지정 시 undefined(모델 연동 default). */
  baselineVectorCosine?: number;
  /** (15) imageVec 채널 절대 baseline cosine — 미지정 시 undefined(모듈 default). */
  baselineImageVecCosine?: number;
  /** (16) 닫힌 시간 구간 하드 필터 — 미지정 시 undefined(전 후보 통과). */
  dateRange?: EventDateRange;
  /** (17) memory_type 한정 하드 필터 — 미지정 시 undefined(전 후보 통과). */
  memoryType?: MemoryType;
  /** (18) 장소 칸 소프트 가산 신호 — 미지정 시 undefined(가산 0). */
  placeValue?: string;
  /** (19) 종류 분류 하드 필터 — 미지정 시 undefined(전 후보 통과). */
  kind?: string;
  /** (20) 종류별 칸값 하드 필터 목록 — 순서 무관(정렬 후 직렬화)·미지정 시 undefined. */
  fieldFilters?: Array<{ key: string; value: string }>;
  /** (21) 0건 폴백 2-pass 키(옛 suffix '|fb:1' 흡수). 미지정 = 1차(좁힌) 검색. */
  fallbackPass?: boolean;
}

// ── 캐시 값 계약 ──────────────────────────────────────────────────────────────

/**
 * 캐시 값 = *리랭커 이전* 점수 결과(spec 10.2.3). retriever.retrieve() 가
 * 돌려주는 RetrievalResult[] 그대로(finalScore·sources·components 포함).
 * 리랭커 산출은 여기에 넣지 않는다 — 캐시 hit 뒤 별도 단계(T6)에서 적용.
 */
export interface CachedSearch {
  results: RetrievalResult[];
  /**
   * T10 — retrieveWithStats() 가 계산한 totalFound/afterFiltering 을 결과와
   * 함께 캐시한다. 캐시 hit 이 retriever 를 다시 안 돌리므로(재계산 0), 이 값
   * 없이는 hit 응답의 processing_info 를 채울 방법이 없다. 캐시 값과 함께
   * 저장·회신해야 hit/miss 가 동일 입력에 대해 동일 processing_info 를 낸다
   * (T10 brief 항목5 — cache hit/miss identity). SearchCache 는 in-process
   * Map(영속화 없음)이라 서버 재시작 시 통째로 비므로, 이 필드를 추가하는
   * 배포 이후에는 "stats 없는 옛 캐시 항목"이 존재할 수 없다 — required.
   */
  stats: RetrieveStats;
}

// ── 결정적 직렬화 ─────────────────────────────────────────────────────────────

/** query 정규화 — 앞뒤 공백 제거 + 소문자. (1) 요소. */
function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * 객체를 키 정렬 후 직렬화한다. JSON.stringify 는 삽입 순서를 보존하므로,
 * 같은 의미의 입력이 작성 순서만 달라도 다른 키가 되는 것을 막으려면 키를
 * 정렬해야 한다(spec 10.2.2 "stable key order").
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * 21개 식별 차원을 결정적으로 직렬화한다. 한 차원이라도 다르면 키가 달라진다 —
 * 특히 reranker 상태(spec 10.2.2 — 토글 시 stale 결과 회피)와 라우트가 결과를
 * 가르는 12칸(옛 suffix 가 따로 잇던 값을 한 구조체로 흡수 / M10·T3).
 *
 * undefined 칸(polarity·projectId·옵션 12칸 중 미지정)은 명시 null 토큰으로
 * 직렬화해 "미지정" 이 고정 값을 갖도록 한다(키 안정성 / 옛 suffix 의 "default"·
 * "none" 토큰과 같은 역할 — "미지정도 안정 토큰" 식별 동작 보존). include 와
 * fieldFilters 는 순서 무관이라 정렬한다(fieldFilters 는 key→value 양식으로 정규화
 * 후 정렬해 같은 칸 묶음을 어느 순서로 줘도 같은 키가 되게 한다 / 옛 suffix 의
 * `.map(...).sort().join(",")` 와 같은 순서 무관 동작).
 */
export function buildCacheKey(input: SearchCacheKeyInput): string {
  const normalized = {
    q: normalizeQuery(input.query),
    ch: input.channels,
    w: input.weights,
    pol: input.polarity ?? null,
    proj: input.projectId ?? null,
    scope: input.scope ? resolvedScopeKey(input.scope) : null,
    inactive: input.includeInactive ?? false,
    validity: input.validityEpoch ?? 0,
    vgen: input.visibilityGeneration ?? null,
    inc: [...input.include].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    rr: {
      enabled: input.reranker.enabled,
      topK_input: input.reranker.topK_input,
      topK_output: input.reranker.topK_output,
    },
    rev: input.dbRevision,
    // 라우트가 결과를 가르는 12칸 + 폴백 패스 — 옛 suffix 흡수(M10·T3).
    lim: input.limit,
    ctx: input.contextBudget,
    imgSearch: input.imageSearch ?? false,
    imgBoost: input.imageVecBoost ?? null,
    precW: input.precisionStrengthWeight ?? null,
    mentBoost: input.mentionBoostPerCount ?? null,
    blMode: input.baselineFloorMode ?? null,
    blVec: input.baselineVectorCosine ?? null,
    blImg: input.baselineImageVecCosine ?? null,
    dr: input.dateRange ?? null,
    mtype: input.memoryType ?? null,
    place: input.placeValue ?? null,
    kind: input.kind ?? null,
    ff: input.fieldFilters
      ? input.fieldFilters
          .map((f) => `${f.key}=${f.value}`)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      : null,
    fb: input.fallbackPass ?? false,
  };
  return stableStringify(normalized);
}

// ── SearchCache ───────────────────────────────────────────────────────────────

interface CacheEntry {
  value: CachedSearch;
  /** Date.now() + ttlMs — 이 시각 이후의 get 은 만료로 본다. */
  expiresAt: number;
}

/** SearchCache 생성자 옵션 — 미지정 시 spec 기본값(TTL 60초 / 200칸). */
export interface SearchCacheOptions {
  /** 항목 수명(ms). 미지정 = DEFAULT_TTL_MS. */
  ttlMs?: number;
  /** LRU 상한(칸 수). 미지정 = DEFAULT_MAX_ENTRIES. */
  maxEntries?: number;
}

/**
 * RRF 검색 결과 캐시 — TTL 만료 + LRU 상한 + 통째 무효화.
 *
 * 자료구조: Map<string, CacheEntry>. JS Map 은 삽입 순서를 보존하므로 가장
 * 오래된 칸 = Map 의 첫 항목이다. get / set 시 해당 키를 삭제 후 재삽입해
 * "최근 사용" 순서로 끌어올린다(LRU). 상한 초과 시 첫 항목(가장 오래 안 쓴 칸)을
 * 축출한다(매일 사용 중 메모리 증가 방어).
 *
 * 순수 모듈 — DB·네트워크·LLM 접근 0. invalidateAll 은 외부 호출자가 부른다
 * (DB 갱신 시 db_revision bump 와 같은 효과의 통째 비우기 — 작은 캐시라 OK).
 */
export class SearchCache {
  /** 기본 TTL — spec 10.2 (60초). */
  static readonly DEFAULT_TTL_MS = 60_000;
  /** 기본 LRU 상한 — spec 10.2 (200칸). */
  static readonly DEFAULT_MAX_ENTRIES = 200;

  private readonly store = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: SearchCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? SearchCache.DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? SearchCache.DEFAULT_MAX_ENTRIES;
  }

  /** 현재 캐시 칸 수. */
  get size(): number {
    return this.store.size;
  }

  /**
   * 키로 캐시 값을 조회한다. 없으면 undefined. TTL 만료 칸은 undefined 를
   * 돌려주면서 그 칸을 삭제한다(만료 칸이 LRU 순서·메모리를 차지하지 않게).
   * hit 시 해당 칸을 재삽입해 "최근 사용" 으로 끌어올린다(LRU 갱신).
   */
  get(key: string): CachedSearch | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // 최근 사용 — 삭제 후 재삽입해 Map 삽입 순서 맨 뒤로 옮긴다.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /**
   * 키에 값을 저장한다. 같은 키 재저장은 칸 수를 늘리지 않고 값·만료 시각을
   * 갱신한다(삭제 후 재삽입 — LRU 순서도 맨 뒤로). 저장 후 상한을 넘으면
   * 가장 오래 안 쓴 칸(Map 첫 항목)을 축출한다.
   */
  set(key: string, value: CachedSearch): void {
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /**
   * 캐시를 통째로 비운다. DB 갱신 시 외부 호출자(T3)가 부른다 — db_revision 을
   * bump 하는 것과 같은 효과(작은 캐시라 통째 비우기가 충분). 이 모듈은 DB 변경을
   * 스스로 감지하지 않는다 — 외부에서 신호를 받아 비울 뿐.
   */
  invalidateAll(): void {
    this.store.clear();
  }
}
