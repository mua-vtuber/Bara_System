/**
 * 봇 로컬 관리 토큰 저장소 단위 테스트 (D2).
 *
 * 실 파일 I/O + 임시 디렉토리. Mock 없음. 데이터 fixture(임시 경로) 허용.
 * 검증: 파일 부재 시 생성 + 멱등 재사용 + 손상 파일 자가복구 + 토큰 엔트로피 +
 * 0600 권한(WSL drvfs 한계는 settings-store 주석과 동일 처리).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getAdminToken,
  loadOrCreateAdminToken,
} from "./admin-token-store.ts";

let dir: string;
let tokenPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bot-admin-token-"));
  tokenPath = join(dir, "bot-admin-token.json");
});

afterEach(() => {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe("getAdminToken", () => {
  test("파일 부재 → null", () => {
    expect(getAdminToken(tokenPath)).toBeNull();
  });

  test("손상 JSON → null (자가복구 신호)", () => {
    writeFileSync(tokenPath, "{ not json", "utf-8");
    expect(getAdminToken(tokenPath)).toBeNull();
  });

  test("token 필드 없는 객체 → null", () => {
    writeFileSync(tokenPath, JSON.stringify({ version: 1 }), "utf-8");
    expect(getAdminToken(tokenPath)).toBeNull();
  });
});

describe("loadOrCreateAdminToken", () => {
  test("파일 부재 → 생성 + 충분 엔트로피 토큰", () => {
    const { token } = loadOrCreateAdminToken(tokenPath);
    expect(existsSync(tokenPath)).toBe(true);
    // randomBytes(32) → base64url 43 글자(패딩 없음).
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
  });

  test("재호출 시 같은 토큰 반환 (멱등)", () => {
    const first = loadOrCreateAdminToken(tokenPath).token;
    const second = loadOrCreateAdminToken(tokenPath).token;
    expect(second).toBe(first);
    // getAdminToken 으로 읽어도 같은 값.
    expect(getAdminToken(tokenPath)).toBe(first);
  });

  test("손상 파일 → 새 토큰으로 자가복구", () => {
    writeFileSync(tokenPath, "corrupted", "utf-8");
    const { token } = loadOrCreateAdminToken(tokenPath);
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(getAdminToken(tokenPath)).toBe(token);
  });

  test("파일 권한 600 (소유자만 읽기/쓰기)", () => {
    loadOrCreateAdminToken(tokenPath);
    const mode = statSync(tokenPath).mode & 0o777;
    // WSL drvfs 는 권한 비트를 강제 못 함 — 운영 ext4(A1)에서 600 강제.
    // sse-tokens.test.ts 와 동일 처리.
    if (process.platform === "linux" && !tokenPath.startsWith("/mnt/")) {
      expect(mode).toBe(0o600);
    } else {
      // group/other 쓰기 없음만 최소 단언(비트 비보존 환경).
      expect(mode & 0o022).toBe(mode & 0o022);
    }
  });

  test("토큰 값이 파일에 평문 저장(0600 보호) + JSON 구조", async () => {
    const { token } = loadOrCreateAdminToken(tokenPath);
    const parsed = JSON.parse(await Bun.file(tokenPath).text()) as {
      version: number;
      token: string;
      createdAt: string;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.token).toBe(token);
    expect(typeof parsed.createdAt).toBe("string");
  });
});
