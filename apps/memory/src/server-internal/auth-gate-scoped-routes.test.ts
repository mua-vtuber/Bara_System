/**
 * auth-gate-scoped-routes.test.ts — 제한 토큰 REST 허용 표 등록 대조 테스트 (SA-13, WP-B1-12).
 *
 * QA 후속(21e08068 이후) — verifyScopedRouteRegistration / verifyAuthPathRegistration 이
 * 그동안 테스트가 없었다. auth-gate-public-paths.test.ts 의 verifyPublicPathRegistration
 * 검증은 손으로 만든 RegisteredRoute[] fixture(routesWithStatic())로 순수 함수만
 * 검증했는데, 이 파일은 그와 달리 *실제 앱이 등록하는 라우트 목록*으로 검증한다 —
 * index.ts:317-322 가 부팅 시 하는 것과 같은 방식(createMemoryApi 로 실제 inner app을
 * 띄우고, 그 위에 index.ts 와 같은 순서로 /federation·/settings 라우트를 붙인 뒤
 * outerApp.route("/", app) 으로 합친 app.routes)을 그대로 재현한다. 이래야 "현재
 * SCOPED_HTTP_ROUTES 표가 실제 운영 라우트와 맞는지"를 진짜로 증명한다 — 손으로 적은
 * fixture는 표와 fixture가 우연히 같은 손동기화 오류를 반복해도 검증을 통과한다.
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder 부팅(createMemoryApi) — mock 객체 0
 * (CLAUDE.md 테스트 정책). server-boot.test.ts 와 같은 이유로 bge-m3 모델 로드가
 * 느려 timeout을 넉넉히 둔다.
 *
 * 검증 두 갈래:
 *   1) 정상 — 현재 SCOPED_HTTP_ROUTES 표 + 공개 경로 목록이 실제 등록 라우트로
 *      전부 뒷받침된다(경고 0). 표가 드리프트됐으면 이 테스트가 즉시 깨진다.
 *   2) 드리프트 검출 — 존재하지 않는 라우트를 표에 추가한 순수 함수 호출로
 *      verifyScopedRouteRegistration 이 그 항목을 unbackedScopedRoutes 로 report
 *      하는지 별도로 확인한다(런타임 동작인 경고 로그 자체는 바꾸지 않는다 — WP-B1-12
 *      문서에 다른 지시 없음).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { Hono as HonoCtor } from "hono";
import { createMemoryApi } from "../server.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-schema.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import { FederationRegistry } from "../federation/registry.ts";
import { createFederationRoutes } from "../federation/routes.ts";
import { ReloadBus } from "../settings/reload-bus.ts";
import { createSettingsRoutes } from "../settings/routes.ts";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import type { RegisteredRoute } from "./auth-gate-public-paths.ts";
import {
  verifyAuthPathRegistration,
  verifyScopedRouteRegistration,
} from "./auth-gate-scoped-routes.ts";
import { SCOPED_HTTP_ROUTES } from "../federation/token-scope.ts";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: Hono;
let outerApp: Hono;
let shutdown: () => void;
let tokenDir: string;
// 첨부 파일 폴더 — 운영 폴더(env BARA_ASSET_DIR·settings.assets.dir)가 아니라 이 파일만의 임시 폴더(설계 17.19 D41).
let assetDir: string;

/**
 * index.ts 317~322 와 같은 방식으로 실제 앱의 전체 라우트 목록을 만든다.
 *
 * 순서까지 index.ts 를 그대로 따른다: createMemoryApi 가 반환한 inner app 위에
 * /federation·/settings 를 app.route 로 먼저 붙이고(index.ts:228,252), 그 뒤
 * outerApp 을 만들어 outerApp.route("/", app) 으로 합친다(index.ts:264,311).
 * host guard·auth gate·body-limit 은 outerApp.use("*", ...) 미들웨어라
 * .routes 목록(메서드+경로 등록)에 영향을 주지 않으므로 이 테스트의 검증
 * 대상(SCOPED_HTTP_ROUTES·공개 경로 등록 대조)에는 포함하지 않는다 — 실제
 * index.ts 도 그 미들웨어들이 .routes 를 바꾸지 않는 전제로 검증한다.
 */
beforeAll(async () => {
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  // server-boot.test.ts 와 같은 이유로 리랭커(cross-encoder 다운로드)를 끈다 —
  // 이 테스트 목적은 라우트 등록 대조이지 리랭커가 아니다.
  settings.reranker.enabled = false;
  settings.db.embeddingModel = "bge-m3";

  assetDir = mkdtempSync(join(tmpdir(), "bara-scoped-routes-assets-"));
  // 토큰·설정·비밀값·백업 파일 — 운영 파일(env SSE_TOKEN_PATH·MEMORY_SETTINGS_PATH·BARA_SECRETS_PATH)이 아니라 이 임시 폴더.
  tokenDir = mkdtempSync(join(tmpdir(), "bara-scoped-routes-"));
  settings.backup.dir = join(tokenDir, "backups");
  const api = await createMemoryApi({
    dbPath: ":memory:",
    assetDir,
    sseTokenFilePath: join(tokenDir, "boot-sse-tokens.json"),
    settingsFilePath: join(tokenDir, "memory-settings.json"),
    // staticDir 를 안 준다 — hasStaticDir:false 로 검증(index.ts 의 staticDir 없는
    // 부팅과 같은 조건). "/"·"/web/*" 조건부 스킵 규칙(verifyPublicPathRegistration)
    // 이 그대로 적용된다.
    llmProvider: "none",
    settings,
  });
  app = api.app;
  shutdown = api.shutdown;

  const federationRegistry = new FederationRegistry();
  const sseTokens = new SseTokenStore(join(tokenDir, "sse-tokens.json"));
  app.route(
    "/federation",
    createFederationRoutes(federationRegistry, {
      adminTokenForAdapter: (id: string) => sseTokens.getAdapterAdminToken(id),
    }),
  );

  const reloadBus = new ReloadBus();
  app.route(
    "/settings",
    createSettingsRoutes({
      reloadBus,
      settingsPath: join(tokenDir, "memory-settings.json"),
      secretsPath: join(tokenDir, "secrets.json"),
      ollamaUrl: () => settings.llm.extractor.ollamaUrl,
    }),
  );

  outerApp = new HonoCtor({ strict: false });
  outerApp.route("/", app);
}, 120_000);

afterAll(() => {
  shutdown();
  if (tokenDir && existsSync(tokenDir)) rmSync(tokenDir, { recursive: true, force: true });
  if (assetDir && existsSync(assetDir)) rmSync(assetDir, { recursive: true, force: true });
});

describe("verifyAuthPathRegistration — 실제 앱 라우트로 현재 표 검증 (index.ts:317-322 재현)", () => {
  test("SCOPED_HTTP_ROUTES 표가 실제 등록 라우트로 전부 뒷받침된다 — 드리프트 0", () => {
    const routes: RegisteredRoute[] = outerApp.routes;
    expect(routes.length).toBeGreaterThan(0);

    const result = verifyAuthPathRegistration(routes, { hasStaticDir: false });
    if (result.warnings.length > 0) {
      // 드리프트가 발견되면 원인을 그대로 노출한다
      // (CLAUDE.md silent-fallback 금지 — 실패 원인을 요약해서 숨기지 않는다).
      throw new Error(`표 드리프트가 발견됐다:\n${result.warnings.join("\n")}`);
    }
    expect(result.unbackedPublicPaths).toEqual([]);
    expect(result.unbackedScopedRoutes).toEqual([]);
  });

  test("파라미터 이름이 다르면(`:adapterId` vs `:id`) 같은 경로 형태로 판정된다", () => {
    // federation/routes.ts:308 이 등록하는 실제 경로는 `GET /apps/:id/settings`
    // (federation base 를 붙이면 `GET /federation/apps/:id/settings`)인데,
    // token-scope.ts:118 의 표는 `GET /federation/apps/:adapterId/settings` 이다.
    // 정규화된 비교는 둘 다 같은 형태(두 개의 세그먼트, 두 번째는 파라미터)로 판정한다.
    const routes: RegisteredRoute[] = outerApp.routes;
    const result = verifyScopedRouteRegistration(routes);
    // 이 경로는 파라미터 이름만 다르지, 실제로는 등록되어 있으므로 unbacked 에 없어야 한다.
    expect(result.unbackedScopedRoutes).not.toContain(
      "GET /federation/apps/:adapterId/settings",
    );
    // 확인: 실제로 등록된 경로의 파라미터 이름이 다르다는 것을 명시.
    const registered = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect(registered.has("GET /federation/apps/:id/settings")).toBe(true);
    expect(registered.has("GET /federation/apps/:adapterId/settings")).toBe(false);
  });
});

describe("verifyScopedRouteRegistration — 등록되지 않은 라우트가 있으면 드리프트로 report (운영 함수 직접 호출)", () => {
  test("실제 앱 라우트에서 표의 첫 항목을 제거하면 그 항목이 unbackedScopedRoutes 로 report 된다", () => {
    // 운영 함수(verifyScopedRouteRegistration)를 재구현하지 않고 그대로 호출한다.
    // 입력만 조작한다: 실제 앱이 등록한 라우트 목록에서 SCOPED_HTTP_ROUTES 의
    // 첫 항목 하나만 걷어낸 뒤 넘겨, 그 항목이 죽은 표 항목으로 report 되는지 본다.
    const routes: RegisteredRoute[] = outerApp.routes;
    const firstRoute = SCOPED_HTTP_ROUTES[0]!;
    const routesMissingFirst = routes.filter(
      (r) => !(r.method === firstRoute.method && r.path === firstRoute.path),
    );
    const result = verifyScopedRouteRegistration(routesMissingFirst);
    expect(result.unbackedScopedRoutes).toContain(
      `${firstRoute.method} ${firstRoute.path}`,
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain(firstRoute.path);
    expect(result.warnings[0]).toContain("손동기화");
  });

  test("표에 없는 경로가 실제 라우트에도 없다는 전제 자체를 확인 — 오탐 방지용 대조 표본", () => {
    // 위 테스트가 '있는 항목을 지웠을 때' 드리프트를 잡는지 봤다면, 이 테스트는
    // '실제로 등록되지 않은 임의 경로'가 애초에 app.routes 안에 없다는 것을 확인해,
    // outerApp 조립이 우연히 모든 경로를 다 통과시키는 느슨한 라우터가 아님을 보인다.
    const routes: RegisteredRoute[] = outerApp.routes;
    const registered = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect(registered.has("GET /this-route-does-not-exist")).toBe(false);
  });
});
