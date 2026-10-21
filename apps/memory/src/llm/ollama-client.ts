/**
 * OllamaClient — `LlmClient`의 Ollama HTTP /api/chat 구현.
 *
 * Ollama는 로컬 127.0.0.1:11434에서 도는 무료 LLM 서버. 추출처럼 빈번하고
 * 가벼운 작업의 1순위. fetch 기반이라 별도 SDK 의존성 없음.
 *
 * 호출 인자:
 *   baseUrl  — 필수. 디폴트 fallback 없음 (caller 가 `settings.llm.ollamaUrl` 전달).
 *   model    — 필수. 디폴트 fallback 없음 (caller 가 `settings.llm.ollamaModel` 전달).
 *
 * S10 정착 (2026-05-19) 후 env 직접 읽기는 제거. 옛 OLLAMA_BASE_URL/OLLAMA_MODEL 은
 * `data/memory-settings.json` 의 llm.ollamaUrl/ollamaModel 로 이전. 단,
 * `OLLAMA_NUM_CTX` 는 튜닝 노브 (settings UI 비노출) — env 유지, 부트스트랩 예외.
 * 양의 정수가 아니면 추출기가 ollama 일 때 시작이 멈추고 다른 슬롯은 슬롯별 초기화 실패로 남는다(resolveOllamaNumCtx — 조용히 8192 로 바꾸지 않음).
 *
 * 모델 선택 가이드:
 *   - qwen3:4b-instruct (Apache 2.0·상업 안전·non-thinking). 추출 default.
 *     외부 배포 모듈 정체성상 default 는 상업 안전 라이선스여야 한다.
 *   - 옛 exaone3.5 가족(7.8b·32b)은 NC(비상업) 라이선스라 외부 배포 default 에서
 *     제거됨. 사용자가 직접 고르면 settings 에 남길 수 있으나 default 아님.
 *   - 함정: thinking 변형 qwen3:4b (instruct 아님) 은 추출에서 빈 응답을 내므로
 *     쓰지 않는다. 반드시 instruct 태그를 쓴다.
 */

import type {
  ChatMessage,
  LlmChatOptions,
  LlmChatResult,
  ObservableLlmClient,
} from "./types.ts";
import {
  errorMessage,
  isAbortError,
  LlmRequestError,
  parseRetryAfterMs,
} from "./errors.ts";
import { BUN_FETCH_NO_DEFAULT_TIMEOUT } from "./bun-fetch.ts";
import { DEFAULT_OLLAMA_TIMEOUT_MS } from "./constants.ts";
import { resolveOllamaNumCtx } from "./ollama-num-ctx.ts";
import { formatOllamaTimingLine, parseOllamaTimingFields } from "./ollama-timing.ts";

export interface OllamaClientOptions {
  /** Ollama 서버 URL. caller (createMemoryApi) 가 settings.llm.ollamaUrl 전달. */
  baseUrl: string;
  /** 모델 태그. caller 가 settings.llm.ollamaModel 전달. */
  model: string;
  /** fetch 호출 타임아웃 (ms). 기본 120초 — 32B + CPU 오프로드 시 첫 호출이 20초까지 갈 수 있음. */
  timeoutMs?: number;
  /**
   * Ollama 모델 컨텍스트 윈도우 (토큰). 기본 8192.
   *
   * 추출은 system prompt + few-shot user/assistant 쌍(memory/extractor-internal/prompt.ts
   * FEW_SHOT_EXAMPLES) + 실제 입력 + 출력 한도를 이 창 하나에 담는다. 입력 몫·출력 한도의
   * 계산은 memory/extractor-output-limit.ts. Ollama 모델별 기본 num_ctx가 2048~4096이라
   * 잘릴 수 있어 8192 로 둔다.
   *
   * env `OLLAMA_NUM_CTX` 로 덮어쓸 수 있음 — settings UI 비노출 튜닝 노브 (S10 부트스트랩 예외). 양의 정수가 아니면 추출기가 ollama 일 때 시작이 멈추고, 다른 슬롯은 슬롯별 초기화 실패로 남는다.
   */
  numCtx?: number;
}

interface OllamaChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: false;
  /**
   * "json" 문자열은 단순 JSON 강제. 객체면 JSON Schema로 출력 구조까지 강제
   * (Ollama 0.5+). 7.8B 등 작은 모델은 "json"만으로도 잘 따르지만 32B는
   * 객체/배열 선택을 모델 자유로 두면 빈 객체로 빠질 수 있어 schema 필요.
   */
  format?: "json" | Record<string, unknown>;
  /**
   * Ollama think 토글 (top-level body 칸). false 면 추론(thinking) 제거.
   * options.think 정의 시에만 채운다 — 미정의면 칸 자체를 안 넣어 모델 기본 동작.
   */
  think?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    num_ctx?: number;
  };
}

interface OllamaChatResponse {
  model: string;
  message?: { role: string; content: string };
  done: boolean;
  /**
   * 종료 사유 원문. "stop" = 정상 종료, "length" = num_predict(출력 토큰) 한도로 잘림.
   * done=false 도중 응답이거나 provider 가 안 주면 undefined.
   */
  done_reason?: string;
  /** 입력(프롬프트) 처리 토큰 수. */
  prompt_eval_count?: number;
  /** 출력(생성) 토큰 수. */
  eval_count?: number;
  /** Ollama 시간 칸(나노초) — 로그 한 줄용. 읽는 쪽은 ollama-timing.ts. */
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  /** 에러 시 채워짐. ollama가 200으로 돌려보내도 message가 비고 error만 채울 수 있음. */
  error?: string;
}

/** /api/chat 요청 옵션 — Bun 기본 300초 제한을 끄고 내부 제한 타이머(signal)만 쓴다(bun-fetch.ts). */
export function buildOllamaChatInit(
  body: unknown,
  signal: AbortSignal,
): RequestInit & typeof BUN_FETCH_NO_DEFAULT_TIMEOUT {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
    ...BUN_FETCH_NO_DEFAULT_TIMEOUT,
  };
}

/** Ollama done_reason 원문 → LlmChatResult.stopReason 3값 정규화. */
function normalizeOllamaStopReason(
  doneReason: string | undefined,
): LlmChatResult["stopReason"] {
  if (doneReason === "stop") return "stop";
  if (doneReason === "length") return "max_tokens";
  return "other";
}

export class OllamaClient implements ObservableLlmClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly numCtx: number;

  constructor(opts: OllamaClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
    this.numCtx = resolveOllamaNumCtx(opts.numCtx, process.env);
  }

  get name(): string {
    return `ollama:${this.model}`;
  }

  /** 기존 `chat()` 소비처 0줄 변경 — `chatDetailed()` 위임 wrapper. */
  async chat(
    messages: readonly ChatMessage[],
    options: LlmChatOptions = {},
  ): Promise<string> {
    const result = await this.chatDetailed(messages, options);
    return result.text;
  }

  async chatDetailed(
    messages: readonly ChatMessage[],
    options: LlmChatOptions = {},
  ): Promise<LlmChatResult> {
    const body: OllamaChatRequest = {
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
    };

    // Schema가 있으면 우선 적용 (구조까지 강제) → 없으면 jsonMode로
    // 단순 JSON 강제 → 둘 다 없으면 자유 형식.
    if (options.jsonSchema) {
      body.format = options.jsonSchema;
    } else if (options.jsonMode) {
      body.format = "json";
    }

    // think 옵션이 정의됐을 때만 송신. 미정의면 body 에 think 칸 없음 = 모델 기본
    // 동작 (qwen instruct 계열은 추론 불필요). "추론 제거 요청 안 함"의 정직한
    // 표현이지 silent fallback 아님.
    if (options.think !== undefined) {
      body.think = options.think;
    }

    // num_ctx는 항상 명시 — Ollama 모델별 기본값(2048~4096)이 추출의 few-shot 흐름
    // (시스템 지시 + 예시 쌍 + 본문 + 출력 한도)을 잘라낼 수 있어 안정성 위해 강제로 박는다.
    body.options = { num_ctx: this.numCtx };
    if (options.temperature !== undefined) {
      body.options.temperature = options.temperature;
    }
    if (options.maxOutputTokens !== undefined) {
      body.options.num_predict = options.maxOutputTokens;
    }

    // 내부 타임아웃 + 외부 signal 동시 지원. 둘 중 먼저 트리거되는 쪽이 끊음.
    // timedOut 은 내부 timeout 이 발동했는지 표식 — abort 오류가 timeout 인지 외부
    // 취소인지 갈라 LlmRequestError.timedOut 에 정직하게 싣는다.
    const timeoutController = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, this.timeoutMs);

    const externalAbort = (): void => timeoutController.abort();
    if (options.signal) {
      if (options.signal.aborted) timeoutController.abort();
      else options.signal.addEventListener("abort", externalAbort, { once: true });
    }

    try {
      // fetch 전송 실패(timeout abort·네트워크 단절)만 이 좁은 try 에서 LlmRequestError
      // 로 래핑한다 — 응답 형태 오류(json.error·content 부재)는 fetch 성공 이후라 이
      // 래핑에 걸리지 않고 generic Error 로 남는다(요청 오류와 결정적 오류의 경계).
      // wall: fetch 직전 ~ 응답 JSON 읽기 끝(오류 응답은 잴 필요 없이 던진다).
      const wallStart = performance.now();
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/chat`, buildOllamaChatInit(body, timeoutController.signal));
      } catch (error) {
        // abort: 내부 timeout 이면 일시 요청 오류로 래핑, 외부 signal(사용자 취소)이면
        // 그대로 던져 취소 의미를 보존한다(실패 아님).
        if (isAbortError(error)) {
          if (timedOut) {
            throw new LlmRequestError({
              provider: "ollama",
              message: `Ollama /api/chat timeout (${this.timeoutMs}ms 초과)`,
              status: null,
              code: null,
              retryAfterMs: null,
              timedOut: true,
              cause: error,
            });
          }
          throw error;
        }
        // 그 외 fetch 거부 = 네트워크 단절(연결 거부·DNS 실패 등) → status null 일시 오류.
        throw new LlmRequestError({
          provider: "ollama",
          message: `Ollama /api/chat 네트워크 실패: ${errorMessage(error)}`,
          status: null,
          code: null,
          retryAfterMs: null,
          timedOut: false,
          cause: error,
        });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new LlmRequestError({
          provider: "ollama",
          message: `Ollama /api/chat ${res.status}: ${text.slice(0, 300)}`,
          status: res.status,
          code: null,
          retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
          timedOut: false,
        });
      }

      const json = (await res.json()) as OllamaChatResponse;
      const wallMs = Math.round(performance.now() - wallStart);
      if (json.error) {
        throw new Error(`Ollama error: ${json.error}`);
      }
      if (!json.message || typeof json.message.content !== "string") {
        throw new Error("Ollama response missing message.content");
      }

      // 오류 검사를 통과한 응답마다 시간 한 줄(spec 5.3). 길이·시간만, 글 내용은 싣지 않는다.
      console.log(
        formatOllamaTimingLine({
          caller: options.callLabel,
          model: this.model,
          doneReason: typeof json.done_reason === "string" ? json.done_reason : null,
          inputChars: messages.reduce((sum, m) => sum + m.content.length, 0),
          imageBytes: null,
          wallMs,
          ...parseOllamaTimingFields(json as unknown as Record<string, unknown>),
        }),
      );

      // Ollama 는 캐시 개념이 없는 provider — cacheReadTokens/cacheWriteTokens 는
      // "그 provider 에 캐시가 없다"는 사실 표현으로 0 고정(누락값 은폐 아님).
      // prompt_eval_count/eval_count 자체가 없으면(구버전 서버 등) usage 전체를 null 로.
      const usage: LlmChatResult["usage"] =
        typeof json.prompt_eval_count === "number" &&
        typeof json.eval_count === "number"
          ? {
              inputTokens: json.prompt_eval_count,
              outputTokens: json.eval_count,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            }
          : null;

      return {
        text: json.message.content,
        stopReason: normalizeOllamaStopReason(json.done_reason),
        usage,
      };
    } finally {
      clearTimeout(timeoutHandle);
      if (options.signal) {
        options.signal.removeEventListener("abort", externalAbort);
      }
    }
  }
}
