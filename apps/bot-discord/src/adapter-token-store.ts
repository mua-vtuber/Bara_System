/**
 * 봇 어댑터 토큰 저장소 (D5).
 *
 * 권위: docs/decisions/2026-07-02-adapter-auth-spec.md section 3.3 / 4.1
 *
 * 봇이 코어에서 pickup 한 어댑터 토큰 + requestId + pickupSecret 을 0600 파일로
 * 영속한다. 부팅 시 이 파일을 probe 해 저장된 토큰이 아직 유효하면 승인 요청을
 * 건너뛴다(sse-bootstrap.ts 배선). 봇 재시작마다 수동 재승인해야 하는 채택 장벽을
 * 없앤다.
 *
 * settings-store.ts / admin-token-store.ts 의 atomic write(tmp + rename) + chmod
 * 600 패턴을 답습한다. 토큰·pickupSecret 값은 로그·응답·에러에 넣지 않는다 — 이
 * 저장소는 값을 반환·저장만 하고 로그하지 않는다.
 */

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

/** 어댑터 토큰 보관 파일 이름. 폴더는 botDataPath 가 정한다(BARA_ADAPTER_DATA_DIR 또는 data/). */
const FILE_NAME = "bot-adapter-token.json";

/** at-rest 파일 권한(소유자만 읽기·쓰기). 다른 봇 저장소와 같은 상수. */
const FILE_MODE = 0o600;

/** 저장 폴더를 새로 만들 때의 권한(소유자만). */
const DIR_MODE = 0o700;

/** 저장 파일 버전. 스키마 변경 시 올린다. */
const FILE_VERSION = 1;

/**
 * 디스크에 보관하는 어댑터 토큰 레코드.
 * endpoint 를 함께 저장 — 다음 부팅에서 endpoint 가 바뀌었으면(포트 변경 등)
 * 저장 토큰을 무효로 보고 재enroll 한다(isStoredTokenForEndpoint).
 */
export interface AdapterTokenRecord {
  version: number;
  adapterId: string;
  endpoint: string;
  token: string;
  requestId: string;
  pickupSecret: string;
  /**
   * 이 어댑터 토큰 저장 시점에 코어에 등록했다고 판단한 봇 로컬 관리 토큰의
   * sha256 해시. 평문 관리 토큰은 이 파일에 저장하지 않는다. 없으면 옛 파일이라
   * 다음 부팅에서 재등록 대상으로 본다.
   */
  adminTokenHash?: string;
  savedAt: string;
}

/** save 호출 시 version·savedAt 을 제외한 입력. 저장소가 채운다. */
export interface AdapterTokenInput {
  adapterId: string;
  endpoint: string;
  token: string;
  requestId: string;
  pickupSecret: string;
  adminTokenHash?: string;
}

/** 어댑터 토큰 파일 경로. 등록 대기 파일(adapter-enrollment-store.ts)이 이 파일 옆에 놓인다. */
export function resolveAdapterTokenPath(filePath?: string): string {
  return resolvePath(filePath);
}

function resolvePath(filePath?: string): string {
  if (filePath !== undefined) return filePath;
  const envPath = process.env.BOT_ADAPTER_TOKEN_PATH?.trim();
  if (envPath) return envPath;
  return botDataPath(FILE_NAME);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * 저장된 어댑터 토큰 레코드를 읽는다. 파일 부재·손상·필드 누락은 null.
 *
 * 손상·누락을 null 로 취급하는 것은 silent fallback 이 아니라, 손상된 토큰
 * 파일을 스스로 버리고 재enroll 하도록 하는 정상 복구 흐름이다(admin-token-store
 * 와 같은 톤). 읽기 자체가 OS 오류로 실패하면 throw 한다.
 */
export function loadAdapterToken(filePath?: string): AdapterTokenRecord | null {
  const path = resolvePath(filePath);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `bot-adapter-token 읽기 실패: ${path} — ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Partial<AdapterTokenRecord>;
  if (
    !isNonEmptyString(rec.adapterId) ||
    !isNonEmptyString(rec.endpoint) ||
    !isNonEmptyString(rec.token) ||
    !isNonEmptyString(rec.requestId) ||
    !isNonEmptyString(rec.pickupSecret)
  ) {
    return null;
  }
  return {
    version: typeof rec.version === "number" ? rec.version : FILE_VERSION,
    adapterId: rec.adapterId,
    endpoint: rec.endpoint,
    token: rec.token,
    requestId: rec.requestId,
    pickupSecret: rec.pickupSecret,
    ...(isNonEmptyString(rec.adminTokenHash)
      ? { adminTokenHash: rec.adminTokenHash }
      : {}),
    savedAt: isNonEmptyString(rec.savedAt) ? rec.savedAt : "",
  };
}

/**
 * 어댑터 토큰 레코드를 0600 파일로 atomic 저장한다(tmp + rename + chmod 600).
 * version·savedAt 은 저장소가 채운다.
 */
export function saveAdapterToken(
  input: AdapterTokenInput,
  filePath?: string,
): void {
  const path = resolvePath(filePath);
  const record: AdapterTokenRecord = {
    version: FILE_VERSION,
    adapterId: input.adapterId,
    endpoint: input.endpoint,
    token: input.token,
    requestId: input.requestId,
    pickupSecret: input.pickupSecret,
    ...(isNonEmptyString(input.adminTokenHash)
      ? { adminTokenHash: input.adminTokenHash }
      : {}),
    savedAt: new Date().toISOString(),
  };

  writePrivateJsonAtomic(path, record, "bot-adapter-token");
}

/**
 * value 를 JSON 으로 0600 파일에 atomic 저장한다(tmp + rename + chmod 600). 폴더가 없으면
 * 소유자 전용(0700)으로 만든다. 실패는 label·경로를 담아 던진다(값은 넣지 않는다).
 */
export function writePrivateJsonAtomic(path: string, value: unknown, label: string): void {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }

  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, {
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
    throw new Error(`${label} 저장 실패: ${path} — ${(err as Error).message}`);
  }
}

/**
 * 저장 토큰을 폐기한다(파일 삭제). 토큰이 코어에서 무효(401)로 판정되면
 * 호출해 다음 부팅이 재enroll 하게 한다. 파일 부재는 no-op(이미 없음).
 */
export function clearAdapterToken(filePath?: string): void {
  const path = resolvePath(filePath);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch (err) {
    throw new Error(
      `bot-adapter-token 삭제 실패: ${path} — ${(err as Error).message}`,
    );
  }
}

/**
 * 저장 레코드가 현재 봇 endpoint 용인지 판정한다(순수 함수).
 * endpoint 가 바뀌었으면(포트 변경 등) 저장 토큰을 무효로 봐야 한다 — 코어의
 * 발급 메타 endpoint 와 어긋나 D6 자동 승인도 안 되기 때문.
 */
export function isStoredTokenForEndpoint(
  record: AdapterTokenRecord,
  endpoint: string,
): boolean {
  return record.endpoint === endpoint;
}
