/**
 * compute-tab.js — 계산 탭 순수 로직 (활용 단계6b T4 / spec §4.4·§5·§6).
 *
 * 대시보드 메인 화면 `[검색][계산]` 탭의 계산 패널이 쓰는 순수 함수 묶음이다. DOM·fetch
 * 부수효과는 index.html 인라인 스크립트가 맡고, 이 모듈은 입력값을 받아 출력값만 돌려준다
 * (테스트가 fixture 로 검증 가능하게 한 분리). 빌드 도구 없이 브라우저가 그대로 읽는 ES
 * 모듈이라 .ts → .js 번들 단계를 안 거친다(정적 HTML 정신·ingest-form.js 선례).
 *
 * 사용자 노출 문자열은 COMPUTE_TEXT 한 곳에 모은다(인라인 색·하드코딩 금지·단계4·5 위젯
 * 선례). 결과 표시는 세 경우를 정직하게 가른다(spec §4.4·Mock Policy):
 *   1) 진짜 합 0   — value:0 + numericFieldPresent:true + excludedCount:0 → "0원" 그대로.
 *   2) 칸 부재     — numericFieldPresent:false → "수치 데이터 없음"(0 위장 아님).
 *   3) 못 읽는 값  — excludedCount>0 → 합계 + "N건은 숫자가 아니라 제외함".
 *                     읽힌 값이 0건(readCount:0)이면 "읽을 수 있는 값 없음".
 * "읽힌 값 0건" 판단은 백엔드 readCount 로 한다 — count 는 총 글 수라 전부 못 읽어도 양수다
 * (count 로 판단하면 "전부 못 읽음"을 "0 합계"로 오인한다·C1).
 * AVG 분모 B(하루/주/달/해) 라벨은 칸 부재(case2)일 때 덧쓰지 않는다 — 칸 부재 분기를
 * 분모 표기보다 먼저 처리한다(§4.4 case2).
 *
 * 라우트(/compute)의 400 에러 message 는 영어 API 문구다. 사용자가 보는 화면은 이 모듈의
 * localizeComputeError 가 한국어로 옮긴다(라우트 영어 문구를 그대로 노출하지 않는다).
 */

// ── 중앙 문자열 (사용자 노출 — 하드코딩 금지) ─────────────────────────────────

export const COMPUTE_TEXT = {
  // 연산 스위치(개수/더하기/평균) — op 값은 라우트 ComputeKind 와 정합(count/sum/avg).
  ops: [
    { value: "count", label: "개수" },
    { value: "sum", label: "더하기" },
    { value: "avg", label: "평균" },
  ],
  opLabel: "연산",
  // 평균 기준(분모) — 'count'=한 건당(분모 A) / day·week·month·year=시간단위당(분모 B).
  divisors: [
    { value: "count", label: "한 건당" },
    { value: "day", label: "하루" },
    { value: "week", label: "주" },
    { value: "month", label: "달" },
    { value: "year", label: "해" },
  ],
  divisorLabel: "기준",
  computeButton: "계산하기",
  computing: "계산 중...",
  // 결과 헤더(연산별).
  headerByKind: {
    count: "개수",
    sum: "합계",
    avg: "평균",
  },
  countUnit: "건",
  // 분모 B 표기(평균 기준별) — "하루 평균" 처럼 헤더에 붙는다. count(한 건당)는 "평균".
  avgPrefixByDivisor: {
    count: "",
    day: "하루",
    week: "주",
    month: "달",
    year: "해",
  },
  // 정직한 상태 문구(세 경우 구분).
  noNumericField: "이 종류에 숫자형 칸이 없음",
  numericFieldAbsent: "수치 데이터 없음",
  noReadableValue: "읽을 수 있는 값 없음",
  // 검색 탭 정렬 토글(단계6b T6·(가)) — 관련순(default)=POST /search·시간순=POST /compute kind=timeline.
  sortLabel: "정렬",
  sortRelevance: "관련순",
  sortTime: "시간순",
  // 시간순 글 목록 렌더 — 시각 부재 표기·정직한 빈 목록 안내(가짜 행 0).
  noDate: "(시각 미상)",
  timelineEmpty: "이 조건에 맞는 글이 없습니다.",
  // "N건은 숫자가 아니라 제외함" — n 을 끼운다.
  excludedNote: (n) => `${n}건은 숫자가 아니라 제외함`,
  // 라우트 영어 400 → 한국어. 정확 일치가 없으면 errorFallback 으로 원문을 보여 준다.
  errorByApiMessage: {
    "field required for sum/avg": "더할 칸을 골라주세요.",
    "period required for time-unit average — specify since/until or a date phrase in query":
      "기간을 골라주세요 (하루/주/달/해 평균은 기간이 필요합니다).",
    "query must be a non-empty string": "검색어나 종류를 입력해주세요.",
    "condition required": "종류·기간·장소·프로젝트 중 하나 이상으로 좁혀주세요.",
    "no aggregate intent detected — use /search for similarity queries":
      "이 질의는 검색에 맞습니다 — 검색 탭을 써주세요.",
  },
  // 한국어 매핑이 없을 때 — 원문 영어를 가리지 않고 그대로 덧붙여 정직하게 보인다.
  errorFallback: (raw) => `계산할 수 없습니다 — ${raw}`,
};

// ── 순수 로직 (단위 테스트 대상) ──────────────────────────────────────────────

/**
 * 한 종류의 columns 배열에서 숫자형 칸(dataType==="number")만 추린다.
 * GET /api/entity-types 응답 columns[].dataType 를 읽는다(T1 노출). 비배열·빈 입력은 빈 배열.
 * @param {Array<{key: string, label: string, dataType?: string}>} cols
 * @returns {Array<{key: string, label: string}>}
 */
export function filterNumericColumns(cols) {
  if (!Array.isArray(cols)) return [];
  return cols
    .filter((c) => c && c.dataType === "number")
    .map((c) => ({ key: c.key, label: c.label }));
}

/**
 * 계산 탭 입력을 api.compute opts 로 조립한다. 값 있는 칸만 합류한다(빈 값은 키 생략 —
 * 라우트가 미전달로 본다). 연산(op)별 규칙:
 *   - count → kind:"count" (field·avgDivisor 미포함·숫자형 칸 불요).
 *   - sum   → kind:"sum" + field (합산할 숫자형 칸).
 *   - avg   → kind:"avg" + field + (기준이 'count'(한 건당) 아니면) avgDivisor.
 * 종류(concept)·프로젝트·기간(since/until)·장소는 값 있을 때만 합류한다(단계5 정합).
 *
 * @param {object} input
 * @param {string} input.op         'count'|'sum'|'avg'
 * @param {string} [input.concept]  집계 대상 종류
 * @param {string} [input.project]  프로젝트
 * @param {string} [input.since]    기간 시작(YYYY-MM-DD)
 * @param {string} [input.until]    기간 끝(YYYY-MM-DD)
 * @param {string} [input.place]    장소
 * @param {string} [input.field]    숫자형 칸 키(sum/avg)
 * @param {string} [input.divisor]  평균 기준('count'|'day'|'week'|'month'|'year')
 * @returns {object}  api.compute(query, opts) 의 opts
 */
export function buildComputePayloadOpts(input = {}) {
  const op = typeof input.op === "string" ? input.op : "";
  const opts = {};
  if (op) opts.kind = op;
  const trim = (v) => (typeof v === "string" ? v.trim() : "");
  const concept = trim(input.concept);
  if (concept) opts.concept = concept;
  const project = trim(input.project);
  if (project) opts.project = project;
  const since = trim(input.since);
  if (since) opts.since = since;
  const until = trim(input.until);
  if (until) opts.until = until;
  const place = trim(input.place);
  if (place) opts.place = place;
  // 개수(count)는 숫자형 칸·분모 불요 — field·avgDivisor 를 안 싣는다.
  if (op === "sum" || op === "avg") {
    const field = trim(input.field);
    if (field) opts.field = field;
  }
  if (op === "avg") {
    const divisor = trim(input.divisor);
    // 'count'(한 건당·분모 A)는 avgDivisor 미전달 — 시간단위당(분모 B)만 단위를 보낸다.
    if (divisor && divisor !== "count") opts.avgDivisor = divisor;
  }
  return opts;
}

/** 숫자를 천단위 콤마로 다듬는다(표시용·소수는 그대로). 비유한수는 String 그대로. */
function formatNumber(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n);
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

/**
 * /compute 응답을 사람이 읽는 결과 조각으로 푼다(렌더 텍스트 분기·DOM 아님·순수).
 * 세 경우를 정직하게 가른다(spec §4.4·Mock Policy). 반환:
 *   { header, headline, notes }
 *     header   — 결과 헤더("합계"/"하루 평균"/"개수" 등). avg 분모 B 표기 포함.
 *                단, 칸 부재(case2)면 분모 표기를 덧쓰지 않는다(§4.4 case2).
 *     headline — 강조 숫자/문구. count 는 개수, sum/avg 는 값 또는 상태 문구.
 *     notes    — 정직한 부가 줄(제외 안내·칸 부재 안내). 없으면 빈 배열.
 *
 * @param {object} data  { kind, count, value?, numericFieldPresent?, readCount?,
 *                         excludedCount?, avgDivisor?, avgDivisorKind? }
 * @returns {{ header: string, headline: string, notes: string[] }}
 */
export function describeComputeResult(data) {
  const kind = data && typeof data.kind === "string" ? data.kind : "";

  // 개수(COUNT) — 단계5 재사용. 숫자형 칸 무관.
  if (kind === "count") {
    const n = typeof data.count === "number" ? data.count : 0;
    return {
      header: COMPUTE_TEXT.headerByKind.count,
      headline: `${formatNumber(n)}${COMPUTE_TEXT.countUnit}`,
      notes: [],
    };
  }

  // 평균 분모 B 표기 — avg 일 때만. 'count'(한 건당)는 접두사 없음("평균").
  const avgPrefix =
    kind === "avg"
      ? COMPUTE_TEXT.avgPrefixByDivisor[data.avgDivisorKind ?? "count"] ?? ""
      : "";
  const baseHeader = COMPUTE_TEXT.headerByKind[kind] ?? kind;
  const headerWithPrefix = avgPrefix ? `${avgPrefix} ${baseHeader}` : baseHeader;

  // case2 — 숫자형 칸 부재. 분모 표기보다 먼저 처리한다(칸 부재가 분모 표기를 가린다·§4.4).
  if (data.numericFieldPresent === false) {
    return {
      header: baseHeader, // 분모 표기 없이 기본 헤더만(분모 라벨을 칸 부재 위에 덧쓰지 않음).
      headline: COMPUTE_TEXT.numericFieldAbsent,
      notes: [],
    };
  }

  const excluded =
    typeof data.excludedCount === "number" && data.excludedCount > 0
      ? data.excludedCount
      : 0;
  // 읽힌 숫자 건수는 백엔드 readCount 로 본다(C1). data.count 는 총 글 수라 전부 못 읽어도
  // 양수 — 그걸로 판단하면 "0 건 읽힘"을 "0 합계"로 오인한다. readCount 미정의(옛 응답·방어)
  // 면 0 으로 보아 case3 변형("읽을 수 있는 값 없음")으로 빠진다 — 0 위장보다 정직하다.
  const readableCount = typeof data.readCount === "number" ? data.readCount : 0;
  const notes = excluded > 0 ? [COMPUTE_TEXT.excludedNote(excluded)] : [];

  // case3 변형 — 못 읽는 값만 있고 읽힌 값이 0건. 합계/평균을 0 으로 보이면 오인(특히 avg
  // 의 0/divisor). "읽을 수 있는 값 없음" + 제외 안내로 정직 표시.
  if (excluded > 0 && readableCount === 0) {
    return {
      header: headerWithPrefix,
      headline: COMPUTE_TEXT.noReadableValue,
      notes,
    };
  }

  // case1 + case3(읽힌 값 있음) — 실제 합/평균값. value:0 + 칸 present + 제외 0 이면 진짜 0.
  const value = typeof data.value === "number" ? data.value : 0;
  return {
    header: headerWithPrefix,
    headline: formatNumber(value),
    notes,
  };
}

/**
 * describeComputeResult 의 산출(header·headline·notes)을 결과 DOM 노드 배열로 조립한다.
 * el 팩토리를 주입받아(index.html 의 el 헬퍼·테스트의 동일 시그니처) DOM 라이브러리 결합을
 * 피한다 — 순수 조립이라 happy-dom 으로 세 경우의 노드 구조를 검증할 수 있다.
 *
 * 구조: results-header(section-title=header) + compute-headline(강조 숫자/문구) + notes 각
 * 한 줄(compute-note). 색·클래스는 theme 토큰 CSS 가 입힌다(인라인 색 0).
 *
 * @param {object} data  /compute 응답
 * @param {(tag: string, props?: object, ...children: any[]) => HTMLElement} el  노드 팩토리
 * @returns {HTMLElement[]}  결과 자리에 넣을 노드 배열
 */
export function buildComputeResultNodes(data, el) {
  const r = describeComputeResult(data);
  const nodes = [
    el(
      "div",
      { className: "results-header" },
      el("span", { className: "section-title" }, r.header),
    ),
    el("div", { className: "compute-headline" }, r.headline),
  ];
  for (const note of r.notes) {
    nodes.push(el("div", { className: "compute-note" }, note));
  }
  return nodes;
}

/**
 * /compute kind=timeline 응답의 items 를 시간순 글 목록 DOM 으로 조립한다(단계6b T6·(가)).
 * T4 가 들어낸 stage5 timeline item 렌더(compute-item·compute-item-date·compute-item-content·
 * CSS 는 index.html 에 남아 있음)를 순수 함수로 복원한다.
 *
 * 각 항목 = 시각(eventAt 우선·없으면 createdAt·둘 다 없으면 noDate) + 내용. 검색 카드
 * (renderCard)를 못 쓰는 이유 = /compute 항목(toComputeItem)이 memoryType·importance·
 * confidence·lastAccessedAt 을 안 담음(plan T6·spec §6b.3). 빈 목록·비배열은 정직한 빈 상태
 * 한 노드(가짜 행 0). el 주입·순수 조립이라 happy-dom 으로 노드 구조를 검증한다.
 *
 * @param {Array<{id, content, createdAt, eventAt}>} items  /compute kind=timeline 응답 items
 * @param {(tag: string, props?: object, ...children: any[]) => HTMLElement} el  노드 팩토리
 * @returns {HTMLElement[]}  검색 결과 자리에 넣을 시간순 글 목록 노드 배열
 */
export function buildComputeTimelineNodes(items, el) {
  if (!Array.isArray(items) || items.length === 0) {
    return [el("div", { className: "empty" }, COMPUTE_TEXT.timelineEmpty)];
  }
  return items.map((item) => {
    const when = item.eventAt || item.createdAt || COMPUTE_TEXT.noDate;
    return el(
      "div",
      { className: "compute-item" },
      el("span", { className: "compute-item-date" }, when),
      el("span", { className: "compute-item-content" }, item.content),
    );
  });
}

/**
 * 라우트(/compute) 400 에러 message 를 한국어로 옮긴다. apiFetch 는 비2xx 면
 * "<status> <statusText> — <body.error>" 양식으로 throw 하므로, 알려진 API 문구가
 * message 안에 들어 있으면(includes) 그 한국어를 쓰고, 없으면 원문을 가리지 않고
 * 그대로 덧붙여 정직하게 보인다(silent fallback 금지).
 * @param {string} message  err.message (apiFetch throw 문구)
 * @returns {string}
 */
export function localizeComputeError(message) {
  const raw = typeof message === "string" ? message : String(message ?? "");
  for (const [apiMsg, ko] of Object.entries(COMPUTE_TEXT.errorByApiMessage)) {
    if (raw.includes(apiMsg)) return ko;
  }
  return COMPUTE_TEXT.errorFallback(raw);
}
