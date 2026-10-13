/** apps/memory/web/dashboard/ui/badges.ts — 의미 배지 조각. 인라인 색 0. */

import { el } from "./dom.ts";

// source/type 문자열 → 표시 라벨 매핑. 명시되지 않은 source 는 문자열 그대로(정직).
const SOURCE_LABELS: Record<string, string> = {
  vector: "의미",
  fts: "글자",
  graph: "그래프",
  concept: "개념",
  imageVec: "이미지",
  image: "이미지",
  image_asset: "이미지",
  project: "프로젝트",
  person: "사람",
  creature: "생물",
  thing: "사물",
  intake: "섭취",
  usable: "사용물",
  work: "작품",
  material: "자료",
  place: "장소",
  schedule: "일정",
  classification_key: "분류",
  entity_group: "종류",
  memory: "글",
  text: "글",
  auto_capture: "자동 저장",
  user_explicit: "직접 입력",
  llm_extract: "AI 추출",
  document: "문서",
  document_section: "문서 구간",
  document_chunk: "본문 조각",
  image_caption: "이미지 설명",
  decision: "결정",
  tag: "태그",
  unknown: "알 수 없음",
};

// state 문자열 → 표시 라벨 매핑.
const STATE_LABELS: Record<string, string> = {
  current: "현재",
  superseded: "대체됨",
  archived: "보관",
  pending_review: "검토대기",
  proposal: "제안",
  project_paused: "일시중지",
  project_done: "완료",
};

// marker kind → 표시 라벨 매핑.
const MARKER_LABELS: Record<"important" | "uncertain" | "supersedes" | "superseded", string> = {
  important: "중요",
  uncertain: "미확인",
  supersedes: "갱신함",
  superseded: "바뀜",
};

/**
 * 검색 채널 출처 배지.
 * 알 수 없는 source 는 라벨을 그대로 표시하고 class 도 그 값으로 생성(정직).
 */
export function sourceBadge(source: string): HTMLElement {
  const label = displayGraphKindLabel(source);
  return el("span", { className: `badge badge--source-${source}` }, label);
}

/** 그래프 타입/source 키를 사용자 화면용 라벨로 바꾼다. */
export function displayGraphKindLabel(kind: string): string {
  return SOURCE_LABELS[kind] ?? kind;
}

/** 두 내부 키가 화면에서는 같은 뜻이면 true. 중복 배지 차단용. */
export function isSameDisplayGraphKind(left: string | undefined, right: string | undefined): boolean {
  if (left == null || right == null) return false;
  return displayGraphKindLabel(left) === displayGraphKindLabel(right);
}

/**
 * 글 상태 배지 (current / superseded / archived 등).
 */
export function stateBadge(state: string): HTMLElement {
  const label = STATE_LABELS[state] ?? state;
  return el("span", { className: `badge badge--state-${state}` }, label);
}

/**
 * 중요도·신뢰도·개정 마커 배지.
 */
export function markerBadge(
  kind: "important" | "uncertain" | "supersedes" | "superseded",
): HTMLElement {
  const label = MARKER_LABELS[kind];
  return el("span", { className: `badge badge--marker-${kind}` }, label);
}

/**
 * 점수 칩. 소수점 세 자리 고정.
 */
export function scoreChip(score: number): HTMLElement {
  return el("span", { className: "chip chip--score" }, score.toFixed(3));
}

/**
 * 태그 텍스트 칩. 텍스트는 그대로 표시.
 */
export function tagChip(text: string): HTMLElement {
  return el("span", { className: "chip chip--tag" }, text);
}

/** 문자열 앞부분에서 YYYY-MM-DD 를 캡처. 뒤에 시각(T...)이 붙어도 날짜만 본다. */
const YMD_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * ISO 문자열 → 'M/D' 짧은 표기(시간은 안 보임 — 결과 줄 컴팩트). 깨지면 앞 10자.
 *
 * 앞부분이 YYYY-MM-DD 형태면 연·월·일을 정규식으로 직접 뽑아 월·일의 앞자리
 * 0 만 떼고 'M/D' 로 만든다. new Date() 와 시간대 접근자를 안 거쳐 결과가
 * 뷰어의 시간대에 흔들리지 않는다(event-date.ts 의 toIso 가 toISOString 의 UTC
 * 시프트를 피하는 철학과 정합). 운영 데이터의 event_at 은 시각 없는 순수 날짜다.
 */
function shortDate(iso: string): string {
  const m = YMD_PREFIX.exec(iso);
  if (m) {
    const month = parseInt(m[2]!, 10);
    const day = parseInt(m[3]!, 10);
    return `${month}/${day}`;
  }
  return iso.slice(0, 10);
}

/**
 * 일정 시간 칩(제목 앞). 단일 시점이면 'M/D', 기간이면 'M/D–M/D'.
 * 인라인 색 0 — .chip--eventtime 클래스로만 색·크기를 입는다.
 */
export function eventTimeChip(eventAt: string, eventUntil?: string): HTMLElement {
  const text =
    eventUntil != null && eventUntil.length > 0
      ? `${shortDate(eventAt)}–${shortDate(eventUntil)}`
      : shortDate(eventAt);
  return el("span", { className: "chip chip--eventtime" }, text);
}

/**
 * 분류 종류 배지(점수 앞). 종류명을 그대로 표시한다. 종류별 색은 CSS
 * (.badge--kind 와 종류 이름 기반 변형)가 입히고 인라인 색은 안 쓴다.
 */
export function kindBadge(kind: string): HTMLElement {
  return el("span", { className: "badge badge--kind" }, kind);
}

const NEUTRAL_EPSILON = 1e-9;

type ComponentDisplayMode = "percent" | "score" | "additive" | "boost" | "penalty";

type ComponentDisplayRule = {
  label: string;
  title: string;
  mode: ComponentDisplayMode;
  shouldShow?: (value: number, components: Record<string, number>) => boolean;
  sortValue?: (value: number) => number;
};

const POSITIVE_ONLY = (value: number): boolean => value > NEUTRAL_EPSILON;

const COMPONENT_RULES: Record<string, ComponentDisplayRule> = {
  rerankerScore: {
    label: "문장 적합도",
    title: "리랭커가 검색어와 본문을 다시 비교한 점수입니다.",
    mode: "percent",
    shouldShow: POSITIVE_ONLY,
  },
  recency: {
    label: "최근성",
    title: "최근에 저장했거나 다시 본 기억일수록 높습니다.",
    mode: "percent",
    shouldShow: POSITIVE_ONLY,
  },
  importance: {
    label: "중요도",
    title: "기억 자체에 저장된 중요도입니다.",
    mode: "percent",
    shouldShow: POSITIVE_ONLY,
  },
  boostedRrf: {
    label: "검색채널",
    title: "의미·글자·그래프·이미지 검색 순위를 합친 점수입니다.",
    mode: "score",
    shouldShow: POSITIVE_ONLY,
  },
  rrf: {
    label: "기본검색",
    title: "채널 보정 전 기본 검색 순위 합산입니다.",
    mode: "score",
    shouldShow: (value, components) =>
      value > NEUTRAL_EPSILON && components["boostedRrf"] === undefined,
  },
  bm25Cross: {
    label: "글자 정밀도",
    title: "검색어 글자가 본문에 직접 맞는 정도입니다.",
    mode: "percent",
    shouldShow: POSITIVE_ONLY,
  },
  precisionStrength: {
    label: "강한 일치",
    title: "유사도가 특히 강한 채널에 붙은 가산점입니다.",
    mode: "additive",
    shouldShow: POSITIVE_ONLY,
  },
  mentionBoost: {
    label: "반복 언급",
    title: "여러 번 언급된 기억에 붙은 가산점입니다.",
    mode: "additive",
    shouldShow: POSITIVE_ONLY,
  },
  supersedePenalty: {
    label: "옛기억 감점",
    title: "더 새 기억에 대체된 옛 기억이면 점수를 낮춥니다.",
    mode: "penalty",
    shouldShow: (value) => value < 1 - NEUTRAL_EPSILON,
    sortValue: (value) => 1 - value,
  },
  cueGraphBoost: {
    label: "관계질문 가산",
    title: "이유·변경·전체 같은 질문 신호가 있어 그래프 연결 검색을 더 세게 봤습니다.",
    mode: "boost",
    shouldShow: (value) => value > 1 + NEUTRAL_EPSILON,
    sortValue: (value) => value - 1,
  },
  vectorRawCosine: {
    label: "의미 유사도",
    title: "검색어와 본문의 원시 의미 유사도입니다.",
    mode: "percent",
    shouldShow: POSITIVE_ONLY,
  },
  imageVecRawCosine: {
    label: "이미지 유사도",
    title: "검색어와 이미지의 원시 의미 유사도입니다.",
    mode: "percent",
    shouldShow: POSITIVE_ONLY,
  },
  vector: {
    label: "의미",
    title: "의미 검색 채널 기여입니다.",
    mode: "percent",
  },
  fts: {
    label: "글자",
    title: "전문 검색 채널 기여입니다.",
    mode: "percent",
  },
  graph: {
    label: "그래프",
    title: "연결 그래프 검색 채널 기여입니다.",
    mode: "percent",
  },
  concept: {
    label: "개념",
    title: "개념 검색 채널 기여입니다.",
    mode: "percent",
  },
  image: {
    label: "이미지",
    title: "이미지 검색 채널 기여입니다.",
    mode: "percent",
  },
  imageVec: {
    label: "이미지",
    title: "이미지 검색 채널 기여입니다.",
    mode: "percent",
  },
  bm25: {
    label: "글자",
    title: "BM25 글자 검색 기여입니다.",
    mode: "percent",
  },
  keyword: {
    label: "키워드",
    title: "키워드 검색 기여입니다.",
    mode: "percent",
  },
};

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

function formatPercentLike(value: number): string {
  if (value >= -1 && value <= 1) return `${Math.round(value * 100)}%`;
  return trimFixed(value, 2);
}

function formatComponentValue(value: number, mode: ComponentDisplayMode): string {
  if (mode === "percent") return formatPercentLike(value);
  if (mode === "score") return trimFixed(value, 3);
  if (mode === "additive") return `${value >= 0 ? "+" : ""}${trimFixed(value, 3)}`;
  if (mode === "boost") return `+${Math.round((value - 1) * 100)}%`;
  return `-${Math.round((1 - value) * 100)}%`;
}

function componentRule(name: string): ComponentDisplayRule {
  return COMPONENT_RULES[name] ?? {
    label: name,
    title: "검색 점수 구성 항목입니다.",
    mode: "percent",
  };
}

export function componentChips(
  components: Record<string, number> | undefined,
  limit = 3,
): HTMLElement[] {
  if (components == null) return [];
  return Object.entries(components)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .map(([name, value]) => ({ name, value, rule: componentRule(name) }))
    .filter(({ value, rule }) => rule.shouldShow?.(value, components) ?? true)
    .sort(
      (a, b) =>
        (b.rule.sortValue?.(b.value) ?? b.value) -
        (a.rule.sortValue?.(a.value) ?? a.value),
    )
    .slice(0, limit)
    .map(({ value, rule }) =>
      el(
        "span",
        { className: "chip chip--component", title: rule.title },
        `${rule.label} ${formatComponentValue(value, rule.mode)}`,
      ),
    );
}

/** 일정 줄 라벨 접두. */
const SCHEDULE_LABEL = "일정: ";
/** 일정 줄 시작·종료 사이 구분자. */
const SCHEDULE_RANGE_SEPARATOR = " → ";
/** ISO 일시를 YYYY-MM-DD 로 자르는 길이(상세 일정 줄은 날짜만 보인다). */
const SCHEDULE_DATE_LENGTH = 10;

/**
 * 상세 표면의 일정 줄 텍스트. 종료가 있으면 '일정: 시작 → 종료',
 * 없으면 '일정: 시작' (날짜는 YYYY-MM-DD). 카드·노드 상세 두 렌더러의 단일 출처.
 */
export function scheduleLineText(eventAt: string, eventUntil?: string | null): string {
  const start = eventAt.slice(0, SCHEDULE_DATE_LENGTH);
  if (eventUntil != null) {
    const end = eventUntil.slice(0, SCHEDULE_DATE_LENGTH);
    return `${SCHEDULE_LABEL}${start}${SCHEDULE_RANGE_SEPARATOR}${end}`;
  }
  return `${SCHEDULE_LABEL}${start}`;
}
