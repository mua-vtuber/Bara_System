/**
 * metadata-infer-cycle.truncation.test.ts — 장소·시각 채우기(갈래 2) 응답이 출력 한도에 잘렸을 때.
 *
 * 문제(2026-10-16 A1 실측): 출력 한도 512 에 10개 메모 세션 응답이 매번 잘려(done=length) JSON 이 끊기고,
 * 일반 실패로 세어져 같은 세션이 매 주기 다시 보내졌다. 이 파일은 다음을 본다.
 *   - 잘린 세션은 메모에 잘린 한도(metaInferTruncatedAt)를 적고, 같은 한도로는 다시 보내지 않는다.
 *   - 한도를 바꾸면 그 세션을 다시 보낸다.
 *   - 잘림이 아닌 실패(네트워크·깨진 JSON)는 예전처럼 다음 주기에 다시 시도한다.
 *   - infer 함수가 설정 한도를 공급자 요청에 싣고, 종료 사유(done_reason "length")로 잘림을 판정한다.
 *
 * 실제 SQLite + 실제 SqliteMemoryStore + 실제 EventBus. LLM 쪽은 실제 OllamaClient 가 실제 로컬 HTTP
 * 대역 서버(test-utils/provider-stand-in.ts)에 요청한다. 인터페이스를 흉내 내는 객체는 만들지 않는다.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { createEmbedder, embeddingDimensionOf } from "../embedding/factory.ts";
import type { Embedder } from "../embedding/types.ts";
import { EventRepository } from "../db/store-internal/event-repository.ts";
import { EventBus } from "../server-internal/event-bus.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import type { ChatMessage, ObservableLlmClient } from "../llm/types.ts";
import {
  startProviderStandIn,
  type ProviderStandIn,
  type RecordedRequest,
} from "../test-utils/provider-stand-in.ts";
import {
  createOllamaInferFn,
  MetadataInferOutputTruncatedError,
  runMetadataInferCycle,
  type SessionInferFn,
} from "./metadata-infer-cycle.ts";
import {
  METADATA_INFER_MAX_OUTPUT_TOKENS_DEFAULT,
  METADATA_INFER_MAX_OUTPUT_TOKENS_KEY,
  METADATA_INFER_MAX_OUTPUT_TOKENS_MAX,
  METADATA_INFER_MAX_OUTPUT_TOKENS_MIN,
} from "./metadata-infer-output-limit.ts";

const MODEL = "bge-m3";
const G = 180; // 세션 간격(분).
const LIMIT = METADATA_INFER_MAX_OUTPUT_TOKENS_DEFAULT;
/** 사용자가 한도를 올린 상황. */
const RAISED_LIMIT = LIMIT * 2;
const NOW = Date.parse("2026-06-02T00:00:00");
const LLM_NAME = "ollama:fixture-model";
/** 한도에 걸려 중간에 끊긴 JSON 배열(A1 에서 본 모양). */
const CUT_JSON = '[{"nodeId":2,"field":"place","value":"에버';

let db: Database;
let store: SqliteMemoryStore;
let eventBus: EventBus;
let embedder: Embedder;
let standIn: ProviderStandIn;

beforeAll(async () => {
  embedder = createEmbedder({ model: MODEL });
  await embedder.load();
  standIn = startProviderStandIn();
});

afterAll(() => {
  standIn.stop();
});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: embeddingDimensionOf(MODEL) });
  store = new SqliteMemoryStore(db, embedder);
  eventBus = new EventBus(new EventRepository(db));
});

afterEach(() => {
  db.close();
  standIn.requests.length = 0;
});

/** Ollama /api/chat 응답 본문. doneReason "length" = 출력 한도 잘림. */
function ollamaReply(text: string, doneReason: "stop" | "length", evalCount: number) {
  return {
    body: {
      message: { role: "assistant", content: text },
      done_reason: doneReason,
      prompt_eval_count: 10,
      eval_count: evalCount,
    },
  };
}

function ollamaInfer(maxOutputTokens: number): SessionInferFn {
  const client = new OllamaClient({ baseUrl: standIn.origin, model: "fixture-model", timeoutMs: 5000 });
  return createOllamaInferFn(client, { maxOutputTokens });
}

/** Ollama 요청 본문의 출력 한도(options.num_predict). */
function numPredictOf(req: RecordedRequest): unknown {
  const body = req.body as { options?: { num_predict?: unknown } };
  if (!body.options) throw new Error("Ollama 요청 본문에 options 칸이 없다");
  return body.options.num_predict;
}

/** 장소가 있는 메모 1개 + 없는 메모 1개 — 섞인(LLM 호출 대상) 닫힌 세션 하나. */
async function addMixedSession(): Promise<[number, number]> {
  const n1 = await store.addNode({ content: "에버랜드 왔다", sourceType: "llm_extract", author: "alice" });
  const n2 = await store.addNode({ content: "롤러코스터 탔다", sourceType: "llm_extract", author: "alice" });
  const setAt = db.prepare("UPDATE knowledge_nodes SET created_at = ? WHERE id = ?");
  setAt.run("2026-06-01 10:00:00", n1);
  setAt.run("2026-06-01 10:10:00", n2);
  await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
  return [n1, n2];
}

function readMarks(nodeId: number): { inferred: number | null; truncatedAt: number | null } {
  return db
    .prepare(
      `SELECT metadata_json ->> '$.metaInferred' AS inferred,
              metadata_json ->> '$.metaInferTruncatedAt' AS truncatedAt
         FROM knowledge_nodes WHERE id = ?`,
    )
    .get(nodeId) as { inferred: number | null; truncatedAt: number | null };
}

function cycle(infer: SessionInferFn, maxOutputTokens: number) {
  return runMetadataInferCycle({
    db,
    infer,
    eventBus,
    gapMinutes: G,
    batchSize: 50,
    maxOutputTokens,
    now: () => NOW,
  });
}

/** console.warn 로 나간 문장을 모은다(원래 함수는 끝나면 되돌린다). */
async function captureWarn<T>(run: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  try {
    return { result: await run(), warns };
  } finally {
    console.warn = original;
  }
}

describe("출력 한도 잘림 — 같은 한도로는 다시 보내지 않는다", () => {
  test("잘린 세션은 한도를 적고 따로 세며, 같은 한도의 다음 사이클에는 후보에서 빠진다", async () => {
    const [n1, n2] = await addMixedSession();
    standIn.reply = () => ollamaReply(CUT_JSON, "length", LIMIT);

    const { result: first, warns } = await captureWarn(() => cycle(ollamaInfer(LIMIT), LIMIT));
    expect(standIn.requests).toHaveLength(1);
    expect(first.truncatedSessions).toBe(1);
    expect(first.inferFailures).toBe(0);
    expect(first.proposalsInserted).toBe(0);
    for (const id of [n1, n2]) {
      expect(readMarks(id)).toEqual({ inferred: null, truncatedAt: LIMIT });
    }
    // 한 줄 경고에 메모 번호·한도·설정 칸 경로가 모두 들어 있다.
    const truncWarns = warns.filter((w) => w.includes("출력 한도 잘림"));
    expect(truncWarns).toHaveLength(1);
    expect(truncWarns[0]).toContain(`nodeIds=${n1},${n2}`);
    expect(truncWarns[0]).toContain(`한도 ${LIMIT}`);
    expect(truncWarns[0]).toContain(METADATA_INFER_MAX_OUTPUT_TOKENS_KEY);

    const second = await cycle(ollamaInfer(LIMIT), LIMIT);
    expect(standIn.requests).toHaveLength(1); // 다시 보내지 않았다.
    expect(second.candidatesFound).toBe(0);
    expect(second.truncatedSessions).toBe(0);
  });

  test("한도를 바꾸면 잘렸던 세션을 다시 보내고, 정상 회신이면 평가 완료로 바뀌며 잘림 표시는 지워진다", async () => {
    const [n1, n2] = await addMixedSession();
    standIn.reply = () => ollamaReply(CUT_JSON, "length", LIMIT);
    await captureWarn(() => cycle(ollamaInfer(LIMIT), LIMIT));
    expect(standIn.requests).toHaveLength(1);

    standIn.reply = () =>
      ollamaReply(JSON.stringify([{ nodeId: n2, field: "place", value: "에버랜드" }]), "stop", 40);
    const raised = await cycle(ollamaInfer(RAISED_LIMIT), RAISED_LIMIT);

    expect(standIn.requests).toHaveLength(2);
    expect(numPredictOf(standIn.requests[1]!)).toBe(RAISED_LIMIT);
    expect(raised.candidatesFound).toBe(2);
    expect(raised.truncatedSessions).toBe(0);
    expect(raised.proposalsInserted).toBe(1);
    for (const id of [n1, n2]) {
      expect(readMarks(id)).toEqual({ inferred: 1, truncatedAt: null });
    }
  });

  test("새 한도에서도 잘리면 새 한도를 적고, 그 한도로는 다시 보내지 않는다", async () => {
    const [n1, n2] = await addMixedSession();
    standIn.reply = (req) => ollamaReply(CUT_JSON, "length", numPredictOf(req) as number);
    await captureWarn(() => cycle(ollamaInfer(LIMIT), LIMIT));
    const { result } = await captureWarn(() => cycle(ollamaInfer(RAISED_LIMIT), RAISED_LIMIT));

    expect(result.truncatedSessions).toBe(1);
    expect(standIn.requests).toHaveLength(2);
    for (const id of [n1, n2]) expect(readMarks(id).truncatedAt).toBe(RAISED_LIMIT);

    await cycle(ollamaInfer(RAISED_LIMIT), RAISED_LIMIT);
    expect(standIn.requests).toHaveLength(2);
  });

  test("infer 함수와 사이클의 한도가 다르면 조용히 넘기지 않고 칸 경로가 든 오류로 멈춘다", async () => {
    const [n1, n2] = await addMixedSession();
    standIn.reply = () => ollamaReply(CUT_JSON, "length", LIMIT);
    let caught: unknown;
    try {
      await cycle(ollamaInfer(LIMIT), RAISED_LIMIT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(METADATA_INFER_MAX_OUTPUT_TOKENS_KEY);
    expect((caught as Error).message).toContain("불일치");
    for (const id of [n1, n2]) expect(readMarks(id)).toEqual({ inferred: null, truncatedAt: null });
  });
});

describe("잘림이 아닌 실패는 다음 사이클에 다시 시도한다", () => {
  test("정상 종료인데 깨진 JSON — 일반 실패로 세고 표시 없이 다음 사이클에 다시 보낸다", async () => {
    const [n1, n2] = await addMixedSession();
    standIn.reply = () => ollamaReply(CUT_JSON, "stop", 30);

    const { result: first } = await captureWarn(() => cycle(ollamaInfer(LIMIT), LIMIT));
    expect(first.inferFailures).toBe(1);
    expect(first.truncatedSessions).toBe(0);
    for (const id of [n1, n2]) expect(readMarks(id)).toEqual({ inferred: null, truncatedAt: null });

    await captureWarn(() => cycle(ollamaInfer(LIMIT), LIMIT));
    expect(standIn.requests).toHaveLength(2);
  });

  test("공급자 오류(HTTP 500) — 일반 실패로 세고 다음 사이클에 다시 보낸다", async () => {
    await addMixedSession();
    standIn.reply = () => ({ status: 500, body: { error: "model crashed" } });

    const { result: first } = await captureWarn(() => cycle(ollamaInfer(LIMIT), LIMIT));
    expect(first.inferFailures).toBe(1);
    expect(first.truncatedSessions).toBe(0);
    const sentFirst = standIn.requests.length;
    expect(sentFirst).toBeGreaterThanOrEqual(1);

    await captureWarn(() => cycle(ollamaInfer(LIMIT), LIMIT));
    expect(standIn.requests.length).toBeGreaterThan(sentFirst);
  });
});

describe("createOllamaInferFn — 한도 전달과 잘림 판정", () => {
  test("설정 한도를 공급자 요청(num_predict)에 싣는다", async () => {
    standIn.reply = () => ollamaReply("[]", "stop", 2);
    const out = await ollamaInfer(RAISED_LIMIT)({
      nodes: [{ id: 1, content: "에버랜드 왔다", place: "에버랜드", eventAt: null }],
    });
    expect(out).toEqual([]);
    expect(standIn.requests).toHaveLength(1);
    expect(numPredictOf(standIn.requests[0]!)).toBe(RAISED_LIMIT);
  });

  test("done_reason length 면 파싱하지 않고 MetadataInferOutputTruncatedError(한도·출력 토큰·이름)", async () => {
    // 잘린 글이라도 우연히 읽히는 배열이면 파싱이 성공했을 것 — 종료 사유가 먼저라 그래도 잘림 오류다.
    standIn.reply = () => ollamaReply("[]", "length", LIMIT);
    let caught: unknown;
    try {
      await ollamaInfer(LIMIT)({ nodes: [{ id: 1, content: "글", place: null, eventAt: null }] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MetadataInferOutputTruncatedError);
    const err = caught as MetadataInferOutputTruncatedError;
    expect(err.maxOutputTokens).toBe(LIMIT);
    expect(err.outputTokens).toBe(LIMIT);
    expect(err.llmName).toBe(LLM_NAME);
    expect(err.message).toContain(`${METADATA_INFER_MAX_OUTPUT_TOKENS_KEY}=${LIMIT}`);
  });

  test.each([[METADATA_INFER_MAX_OUTPUT_TOKENS_MIN - 1], [METADATA_INFER_MAX_OUTPUT_TOKENS_MAX + 1], [1024.5]])(
    "범위 밖 한도 %p 는 만들 때 칸 경로가 든 오류로 던진다",
    (bad) => {
      expect(() => ollamaInfer(bad)).toThrow(METADATA_INFER_MAX_OUTPUT_TOKENS_KEY);
    },
  );

  test("사이클도 범위 밖 한도를 받으면 칸 경로가 든 오류로 던진다", async () => {
    await expect(cycle(ollamaInfer(LIMIT), METADATA_INFER_MAX_OUTPUT_TOKENS_MIN - 1)).rejects.toThrow(
      METADATA_INFER_MAX_OUTPUT_TOKENS_KEY,
    );
  });
});

describe("createOllamaInferFn — 지시문·메모 목록 양식", () => {
  test("메모 목록은 [번호] 양식이고 'node' 글자가 없으며, 근거에 번호를 쓰지 말라고 지시한다", async () => {
    const seen: ChatMessage[] = [];
    const client: ObservableLlmClient = {
      name: "fixture",
      chat: async () => {
        throw new Error("createOllamaInferFn 은 종료 사유가 필요해 chatDetailed 만 불러야 한다");
      },
      chatDetailed: async (messages) => {
        seen.push(...messages);
        return { text: "[]", stopReason: "stop", usage: null };
      },
    };
    const result = await createOllamaInferFn(client, { maxOutputTokens: LIMIT })({
      nodes: [
        { id: 97, content: "에버랜드 왔다", place: "에버랜드", eventAt: null },
        { id: 98, content: "롤러코스터 탔다", place: null, eventAt: null },
      ],
    });

    expect(result).toEqual([]);
    const system = seen.find((m) => m.role === "system")!.content;
    const user = seen.find((m) => m.role === "user")!.content;
    expect(user).toContain('[97] "에버랜드 왔다" (장소=에버랜드, 시각=없음)');
    expect(user).not.toContain("node");
    expect(system).toContain("메모 번호는 쓰지 말고");
  });
});
