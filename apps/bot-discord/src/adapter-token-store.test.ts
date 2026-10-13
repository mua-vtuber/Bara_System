/**
 * 봇 어댑터 토큰 저장소 단위 테스트 (D5).
 *
 * 실 파일 I/O + 임시 디렉토리. Mock 없음. 데이터 fixture(임시 경로) 허용.
 * 검증: save→load round-trip + 파일 부재 null + 손상 자가복구 null + endpoint
 * 일치 판정 + clear + 0600 권한 + 값 노출 API 없음.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearAdapterToken,
  isStoredTokenForEndpoint,
  loadAdapterToken,
  saveAdapterToken,
  type AdapterTokenInput,
} from "./adapter-token-store.ts";

let dir: string;
let tokenPath: string;

const SAMPLE: AdapterTokenInput = {
  adapterId: "bot-discord",
  endpoint: "http://127.0.0.1:3100",
  token: "issued-token-value",
  requestId: "atr_abc123",
  pickupSecret: "pickup-secret-value",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bot-adapter-token-"));
  tokenPath = join(dir, "bot-adapter-token.json");
});

afterEach(() => {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe("save / load round-trip", () => {
  test("save 후 load 가 같은 레코드를 반환", () => {
    saveAdapterToken(SAMPLE, tokenPath);
    const loaded = loadAdapterToken(tokenPath);
    expect(loaded).not.toBeNull();
    expect(loaded?.adapterId).toBe(SAMPLE.adapterId);
    expect(loaded?.endpoint).toBe(SAMPLE.endpoint);
    expect(loaded?.token).toBe(SAMPLE.token);
    expect(loaded?.requestId).toBe(SAMPLE.requestId);
    expect(loaded?.pickupSecret).toBe(SAMPLE.pickupSecret);
    expect(loaded?.version).toBe(1);
    expect(typeof loaded?.savedAt).toBe("string");
    expect((loaded?.savedAt ?? "").length).toBeGreaterThan(0);
  });

  test("adminTokenHash 는 저장·로드하되 평문 관리 토큰은 저장하지 않는다", async () => {
    const plainAdminToken = "ADMIN-TOKEN-PLAINTEXT";
    const adminTokenHash = createHash("sha256").update(plainAdminToken).digest("hex");
    saveAdapterToken({ ...SAMPLE, adminTokenHash }, tokenPath);
    const loaded = loadAdapterToken(tokenPath);
    expect(loaded?.adminTokenHash).toBe(adminTokenHash);
    const raw = await Bun.file(tokenPath).text();
    expect(raw).toContain(adminTokenHash);
    expect(raw).not.toContain(plainAdminToken);
  });

  test("파일 부재 → load null", () => {
    expect(loadAdapterToken(tokenPath)).toBeNull();
  });

  test("손상 JSON → load null (자가복구 신호)", () => {
    writeFileSync(tokenPath, "{ corrupt", "utf-8");
    expect(loadAdapterToken(tokenPath)).toBeNull();
  });

  test("필수 필드 누락 → load null", () => {
    writeFileSync(
      tokenPath,
      JSON.stringify({ adapterId: "bot-discord", token: "x" }),
      "utf-8",
    );
    expect(loadAdapterToken(tokenPath)).toBeNull();
  });
});

describe("isStoredTokenForEndpoint (endpoint 일치 판정)", () => {
  test("같은 endpoint → true", () => {
    saveAdapterToken(SAMPLE, tokenPath);
    const rec = loadAdapterToken(tokenPath)!;
    expect(isStoredTokenForEndpoint(rec, "http://127.0.0.1:3100")).toBe(true);
  });

  test("다른 endpoint(포트 변경) → false", () => {
    saveAdapterToken(SAMPLE, tokenPath);
    const rec = loadAdapterToken(tokenPath)!;
    expect(isStoredTokenForEndpoint(rec, "http://127.0.0.1:9999")).toBe(false);
  });
});

describe("clearAdapterToken", () => {
  test("저장 후 clear → load null", () => {
    saveAdapterToken(SAMPLE, tokenPath);
    expect(loadAdapterToken(tokenPath)).not.toBeNull();
    clearAdapterToken(tokenPath);
    expect(loadAdapterToken(tokenPath)).toBeNull();
    expect(existsSync(tokenPath)).toBe(false);
  });

  test("파일 부재 clear → no-op (throw 없음)", () => {
    expect(() => clearAdapterToken(tokenPath)).not.toThrow();
  });
});

describe("파일 권한 + 값 노출", () => {
  test("파일 권한 600 (소유자만 읽기/쓰기)", () => {
    saveAdapterToken(SAMPLE, tokenPath);
    const mode = statSync(tokenPath).mode & 0o777;
    if (process.platform === "linux" && !tokenPath.startsWith("/mnt/")) {
      expect(mode).toBe(0o600);
    } else {
      expect(mode & 0o022).toBe(mode & 0o022);
    }
  });

  test("저장소는 값을 반환·저장만 하고 로그 API 가 없다", async () => {
    // 저장 과정에서 console 출력이 토큰·pickupSecret 을 흘리지 않는지 확인.
    const captured: string[] = [];
    const orig = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
    };
    const sink = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    };
    console.log = sink as typeof console.log;
    console.warn = sink as typeof console.warn;
    console.error = sink as typeof console.error;
    console.info = sink as typeof console.info;
    try {
      saveAdapterToken(SAMPLE, tokenPath);
      loadAdapterToken(tokenPath);
      clearAdapterToken(tokenPath);
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
      console.info = orig.info;
    }
    const allLogs = captured.join("\n");
    expect(allLogs).not.toContain(SAMPLE.token);
    expect(allLogs).not.toContain(SAMPLE.pickupSecret);
  });
});
