// web/dashboard/ui/dom.ts
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null)
      continue;
    if (k === "className") {
      node.className = String(v);
    } else if (k === "dataset") {
      Object.assign(node.dataset, v);
    } else if (k === "style") {
      node.setAttribute("style", String(v));
    } else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const child of children.flat()) {
    if (child == null)
      continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// web/dashboard/ui/badges.ts
var SOURCE_LABELS = {
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
  unknown: "알 수 없음"
};
var STATE_LABELS = {
  current: "현재",
  superseded: "대체됨",
  archived: "보관",
  pending_review: "검토대기",
  proposal: "제안",
  project_paused: "일시중지",
  project_done: "완료"
};
var MARKER_LABELS = {
  important: "중요",
  uncertain: "미확인",
  supersedes: "갱신함",
  superseded: "바뀜"
};
function sourceBadge(source) {
  const label = displayGraphKindLabel(source);
  return el("span", { className: `badge badge--source-${source}` }, label);
}
function displayGraphKindLabel(kind) {
  return SOURCE_LABELS[kind] ?? kind;
}
function isSameDisplayGraphKind(left, right) {
  if (left == null || right == null)
    return false;
  return displayGraphKindLabel(left) === displayGraphKindLabel(right);
}
function stateBadge(state) {
  const label = STATE_LABELS[state] ?? state;
  return el("span", { className: `badge badge--state-${state}` }, label);
}
function markerBadge(kind) {
  const label = MARKER_LABELS[kind];
  return el("span", { className: `badge badge--marker-${kind}` }, label);
}
function scoreChip(score) {
  return el("span", { className: "chip chip--score" }, formatScore(score));
}
function formatScore(score) {
  return score.toFixed(3);
}
function tagChip(text) {
  return el("span", { className: "chip chip--tag" }, text);
}
var YMD_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
function shortDate(iso) {
  const m = YMD_PREFIX.exec(iso);
  if (m) {
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    return `${month}/${day}`;
  }
  return iso.slice(0, 10);
}
function eventTimeChip(eventAt, eventUntil) {
  const text = eventUntil != null && eventUntil.length > 0 ? `${shortDate(eventAt)}–${shortDate(eventUntil)}` : shortDate(eventAt);
  return el("span", { className: "chip chip--eventtime" }, text);
}
function kindBadge(kind) {
  return el("span", { className: "badge badge--kind" }, kind);
}
var NEUTRAL_EPSILON = 0.000000001;
var POSITIVE_ONLY = (value) => value > NEUTRAL_EPSILON;
var COMPONENT_RULES = {
  rerankerScore: {
    label: "문장 적합도",
    title: "리랭커가 검색어와 본문을 다시 비교한 점수입니다.",
    mode: "percent",
    shouldShow: POSITIVE_ONLY
  },
  recency: {
    label: "최근성",
    title: "최근에 저장했거나 다시 본 기억일수록 높습니다.",
    mode: "percent",
    shouldShow: POSITIVE_ONLY
  },
  importance: {
    label: "중요도",
    title: "기억 자체에 저장된 중요도입니다.",
    mode: "percent",
    shouldShow: POSITIVE_ONLY
  },
  boostedRrf: {
    label: "검색채널",
    title: "의미·글자·그래프·이미지 검색 순위를 합친 점수입니다.",
    mode: "score",
    shouldShow: POSITIVE_ONLY
  },
  rrf: {
    label: "기본검색",
    title: "채널 보정 전 기본 검색 순위 합산입니다.",
    mode: "score",
    shouldShow: (value, components) => value > NEUTRAL_EPSILON && components["boostedRrf"] === undefined
  },
  bm25Cross: {
    label: "글자 정밀도",
    title: "검색어 글자가 본문에 직접 맞는 정도입니다.",
    mode: "percent",
    shouldShow: POSITIVE_ONLY
  },
  precisionStrength: {
    label: "강한 일치",
    title: "유사도가 특히 강한 채널에 붙은 가산점입니다.",
    mode: "additive",
    shouldShow: POSITIVE_ONLY
  },
  mentionBoost: {
    label: "반복 언급",
    title: "여러 번 언급된 기억에 붙은 가산점입니다.",
    mode: "additive",
    shouldShow: POSITIVE_ONLY
  },
  supersedePenalty: {
    label: "옛기억 감점",
    title: "더 새 기억에 대체된 옛 기억이면 점수를 낮춥니다.",
    mode: "penalty",
    shouldShow: (value) => value < 1 - NEUTRAL_EPSILON,
    sortValue: (value) => 1 - value
  },
  cueGraphBoost: {
    label: "관계질문 가산",
    title: "이유·변경·전체 같은 질문 신호가 있어 그래프 연결 검색을 더 세게 봤습니다.",
    mode: "boost",
    shouldShow: (value) => value > 1 + NEUTRAL_EPSILON,
    sortValue: (value) => value - 1
  },
  vectorRawCosine: {
    label: "의미 유사도",
    title: "검색어와 본문의 원시 의미 유사도입니다.",
    mode: "percent",
    shouldShow: POSITIVE_ONLY
  },
  imageVecRawCosine: {
    label: "이미지 유사도",
    title: "검색어와 이미지의 원시 의미 유사도입니다.",
    mode: "percent",
    shouldShow: POSITIVE_ONLY
  },
  vector: {
    label: "의미",
    title: "의미 검색 채널 기여입니다.",
    mode: "percent"
  },
  fts: {
    label: "글자",
    title: "전문 검색 채널 기여입니다.",
    mode: "percent"
  },
  graph: {
    label: "그래프",
    title: "연결 그래프 검색 채널 기여입니다.",
    mode: "percent"
  },
  concept: {
    label: "개념",
    title: "개념 검색 채널 기여입니다.",
    mode: "percent"
  },
  image: {
    label: "이미지",
    title: "이미지 검색 채널 기여입니다.",
    mode: "percent"
  },
  imageVec: {
    label: "이미지",
    title: "이미지 검색 채널 기여입니다.",
    mode: "percent"
  },
  bm25: {
    label: "글자",
    title: "BM25 글자 검색 기여입니다.",
    mode: "percent"
  },
  keyword: {
    label: "키워드",
    title: "키워드 검색 기여입니다.",
    mode: "percent"
  }
};
function trimFixed(value, digits) {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}
function formatPercentLike(value) {
  if (value >= -1 && value <= 1)
    return `${Math.round(value * 100)}%`;
  return trimFixed(value, 2);
}
function formatComponentValue(value, mode) {
  if (mode === "percent")
    return formatPercentLike(value);
  if (mode === "score")
    return trimFixed(value, 3);
  if (mode === "additive")
    return `${value >= 0 ? "+" : ""}${trimFixed(value, 3)}`;
  if (mode === "boost")
    return `+${Math.round((value - 1) * 100)}%`;
  return `-${Math.round((1 - value) * 100)}%`;
}
function componentRule(name) {
  return COMPONENT_RULES[name] ?? {
    label: name,
    title: "검색 점수 구성 항목입니다.",
    mode: "percent"
  };
}
function componentChips(components, limit = 3) {
  if (components == null)
    return [];
  return Object.entries(components).filter((entry) => Number.isFinite(entry[1])).map(([name, value]) => ({ name, value, rule: componentRule(name) })).filter(({ value, rule }) => rule.shouldShow?.(value, components) ?? true).sort((a, b) => (b.rule.sortValue?.(b.value) ?? b.value) - (a.rule.sortValue?.(a.value) ?? a.value)).slice(0, limit).map(({ value, rule }) => el("span", { className: "chip chip--component", title: rule.title }, `${rule.label} ${formatComponentValue(value, rule.mode)}`));
}
var SCHEDULE_LABEL = "일정: ";
var SCHEDULE_RANGE_SEPARATOR = " → ";
var SCHEDULE_DATE_LENGTH = 10;
function scheduleLineText(eventAt, eventUntil) {
  const start = eventAt.slice(0, SCHEDULE_DATE_LENGTH);
  if (eventUntil != null) {
    const end = eventUntil.slice(0, SCHEDULE_DATE_LENGTH);
    return `${SCHEDULE_LABEL}${start}${SCHEDULE_RANGE_SEPARATOR}${end}`;
  }
  return `${SCHEDULE_LABEL}${start}`;
}
export {
  tagChip,
  stateBadge,
  sourceBadge,
  scoreChip,
  scheduleLineText,
  markerBadge,
  kindBadge,
  isSameDisplayGraphKind,
  formatScore,
  eventTimeChip,
  displayGraphKindLabel,
  componentChips
};
