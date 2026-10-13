/**
 * 봇 로컬 관리 토큰 저장소 (D2).
 *
 * 권위: docs/decisions/2026-07-02-adapter-auth-spec.md section 3.2 / 4.1
 *
 * 봇 :3100 의 상태변경·민감읽기 경로(PUT /settings, GET /settings, /actions/*)는
 * 이 토큰을 Authorization: Bearer 로 요구한다(http-admin-gate.ts). 같은 PC 의 다른
 * 프로세스나 브라우저發 요청이 소유자 설정을 읽거나 memoryApiUrl 을 탈취하지
 * 못하게 막는다.
 *
 * 토큰은 부팅 시 probe 해 없으면 생성(랜덤 32 bytes base64url)하고 0600 파일로
 * 영속한다. settings-store.ts 의 atomic write(tmp + rename) + chmod 600 패턴을
 * 답습한다. 토큰 값은 로그·응답·에러에 절대 넣지 않는다.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { botDataPath } from "./data-dir.ts";

/** 관리 토큰 보관 파일 이름. 폴더는 botDataPath 가 정한다(BARA_ADAPTER_DATA_DIR 또는 data/). */
const FILE_NAME = "bot-admin-token.json";

/** 토큰 엔트로피(바이트). 32 = 256 비트 — 추측 불가. sse-tokens 와 동일. */
const TOKEN_BYTES = 32;

/** at-rest 파일 권한(소유자만 읽기·쓰기). settings-store·sse-tokens 와 같은 상수. */
const FILE_MODE = 0o600;

/** 저장 파일 버전. 스키마 변경 시 올린다. */
const FILE_VERSION = 1;

interface AdminTokenFileShape {
  version: number;
  token: string;
  createdAt: string;
}

function resolvePath(filePath?: string): string {
  if (filePath !== undefined) return filePath;
  const envPath = process.env.BOT_ADMIN_TOKEN_PATH?.trim();
  if (envPath) return envPath;
  return botDataPath(FILE_NAME);
}

/**
 * 파일에서 토큰을 읽는다. 파일이 없거나 형식이 깨졌으면 null.
 *
 * 형식이 깨진 파일은 throw 하지 않고 null 을 반환한다 — 호출자
 * (loadOrCreateAdminToken)가 새 토큰을 생성하도록 한다. JSON 파싱 실패를
 * "토큰 없음"으로 취급하는 이 한 경로는 silent fallback 이 아니라, 손상된
 * 토큰 파일을 스스로 복구하는 정상 동작이다(sse-tokens 의 v1 관용 로드와 같은 톤).
 */
export function getAdminToken(filePath?: string): string | null {
  const path = resolvePath(filePath);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `bot-admin-token 읽기 실패: ${path} — ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as AdminTokenFileShape).token !== "string" ||
    (parsed as AdminTokenFileShape).token.length === 0
  ) {
    return null;
  }
  return (parsed as AdminTokenFileShape).token;
}

/**
 * 토큰을 probe 하고, 없으면 새로 생성해 0600 파일로 저장한 뒤 반환한다(멱등).
 *
 * 재호출 시 파일에 이미 토큰이 있으면 그 값을 그대로 반환한다 — 봇 재시작마다
 * 토큰이 바뀌면 앞서 발급한 관리 경로 접근이 전부 깨지므로, 한 번 만든 토큰을
 * 유지한다.
 */
export function loadOrCreateAdminToken(filePath?: string): { token: string } {
  const path = resolvePath(filePath);
  const existing = getAdminToken(path);
  if (existing !== null) {
    return { token: existing };
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const shape: AdminTokenFileShape = {
    version: FILE_VERSION,
    token,
    createdAt: new Date().toISOString(),
  };

  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(shape, null, 2)}\n`, {
      encoding: "utf-8",
      mode: FILE_MODE,
    });
    chmodSync(tmpPath, FILE_MODE);
    renameSync(tmpPath, path);
    chmodSync(path, FILE_MODE);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // 원래 저장 실패를 가리지 않는다.
      }
    }
    throw new Error(
      `bot-admin-token 저장 실패: ${path} — ${(err as Error).message}`,
    );
  }

  return { token };
}
