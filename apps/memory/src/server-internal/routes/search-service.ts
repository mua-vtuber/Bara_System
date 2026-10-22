/**
 * server-internal/routes/search-service.ts — POST /search 파이프라인 본체(서비스 함수).
 *
 * MCP T4(spec 4.4) — HTTP 자기호출 금지 원칙의 귀결로 search.ts 라우트 본문에서
 * 이 파일로 이동한다(코드 이동만, 식별자·순서·주석 무변경). search.ts 는 body
 * JSON 파싱 + runSearchPipeline 호출 + 에러 매핑만 남은 얇은 라우트가 되고,
 * mcp/tools-memory.ts 의 search_memory 도구가 같은 함수를 직접 호출한다(REST
 * 재노출 — 자기 서버에 HTTP 요청을 보내지 않는다).
 *
 * query 검증 실패는 SearchInputError 로 던진다 — 라우트가 이를 400 으로,
 * MCP 도구가 isError 텍스트로 각각 매핑한다(같은 원인 문구 공유).
 */

import type {
  MemoryApiDeps,
  SearchBody,
  SearchEnrichedResult,
  ProcessingInfo,
} from "../types.ts";
import { isPositiveString, parseLimit } from "../http-helpers.ts";
import { toNfc } from "../../memory/nfc.ts";
import { parseMemoryReadScope, type ResolvedMemoryScope } from "../../memory/shared-memory-contract.ts";
import { resolveMemoryReadScope } from "../../memory/project-scope-resolver.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { DEFAULT_MAX_CONTEXT_TOKENS } from "../../memory/neighbor-chunks.ts";
import {
  parseClassificationFiltersFromSearchParams,
  mergeFilters,
} from "../../memory/classification-filter.ts";
import {
  parsePolarity,
  parseMemoryType,
  parseFilter,
  parseKind,
  parseFieldFilters,
  parsePlace,
  parseImageSearch,
  resolveDateRange,
} from "./search-params.ts";
import {
  retrieveEntities,
  type EntitySearchHit,
} from "../../memory/retrieve-entities-channel.ts";
import { explicitDisplayKind } from "../../memory/entity-type-classifier.ts";
import { buildEnriched } from "./search-enrich.ts";
import { readAncillaryVisibility } from "./search-ancillary-visibility.ts";
import { runSearchRetrieval } from "./search-retrieval.ts";
import {
  applyNeighborContext,
  applyOpenConflicts,
  applyRevisionFlags,
  applySummaries,
  dedupChildToParent,
} from "./search-post-process.ts";
import { applyResultFloor } from "./search-result-floor.ts";
import {
  buildIndexItems,
  parseResponseMode,
  POINTER_SENTENCE,
} from "./search-index-mode.ts";
import { StageTimer } from "../../memory/stage-timer.ts";
import {
  formatSearchTimingLine,
  type SearchTimingRecord,
} from "./search-timing.ts";

/** query 부재·비문자열 등 입력 오류 — 라우트가 400, MCP 도구가 isError 로 매핑. */
export class SearchInputError extends Error {}

/**
 * 호출측이 명시하는 파이프라인 적용 옵션(T20 / spec F · 단락 11 확정 3).
 *
 * `applyResultFloor` 는 검색 결과 하한선을 걸지 여부다. **호출자 정체로 조용히
 * 갈리지 않는다** — MCP `search_memory`(AI 경로)가 true 를 명시하고, REST
 * `/search`(대시보드)는 이 옵션을 안 넘겨 false 로 남는다. 사람 눈 탐색은 낮은
 * 점수 결과도 단서로 쓰므로 대시보드는 전체 표시를 유지한다.
 *
 * 미지정 default 는 false — 이 옵션을 모르는 기존 호출자(외부 소비처·테스트)의
 * 동작이 도입 전과 byte 동일하다. AI 경로만 명시적으로 켠다.
 */
export interface SearchPipelineOptions {
  applyResultFloor?: boolean;
  /**
   * 호출측이 이미 해석한 읽기 범위(recall_context 가 기본값 "global" 로 해석한 것). 주면
   * body.scope 는 비어 있어야 한다 — 두 범위가 갈리는 호출을 조용히 한쪽으로 고르지 않는다.
   * 안 주면 body.scope 를 여기서 해석한다(없으면 거름 없음, spec 10.1 단계 1).
   */
  resolvedScope?: ResolvedMemoryScope;
}

/**
 * index 모드 limit 의 하드 최대(T21 / spec C — "최대 100").
 *
 * settings 의 `indexModeLimit` 도, 호출자가 body.limit 으로 명시한 값도 이 위로는
 * 못 올라간다. index 회신 총 토큰이 `limit × 건당 상한` 으로 위에서 닫히는 계약의
 * 절반이 이 상수다(나머지 절반은 search-index-mode.ts 의 ONE_LINE_MAX_CHARS).
 * parseLimit 은 거부가 아니라 *clamp* 라 101 을 넣으면 100 으로 접힌다 — 기존
 * limit 파싱 관례(전 통로 clamp)를 그대로 따른다.
 */
export const INDEX_MODE_LIMIT_MAX = 100;

/** settings 미주입 시 쓰는 index 건수 default — 스키마 default(40)와 같은 값. */
const INDEX_MODE_DEFAULT_LIMIT = 40;

/**
 * settings 의 index 건수 상한을 읽는다. 미주입(buildMemoryApi 직호출·테스트)이면
 * 스키마 default 와 같은 40 을 쓴다 — 설정 없이도 index 모드가 도는 것이 계약이고,
 * 스키마 default 와 다른 값을 여기 두면 두 곳이 조용히 갈린다.
 *
 * 값이 유효 범위를 벗어나면(0 이하·비정수·100 초과) 그 값을 그대로 믿지 않고
 * parseLimit 이 clamp 한다 — 이 함수는 default 후보만 고른다.
 */
function resolveIndexModeLimit(settings: MemorySettings | undefined): number {
  return settings?.search?.indexModeLimit ?? INDEX_MODE_DEFAULT_LIMIT;
}

/**
 * 장소 칸 신호를 해석한다(활용 단계4 T4 / D3). 우선순위:
 *   1. 명시 body.place(parsePlace)가 유효하면 그대로 — "딱 이 장소" 호출자 의도라
 *      query 자동 추출보다 우선한다(resolveDateRange 의 명시>자동 선례 정합).
 *   2. 없으면 query 안에서 *저장된 장소 leaf 이름*(store.listPlaceLeafNames)을 부분
 *      일치로 찾아 신호로 쓴다(A안·LLM 0·신규 장소 자동 커버). 직접 입력·추론 장소
 *      모두 포함(listPlaceLeafNames 가 has_place 두 경로 OR).
 *   3. 둘 다 없으면 undefined → 라우트가 placeValue 를 안 넘김 → 장소 가산 미적용
 *      (회귀 0). 소프트 가산이라 신호가 없어도 평소 검색과 같다(탈락 없음).
 *
 * 가장 긴 이름 우선(구체적 우선): listPlaceLeafNames 가 이름 길이 내림차순으로
 * 회신하므로, query 에 부분일치하는 *첫* 이름이 곧 가장 긴 매칭이다. '강남 A마트' 와
 * '강남' 이 둘 다 저장돼 있고 query 에 '강남 A마트' 가 있으면 긴 쪽('강남 A마트')을
 * 신호로 잡아 더 정확히 매칭한다. 조사 정규식(B안)은 안 쓴다 — 저장 이름 부분매칭
 * 만으로 신규 장소까지 커버되고 2단계 엔티티 확인이 불필요하다(plan D3).
 *
 * 정밀도: 저장 장소 이름이 query 의 부분문자열일 때만 신호다(짧은 우연 이름은 긴
 * 이름 우선 + 저장 장소만 후보라는 두 겹으로 완화). 소프트 가산이라 우연 매칭이
 * 나도 후보 탈락이 아니라 가산점만 더해지므로(다른 글 살아남음) 과도한 정밀 로직
 * 없이 저장 이름 부분매칭에 충실한다(plan D3 의도).
 *
 * query·leaf 이름 모두 toLowerCase 비교(저장 시점 정규화값 정합 / searchPlaceNodeScores).
 */
export function resolvePlaceSignal(
  rawPlace: unknown,
  query: string,
  store: SqliteMemoryStore,
): string | undefined {
  // 1. 명시 우선.
  const explicit = parsePlace(rawPlace);
  if (explicit) return explicit;

  // 2. query 자동 추출 — 저장 장소 이름 부분일치(가장 긴 이름 우선).
  const haystack = query.toLowerCase();
  for (const name of store.listPlaceLeafNames()) {
    // listPlaceLeafNames 는 이미 toLowerCase 저장값이라 그대로 비교. 빈 이름·공백은
    // 부분일치 의미가 없어 건너뛴다(정상 데이터엔 없지만 방어).
    const trimmed = name.trim();
    if (trimmed.length > 0 && haystack.includes(trimmed)) {
      return name; // 첫 매칭 = 가장 긴 이름(길이 내림차순 회신).
    }
  }
  return undefined;
}

/**
 * POST /search 파이프라인 본체. body 검증 + 하이브리드 검색 + 후처리 + 선택적
 * 컨텍스트 조립까지 REST 라우트와 MCP search_memory 도구가 공유하는 단일 실행부.
 *
 * searchParams 는 URL `?filter.<category>=`/`?memory_type=` 통로다. REST 라우트는
 * `new URL(c.req.url).searchParams` 를 그대로 넘기고, MCP 는 URL 통로가 없어
 * 빈 URLSearchParams 를 넘긴다(둘 다 없으면 필터 미적용 = 동작 불변).
 */
export async function runSearchPipeline(
  deps: MemoryApiDeps,
  body: SearchBody,
  searchParams: URLSearchParams,
  options?: SearchPipelineOptions,
): Promise<Record<string, unknown>> {
  const { retriever, assembler, store } = deps;

  if (!isPositiveString(body.query)) {
    throw new SearchInputError("query must be a non-empty string");
  }

  // NFC 정규화 경계(G3-a) — body.query 를 검증 직후 NFC 로 한 번 통일해 로컬
  // `query` 로 고정한다. 하류(날짜/장소 신호 추출, 캐시 키, retriever.retrieve,
  // 리랭커, 엔티티 채널, 응답 echo)가 모두 이 로컬을 쓴다 — 한 곳이라도 원본
  // body.query 를 다시 읽으면 NFC/NFD 입력에 따라 캐시 키·임베딩이 갈려 같은
  // 질의가 다른 결과·다른 캐시 슬롯을 만든다. trim 은 하지 않는다(질의 앞뒤
  // 공백 의미는 이 경계 밖 — 기존 파싱 계약 불변).
  const query = toNfc(body.query);
  let requestedScope;
  try { requestedScope = parseMemoryReadScope(body.scope); }
  catch (error) { throw new SearchInputError(`Invalid memory scope: ${error instanceof Error ? error.message : String(error)}`); }
  if (options?.resolvedScope !== undefined && requestedScope !== undefined) {
    throw new SearchInputError("scope must not be given twice (body.scope and a resolved scope)");
  }
  // 프로젝트 이름·별칭·번호·옛 글자값을 실제 project_id 값 묶음으로 해석한다. 모르는·애매한
  // 값은 ProjectScopeError 로 그대로 던진다(REST 400 / MCP 도구 오류 — 빈 결과로 가리지 않음).
  const scope = options?.resolvedScope ?? await resolveMemoryReadScope(store, requestedScope, "unfiltered");
  if (body.includeInactive !== undefined && typeof body.includeInactive !== "boolean") throw new SearchInputError("includeInactive must be a boolean");
  const includeInactive = body.includeInactive === true;

  // settings snapshot 한 번 — 캐시 키·retriever 노브·인접 청크 한도·요약 토글·
  // 하한선·index 건수 상한이 같은 호출 시점 값을 본다(deps.getSettings 동적
  // lookup — 구조분해 금지). T21 에서 index limit 이 이 값을 필요로 해 스냅샷
  // 위치가 limit 파싱 *앞* 으로 올라왔다(호출 1회 유지 — 이중 lookup 금지).
  const settings = deps.getSettings?.();

  // ── T21 회신 양식(spec C) ────────────────────────────────────────────────
  // "index" 는 본문 대신 색인만 회신하는 2단계 검색의 1회차다. 무효·부재는 전부
  // "full" 로 떨어져 이 칸을 모르는 호출자의 응답이 도입 전과 byte 동일하다.
  const responseMode = parseResponseMode(body.responseMode);

  // limit 상한이 양식별로 다르다(spec C) — full 은 건당 본문을 실어 50 이 상한이지만,
  // index 는 건당 한 줄(oneLine 120자 상한)이라 더 많이 실어도 회신이 감당된다.
  // default 도 갈린다: full 은 10, index 는 settings.search.indexModeLimit(40).
  // 하드 최대 100 은 여기 리터럴이 아니라 아래 INDEX_MODE_LIMIT_MAX 단일 출처다.
  //
  // **이 limit 이 캐시 키의 기존 `limit` 칸으로 그대로 흘러간다**(search-retrieval.ts
  // → SearchCacheKeyInput.limit). 캐시 키 신설 칸은 필요 없다 — responseMode 는
  // retriever 결과 자체를 안 바꾸고 그 뒤 후처리만 가르기 때문이다. 같은 질의를
  // 같은 limit 으로 full·index 두 번 부르면 두 번째가 캐시 hit 이 된다(spec C
  // "full/index 가 같은 RRF 캐시를 공유해 적중률이 오히려 오른다").
  const limit =
    responseMode === "index"
      ? parseLimit(
          body.limit,
          resolveIndexModeLimit(settings),
          INDEX_MODE_LIMIT_MAX,
        )
      : parseLimit(body.limit, 10, 50);
  const contextBudget =
    typeof body.contextBudget === "number" && body.contextBudget >= 0
      ? Math.floor(body.contextBudget)
      : 0;

  // project 칸은 문자열 + 공백 제거 후 1자 이상일 때만 retriever 에 전달한다.
  // 비문자열·빈 문자열이면 undefined — project expansion 없이 그대로 검색.
  const project =
    typeof body.project === "string" && body.project.trim().length > 0
      ? body.project.trim()
      : undefined;

  // polarity·filter 도 project 와 같은 방어 패턴 — 유효할 때만 retriever 에
  // 전달한다(부재·무효면 미전달 = 필터 미적용 = 1.1b 동작 불변). cue 검출은
  // retriever 가 query 에서 자동 수행하므로 라우트가 따로 파싱하지 않는다
  // (1.1c T2 — query 토큰 불변 / 채널 가중치 조정만).
  const polarity = parsePolarity(body.polarity);
  const bodyFilter = parseFilter(body.filter);

  // memory_type 한정 필터(1.2 / 통일 원칙) — polarity 방어 패턴 그대로. body 의
  // camelCase·snake_case 둘 다 받고, URL ?memory_type= 통로도 같은 값으로 흡수한다
  // (body 우선 — 명시 body 가 query 보다 강하다). 유효 enum 일 때만 retriever 로
  // 전달해 RRF 합산 *전* 후보를 줄인다(가중치 아님 — RRF 코어 불변). 부재·무효면
  // 미전달 = 필터 미적용(전 후보 통과 / 도입 전 동작 불변).
  const memoryType =
    parseMemoryType(body.memoryType) ??
    parseMemoryType(body.memory_type) ??
    parseMemoryType(searchParams.get("memory_type")) ??
    parseMemoryType(searchParams.get("memoryType"));

  // Phase 11b T6 — URL searchParams 의 `?filter.<category>=<값>` 양식을
  // 옛 body.filter 양식과 합쳐서 retriever 의 filter 칸으로 흘려보낸다.
  // 옛 body 통로는 그대로 보존하고 URL 통로만 추가. 같은 카테고리가 URL
  // 에 두 번 들어오는 케이스(`filter.character=A&filter.character=B`)도
  // mergeFilters 가 별 키로 보관해서 retriever step 4.5 (c) 의
  // Object.values 순회 양식과 자연 정합(모든 값이 passSets 에 추가 →
  // AND 교집합). retriever / rrf / search-tuning 코어 코드는 한 글자도
  // 안 건드림.
  const urlClassificationFilters =
    parseClassificationFiltersFromSearchParams(searchParams);
  const filter = mergeFilters(bodyFilter, urlClassificationFilters);

  // 검색 시간 범위(Phase 7 갈래 1 / Task 5) — 명시 since/until 우선, 없으면
  // 검색어에서 닫힌 시간 표현 자동 추출. 지정되면 retriever 가 RRF 합산 *전*
  // COALESCE(event_at, created_at) 후보를 이 구간으로 거른다(RRF 코어 불변).
  // 시간 표현 없으면 undefined → 필터 미적용(전 후보 통과 / 회귀 0).
  const dateRange = resolveDateRange(body.since, body.until, query, new Date());

  // 장소 칸 소프트 가산 신호(활용 단계4 T2·T4 / search-field-filter D6·D3) — 명시
  // body.place 우선, 없으면 query 에서 저장 장소 이름 부분일치 자동 추출
  // (resolvePlaceSignal·LLM 0). 유효하면 retriever 가 RRF 합산 후 step 9 점수에
  // 장소 매칭 글 가산점을 더한다(후보 축소 아님 — 표기 흔들림 대응). 명시·자동 둘 다
  // 없으면 undefined → 미전달 = 미적용 = byte 동일(회귀 0).
  const placeValue = resolvePlaceSignal(body.place, query, store);

  // 종류·종류별 칸 검색 캡슐(활용 단계6 T4) — project·filter 와 같은 방어 파싱.
  // 유효할 때만 retriever 에 전달한다(부재·무효면 미전달 = 필터 미적용 = 도입 전
  // byte 동일). kind 는 종류 분류 글로, fieldFilters 는 그 종류 칸값 글로 RRF 합산
  // *전* 후보를 줄인다(가중치 아님 — RRF 코어 불변). 둘 다 지정되면 AND 교집합.
  const kindFilter = parseKind(body.kind);
  const fieldFilters = parseFieldFilters(body.fieldFilters);
  const imageSearch = parseImageSearch(body.imageSearch);

  // ── R4 캐시 + retriever 실행 + 명시 relaxed 2-pass — search-retrieval.ts ──
  //
  // T21 수정 1회차(Medium 1) — index 모드는 `contextBudget` 을 0 으로 고정해 넘긴다.
  // 이 값은 캐시 키 칸(10)이라(search-cache.ts) 그대로 흘리면 budget 만 다른 index
  // 호출끼리도 슬롯이 갈린다. index 는 컨텍스트를 *아예 조립하지 않으므로* 0 이
  // 의미상 정확한 값이다 — "조립 분기" 칸에 "조립 안 함"을 그대로 적는 것이라
  // 캐시를 속이는 게 아니다.
  //
  // 효과 범위를 정확히 적어 둔다: 이 고정은 **budget 이 어떻든 모든 index 호출을 한
  // 슬롯으로 모으고, budget 없는 full 호출과도 슬롯을 공유하게** 한다. 다만
  // budget > 0 인 full 호출과는 여전히 갈리는데, 그쪽은 컨텍스트를 실제로 조립하므로
  // 조립 분기 값이 다른 것이 맞다(같은 슬롯에 넣으면 캐시가 거짓말을 한다).
  const timer = new StageTimer(); // 단계 시간(speed-step1 5.2) — 로그 한 줄용
  const outcome = await runSearchRetrieval(deps, store, retriever, settings, {
    scope,
    includeInactive,
    query,
    limit,
    contextBudget: responseMode === "index" ? 0 : contextBudget,
    project,
    polarity,
    filter,
    dateRange,
    memoryType,
    placeValue,
    kindFilter,
    fieldFilters,
    imageSearch,
    relaxFilters: body.relaxFilters === true,
  });
  const retrievalMs = timer.lap("retrieval");
  let results = outcome.results;
  // 부가 출력(부모 치환·이웃 청크·요약·엔티티·개념 확장·캡션)은 결과가 아닌 다른 노드·
  // 문서에서 온다. 응답 하나에 판정기 하나를 두고 결과 필터와 모든 부가 출력이 같은
  // 스냅샷 보기를 쓴다 — 항목마다 실제 출처를 판정하고, 실제로 뺀 항목이 있는 종류만
  // omittedAncillary 에 적는다(WP-B1-03 / search-ancillary-visibility.ts).
  const ancillary = readAncillaryVisibility(store, scope, includeInactive);
  results = results.filter((result) => ancillary.admits(result.node.id));
  const ancillaryMs = timer.lap("ancillary");
  const { searchMode, relaxed, strictCount, removedFilters, stats, appliedFilters } =
    outcome;

  // ── R5 리랭커 (6b T6 / spec 10.2.3 캐시↔리랭커 순서 / 11.1.1) ────────────
  // 위 results 는 *리랭커 이전* 운영 최종 점수(중립 RRF + cue 가중치) 결과다.
  // 캐시에 들어가는 값도 바로 이 리랭커 이전 결과다(retrieval 안 set 은 재정렬
  // 전에 끝남) — 리랭커는 캐시 hit/miss 둘 다 그 뒤에 오는 별도 단계라 그 산출은
  // 캐시하지 않는다(spec 10.2.3). 그래서 같은 query 가 캐시 hit 이어도 리랭커는
  // 다시 돈다.
  //
  // deps.reranker 가 주입됐을 때만 가동한다 — createMemoryApi 는
  // settings.reranker.enabled 가 true 일 때만 인스턴스를 채운다. undefined 면
  // 이 단계를 통째로 건너뛰어 RRF 순서·점수가 pre-6b 와 byte 동일하다(회귀 0 /
  // 정직한 토글 OFF). 모델 로드 실패(available=false)면 인스턴스는 있되 rerank 가
  // RRF 순서를 정직하게 회신한다(spec 11.2 degrade). 입력 상위 N(topKInput) 선별·
  // 회신 상위 N(topKOutput) 한도·정렬은 Reranker 가 책임진다(라우트는 wiring 만).
  const rerankerStage = deps.reranker;
  let rerank: SearchTimingRecord["rerank"] = null;
  if (rerankerStage) {
    const reranked = await rerankerStage.rerankWithStats(query, results);
    results = reranked.results;
    rerank = { ms: timer.lap("rerank"), stats: reranked.stats };
  }

  // ── T20 결과 하한선 (spec F / 결정 D-B / 단락 11 확정 3) ────────────────
  // 무관한 글로 top-k 를 채우던 동작을 여기서 끝낸다. 하한선 미달 결과는 목록에서
  // 버리고, 전부 미달이면 0건을 그대로 회신한다(빈 결과가 정직한 상태 — D-B).
  //
  // **적용 위치가 계약이다**: 캐시·리랭커 *뒤*, enrich 후처리 *앞*(D-D).
  //   - 캐시 뒤라서 SearchCacheKeyInput 확장이 불필요하다 — 캐시는 리랭커 이전 RRF
  //     결과를 보관하고 하한선은 그걸 읽은 뒤의 후처리 단계라, 계수를 바꿔도 캐시
  //     무효화 없이 즉시 반영되고 AI·대시보드 두 경로가 같은 캐시 슬롯을 계속 공유한다.
  //   - enrich 앞이라서 탈락 결과의 후처리 비용을 아예 안 쓴다 — 아래 개념 펼침
  //     (buildEnriched)·인접 청크·요약 합류·revision 플래그가 전부 걸러진 뒤의
  //     결과만 본다. 하한선이 동작 비용을 오히려 낮추는 자리다.
  //
  // 관측 대상은 융합 점수가 아니라 components.vectorRawCosine 이다(T19 실측 —
  // 융합 점수로는 무관 결과와 정답이 안 갈린다). 판정은 search-result-floor.ts.
  const floorOutcome = applyResultFloor(
    results,
    settings,
    options?.applyResultFloor === true,
  );
  results = floorOutcome.kept;
  const floorMs = timer.lap("floor");
  // 두 갈래(index·full) 모두 return 직전에 한 번 부른다. 질의 글은 길이만 쓴다.
  const logTiming = (resultCount: number, tail: SearchTimingRecord["tail"]): void => {
    console.log(formatSearchTimingLine({
      totalMs: timer.elapsed(), floorOn: floorOutcome.applied, queryChars: query.length,
      resultCount, retrievalMs, passes: outcome.passes, ancillaryMs, rerank, floorMs, tail,
    }));
  };

  // ── T21 index 모드 분기 (spec C) ─────────────────────────────────────────
  // 여기서 갈라져 아래 무거운 후처리를 통째로 건너뛴다. **분기 위치가 계약이다**:
  //   - 하한선 *뒤* 라서 index 모드도 AI 경로 하한선을 그대로 탄다(T20 과 같은
  //     플래그·같은 판정). 무관 질의는 index 모드에서도 0건이 정직하게 나온다.
  //   - enrich *앞* 이라서 개념 펼침(buildEnriched → getNodeConceptExpansion)·
  //     인접 청크·자식→부모 dedup·revision 플래그·관계요약·컨텍스트 조립이
  //     아예 안 돈다. 색인 회신이 지연·토큰을 함께 줄이는 근거가 이 생략이다(D-D).
  //   - **엔티티 채널의 store.embedQuery 도 여기서 끊긴다** — 그 호출은 아래에
  //     있어서 index 모드는 도달조차 하지 않는다. 쿼리 임베딩(콜드 추론 수초)이
  //     1회차에서 통째로 빠지는 것이 spec C 가 지목한 절감분이다.
  //
  // processing_info — **index 회신은 하한선 토글과 무관하게 생존자 기준으로 센다**
  // (수정 1회차 Low). full 모드는 하한선 미적용 시 `stats.afterFiltering`(retriever 가
  // limit 절단 *전* 에 잰 수)을 그대로 써서 도입 전 byte 동일을 지키지만, index 는
  // 애초에 새 회신 양식이라 지킬 옛 계약이 없다. 그런데 index limit 은 최대 100 까지
  // 열려 있어 절단 전후 모집단 차이가 full(최대 50)보다 크게 벌어진다 — 하한선을 끈
  // 순간 `afterFiltering`(절단 전 9) 과 `returned`(절단 후 3) 가 다른 것을 세는
  // 상태가 된다. 두 수가 같은 모집단을 가리키도록 index 는 항상 손에 든 결과 수를
  // 센다(totalFound >= afterFiltering >= returned 단조성 유지).
  if (responseMode === "index") {
    const indexItems = await buildIndexItems(store, results, ancillary);
    const indexMs = timer.lap("index");
    const omittedAncillary = ancillary.omittedKinds(indexItems.map((item) => item.id));
    const indexProcessingInfo: ProcessingInfo = {
      totalFound: stats.totalFound,
      afterFiltering: results.length,
      // dedup 으로 항목이 합쳐질 수 있어 afterFiltering 과 다를 수 있다 — 실제로
      // 회신한 항목 수를 그대로 센다.
      returned: indexItems.length,
      // index 모드는 컨텍스트 조립을 안 한다 — 예산 절단이 원천적으로 발생할 수
      // 없으므로 0 이 정직한 값이다(fallback 아님 / T10 contextBudget=0 선례와 동형).
      trimmedByBudget: 0,
    };
    logTiming(indexItems.length, { kind: "index", indexMs });
    return {
      query,
      responseMode,
      count: indexItems.length,
      results: indexItems,
      ...(omittedAncillary.length > 0 ? { omittedAncillary } : {}),
      // 절단은 항상 포인터 동반(spec C) — oneLine 이 조각이라는 사실과 본문을
      // 어디서 받는지를 회신 자체가 말한다. 문구는 search-index-mode.ts 단일 출처.
      pointer: POINTER_SENTENCE,
      searchMode,
      relaxed,
      strictCount,
      removedFilters,
      processing_info: indexProcessingInfo,
      appliedFilters,
      ...(scope ? { appliedScope: scope } : {}),
    };
  }

  // 결과 노드 종류(kind) 배지 — 글 본문(r.node.content)을 콜론 명시일 때만
  // (explicitDisplayKind) 한국어 배지로 바꾼다(2026-06-28 "종류" 허브 버그 수정·spec
  // §4.3 + 2026-07-06 평문 자동 추론 범위 조이기 Task 3·P-2). 옛 코드는
  // store.getNodeKinds(글의 "종류" 분류 꼬리표)에서 배지를 읽었는데, 그 꼬리표가
  // 그래프의 "종류" 허브 노드를 만든 데이터 출처라 ingest 가 자동 승격을 끊었다.
  // explicitDisplayKind 는 콜론 명시(source "explicit")일 때만 배지를 인정하고 평문
  // 어휘 경계(source "seed")는 null 로 접는다 — 저장 측(ingest 종류값 노드·Task 2)과
  // 같은 규칙을 공유해, 평문 "클로드 코드"의 "코드"가 material 배지를 달던 저장·표시
  // 불일치를 없앤다. 순수 함수 조합이라 추가 DB 조회 0(본문은 이미 손에 있음).
  // 본문에 종류 신호 없는 노드는 Map 에 키가 없어 아래에서 null 로 떨어진다(가짜 0 금지).
  // 검색 캡슐(kind·fieldFilters)은 retriever 가 개념 이름 매칭으로 이미 처리했고, 여기는
  // 응답 표시 배지만 산출한다(검색 로직 무접촉).
  const displayKindByNodeId = new Map<number, string>();
  for (const r of results) {
    const kind = explicitDisplayKind(r.node.content);
    if (kind !== null) {
      displayKindByNodeId.set(r.node.id, kind);
    }
  }

  // 결과 노드마다 개념 1단계 펼침을 합류(1.1a T6). getNodeConceptExpansion 이
  // async 라 Promise.all 로 병렬 조회. 결과 개수가 limit(최대 50) 이라 N+1 부담 작음.
  //
  // neighbors/documentRef 는 *모든* 항목에 default(빈 배열 / null)로 먼저 더한다 —
  // 아래 후처리가 상위 K document_chunk 항목만 채워 일반 노드는 빈 상태로 남는다.
  // 이 매핑은 results 순서를 그대로 유지하므로 RRF 순위·점수·count 가 불변이다.
  const enriched: SearchEnrichedResult[] = await Promise.all(
    results.map((r) =>
      // 11b T7 — image_asset 노드 분기 표시 통로(buildEnriched 헬퍼).
      // 이 매핑은 results 순서를 그대로 유지하므로 RRF 순위·점수·count 가 불변이다.
      buildEnriched(
        store,
        r.node,
        r.score,
        r.sources,
        r.components,
        displayKindByNodeId.get(r.node.id) ?? null,
        ancillary,
      ),
    ),
  );

  const enrichMs = timer.lap("enrich");

  // ── 14b T3 인접 청크 + 문서 ref 후처리 — search-post-process.ts ─────────
  // maxContextTokens 는 settings.chunking 에서 흘러 들어온다(T2). settings 미주입
  // (buildMemoryApi 직호출 / 테스트)이면 DEFAULT_MAX_CONTEXT_TOKENS(2000) 로 degrade.
  const maxContextTokens =
    settings?.chunking?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  applyNeighborContext(store, results, enriched, maxContextTokens, ancillary);

  // ── 자식 노드 → 부모 원본 치환 + dedup — search-post-process.ts ──────────
  const dedupedResults = await dedupChildToParent(store, enriched, ancillary);

  // ── Phase 7 ④ Task 7 revision 양방향 플래그 — search-post-process.ts ─────
  await applyRevisionFlags(store, dedupedResults);

  // ── WP-B1-10(SL-3 표시) 열린 충돌 표시 — search-post-process.ts ──────────
  applyOpenConflicts(store, dedupedResults);

  // ── Phase 7 둘째 단계 Task 8 요약 검색 채널 — search-post-process.ts ─────
  await applySummaries(store, settings, body.withSummaries, dedupedResults, ancillary);
  const postMs = timer.lap("post");

  // ── 새 종류 검색 별 통로 entityHits (분류 단계3 T5·D14) ──────────────────
  // 새 종류(사용자가 화면으로 더한 종류) 엔티티를 *엔티티 자체* 로 찾는 별 통로다.
  // retriever.retrieve()·rrf.ts·점수식 6파일을 호출조차 안 한다 — 위 results
  // (글 RRF) 조립과 완전히 분리된 칸이다(공백 1·2 무접촉·compute.ts 선례). 쿼리
  // 임베딩은 store.embedQuery 로 1회 만들어 entities_vec KNN 입력으로 쓰고,
  // entities_fts BM25 와 문자열 키 RRF 로 엔티티끼리 합산한다.
  //
  // 성능 게이트(D14·plan "새 종류 0개 byte 동일"의 성능 측면): 새 종류가 0개면
  // entities_fts·entities_vec 가 비어 검색이 무의미한데, store.embedQuery 는 쿼리를
  // 모델로 임베딩한다(콜드 추론 ~수초). 그 비용을 새 종류 0개일 때 통째로 건너뛰어야
  // 검색 성능이 도입 전과 같다. 명부 존재 검사(listUserEntityTypes — 작은 entity_types
  // 테이블 prepared 쿼리)는 임베딩 대비 무시 가능한 비용이다. 새 종류 없음 = 정직한
  // 빈 결과(silent fallback 아님 — 데이터가 진짜 없는 상태를 그대로 회신).
  //
  // WP-B1-03 — 엔티티는 결과가 아닌 출처 노드에서 만들어진다. 출처 판정에 걸린 엔티티는
  // 빼고 다음 순위가 자리를 채운다(ancillary.admitsEntityHit).
  let entityHits: EntitySearchHit[] = [];
  let entityEmbedMs: number | null = null;
  const hasUserEntityTypes =
    store.entityTypeRegistryDb.listUserEntityTypes().length > 0;
  if (hasUserEntityTypes) {
    const entityQueryVec = await store.embedQuery(query);
    entityEmbedMs = timer.lap("entityEmbed");
    entityHits = await retrieveEntities(
      store.entitiesRepo,
      query,
      entityQueryVec,
      limit,
      (entityId) => ancillary.admitsEntityHit(entityId),
    );
  }
  const entityMs = timer.lap("entity");
  // 모든 부가 출력 단계가 끝난 뒤 — 실제로 표시한 항목에서 뺀 부가 출력이 있는 종류만
  // (부모로 바뀌어 안 보이는 자식의 개념 펼침 생략은 세지 않는다).
  const omittedAncillary = ancillary.omittedKinds(dedupedResults.map((item) => item.id));

  // T10 — processing_info.trimmedByBudget 은 컨텍스트 조립이 예산 초과로 뺀
  // 메모리 수(ContextAssembler.memoriesTrimmed 그대로 노출 — 재계산 0). contextBudget
  // 이 0(미지정)이면 조립 자체가 안 돌아 trim 이 원천적으로 발생할 수 없으므로
  // 0(정직한 값 — fallback 아님). assemble() 은 여기서 한 번만 호출해 response.context
  // 와 processing_info 양쪽이 같은 산출을 공유한다(D-D — 중복 조립 0).
  const assembled =
    contextBudget > 0
      ? assembler.assemble(results, { memoryBudget: contextBudget, scope, includeInactive })
      : undefined;

  const assembleMs = assembled ? timer.lap("assemble") : null;

  // T10 — processing_info(spec B 항목1). afterFiltering 의 의미는 **"이 단계에서
  // 모든 거름망(retriever 필터 + T20 하한선)을 통과해 살아남은 수"** 다(context
  // 예산 절단 전 — 그건 trimmedByBudget 칸이 따로 본다).
  //
  // T20 — 하한선이 돌았으면 *생존자를 직접 센다*. 뺄셈을 쓰지 않는 이유가 있다:
  // stats.afterFiltering 은 retriever 가 limit 절단 *전* 에 잰 수인데(retriever.ts
  // 가 `results.length` 를 `slice(0, limit)` 앞에서 캡처) 하한선은 이미 절단된
  // 배열을 거른다. 모집단이 달라서 코퍼스가 limit 보다 크면 뺄셈이 어긋난다 —
  // 실제로 코퍼스 12·limit 3 에서 전건 탈락인데도 afterFiltering 9 가 나와 D-B 의
  // 정직한 0 신호가 뒤집혔다(2026-08-03 수정 순환 1회차 재현). 리랭커 topKOutput
  // 절단까지 겹치면 음수도 가능했다.
  //
  // 생존자 기준이면 세 수가 항상 단조롭다(totalFound >= afterFiltering >= returned).
  // 하한선 미적용(대시보드 경로·토글 OFF)이면 stats 값을 그대로 써 기존 동작과
  // byte 동일하다 — 그 경로에서는 limit 절단 전 의미가 유지된다.
  //
  // 전부 하한선에 걸리면 totalFound > 0 인데 afterFiltering = 0 이 된다. 이것이
  // D-B 가 의도한 정직한 회신이다 — AI 가 "기억이 아예 없음"과 "있었지만 관련
  // 있는 게 없음"을 구분해서 읽는다.
  const processingInfo: ProcessingInfo = {
    totalFound: stats.totalFound,
    afterFiltering: floorOutcome.applied
      ? results.length
      : stats.afterFiltering,
    returned: dedupedResults.length,
    trimmedByBudget: assembled?.memoriesTrimmed ?? 0,
  };

  const response: Record<string, unknown> = {
    query,
    count: dedupedResults.length,
    results: dedupedResults,
    ...(omittedAncillary.length > 0 ? { omittedAncillary } : {}),
    searchMode,
    relaxed,
    strictCount,
    removedFilters,
    // 글 results 와 완전히 분리된 칸(D14-1) — 새 종류 0개면 [] 라 기존 소비처 무해.
    entityHits,
    // T10 — 항상 존재하는 두 칸(additive only / 기존 칸 무변경).
    processing_info: processingInfo,
    appliedFilters,
    // 실제로 적용한 읽기 범위(해석 결과). 범위를 안 주면 거름이 없어 칸을 생략한다.
    ...(scope ? { appliedScope: scope } : {}),
  };

  if (assembled) {
    response.context = {
      memoryBlock: assembled.memoryBlock,
      tokensUsed: assembled.tokensUsed,
      memoriesIncluded: assembled.memoriesIncluded,
      memoriesTrimmed: assembled.memoriesTrimmed,
    };
  }

  logTiming(dedupedResults.length, {
    kind: "full", enrichMs, postMs, assembleMs,
    entity: hasUserEntityTypes ? { ms: entityMs + (entityEmbedMs ?? 0), embedMs: entityEmbedMs } : null,
  });
  return response;
}
