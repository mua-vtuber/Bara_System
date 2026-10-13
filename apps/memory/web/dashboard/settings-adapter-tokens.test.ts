/**
 * settings-adapter-tokens.test.ts — 어댑터 토큰 승인·권한 화면 통합 테스트 (WP-B1-14).
 *
 * 권위: docs/decisions/2026-09-27-audit-fix-plan-memory-core.md WP-B1-14.
 *
 * 검증 정신: 실제 memory API(Bun.serve, 실 SQLite·실 SseTokenStore·실 인증
 * 게이트)를 loopback 에 띄우고, dashboard 쪽 apiFetch 의 상대경로 호출을 그
 * 서버 base 로 재작성하는 fetch 프록시를 깐 뒤, happy-dom DOM 위에서 패널을
 * 렌더링해 실 HTTP 로 승인·거절·회수·권한 변경을 검증한다. mock 클래스 0
 * (CLAUDE.md 테스트 정책) — installFetchMock 응답 대체 방식(옛 settings.test.ts)
 * 은 새 계약(requestedScope·existingAdapter·scope·legacyScope)의 권한 로직
 * 자체를 검증하지 못해 여기서는 쓰지 않는다.
 *
 * 서버 조립은 src/server-internal/routes/events.test.ts 의
 * "GET /events/stream — 토큰 회수·교체·권한 변경 즉시 반영 (SA-6)" 블록과
 * src/server-internal/routes/adapter-tokens.test.ts 의 guardedApp 패턴을
 * 그대로 따른다: 인증 게이트 → 어댑터 토큰 라우트 → events 라우트(대시보드가
 * /dashboard/sse-token 으로 부트스트랩 토큰을 교환하는 통로) 순서.
 *
 * events 테이블은 sqlite-vec 와 무관한 일반 테이블이라 openMemoryDatabase 를
 * 우회해 :memory: DB 에 DDL 만 적용한다(events.test.ts 의 openEventsOnlyDb
 * 선례) — 로컬에서도 vec0.so 미스매치 없이 실 SQLite 로 검증된다.
 */

import "../../test-setup-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { EventRepository } from "../../src/db/store-internal/event-repository";
import { EventBus } from "../../src/server-internal/event-bus";
import { SseTokenStore } from "../../src/federation/sse-tokens";
import { MEMORY_DEFAULTS } from "../../src/settings/memory-defaults";
import { createAuthGate } from "../../src/server-internal/auth-gate";
import { registerAdapterTokenRoutes } from "../../src/server-internal/routes/adapter-tokens";
import { registerEventsRoutes } from "../../src/server-internal/routes/events";
import { _resetTokenCacheForTest } from "./api-fetch";
import {
  createAdapterTokenManagementApi,
  renderAdapterRequestRow,
  renderAdapterTokenManagementPanel,
  type AdapterTokenRequestDTO,
} from "./settings-adapter-tokens";

/** events DDL 만 가진 :memory: DB — events.test.ts openEventsOnlyDb 선례. */
function openEventsOnlyDb(): Database {
  const d = new Database(":memory:");
  d.exec(
    `CREATE TABLE events (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       type         TEXT NOT NULL,
       payload_json TEXT NOT NULL,
       created_at   TEXT NOT NULL DEFAULT (datetime('now'))
     );`,
  );
  return d;
}

interface RunningServer {
  base: string;
  stop: () => void;
}

/** 운영 조립 순서(인증 게이트 → 어댑터 토큰 라우트 → events 라우트)를 실 loopback HTTP 로 띄운다. */
function startMemoryApiServer(sseTokens: SseTokenStore, db: Database): RunningServer {
  const eventRepository = new EventRepository(db);
  const eventBus = new EventBus(eventRepository);

  const app = new Hono({ strict: false });
  app.use(
    "*",
    createAuthGate({
      sseTokens,
      remoteAddrOf: () => "127.0.0.1",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  registerAdapterTokenRoutes(app, { sseTokens, remoteAddrOf: () => "10.0.0.8" });
  registerEventsRoutes(app, { eventBus, eventRepository, sseTokens });

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/**
 * apiFetch(상대경로 "/adapter-tokens" 등)가 실제로는 이 origin 이 아닌 곳으로
 * 나가야 하는 브라우저 전제와 달리, Bun 의 네이티브 fetch 는 window.location 을
 * base 로 상대경로를 해석하지 않는다(직접 실측 확인). 그래서 절대경로가 아닌
 * 요청만 서버 base 로 재작성하는 프록시를 깐다 — dashboard 소스는 건드리지
 * 않고 테스트 하니스에서만 처리(실 HTTP 자체는 그대로 진짜로 나간다).
 */
function installRelativeFetchProxy(base: string): () => void {
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const absolute = url.startsWith("/") ? `${base}${url}` : url;
    return original(absolute, init);
  }) as typeof fetch;
  return () => {
    (globalThis as { fetch: typeof fetch }).fetch = original;
  };
}

async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

let tokenDir: string;
let sseTokens: SseTokenStore;
let db: Database;
let server: RunningServer;
let restoreFetch: () => void;

beforeEach(() => {
  _resetTokenCacheForTest();
  document.body.textContent = "";

  tokenDir = mkdtempSync(join(tmpdir(), "bara-adapter-panel-"));
  sseTokens = new SseTokenStore(join(tokenDir, "sse-tokens.json"));
  db = openEventsOnlyDb();
  server = startMemoryApiServer(sseTokens, db);
  restoreFetch = installRelativeFetchProxy(server.base);

  // 대시보드 부트스트랩 토큰 — apiFetch 가 /dashboard/sse-token 교환에 쓴다.
  // full 권한 토큰이어야 승인·권한 변경(PATCH)이 auth-gate 를 통과한다.
  const dashboardToken = sseTokens.issueToken("dashboard");
  window.sessionStorage.setItem("bara.dashboard.token", dashboardToken);
});

afterEach(() => {
  restoreFetch();
  server.stop();
  db.close();
  if (existsSync(tokenDir)) rmSync(tokenDir, { recursive: true, force: true });
  _resetTokenCacheForTest();
  document.body.textContent = "";
});

/** 어댑터 등록 요청을 실 서버에 만든다(POST /adapter-enroll, 공개 경로). */
async function enroll(
  adapterId: string,
  options: { displayName?: string; description?: string; requestedScope?: string } = {},
): Promise<{ requestId: string }> {
  const res = await fetch(`${server.base}/adapter-enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adapterId,
      displayName: options.displayName ?? adapterId,
      description: options.description,
      endpoint: "http://127.0.0.1:3100",
      requestedScope: options.requestedScope,
    }),
  });
  expect(res.status).toBe(202);
  return (await res.json()) as { requestId: string };
}

describe("renderAdapterTokenManagementPanel — 승인 대기 요청 표시 (WP-B1-14)", () => {
  test("요청 권한과 기존 어댑터 없음을 표시하고 토큰 값은 노출하지 않는다", async () => {
    await enroll("bot-discord", {
      displayName: "디스코드 봇",
      description: "Discord reference adapter",
      requestedScope: "full",
    });

    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks();

    const text = document.body.textContent ?? "";
    expect(text).toContain("디스코드 봇");
    expect(text).toContain("bot-discord");
    // 디스코드 어댑터의 옛 영문 설명이 한글 설명으로 바뀌어 보인다(adapterDescription).
    expect(text).toContain("디스코드 메시지를 메모리에 저장하는 기본 연결 앱입니다.");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("Discord reference adapter");

    // requestedScope=full 은 기본 선택이 없다(SA-3) — 승인 버튼이 비활성.
    const approveBtn = document.querySelector(".adapter-token-primary") as HTMLButtonElement;
    expect(approveBtn).toBeTruthy();
    expect(approveBtn.disabled).toBe(true);
    expect(text).toContain("전체 관리");
  });

  test("requestedScope 가 mcp-standard 면 그 값이 기본 선택되어 승인 버튼이 즉시 켜진다", async () => {
    await enroll("ocr-companion", { requestedScope: "mcp-standard" });
    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks();

    const approveBtn = document.querySelector(".adapter-token-primary") as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(false);
    const scopeSelect = document.querySelector(".adapter-token-scope-select") as HTMLSelectElement;
    expect(scopeSelect.value).toBe("mcp-standard");
  });

  test("requestedScope 가 없으면 mcp-standard 가 기본 선택된다", async () => {
    await enroll("no-scope-adapter");
    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks();

    const scopeSelect = document.querySelector(".adapter-token-scope-select") as HTMLSelectElement;
    expect(scopeSelect.value).toBe("mcp-standard");
    expect(document.body.textContent).toContain("요청한 권한 없음");
  });
});

describe("renderAdapterTokenManagementPanel — 승인 → scope 가 approve body 에 실린다 (CR-0)", () => {
  test("전체 관리를 직접 고른 뒤 승인하면 실 서버가 full 토큰을 발급한다", async () => {
    await enroll("bot-discord", { requestedScope: "full" });
    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks();

    const scopeSelect = document.querySelector(".adapter-token-scope-select") as HTMLSelectElement;
    scopeSelect.value = "full";
    scopeSelect.dispatchEvent(new Event("change"));
    await flushMicrotasks();

    const approveBtn = document.querySelector(".adapter-token-primary") as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(false);
    approveBtn.click();
    await flushMicrotasks(6);

    expect(document.body.textContent).toContain("승인 대기 중인 어댑터 없음");
    expect(document.body.textContent).toContain("bot-discord");
    expect(sseTokens.getTokenScope("bot-discord")).toBe("full");
    // 발급 행에 현재 권한 배지가 뜬다.
    expect(document.body.textContent).toContain("현재 권한");
    expect(document.body.textContent).toContain("전체 관리");
  });

  test("mcp-standard 기본 선택 그대로 승인하면 실 서버가 mcp-standard 토큰을 발급한다", async () => {
    await enroll("ocr-companion", { requestedScope: "mcp-standard" });
    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks();

    const approveBtn = document.querySelector(".adapter-token-primary") as HTMLButtonElement;
    approveBtn.click();
    await flushMicrotasks(6);

    expect(sseTokens.getTokenScope("ocr-companion")).toBe("mcp-standard");
  });
});

describe("renderAdapterTokenManagementPanel — 기존 어댑터 재등록 경고와 공유/교체 (SA-2)", () => {
  test("이미 토큰이 발급된 adapterId 재등록 요청에 경고와 공유/교체 선택이 뜬다", async () => {
    sseTokens.issueToken("bot-discord", undefined, undefined, "mcp-standard");
    await enroll("bot-discord", { requestedScope: "full" });

    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks();

    const text = document.body.textContent ?? "";
    expect(text).toContain("이미 연결된 어댑터");
    expect(text).toContain("표준");
    expect(document.querySelector(".adapter-token-existing-choice")).toBeTruthy();
  });

  test("공유 승인(existingToken 생략)은 기존 토큰을 그대로 유지한다", async () => {
    const existingToken = sseTokens.issueToken("bot-discord", undefined, undefined, "mcp-standard");
    await enroll("bot-discord", { requestedScope: "mcp-standard" });

    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks();

    const approveBtn = document.querySelector(".adapter-token-primary") as HTMLButtonElement;
    // 기본 선택 = share, mcp-standard 기본 scope.
    approveBtn.click();
    await flushMicrotasks(6);

    expect(sseTokens.verifyToken(existingToken)).toBe("bot-discord");
    expect(sseTokens.getTokenScope("bot-discord")).toBe("mcp-standard");
  });

  test("토큰 교체(rotate)를 고르고 승인하면 옛 토큰이 무효화된다", async () => {
    const oldToken = sseTokens.issueToken("bot-discord", undefined, undefined, "mcp-standard");
    await enroll("bot-discord", { requestedScope: "mcp-standard" });

    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks();

    const choiceSelect = document.querySelector(".adapter-token-existing-choice") as HTMLSelectElement;
    choiceSelect.value = "rotate";
    choiceSelect.dispatchEvent(new Event("change"));
    await flushMicrotasks();

    const approveBtn = document.querySelector(".adapter-token-primary") as HTMLButtonElement;
    approveBtn.click();
    await flushMicrotasks(6);

    expect(sseTokens.verifyToken(oldToken)).toBeNull();
    expect(sseTokens.getTokenScope("bot-discord")).toBe("mcp-standard");
  });
});

describe("renderAdapterTokenManagementPanel — 발급 행 권한 표시·변경 (SA-3)", () => {
  test("옛 토큰(scope 미지정)은 발급 행에 legacyScope 안내와 함께 full 로 표시된다", async () => {
    sseTokens.issueToken("legacy-adapter");
    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks();

    const text = document.body.textContent ?? "";
    expect(text).toContain("legacy-adapter");
    expect(text).toContain("권한 미지정 옛 토큰 = full");
  });

  test("권한 변경 선택 + 적용은 실 서버에 PATCH 를 보내고 목록을 갱신한다", async () => {
    sseTokens.issueToken("ocr-companion", undefined, undefined, "mcp-standard");
    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks();

    const scopeSelect = document.querySelector(
      ".adapter-token-row--issued .adapter-token-scope-select",
    ) as HTMLSelectElement;
    scopeSelect.value = "read-only";
    scopeSelect.dispatchEvent(new Event("change"));
    await flushMicrotasks();

    const applyBtn = Array.from(
      document.querySelectorAll(".adapter-token-row--issued .adapter-token-secondary"),
    ).find((el) => el.textContent === "권한 변경 적용") as HTMLButtonElement;
    expect(applyBtn).toBeTruthy();
    applyBtn.click();
    await flushMicrotasks(6);

    expect(sseTokens.getTokenScope("ocr-companion")).toBe("read-only");
    expect(document.body.textContent).toContain("읽기 전용");
  });
});

describe("renderAdapterTokenManagementPanel — 서버 오류를 원인 그대로 표시 (silent 실패 금지)", () => {
  test("목록 조회가 인증 실패하면 화면에 오류 원인이 남는다", async () => {
    // 부트스트랩 토큰을 무효한 값으로 덮어써 /dashboard/sse-token 자체가 401 을 내게 한다.
    window.sessionStorage.setItem("bara.dashboard.token", "invalid-token-value");
    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks(6);

    const text = document.body.textContent ?? "";
    expect(text).toContain("오류");
    expect(text).not.toBe("");
  });
});

/** showToast 가 만드는 토스트 호스트에서 텍스트를 읽는다(form/toast.ts ensureHost). */
function toastTexts(): string[] {
  return Array.from(document.querySelectorAll(".form-toast-error")).map(
    (el) => el.textContent ?? "",
  );
}

describe("createAdapterTokenButton — 버튼 액션 실패를 토스트로 표시 (QA 후속, 21e08068)", () => {
  // 옛 코드는 onClick 을 try/finally 로만 감싸 catch 가 없었다 — 승인·거절·
  // 회수·권한 변경이 실패하면 unhandled rejection 이 되어 화면에 아무것도
  // 안 남았다. 아래는 각 액션에서 실 서버가 409/404 를 내는 상황을 만들어
  // 그 오류 문구가 토스트로 뜨는지 검증한다.

  test("승인 — 화면엔 아직 pending 인데 서버에서 이미 거절 처리된 요청을 승인하면 409 오류가 토스트로 뜬다", async () => {
    const { requestId } = await enroll("bot-discord", { requestedScope: "mcp-standard" });
    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks();

    // 화면을 그리고 난 뒤, 다른 관리자가 같은 요청을 먼저 거절했다고 가정한다
    // (실 서버 상태를 직접 바꿔 stale 화면을 재현 — UI 는 갱신 전이라 여전히
    // 승인 버튼이 떠 있다).
    sseTokens.rejectTokenRequest(requestId);

    const approveBtn = document.querySelector(".adapter-token-primary") as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(false);
    approveBtn.click();
    await flushMicrotasks(6);

    const toasts = toastTexts();
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts.some((t) => t.includes("거절된 어댑터 토큰 요청은 승인할 수 없다"))).toBe(true);
    // 버튼은 finally 에서 다시 활성화된다 — 재시도 가능해야 한다.
    expect(approveBtn.disabled).toBe(false);
  });

  test("거절 — 서버에 존재하지 않는 요청을 거절하면 404 오류가 토스트로 뜬다", async () => {
    // SseTokenStore 에는 요청을 완전히 지우는 API가 없다(rejectTokenRequest는
    // 상태와 무관하게 항상 성공한다) — 그래서 "요청이 삭제됐다"는 상황을
    // requestId 자체가 존재하지 않는 순수 데이터 fixture 로 재현한다.
    // renderAdapterRequestRow 를 직접 호출(export, QA 후속)해 실제 API·실제
    // 서버로 거절을 시도하면 route(adapter-tokens.ts:215)가 그대로 404 를
    // 낸다 — mock 없이 실 HTTP 로 검증.
    const fixture: AdapterTokenRequestDTO = {
      requestId: "atr_does_not_exist",
      adapterId: "ocr-companion",
      displayName: "OCR",
      description: "",
      endpoint: "",
      remoteAddr: "",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      approvedAt: null,
      rejectedAt: null,
      requestedScope: "mcp-standard",
      existingAdapter: null,
    };
    const api = createAdapterTokenManagementApi();
    document.body.appendChild(renderAdapterRequestRow(fixture, api, async () => {}));
    await flushMicrotasks();

    const rejectBtn = document.querySelector(".adapter-token-secondary") as HTMLButtonElement;
    expect(rejectBtn.textContent).toBe("거절");
    rejectBtn.click();
    await flushMicrotasks(6);

    const toasts = toastTexts();
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts.some((t) => t.includes("찾을 수 없"))).toBe(true);
    expect(rejectBtn.disabled).toBe(false);
  });

  test("권한 변경 — 서버에서 이미 회수된 어댑터에 PATCH 를 보내면 404 오류가 토스트로 뜬다", async () => {
    sseTokens.issueToken("ocr-companion", undefined, undefined, "mcp-standard");
    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks();

    // 화면을 그린 뒤 다른 경로로 토큰이 먼저 회수됐다고 가정한다.
    sseTokens.removeToken("ocr-companion");

    const applyBtn = Array.from(
      document.querySelectorAll(".adapter-token-row--issued .adapter-token-secondary"),
    ).find((el) => el.textContent === "권한 변경 적용") as HTMLButtonElement;
    expect(applyBtn).toBeTruthy();
    applyBtn.click();
    await flushMicrotasks(6);

    const toasts = toastTexts();
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts.some((t) => t.includes("찾을 수 없"))).toBe(true);
    expect(applyBtn.disabled).toBe(false);
  });

  test("회수 — 서버에서 이미 회수된 어댑터를 다시 회수하면 404 오류가 토스트로 뜬다", async () => {
    sseTokens.issueToken("bot-discord", undefined, undefined, "mcp-standard");
    document.body.appendChild(renderAdapterTokenManagementPanel());
    await flushMicrotasks();

    sseTokens.removeToken("bot-discord");

    const revokeBtn = document.querySelector(".adapter-token-danger") as HTMLButtonElement;
    expect(revokeBtn.textContent).toBe("토큰 회수");
    revokeBtn.click();
    await flushMicrotasks(6);

    const toasts = toastTexts();
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts.some((t) => t.includes("찾을 수 없"))).toBe(true);
    expect(revokeBtn.disabled).toBe(false);
  });
});
