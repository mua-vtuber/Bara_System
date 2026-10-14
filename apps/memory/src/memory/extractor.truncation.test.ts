/**
 * extractor.truncation.test.ts — 추출 응답이 출력 한도에 잘리면 같은 요청을 다시 보내지 않고
 * ExtractionOutputTruncatedError 로 멈추는지 검증한다(speed-step1 spec 4.1·4.3).
 *
 * 실제 클라이언트 5종 + 실제 로컬 HTTP 대역 서버(test-utils/provider-stand-in.ts) + 실제 SQLite.
 * 인터페이스를 흉내 내는 객체는 만들지 않는다. 공급자별 응답 모양은 각 클라이언트의 기존 시험을 따른다.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { AnthropicClient } from "../llm/anthropic-client.ts";
import { GeminiClient } from "../llm/gemini-client.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import { OpenAiClient } from "../llm/openai-client.ts";
import { OpenAiCompatibleClient } from "../llm/openai-compatible-client.ts";
import type { ObservableLlmClient } from "../llm/types.ts";
import {
  startProviderStandIn,
  type ProviderStandIn,
  type RecordedRequest,
  type StandInReply,
} from "../test-utils/provider-stand-in.ts";
import { MemoryExtractor } from "./extractor.ts";
import {
  EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT,
  EXTRACTOR_MAX_OUTPUT_TOKENS_KEY,
  EXTRACTOR_MAX_OUTPUT_TOKENS_MAX,
  EXTRACTOR_MAX_OUTPUT_TOKENS_MIN,
} from "./extractor-output-limit.ts";
import { ExtractionOutputTruncatedError } from "./extractor-internal/response-errors.ts";

/** 쪼갤 가치가 있어(절 접속어미 여럿) 짧은 단일 의미 건너뛰기에 걸리지 않는 입력. */
const INPUT_TEXT =
  "어제 서울에서 오랜 친구를 만났고, 그 친구는 곧 부산으로 이사한다고 했으며, 다음 달에는 함께 여행을 가기로 했다.";
const ITEMS_JSON = JSON.stringify([
  { content: "친구가 부산으로 이사한다", memoryType: "fact", importance: 0.8 },
]);
const GARBLED_TEXT = "죄송합니다만 JSON 이 아닌 말로 답하겠습니다";
const MAX_OUTPUT_TOKENS = EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT;
/** 기본값과 다른 생성자 한도 — 공급자 요청에 이 값이 실려야 한다. */
const CUSTOM_LIMIT = 2048;
const KEY = "test-key-truncation";

interface ProviderCase {
  readonly label: string;
  readonly llmName: string;
  readonly build: (origin: string) => ObservableLlmClient;
  /** 정상 종료(stop) 응답. */
  readonly stop: (text: string) => StandInReply;
  /** 요청 본문에서 출력 한도 칸의 값을 읽는다(공급자별 칸 이름이 다르다). */
  readonly limitOf: (req: RecordedRequest) => unknown;
  /** 출력 한도 잘림 응답. */
  readonly truncated: (text: string) => StandInReply;
}

function anthropicBody(text: string, stopReason: string, outputTokens: number): unknown {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: text.length > 0 ? [{ type: "text", text }] : [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: outputTokens },
  };
}

function openAiBody(text: string, finishReason: string, completionTokens: number): unknown {
  return {
    choices: [{ message: { content: text }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: completionTokens },
  };
}

function geminiBody(text: string, finishReason: string, candidateTokens: number): unknown {
  return {
    candidates: [{ content: { parts: text.length > 0 ? [{ text }] : [] }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: candidateTokens },
  };
}

function ollamaBody(text: string, doneReason: string, evalCount: number): unknown {
  return {
    message: { role: "assistant", content: text },
    done_reason: doneReason,
    prompt_eval_count: 10,
    eval_count: evalCount,
  };
}

const PROVIDERS: readonly ProviderCase[] = [
  {
    label: "Ollama",
    llmName: "ollama:fixture-model",
    build: (origin) => new OllamaClient({ baseUrl: origin, model: "fixture-model", timeoutMs: 5000 }),
    stop: (text) => ({ body: ollamaBody(text, "stop", 20) }),
    limitOf: (req) => (req.body as { options: { num_predict: unknown } }).options.num_predict,
    truncated: (text) => ({ body: ollamaBody(text, "length", MAX_OUTPUT_TOKENS) }),
  },
  {
    label: "Anthropic",
    llmName: "anthropic:claude-sonnet-4-6",
    build: (origin) =>
      new AnthropicClient({ apiKey: KEY, model: "claude-sonnet-4-6", baseURL: origin, maxRetries: 0, timeoutMs: 5000 }),
    stop: (text) => ({ body: anthropicBody(text, "end_turn", 20) }),
    limitOf: (req) => (req.body as { max_tokens: unknown }).max_tokens,
    truncated: (text) => ({ body: anthropicBody(text, "max_tokens", MAX_OUTPUT_TOKENS) }),
  },
  {
    label: "OpenAI",
    llmName: "openai:gpt-4o",
    build: (origin) => new OpenAiClient({ apiKey: KEY, model: "gpt-4o", timeoutMs: 5000, baseUrl: `${origin}/v1` }),
    stop: (text) => ({ body: openAiBody(text, "stop", 20) }),
    limitOf: (req) => (req.body as { max_completion_tokens: unknown }).max_completion_tokens,
    truncated: (text) => ({ body: openAiBody(text, "length", MAX_OUTPUT_TOKENS) }),
  },
  {
    label: "OpenAI 호환",
    llmName: "openai-compatible:local-model",
    build: (origin) =>
      new OpenAiCompatibleClient({ baseUrl: `${origin}/v1`, model: "local-model", timeoutMs: 5000 }),
    stop: (text) => ({ body: openAiBody(text, "stop", 20) }),
    limitOf: (req) => (req.body as { max_tokens: unknown }).max_tokens,
    truncated: (text) => ({ body: openAiBody(text, "length", MAX_OUTPUT_TOKENS) }),
  },
  {
    label: "Gemini",
    llmName: "google:gemini-2.5-flash",
    build: (origin) =>
      new GeminiClient({ apiKey: KEY, model: "gemini-2.5-flash", timeoutMs: 5000, baseUrl: `${origin}/v1beta` }),
    stop: (text) => ({ body: geminiBody(text, "STOP", 20) }),
    limitOf: (req) =>
      (req.body as { generationConfig: { maxOutputTokens: unknown } }).generationConfig.maxOutputTokens,
    truncated: (text) => ({ body: geminiBody(text, "MAX_TOKENS", MAX_OUTPUT_TOKENS) }),
  },
];

const OLLAMA = PROVIDERS[0]!;

let standIn: ProviderStandIn;
let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;

beforeAll(() => {
  standIn = startProviderStandIn();
  // MemoryExtractor.extract() 는 임베딩을 하지 않는다 — 차원(1024)만 쓰므로 load() 없이 구성한다
  // (extractor.dedup-scope.test.ts 선례). DB 는 실제 SQLite.
  embedder = new Bgem3Embedder();
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  standIn.requests.length = 0;
});
afterAll(() => {
  standIn.stop();
  db.close();
});

function extractorFor(client: ObservableLlmClient, maxOutputTokens?: number): MemoryExtractor {
  return new MemoryExtractor(client, store, embedder, maxOutputTokens === undefined ? {} : { maxOutputTokens });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("오류가 나야 하는데 성공했다");
    },
    (e: unknown) => e,
  );
}

/** Ollama /api/chat 요청 본문의 options 칸. */
function optionsOf(req: RecordedRequest): Record<string, unknown> {
  const body = req.body as { options?: Record<string, unknown> };
  if (!body.options) throw new Error("Ollama 요청 본문에 options 칸이 없다");
  return body.options;
}

describe("추출기 — 출력 한도 잘림은 재요청 없이 오류", () => {
  for (const provider of PROVIDERS) {
    test(`${provider.label}: 잘림 응답 -> ExtractionOutputTruncatedError(first), 요청 1번`, async () => {
      standIn.reply = () => provider.truncated(ITEMS_JSON);
      const extractor = extractorFor(provider.build(standIn.origin));
      const err = await caught(extractor.extract({ text: INPUT_TEXT }));
      expect(err).toBeInstanceOf(ExtractionOutputTruncatedError);
      const truncated = err as ExtractionOutputTruncatedError;
      expect(truncated.name).toBe("ExtractionOutputTruncatedError");
      expect(truncated.attempt).toBe("first");
      expect(truncated.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
      expect(truncated.llmName).toBe(provider.llmName);
      expect(truncated.outputTokens).toBe(MAX_OUTPUT_TOKENS);
      expect(truncated.message).toBe(
        `추출 응답이 출력 한도(${EXTRACTOR_MAX_OUTPUT_TOKENS_KEY}=${MAX_OUTPUT_TOKENS})에 걸려 잘렸습니다 — 같은 요청을 다시 보내지 않았습니다 (${provider.llmName}, 출력 토큰 ${MAX_OUTPUT_TOKENS}, 첫 호출). 한도를 올리고 서버를 다시 시작하면 다음 주기에 다시 시도합니다`,
      );
      expect(truncated.stoppedBelowLimit).toBe(false);
      expect(standIn.requests.length).toBe(1);
    });
  }

  for (const provider of PROVIDERS.filter((p) => p.label.startsWith("OpenAI"))) {
    test(`${provider.label}: 글 없이(빈 글) 잘려도 같은 오류, 요청 1번`, async () => {
      standIn.reply = () => provider.truncated("");
      const extractor = extractorFor(provider.build(standIn.origin));
      const err = await caught(extractor.extract({ text: INPUT_TEXT }));
      expect(err).toBeInstanceOf(ExtractionOutputTruncatedError);
      expect((err as ExtractionOutputTruncatedError).attempt).toBe("first");
      expect(standIn.requests.length).toBe(1);
    });
  }

  test("Ollama: 첫 응답 형식 깨짐(stop) 뒤 재요청이 잘림 -> attempt=retry, 요청 2번, 온도 0.1·0.3", async () => {
    let call = 0;
    standIn.reply = () => {
      call += 1;
      return call === 1 ? OLLAMA.stop(GARBLED_TEXT) : OLLAMA.truncated(ITEMS_JSON);
    };
    const extractor = extractorFor(OLLAMA.build(standIn.origin));
    const err = await caught(extractor.extract({ text: INPUT_TEXT }));
    expect(err).toBeInstanceOf(ExtractionOutputTruncatedError);
    expect((err as ExtractionOutputTruncatedError).attempt).toBe("retry");
    expect((err as ExtractionOutputTruncatedError).message).toContain("재요청");
    expect(standIn.requests.length).toBe(2);
    expect(standIn.requests.map((r) => optionsOf(r).temperature)).toEqual([0.1, 0.3]);
  });

  test("정상 응답(stop) -> 항목 1개, 요청 1번", async () => {
    standIn.reply = () => OLLAMA.stop(ITEMS_JSON);
    const result = await extractorFor(OLLAMA.build(standIn.origin)).extract({ text: INPUT_TEXT });
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.content).toBe("친구가 부산으로 이사한다");
    expect(standIn.requests.length).toBe(1);
  });

  test("Ollama 요청 JSON 에 callLabel 키가 없다(로그용 라벨이 공급자에 새지 않는다)", async () => {
    standIn.reply = () => OLLAMA.stop(ITEMS_JSON);
    await extractorFor(OLLAMA.build(standIn.origin)).extract({ text: INPUT_TEXT });
    const req = standIn.requests[0]!;
    expect(JSON.stringify(req.body)).not.toContain("callLabel");
    expect("callLabel" in (req.body as Record<string, unknown>)).toBe(false);
    expect("callLabel" in optionsOf(req)).toBe(false);
  });
});

describe("추출기 — 출력 한도는 생성자 인스턴스 값", () => {
  for (const provider of PROVIDERS) {
    test(`${provider.label}: 생성자 한도 ${CUSTOM_LIMIT} -> 요청 한도 칸과 잘림 오류가 그 값`, async () => {
      standIn.reply = () => provider.truncated(ITEMS_JSON);
      const extractor = extractorFor(provider.build(standIn.origin), CUSTOM_LIMIT);
      const err = await caught(extractor.extract({ text: INPUT_TEXT }));
      expect(provider.limitOf(standIn.requests[0]!)).toBe(CUSTOM_LIMIT);
      expect(err).toBeInstanceOf(ExtractionOutputTruncatedError);
      expect((err as ExtractionOutputTruncatedError).maxOutputTokens).toBe(CUSTOM_LIMIT);
    });

    test(`${provider.label}: 생략 -> 요청 한도 칸이 기본값`, async () => {
      standIn.reply = () => provider.stop(ITEMS_JSON);
      await extractorFor(provider.build(standIn.origin)).extract({ text: INPUT_TEXT });
      expect(provider.limitOf(standIn.requests[0]!)).toBe(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT);
    });
  }

  test("maxOutputTokens·attemptIdentity 가 { llmName, maxOutputTokens } 를 돌려준다", () => {
    const extractor = extractorFor(OLLAMA.build(standIn.origin), CUSTOM_LIMIT);
    expect(extractor.maxOutputTokens).toBe(CUSTOM_LIMIT);
    expect(extractor.attemptIdentity).toEqual({ llmName: OLLAMA.llmName, maxOutputTokens: CUSTOM_LIMIT });
    expect(Object.isFrozen(extractor.attemptIdentity)).toBe(true);
    const defaulted = extractorFor(OLLAMA.build(standIn.origin));
    expect(defaulted.maxOutputTokens).toBe(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT);
    expect(defaulted.attemptIdentity).toEqual({
      llmName: OLLAMA.llmName,
      maxOutputTokens: EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT,
    });
  });

  for (const bad of [EXTRACTOR_MAX_OUTPUT_TOKENS_MIN - 1, EXTRACTOR_MAX_OUTPUT_TOKENS_MAX + 1]) {
    test(`생성자 한도 ${bad} -> 키 이름이 든 오류`, () => {
      expect(() => extractorFor(OLLAMA.build(standIn.origin), bad)).toThrow(
        /^MemoryExtractor: llm\.extractor\.maxOutputTokens/,
      );
    });
  }
});

describe("추출기 — 한도를 다 쓰기 전에 잘림(stoppedBelowLimit)", () => {
  const BELOW = 1630;

  test("Ollama: 한도 2048 에 출력 토큰 1630 -> stoppedBelowLimit=true, 한도 전 문장", async () => {
    standIn.reply = () => ({ body: ollamaBody(ITEMS_JSON, "length", BELOW) });
    const err = await caught(extractorFor(OLLAMA.build(standIn.origin), 2048).extract({ text: INPUT_TEXT }));
    expect(err).toBeInstanceOf(ExtractionOutputTruncatedError);
    const truncated = err as ExtractionOutputTruncatedError;
    expect(truncated.stoppedBelowLimit).toBe(true);
    expect(truncated.message).toBe(
      `추출 응답이 출력 한도(${EXTRACTOR_MAX_OUTPUT_TOKENS_KEY}=2048)를 다 쓰기 전에 잘렸습니다(출력 토큰 ${BELOW}) — 입력과 출력이 모델 컨텍스트 창(Ollama 는 OLLAMA_NUM_CTX)을 넘었거나 공급자가 생각 단계 토큰을 함께 셌을 수 있습니다. 같은 요청을 다시 보내지 않았습니다 (${OLLAMA.llmName}, 첫 호출)`,
    );
    expect(standIn.requests.length).toBe(1);
  });

  test("Ollama: 출력 토큰이 한도와 같으면 false + 보통 문장", async () => {
    standIn.reply = () => ({ body: ollamaBody(ITEMS_JSON, "length", 2048) });
    const err = await caught(extractorFor(OLLAMA.build(standIn.origin), 2048).extract({ text: INPUT_TEXT }));
    const truncated = err as ExtractionOutputTruncatedError;
    expect(truncated.stoppedBelowLimit).toBe(false);
    expect(truncated.message).toContain("에 걸려 잘렸습니다");
    expect(truncated.message).not.toContain("다 쓰기 전에");
  });

  test("사용량을 안 주는 응답 -> false + '출력 토큰 미보고' 보통 문장", async () => {
    standIn.reply = () => ({ body: { message: { role: "assistant", content: ITEMS_JSON }, done_reason: "length" } });
    const err = await caught(extractorFor(OLLAMA.build(standIn.origin), 2048).extract({ text: INPUT_TEXT }));
    const truncated = err as ExtractionOutputTruncatedError;
    expect(truncated.outputTokens).toBeNull();
    expect(truncated.stoppedBelowLimit).toBe(false);
    expect(truncated.message).toContain("출력 토큰 미보고");
    expect(truncated.message).toContain("에 걸려 잘렸습니다");
  });
});
