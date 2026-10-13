/**
 * test-utils/provider-stand-in.ts — 공급자 API 자리에 세우는 진짜 로컬 HTTP 서버(Bun.serve port 0).
 * 테스트 전용: 제품 코드가 import 하지 않는다.
 *
 * 인터페이스를 가짜로 구현하지 않는다 — 클라이언트는 실제 fetch 로 이 서버에 요청을 보내고, 서버는 받은
 * 요청(경로·쿼리·헤더·본문)을 기록한 뒤 테스트가 정한 응답을 돌려준다. 테스트는 기록을 보고 "키가
 * 올바른 헤더에만 실렸는지, URL 에 없는지" 같은 요청 모양을 검사한다.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface StandInReply {
  status?: number;
  headers?: Record<string, string>;
  /** 객체면 JSON 으로, 문자열이면 그대로 보낸다. */
  body?: unknown;
  /** true 면 응답하지 않고 매달린다(timeout 검사용). */
  hang?: boolean;
  /** 이만큼(ms) 늦게 응답한다(늦게 도착한 응답 검사용). */
  delayMs?: number;
}

export interface ProviderStandIn {
  /** "http://127.0.0.1:<port>" */
  origin: string;
  requests: RecordedRequest[];
  /** 요청마다 응답을 정한다. 기본은 404. */
  reply: (req: RecordedRequest) => StandInReply;
  stop: () => void;
}

export function startProviderStandIn(): ProviderStandIn {
  const standIn: ProviderStandIn = {
    origin: "",
    requests: [],
    reply: () => ({ status: 404, body: "not found" }),
    stop: () => {},
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const text = req.method === "GET" ? "" : await req.text();
      let body: unknown = text;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const recorded: RecordedRequest = { method: req.method, path: url.pathname, search: url.search, headers, body };
      standIn.requests.push(recorded);
      const reply = standIn.reply(recorded);
      if (reply.hang) await new Promise(() => {});
      if (reply.delayMs) await Bun.sleep(reply.delayMs);
      const payload = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
      return new Response(payload, {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
      });
    },
  });
  standIn.origin = `http://127.0.0.1:${server.port}`;
  // server.stop() 은 열린 연결이 모두 닫힐 때 끝나는 Promise 를 돌려준다. 매달린 요청(hang)이 있으면
  // 끝나지 않으므로 기다리지 않고 강제로 닫기만 한다.
  standIn.stop = () => {
    void server.stop(true);
  };
  return standIn;
}
