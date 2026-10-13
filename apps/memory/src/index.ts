/**
 * memory-api entry point. Run with `bun run src/index.ts`.
 *
 * S10 정착 (2026-05-19) 후 모듈 코어 설정은 `data/memory-settings.json` 이
 * 단일 권위 — 옛 LLM_PROVIDER, OLLAMA_*, ANTHROPIC_*, EVOLVER_*, BACKFILL_*,
 * RECENCY_HALF_LIFE_DAYS, IMPORTANCE_HALF_LIFE_DAYS env 모두 settings 로 이전.
 *
 * 부트스트랩 예외 (settings 로딩 *전*에 알아야 하는 인프라 인자):
 *   MEMORY_SETTINGS_PATH·BARA_SECRETS_PATH — settings 파일(디폴트 `data/memory-settings.json`)·비밀값 파일(디폴트 settings 옆
 *                         secrets.json). resolveSettingsFilePaths 가 한 쌍으로 정하고 설정 읽기·/settings 라우트가 그 값을 받는다.
 *   MEMORY_DB_PATH       — settings.db.path 위에 ops 오버라이드. 미설정 시 settings 값.
 *   BARA_ASSET_DIR·SSE_TOKEN_PATH — 첨부 파일 폴더(settings.assets.dir 위 오버라이드)·연결 토큰 파일. createMemoryApi 가 받는다.
 *   MEMORY_PORT          — settings.db.port 위에 오버라이드.
 *   MEMORY_HOST          — settings.db.host 위에 오버라이드.
 *   MEMORY_STATIC        — 정적 대시보드 디렉토리. settings 비노출 (운영자급 인프라).
 *   BARA_ADAPTERS_DIR    — 펫 방식 서버의 어댑터 폴더. 있으면 <폴더> 아래 각 어댑터의 current/app.manifest.json 도 훑는다(federation/discovery.ts).
 *   OLLAMA_NUM_CTX       — Ollama 컨텍스트 윈도우 튜닝. ollama-client.ts 안에서 직접 읽음.
 *
 * 위 10개 env 만 이 모듈이 process.env 를 *직접* 읽는 경로 — 그 외 모든 모듈
 * 코어 옵션은 settings 안.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { createMemoryApi } from "./server.ts";
import { EVENT_TYPES } from "./server-internal/event-bus.ts";
import {
  startBackfillScheduler,
  startVisionBackfillScheduler,
  startCleanupDeepPassScheduler,
  type BackfillSchedulerHandle,
} from "./scheduler.ts";
import { buildLlmClientWithReason } from "./server-internal/llm-wiring.ts";
import { asObservableLlmClient } from "./memory/cleanup-deep-pass/cleanup-llm-executor.ts";
// 깊은 패스 사이클 오케스트레이션(4단계 순차·실행층·예산·요약 로그)은 run-cycle-runner.ts
// createRunCycle 로 추출됐다(spec 5.B-1 — 수동 run API 와 정기 tick 이 한 통로). 옛 인라인
// 클로저가 쓰던 CleanupLlmExecutor·CycleBudget·단계 cycle 함수 import 는 그쪽으로 이동.
import { buildCleanupGateInput, buildMemoSavedTrigger, entityRegisterStageConfig } from "./memory/cleanup-deep-pass/entity-register/boot-wiring.ts";
import type { MemoSavedCleanupTrigger } from "./memory/cleanup-deep-pass/entity-register/per-memo-trigger.ts";
import {
  cleanupDeepPassGateReasons,
  shouldRunCleanupDeepPass,
} from "./memory/cleanup-deep-pass/scheduler-gate.ts";
import { createRunCycle } from "./memory/cleanup-deep-pass/run-cycle-runner.ts";
import { CleanupRunsLedger, emptyRunAggregates } from "./memory/cleanup-deep-pass/cleanup-runs-ledger.ts";
import type { CleanupRunsRouteDeps } from "./server-internal/routes/cleanup-runs.ts";
import type { CleanupRunContext } from "./scheduler.ts";
import { toVisionProviderSettings } from "./llm/vision/caption-flow.ts";
import { createVisionProvider } from "./llm/vision/index.ts";
import {
  startAutoCleanupTrigger,
  type AutoCleanupTriggerHandle,
} from "./memory/auto-cleanup-trigger.ts";
import { startTrashCron, type TrashCronHandle } from "./memory/trash-manager.ts";
import { startBackupCron, type BackupCronHandle } from "./backup/backup-cron.ts";
import { cleanupIncompleteRounds } from "./backup/backup-runner.ts";
import { serverBackupRunDeps } from "./backup/server-backup-deps.ts";
import { DEFAULT_SSE_TOKEN_PATH } from "./federation/sse-tokens.ts";
import {
  createOllamaInferFn,
  runMetadataInferCycle,
} from "./memory/metadata-infer-cycle.ts";
import {
  createOllamaPersonLinkInferFn,
  runPersonLinkInferCycle,
} from "./memory/person-link-infer-cycle.ts";
// Phase 5.7.3 W6 (2026-05-22) — 옛 evolver 백그라운드 사이클 통째 폐기 후
// 위 두 신규 시스템 가동. 옛 import (MemoryEvolver / 옛 백그라운드 가동 함수)
// 제거.
import { FederationRegistry } from "./federation/registry.ts";
import { discoverAndLogFederation } from "./federation/discovery.ts";
import { HealthPoller } from "./federation/health-poller.ts";
import { createFederationRoutes } from "./federation/routes.ts";
import { ReloadBus } from "./settings/reload-bus.ts";
import { createSettingsRoutes } from "./settings/routes.ts";
import { getMemorySettings, resolveSettingsFilePaths } from "./settings/memory-settings.ts";
import { createBodyLimit } from "./server-internal/body-limit.ts";
import { createAuthGate } from "./server-internal/auth-gate.ts";
import { createGracefulExit } from "./server-internal/graceful-exit.ts";
import { RESTART_EXIT_CODE } from "./server-internal/restart-policy.ts";
import { verifyAuthPathRegistration } from "./server-internal/auth-gate-scoped-routes.ts";
import { createHostGuard } from "./server-internal/host-guard.ts";
import { isLoopbackHost, SERVER_IDLE_TIMEOUT_SECONDS } from "./index-helpers.ts";
import { warmUpKoreanTokenizer } from "./memory/lang/korean-tokenizer.ts";
import { setTimeZone } from "./db/store-internal/helpers.ts";

// settings 파일 부재는 setup engine 이 처리한다. 서버가 기본값으로 조용히 떠 버리면
// 설치/런처가 고른 데이터 경로와 실제 런타임이 어긋나므로 loud 하게 멈춘다.
const settingsFiles = resolveSettingsFilePaths(process.env);
const settingsFilePath = settingsFiles.settingsPath;
if (!existsSync(settingsFilePath)) {
  console.error(
    `[memory-api] setup required: settings 파일이 없습니다 (${settingsFilePath}). ` +
      `먼저 저장소 루트에서 'bun run setup -- --local'(WSL/Linux) 또는 'bun run setup -- --desktop'(Windows), 또는 Bara Launcher setup 을 실행하세요. ` +
      `펫으로 설치한 서버는 펫이 설정 파일을 준비하므로 펫의 설치·업데이트로 다시 준비하세요.`,
  );
  process.exit(78);
}

// settings 1회 로딩 — 부팅 시점 권위 스냅샷. PUT /settings 후 재시작
// 5~15초 윈도우에 새 값이 적용된다 (사용자 명시 게이트, status.md).
let settings = getMemorySettings(settingsFilePath, settingsFiles.secretsPath);

// P3 G3-b — 애플리케이션 시간대를 helpers 모듈에 주입한다. 저장 시각(nowKst)·상대
// 날짜·보관 컷오프가 전부 이 zone 하나를 따르게 된다. createMemoryApi(store 생성)
// *전에* 주입해야 store 가 첫 노드부터 올바른 zone 으로 시각을 적는다. 잘못된 zone
// 문자열은 setTimeZone 이 loud 하게 throw 해 부팅을 멈춘다(silent fallback 금지 —
// 소유자가 오타를 즉시 발견). default "Asia/Seoul" 이면 옛 KST 고정 동작과 동일.
setTimeZone(settings.time.zone);
console.log(`[memory-api] 시간대 설정: ${settings.time.zone}`);

// 부트스트랩 env override 정합 — 인프라 바인딩이라 settings UI 비노출 항목.
// 미설정이면 settings.db.* 디폴트 사용.
const dbPath =
  process.env.MEMORY_DB_PATH?.trim() || settings.db.path || ":memory:";
// 첨부 파일 폴더·연결 토큰 파일 — createMemoryApi 와 백업 runDeps 가 부팅 때 정한 이 값을 쓴다(설계 17.19 D41, 빈 폴더 값은 S5 멈춤).
const assetDir = process.env.BARA_ASSET_DIR?.trim() || settings.assets.dir;
const sseTokenFilePath = process.env.SSE_TOKEN_PATH?.trim() || DEFAULT_SSE_TOKEN_PATH;
const port = Number.parseInt(
  process.env.MEMORY_PORT ?? String(settings.db.port),
  10,
);
const hostname =
  process.env.MEMORY_HOST?.trim() || settings.db.host || "127.0.0.1";
const staticDir = process.env.MEMORY_STATIC?.trim() || undefined;

if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  console.error(`[memory-api] invalid MEMORY_PORT: ${process.env.MEMORY_PORT}`);
  process.exit(1);
}

console.log(
  `[memory-api] starting (db=${dbPath}, host=${hostname}, port=${port})...`,
);

// :memory: 폴백 경고. settings 부재 + env 미설정 동시 발생 시 silent data loss
// 차단 — 2026-05-15 본인 한 번 당한 적 있어 매번 한 줄 경고로 surface.
if (dbPath === ":memory:") {
  console.warn(
    "[memory-api] ⚠️  DB가 :memory:로 설정되어 있음 — 메모는 재시작 시 전부 사라진다.",
  );
  console.warn(
    "[memory-api] ⚠️  영구 저장은 settings 페이지의 'DB 파일 경로' 또는 env MEMORY_DB_PATH 로 설정.",
  );
}

// 보안 Phase 1 Task 5 — 비-loopback 바인딩 부팅 경고.
// TLS 프록시 없이 외부 주소에 바인딩하면 Authorization 토큰이 평문으로 흐른다.
// 다음 보안 spec(TLS) 전까지 신뢰된 LAN 또는 암호화 통로(VPN 등)를 거치도록 경고한다.
if (!isLoopbackHost(hostname)) {
  console.warn(
    "[memory-api] [경고] 비-loopback bind — TLS 프록시(Caddy 등) 없이 외부 노출 시 토큰이 평문으로 흐른다. " +
      "다음 보안 spec(TLS) 전까지 신뢰된 LAN 또는 암호화 통로(VPN 등)를 거치라.",
  );
  // P1-A2 — 비-loopback bind 인데 MEMORY_ALLOWED_HOSTS 미설정이면 프록시/외부
  // 접속 Host 가 Host 게이트 허용목록 밖이라 403 난다. 정직한 실패 예고
  // (silent 통과 금지 — 소유자가 자기 서비스가 왜 403 나는지 모르는 상황 차단).
  if (!process.env.MEMORY_ALLOWED_HOSTS?.trim()) {
    console.warn(
      "[memory-api] [경고] 비-loopback bind + MEMORY_ALLOWED_HOSTS 미설정 — " +
        "리버스 프록시/외부 접속 Host 가 Host 게이트에서 403 된다. " +
        "프록시가 세팅하는 Host(예: memory.example.com)를 MEMORY_ALLOWED_HOSTS 에 콤마 구분으로 추가하라.",
    );
  }
}

// Phase 6a T11 — regex 자가 검증 API(`POST /api/regex/validate`) + 양식·booster
// CRUD 라우트(`/api/regex-patterns` · `/api/regex-boosters`)는 buildMemoryApi 안에서
// 등록된다(registerRegexRoutes). 그 라우트는 createMemoryApi 가 부팅 시 만든 *한*
// RegexL0Extractor 인스턴스(deps.regexL0)와 그 인스턴스가 받은 *같은* RegexUserRepo
// (deps.regexUserRepo)를 공유한다 — CRUD(add/delete) 직후 regexL0.reload() 가 같은
// DB 를 다시 읽어 캐시에 반영하므로, 사용자 추가 양식/booster 가 자가 검증 + 입력
// 흐름(T9 POST /memories) 양쪽에 즉시 적용된다(단일 권위). 별 인스턴스를 만들지 않도록
// 여기서 다시 mount 하지 않는다 — inner app(아래 outerApp.route("/", app))이 그대로
// /api/* 를 흘려보낸다.
const {
  app,
  store,
  extractor,
  llm,
  assetStore,
  imageEmbedder,
  // Phase 7 요약 단계 Task 7 — createMemoryApi 가 부팅 시 만든 *한* Embedder(글 임베딩
  // bge-m3 1024). 깊은 패스 둘째 단계(요약)의 청크요약·관계요약 텍스트를 임베딩해 vec0
  // 에 넣는 데 쓴다(runSummaryCycle deps). server.ts 가 이미 반환하던 칸인데 여기
  // destructure 에만 빠져 있었다.
  embedder,
  eventBus,
  // P3 G3-c — createMemoryApi 가 부팅 시 만든 events 큐 repository. trash cron 이
  // 오래된 events 를 주기 정리(purgeOldEvents)하는 데 쓴다. eventBus 와 같은 db·인스턴스.
  eventRepository,
  // Phase 7 깊은 패스 Task 4 — createMemoryApi 가 부팅 시 만든 *한* RegexL0Extractor
  // 인스턴스(deps.regexL0). 깊은 패스 후보 검출이 *입력 시점과 같은* 양식 세트를 봐야
  // 하고(Task 6 의 approve 후 reload() 도 반영), extractor.regex.enabled=false 면
  // undefined — 그땐 깊은 패스도 비활성(아래 게이트).
  regexL0,
  // 보안 Phase 1 Task 5 — createMemoryApi 가 부팅 시 만든 SseTokenStore 인스턴스.
  // outerApp 의 createAuthGate 에 주입해 Bearer 토큰 검증을 수행한다.
  sseTokens,
  setAutoCleanupTrigger,
  // 데이터 정리 AI 효율 가동 5.B-1 — run API 배선 주입 셋터. 아래 깊은 패스 스케줄러를
  // 만든 뒤 run 원장·스케줄러 트리거·취소 registry 를 묶어 deps.cleanupRuns 에 얹는다.
  setCleanupRuns,
  // 데이터 초기화 0단계 — 아래 세 스케줄러 중 하나라도 사이클을 돌고 있는지 확인하는 함수를 얹는 셋터.
  setBackgroundWritersRunning,
  documentOcrRuntime,
  shutdown,
} = await createMemoryApi({
  dbPath, assetDir, sseTokenFilePath, settingsFilePath,
  staticDir,
  settings,
  // 문서 OCR 실행기 관리자가 읽는 살아 있는 설정 — 아래 reloadBus 구독이 settings 변수를 갈아 끼운다.
  getLiveSettings: () => settings,
  // 대시보드 재시작 버튼 — handleSignal 은 아래에서 선언되지만 요청이 들어올 때 호출되므로 그때는 준비돼 있다.
  requestRestart: () => { void handleSignal("dashboard restart request", RESTART_EXIT_CODE); },
});

// App federation (Phase 5.5 / spec section 6.1) — apps/* 매니페스트(그리고 BARA_ADAPTERS_DIR 가 있으면
// 그 폴더의 <어댑터>/current 매니페스트)를 스캔 + 검증 통과한 어댑터만 레지스트리 등록 + health poll. 부팅 시 1회
// 스캔 (매니페스트 hot-reload 안 함 — spec section 12).
const federationRegistry = new FederationRegistry();
const appsRoot = resolve(import.meta.dir, "..", "..");
await discoverAndLogFederation(appsRoot, federationRegistry, process.env);
// federation 프록시가 코어→봇 hop 에 봇 관리 토큰을 부착하도록 조회 함수를
// 주입한다(P1-통합 I4). sseTokens 는 SSE 토큰 검증과 같은 저장소에서 봇 관리
// 토큰도 보관한다(spec § 6). 화살표로 감싸 this 바인딩을 유지한다.
app.route(
  "/federation",
  createFederationRoutes(federationRegistry, {
    adminTokenForAdapter: (id) => sseTokens.getAdapterAdminToken(id),
  }),
);
// localhost 어댑터 = 부하 무시 가능 → 5초 polling 으로 단축 (start-all.bat
// 직후 본인이 대시보드 진입할 때 down 잔존 윈도우 30초 → 5초로 축소).
const healthPoller = new HealthPoller(federationRegistry, { intervalMs: 5_000 });
healthPoller.start();

// Memory core settings 라우터 (Phase 5.5.5 S9). PUT /settings 가 호출되면
// reload-bus 가 emit — 본 index.ts 가 구독해 in-process settings 변수를
// 새 디스크 값으로 갱신한다. 스케줄러·임베딩 인스턴스는 부팅 시 captured
// 값으로 가동 중이라 재시작 전엔 새 값 미적용 — 사용자가 settings 페이지
// 저장 후 본인이 메모리 서비스 재시작 (5~15초 윈도우, 매일 사용 게이트
// 그대로 유지). 이 한계는 콘솔 로그로 명시.
const reloadBus = new ReloadBus();
reloadBus.subscribe(() => {
  settings = getMemorySettings(settingsFilePath, settingsFiles.secretsPath);
  console.log(
    "[memory-api] settings 다시 읽음 — 다음 사이클 값은 재시작 후 적용 (5~15초 윈도우). 문서 OCR 은 바로 적용.",
  );
  // 문서 OCR 은 저장 즉시 재구성(사용자 결정 Q9) — 저장 응답을 막지 않고, 실패는 로그로 알린다.
  void documentOcrRuntime.reconfigure().catch((e) => {
    console.error(`[memory-api] 문서 OCR 재구성 실패: ${e instanceof Error ? e.message : String(e)}`);
  });
});
app.route(
  "/settings",
  createSettingsRoutes({
    reloadBus, settingsPath: settingsFilePath, secretsPath: settingsFiles.secretsPath,
    ollamaUrl: () => settings.llm.extractor.ollamaUrl,
  }),
);

// 보안 미들웨어와 inner app 을 분리하기 위해 *outer* Hono 한 벌로 감싼다.
// createMemoryApi 안에서 staticDir 핸들러(`GET /`, `GET /web/*`)가 이미 등록된
// 상태라, body-limit/auth/host guard 를 inner app 에 뒤늦게 박으면 정적 핸들러에
// 미적용된다. outer 한 겹이 단일 진입점이다.
const outerApp = new Hono({ strict: false });

// P1-A2 — Host/Origin 검증 미들웨어 (DNS 리바인딩 차단).
// 미들웨어 스택 최최상단 — body-limit·auth-gate 앞. 리바인딩
// 방어는 어떤 서버 로직보다 먼저 걸려야 하고(무해한 302 조차 리바인딩 요청에
// 주지 않는다), 비용은 헤더 검사 하나라 최상단에 둬도 부담 없다.
// host·port 는 위에서 계산된 bind 값 재사용(단일출처, 하드코딩 0).
outerApp.use("*", createHostGuard({ host: hostname, port }));

// 보안 Phase 1 Task 5 — 인증 게이트 미들웨어.
// remoteAddrOf 는 Bun server.requestIP 를 통해 실제 원격 IP 를 추출한다.
// c.env 는 Bun.serve 가 주입하는 환경 객체로, requestIP 메서드가 담겨 있다.
//
// P3 G3-e — auth-gate 를 body-limit *앞*에 둔다. 인증 실패 요청(토큰 없음 401)이
// body-limit 의 본문 스트림 버퍼링에 도달하지 못하게 해, 무인증 대용량 업로드로
// 메모리를 압박하는 표면을 없앤다(감사 지적). 무인증 *허용* 경로(/adapter-enroll·
// /health 등 allowlist)는 auth-gate 가 통과시키고, 그 뒤 body-limit 가 여전히
// 상한을 적용하므로(아래 순서) 그 경로들의 본문 보호는 사라지지 않는다 —
// "auth 앞으로, body-limit 뒤로" 이동이 무인증 본문 경로를 무제한으로 만들지 않는다.
outerApp.use(
  "*",
  createAuthGate({
    getMcpBodyLimit: () => settings.security.maxTextBytes,
    sseTokens,
    remoteAddrOf: (c) =>
      (
        c.env as {
          requestIP?: (r: Request) => { address: string } | null;
        }
      )?.requestIP?.(c.req.raw)?.address,
  }),
);

// 보안 Phase 1 Task 5 — 입력 상한 미들웨어.
// 요청마다 getLimits 를 통해 설정값을 읽으므로 재시작 없이도 변경이 반영된다.
// P3 G3-e — auth-gate *뒤*. 인증을 통과했거나 auth-gate allowlist 인 요청만 여기
// 본문 버퍼링에 도달한다. /ingest 같은 대용량 라우트는 보호 경로라 인증 통과 후
// maxAssetBytes 상한을 받고, /adapter-enroll 은 allowlist 통과 후에도 여전히
// maxTextBytes 상한을 받는다(무인증 본문 경로 회귀 0).
outerApp.use(
  "*",
  createBodyLimit(() => ({
    maxTextBytes: settings.security.maxTextBytes,
    maxAssetBytes: settings.security.maxAssetBytes,
  })),
);

outerApp.route("/", app);

// P3 G4-c + SA-13(WP-B1-12) — 공개 경로 계약과 제한 토큰 REST 허용 표
// (token-scope.ts SCOPED_HTTP_ROUTES)를 실제 등록 라우트와 한 번에 대조해
// 손동기화 드리프트를 부팅에서 잡는다. 죽은 항목은 loud 경고 — silent 통과 금지.
// staticDir 없으면 "/"·"/web" 검증은 건너뛴다(조건부 정직).
const authPathCheck = verifyAuthPathRegistration(outerApp.routes, {
  hasStaticDir: staticDir !== undefined,
});
for (const warning of authPathCheck.warnings) {
  console.warn(warning);
}
if (authPathCheck.warnings.length === 0) {
  console.log(
    "[auth-gate] 공개 경로·제한 토큰 허용 표와 등록 라우트 정합 확인 (드리프트 0).",
  );
}

const server = Bun.serve({ port, hostname, idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS, fetch: outerApp.fetch });
// 문서 OCR 서버 자동 처리(로컬·API) — 설정대로 켜거나 끈다(사유는 로그·상태 화면).
await documentOcrRuntime.reconfigure();

console.log(`[memory-api] listening on http://${hostname}:${server.port}`);
console.log(`[memory-api] dashboard at http://${hostname}:${server.port}/`);

// 한국어 토크나이저(Kiwi) 워밍업 — 부팅을 막지 않는 백그라운드 최적화.
// 호출 안 해도 첫 tokenizeKorean 이 자동 초기화하므로(korean-tokenizer.ts
// JSDoc), 실패해도 서버 가동 자체는 계속돼야 한다 — await 로 블로킹하지
// 않고 fire-and-forget + 실패 시 식별자 포함 loud warn(silent 무시 금지,
// onExtractorCycleComplete 의 catch 선례 정합). 성공 시 첫 한국어 검색/추출
// 호출의 cold start(WASM 로드 + 모델 사전 로드 + Kiwi 빌드)를 제거한다.
void warmUpKoreanTokenizer().catch((e) => {
  console.warn(
    `[memory-api] warmUpKoreanTokenizer 실패 — 첫 tokenizeKorean 호출 시 자동 재시도(성능 저하만, 기능 영향 없음): ${
      e instanceof Error ? e.message : String(e)
    }`,
  );
});

// 백필 스케줄러 — settings.llm.extractor.enabled=true + mode='backfill' + interval>0
// + extractor 가용 시 가동. Phase 5.6 W5 정합 — 의미 추출 슬롯이 권위.
//
// Phase 5.7.2 W4 (2026-05-22) — 본 가동 분기 변경 0 약속:
//   본 단락 (이 주석 아래 if/else) = scheduler 가동 갈래 결정 권위. mode 갈래
//   3 종 동작 정합:
//     - extractor.enabled=true + mode='backfill' + interval>0 + extractor 가용
//       → startBackfillScheduler 호출 (정해진 주기 cron 가동)
//     - extractor.enabled=true + mode='immediate'
//       → intervalMin=0 → else 분기 → off + 안내 console.log
//         (POST /memories 라우트 안 mode='immediate' wiring 가 즉시 추출 책임)
//     - extractor.enabled=false
//       → intervalMin=0 → else 분기 → off + 안내 console.log
//   본 분기는 5.7.2 wiring 본격 작업 (W2 신규 mode='immediate' POST /memories
//   라우트 wiring) 후에도 옛 흐름 그대로 보존 — mode 갈래별 동작이 *코어 단계
//   에서 일관* 한 정신.
//   본 분기 자체는 모듈 진입부 (top-level await + 인스턴스 가동) 라 단위
//   테스트 어려움 → 분기 동작 권위 = 본 JSDoc + 매뉴얼 sanity gate (spec
//   section 4.3) 5단계 안 backfill 30분 cron 흐름 검증. scheduler 함수 자체의
//   입력 검증 + 사이클 동작 = apps/memory/src/scheduler.test.ts 가 별도 검증.
let scheduler: BackfillSchedulerHandle | null = null;
const extractorSlot = settings.llm.extractor;

// Phase 7 2차 Task 6 — 갈래 2(맥락 추론 메타 전파)를 extractor 사이클 끝에 얹는다.
//   별도 스케줄러·cadence·offset·setInterval 0 — extractor `runCycle` 이 끝나는
//   `onCycleComplete` 직후 갈래 2 한 사이클(runMetadataInferCycle)을 순차로 잇는다.
//   extractor 사이클과 같은 프로세스 안 순차라 겹침 0(락·스태거 불필요).
//
//   가동 조건 = settings.metadataInfer.enabled=true + LLM 가용(extractor 와 같은
//   ollama 클라이언트 재사용 — 새 LLM 통로 0). 둘 중 하나라도 빠지면 콜백 안에서
//   no-op + 사유 로그(graceful — 잘못된 자동 데이터 0). extractor 자체가 꺼지면
//   onCycleComplete 가 안 불려 갈래 2 도 자연히 안 돈다(얹힌 구조).
//
//   infer 함수 = createOllamaInferFn(llm). llm 미가용(null)이면 infer=null 로 둬
//   runMetadataInferCycle 이 no-op 분기를 탄다. enabled=false 면 호출 자체를 건너뛴다.
const metadataInferSlot = settings.metadataInfer;
const metadataInferFn =
  metadataInferSlot.enabled && llm !== null
    ? createOllamaInferFn(llm)
    : null;
// Phase 7 2차 Task 6 — 중복 진입 차단 플래그(원인 2). onExtractorCycleComplete 은
// fire-and-forget(void)이라 이전 갈래 2 사이클이 아직 ollama 로 도는 중에 다음
// extractor 사이클(2분 격자)이 끝나면 콜백이 또 불려 갈래 2 가 중첩 실행될 수 있다.
// extractor 후보가 0이면 runCycle 이 즉시 끝나 매 2분마다 콜백이 불리므로 위험이 크다.
// extractor/vision overlap 가드와 같은 정신의 module-level 플래그 한 개로 막는다.
let metaInferRunning = false;
const onExtractorCycleComplete = (): void => {
  if (!metadataInferSlot.enabled) {
    // enabled=false — 정직한 비활성(첫 가동 콜백에서만 의미 있으나 매 사이클 조용히
    // 건너뛴다. 시작 로그는 아래 한 줄로 한 번 남긴다).
    return;
  }
  if (metaInferRunning) {
    // 이전 사이클이 아직 도는 중 — 중첩 실행 차단(매 2분이라 로그는 생략).
    return;
  }
  // runMetadataInferCycle 은 infer=null 이면 자체 no-op 로그를 남기므로, 여기서는
  // 결과 정상 흐름만 잇고 실패는 loud 로 surface(silent swallow 금지).
  metaInferRunning = true;
  void runMetadataInferCycle({
    db: store.getRawDb(),
    infer: metadataInferFn,
    eventBus,
    gapMinutes: metadataInferSlot.sessionGapMinutes,
    batchSize: metadataInferSlot.batchSize,
  })
    .catch((e) => {
      console.error(
        `[metadata-infer] 사이클 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    })
    // 예외 경로에서도 반드시 플래그를 푼다 — 안 풀면 갈래 2 가 영구 정지한다.
    .finally(() => {
      metaInferRunning = false;
    });
};

// Phase 5.7.1 W1 — 옛 backfillIntervalMin / extractor.backfill* 칸 → llm.extractor.backfill sub-object 이전.
const intervalMin =
  extractorSlot.enabled && extractorSlot.mode === "backfill"
    ? extractorSlot.backfill.intervalMin
    : 0;
if (intervalMin > 0) {
  if (!extractor) {
    console.warn(
      "[memory-api] llm.extractor.enabled=true + mode='backfill' 인데 LLM 클라이언트 없음 — 스케줄러 비활성.",
    );
  } else {
    scheduler = startBackfillScheduler(extractor, store, {
      intervalMs: intervalMin * 60_000,
      // extractor 는 경계 격자 그대로(offset 0). vision 은 같은 주기를
      // 따르되 반 주기 뒤로 스태거 — 두 스케줄러가 같은 분에 겹쳐 도는 걸 피한다.
      offsetMin: 0,
      batchSize: extractorSlot.backfill.batchSize,
      minImportance: extractorSlot.backfill.minImportance, chunking: settings.chunking,
      // Phase 7 2차 Task 6 — extractor 사이클 끝마다 갈래 2 한 사이클을 잇는다.
      onCycleComplete: onExtractorCycleComplete,
    });
    console.log(
      `[memory-api] 맥락 추론 메타 전파(갈래 2): ${
        metadataInferFn !== null
          ? `의미 추출 사이클 끝마다 가동 (G=${metadataInferSlot.sessionGapMinutes}분, batch=${metadataInferSlot.batchSize})`
          : metadataInferSlot.enabled
            ? "enabled=true 이나 LLM 미가용 — 미가동(graceful)"
            : "enabled=false — 미가동"
      }`,
    );
  }
} else {
  console.log(
    "[memory-api] background backfill scheduler: off (extractor.enabled=" +
      String(extractorSlot.enabled) +
      ", mode=" +
      extractorSlot.mode +
      ").",
  );
}

// Phase 11e G2-3 (T7 / DCL-1) + extractor-vision-unified-clock-scheduler 결정 2·5 —
//   vision(VLM 캡션) 백필 스케줄러.
//   extractor 스케줄러 가동 자리 바로 옆에 vision 갈래를 둔다(spec §10.4 / index.ts
//   extractor 분기 정합). 동작 방식(mode)·주기(intervalMin) 분은 "의미추출 AI" 수준
//   공통이라 권위 = extractor 슬롯 — vision 은 extractor.mode·backfill.intervalMin 을
//   따라간다(이미지 슬롯 독립 mode·intervalMin 제거 — 결정 5). 켜기 토글만 따로
//   (visionSlot.enabled) — 이미지 캡션 default OFF (opt-in). 가동 조건 =
//   visionSlot.enabled=true + extractor.mode='backfill' + extractor.backfill.intervalMin>0
//   + VLM provider 가용. extractor 와 같은 런타임 골격(startGenericBackfillScheduler)을
//   공유하고 vision 전용 = 후보 조회(has_caption_auto=0 / created_at ASC) + caption flow
//   한 곳뿐. 두 스케줄러가 같은 분에 겹치지 않도록 반 주기 스태거 offset =
//   floor(intervalMin/2).
//
//   graceful (spec §3 / §8.3-4 정합): extractor.mode='immediate' 또는
//   visionSlot.enabled=false 면 스케줄러 off + 명시 로그(정직한 비활성 — 0건 위장
//   금지). 가동 조건 충족인데 provider 가 못 만들어지면(미설정·양식 어긋남) 비활성 +
//   명시 로그(extractor 의 "LLM 클라이언트 없음 — 스케줄러 비활성" 선례 정합). 이미지
//   입력 토대 자체가 꺼졌으면(imageEmbedder 미주입 — 운영 0) 캡션 달 이미지가 없으므로
//   비활성.
let visionScheduler: BackfillSchedulerHandle | null = null;
const visionSlot = settings.llm.vision;
const visionIntervalMin =
  visionSlot.enabled && extractorSlot.mode === "backfill"
    ? extractorSlot.backfill.intervalMin
    : 0;
const visionOffsetMin = Math.floor(extractorSlot.backfill.intervalMin / 2);
if (visionIntervalMin > 0) {
  if (!imageEmbedder) {
    console.warn(
      "[memory-api] llm.vision.enabled=true + extractor mode='backfill' 인데 이미지 입력 토대 없음(imageEmbedder 미주입) — vision 스케줄러 비활성.",
    );
  } else {
    const visionProviderSettings = toVisionProviderSettings(visionSlot);
    let visionProvider = null as ReturnType<typeof createVisionProvider>;
    try {
      visionProvider = createVisionProvider(visionProviderSettings);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[memory-api] createVisionProvider 실패 — vision 스케줄러 비활성 (${msg}).`,
      );
      visionProvider = null;
    }
    if (!visionProvider) {
      // createVisionProvider 가 null 회수(enabled=false/provider=null 갈래) 또는 throw
      // — VLM 클라이언트 없음. 정직한 비활성(0건 위장 금지 / extractor 선례 정합).
      console.warn(
        "[memory-api] llm.vision.enabled=true + extractor mode='backfill' 인데 VLM 클라이언트 없음 — vision 스케줄러 비활성.",
      );
    } else {
      visionScheduler = startVisionBackfillScheduler(
        store,
        assetStore,
        visionProviderSettings,
        visionProvider,
        {
          intervalMs: visionIntervalMin * 60_000,
          offsetMin: visionOffsetMin,
          batchSize: visionSlot.backfill.batchSize,
          captionPrompt: visionSlot.captionPrompt,
        },
      );
    }
  }
} else {
  console.log(
    "[memory-api] vision backfill scheduler: off (vision.enabled=" +
      String(visionSlot.enabled) +
      ", extractor.mode=" +
      extractorSlot.mode +
      ").",
  );
}

// Phase 7 깊은 패스 Task 4 — 정규식 강화 깊은 패스 스케줄러 (intervalDays 독립 주기).
//   강한 cleanup LLM(extractor 2.4b 와 *별* 모델·슬롯)이 "정규식이 놓친 글"을 묶어
//   새 정규식 양식을 제안한다. extractor·vision 스케줄러와 *별* 주기(일 단위)로 돌고,
//   런타임 골격(startGenericBackfillScheduler)만 공유한다 — 새 setInterval/가드 0.
//
//   cleanup LLM 은 cleanup 슬롯(settings.llm.cleanup)으로 구성한다 — extractor 의
//   ollama 클라이언트를 재사용하지 않는다(강한 모델을 따로 가리키므로). enabled=false
//   면 아예 안 만든다(null).
//
//   가동 조건(데이터 정리 AI 효율 가동 spec 5.B-2 — 게이트 재구성):
//     - cleanupSlot.enabled=true (사용자가 명시 활성화 — API 비용 부담이라 default OFF)
//     - cleanupLlm !== null (LLM 클라이언트 구성 성공)
//     - cleanupSlot.intervalDays >= 1 (하루 미만 주기 금지 — 골격 throw 전에 게이트)
//     - 켜진 단계 1개 이상 (regex·summary·personLink 자기 게이트 중 하나라도 ON)
//   옛 게이트는 regexStrengthen.enabled 를 전체 전제로 요구해 "정규식 OFF + 요약만 ON"
//   조합을 막았다(spec #2 게이트 불일치) — 이제 각 단계가 사이클 안에서 자기 게이트로
//   판단하고, 스케줄러 기동은 슬롯 공통 조건 + 단계 OR 로 정한다(shouldRunCleanupDeepPass
//   단일 출처). 기존에 돌던 조합 동작은 전부 보존. 하나라도 안 켜지면 사유 배열 로그
//   (graceful — 잘못된 자동 데이터 0 / extractor·vision "off" 선례 정합).
let cleanupDeepPassScheduler: BackfillSchedulerHandle | null = null;
// "입력할 때마다"(llm.cleanup.trigger=on_save) 대기열 — 스케줄러가 켜지고 메모 단위 단계가 하나라도 켜졌을 때만 있다.
let memoSavedTrigger: MemoSavedCleanupTrigger | null = null;
// 데이터 초기화는 DB 에 결과를 쓰는 세 스케줄러(추출 백필·이미지 분석 백필·정리 깊은 패스) 중 하나라도 사이클을 돌면
// 409 로 물러난다(routes/cleanup.ts 0단계). 세 변수가 모두 선언된 여기서 얹는다(그 전 closure 는 TDZ). Bun.serve 뒤
// 여기까지 top-level await 가 없어 그 사이 요청이 처리되지 않는다. 나중에 만들어지는 스케줄러도 호출 시점에 본다.
setBackgroundWritersRunning(
  () =>
    scheduler?.isRunning() === true ||
    visionScheduler?.isRunning() === true ||
    cleanupDeepPassScheduler?.isRunning() === true ||
    documentOcrRuntime.isRunning(),
);
const cleanupSlot = settings.llm.cleanup;
const rs = settings.cleanupDeepPass.regexStrengthen;
// spec 5.B-2 — 사람 연결 단계 자기 손잡이(옛 요약 슬롯 차용·토글 부재 해소) + 관계 발굴
// 자동 반영 게이트. personLink.enabled=default true(현행 보존), 두 autoApply 는 신규 설치
// default false / 기존 설치는 migrate-legacy-keys 가 true 로 채운다.
const personLinkSlot = settings.cleanupDeepPass.personLink;
// 데이터 정리 AI 효율 가동 spec 6.C-2 (DCL-4) — 렌즈 소비 단계 손잡이. default OFF
// (유료 + 신규 동작). enabled=true 면 4번째 깊은 패스 단계로 구조화 초안을 만든다.
const lensDraftSlot = settings.cleanupDeepPass.lensDraft;
const relationDiscovery = settings.cleanupDeepPass.relationDiscovery;
// Phase 7 요약 단계 Task 7 — 둘째 단계(요약) 손잡이. 첫 단계 `regexStrengthen` 형제
// (같은 cleanupDeepPass 그룹). atomic 임계·후보 수·관계 엣지 confidence 임계·첫 문단
// fallback 길이는 여기서 단일 출처로 읽어 runSummaryCycle deps 로 넘긴다(하드코딩 0).
const summarySlot = settings.cleanupDeepPass.summary;
const cleanupLlmBuild = cleanupSlot.enabled
  ? buildLlmClientWithReason(cleanupSlot.provider, {
      ...cleanupSlot,
      // 데이터 정리 AI 효율 가동 spec 4.A-8 — cleanup 슬롯의 필드명은
      // requestTimeoutMs(extractor.timeoutMs 와 이름이 달라 LlmClientSlot 의
      // 공통 timeoutMs 칸으로 여기서 매핑). 모든 provider 균일 적용.
      timeoutMs: cleanupSlot.requestTimeoutMs,
    }, "llm.cleanup")
  : { client: null, reason: null };
const cleanupLlm = cleanupLlmBuild.client;
// spec 5.B-2 — 단계별 자기 게이트(요약은 shouldRunSummaryStage, regex 는 강화 토글 + regexL0 가용,
// 나머지는 자기 토글) + 정리 AI 모델 빈칸 검사. 계산은 boot-wiring.ts 한 곳(run API 가능 여부와 공유).
const cleanupGateInput = buildCleanupGateInput(settings, { cleanupLlmAvailable: cleanupLlm !== null, cleanupLlmFailureReason: cleanupLlmBuild.reason, regexAvailable: regexL0 !== undefined });
const { regexStageOn, personLinkStageOn, lensDraftStageOn, entityRegisterStageOn } = cleanupGateInput;
const summaryStageEnabled = cleanupGateInput.summaryStageOn;
if (shouldRunCleanupDeepPass(cleanupGateInput)) {
  // 데이터 정리 AI 효율 가동 spec 4.A-4/4.A-5 — 4단계 모두 단일 실행층(CleanupLlmExecutor)
  // 경유. 게이트(shouldRunCleanupDeepPass)가 cleanupLlmAvailable 로 null 아님을 이미
  // 확정했으나, 타입 좁힘을 위해 여기서 한 번 더 명시 가드한다(도달 불가 — 도달 시 loud
  // fail). 3 구현체가 전부 chatDetailed 를 가지므로 asObservableLlmClient 로 좁힌다.
  // stageVersion 은 stage-constants.ts CLEANUP_STAGE_LLM_LIMITS 가 단일 출처(spec 5.B-3).
  // reliability·budget 값은 T5 에서 설정으로 승격됐으므로 아래 그룹에서 읽는다(하드코딩 0).
  if (cleanupLlm === null) {
    throw new Error(
      "cleanup deep-pass 게이트 통과 후 cleanupLlm 이 null — 게이트 계약 위반(도달 불가).",
    );
  }
  const cleanupObservable = asObservableLlmClient(cleanupLlm);
  const reliability = settings.cleanupDeepPass.reliability;
  const budgetConfig = settings.cleanupDeepPass.budget;

  // spec 5.B-1 — run 원장(cleanup_runs). 수동 run API 와 정기 스케줄 tick 이 한 통로로
  // run 행을 남긴다. 사이클 오케스트레이션(4단계 순차·실행층·예산·요약 로그)은
  // createRunCycle 이 index 인라인 클로저에서 추출해 스케줄러·run API 가 공유한다.
  const cleanupRunsLedger = new CleanupRunsLedger(store.getRawDb());
  const runCycle = createRunCycle({
    store,
    embedder,
    regexL0,
    eventBus,
    cleanupObservable,
    ledger: cleanupRunsLedger,
    budgetConfig,
    reliability,
    regexStage: {
      batchSize: rs.batchSize,
      overmatchThreshold: rs.overmatchThreshold,
      overmatchSampleSize: rs.overmatchSampleSize,
    },
    summaryStage: {
      atomicThreshold: summarySlot.atomicThreshold,
      batchSize: summarySlot.batchSize,
      relationConfidenceThreshold: summarySlot.relationConfidenceThreshold,
      firstParagraphMaxChars: summarySlot.firstParagraphMaxChars,
    },
    personLinkStage: {
      batchSize: personLinkSlot.batchSize,
      autoApply: personLinkSlot.autoApply,
    },
    lensDraftStage: {
      batchSize: lensDraftSlot.batchSize,
    },
    entityRegisterStage: entityRegisterStageConfig(settings),
    relationAutoApply: relationDiscovery.autoApply,
    regexStageOn,
    summaryStageOn: summaryStageEnabled,
    personLinkStageOn,
    lensDraftStageOn,
    entityRegisterStageOn,
  });

  // 스케줄러 runCycle 래퍼 — 수동 run(ctx 존재)은 그대로 통과, 정기 tick(ctx 없음)은
  // 'scheduled' run 행을 먼저 만들어 그 runId 를 실어 넘긴다(spec — 스케줄 실행도 run 행 기록).
  const scheduledRunCycle = async (ctx?: CleanupRunContext): Promise<void> => {
    if (ctx !== undefined) {
      await runCycle(ctx);
      return;
    }
    const started = cleanupRunsLedger.startRun({
      trigger: "scheduled",
      options: {},
    });
    await runCycle({ runId: started.runId });
  };

  cleanupDeepPassScheduler = startCleanupDeepPassScheduler({
    intervalDays: cleanupSlot.intervalDays,
    runCycle: scheduledRunCycle,
  });

  // spec 5.B-1 — run API 배선. 라우트가 이 묶음으로 원장·스케줄러 트리거·취소에 접근한다.
  //   gateReasons: 스케줄러가 기동한 이상 여기 도달하면 게이트는 통과 상태 — 빈 배열.
  //     (스케줄러 자체가 안 켜진 경우는 아래 else 분기라 run API 도 503 로 남는다.)
  //   triggerRun: 스케줄러 handle 의 원자 tryTickNow 위임(정기·수동 겹침 한곳 차단).
  //   registerCancel/cancelRun: runId→AbortController registry(취소 신호 실행층 전파).
  const cancelControllers = new Map<string, AbortController>();
  const runApiHandle = cleanupDeepPassScheduler;
  memoSavedTrigger = buildMemoSavedTrigger({ settings, gate: cleanupGateInput, ledger: cleanupRunsLedger, scheduler: runApiHandle });
  const memoSavedQueue = memoSavedTrigger;
  // 종료된 run 의 controller 를 정리한다(24/7 서버에서 map 무한 증가 차단). 새 run 등록
  // 시점에 원장 status 로 이미 running 이 아닌 항목을 걷어낸다 — 사이클 완료를 여기서
  // await 하지 않으므로(202 non-blocking) 이 지연 정리가 leak 을 막는 통로다.
  const pruneFinishedControllers = (): void => {
    for (const [id] of cancelControllers) {
      if (cleanupRunsLedger.statusOf(id) !== "running") {
        cancelControllers.delete(id);
      }
    }
  };
  const cleanupRunsRouteDeps: CleanupRunsRouteDeps = {
    ledger: cleanupRunsLedger,
    gateReasons: () => [],
    isRunning: () => runApiHandle.isRunning(),
    triggerRun: (ctx) => runApiHandle.tryTickNow(ctx),
    ...(memoSavedQueue ? { onMemoSaved: (id: number) => memoSavedQueue.enqueue(id) } : {}),
    registerCancel: (runId) => {
      pruneFinishedControllers();
      const controller = new AbortController();
      cancelControllers.set(runId, controller);
      return controller.signal;
    },
    cancelRun: (runId) => {
      const controller = cancelControllers.get(runId);
      if (!controller) return false;
      controller.abort();
      cleanupRunsLedger.finishRun({
        runId,
        status: "cancelled",
        aggregates: emptyRunAggregates(),
      });
      return true;
    },
  };
  setCleanupRuns(cleanupRunsRouteDeps);
  // spec 5.B-2 — 세 단계 전부 같은 "가동/off + 사유" 양식으로 한 줄씩 남긴다(정직한
  //   비활성 표시). 옛 사람 연결 단계 고정 "가동" 로그를 다른 단계와 통일했다.
  console.log(
    `[memory-api] cleanup deep-pass 정규식 강화 단계: ${
      regexStageOn
        ? `가동 (batch=${rs.batchSize}, 과매치 컷≥${rs.overmatchThreshold})`
        : `off (${
            !rs.enabled
              ? "cleanupDeepPass.regexStrengthen.enabled=false"
              : "extractor.regex.enabled=false (regexL0 미가용)"
          })`
    }`,
  );
  console.log(
    `[memory-api] cleanup deep-pass 요약 단계: ${
      summaryStageEnabled
        ? `가동 (atomic≥${summarySlot.atomicThreshold}, batch=${summarySlot.batchSize}, 관계엣지 conf≥${summarySlot.relationConfidenceThreshold}, 관계 자동반영=${String(relationDiscovery.autoApply)})`
        : `off (cleanupDeepPass.summary.enabled=${String(summarySlot.enabled)} — 슬롯은 켜졌으나 요약 토글 OFF)`
    }`,
  );
  console.log(
    `[memory-api] cleanup deep-pass 사람 연결 단계: ${
      personLinkStageOn
        ? `가동 (batch=${personLinkSlot.batchSize}, 자동연결=${String(personLinkSlot.autoApply)} conf≥0.9, proposal conf≥0.6)`
        : "off (cleanupDeepPass.personLink.enabled=false)"
    }`,
  );
  console.log(
    `[memory-api] cleanup deep-pass 렌즈 소비 단계: ${
      lensDraftStageOn
        ? `가동 (batch=${lensDraftSlot.batchSize}, 자동적용 0 — 전부 검토 제안)`
        : "off (cleanupDeepPass.lensDraft.enabled=false)"
    }`,
  );
  console.log(`[memory-api] cleanup deep-pass 정리 시점: ${settings.llm.cleanup.trigger}${memoSavedTrigger ? " (입력 직후 정리 가동)" : ""}`);
  console.log(`[memory-api] cleanup deep-pass 항목·일정 자동 등록 단계: ${entityRegisterStageOn ? `가동 (batch=${settings.cleanupDeepPass.entityRegister.batchSize}, 자동등록=${String(settings.cleanupDeepPass.entityRegister.autoApply)})` : "off (cleanupDeepPass.entityRegister.enabled=false)"}`);
} else {
  // 어느 조건이 빠져 안 켜졌는지 사유 배열로 명시(정직한 비활성 — 0건 위장 금지). 게이트
  // 사유는 scheduler-gate.ts 가 단일 출처(run API 409 사유와 같은 함수 — spec 5.B-2/B-1).
  const reasons = cleanupDeepPassGateReasons(cleanupGateInput);
  console.log(
    `[memory-api] cleanup deep-pass scheduler: off (${reasons.join(", ")}).`,
  );
}

// Phase 5.7.3 W6 (2026-05-22) — 신규 두 시스템 출범. 옛 evolver-scheduler
// (setInterval 24h 통합 한 사이클) 통째 폐기 → 이벤트 기반 메모리 자동 정리
// (auto-cleanup-trigger) + 시간 기반 휴지통 cron (trash-manager) 두 갈래
// 분리. 데이터 변동 시점 호출처 (store.addNode / extractor.extractAndStore /
// hashtag wiring / POST /memories / DELETE /memories/:id / updateNodeImportance)
// 가 trigger.emit 으로 신호 송출 → throttle 윈도우 안 silent skip + 윈도우
// 종료 시 한 번만 runAutoCleanup 가동. trashCron 은 매일 새벽 KST cronTime
// 에 가동 → 30일+ archive 영구 삭제 + soonToPurge 계산.
const autoCleanupTrigger: AutoCleanupTriggerHandle = startAutoCleanupTrigger({
  throttleMs: settings.autoCleanup.throttleSeconds * 1000,
  store,
  cleanupOptions: { valueThreshold: settings.autoCleanup.valueThreshold },
  // 반복단어 emerge 운영 배선(Task 4 옵셔널 주입의 실제 연결) — store 는
  // getAllNodes·findOrCreateConcept 를 그대로 노출해 ConceptEmergeStore 를
  // 만족한다. 미주입 시 emerge 단계가 no-op 이었으나, 사용자가 emerge 켜기로
  // 결정해 종료 사이클마다 반복단어 승격이 실제로 돌도록 store 를 주입한다.
  emergeStore: store,
  // 그래프 라이브 연출 2d — emerge 가 진짜 승격한 개념마다 graph_emerge 를 발행한다.
  // trigger 본체가 server-internal(event-bus)에 직접 의존하지 않도록 콜백으로 흘리고,
  // 여기 부팅 배선에서 eventBus.emit 으로 잇는다. eventBus 는 createMemoryApi 가 항상
  // 채워 destructure 로 받지만, 방어로 존재할 때만 배선한다(없으면 emerge no-op 보존).
  onGraphEmerge: eventBus
    ? (sig) => {
        eventBus.emit(EVENT_TYPES.GRAPH_EMERGE, sig);
      }
    : undefined,
  enabled: () => settings.autoCleanup.enabled,
});
// trigger handle 을 데이터 변동 호출처 세 곳에 주입 — store (raw / deleted /
// edited 3 reason) + extractor (atomic / hashtag 2 reason) + server 라우트
// (POST /memories external-sdk-write 1 reason). 같은 handle 공유 = 한
// throttle 윈도우 공유.
store.setAutoCleanupTrigger(autoCleanupTrigger);
if (extractor) extractor.setAutoCleanupTrigger(autoCleanupTrigger);
setAutoCleanupTrigger(autoCleanupTrigger);

const trashCron: TrashCronHandle = startTrashCron({
  cronTime: settings.trashManagement.cronTime,
  store,
  managementOptions: {
    retentionDays: settings.trashManagement.retentionDays,
    warningDays: settings.trashManagement.warningDays,
    // P3 G3-c — events 보존 정리를 archive 정리와 같은 cron 사이클에 합류시킨다.
    // -1(무제한)이면 purgeOldEvents 가 삭제 0(정직한 비활성).
    eventsRetentionDays: settings.events.retentionDays,
  },
  // events 큐 repository 를 정리 표면으로 주입 — 같은 db 위 append/purge 공유.
  eventsStore: eventRepository,
  enabled: () => settings.trashManagement.enabled,
});

console.log(
  `[memory-api] auto-cleanup trigger: enabled=${settings.autoCleanup.enabled}, throttle=${settings.autoCleanup.throttleSeconds}s, valueThreshold=${settings.autoCleanup.valueThreshold}`,
);
console.log(
  `[memory-api] trash cron: enabled=${settings.trashManagement.enabled}, cronTime=${settings.trashManagement.cronTime} ${settings.time.zone}, retention=${settings.trashManagement.retentionDays}d, warn=${settings.trashManagement.warningDays}d, events=${
    settings.events.retentionDays < 0
      ? "무제한"
      : `${settings.events.retentionDays}d`
  }`,
);

// P4 D1 — 서버 내장 백업 cron. 시각 해석은 settings.time.zone(zone-aware) —
// trash cron 의 시스템 TZ 방식과 다르다(backup-cron.ts). 부팅 시 반쪽 회차 청소.
// dbPath=":memory:" 부팅은 스냅샷을 만들 수 없어(파일 DB 전용) cron 등록을
// 건너뛰고 경고 한 줄만 남긴다 — 조용한 no-op 금지.
let backupCron: BackupCronHandle | null = null;
if (dbPath === ":memory:") {
  console.warn("[memory-api] backup cron 미가동 — DB 가 :memory: (파일 DB 전용)");
} else {
  const incompleteRounds = cleanupIncompleteRounds(settings.backup.dir);
  if (incompleteRounds.length > 0) {
    console.warn(
      `[memory-api] backup 반쪽 회차 ${incompleteRounds.length}개 청소: ${incompleteRounds.join(", ")}`,
    );
  }
  backupCron = startBackupCron({
    cronTime: settings.backup.cronTime,
    zone: settings.time.zone,
    enabled: () => settings.backup.enabled,
    retentionDays: settings.backup.retentionDays,
    // settings·비밀값 파일은 설정 읽기·/settings 라우트와 같은 부팅 한 쌍(settingsFiles) — 백업이 따로 고르지 않는다.
    runDeps: () => serverBackupRunDeps({
      db: store.getRawDb(), dbPath, backupDir: settings.backup.dir, assetDir, settingsFiles, sseTokenFilePath,
    }),
  });
  console.log(
    `[memory-api] backup cron: enabled=${settings.backup.enabled}, cronTime=${settings.backup.cronTime} ${settings.time.zone}, retention=${settings.backup.retentionDays}d, dir=${settings.backup.dir}`,
  );
}

// 종료 절차는 SIGINT·SIGTERM(종료 코드 0)과 대시보드 재시작(RESTART_EXIT_CODE — systemd 가 다시 켠다)이 함께 쓴다.
const handleSignal = createGracefulExit({
  log: console.log,
  error: console.error,
  exit: (code) => process.exit(code),
  stop: async () => {
    healthPoller.stop();
    if (scheduler) await scheduler.stop();
    if (visionScheduler) await visionScheduler.stop();
    memoSavedTrigger?.stop();
    if (cleanupDeepPassScheduler) await cleanupDeepPassScheduler.stop();
    await documentOcrRuntime.stop();
    await autoCleanupTrigger.stop();
    trashCron.stop();
    if (backupCron) backupCron.stop();
    server.stop(true);
    shutdown();
  },
});
process.on("SIGINT", () => {
  void handleSignal("SIGINT", 0);
});
process.on("SIGTERM", () => {
  void handleSignal("SIGTERM", 0);
});
