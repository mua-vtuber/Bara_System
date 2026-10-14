/**
 * ollama-timing — Ollama 호출 시간·토큰 수를 로그 한 줄로 만드는 순수 모듈(spec 5.3·5.4).
 *
 * 글 호출(`OllamaClient`)과 그림 호출(`OllamaVisionProvider`)이 같은 형식·같은 머리말로
 * 이 두 함수만 부른다. 프롬프트·응답 글·그림 내용은 줄에 넣지 않는다(길이·바이트만).
 * `-` 와 `미지정` 은 "값이 없다"를 그대로 적는 표시이며 대체값이 아니다.
 */

export const OLLAMA_TIMING_PREFIX = "[ollama-timing]";

const NANOS_PER_MS = 1_000_000;
const MS_PER_SECOND = 1000;
const ABSENT = "-";
const CALLER_UNSPECIFIED = "미지정";

/** Ollama 응답 JSON 에서 읽은 시간·토큰 칸. 없거나 숫자가 아니면 null. */
export interface OllamaTimingFields {
  totalMs: number | null;
  loadMs: number | null;
  promptTokens: number | null;
  promptMs: number | null;
  outputTokens: number | null;
  outputMs: number | null;
}

/** 로그 한 줄에 실리는 호출 한 번의 기록. */
export interface OllamaCallTiming extends OllamaTimingFields {
  /** 호출 이름(callLabel). 없으면 줄에 `미지정`. */
  caller: string | undefined;
  model: string;
  /** Ollama done_reason 원문. 없으면 null. */
  doneReason: string | null;
  /** 보낸 프롬프트 글자 수 합. */
  inputChars: number;
  /** 그림 호출의 그림 바이트 수. 글 호출은 null(칸 자체를 넣지 않는다). */
  imageBytes: number | null;
  /** 우리 쪽에서 잰 요청 시작 ~ 응답 JSON 읽기 끝(ms). */
  wallMs: number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nanosToMs(value: unknown): number | null {
  const n = finiteNumber(value);
  return n === null ? null : Math.round(n / NANOS_PER_MS);
}

export function parseOllamaTimingFields(json: Record<string, unknown>): OllamaTimingFields {
  return {
    totalMs: nanosToMs(json.total_duration),
    loadMs: nanosToMs(json.load_duration),
    promptTokens: finiteNumber(json.prompt_eval_count),
    promptMs: nanosToMs(json.prompt_eval_duration),
    outputTokens: finiteNumber(json.eval_count),
    outputMs: nanosToMs(json.eval_duration),
  };
}

function orAbsent(value: number | null): string {
  return value === null ? ABSENT : String(value);
}

/** `3100tok/95000ms(32.6tok/s)` — 초당 토큰은 개수와 시간이 둘 다 있고 시간이 0 보다 클 때만. */
function formatTokenSpan(tokens: number | null, ms: number | null): string {
  const base = `${orAbsent(tokens)}${tokens === null ? "" : "tok"}/${orAbsent(ms)}${ms === null ? "" : "ms"}`;
  if (tokens === null || ms === null || ms <= 0) return base;
  const perSecond = (tokens / ms) * MS_PER_SECOND;
  return `${base}(${perSecond.toFixed(1)}tok/s)`;
}

export function formatOllamaTimingLine(t: OllamaCallTiming): string {
  const parts = [
    OLLAMA_TIMING_PREFIX,
    `caller=${t.caller ?? CALLER_UNSPECIFIED}`,
    `model=${t.model}`,
    `done=${t.doneReason ?? ABSENT}`,
    `inputChars=${t.inputChars}`,
  ];
  if (t.imageBytes !== null) parts.push(`imageBytes=${t.imageBytes}`);
  parts.push(
    `wall=${t.wallMs}ms`,
    `total=${t.totalMs === null ? ABSENT : `${t.totalMs}ms`}`,
    `load=${t.loadMs === null ? ABSENT : `${t.loadMs}ms`}`,
    `prompt=${formatTokenSpan(t.promptTokens, t.promptMs)}`,
    `output=${formatTokenSpan(t.outputTokens, t.outputMs)}`,
  );
  return parts.join(" ");
}
