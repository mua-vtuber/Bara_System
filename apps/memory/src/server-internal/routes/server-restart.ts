/**
 * server-internal/routes/server-restart.ts — 대시보드 "기억 서버 재시작" 라우트
 *
 * GET  /server/restart — { supported, reason, bootId }. 대시보드가 버튼 활성 여부를 정하고,
 *                         재시작 뒤 bootId 가 바뀌었는지로 정말 다시 켜졌음을 확인한다.
 * POST /server/restart — 지원하면 202 를 먼저 보낸 뒤 종료 절차를 시작한다. 지원하지 않거나
 *                         백그라운드 쓰기 작업(정리·추출·이미지 분석)이 도는 중이면 409.
 *
 * 두 라우트 모두 대시보드 소유자 토큰(adapterId "dashboard")만 쓸 수 있다. 제한 권한 토큰은
 * auth-gate 가 표(SCOPED_HTTP_ROUTES)에 없는 경로로 먼저 막고, full 권한이어도 다른 어댑터의
 * 토큰은 여기서 403 으로 거절한다.
 */

import type { Hono } from "hono";
import { DASHBOARD_ADAPTER_ID, MCP_ADAPTER_ID_VAR } from "../auth-gate.ts";
import {
  PROCESS_BOOT_ID,
  RESTART_BUSY_REASON,
  RESTART_FORBIDDEN_MESSAGE,
  RESTART_TRIGGER_DELAY_MS,
  resolveRestartSupport,
} from "../restart-policy.ts";
import type { MemoryApiDeps } from "../types.ts";

export const SERVER_RESTART_PATH = "/server/restart";

export interface ServerRestartRouteOptions {
  /** 재시작 지원 표시를 읽을 환경. 운영은 process.env. */
  env?: Record<string, string | undefined>;
  /** 응답 전송 뒤 종료 절차 시작까지의 지연(ms). */
  triggerDelayMs?: number;
}

/** deps.requestRestart 는 index.ts 가 넘기는 선택 의존이라 호출 시점에 lookup 한다. */
export function registerServerRestartRoutes(
  app: Hono,
  deps: Pick<MemoryApiDeps, "requestRestart" | "backgroundWritersRunning">,
  options: ServerRestartRouteOptions = {},
): void {
  const env = options.env ?? process.env;
  const triggerDelayMs = options.triggerDelayMs ?? RESTART_TRIGGER_DELAY_MS;

  app.get(SERVER_RESTART_PATH, (c) => {
    if (c.get(MCP_ADAPTER_ID_VAR) !== DASHBOARD_ADAPTER_ID) {
      return c.json({ error: RESTART_FORBIDDEN_MESSAGE }, 403);
    }
    const support = resolveRestartSupport(env);
    // 작업 중 여부는 호출 시점에 deps 에서 읽는다(index.ts 가 스케줄러를 만든 뒤 채우는 선택 의존).
    const busy = deps.backgroundWritersRunning?.() === true;
    return c.json({
      supported: support.supported,
      reason: support.reason,
      busy,
      busyReason: busy ? RESTART_BUSY_REASON : null,
      bootId: PROCESS_BOOT_ID,
    });
  });

  app.post(SERVER_RESTART_PATH, (c) => {
    if (c.get(MCP_ADAPTER_ID_VAR) !== DASHBOARD_ADAPTER_ID) {
      return c.json({ error: RESTART_FORBIDDEN_MESSAGE }, 403);
    }
    const support = resolveRestartSupport(env);
    if (!support.supported) {
      return c.json({ error: support.reason }, 409);
    }
    if (deps.backgroundWritersRunning?.() === true) {
      return c.json({ error: RESTART_BUSY_REASON }, 409);
    }
    const requestRestart = deps.requestRestart;
    if (requestRestart === undefined) {
      return c.json({ error: "requestRestart 미주입 — 재시작을 시작할 수 없어요." }, 503);
    }
    // 종료 절차가 열린 연결을 끊으므로 202 가 나간 뒤에 시작한다.
    setTimeout(requestRestart, triggerDelayMs);
    return c.json({ restarting: true, bootId: PROCESS_BOOT_ID }, 202);
  });
}
