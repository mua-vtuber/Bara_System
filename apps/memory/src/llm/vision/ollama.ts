/**
 * OllamaVisionProvider — 로컬 Ollama HTTP /api/chat 통로 + messages[0].images 안
 * base64 image 배열. qwen3-vl:4b / llava 가족.
 *
 * 옛 `ollama-client.ts` (글 한정) fetch 패턴 그대로 + Ollama vision 양식 추가:
 *   POST /api/chat
 *   {
 *     model: "qwen3-vl:4b",
 *     stream: false,
 *     messages: [
 *       { role: "user", content: "한 줄 묘사하라", images: ["<base64>"] }
 *     ],
 *     options: { temperature, num_predict }
 *   }
 *
 * 회신 회수: response.message.content 글. usage 는 prompt_eval_count / eval_count 합류.
 *
 * mimeType 은 Ollama 가 body 안 별 칸으로 받지 않음 — 모델이 base64 raw 안 magic
 * number 읽어 자가 처리. mimeType 인자는 인터페이스 정합 + 디버깅 로그 한정.
 */

import type {
  VisionCaptionOptions,
  VisionCaptionResult,
  VisionProvider,
} from "./index.ts";
import { DEFAULT_OLLAMA_TIMEOUT_MS } from "../constants.ts";
import { requestProviderJson } from "../provider-http.ts";
import { formatOllamaTimingLine, parseOllamaTimingFields } from "../ollama-timing.ts";
import { emptyTruncatedOutputError, requireLimitSettingPath } from "./caption-result.ts";

export interface OllamaVisionProviderOptions {
  /** Ollama 서버 URL. caller (createVisionProvider) 가 settings.llm.vision.endpoint 검사 후 전달. */
  baseUrl: string;
  /** 모델 태그. caller 가 settings.llm.vision.model 전달. 예: "qwen3-vl:4b". */
  model: string;
  /** captionImage 호출별 default max_tokens. 미지정 시 256. */
  defaultMaxTokens?: number;
  /**
   * fetch 호출 타임아웃 (ms). caller(createVisionProvider)가 settings.llm.vision.timeoutMs
   * 를 전달. 미지정 시 안전망 120초 — 단 운영 default 는 settings 6분(360000)이라
   * GPU 없는 A1 CPU 캡션(1장 100~209초)도 끊기지 않는다.
   */
  timeoutMs?: number;
  /** 글 없이 잘렸을 때 오류에 넣을 한도 칸 경로(필수 — 캡션 "llm.vision.tokenCap", OCR "documents.ocr.maxOutputTokensPerPage"). */
  limitSettingPath: string;
}

interface OllamaChatMessage {
  role: string;
  content: string;
  /** base64 이미지 배열 — Ollama vision 양식 한정. */
  images?: string[];
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: false;
  /**
   * Ollama think 토글 (top-level body 칸). false 면 추론(thinking) 제거.
   * options.think 정의 시에만 채운다 — 미정의면 칸 없음 = 모델 기본 동작.
   */
  think?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    /** 문맥 길이. 호출 옵션 numCtx 가 있을 때만 보낸다(문서 OCR). */
    num_ctx?: number;
  };
}

interface OllamaChatResponse {
  model: string;
  message?: { role: string; content: string };
  done: boolean;
  /** 종료 사유 — 공식 문서 예시는 stop/load/unload, 출력 한도(num_predict)에 닿으면 length. */
  done_reason?: string;
  error?: string;
  /** Ollama usage 메트릭 — 가용 시 응답에 포함. */
  prompt_eval_count?: number;
  eval_count?: number;
  /** 시간 칸(나노초) — 가용 시 응답에 포함. 로그 한 줄에만 쓴다. */
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

/** Ollama done_reason → 공통 종료 사유. stop→stop, length→max_tokens, 그 밖·없음→other. */
export function ollamaStopReason(doneReason: string | undefined): "stop" | "max_tokens" | "other" {
  if (doneReason === "stop") return "stop";
  if (doneReason === "length") return "max_tokens";
  return "other";
}

export class OllamaVisionProvider implements VisionProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly defaultMaxTokens: number;
  private readonly timeoutMs: number;
  private readonly limitSettingPath: string;

  constructor(opts: OllamaVisionProviderOptions) {
    if (!opts.baseUrl || opts.baseUrl.length === 0) {
      throw new Error(
        "OllamaVisionProvider: baseUrl 이 비어 있음. " +
          "settings.llm.vision.endpoint 를 채워라.",
      );
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 256;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
    this.limitSettingPath = requireLimitSettingPath("OllamaVisionProvider", opts.limitSettingPath);
  }

  get name(): string {
    return `ollama:${this.model}`;
  }

  async captionImage(
    imageBuffer: Uint8Array | Buffer,
    _mimeType: string,
    prompt: string,
    options: VisionCaptionOptions = {},
  ): Promise<VisionCaptionResult> {
    const base64 = Buffer.from(imageBuffer).toString("base64");

    const body: OllamaChatRequest = {
      model: this.model,
      stream: false,
      messages: [
        {
          role: "user",
          content: prompt,
          images: [base64],
        },
      ],
      options: {
        temperature: options.temperature ?? 0.3,
        num_predict: options.maxTokens ?? this.defaultMaxTokens,
        ...(options.numCtx !== undefined ? { num_ctx: options.numCtx } : {}),
      },
    };

    // think 옵션이 정의됐을 때만 송신. 미정의면 body 에 think 칸 없음 = 모델 기본
    // 동작. "추론 제거 요청 안 함"의 정직한 표현이지 silent fallback 아님.
    if (options.think !== undefined) {
      body.think = options.think;
    }

    // 전송 실패 규칙(내부 timeout → LlmRequestError{timedOut}, 2xx 아님 → LlmRequestError{status},
    // 연결 실패 → LlmRequestError{status:null}, 바깥 취소는 그대로)은 공급자 공통 함수가 맡는다 —
    // 문서 OCR 이 상태 코드로 일시/결정/설정을 가른다.
    // wall: 요청 시작 ~ 응답 JSON 읽기 끝(전송 실패는 줄 없이 던진다).
    const wallStart = performance.now();
    const json = (await requestProviderJson({
      provider: "ollama",
      label: "OllamaVisionProvider /api/chat",
      url: `${this.baseUrl}/api/chat`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      timeoutMs: this.timeoutMs,
      signal: options.signal,
    })) as OllamaChatResponse;
    const wallMs = Math.round(performance.now() - wallStart);

    if (json.error) {
      throw new Error(`OllamaVisionProvider error: ${json.error}`);
    }
    if (!json.message || typeof json.message.content !== "string") {
      throw new Error(
        "OllamaVisionProvider: response 안 message.content 가 없음.",
      );
    }

    // 오류 검사를 통과한 응답마다 시간 한 줄(spec 5.4). 프롬프트 글자 수·그림 바이트 수만, 내용은 싣지 않는다.
    console.log(
      formatOllamaTimingLine({
        caller: options.callLabel,
        model: this.model,
        doneReason: typeof json.done_reason === "string" ? json.done_reason : null,
        inputChars: prompt.length,
        imageBytes: imageBuffer.byteLength,
        wallMs,
        ...parseOllamaTimingFields(json as unknown as Record<string, unknown>),
      }),
    );

    const stopReason = ollamaStopReason(json.done_reason);
    const caption = json.message.content.trim();
    if (!caption && options.allowEmptyText === true) {
      // 문서 OCR 의 빈 쪽 — 판정은 호출부가 stopReason 으로 한다.
      return { caption: "", usage: { inputTokens: json.prompt_eval_count, outputTokens: json.eval_count }, stopReason };
    }
    if (!caption) {
      if (stopReason === "max_tokens") {
        throw emptyTruncatedOutputError("OllamaVisionProvider", this.limitSettingPath);
      }
      throw new Error(
        `OllamaVisionProvider: 회신 caption 이 빈 문자열 (done_reason=${json.done_reason ?? "없음"}).`,
      );
    }

    return {
      caption,
      usage: {
        inputTokens: json.prompt_eval_count,
        outputTokens: json.eval_count,
      },
      stopReason,
    };
  }
}
