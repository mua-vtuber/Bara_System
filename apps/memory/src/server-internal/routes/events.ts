/**
 * server-internal/routes/events.ts — SSE 알림 스트림 + 폴백 목록 (Phase 7 2차 Task 3).
 *
 * 권위: docs/decisions/2026-06-04-phase7-2nd-active-loop-plan.md Task 3
 *       docs/decisions/2026-06-02-phase7-redesign-design.md 단락 2(① 알림 토대) · 9.1(전송)
 *
 * 두 라우트:
 *   1. GET /events/stream — SSE 한 줄. 어댑터(디스코드 봇·대시보드)가 한 번 열어
 *      유지하면 메모리가 이벤트를 즉시 흘린다. 끊겼다 재연결하면 Last-Event-ID
 *      다음부터 events 큐(Task 1)로 이어받아 하나도 안 놓친다.
 *   2. GET /events?since=N — 폴백 목록(JSON). SSE 를 못 쓰는 호출자가 events 큐의
 *      N 초과분을 한 번에 받아 가는 통로(listSince 위임).
 *
 * 토큰 검증(Task 2):
 *   연결은 SseTokenStore.verifyToken 으로 검증한다. 토큰은 헤더(Authorization:
 *   Bearer <t> 또는 X-Adapter-Token) 또는 query(?token=<t>)로 받는다 — EventSource
 *   는 커스텀 헤더를 못 붙이는 클라이언트가 있어 query 통로도 연다. 검증 실패 =
 *   401(silent 통과 금지). 토큰 값은 로그·에러 메시지에 절대 넣지 않는다(식별자는
 *   adapterId 만 / T2 규칙 계승).
 *
 * 회수·권한 변경 즉시 반영(SA-6, WP-B1-13):
 *   열린 스트림은 SseTokenStore.onTokenChange 를 구독한다. 자기 어댑터의 토큰이 회수·
 *   교체되거나 권한이 바뀌면 "토큰이 아직 이 adapterId 로 검증되는가 + 그 권한이
 *   GET /events/stream 을 허용하는가(canUseScopedHttp)"를 다시 확인하고, 실패면 ping
 *   주기를 기다리지 않고 스트림을 닫는다. 이벤트 쓰기·ping 직전에도 같은 확인을 한다.
 *
 * TLS 통로 한정(설계 9.1):
 *   이 서버는 127.0.0.1 에 바인딩한다. 외부 접속은 별도 TLS 터널(Cloudflare Tunnel /
 *   SSH)을 경유하므로, 토큰·이벤트가 평문 HTTP 로 공개망에 직접 노출되는 통로는 없다.
 *   따라서 이 라우트는 in-process·loopback 신뢰 전제 위에서 토큰을 *구독 식별* 용으로
 *   쓴다 — 평문 HTTP 직접 노출을 전제하지 않는다.
 *
 * 대시보드 토큰 전달(Task 5):
 *   대시보드(web/index.html)는 메모리 서버와 같은 origin(127.0.0.1)에서 서빙되는
 *   정적 페이지다. EventSource 는 커스텀 헤더를 못 붙이므로 토큰을 query(?token=)로
 *   넘겨야 한다. 그 토큰을 대시보드가 얻는 통로 = GET /dashboard/sse-token —
 *   issueToken("dashboard")(멱등)를 같은 origin REST 호출(/stats·/cleanup-proposals
 *   와 동일 패턴)로 한 번 받아 EventSource 에 붙인다. 정적 HTML 서빙 라우트를 안
 *   건드리고(회귀 표면 0), sseTokens 가 이미 이 라우트 deps 에 주입돼 server.ts 변경
 *   없이 합류한다. 토큰 값은 응답 body 로만 전달 — 로그엔 adapterId("dashboard")만.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventRecord } from "../../db/store-internal/event-repository.ts";
import {
  DEFAULT_EVENT_LIMIT,
  EventRepository,
} from "../../db/store-internal/event-repository.ts";
import type { EventBus, Subscription } from "../event-bus.ts";
import type { SseTokenStore } from "../../federation/sse-tokens.ts";
import { canUseScopedHttp } from "../../federation/token-scope.ts";
import { err } from "../http-helpers.ts";
import { DASHBOARD_ADAPTER_ID } from "../auth-gate.ts";

/** GET /events?since 폴백 목록의 max limit — 과도 회신 차단(parseLimit 자연 clamp). */
const FALLBACK_MAX_LIMIT = 500;

/**
 * SSE 스트림 경로. 라우트 등록과 권한 재확인(canUseScopedHttp)이 같은 값을 쓴다 —
 * token-scope.ts 의 SCOPED_HTTP_ROUTES 항목과 일치해야 한다.
 */
const EVENTS_STREAM_PATH = "/events/stream";
const EVENTS_STREAM_METHOD = "GET";

/**
 * SSE comment ping 주기(ms). 일정 시간 emit 이 없어도 이 주기마다 comment 한 줄을
 * 흘려 죽은 연결을 빨리 감지한다 — 끊긴 소켓에 write 하면 즉시 실패해
 * onAbort 가 구독을 떼고, 다음 emit 까지 죽은 구독자가 남아 있지 않는다.
 * comment 는 `:` 로 시작하는 한 줄이라 EventSource 클라이언트가 무시한다(데이터 영향 0).
 * 서버의 무응답 연결 끊김 시간(index-helpers.ts SERVER_IDLE_TIMEOUT_SECONDS)보다 짧아야
 * 조용한 스트림이 끊기지 않는다 — 그 관계는 index-helpers.test.ts 가 검사한다.
 */
export const SSE_PING_INTERVAL_MS = 25_000;

/**
 * events 라우트 의존. event-bus(실시간 fan-out + 큐 적재 위임)와 토큰 검증기를
 * 주입받는다. 폴백 목록(listSince)은 같은 EventRepository 를 event-bus 가 들고 있는
 * 것과 *동일 db 핸들* 로 직접 조회한다(store.getRawDb()).
 */
export interface EventsRoutesDeps {
  eventBus: EventBus;
  sseTokens: SseTokenStore;
  eventRepository: EventRepository;
}

/**
 * 요청에서 SSE 구독 토큰을 추출한다. 헤더(Authorization: Bearer / X-Adapter-Token)
 * 우선, 없으면 query(?token=). 토큰 값은 반환만 하고 로그에 남기지 않는다.
 */
function extractToken(headerAuth: string | undefined, headerAdapter: string | undefined, queryToken: string | undefined): string | null {
  if (headerAuth) {
    const m = headerAuth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }
  if (headerAdapter && headerAdapter.trim().length > 0) {
    return headerAdapter.trim();
  }
  if (queryToken && queryToken.trim().length > 0) {
    return queryToken.trim();
  }
  return null;
}

export function registerEventsRoutes(app: Hono, deps: EventsRoutesDeps): void {
  const api = new Hono({ strict: false });

  // ── GET /events/stream — SSE 한 줄 (실시간 + Last-Event-ID 이어받기) ─────────
  api.get(EVENTS_STREAM_PATH, (c) => {
    const token = extractToken(
      c.req.header("Authorization"),
      c.req.header("X-Adapter-Token"),
      c.req.query("token"),
    );
    if (token === null) {
      return err(c, 401, "SSE 구독 토큰 없음 — 헤더(Authorization: Bearer / X-Adapter-Token) 또는 ?token= 필요");
    }
    const adapterId = deps.sseTokens.verifyToken(token);
    if (adapterId === null) {
      // verifyToken 이 null = 무효 토큰. silent 통과 금지 — 401 로 명시. 토큰 값은
      // 메시지에 넣지 않는다(T2 규칙).
      return err(c, 401, "SSE 구독 토큰 무효 — 검증 실패");
    }
    // 연결 시점·변경 통지·쓰기 직전에 쓰는 같은 판정(SA-6). 토큰 값은 이 클로저 안에만 있다.
    const streamStillAllowed = (): boolean =>
      deps.sseTokens.verifyToken(token) === adapterId &&
      canUseScopedHttp(
        deps.sseTokens.getTokenScope(adapterId),
        EVENTS_STREAM_METHOD,
        EVENTS_STREAM_PATH,
        adapterId,
      );
    if (!streamStillAllowed()) {
      // 외곽 인증 게이트가 먼저 막는 경우지만, 라우트도 같은 판정으로 스스로 거부한다.
      // (err 헬퍼는 403 을 받지 않아 아래 대시보드 토큰 라우트와 같이 c.json 을 쓴다.)
      return c.json(
        { error: `SSE 구독 권한 부족 — adapterId=${adapterId} 의 권한으로는 알림 스트림을 열 수 없음` },
        403,
      );
    }

    // Last-Event-ID: N — 끊겼다 재연결한 어댑터가 마지막 받은 id 를 보내면 그 초과분을
    // 먼저 흘린 뒤 실시간 합류. 표준 SSE 재연결 헤더 + 폴백으로 query 도 받는다.
    const lastEventIdRaw =
      c.req.header("Last-Event-ID") ?? c.req.query("lastEventId");
    const lastEventId = parseLastEventId(lastEventIdRaw);

    return streamSSE(c, async (stream) => {
      // emit 과 writeSSE 를 잇는 in-process 송출 큐. event-bus 의 send 콜백은 동기로
      // record 를 이 큐에 넣고 대기 루프를 깨운다 — writeSSE 가 비동기라 직접 await
      // 하지 못하므로, 큐+신호로 순서를 보존한다(backlog 송출 도중 들어온 실시간
      // 이벤트도 뒤에 줄 서서 놓침이 없다).
      const pending: EventRecord[] = [];
      let wake: (() => void) | null = null;
      let aborted = false;
      // comment ping 타이머 핸들 — onAbort·finally 에서 반드시 clear (타이머 누수 차단).
      let pingTimer: ReturnType<typeof setInterval> | null = null;
      const clearPing = (): void => {
        if (pingTimer !== null) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
      };

      // event-bus 구독 등록 — emit 마다 이 콜백이 record 를 큐에 넣고 루프를 깨운다.
      // 콜백 자체는 동기·가벼움(배열 push + resolver 호출)이라 fan-out 격리에 안전.
      const sub: Subscription = deps.eventBus.subscribe(adapterId, (record) => {
        pending.push(record);
        if (wake) {
          const w = wake;
          wake = null;
          w();
        }
      });

      // 토큰 회수·교체·권한 변경 즉시 반영(SA-6). 판정이 실패하면 구독·ping 을 떼고 루프를
      // 끝낸다 — 콜백이 끝나면 streamSSE 가 스트림을 닫는다. 이미 쌓인 pending 이벤트도
      // 보내지 않는다. 로그에는 adapterId 와 사유만 남긴다(토큰 값 미포함).
      const closeForTokenChange = (reason: string): void => {
        if (aborted) return;
        aborted = true;
        clearPing();
        deps.eventBus.unsubscribe(sub);
        if (wake) {
          const w = wake;
          wake = null;
          w();
        }
        console.warn(`[events] SSE 연결 종료(토큰 재검증 실패) — adapterId=${adapterId} 사유=${reason}`);
      };
      const stopTokenWatch = deps.sseTokens.onTokenChange((change) => {
        if (change.adapterId !== adapterId || streamStillAllowed()) return;
        closeForTokenChange(change.kind);
      });
      // 연결 판정과 통지 구독 사이에 바뀐 경우도 놓치지 않게 구독 직후 한 번 더 확인한다.
      if (!streamStillAllowed()) closeForTokenChange("connect-check");

      // 연결이 끊기면(클라이언트 close 등) 구독 해제 + 루프 종료. silent swallow 아님 —
      // adapterId 만 로그(토큰 값 미포함).
      stream.onAbort(() => {
        aborted = true;
        clearPing();
        stopTokenWatch();
        deps.eventBus.unsubscribe(sub);
        if (wake) {
          const w = wake;
          wake = null;
          w();
        }
        console.warn(`[events] SSE 연결 종료 — adapterId=${adapterId}`);
      });

      // 주기 comment ping — emit 이 한참 없어도 SSE_PING_INTERVAL_MS 마다 comment 한 줄을
      // 흘린다. 끊긴 연결에 write 하면 곧장 reject 되고, onAbort 가 구독·타이머를
      // 떼어 죽은 구독자가 subscribers Set 에 남지 않는다. write 실패는 aborted 로 표시해
      // 대기 루프도 빠져나오게 한다(swallow 아님 — 끊김을 onAbort 가 처리).
      pingTimer = setInterval(() => {
        if (aborted) {
          clearPing();
          return;
        }
        if (!streamStillAllowed()) {
          closeForTokenChange("ping-check");
          return;
        }
        stream.write(": ping\n\n").catch(() => {
          aborted = true;
          clearPing();
          if (wake) {
            const w = wake;
            wake = null;
            w();
          }
        });
      }, SSE_PING_INTERVAL_MS);

      try {
        // (A) Last-Event-ID 이어받기 — 구독을 *먼저* 걸어 둔 뒤 backlog 를 흘린다.
        //     순서: backlog(큐의 N 초과분)를 흘리는 동안 새로 emit 된 이벤트는 pending
        //     에 쌓여 backlog 뒤에 이어 나가므로, 경계에서 놓치거나 중복하지 않는다.
        if (lastEventId !== null) {
          const backlog = deps.eventRepository.listSince(lastEventId);
          for (const record of backlog) {
            if (aborted) return;
            if (!streamStillAllowed()) {
              closeForTokenChange("write-check");
              return;
            }
            await writeRecord(stream, record);
          }
        }

        // (B) 실시간 — pending 큐를 비우고, 비면 다음 emit 까지 대기. 대기 중 끊기면
        //     onAbort 가 wake 를 호출해 빠져나온다. 일정 주기마다 comment ping 으로
        //     죽은 연결을 빨리 감지(끊김은 다음 write 에서 드러난다).
        while (!aborted) {
          if (pending.length === 0) {
            await new Promise<void>((res) => {
              wake = res;
            });
            continue;
          }
          if (!streamStillAllowed()) {
            closeForTokenChange("write-check");
            break;
          }
          const record = pending.shift()!;
          await writeRecord(stream, record);
        }
      } finally {
        // 정상 종료·예외 어느 쪽이든 구독·ping 타이머·토큰 변경 구독은 반드시 뗀다(누수
        // 차단). 멱등이라 onAbort 가 이미 뗐어도 무해.
        clearPing();
        stopTokenWatch();
        deps.eventBus.unsubscribe(sub);
      }
    });
  });

  // ── GET /events?since=N — 폴백 목록(JSON) ───────────────────────────────────
  //
  // SSE 를 못 쓰는 호출자용. since 가 없으면 0(전체 큐 앞부분부터). listSince 위임 —
  // afterId 초과분을 id 오름차순으로 limit 개. 빈 배열 = "그 id 이후 새 이벤트 없음"
  // 이라는 진짜 빈 상태(실패 위장 아님).
  api.get("/events", (c) => {
    const token = extractToken(
      c.req.header("Authorization"),
      c.req.header("X-Adapter-Token"),
      c.req.query("token"),
    );
    if (token === null) {
      return err(c, 401, "events 폴백 조회 토큰 없음 — 헤더 또는 ?token= 필요");
    }
    const adapterId = deps.sseTokens.verifyToken(token);
    if (adapterId === null) {
      return err(c, 401, "events 폴백 조회 토큰 무효 — 검증 실패");
    }

    const since = parseLastEventId(c.req.query("since")) ?? 0;
    const limit = parseEventLimit(c.req.query("limit"));
    const events = deps.eventRepository.listSince(since, limit);
    return c.json({ events });
  });

  // ── GET /dashboard/sse-token — 같은 origin 대시보드 토큰 발급 (Task 5) ───────
  //
  // 대시보드(정적 index.html)는 EventSource 에 커스텀 헤더를 못 붙여 토큰을
  // query(?token=)로 넘긴다. 그 토큰을 여기서 issueToken("dashboard")(멱등)으로
  // 한 번 받아 간다. 최초 권한은 서버 파일에 접근할 수 있는 dashboard:link CLI가
  // 제공한다. full Bearer를 이 라우트에서도 검증하고 loopback은 외곽 게이트가 검사한다.
  api.get("/dashboard/sse-token", (c) => {
    const header = c.req.header("Authorization") ?? "";
    const caller = deps.sseTokens.verifyToken(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (caller === null) return err(c, 401, "대시보드 인증 링크가 필요합니다. bun run dashboard:link 를 실행하세요.");
    if (deps.sseTokens.getTokenScope(caller) !== "full") return c.json({ error: "full 권한이 필요합니다." }, 403);
    const token = deps.sseTokens.issueToken(DASHBOARD_ADAPTER_ID);
    c.header("Cache-Control", "no-store");
    // 토큰 값은 로그에 남기지 않는다 — 발급 사실만 adapterId 로 남긴다.
    return c.json({ adapterId: DASHBOARD_ADAPTER_ID, token });
  });

  app.route("/", api);
}

/**
 * 한 이벤트 record 를 SSE 형식으로 흘린다. writeSSE 가 `id: <id>\nevent: <type>\n
 * data: <json>\n\n` 형식을 만든다(Hono 헬퍼). data 는 payload JSON 직렬화.
 */
async function writeRecord(
  stream: { writeSSE: (m: { data: string; event?: string; id?: string }) => Promise<void> },
  record: EventRecord,
): Promise<void> {
  await stream.writeSSE({
    id: String(record.id),
    event: record.type,
    data: JSON.stringify(record.payload),
  });
}

/**
 * Last-Event-ID / since 문자열을 양의 정수 커서로 파싱한다. 유효한 0 이상 정수면 그
 * 값, 아니면 null(=이어받기 안 함 / 폴백은 0 으로 보정). 빈 값·NaN·음수는 null.
 */
function parseLastEventId(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/** 폴백 목록 limit 파싱 — 미지정 시 DEFAULT_EVENT_LIMIT, 상한 FALLBACK_MAX_LIMIT. */
function parseEventLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EVENT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_EVENT_LIMIT;
  return Math.max(1, Math.min(FALLBACK_MAX_LIMIT, Math.floor(n)));
}
