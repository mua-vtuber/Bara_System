/**
 * sse-consumer.test.ts — SSE 구독·재연결·Last-Event-ID 이어받기 (Phase 7 2차 Task 7).
 *
 * mock 인터페이스 금지 정책 정합: 가짜 EventSource 구현체를 만들지 않고, 진짜
 * Bun.serve 로 SSE 를 흘리는 로컬 테스트 서버를 띄워 실 fetch 스트림으로 검증한다.
 * 서버는 SseConsumer 가 붙는 메모리 /events/stream 형식(id/event/data + 빈 줄)을
 * 그대로 흉내 낸다 — 데이터 fixture 가 아니라 실 HTTP 송수신이다.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { SseConsumer, type SseEvent } from "./sse-consumer.ts";

/**
 * 한 테스트용 SSE 서버. /events/stream 에 토큰을 확인하고, 큐에 넣어둔 이벤트를
 * 차례로 흘린 뒤 (옵션) 연결을 끊는다. Last-Event-ID 헤더를 받아 그 초과분만
 * 흘려 이어받기를 검증할 수 있게 한다.
 */
interface QueuedEvent {
  id: number;
  type: string;
  data: string;
}

function startSseServer(opts: {
  validToken: string;
  /** 전체 이벤트 큐(id 오름차순). 연결 시 Last-Event-ID 초과분을 흘린다. */
  events: QueuedEvent[];
  /** 이벤트를 다 흘린 뒤 연결을 닫을지(재연결 검증용). 기본 true. */
  closeAfterDrain?: boolean;
}): { url: string; stop: () => void; connectionCount: () => number } {
  let connections = 0;
  const closeAfterDrain = opts.closeAfterDrain ?? true;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0, // 임의 빈 포트.
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/events/stream") {
        return new Response("not found", { status: 404 });
      }
      // 토큰 검증 — Authorization: Bearer <t>.
      const auth = req.headers.get("Authorization") ?? "";
      const m = auth.match(/^Bearer\s+(.+)$/);
      if (!m || m[1] !== opts.validToken) {
        return new Response("unauthorized", { status: 401 });
      }
      connections += 1;

      const lastEventIdRaw = req.headers.get("Last-Event-ID");
      const lastId =
        lastEventIdRaw !== null && lastEventIdRaw.trim().length > 0
          ? Number(lastEventIdRaw)
          : 0;
      const toSend = opts.events.filter((e) => e.id > lastId);

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          for (const e of toSend) {
            controller.enqueue(
              enc.encode(`id: ${e.id}\nevent: ${e.type}\ndata: ${e.data}\n\n`),
            );
          }
          if (closeAfterDrain) {
            controller.close();
          }
          // closeAfterDrain=false 면 연결을 열어 둔 채 둔다(stop 이 서버를 닫음).
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    connectionCount: () => connections,
  };
}

/** 짧은 대기 — 비동기 루프가 한 사이클 돌 시간을 준다. */
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("SseConsumer — 기본 구독", () => {
  let server: ReturnType<typeof startSseServer>;
  afterEach(() => server?.stop());

  test("(a1) 토큰을 헤더로 보내고 큐의 이벤트를 순서대로 받는다", async () => {
    server = startSseServer({
      validToken: "tok-ok",
      events: [
        { id: 1, type: "cleanup_proposals_ready", data: '{"count":2}' },
        { id: 2, type: "cleanup_proposals_ready", data: '{"count":1}' },
      ],
    });

    const received: SseEvent[] = [];
    const consumer = new SseConsumer({
      baseUrl: server.url,
      token: "tok-ok",
      onEvent: (e) => {
        received.push(e);
      },
      reconnectDelayMs: 50,
    });
    consumer.start();
    await wait(200);
    consumer.stop();

    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received[0].type).toBe("cleanup_proposals_ready");
    expect(received[0].id).toBe("1");
    expect(JSON.parse(received[0].data)).toEqual({ count: 2 });
    expect(received[1].id).toBe("2");
  });

  test("(a2) 토큰이 틀리면 onError 로 401 을 드러낸다(silent 아님)", async () => {
    server = startSseServer({ validToken: "tok-ok", events: [] });

    const errors: Error[] = [];
    const consumer = new SseConsumer({
      baseUrl: server.url,
      token: "WRONG",
      onEvent: () => {},
      onError: (e) => {
        errors.push(e);
      },
      reconnectDelayMs: 50,
    });
    consumer.start();
    await wait(150);
    consumer.stop();

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain("401");
    // 토큰 값이 에러 메시지에 새지 않아야 한다.
    expect(errors.some((e) => e.message.includes("WRONG"))).toBe(false);
  });
});

describe("SseConsumer — Last-Event-ID 이어받기 (놓침 0)", () => {
  let server: ReturnType<typeof startSseServer>;
  afterEach(() => server?.stop());

  test("(b1) 재연결 시 마지막 받은 id 초과분만 이어받는다", async () => {
    // closeAfterDrain=true 라 매 연결이 큐를 흘린 뒤 닫힌다 → consumer 가 재연결.
    server = startSseServer({
      validToken: "tok-ok",
      events: [
        { id: 10, type: "cleanup_proposals_ready", data: "{}" },
        { id: 11, type: "cleanup_proposals_ready", data: "{}" },
      ],
      closeAfterDrain: true,
    });

    const received: SseEvent[] = [];
    const consumer = new SseConsumer({
      baseUrl: server.url,
      token: "tok-ok",
      onEvent: (e) => {
        received.push(e);
      },
      reconnectDelayMs: 50,
    });
    consumer.start();
    // 첫 연결에서 10·11 받고, 재연결 시 Last-Event-ID=11 이라 서버가 초과분 0 을
    // 흘린다 → 같은 이벤트 재수신 없음.
    await wait(300);
    consumer.stop();

    // 10·11 은 정확히 한 번씩만(재알림 없음).
    const ids = received.map((e) => e.id);
    expect(ids.filter((i) => i === "10").length).toBe(1);
    expect(ids.filter((i) => i === "11").length).toBe(1);
    expect(consumer.getLastEventId()).toBe("11");
    // 여러 번 재연결됐음을 확인(끊겨도 다시 붙음).
    expect(server.connectionCount()).toBeGreaterThanOrEqual(2);
  });
});

describe("SseConsumer — 재연결", () => {
  test("(c1) 끊긴 뒤 다시 붙어 새 이벤트를 이어 받는다(재연결 동작)", async () => {
    // 서버가 매 연결마다 큐를 흘리고 닫는다 → consumer 가 reconnectDelay 뒤 재연결.
    // 한 번 더 붙어 같은 큐를 다시 보지 않고(Last-Event-ID) 끊김 후 재연결 자체를
    // connectionCount 로 확인한다. (죽은 포트로 시작하는 검증은 WSL 에서 connection
    // refused 가 ~140초 뒤에야 나 환경 의존적이라 채택 안 함 — 재연결 동작은
    // 서버 닫힘→재연결 경로로 검증.)
    const server = startSseServer({
      validToken: "tok-ok",
      events: [{ id: 1, type: "cleanup_proposals_ready", data: "{}" }],
      closeAfterDrain: true,
    });
    const received: SseEvent[] = [];
    const consumer = new SseConsumer({
      baseUrl: server.url,
      token: "tok-ok",
      onEvent: (e) => {
        received.push(e);
      },
      reconnectDelayMs: 40,
    });
    consumer.start();
    await wait(250);
    consumer.stop();
    server.stop();

    // 첫 연결에서 id 1 을 받고, 닫힌 뒤 여러 번 재연결한다(끊겨도 다시 붙음).
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].id).toBe("1");
    expect(server.connectionCount()).toBeGreaterThanOrEqual(2);
  });

  test("(c2) stop() 후에는 더 연결하지 않는다", async () => {
    const server = startSseServer({
      validToken: "tok-ok",
      events: [{ id: 1, type: "x", data: "{}" }],
      closeAfterDrain: true,
    });
    const consumer = new SseConsumer({
      baseUrl: server.url,
      token: "tok-ok",
      onEvent: () => {},
      reconnectDelayMs: 10_000,
    });
    consumer.start();
    // 첫 연결이 닫힌 뒤 긴 재연결 대기 중에 stop 한다. 짧은 delay 로 두면
    // stop 직전에 다음 fetch 가 이미 시작돼 connectionCount 관측이 흔들린다.
    await wait(120);
    consumer.stop();
    const countAfterStop = server.connectionCount();
    await wait(150);
    // stop 뒤로는 재연결 0 — 카운트가 더 안 늘어난다.
    expect(server.connectionCount()).toBe(countAfterStop);
    server.stop();
  });
});
