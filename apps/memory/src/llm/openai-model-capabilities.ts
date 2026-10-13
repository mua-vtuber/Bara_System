/**
 * OpenAI 모델 이름 규칙 — 단일 출처 (2026-10-11 llm-api-providers spec D7·D9, 사용자 결정 Q3·Q5).
 *
 * 두 가지 규칙을 한 곳에 둔다. 다른 파일에 접두어·패턴 사본을 두지 않는다(목록 함수·클라이언트·
 * 테스트 모두 이 모듈을 import).
 *
 * 1) temperature 허용 표 — GPT-5·o 계열 같은 추론 모델은 기본값 1 외의 temperature 를 HTTP 400 으로
 *    거절한다(공식 표는 없고 포럼·3자 문서로 확인된 사례). 그래서 받는 것이 확인된 옛 가족(gpt-4o,
 *    gpt-4.1, gpt-4, gpt-3.5)에만 보낸다. 모르는 모델은 칸을 빼고 이름마다 한 번 경고한다 — 빼는
 *    쪽은 어느 모델에서도 400 을 내지 않는다. 이것은 "모델 목록"이 아니라 요청 칸 허용 규칙이다.
 *
 * 2) 대화 모델 이름 규칙 — OpenAI /v1/models 는 기능 정보(대화용인지, 이미지를 받는지)를 주지 않는다.
 *    사용자 결정(Q3)으로 이름 규칙에 맞는 대화 모델만 목록에 남긴다. 포함 규칙에 맞고 제외 표식에
 *    안 걸려야 대화 모델이다. 공급자가 실제로 돌려준 목록을 거르는 패턴일 뿐 모델 이름을 지어내지
 *    않는다. 걸러진 개수는 응답·화면에 밝히고 "직접 입력…"은 항상 남는다. OpenAI 가 새 이름 규칙의
 *    대화 모델을 내면 아래 상수만 고친다.
 */

/** temperature 를 받는 것이 확인된 가족(정규화한 이름이 이 값이거나 "<값>-" 로 시작). */
const OPENAI_SAMPLING_ACCEPTING_FAMILIES: readonly string[] = ["gpt-4o", "gpt-4.1", "gpt-4", "gpt-3.5"];

/** 대화 모델 포함 규칙(소문자 비교). */
export const OPENAI_CHAT_MODEL_ID_PATTERNS: readonly RegExp[] = [/^gpt-\d/, /^chatgpt-/, /^o\d/];

/** 포함 규칙에 맞아도 대화 API 가 아닌 변형 표식(소문자 비교). */
export const OPENAI_NON_CHAT_ID_MARKERS: readonly RegExp[] = [
  /-audio/,
  /-realtime/,
  /-transcribe/,
  /-tts/,
  /-search/,
  /-image/,
  /instruct$/,
];

/** 미세조정 모델("ft:gpt-4o-mini:org::id")은 바탕 모델 이름으로 본다. */
export function normalizeOpenAiModelId(modelId: string): string {
  const id = modelId.trim().toLowerCase();
  if (id.startsWith("ft:")) {
    const base = id.slice("ft:".length).split(":")[0];
    return base ?? id;
  }
  return id;
}

/** 대화 모델 이름 규칙 판정. */
export function isOpenAiChatModelId(id: string): boolean {
  const normalized = normalizeOpenAiModelId(id);
  if (!OPENAI_CHAT_MODEL_ID_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  return !OPENAI_NON_CHAT_ID_MARKERS.some((marker) => marker.test(normalized));
}

/** 알아볼 수 없는 모델 이름을 이미 알렸는지 — 이름마다 한 번만 경고(호출마다 같은 줄이 쌓이지 않게). */
const warnedNoSamplingModelIds = new Set<string>();

/** 이 모델에 temperature 를 보내도 되는가. false 면 클라이언트가 칸을 뺀다. */
export function openAiModelAcceptsSampling(modelId: string): boolean {
  const id = normalizeOpenAiModelId(modelId);
  const accepted = OPENAI_SAMPLING_ACCEPTING_FAMILIES.some(
    (family) => id === family || id.startsWith(`${family}-`),
  );
  if (!accepted && !warnedNoSamplingModelIds.has(modelId)) {
    warnedNoSamplingModelIds.add(modelId);
    console.warn(
      `[openai] 모델 '${modelId}' 은 temperature 를 받는다고 확인된 가족이 아니라 temperature 를 빼고 보낸다 ` +
        `(openai-model-capabilities.ts 표를 확인할 것).`,
    );
  }
  return accepted;
}
