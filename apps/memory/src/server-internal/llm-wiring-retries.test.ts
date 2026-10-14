/**
 * llm-wiring — 추출 클라이언트의 Anthropic SDK 자동 재시도 0 (2026-10-14 backfill-retry-ledger 사용자 결정).
 *
 * Bun 300초 제한을 끈 뒤 SDK 기본 재시도 2번이 남으면 추출 한 번이 최악 timeoutMs × 3 까지 간다. 추출 백필은
 * 실패 기록 표로 자체 재시도하므로 추출 경로만 0 으로 둔다. 정리(cleanup) 경로는 옵션을 넘기지 않아 SDK 기본값 그대로다.
 * 공급자 자리에 진짜 로컬 HTTP 서버(Bun.serve)를 세워 요청 횟수를 센다(mock 클래스 0). 슬롯에는 주소 칸이 없으므로
 * SDK 가 읽는 ANTHROPIC_BASE_URL 환경 변수로 대역 서버를 가리키고, 시험 뒤 원래 값으로 되돌린다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { MEMORY_DEFAULTS } from "../settings/memory-schema.ts";
import { buildLlmClient, EXTRACTOR_ANTHROPIC_MAX_RETRIES, type LlmClientSlot } from "./llm-wiring.ts";

let server: ReturnType<typeof Bun.serve>;
let hits = 0;
const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      hits += 1;
      return Response.json({ type: "error", error: { type: "api_error", message: "stand-in failure" } }, { status: 500 });
    },
  });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
});
beforeEach(() => { hits = 0; });

function anthropicSlot(): LlmClientSlot {
  const base = structuredClone(MEMORY_DEFAULTS.llm.extractor) as unknown as LlmClientSlot;
  return { ...base, anthropicApiKey: "sk-ant-local-stand-in", anthropicModel: "claude-haiku-4-5", timeoutMs: 10_000 };
}

async function failingChat(retries: number | undefined): Promise<void> {
  const client = buildLlmClient("anthropic", anthropicSlot(), "llm.extractor",
    retries === undefined ? {} : { anthropicMaxRetries: retries });
  expect(client).not.toBeNull();
  await expect(client!.chat([{ role: "user", content: "hi" }])).rejects.toBeDefined();
}

describe("추출 경로 Anthropic SDK 자동 재시도", () => {
  test("추출용 상수는 0 이다", () => {
    expect(EXTRACTOR_ANTHROPIC_MAX_RETRIES).toBe(0);
  });

  test("재시도 0 옵션을 주면 500 응답에 요청을 한 번만 보낸다", async () => {
    await failingChat(EXTRACTOR_ANTHROPIC_MAX_RETRIES);
    expect(hits).toBe(1);
  });

  test("옵션을 주지 않으면(정리 경로) SDK 기본 재시도가 남는다 — 요청이 한 번보다 많다", async () => {
    await failingChat(undefined);
    expect(hits).toBeGreaterThan(1);
  }, 30_000);
});
