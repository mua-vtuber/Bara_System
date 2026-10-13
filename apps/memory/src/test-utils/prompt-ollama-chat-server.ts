/**
 * test-utils/prompt-ollama-chat-server.ts — 테스트 전용 로컬 HTTP 서버(Ollama `/api/chat`, stream=false).
 *
 * 마지막 사용자 메시지에 든 원문을 보고 정해 둔 추출 항목 JSON 을 돌려준다. 실제 OllamaClient 가 이 서버를
 * 부르고 실제 MemoryExtractor 가 응답을 파싱한다 — LlmClient 를 흉내 내는 객체가 아니다. 정해 둔 원문이
 * 프롬프트에 없으면 500 과 사유를 돌려 테스트가 조용히 빈 추출로 지나가지 않게 한다.
 *
 * hold() 는 다음 응답들을 release 할 때까지 붙잡는다 — LLM 이 느린 동안 다른 흐름(백필 주기 등)이 무엇을
 * 보는지 실제 HTTP 로 검증한다. 운영 코드는 import 하지 않는다.
 */

export interface ExtractionReplyItem {
  content: string;
  memoryType: string;
  importance: number;
}

/** 프롬프트에 source 가 들어 있으면 items 를 돌려준다. 여러 개가 맞으면 가장 긴 source 가 이긴다. */
export interface ExtractionReply {
  source: string;
  items: readonly ExtractionReplyItem[];
}

export interface PromptOllamaChatServer {
  /** http://127.0.0.1:<port> — OllamaClient.baseUrl 로 쓴다. */
  readonly url: string;
  /** 지금까지 받은 /api/chat 요청 수. */
  requestCount(): number;
  /** 다음 /api/chat 요청이 도착하면 풀린다(응답을 붙잡고 있어도 도착 시점에 풀린다). */
  nextRequest(): Promise<void>;
  /** 이후 응답을 붙잡는다. 돌려받은 함수를 부르면 붙잡힌 응답과 이후 응답이 나간다. */
  hold(): () => void;
  stop(): void;
}

export function startPromptOllamaChatServer(replies: readonly ExtractionReply[]): PromptOllamaChatServer {
  let count = 0;
  let arrivalWaiters: Array<() => void> = [];
  let gate: Promise<void> | null = null;
  const bySpecificity = [...replies].sort((a, b) => b.source.length - a.source.length);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (req.method !== "POST" || path !== "/api/chat") {
        return new Response(`unexpected ${req.method} ${path}`, { status: 404 });
      }
      const body = await req.json() as { messages: Array<{ content: string }> };
      count += 1;
      const arrived = arrivalWaiters;
      arrivalWaiters = [];
      for (const resolve of arrived) resolve();
      if (gate !== null) await gate;
      const prompt = body.messages.at(-1)?.content ?? "";
      const reply = bySpecificity.find((candidate) => prompt.includes(candidate.source));
      if (reply === undefined) {
        return new Response(`no extraction reply registered for this prompt: ${prompt.slice(0, 200)}`, { status: 500 });
      }
      return Response.json({
        model: "test-model",
        message: { role: "assistant", content: JSON.stringify(reply.items) },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 10,
        eval_count: 10,
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requestCount: () => count,
    nextRequest: () => new Promise<void>((resolve) => { arrivalWaiters.push(resolve); }),
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => { release = resolve; });
      return () => { gate = null; release(); };
    },
    stop: () => server.stop(true),
  };
}
