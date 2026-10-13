/**
 * test-utils/delayed-ollama-chat-server.ts — 테스트 전용 로컬 HTTP 서버.
 *
 * Ollama `/api/chat`(stream=false) 응답 형식으로 정해진 글을 정해진 지연 뒤에 돌려준다. 실제
 * OllamaClient·OllamaVisionProvider 가 이 서버를 호출해, LLM·VLM 이 느린 동안 쓰기 잠금이
 * 비어 있는지 같은 동시성 흐름을 실제 HTTP 로 검증한다(WP-B1-07). 운영 코드는 import 하지 않는다.
 */

export interface DelayedOllamaChatServer {
  /** http://127.0.0.1:<port> — OllamaClient.baseUrl / vision endpoint 로 쓴다. */
  readonly url: string;
  /** 지금까지 받은 /api/chat 요청 수. */
  requestCount(): number;
  /** 다음 /api/chat 요청이 도착하면(응답 지연이 시작되면) 풀린다. */
  nextRequest(): Promise<void>;
  stop(): void;
}

export function startDelayedOllamaChatServer(opts: {
  delayMs: number;
  /** message.content 로 돌려줄 글 — 추출은 JSON 배열 글, 캡션은 캡션 글. */
  content: string;
}): DelayedOllamaChatServer {
  let count = 0;
  let waiters: Array<() => void> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (req.method !== "POST" || path !== "/api/chat") {
        return new Response(`unexpected ${req.method} ${path}`, { status: 404 });
      }
      await req.json();
      count += 1;
      const arrived = waiters;
      waiters = [];
      for (const resolve of arrived) resolve();
      await Bun.sleep(opts.delayMs);
      return Response.json({
        model: "test-model",
        message: { role: "assistant", content: opts.content },
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
    nextRequest: () => new Promise<void>((resolve) => { waiters.push(resolve); }),
    stop: () => server.stop(true),
  };
}
