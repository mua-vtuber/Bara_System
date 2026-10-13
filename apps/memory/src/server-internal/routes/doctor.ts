/**
 * server-internal/routes/doctor.ts — GET /doctor 라우트 등록기 (T23 / spec E).
 *
 * runDoctor(server-internal/doctor.ts) 를 그대로 재노출한다 — REST 재노출 원칙
 * (backup.ts·cleanup-runs.ts 선례) 그대로, 이 라우트는 HTTP 얇은 표면일 뿐 진단
 * 로직을 갖지 않는다. MCP bara_doctor(tools-doctor.ts) 도 같은 runDoctor 를 불러
 * 두 표면이 항상 같은 stages·firstBlockingCause 문구를 낸다.
 *
 * 인자 없음 / 읽기 전용 / 쓰기 0 — 다른 진단 라우트와 달리 confirm 토큰도 body 도
 * 필요하지 않다.
 */

import type { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { runDoctor } from "../doctor.ts";

export function registerDoctorRoutes(app: Hono, deps: MemoryApiDeps): void {
  app.get("/doctor", (c) => c.json(runDoctor(deps)));
}
