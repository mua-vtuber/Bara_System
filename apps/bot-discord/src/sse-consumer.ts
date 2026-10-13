/**
 * sse-consumer.ts — 메모리 /events/stream 구독 클라이언트 (Phase 7 2차 Task 7).
 *
 * 권위: docs/decisions/2026-06-04-phase7-2nd-active-loop-plan.md Task 7
 *       docs/decisions/2026-06-02-phase7-redesign-design.md 단락 2(① 알림 토대)
 *
 * 왜 fetch 스트림 직접 파싱인가:
 *   Bun 1.3 전역 `EventSource` 는 없고(확인됨), `eventsource` npm 패키지도 안 깔려
 *   있다. 봇은 api-client.ts 정신대로 "zero-extra-dependencies" 라 의존성을 새로
 *   추가하지 않고, 표준 `fetch` 의 ReadableStream 으로 SSE 줄을 직접 읽어 파싱한다.
 *   더불어 EventSource 는 커스텀 헤더(Authorization)를 못 붙이는데, 봇은 토큰을
 *   query 노출 없이 헤더로 보내는 편이 안전해 직접 구현이 오히려 정합한다.
 *
 * SSE 형식(메모리 events.ts writeRecord 가 흘리는 것):
 *   id: <eventId>\n
 *   event: <type>\n
 *   data: <json>\n
 *   \n            ← 빈 줄 = 한 이벤트 끝
 *
 * 재연결 + 이어받기:
 *   연결이 끊기면(서버 재시작·네트워크) reconnectDelayMs 뒤 다시 연결한다. 마지막으로
 *   받은 이벤트 id 를 보관했다가 재연결 시 Last-Event-ID 헤더로 보내, 끊긴 사이 쌓인
 *   이벤트를 메모리 events 큐(Task 1)에서 이어받는다 — 놓침 0. 끊김·실패는 silent
 *   하게 삼키지 않고 onError 콜백 + console.warn 으로 드러낸다(식별자만, 토큰 값 X).
 */

/** 한 SSE 이벤트(파싱 결과). */
export interface SseEvent {
  /** 이벤트 id(메모리 events 큐의 단조 증가 id). 커서로 보관한다. */
  id: string | null;
  /** event: 필드. 미지정 SSE 기본값은 "message". */
  type: string;
  /** data: 필드 원문(JSON 문자열). 파싱은 호출자 책임. */
  data: string;
}

export interface SseConsumerOptions {
  /** 메모리 API base URL(예: "http://127.0.0.1:3001"). trailing slash 없이. */
  baseUrl: string;
  /** SSE 구독 토큰. Authorization 헤더로 보낸다. */
  token: string;
  /** 이벤트 한 건마다 호출. 던지는 예외는 잡아 onError 로 보내고 루프는 이어간다. */
  onEvent: (event: SseEvent) => void | Promise<void>;
  /** 연결 끊김·실패·이벤트 처리 오류를 알린다. 토큰 값은 절대 넘기지 않는다. */
  onError?: (err: Error) => void;
  /** 재연결 대기(ms). 미지정 시 DEFAULT_RECONNECT_DELAY_MS. */
  reconnectDelayMs?: number;
  /**
   * 테스트 주입용 fetch. 미지정 시 전역 fetch. (mock 인터페이스가 아니라 실제
   * fetch 함수 시그니처 그대로 — 테스트는 로컬 서버에 붙는 진짜 fetch 를 넘긴다.)
   */
  fetchImpl?: typeof fetch;
}

/** 재연결 기본 대기(ms). 하드코딩 금지 — 호출자가 설정으로 덮을 수 있다. */
export const DEFAULT_RECONNECT_DELAY_MS = 3000;

/**
 * 메모리 /events/stream 구독자. start() 하면 백그라운드 루프가 연결을 유지하고,
 * 끊기면 재연결한다. stop() 으로 멈춘다.
 */
export class SseConsumer {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly onEvent: (event: SseEvent) => void | Promise<void>;
  private readonly onError: (err: Error) => void;
  private readonly reconnectDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  /** 마지막으로 받은 이벤트 id — 재연결 시 Last-Event-ID 로 이어받기. */
  private lastEventId: string | null = null;
  /** 현재 가동 중 루프 여부. stop() 이 false 로 내려 루프를 끝낸다. */
  private running = false;
  /** 현재 진행 중 요청을 끊기 위한 controller. stop() 이 abort 한다. */
  private controller: AbortController | null = null;
  /** 재연결 대기 타이머 — stop() 이 취소한다. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 재연결 대기 Promise 해제 함수 — stop() 이 잠든 루프를 깨운다. */
  private reconnectSleepResolve: (() => void) | null = null;

  constructor(options: SseConsumerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.onEvent = options.onEvent;
    this.onError = options.onError ?? (() => {});
    this.reconnectDelayMs =
      options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 마지막으로 받은 이벤트 id(이어받기 커서). 테스트·진단용 노출. */
  getLastEventId(): string | null {
    return this.lastEventId;
  }

  /**
   * 구독을 시작한다. 한 번의 연결이 끝나면(서버가 닫거나 오류) 멈추라는 지시
   * (stop)가 없는 한 reconnectDelayMs 뒤 다시 연결한다. 비동기 루프는 await 하지
   * 않고 백그라운드로 돈다 — 호출자는 fire-and-forget.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runLoop();
  }

  /** 구독을 멈춘다. 진행 중 요청을 끊고 재연결 타이머를 취소한다. */
  stop(): void {
    this.running = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectSleepResolve !== null) {
      const resolve = this.reconnectSleepResolve;
      this.reconnectSleepResolve = null;
      resolve();
    }
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  /**
   * 연결 → 스트림 읽기 → (끊기면) 대기 후 재연결을 running 동안 반복한다.
   * 한 사이클의 오류는 onError 로 드러내고 루프는 다음 재연결로 이어간다 —
   * 한 번 끊겼다고 봇 전체가 죽지 않는다.
   */
  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.connectOnce();
      } catch (err) {
        if (!this.running) break; // stop() 의 abort 는 정상 종료 — 오류로 안 본다.
        this.onError(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
      if (!this.running) break;
      // 재연결 대기 — stop() 이 타이머를 취소하면 즉시 끝난다.
      await this.sleep(this.reconnectDelayMs);
    }
  }

  /**
   * /events/stream 에 한 번 연결해 스트림을 끝까지 읽는다. 서버가 줄을 닫거나
   * 연결이 끊기면 정상 반환(runLoop 가 재연결). 비2xx 응답은 throw — silent 하게
   * 삼키지 않는다(예: 401 = 토큰 무효를 호출자가 알게).
   */
  private async connectOnce(): Promise<void> {
    this.controller = new AbortController();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "text/event-stream",
    };
    // 끊긴 사이 쌓인 이벤트를 이어받기 — 마지막 받은 id 를 표준 헤더로 보낸다.
    if (this.lastEventId !== null) {
      headers["Last-Event-ID"] = this.lastEventId;
    }

    const res = await this.fetchImpl(`${this.baseUrl}/events/stream`, {
      headers,
      signal: this.controller.signal,
    });

    if (!res.ok) {
      // 토큰 무효(401)·서버 오류 등 — 토큰 값은 메시지에 넣지 않는다(식별자만).
      throw new Error(
        `SSE 연결 실패: ${res.status} ${res.statusText} (GET ${this.baseUrl}/events/stream)`,
      );
    }
    if (!res.body) {
      throw new Error("SSE 연결 실패: 응답 body 없음");
    }

    await this.readStream(res.body);
  }

  /**
   * ReadableStream 을 줄 단위로 읽어 SSE 이벤트로 파싱한다. data:/event:/id: 줄을
   * 모으다가 빈 줄을 만나면 한 이벤트가 완성된 것으로 보고 dispatchEvent 한다.
   */
  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // 한 이벤트가 완성될 때까지 모으는 누적칸.
    let evId: string | null = null;
    let evType = "message";
    const dataLines: string[] = [];

    const flush = async () => {
      if (dataLines.length === 0 && evType === "message" && evId === null) {
        return; // comment ping 등 — 흘릴 게 없으면 무시.
      }
      const event: SseEvent = {
        id: evId,
        type: evType,
        data: dataLines.join("\n"),
      };
      if (event.id !== null) {
        this.lastEventId = event.id; // 커서 전진 — 다음 재연결의 이어받기 기준.
      }
      // 한 이벤트 처리 오류가 스트림 전체를 끊지 않게 격리(onError 로 드러냄).
      try {
        await this.onEvent(event);
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
      }
      evId = null;
      evType = "message";
      dataLines.length = 0;
    };

    try {
      while (this.running) {
        const { value, done } = await reader.read();
        if (done) break; // 서버가 줄을 닫음 — runLoop 가 재연결.
        buffer += decoder.decode(value, { stream: true });

        let nlIndex: number;
        while ((nlIndex = buffer.indexOf("\n")) !== -1) {
          // CRLF·LF 모두 다룬다 — \r 을 떼고 한 줄을 꺼낸다.
          let line = buffer.slice(0, nlIndex);
          buffer = buffer.slice(nlIndex + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);

          if (line === "") {
            await flush(); // 빈 줄 = 이벤트 경계.
            continue;
          }
          if (line.startsWith(":")) {
            continue; // comment 줄(ping) — 무시.
          }
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          // 표준 SSE: 콜론 뒤 첫 공백 한 칸은 제거.
          let val = colon === -1 ? "" : line.slice(colon + 1);
          if (val.startsWith(" ")) val = val.slice(1);

          if (field === "id") {
            evId = val;
          } else if (field === "event") {
            evType = val;
          } else if (field === "data") {
            dataLines.push(val);
          }
          // 그 외 필드(retry 등)는 현재 무시.
        }
      }
    } finally {
      // 루프 종료·예외 어느 쪽이든 reader 를 푼다(누수 차단).
      try {
        await reader.cancel();
      } catch {
        // cancel 실패는 다음 재연결을 막지 않으므로 조용히 통과.
      }
    }
  }

  /** running 동안만 의미 있는 대기 — stop() 이 타이머를 취소하면 즉시 깬다. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        if (this.reconnectTimer !== null) {
          clearTimeout(this.reconnectTimer);
        }
        this.reconnectTimer = null;
        this.reconnectSleepResolve = null;
        resolve();
      };
      this.reconnectSleepResolve = done;
      this.reconnectTimer = setTimeout(done, ms);
    });
  }
}
