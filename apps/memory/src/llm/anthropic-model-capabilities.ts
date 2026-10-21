/**
 * Anthropic 모델별 요청 칸 허용 규칙 — 단일 출처.
 *
 * 왜 필요한가: 최신 Claude 모델 가족(Fable 5·5.1, Mythos 5·5.1, Opus 5.5·5·4.8·4.7,
 * Sonnet 5.5·5, Haiku 5.5)은 표본 추출 조절값(temperature·top_p·top_k)을 요청에 넣으면
 * HTTP 400 (`temperature` is deprecated for this model) 으로 거절한다. Opus 4.6·Sonnet 4.6·
 * Haiku 4.5 와 그 이전 모델은 아직 받는다. 글 클라이언트(`anthropic-client.ts`)와 이미지
 * 캡션 클라이언트(`vision/anthropic.ts`)가 모두 이 모듈 하나만 보고 칸을 넣거나 뺀다 —
 * 모델 이름 목록을 다른 파일에 흩어 두지 않는다.
 *
 * 판정 방식 (허용 목록):
 *   - 이름을 정규화한다: 소문자화 → 앞의 공급자 접두("anthropic.", "us.anthropic." 등) 제거 →
 *     뒤의 Bedrock 판 표시("-v1:0"), Vertex 판 표시("@20250929"), 날짜("-20251001"),
 *     "[1m]" 같은 꼬리 제거.
 *   - 받는 것이 확인된 옛 가족만 true. 이름 규칙을 알아볼 수 없는 모델은 false — 조절값을
 *     빼는 쪽은 어느 모델에서도 400 을 일으키지 않지만(모든 모델에서 선택 칸), 넣는 쪽은
 *     새 모델에서 요청 자체가 실패하기 때문이다. 이것은 실패를 가리는 대체값이 아니라
 *     "받는다고 확인된 모델에만 보낸다"는 보수적 규칙이다.
 *   - 새 모델이 나오면 아래 표(SAMPLING_REJECTING_FAMILIES·OPUS_SAMPLING_REJECT_FROM_MINOR)
 *     만 고친다.
 */

/** 주 버전과 상관없이 표본 조절값을 거절하는 가족. */
const SAMPLING_REJECTING_FAMILIES: ReadonlySet<string> = new Set([
  "fable",
  "mythos",
]);

/** 이 주 버전 이상인 opus·sonnet·haiku 는 표본 조절값을 거절한다. */
const SAMPLING_REJECT_FROM_MAJOR = 5;

/** Opus 4.x 중 이 부 버전 이상(4.7·4.8)은 표본 조절값을 거절한다. */
const OPUS_SAMPLING_REJECT_FROM_MINOR = 7;

/** 표본 조절값을 받는 것이 확인된 옛 이름 규칙(claude-3-5-sonnet-…, claude-2.1, claude-instant-1.2). */
const LEGACY_ACCEPTING_PATTERN = /^claude-(?:instant|[123])(?:[-.]|$)/;

/** 현행 이름 규칙: claude-<가족>-<주>[-<부>]. */
const CURRENT_NAMING_PATTERN = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/;

/** 알아볼 수 없는 모델 이름을 이미 알렸는지 — 이름마다 한 번만 경고한다(호출마다 같은 줄이 쌓이지 않게). */
const warnedUnknownModelIds = new Set<string>();

/** 이름 규칙을 알아볼 수 없어 temperature 를 빼고 보낸다는 사실을 이름마다 한 번 알린다. */
function warnUnknownModelOnce(modelId: string): void {
  if (warnedUnknownModelIds.has(modelId)) return;
  warnedUnknownModelIds.add(modelId);
  console.warn(
    `[anthropic] 모델 이름 '${modelId}' 을 알려진 가족 규칙으로 알아볼 수 없어 temperature 를 빼고 보낸다 ` +
      `(anthropic-model-capabilities.ts 표를 확인할 것).`,
  );
}

/** 공급자 접두·판 표시·날짜·문맥 표시 꼬리를 걷어낸 비교용 이름. */
export function normalizeAnthropicModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  const providerPrefixEnd = id.lastIndexOf("anthropic.");
  if (providerPrefixEnd >= 0) id = id.slice(providerPrefixEnd + "anthropic.".length);
  id = id.replace(/\[[^\]]*\]$/, "");
  id = id.replace(/-v\d+(?::\d+)?$/, "");
  id = id.replace(/@[^@]*$/, "");
  id = id.replace(/-\d{8}$/, "");
  return id;
}

/**
 * 이 모델에 temperature·top_p·top_k 를 보내도 되는가.
 * false 면 클라이언트가 해당 칸을 요청에서 뺀다.
 */
export function anthropicModelAcceptsSampling(modelId: string): boolean {
  const id = normalizeAnthropicModelId(modelId);
  if (LEGACY_ACCEPTING_PATTERN.test(id)) return true;

  const match = CURRENT_NAMING_PATTERN.exec(id);
  if (!match) {
    warnUnknownModelOnce(modelId);
    return false;
  }
  const family = match[1]!;
  const major = Number(match[2]);
  const minor = match[3] === undefined ? 0 : Number(match[3]);

  if (SAMPLING_REJECTING_FAMILIES.has(family)) return false;
  if (family !== "opus" && family !== "sonnet" && family !== "haiku") {
    warnUnknownModelOnce(modelId);
    return false;
  }
  if (major >= SAMPLING_REJECT_FROM_MAJOR) return false;
  if (family === "opus" && major === 4 && minor >= OPUS_SAMPLING_REJECT_FROM_MINOR) {
    return false;
  }
  return true;
}

/**
 * 생각(thinking)을 끄는 요청 칸. Anthropic SDK 0.96 의 타입에는 "between_tools" 가 없어 여기서 따로
 * 적는다(전송은 SDK 가 본문을 그대로 싣는다).
 */
export type AnthropicThinkingOffParam = { type: "disabled" } | { type: "between_tools" };

/**
 * 생각을 끄려면 칸을 넣어야 하는 모델(정규화한 이름 → 넣을 값). 값마다의 근거는 모두
 * Claude API 문서(2026-10 확인)의 모델별 thinking 설명이다:
 *   - claude-opus-5 -> {type:"disabled"}: Opus 5 는 "disabled" 를 effort high 이하에서만 받는다
 *     (기본 effort high). 이 클라이언트는 effort 를 보내지 않아 기본값이라 받는다.
 *   - claude-haiku-5-5 -> {type:"disabled"}: Haiku 5.5 도 "disabled" 를 effort high 이하에서만
 *     받는다(기본 effort medium). effort 를 보내지 않아 기본값이라 받는다.
 *   - claude-sonnet-5 -> {type:"disabled"}: Sonnet 5 는 "disabled" 를 제한 없이 받는다.
 *   - claude-sonnet-5-5 -> {type:"between_tools"}: Sonnet 5.5 는 "disabled" 를 400 으로 거절하고
 *     {type:"between_tools"}(다른 칸 없이)로만 끈다. effort high 이하에서만 가능한데 이 클라이언트는
 *     effort 를 보내지 않아 기본값 high 라 가능하다.
 * 표에 없는 모델은 칸을 넣지 않는다(같은 문서 기준):
 *   - Opus 5.5·Fable 5.x·Mythos: 생각을 끌 수 없다 — 칸을 빼는 것이 유일한 요청이다(지금 동작 그대로).
 *   - Opus 4.8 이하·Sonnet 4.6 이하·Haiku 4.5 이하: thinking 칸을 빼면 이미 생각하지 않는다.
 *   - 이름 규칙을 모르는 모델: 넣으면 400 이 날 수 있어 넣지 않는다.
 * 새 모델이 나오면 이 표만 고친다.
 */
const THINKING_OFF_PARAMS: ReadonlyMap<string, AnthropicThinkingOffParam> = new Map([
  ["claude-opus-5", { type: "disabled" }],
  ["claude-sonnet-5", { type: "disabled" }],
  ["claude-haiku-5-5", { type: "disabled" }],
  ["claude-sonnet-5-5", { type: "between_tools" }],
]);

/** 생각을 끄라는 요청(think === false)일 때 요청 본문에 펼쳐 넣을 칸. 넣을 것이 없으면 빈 객체. */
export function anthropicThinkingParams(
  modelId: string,
  think: boolean | undefined,
): { thinking?: AnthropicThinkingOffParam } {
  if (think !== false) return {};
  const off = THINKING_OFF_PARAMS.get(normalizeAnthropicModelId(modelId));
  return off === undefined ? {} : { thinking: off };
}

/** 요청 본문에 펼쳐 넣을 표본 조절 칸. 허용 안 되는 모델이거나 값이 없으면 빈 객체. */
export function anthropicSamplingParams(
  modelId: string,
  sampling: { temperature?: number },
): { temperature?: number } {
  if (sampling.temperature === undefined) return {};
  if (!anthropicModelAcceptsSampling(modelId)) return {};
  return { temperature: sampling.temperature };
}
