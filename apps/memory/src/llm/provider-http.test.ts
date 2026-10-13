/**
 * provider-http — 오류 문장 가림·본문 못 읽음 표시. 진짜 로컬 HTTP 서버(Bun.serve)만 쓴다.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { requestProviderJson, UNREADABLE_BODY_MARK } from "./provider-http.ts";
import { LlmRequestError } from "./errors.ts";
import { OpenAiClient } from "./openai-client.ts";
import { GeminiClient } from "./gemini-client.ts";
import { startProviderStandIn, type ProviderStandIn } from "../test-utils/provider-stand-in.ts";

const KEY = "sk-test-HTTP-MASK-9988";
/**
 * 헤더를 보낸 뒤 연결을 끊기까지 기다리는 시간. 헤더와 연결 끊김(FIN)이 클라이언트에 한 번에 읽히면
 * Bun 의 fetch 는 응답(상태 500)을 돌려주지 않고 ECONNRESET 으로 fetch 자체를 실패시킨다 — 그러면
 * "본문을 못 읽음" 경로가 아니라 "연결 실패(status null)" 경로를 타 이 검사가 엉뚱하게 깨진다.
 * 같은 프로세스의 이벤트 루프가 잠깐 멈추면(전체 스위트처럼 무거울 때) 바로 끊는 방식은 그렇게 된다.
 * 헤더가 먼저 읽힌 뒤에 끊기도록 이만큼 늦춘다.
 */
const BODY_DROP_DELAY_MS = 250;
let standIn: ProviderStandIn;
let brokenBody: Bun.TCPSocketListener<undefined>;

beforeAll(() => {
  standIn = startProviderStandIn();
  // 상태 줄·헤더(본문 1000바이트 예고)와 본문 앞부분만 보내고, 잠시 뒤 본문 도중 연결을 끊는 진짜
  // TCP 서버 — 클라이언트는 상태 500 응답을 받은 뒤 본문 읽기에서 실패한다.
  brokenBody = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.write("HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nContent-Length: 1000\r\n\r\npartial");
        setTimeout(() => socket.end(), BODY_DROP_DELAY_MS);
      },
    },
  });
});
afterAll(() => {
  standIn.stop();
  brokenBody.stop(true);
});

describe("2xx 응답 본문의 error 문장도 키를 가린다", () => {
  test("OpenAI 200 + error.message 에 보낸 키 → 던진 문장에 키 없음", async () => {
    standIn.reply = () => ({ body: { error: { message: `bad key ${KEY}` } } });
    const c = new OpenAiClient({ apiKey: KEY, model: "gpt-4o", timeoutMs: 5000, baseUrl: `${standIn.origin}/v1` });
    const err = (await c.chatDetailed([{ role: "user", content: "x" }]).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("OpenAI error: bad key [가림]");
    expect(err.message).not.toContain(KEY);
  });

  test("Gemini 200 + error.message 에 보낸 키 → 던진 문장에 키 없음", async () => {
    standIn.reply = () => ({ body: { error: { message: `invalid ${KEY}` } } });
    const c = new GeminiClient({ apiKey: KEY, model: "gemini-2.5-flash", timeoutMs: 5000, baseUrl: `${standIn.origin}/v1beta` });
    const err = (await c.chatDetailed([{ role: "user", content: "x" }]).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("Gemini error: invalid [가림]");
    expect(err.message).not.toContain(KEY);
  });
});

describe("오류 응답 본문을 못 읽으면", () => {
  test("빈 문장이 아니라 못 읽었다는 표시를 남기고 상태 코드는 그대로", async () => {
    const err = await requestProviderJson({
      provider: "openai",
      label: "OpenAI /x",
      url: `http://127.0.0.1:${brokenBody.port}/x`,
      method: "GET",
      headers: {},
      timeoutMs: 5000,
      secrets: [KEY],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect((err as LlmRequestError).status).toBe(500);
    expect((err as LlmRequestError).message).toBe(`OpenAI /x 500: ${UNREADABLE_BODY_MARK}`);
  });
});
