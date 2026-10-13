/**
 * 서버 OCR 한 쪽 읽기 — 리더 6종 + 파일 업로드 리더 (2026-10-11 document-ocr spec T5).
 * 공급자 자리에 진짜 로컬 HTTP 서버(Bun.serve)를 세운다(mock 클래스 0, 실키 없음).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { MEMORY_DEFAULTS } from "../../settings/memory-schema.ts";
import type { DocumentOcrSettings } from "../../settings/memory-settings.ts";
import { startProviderStandIn, type ProviderStandIn, type RecordedRequest, type StandInReply } from "../../test-utils/provider-stand-in.ts";
import {
  DOCUMENT_OCR_PROMPT,
  createDocumentOcrPageReader,
  createDocumentOcrReader,
  type DocumentOcrFileReader,
  type FixedAddressOverrides,
} from "./page-reader.ts";
import { DocumentOcrConfigError, OcrPageError, type OcrPageImage } from "./types.ts";

const KEY = "sk-test-OCR-READER-778899";
const PAGE: OcrPageImage = { pageIndex: 1, pageCount: 3, mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) };
let standIn: ProviderStandIn;

beforeAll(() => {
  standIn = startProviderStandIn();
});
afterEach(() => {
  standIn.requests.length = 0;
});
afterAll(() => standIn.stop());

function ocrSettings(patch: (s: DocumentOcrSettings) => void): DocumentOcrSettings {
  const s = structuredClone(MEMORY_DEFAULTS.documents.ocr) as unknown as DocumentOcrSettings;
  s.schedule.timeoutMs = 3000;
  patch(s);
  return s;
}

function overrides(): FixedAddressOverrides {
  return {
    anthropicBaseUrl: standIn.origin,
    openaiBaseUrl: `${standIn.origin}/v1`,
    geminiBaseUrl: `${standIn.origin}/v1beta`,
  };
}

type Outcome = "ok" | "truncated" | "odd" | "empty";

/** 갈래별 설정·응답 모양. */
interface Case {
  name: string;
  settings: () => DocumentOcrSettings;
  reply: (outcome: Outcome, text: string) => unknown;
  /** 요청 본문에서 지시문·한도·이미지를 꺼낸다. */
  inspect: (req: RecordedRequest) => { prompt: string; maxTokens: unknown; hasImage: boolean; extra?: Record<string, unknown> };
}

const openAiReply = (outcome: Outcome, text: string) => ({
  choices: [{ message: { content: outcome === "empty" ? "" : text }, finish_reason: outcome === "truncated" ? "length" : outcome === "odd" ? "content_filter" : "stop" }],
  usage: { prompt_tokens: 1700, completion_tokens: 40 },
});
const openAiInspect = (req: RecordedRequest) => {
  const body = req.body as { messages: Array<{ content: Array<{ type: string; text?: string }> }>; max_tokens?: number; max_completion_tokens?: number; temperature?: number };
  const content = body.messages[0]!.content;
  return {
    prompt: content.find((c) => c.type === "text")!.text!,
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
    hasImage: content.some((c) => c.type === "image_url"),
    extra: { temperature: body.temperature },
  };
};

const CASES: Case[] = [
  {
    name: "api:anthropic",
    settings: () => ocrSettings((s) => { s.mode = "api"; s.api.provider = "anthropic"; s.api.anthropicApiKey = KEY; s.api.anthropicModel = "claude-sonnet-4-5"; }),
    reply: (outcome, text) => ({
      id: "m", type: "message", role: "assistant", model: "claude-sonnet-4-5",
      content: outcome === "empty" ? [] : [{ type: "text", text }],
      stop_reason: outcome === "truncated" ? "max_tokens" : outcome === "odd" ? "refusal" : "end_turn",
      stop_sequence: null, usage: { input_tokens: 1700, output_tokens: 40 },
    }),
    inspect: (req) => {
      const body = req.body as { messages: Array<{ content: Array<{ type: string; text?: string }> }>; max_tokens: number };
      const content = body.messages[0]!.content;
      return { prompt: content.find((c) => c.type === "text")!.text!, maxTokens: body.max_tokens, hasImage: content.some((c) => c.type === "image") };
    },
  },
  {
    name: "api:openai",
    settings: () => ocrSettings((s) => { s.mode = "api"; s.api.provider = "openai"; s.api.gptApiKey = KEY; s.api.gptModel = "gpt-4.1"; }),
    reply: openAiReply,
    inspect: openAiInspect,
  },
  {
    name: "api:google",
    settings: () => ocrSettings((s) => { s.mode = "api"; s.api.provider = "google"; s.api.geminiApiKey = KEY; s.api.geminiModel = "gemini-2.5-flash"; }),
    reply: (outcome, text) => ({
      candidates: [{ content: { parts: outcome === "empty" ? [] : [{ text }] }, finishReason: outcome === "truncated" ? "MAX_TOKENS" : outcome === "odd" ? "RECITATION" : "STOP" }],
      usageMetadata: { promptTokenCount: 1700, candidatesTokenCount: 40 },
    }),
    inspect: (req) => {
      const body = req.body as { contents: Array<{ parts: Array<{ text?: string; inlineData?: unknown }> }>; generationConfig: { maxOutputTokens: number; temperature: number } };
      const parts = body.contents[0]!.parts;
      return { prompt: parts.find((p) => p.text)!.text!, maxTokens: body.generationConfig.maxOutputTokens, hasImage: parts.some((p) => p.inlineData), extra: { temperature: body.generationConfig.temperature } };
    },
  },
  {
    name: "api:openai_compatible",
    settings: () => ocrSettings((s) => { s.mode = "api"; s.api.provider = "openai_compatible"; s.api.openaiBaseUrl = `${standIn.origin}/v1`; s.api.openaiModel = "vlm"; s.api.openaiApiKey = KEY; }),
    reply: openAiReply,
    inspect: openAiInspect,
  },
  {
    name: "local:lmstudio_vision",
    settings: () => ocrSettings((s) => { s.mode = "local"; s.local.provider = "lmstudio_vision"; s.local.lmstudioUrl = `${standIn.origin}/v1`; s.local.lmstudioModel = "lm-vlm"; }),
    reply: openAiReply,
    inspect: openAiInspect,
  },
  {
    name: "local:ollama_vision",
    settings: () => ocrSettings((s) => { s.mode = "local"; s.local.provider = "ollama_vision"; s.local.ollamaUrl = standIn.origin; s.local.ollamaModel = "qwen3-vl"; }),
    reply: (outcome, text) => ({
      model: "qwen3-vl", message: { role: "assistant", content: outcome === "empty" ? "" : text }, done: true,
      done_reason: outcome === "truncated" ? "length" : outcome === "odd" ? "unload" : "stop", prompt_eval_count: 1700, eval_count: 40,
    }),
    inspect: (req) => {
      const body = req.body as { messages: Array<{ content: string; images?: string[] }>; options: { num_predict: number; num_ctx?: number; temperature: number } };
      return { prompt: body.messages[0]!.content, maxTokens: body.options.num_predict, hasImage: (body.messages[0]!.images ?? []).length === 1, extra: { num_ctx: body.options.num_ctx, temperature: body.options.temperature } };
    },
  },
];

function replyWith(reply: StandInReply): void {
  standIn.reply = () => reply;
}

async function failureOf(promise: Promise<unknown>): Promise<OcrPageError> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(OcrPageError);
  return err as OcrPageError;
}

describe("리더 6종 — 요청 모양과 판정", () => {
  for (const c of CASES) {
    test(`${c.name}: 지시문·쪽 한도·이미지를 보내고 글을 돌려준다`, async () => {
      replyWith({ body: c.reply("ok", "# 2쪽 본문") });
      const reader = createDocumentOcrPageReader(c.settings(), overrides());
      const out = await reader.readPage(PAGE);
      expect(out.markdown).toBe("# 2쪽 본문");
      expect(out.usage).toEqual({ inputTokens: 1700, outputTokens: 40 });
      const seen = c.inspect(standIn.requests[0]!);
      expect(seen.prompt).toBe(DOCUMENT_OCR_PROMPT);
      expect(seen.maxTokens).toBe(8192);
      expect(seen.hasImage).toBe(true);
      if (c.name === "local:ollama_vision") expect(seen.extra?.num_ctx).toBe(8192 + 8192);
      if (seen.extra && "temperature" in seen.extra && seen.extra.temperature !== undefined) expect(seen.extra.temperature).toBe(0);
      expect(JSON.stringify(standIn.requests[0]!.search)).not.toContain(KEY);
    });

    test(`${c.name}: 출력 한도 잘림·비정상 종료는 결정적 실패, 정상 종료 + 빈 글은 빈 쪽(실패 아님)`, async () => {
      replyWith({ body: c.reply("truncated", "앞부분만") });
      const truncated = await failureOf(createDocumentOcrPageReader(c.settings(), overrides()).readPage(PAGE));
      expect(truncated.klass).toBe("deterministic");
      expect(truncated.message).toContain("documents.ocr.maxOutputTokensPerPage=8192");
      expect(truncated.message).toContain("2쪽");
      replyWith({ body: c.reply("odd", "글") });
      const odd = await failureOf(createDocumentOcrPageReader(c.settings(), overrides()).readPage(PAGE));
      expect(odd.klass).toBe("deterministic");
      expect(odd.message).toContain("정상 종료가 아님");
      replyWith({ body: c.reply("empty", "") });
      const blank = await createDocumentOcrPageReader(c.settings(), overrides()).readPage(PAGE);
      expect(blank.blank).toBe(true);
      expect(blank.markdown).toBe("");
      replyWith({ body: c.reply("ok", "   \n ") }); // 공백뿐인 글도 빈 쪽
      expect((await createDocumentOcrPageReader(c.settings(), overrides()).readPage(PAGE)).blank).toBe(true);
    });
  }
});

describe("오류 3분류·키 가림", () => {
  const openai = CASES.find((c) => c.name === "api:openai")!;

  test("401·403·404(모델 없음) → 설정, 400 → 그 쪽의 결정적 실패(문서 OCR 만, 사용자 결정 M1)", async () => {
    for (const status of [401, 403, 404]) {
      replyWith({ status, body: { error: { message: "nope" } } });
      expect((await failureOf(createDocumentOcrPageReader(openai.settings(), overrides()).readPage(PAGE))).klass).toBe("config");
    }
    replyWith({ status: 400, body: { error: { message: "bad image" } } });
    const bad = await failureOf(createDocumentOcrPageReader(openai.settings(), overrides()).readPage(PAGE));
    expect(bad.klass).toBe("deterministic");
    expect(bad.httpStatus).toBe(400);
    const google = CASES.find((c) => c.name === "api:google")!;
    replyWith({ status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "Unable to process input image" } } });
    expect((await failureOf(createDocumentOcrPageReader(google.settings(), overrides()).readPage(PAGE))).klass).toBe("deterministic");
  });

  test("정리 깊은 패스 분류는 그대로 — 400 은 거기서는 설정", async () => {
    const { classifyLlmError } = await import("../../memory/cleanup-deep-pass/error-classifier.ts");
    expect(classifyLlmError({ status: 400, timedOut: false })).toBe("config");
    expect(classifyLlmError({ status: 404, timedOut: false })).toBe("deterministic");
  });

  test("응답 형식이 틀린 실패는 영어 해석 문장 앞에 한국어 사유를 붙인다", async () => {
    replyWith({ body: { unexpected: true } });
    const err = await failureOf(createDocumentOcrPageReader(openai.settings(), overrides()).readPage(PAGE));
    expect(err.klass).toBe("deterministic");
    expect(err.message.startsWith("AI 응답을 글로 읽지 못함")).toBe(true);
  });

  test("429(Retry-After)·503 → 일시, 404·422 → 결정적", async () => {
    replyWith({ status: 429, headers: { "retry-after": "120" }, body: { error: { message: "slow down" } } });
    const limited = await failureOf(createDocumentOcrPageReader(openai.settings(), overrides()).readPage(PAGE));
    expect(limited.klass).toBe("transient");
    expect(limited.retryAfterMs).toBe(120_000);
    replyWith({ status: 503, body: "busy" });
    expect((await failureOf(createDocumentOcrPageReader(openai.settings(), overrides()).readPage(PAGE))).klass).toBe("transient");
    replyWith({ status: 422, body: "no" });
    expect((await failureOf(createDocumentOcrPageReader(openai.settings(), overrides()).readPage(PAGE))).klass).toBe("deterministic");
  });

  test("Anthropic SDK 의 429 도 상태 코드로 일시", async () => {
    const anthropic = CASES.find((c) => c.name === "api:anthropic")!;
    replyWith({ status: 429, headers: { "retry-after": "30" }, body: { type: "error", error: { type: "rate_limit_error", message: "slow" } } });
    const err = await failureOf(createDocumentOcrPageReader(anthropic.settings(), overrides()).readPage(PAGE));
    expect(err.klass).toBe("transient");
    expect(standIn.requests.length).toBe(1); // SDK 재시도 0 — 원장이 시도를 센다.
  });

  test("시간 초과 → 일시", async () => {
    const ollama = CASES.find((c) => c.name === "local:ollama_vision")!;
    replyWith({ hang: true });
    const settings = ollama.settings();
    settings.schedule.timeoutMs = 200;
    expect((await failureOf(createDocumentOcrPageReader(settings, overrides()).readPage(PAGE))).klass).toBe("transient");
  });

  test("공급자가 오류 본문에 키를 되돌려 줘도 문장에 키가 없다", async () => {
    replyWith({ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } });
    const err = await failureOf(createDocumentOcrPageReader(openai.settings(), overrides()).readPage(PAGE));
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("[가림]");
  });
});

describe("설정 검사 — 생성 시점", () => {
  test("빈 칸은 칸 이름을 대며 DocumentOcrConfigError", () => {
    const cases: Array<[(s: DocumentOcrSettings) => void, string]> = [
      [(s) => { s.mode = "api"; s.api.provider = "openai"; s.api.gptModel = "m"; }, "documents.ocr.api.gptApiKey"],
      [(s) => { s.mode = "api"; s.api.provider = "google"; s.api.geminiApiKey = KEY; }, "documents.ocr.api.geminiModel"],
      [(s) => { s.mode = "api"; s.api.provider = "anthropic"; s.api.anthropicModel = "m"; }, "documents.ocr.api.anthropicApiKey"],
      [(s) => { s.mode = "api"; s.api.provider = "openai_compatible"; s.api.openaiModel = "m"; }, "documents.ocr.api.openaiBaseUrl"],
      [(s) => { s.mode = "local"; s.local.provider = "lmstudio_vision"; }, "documents.ocr.local.lmstudioModel"],
      [(s) => { s.mode = "local"; s.local.provider = "ollama_vision"; s.local.ollamaModel = ""; }, "documents.ocr.local.ollamaModel"],
      [(s) => { s.mode = "api"; s.api.provider = "http_file_api"; }, "documents.ocr.api.endpointUrl"],
    ];
    for (const [patch, field] of cases) {
      const err = (() => { try { createDocumentOcrReader(ocrSettings(patch)); return null; } catch (e) { return e; } })();
      expect(err).toBeInstanceOf(DocumentOcrConfigError);
      expect((err as Error).message).toContain(field);
    }
  });

  test("로컬 command·수동·보조 프로그램 모드는 서버 자동 처리 대상이 아님", () => {
    expect(() => createDocumentOcrReader(ocrSettings((s) => { s.mode = "local"; s.local.provider = "command"; }))).toThrow(
      "documents.ocr.local.provider=command 는 서버 자동 처리를 지원하지 않음",
    );
    expect(() => createDocumentOcrReader(ocrSettings((s) => { s.mode = "manual"; }))).toThrow(DocumentOcrConfigError);
    expect(() => createDocumentOcrReader(ocrSettings((s) => { s.mode = "pc_companion"; }))).toThrow(DocumentOcrConfigError);
  });

  test("지문 재료가 공급자·모델·한도·지시문 버전으로 바뀐다", () => {
    const a = createDocumentOcrReader(CASES[1]!.settings(), overrides()).fingerprintParts;
    const higher = CASES[1]!.settings();
    higher.maxOutputTokensPerPage = 16384;
    expect(createDocumentOcrReader(higher, overrides()).fingerprintParts).not.toEqual(a);
    expect(a).toMatchObject({ provider: "openai", model: "gpt-4.1", maxOutputTokensPerPage: 8192, promptVersion: 1 });
  });
});

describe("파일 업로드 리더", () => {
  const asset = { sha256: "s", bytes: new Uint8Array([1, 2, 3]), mimeType: "application/pdf", originalName: "scan.pdf" };
  const fileSettings = () => ocrSettings((s) => { s.mode = "api"; s.api.provider = "http_file_api"; s.api.endpointUrl = `${standIn.origin}/ocr`; s.api.apiKey = KEY; });
  const fileReader = () => createDocumentOcrReader(fileSettings()) as DocumentOcrFileReader;

  test("문서 파일을 올리고 Markdown 을 자르지 않고 받는다", async () => {
    const long = "가".repeat(2000);
    replyWith({ body: long });
    const reader = fileReader();
    expect(reader.kind).toBe("file");
    expect(reader.providerName).toBe("server-api:http_file_api");
    const out = await reader.readDocument("doc_1", asset);
    expect(out.markdown).toBe(long);
    expect(out.usage).toBeNull();
    expect(standIn.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  test("HTTP 상태로 분류하고 키를 가린다", async () => {
    const expectations: Array<[number, string]> = [[401, "config"], [422, "deterministic"], [500, "transient"], [429, "transient"]];
    for (const [status, klass] of expectations) {
      replyWith({ status, body: `echo ${KEY}` });
      const err = await failureOf(fileReader().readDocument("doc_1", asset));
      expect(err.klass).toBe(klass as never);
      expect(err.message).not.toContain(KEY);
    }
  });

  test("빈 Markdown 은 결정적 실패", async () => {
    replyWith({ body: "   " });
    expect((await failureOf(fileReader().readDocument("doc_1", asset))).klass).toBe("deterministic");
  });
});
