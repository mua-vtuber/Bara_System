/**
 * document-ocr-companion-scope.test.ts — WP-B1-15: OCR companion 의 401 vs 403 구분.
 *
 * document-ocr-companion.test.ts 는 이미 800줄 캡에 걸려 있어(공용 규칙: 캡을 넘긴
 * 파일은 키우지 않고 새 작은 모듈로 분리) 이 파일을 새로 둔다. WP-B1-15 의 파일
 * 목록에는 없지만, 캡 규칙이 우선한다("계획 밖 변경"으로 보고).
 *
 * 검증 대상:
 *   - requestDocumentOcrCompanionTokenApproval 이 requestedScope: "full" 을 싣는다.
 *   - formatCompanionError 가 403 을 401 과 구분해 권한 변경 안내를 준다.
 *   - claim 이 403(mcp-standard 토큰 — full 전용 경로)을 받으면 companion once 가
 *     그 안내를 그대로 전파한다.
 *
 * mock 클라이언트 금지 — 실 SseTokenStore + 실 createAuthGate(scope 판정) +
 * Bun.serve 로 완전한 HTTP 서버를 띄운다. /api/documents/ocr-jobs/claim 라우트는
 * 문서 store 전체(SQLite)를 부팅하지 않고 200 을 돌리는 더미 핸들러로 대신한다 —
 * 검증 대상은 그 앞단의 인증/권한 판정(auth-gate)이지 문서 처리 로직이 아니다.
 * auth-gate 는 실제 코드이고 token-scope.ts 의 실제 표(이 경로가 없어 기본 거부)를
 * 그대로 쓰므로, 401/403 응답은 진짜다.
 */

import { Hono } from "hono";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatCompanionError,
  requestDocumentOcrCompanionTokenApproval,
  runDocumentOcrCompanionOnce,
  type DocumentOcrCompanionConfig,
} from "./document-ocr-companion.ts";
import { MemoryApiError } from "../api-client.ts";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { createAuthGate } from "../server-internal/auth-gate.ts";
import { createAdapterTokenRoutes } from "../server-internal/routes/adapter-tokens.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";

/**
 * 실 memory-api 축소판. /api/documents/ocr-jobs/claim 은 인증·권한 판정이 끝난
 * 뒤에만 닿는 더미 200 핸들러(job:null — 실제 문서 store 는 이 테스트의 관심사가
 * 아니다). auth-gate 가 scope 표에서 이 경로를 찾지 못해 mcp-standard 이하 토큰은
 * 항상 403 을 받는다(기본 거부 — token-scope.ts 의 실제 정책).
 */
function startMiniMemoryApi(): {
  url: string;
  store: SseTokenStore;
  stop: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "ocr-companion-scope-"));
  const store = new SseTokenStore(join(dir, "sse-tokens.json"));
  const app = new Hono();
  app.use(
    "*",
    createAuthGate({
      sseTokens: store,
      remoteAddrOf: () => "127.0.0.1",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  app.post("/api/documents/ocr-jobs/claim", (c) => c.json({ ok: true, job: null }));
  const routes = createAdapterTokenRoutes({ sseTokens: store, remoteAddrOf: () => "127.0.0.1" });
  app.route("/", routes);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  return {
    url: `http://127.0.0.1:${server.port}`,
    store,
    stop: () => {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function baseConfig(command: string[]): DocumentOcrCompanionConfig {
  return {
    baseUrl: "http://memory.local",
    token: "token-a",
    workerId: "worker-a",
    once: true,
    pollSeconds: 1,
    leaseSeconds: 120,
    tmpDir: tmpdir(),
    providerName: "fixture-ocr",
    ocrCommand: command,
    tokenAction: { type: "none" },
  };
}

describe("requestDocumentOcrCompanionTokenApproval — requestedScope (WP-B1-15)", () => {
  test("enroll 요청 body 에 requestedScope: full 이 실린다", async () => {
    const api = startMiniMemoryApi();
    try {
      await expect(
        requestDocumentOcrCompanionTokenApproval({ baseUrl: api.url }),
      ).resolves.toHaveProperty("requestId");
      const requests = api.store.listTokenRequests("pending");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.adapterId).toBe("ocr-companion");
      expect(requests[0]!.requestedScope).toBe("full");
    } finally {
      api.stop();
    }
  });
});

describe("formatCompanionError — 401 vs 403 구분 (WP-B1-15)", () => {
  test("401은 토큰 재발급 안내(TOKEN_GUIDANCE), 403은 권한 변경 안내를 준다", () => {
    const unauthorized = formatCompanionError(
      new MemoryApiError(401, "Unauthorized", "memory-api request failed: 401 Unauthorized"),
    );
    expect(unauthorized).toContain("401");
    expect(unauthorized).toContain("BARA_MEMORY_TOKEN");
    expect(unauthorized).not.toContain("full");

    const forbidden = formatCompanionError(
      new MemoryApiError(403, "Forbidden", "memory-api request failed: 403 Forbidden"),
    );
    expect(forbidden).toContain("403");
    expect(forbidden).toContain("full");
    expect(forbidden).toContain("어댑터 관리");
    // 403 안내는 401 안내(BARA_MEMORY_TOKEN 재발급 절차)를 반복하지 않는다 — 조치가
    // "토큰 재발급"이 아니라 "권한 변경"이라 다른 문구가 맞다.
    expect(forbidden).not.toContain("BARA_MEMORY_TOKEN");
  });
});

describe("claim 403 — companion once 가 권한 부족 안내를 그대로 전파한다 (WP-B1-15)", () => {
  test("mcp-standard 토큰으로 claim 하면 403 을 받아 formatCompanionError 안내로 실패한다", async () => {
    const api = startMiniMemoryApi();
    try {
      const token = api.store.issueToken("ocr-companion", undefined, undefined, "mcp-standard");
      const config = { ...baseConfig(["ocr"]), baseUrl: api.url, token };

      await expect(runDocumentOcrCompanionOnce(config)).rejects.toThrow(/403/);
      await expect(runDocumentOcrCompanionOnce(config)).rejects.toThrow(/full/);
    } finally {
      api.stop();
    }
  });

  test("full 토큰(레거시 scope 없음 포함)으로 claim 하면 성공한다(운영 companion 무변화)", async () => {
    const api = startMiniMemoryApi();
    try {
      // scope 인자 생략 = 레거시 옛 토큰과 동일하게 full 로 해석된다(WP-B1-13 계약).
      const token = api.store.issueToken("ocr-companion");
      const config = { ...baseConfig(["ocr"]), baseUrl: api.url, token };

      const result = await runDocumentOcrCompanionOnce(config);
      expect(result).toEqual({ claimed: false });
    } finally {
      api.stop();
    }
  });
});
