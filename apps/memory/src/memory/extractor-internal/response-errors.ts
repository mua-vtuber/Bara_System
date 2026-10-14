/**
 * response-errors.ts — 추출 LLM 응답이 쓸 수 없는 상태일 때 던지는 오류 클래스 모음.
 *
 * 백필 실패 분류기(backfill-attempts/classify.ts)가 이 파일을 import 해 오류 클래스로 갈래를 가른다.
 * 그래서 타입 import 와 순수 상수 모듈 extractor-output-limit.ts 외에는 아무것도 import 하지 않는다 — 무거운 모듈을 끌어오지 않는다.
 * 오류 클래스는 서로 독립이라 새 클래스는 이 파일 끝에 더하기만 하면 된다.
 *
 * 오류 문장은 실패 기록 표 last_error 와 설정 화면 실패 목록에 그대로 보이므로 응답 글 자체는 담지 않는다.
 */

import type { LlmChatResult } from "../../llm/types.ts";
import { EXTRACTOR_MAX_OUTPUT_TOKENS_KEY } from "../extractor-output-limit.ts";

/** 잘림이 어느 호출에서 났는가 — 첫 호출, 또는 형식 깨짐 뒤 재요청. */
export type ExtractionAttempt = "first" | "retry";

export interface ExtractionOutputTruncatedFields {
  readonly llmName: string;
  readonly maxOutputTokens: number;
  readonly outputTokens: number | null;
  readonly attempt: ExtractionAttempt;
}

const ATTEMPT_LABEL: Record<ExtractionAttempt, string> = {
  first: "첫 호출",
  retry: "재요청",
};

/**
 * 추출 응답이 출력 한도(max_tokens)에 걸려 잘렸다. 일부를 읽을 수 있어도 저장하지 않고,
 * 같은 요청을 다시 보내지도 않는다(다시 보내도 또 잘릴 가능성이 높고 CPU 만 쓴다).
 */
export class ExtractionOutputTruncatedError extends Error {
  readonly llmName: string;
  readonly maxOutputTokens: number;
  /** usage.outputTokens. 공급자가 사용량을 안 주면 null. */
  readonly outputTokens: number | null;
  readonly attempt: ExtractionAttempt;
  /**
   * 공급자가 알려 준 출력 토큰 수가 한도보다 적은데 잘렸다 — 출력 한도가 아닌 다른 것(컨텍스트 창 등)이 잘랐다.
   * 사용량을 안 주면(null) 판단할 수 없으므로 false. 입력 칸이 아니라 여기서 한 번만 계산한다.
   */
  readonly stoppedBelowLimit: boolean;

  constructor(fields: ExtractionOutputTruncatedFields) {
    const stoppedBelowLimit = fields.outputTokens !== null && fields.outputTokens < fields.maxOutputTokens;
    const attemptLabel = ATTEMPT_LABEL[fields.attempt];
    const limit = `${EXTRACTOR_MAX_OUTPUT_TOKENS_KEY}=${fields.maxOutputTokens}`;
    super(
      stoppedBelowLimit
        ? `추출 응답이 출력 한도(${limit})를 다 쓰기 전에 잘렸습니다(출력 토큰 ${fields.outputTokens}) — ` +
            `입력과 출력이 모델 컨텍스트 창(Ollama 는 OLLAMA_NUM_CTX)을 넘었거나 공급자가 생각 단계 토큰을 함께 셌을 수 있습니다. ` +
            `같은 요청을 다시 보내지 않았습니다 (${fields.llmName}, ${attemptLabel})`
        : `추출 응답이 출력 한도(${limit})에 걸려 잘렸습니다 — ` +
            `같은 요청을 다시 보내지 않았습니다 (${fields.llmName}, ` +
            `${fields.outputTokens === null ? "출력 토큰 미보고" : `출력 토큰 ${fields.outputTokens}`}, ${attemptLabel}). ` +
            `한도를 올리고 서버를 다시 시작하면 다음 주기에 다시 시도합니다`,
    );
    this.stoppedBelowLimit = stoppedBelowLimit;
    this.name = "ExtractionOutputTruncatedError";
    this.llmName = fields.llmName;
    this.maxOutputTokens = fields.maxOutputTokens;
    this.outputTokens = fields.outputTokens;
    this.attempt = fields.attempt;
  }
}

/**
 * 응답이 출력 한도에 잘렸으면 ExtractionOutputTruncatedError 를 던진다. 아니면 아무것도 하지 않는다.
 * 응답마다 파싱 전에 먼저 부른다.
 */
export function throwIfTruncated(
  result: Pick<LlmChatResult, "stopReason" | "usage">,
  context: { llmName: string; maxOutputTokens: number; attempt: ExtractionAttempt },
): void {
  if (result.stopReason !== "max_tokens") return;
  throw new ExtractionOutputTruncatedError({
    llmName: context.llmName,
    maxOutputTokens: context.maxOutputTokens,
    outputTokens: result.usage === null ? null : result.usage.outputTokens,
    attempt: context.attempt,
  });
}

/** 형식이 깨진 응답을 두 번 받았을 때(첫 호출 + 재요청) 오류에 담는 값. 응답 글 자체는 담지 않는다. */
export interface ExtractionMalformedResponseFields {
  readonly llmName: string;
  /** 첫 응답의 글자 수. */
  readonly firstLength: number;
  /** 재요청 응답의 글자 수. */
  readonly retryLength: number;
}

/** 추출을 시도한 총 호출 수 — 첫 호출 1번 + 형식-깨짐 재요청 1번. */
const MALFORMED_ATTEMPTS = 2;

/**
 * 추출 응답이 첫 호출과 재요청 모두 읽을 수 없었다(빈 글이거나 JSON 형식이 아님).
 * "추출할 것 없음(0건)" 과 구별하려고 실패로 던진다 — 모델이 쓸모없는 응답을 낸 것을 성공처럼 꾸미지 않는다.
 * 문장에는 두 응답의 길이만 쓰고 응답 글은 쓰지 않는다.
 */
export class ExtractionMalformedResponseError extends Error {
  readonly llmName: string;
  readonly attempts: typeof MALFORMED_ATTEMPTS = MALFORMED_ATTEMPTS;
  readonly firstLength: number;
  readonly retryLength: number;

  constructor(fields: ExtractionMalformedResponseFields) {
    super(
      `추출 응답을 두 번 모두 읽지 못했습니다(빈 글이거나 JSON 형식이 아님) — 0건으로 처리하지 않았습니다 ` +
        `(${fields.llmName}, 응답 길이 ${fields.firstLength}자/${fields.retryLength}자)`,
    );
    this.name = "ExtractionMalformedResponseError";
    this.llmName = fields.llmName;
    this.firstLength = fields.firstLength;
    this.retryLength = fields.retryLength;
  }
}
