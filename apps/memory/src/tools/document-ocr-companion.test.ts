/**
 * document-ocr-companion.test.ts — OCR companion pull worker contract.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatCompanionError,
  pickupDocumentOcrCompanionToken,
  parseCompanionArgs,
  requestDocumentOcrCompanionTokenApproval,
  runDocumentOcrCompanion,
  runDocumentOcrCompanionOnce,
  type DocumentOcrCompanionConfig,
} from "./document-ocr-companion.ts";
import { MemoryApiError } from "../api-client.ts";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bara-ocr-companion-"));
  createdDirs.push(dir);
  return dir;
}

function makeCandidate() {
  const sha = "d".repeat(64);
  return {
    documentId: "doc_scan",
    title: "scan.pdf",
    documentType: "free",
    chunkCount: 0,
    parse: {
      status: "needs_ocr",
      method: "tier1",
      originalAssetSha256: sha,
      warnings: [],
      lease: {
        workerId: "worker-a",
        claimedAt: "2026-07-01 10:00:00",
        leaseUntil: "2026-07-01 10:30:00",
      },
    },
    originalAssetSha256: sha,
    assetUrl: `/assets/${sha}`,
    assetMimeType: "application/pdf",
    originalName: "scan.pdf",
    createdAt: "2026-07-01 10:00:00",
    updatedAt: "2026-07-01 10:00:00",
  };
}

function baseConfig(tmp: string, command: string[]): DocumentOcrCompanionConfig {
  return {
    baseUrl: "http://memory.local",
    token: "token-a",
    workerId: "worker-a",
    once: true,
    pollSeconds: 1,
    leaseSeconds: 120,
    tmpDir: tmp,
    providerName: "fixture-ocr",
    ocrCommand: command,
    tokenAction: { type: "none" },
  };
}

function installFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function writeScript(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

describe("document OCR companion", () => {
  test("--once 에서 job 없음이면 정상 종료한다", async () => {
    const tmp = tempDir();
    const fetchMock = installFetch((url) => {
      expect(url).toBe("http://memory.local/api/documents/ocr-jobs/claim");
      return new Response(JSON.stringify({ ok: true, job: null }), { status: 200 });
    });
    try {
      const result = await runDocumentOcrCompanionOnce(
        baseConfig(tmp, [process.execPath, join(tmp, "unused.ts")]),
      );
      expect(result).toEqual({ claimed: false });
      expect(fetchMock.calls.length).toBe(1);
    } finally {
      fetchMock.restore();
    }
  });

  test("fixture 명령이 Markdown 을 쓰면 result API 가 호출된다", async () => {
    const tmp = tempDir();
    const script = writeScript(
      tmp,
      "success.ts",
      `
const [inputArg, outputArg, docArg] = Bun.argv.slice(2);
if (inputArg !== process.env.BARA_INPUT_PATH) process.exit(3);
if (outputArg !== process.env.BARA_OUTPUT_MARKDOWN_PATH) process.exit(4);
if (docArg !== process.env.BARA_DOCUMENT_ID) process.exit(5);
const input = await Bun.file(inputArg).text();
await Bun.write(outputArg, "# OCR\\n" + docArg + "\\n" + process.env.BARA_ASSET_SHA256 + "\\n" + input);
`,
    );
    const candidate = makeCandidate();
    const resultBodies: Record<string, unknown>[] = [];
    const fetchMock = installFetch((url, init) => {
      if (url.endsWith("/api/documents/ocr-jobs/claim")) {
        return new Response(JSON.stringify({ ok: true, job: candidate }), { status: 200 });
      }
      if (url.endsWith(`/assets/${candidate.originalAssetSha256}`)) {
        return new Response("PDFDATA", {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      if (url.endsWith("/api/documents/doc_scan/ocr-result")) {
        resultBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            ok: true,
            documentId: "doc_scan",
            assetSha256: "e".repeat(64),
            parse: {},
            chunkCount: 1,
            nodeIds: [1],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const result = await runDocumentOcrCompanionOnce(
        baseConfig(tmp, [process.execPath, script, "{input}", "{output}", "{documentId}"]),
      );
      expect(result).toEqual({ claimed: true, documentId: "doc_scan" });
      const resultBody = resultBodies[0]!;
      expect(resultBody.markdown).toContain("# OCR");
      expect(resultBody.markdown).toContain("doc_scan");
      expect(resultBody.markdown).toContain(candidate.originalAssetSha256);
      expect(resultBody.markdown).toContain("PDFDATA");
      expect(resultBody.source).toBe("companion");
      expect(resultBody.providerName).toBe("fixture-ocr");
      expect(resultBody.workerId).toBe("worker-a");
    } finally {
      fetchMock.restore();
    }
  });

  test("명령 실패 시 failure API 가 호출된다", async () => {
    const tmp = tempDir();
    const script = writeScript(
      tmp,
      "fail.ts",
      `console.error("fixture boom"); process.exit(2);`,
    );
    const candidate = makeCandidate();
    const failureBodies: Record<string, unknown>[] = [];
    const fetchMock = installFetch((url, init) => {
      if (url.endsWith("/api/documents/ocr-jobs/claim")) {
        return new Response(JSON.stringify({ ok: true, job: candidate }), { status: 200 });
      }
      if (url.endsWith(`/assets/${candidate.originalAssetSha256}`)) {
        return new Response("PDFDATA", { status: 200 });
      }
      if (url.endsWith("/api/documents/doc_scan/ocr-failure")) {
        failureBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, documentId: "doc_scan", parse: {} }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const result = await runDocumentOcrCompanionOnce(
        baseConfig(tmp, [process.execPath, script]),
      );
      expect(result).toEqual({ claimed: true, documentId: "doc_scan", failed: true });
      const failureBody = failureBodies[0]!;
      expect(String(failureBody?.errorMessage)).toContain("fixture boom");
      expect(failureBody.source).toBe("companion");
      expect(failureBody.workerId).toBe("worker-a");
    } finally {
      fetchMock.restore();
    }
  });

  test("빈 Markdown 산출도 failure API 로 보고한다", async () => {
    const tmp = tempDir();
    const script = writeScript(
      tmp,
      "empty.ts",
      `await Bun.write(process.env.BARA_OUTPUT_MARKDOWN_PATH, "   ");`,
    );
    const candidate = makeCandidate();
    const failureBodies: Record<string, unknown>[] = [];
    const fetchMock = installFetch((url, init) => {
      if (url.endsWith("/api/documents/ocr-jobs/claim")) {
        return new Response(JSON.stringify({ ok: true, job: candidate }), { status: 200 });
      }
      if (url.endsWith(`/assets/${candidate.originalAssetSha256}`)) {
        return new Response("PDFDATA", { status: 200 });
      }
      if (url.endsWith("/api/documents/doc_scan/ocr-failure")) {
        failureBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, documentId: "doc_scan", parse: {} }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const result = await runDocumentOcrCompanionOnce(
        baseConfig(tmp, [process.execPath, script]),
      );
      expect(result.failed).toBe(true);
      expect(String(failureBodies[0]!.errorMessage)).toContain("empty Markdown");
      expect(String(failureBodies[0]!.errorMessage)).toContain("BARA_OUTPUT_MARKDOWN_PATH");
    } finally {
      fetchMock.restore();
    }
  });

  test("asset 다운로드 실패는 운영자가 확인할 힌트를 failure API 로 보고한다", async () => {
    const tmp = tempDir();
    const candidate = makeCandidate();
    const failureBodies: Record<string, unknown>[] = [];
    const fetchMock = installFetch((url, init) => {
      if (url.endsWith("/api/documents/ocr-jobs/claim")) {
        return new Response(JSON.stringify({ ok: true, job: candidate }), { status: 200 });
      }
      if (url.endsWith(`/assets/${candidate.originalAssetSha256}`)) {
        return new Response(JSON.stringify({ error: "asset not found" }), {
          status: 404,
          statusText: "Not Found",
        });
      }
      if (url.endsWith("/api/documents/doc_scan/ocr-failure")) {
        failureBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, documentId: "doc_scan", parse: {} }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const result = await runDocumentOcrCompanionOnce(
        baseConfig(tmp, [process.execPath, join(tmp, "unused.ts")]),
      );
      expect(result.failed).toBe(true);
      const message = String(failureBodies[0]!.errorMessage);
      expect(message).toContain("원본 자산 다운로드 실패");
      expect(message).toContain("/assets/");
      expect(message).toContain("BARA_MEMORY_TOKEN");
    } finally {
      fetchMock.restore();
    }
  });

  test("parseCompanionArgs 는 옵션과 command 구분자를 해석한다", () => {
    const parsed = parseCompanionArgs(
      [
        "--base-url",
        "http://a1",
        "--token",
        "tok",
        "--worker-id",
        "worker-z",
        "--once",
        "--poll-seconds",
        "5",
        "--lease-seconds",
        "300",
        "--tmp-dir",
        "D:/tmp",
        "--provider-name",
        "local-ocr",
        "--",
        "ocr.exe",
        "{input}",
        "{output}",
      ],
      {},
    );
    expect(parsed.baseUrl).toBe("http://a1");
    expect(parsed.token).toBe("tok");
    expect(parsed.workerId).toBe("worker-z");
    expect(parsed.once).toBe(true);
    expect(parsed.pollSeconds).toBe(5);
    expect(parsed.leaseSeconds).toBe(300);
    expect(parsed.tmpDir).toBe("D:/tmp");
    expect(parsed.providerName).toBe("local-ocr");
    expect(parsed.ocrCommand).toEqual(["ocr.exe", "{input}", "{output}"]);
    expect(parsed.tokenAction).toEqual({ type: "none" });
  });

  test("parseCompanionArgs 는 서버 설정 사용과 원격 명령 opt-in 을 해석한다", () => {
    const parsed = parseCompanionArgs(
      ["--use-server-config", "--allow-remote-command", "--", "local-ocr"],
      {
        BARA_OCR_USE_SERVER_CONFIG: "0",
        BARA_OCR_ALLOW_REMOTE_COMMAND: "0",
      },
    );
    expect(parsed.useServerConfig).toBe(true);
    expect(parsed.allowRemoteCommand).toBe(true);
    expect(parsed.ocrCommand).toEqual(["local-ocr"]);
  });

  test("BARA_OCR_USE_SERVER_CONFIG 는 OCR 명령 없이도 서버 설정을 사용하게 한다", () => {
    const parsed = parseCompanionArgs(["--once"], {
      BARA_MEMORY_TOKEN: "tok",
      BARA_OCR_USE_SERVER_CONFIG: "1",
    });
    expect(parsed.useServerConfig).toBe(true);
    expect(parsed.ocrCommand).toEqual([]);
  });

  test("BARA_OCR_COMMAND_JSON 을 command argv 로 해석한다", () => {
    const parsed = parseCompanionArgs(["--once"], {
      BARA_OCR_COMMAND_JSON: '["python","ocr.py","{input}","{output}"]',
      BARA_MEMORY_TOKEN: "tok",
      BARA_MEMORY_URL: "http://memory",
    });
    expect(parsed.ocrCommand).toEqual(["python", "ocr.py", "{input}", "{output}"]);
    expect(parsed.baseUrl).toBe("http://memory");
  });

  test("-- <command> 가 BARA_OCR_COMMAND_JSON 보다 우선한다", () => {
    const parsed = parseCompanionArgs(
      ["--once", "--", "cli-ocr", "{input}"],
      { BARA_OCR_COMMAND_JSON: '["env-ocr","{output}"]' },
    );
    expect(parsed.ocrCommand).toEqual(["cli-ocr", "{input}"]);
  });

  test("MEMORY_API_URL 은 BARA_MEMORY_URL 이 없을 때 base URL fallback 으로 쓰인다", () => {
    const parsed = parseCompanionArgs(["--", "ocr"], {
      MEMORY_API_URL: "http://memory-from-legacy-env",
    });
    expect(parsed.baseUrl).toBe("http://memory-from-legacy-env");
  });

  test("--request-token 은 OCR 명령 없이도 설정된다", () => {
    const parsed = parseCompanionArgs(["--base-url", "http://a1", "--request-token"], {});
    expect(parsed.tokenAction).toEqual({ type: "request" });
    expect(parsed.baseUrl).toBe("http://a1");
    expect(parsed.ocrCommand).toEqual([]);
  });

  test("--request-token 은 잘못된 BARA_OCR_COMMAND_JSON 을 무시하고 승인 요청만 준비한다", () => {
    const parsed = parseCompanionArgs(["--request-token"], {
      BARA_OCR_COMMAND_JSON: '"not-an-array"',
    });
    expect(parsed.tokenAction).toEqual({ type: "request" });
    expect(parsed.ocrCommand).toEqual([]);
  });

  test("--pickup-token 은 requestId 와 pickupSecret 을 파싱한다", () => {
    const parsed = parseCompanionArgs(["--pickup-token", "atr_1", "secret"], {});
    expect(parsed.tokenAction).toEqual({
      type: "pickup",
      requestId: "atr_1",
      pickupSecret: "secret",
    });
    expect(parsed.ocrCommand).toEqual([]);
  });

  test("빈 env 값은 기본값으로 떨어진다", () => {
    const parsed = parseCompanionArgs(["--", "ocr"], {
      BARA_MEMORY_URL: "",
      MEMORY_API_URL: "",
      BARA_OCR_TMP_DIR: "",
      BARA_OCR_PROVIDER_NAME: "",
    });
    expect(parsed.baseUrl).toBe("http://127.0.0.1:3001");
    expect(parsed.tmpDir.length).toBeGreaterThan(0);
    expect(parsed.providerName).toBe("document-ocr-companion");
  });

  test("OCR 명령 누락 메시지는 env JSON 과 -- command 예시를 안내한다", () => {
    expect(() => parseCompanionArgs([], {})).toThrow(/BARA_OCR_COMMAND_JSON/);
    expect(() => parseCompanionArgs([], {})).toThrow(/-- <command>/);
  });

  test("BARA_OCR_COMMAND_JSON 이 잘못되면 명확히 실패한다", () => {
    expect(() => parseCompanionArgs([], { BARA_OCR_COMMAND_JSON: '"ocr"' })).toThrow(
      /문자열 배열/,
    );
  });

  test("토큰 누락은 protected API 를 호출하기 전에 안내 메시지로 실패한다", async () => {
    const tmp = tempDir();
    let called = false;
    const fetchMock = installFetch(() => {
      called = true;
      return new Response(JSON.stringify({ ok: true, job: null }), { status: 200 });
    });
    try {
      const config = baseConfig(tmp, ["ocr"]);
      config.token = undefined;
      await expect(runDocumentOcrCompanionOnce(config)).rejects.toThrow(/BARA_MEMORY_TOKEN/);
      expect(called).toBe(false);
    } finally {
      fetchMock.restore();
    }
  });

  test("401 오류 메시지는 승인 큐 토큰 발급 흐름을 안내한다", () => {
    const message = formatCompanionError(
      new MemoryApiError(401, "Unauthorized", "memory-api request failed: 401 Unauthorized"),
    );
    expect(message).toContain("BARA_MEMORY_TOKEN");
    expect(message).toContain("--request-token");
    expect(message).toContain("--pickup-token");
  });

  test("claim 401 은 companion once 에서 운영 안내 메시지로 전파된다", async () => {
    const tmp = tempDir();
    const fetchMock = installFetch(() =>
      new Response(JSON.stringify({ error: "인증이 필요합니다." }), {
        status: 401,
        statusText: "Unauthorized",
      }),
    );
    try {
      await expect(runDocumentOcrCompanionOnce(baseConfig(tmp, ["ocr"]))).rejects.toThrow(
        /BARA_MEMORY_TOKEN/,
      );
    } finally {
      fetchMock.restore();
    }
  });

  test("서버 runtime config 는 leaseSeconds/statuses/resourceProfile 을 claim 에 반영한다", async () => {
    const tmp = tempDir();
    const fetchMock = installFetch((url, init) => {
      if (url.endsWith("/api/documents/ocr-runtime-config")) {
        return new Response(
          JSON.stringify({
            ok: true,
            config: {
              mode: "pc_companion",
              resourceProfile: "gpu",
              schedule: {
                intervalMin: 10,
                batchSize: 1,
                leaseSeconds: 240,
                timeoutMs: 600000,
              },
              local: {
                provider: "command",
                ollamaUrl: "",
                ollamaModel: "",
                lmstudioUrl: "",
                lmstudioModel: "",
                commandJson: "",
              },
              api: {
                provider: "http_file_api",
                endpointUrl: "",
                model: "",
                responseFormat: "markdown",
                hasApiKey: false,
              },
              pcCompanion: {
                workerId: "pc-gpu",
                pollSeconds: 9,
                commandSource: "local",
                commandJson: "",
                allowedStatuses: ["needs_ocr", "ocr_failed"],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/documents/ocr-jobs/claim")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          workerId: "worker-a",
          leaseSeconds: 240,
          statuses: ["needs_ocr", "ocr_failed"],
        });
        return new Response(JSON.stringify({ ok: true, job: null }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const result = await runDocumentOcrCompanionOnce({
        ...baseConfig(tmp, ["local-ocr"]),
        useServerConfig: true,
      });
      expect(result).toEqual({ claimed: false });
      expect(fetchMock.calls.map((call) => call.url)).toEqual([
        "http://memory.local/api/documents/ocr-runtime-config",
        "http://memory.local/api/documents/ocr-jobs/claim",
      ]);
    } finally {
      fetchMock.restore();
    }
  });

  test("서버 commandJson 은 명시 opt-in 없이는 실행하지 않는다", async () => {
    const tmp = tempDir();
    const fetchMock = installFetch((url) => {
      expect(url).toBe("http://memory.local/api/documents/ocr-runtime-config");
      return new Response(
        JSON.stringify({
          ok: true,
          config: {
            mode: "pc_companion",
            resourceProfile: "balanced",
            schedule: {
              intervalMin: 10,
              batchSize: 1,
              leaseSeconds: 240,
              timeoutMs: 600000,
            },
            local: {
              provider: "command",
              ollamaUrl: "",
              ollamaModel: "",
              lmstudioUrl: "",
              lmstudioModel: "",
              commandJson: "",
            },
            api: {
              provider: "http_file_api",
              endpointUrl: "",
              model: "",
              responseFormat: "markdown",
              hasApiKey: false,
            },
            pcCompanion: {
              workerId: "pc-gpu",
              pollSeconds: 9,
              commandSource: "server",
              commandJson: '["remote-ocr","{input}","{output}"]',
              allowedStatuses: ["needs_ocr"],
            },
          },
        }),
        { status: 200 },
      );
    });
    try {
      await expect(
        runDocumentOcrCompanionOnce({
          ...baseConfig(tmp, []),
          useServerConfig: true,
        }),
      ).rejects.toThrow(/원격 명령 실행을 허용/);
      expect(fetchMock.calls).toHaveLength(1);
    } finally {
      fetchMock.restore();
    }
  });

  test("opt-in 된 서버 commandJson 은 실행되고 resourceProfile env 를 전달한다", async () => {
    const tmp = tempDir();
    const script = writeScript(
      tmp,
      "server-command.ts",
      `
if (process.env.BARA_OCR_RESOURCE_PROFILE !== "gpu") process.exit(9);
await Bun.write(process.env.BARA_OUTPUT_MARKDOWN_PATH, "# OCR from server command\\n" + process.env.BARA_DOCUMENT_ID);
`,
    );
    const candidate = makeCandidate();
    const resultBodies: Record<string, unknown>[] = [];
    const fetchMock = installFetch((url, init) => {
      if (url.endsWith("/api/documents/ocr-runtime-config")) {
        return new Response(
          JSON.stringify({
            ok: true,
            config: {
              mode: "pc_companion",
              resourceProfile: "gpu",
              schedule: {
                intervalMin: 10,
                batchSize: 1,
                leaseSeconds: 300,
                timeoutMs: 600000,
              },
              local: {
                provider: "command",
                ollamaUrl: "",
                ollamaModel: "",
                lmstudioUrl: "",
                lmstudioModel: "",
                commandJson: "",
              },
              api: {
                provider: "http_file_api",
                endpointUrl: "",
                model: "",
                responseFormat: "markdown",
                hasApiKey: false,
              },
              pcCompanion: {
                workerId: "pc-gpu",
                pollSeconds: 9,
                commandSource: "server",
                commandJson: JSON.stringify([
                  process.execPath,
                  script,
                  "{input}",
                  "{output}",
                  "{documentId}",
                ]),
                allowedStatuses: ["needs_ocr", "ocr_failed"],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/documents/ocr-jobs/claim")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          workerId: "worker-a",
          leaseSeconds: 300,
          statuses: ["needs_ocr", "ocr_failed"],
        });
        return new Response(JSON.stringify({ ok: true, job: candidate }), { status: 200 });
      }
      if (url.endsWith(`/assets/${candidate.originalAssetSha256}`)) {
        return new Response("PDFDATA", {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      if (url.endsWith("/api/documents/doc_scan/ocr-result")) {
        resultBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            ok: true,
            documentId: "doc_scan",
            assetSha256: "e".repeat(64),
            parse: {},
            chunkCount: 1,
            nodeIds: [1],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const result = await runDocumentOcrCompanionOnce({
        ...baseConfig(tmp, []),
        useServerConfig: true,
        allowRemoteCommand: true,
      });
      expect(result).toEqual({ claimed: true, documentId: "doc_scan" });
      expect(resultBodies[0]!.markdown).toContain("# OCR from server command");
    } finally {
      fetchMock.restore();
    }
  });

  test("requestDocumentOcrCompanionTokenApproval 은 adapter-enroll 만 호출한다", async () => {
    const fetchMock = installFetch((url, init) => {
      expect(url).toBe("http://memory.local/adapter-enroll");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        adapterId: "ocr-companion",
      });
      return new Response(
        JSON.stringify({
          status: "pending",
          adapterId: "ocr-companion",
          requestId: "atr_1",
          pickupSecret: "secret",
        }),
        { status: 202 },
      );
    });
    try {
      const result = await requestDocumentOcrCompanionTokenApproval({
        baseUrl: "http://memory.local",
      });
      expect(result).toEqual({
        adapterId: "ocr-companion",
        requestId: "atr_1",
        pickupSecret: "secret",
      });
      expect(fetchMock.calls).toHaveLength(1);
    } finally {
      fetchMock.restore();
    }
  });

  test("pickupDocumentOcrCompanionToken 은 승인된 토큰만 출력 대상으로 반환한다", async () => {
    const fetchMock = installFetch((url) => {
      expect(url).toBe(
        "http://memory.local/adapter-enroll/atr_1/token?pickupSecret=secret",
      );
      return new Response(
        JSON.stringify({
          status: "approved",
          adapterId: "ocr-companion",
          requestId: "atr_1",
          token: "issued-token",
        }),
        { status: 200 },
      );
    });
    try {
      const result = await pickupDocumentOcrCompanionToken({
        baseUrl: "http://memory.local",
        requestId: "atr_1",
        pickupSecret: "secret",
      });
      expect(result).toEqual({ adapterId: "ocr-companion", token: "issued-token" });
      expect(fetchMock.calls).toHaveLength(1);
    } finally {
      fetchMock.restore();
    }
  });

  test("--request-token 은 claim 없이 승인 요청 정보를 출력한다", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      logs.push(String(value));
    };
    const fetchMock = installFetch((url) => {
      expect(url).toBe("http://memory.local/adapter-enroll");
      return new Response(
        JSON.stringify({
          status: "pending",
          adapterId: "ocr-companion",
          requestId: "atr_print",
          pickupSecret: "print-secret",
        }),
        { status: 202 },
      );
    });
    try {
      await runDocumentOcrCompanion({
        ...baseConfig(tempDir(), []),
        tokenAction: { type: "request" },
        baseUrl: "http://memory.local",
        token: undefined,
      });
      expect(logs).toEqual(["requestId=atr_print", "pickupSecret=print-secret"]);
      expect(fetchMock.calls).toHaveLength(1);
    } finally {
      console.log = originalLog;
      fetchMock.restore();
    }
  });

  test("--pickup-token 은 claim 없이 승인된 토큰을 출력한다", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      logs.push(String(value));
    };
    const fetchMock = installFetch(() =>
      new Response(
        JSON.stringify({
          status: "approved",
          adapterId: "ocr-companion",
          requestId: "atr_print",
          token: "picked-token",
        }),
        { status: 200 },
      ),
    );
    try {
      await runDocumentOcrCompanion({
        ...baseConfig(tempDir(), []),
        tokenAction: {
          type: "pickup",
          requestId: "atr_print",
          pickupSecret: "print-secret",
        },
        baseUrl: "http://memory.local",
        token: undefined,
      });
      expect(logs).toEqual(["picked-token"]);
      expect(fetchMock.calls[0]?.url).toBe(
        "http://memory.local/adapter-enroll/atr_print/token?pickupSecret=print-secret",
      );
    } finally {
      console.log = originalLog;
      fetchMock.restore();
    }
  });
});
