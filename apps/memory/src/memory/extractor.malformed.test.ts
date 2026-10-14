/**
 * extractor.malformed.test.ts — 추출 응답이 첫 호출과 재요청 모두 형식이 깨졌을 때
 * ExtractionMalformedResponseError 로 멈추는지, 정상 빈 결과는 오류가 아닌지 검증한다
 * (speed-step1 spec 4.4).
 *
 * 실제 클라이언트 + 실제 로컬 HTTP 대역 서버(test-utils/provider-stand-in.ts) + 실제 SQLite.
 * 인터페이스를 흉내 내는 객체는 만들지 않는다.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import { OpenAiCompatibleClient } from "../llm/openai-compatible-client.ts";
import type { ObservableLlmClient } from "../llm/types.ts";
import {
  startProviderStandIn,
  type ProviderStandIn,
  type StandInReply,
} from "../test-utils/provider-stand-in.ts";
import { MemoryExtractor } from "./extractor.ts";
import { ExtractionMalformedResponseError } from "./extractor-internal/response-errors.ts";

/** 쪼갤 가치가 있어(절 접속어미 여럿) 짧은 단일 의미 건너뛰기에 걸리지 않는 입력. */
const INPUT_TEXT =
  "어제 서울에서 오랜 친구를 만났고, 그 친구는 곧 부산으로 이사한다고 했으며, 다음 달에는 함께 여행을 가기로 했다.";
const ITEM = { content: "친구가 부산으로 이사한다", memoryType: "fact", importance: 0.8 };
const LOW_IMPORTANCE_ITEM = { content: "사소한 내용입니다", memoryType: "fact", importance: 0.01 };
const EXPLANATION = "죄송합니다만 JSON 이 아닌 말로 답하겠습니다";

let standIn: ProviderStandIn;
let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;

beforeAll(() => {
  standIn = startProviderStandIn();
  // extract() 는 임베딩을 하지 않는다 — 차원(1024)만 쓰므로 load() 없이 구성한다(truncation 시험 선례).
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

function ollama(): OllamaClient {
  return new OllamaClient({ baseUrl: standIn.origin, model: "fixture-model", timeoutMs: 5000 });
}

function ollamaReply(text: string): StandInReply {
  return { body: { message: { role: "assistant", content: text }, done_reason: "stop", eval_count: 20 } };
}

function openAiReply(text: string): StandInReply {
  return {
    body: {
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    },
  };
}

/** 호출 순서대로 응답 글을 돌려준다. 모자라면 오류. */
function replyInOrder(texts: readonly string[], wrap: (t: string) => StandInReply): void {
  let call = 0;
  standIn.reply = () => {
    const text = texts[call];
    call += 1;
    if (text === undefined) throw new Error(`예상보다 요청이 많다(${call}번째)`);
    return wrap(text);
  };
}

function extractorFor(client: ObservableLlmClient): MemoryExtractor {
  return new MemoryExtractor(client, store, embedder);
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("오류가 나야 하는데 성공했다");
    },
    (e: unknown) => e,
  );
}

describe("추출기 — 형식이 두 번 깨지면 오류", () => {
  const CASES: ReadonlyArray<{ label: string; first: string; retry: string }> = [
    { label: "빈 글 두 번", first: "", retry: "" },
    { label: "설명문 두 번", first: EXPLANATION, retry: "여전히 설명문입니다" },
    { label: "JSON 이 아닌 숫자 두 번", first: "42", retry: "42" },
    { label: "잘린 JSON 뒤 설명문", first: '[{"content":"잘린', retry: EXPLANATION },
  ];
  for (const c of CASES) {
    test(`${c.label} -> ExtractionMalformedResponseError, 요청 2번, 문장에 응답 글 없음`, async () => {
      replyInOrder([c.first, c.retry], ollamaReply);
      const err = await caught(extractorFor(ollama()).extract({ text: INPUT_TEXT }));
      expect(err).toBeInstanceOf(ExtractionMalformedResponseError);
      const malformed = err as ExtractionMalformedResponseError;
      expect(malformed.name).toBe("ExtractionMalformedResponseError");
      expect(malformed.llmName).toBe("ollama:fixture-model");
      expect(malformed.attempts).toBe(2);
      expect(malformed.firstLength).toBe(c.first.length);
      expect(malformed.retryLength).toBe(c.retry.length);
      expect(malformed.message).toBe(
        `추출 응답을 두 번 모두 읽지 못했습니다(빈 글이거나 JSON 형식이 아님) — 0건으로 처리하지 않았습니다 (ollama:fixture-model, 응답 길이 ${c.first.length}자/${c.retry.length}자)`,
      );
      for (const piece of [c.first, c.retry].filter((t) => t.length > 3)) {
        expect(malformed.message).not.toContain(piece);
      }
      expect(standIn.requests.length).toBe(2);
    });
  }

  test("OpenAI 호환 공급자도 깨짐 두 번 -> 같은 오류(공급자와 무관)", async () => {
    // OpenAI 호환 클라이언트는 빈 content 를 자체 오류로 거절하므로(이 시험의 대상 아님) 두 응답 모두 글이 있는 설명문이다.
    replyInOrder([EXPLANATION, "42"], openAiReply);
    const client = new OpenAiCompatibleClient({
      baseUrl: `${standIn.origin}/v1`,
      model: "local-model",
      timeoutMs: 5000,
    });
    const err = await caught(extractorFor(client).extract({ text: INPUT_TEXT }));
    expect(err).toBeInstanceOf(ExtractionMalformedResponseError);
    const malformed = err as ExtractionMalformedResponseError;
    expect(malformed.llmName).toBe("openai-compatible:local-model");
    expect(malformed.firstLength).toBe(EXPLANATION.length);
    expect(malformed.retryLength).toBe(2);
    expect(standIn.requests.length).toBe(2);
  });
});

describe("추출기 — 정상 빈 결과는 오류가 아니다", () => {
  test("`[]` 명시 -> 0건, 요청 1번", async () => {
    replyInOrder(["[]"], ollamaReply);
    const result = await extractorFor(ollama()).extract({ text: INPUT_TEXT });
    expect(result.items).toEqual([]);
    expect(standIn.requests.length).toBe(1);
  });

  test('`{"items":[]}` -> 0건, 요청 1번', async () => {
    replyInOrder(['{"items":[]}'], ollamaReply);
    const result = await extractorFor(ollama()).extract({ text: INPUT_TEXT });
    expect(result.items).toEqual([]);
    expect(standIn.requests.length).toBe(1);
  });

  test("정상 JSON 인데 중요도가 낮아 필터가 비움 -> 0건, 요청 1번", async () => {
    replyInOrder([JSON.stringify([LOW_IMPORTANCE_ITEM])], ollamaReply);
    const result = await extractorFor(ollama()).extract({ text: INPUT_TEXT });
    expect(result.items).toEqual([]);
    expect(standIn.requests.length).toBe(1);
  });

  test("첫 응답 깨짐 -> 재요청 `[]` -> 0건, 요청 2번", async () => {
    replyInOrder([EXPLANATION, "[]"], ollamaReply);
    const result = await extractorFor(ollama()).extract({ text: INPUT_TEXT });
    expect(result.items).toEqual([]);
    expect(standIn.requests.length).toBe(2);
  });

  test("첫 응답 깨짐 -> 재요청 항목 1개 -> 1건", async () => {
    replyInOrder([EXPLANATION, JSON.stringify([ITEM])], ollamaReply);
    const result = await extractorFor(ollama()).extract({ text: INPUT_TEXT });
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.content).toBe(ITEM.content);
    expect(standIn.requests.length).toBe(2);
  });
});
