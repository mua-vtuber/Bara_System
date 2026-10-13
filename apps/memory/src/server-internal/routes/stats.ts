/**
 * server-internal/routes/stats.ts — health / 정적 파일 serving / stats 라우트
 *
 * registerStatsRoutes: GET /health, GET / + GET /web/*, GET /stats
 *
 * buildMemoryApi 가 가장 먼저 등록한다 — 경로 충돌 없음.
 */

import type { Hono, Context } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { APP_VERSION, buildVersionInfo } from "../../version.ts";
import {
  resolveStaticPath,
  extensionOf,
  STATIC_MIME,
  err,
} from "../http-helpers.ts";
import { CAPTURE_KINDS } from "./capture.ts";
import { CLIENT_INFO_PROTOCOL_VERSION, CLIENT_CAPABILITIES } from "./client-info-contract.ts";

export function registerStatsRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps;

  // ── GET /health ───────────────────────────────────────────────────────
  // version: the replace procedure checks that a started release answers with the version its release.json names
  // (docs/decisions/2026-10-08-single-deploy-path-spec.md 5.2 step 4). Managed servers bind loopback only.
  app.get("/health", (c) => c.json({ ok: true, version: APP_VERSION }));
  app.get("/client-info", (c) => c.json({
    protocolVersion: CLIENT_INFO_PROTOCOL_VERSION,
    version: APP_VERSION,
    captureKinds: CAPTURE_KINDS,
    capabilities: CLIENT_CAPABILITIES,
  }));

  // ── 정적 파일 serving (미니 대시보드) ───────────────────────────────
  if (deps.staticDir) {
    const staticDir = deps.staticDir;
    const serveStatic = async (c: Context, requestPath: string) => {
      const full = resolveStaticPath(staticDir, requestPath);
      if (!full) return err(c, 404, "not found");
      const file = Bun.file(full);
      if (!(await file.exists())) return err(c, 404, "not found");
      const mime =
        STATIC_MIME[extensionOf(full)] ?? "application/octet-stream";
      return new Response(file, { headers: { "Content-Type": mime } });
    };
    // 루트 요청 → index.html (resolveStaticPath "/" 분기 처리).
    app.get("/", (c) => serveStatic(c, "/"));
    // /web/<...> 하위 경로는 staticDir 안에서 직접 해결.
    app.get("/web/*", (c) => {
      const path = c.req.path.replace(/^\/web/, "") || "/";
      return serveStatic(c, path);
    });
  }

  // ── GET /stats ────────────────────────────────────────────────────────
  app.get("/stats", async (c) => {
    const stats = await store.getStats();
    return c.json({ ...stats, ...buildVersionInfo(store.getRawDb()) });
  });
}
