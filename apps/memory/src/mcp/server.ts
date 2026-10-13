/**
 * mcp/server.ts — MCP 서버 조립 + /mcp 라우트 마운트 (spec 단락 4).
 *
 * 무상태(stateless): 요청마다 새 McpServer + StreamableHTTPTransport 를 만든다 —
 * 세션 상태 0, 서버 재시작(5~15초) 후 클라이언트 재접속만으로 복구(spec 4.1).
 * 인증은 outer authGate("*") 가 자동 적용하고(spec 4.2), gate 가 /mcp 한정으로
 * 실어 준 adapterId 컨텍스트 변수를 저장 계열 도구가 author 기록에 쓴다(spec 7.3).
 * 도구 핸들러는 HTTP 자기호출 없이 REST 와 같은 내부 서비스 함수를 부른다(spec 4.4).
 */

import { Hono, type Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { APP_VERSION } from "../version.ts";
import { MCP_ADAPTER_ID_VAR, MCP_TOKEN_SCOPE_VAR } from "../server-internal/auth-gate.ts";
import type { TokenScope } from "../federation/sse-tokens.ts";
import type { MemoryApiDeps } from "../server-internal/types.ts";
import { registerMemoryTools } from "./tools-memory.ts";
import { registerCaptureTools } from "./tools-capture.ts";
import { registerCleanupTools } from "./tools-cleanup.ts";
import { registerDoctorTools } from "./tools-doctor.ts";
import { registerProfileTools } from "./tools-profile.ts";
import { registerMutationTools } from "./tools-mutations.ts";
import { registerContextTools } from "./tools-context.ts";
import { buildMcpInstructions } from "./instructions.ts";
import { serializeToolError, type BaraToolErrorCode } from "./errors.ts";
import { ScopedMcpServer } from "./access.ts";

export const MCP_SERVER_NAME = "bara-memory";
/** 저장 계열 도구의 saveTextInput source 값 — 봇 "discord" 와 같은 플랫폼 표기 단일 출처. */
export const MCP_SOURCE = "mcp";

/** 도구 등록부가 받는 요청 단위 컨텍스트 — deps + 토큰 유래 adapterId. */
export interface McpToolContext {
  deps: MemoryApiDeps;
  /** auth-gate 가 /mcp 한정으로 전파한 adapterId. gate 미경유(직접 마운트 테스트)면 undefined. */
  adapterId: string | undefined;
  scope?: TokenScope;
}

/**
 * 저장 계열 도구가 author 기록에 쓸 adapterId. 부재 = 배선 결함이라 loud fail —
 * author 를 클라이언트 자기신고로 대체하지 않는다(spec 7.3 / silent fallback 금지).
 */
export function requireAdapterId(ctx: McpToolContext): string {
  if (!ctx.adapterId) {
    throw new Error(
      "mcpAdapterId 누락 — auth-gate 의 /mcp adapterId 전파(MCP_ADAPTER_ID_VAR)가 배선되지 않았다",
    );
  }
  return ctx.adapterId;
}

/** 도구 성공 회신 — REST 응답 JSON 을 텍스트 content 로 직렬화한다. */
export function toolJson(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * 도구 실패 회신 — REST 와 같은 원인 문구를 { code, message, details? } JSON 봉투로
 * 담는다(spec 단락 8 + T8 구조화). code 는 BaraToolErrorCode 닫힌 집합 한정 —
 * 임의 문자열은 컴파일 타임에 막힌다. message 문구는 호출부 기존 문자열 그대로
 * (형태만 구조화, 문구 불변). details(409 의 현행 fingerprint 등)는 클라이언트 AI 의
 * 자가 복구 재료라 details 칸으로 동봉 — 부재 시 칸 자체를 생략한다.
 */
export function toolError(
  code: BaraToolErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: serializeToolError({ code, message, details }) }],
  };
}

/**
 * 요청 단위 MCP 서버 조립 — 도구 등록부 5종(T4 tools-memory·T6 tools-capture·T11 tools-cleanup·T23 tools-doctor·T25 tools-profile) 합류. 도구 18종.
 *
 * T27(spec G) — 도구를 가로지르는 사용 전략을 instructions 로 싣는다. SDK 는 이 값을
 * initialize 응답에 담아 보내고(server/index.js: `...(this._instructions && ...)`),
 * 클라이언트가 세션 맥락에 주입한다. 도구 설명이 각자 "이 도구 하나"를 말하는
 * 자리라면, 여기는 그 어느 설명문에도 들어갈 수 없는 것 — 색인 먼저 훑는 2단
 * 검색 박자, 검색하지 말아야 할 질문, 못 찾았을 때의 정직한 종료 조건 — 을 말한다.
 * scope 별로 문안이 갈린다(buildMcpInstructions) — read-only 연결에는 쓰기 절 대신
 * 읽기 전용 안내를 싣는다(WP-B1-16 / SA-5).
 *
 * 반환 타입은 ScopedMcpServer(McpServer 의 하위 클래스) — registerTool 을 감싸
 * canUseMcpTool 이 거부하는 도구를 등록 직후 disable() 한다. 등록부 7개
 * (registerMemoryTools 등)는 이 사실을 모른 채 평소처럼 server.registerTool 을
 * 부르기만 하면 된다(시그니처 불변).
 */
export function buildBaraMcpServer(ctx: McpToolContext): McpServer {
  const server = new ScopedMcpServer(
    { name: MCP_SERVER_NAME, version: APP_VERSION },
    { instructions: buildMcpInstructions(ctx.scope) },
    ctx.scope,
  );
  registerMemoryTools(server, ctx);
  registerCaptureTools(server, ctx);
  registerCleanupTools(server, ctx);
  registerDoctorTools(server, ctx);
  registerProfileTools(server, ctx);
  registerMutationTools(server, ctx);
  registerContextTools(server, ctx);
  return server;
}

/** /mcp 라우트 마운트 — buildMemoryApi 가 호출한다. */
export function registerMcpRoutes(app: Hono, deps: MemoryApiDeps): void {
  app.all("/mcp", async (c: Context) => {
    const adapterId = c.get(MCP_ADAPTER_ID_VAR) as string | undefined;
    const scope = c.get(MCP_TOKEN_SCOPE_VAR) as TokenScope | undefined;
    const server = buildBaraMcpServer({ deps, adapterId, scope });
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
  });
}
