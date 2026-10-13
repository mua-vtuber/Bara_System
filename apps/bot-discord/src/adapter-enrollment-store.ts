/**
 * 봇 어댑터 등록 대기 저장소.
 *
 * 봇이 /adapter-enroll 로 승인 요청을 만들면 서버는 requestId 와 pickupSecret(승인 뒤 토큰을
 * 회수할 비밀값)을 한 번만 준다. 예전에는 이 둘을 메모리에만 들고 있어서, 승인 대기 중에
 * 봇이 재시작되면 비밀값을 잃었다. 서버는 같은 adapterId 의 대기 요청이 있으면 새 무인증
 * 요청을 409(ADAPTER_ENROLL_PENDING_EXISTS)로 거절하므로, 봇은 옛 요청을 회수할 수도
 * 새로 요청할 수도 없는 상태에 빠졌다.
 *
 * 그래서 대기 요청을 어댑터 토큰 파일 옆에 0600 파일로 남긴다. 재시작 뒤에는 이 파일로
 * 회수 확인을 이어 가고, 토큰을 받았거나 요청이 끝난 것(거절·만료)이 확인되면 지운다.
 * 비밀값은 로그·에러에 넣지 않는다.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveAdapterTokenPath, writePrivateJsonAtomic } from "./adapter-token-store.ts";

/** 등록 대기 파일 이름. 어댑터 토큰 파일과 같은 폴더에 둔다. */
const FILE_NAME = "bot-adapter-enrollment.json";

/** 저장 파일 버전. 스키마 변경 시 올린다. */
const FILE_VERSION = 1;

const STORE_LABEL = "bot-adapter-enrollment";

export interface PendingEnrollmentRecord {
  version: number;
  adapterId: string;
  /** 요청을 보낸 memory-api 주소. 주소가 바뀌면 다른 서버의 요청이라 쓰지 않는다. */
  baseUrl: string;
  requestId: string;
  pickupSecret: string;
  createdAt: string;
}

export type PendingEnrollmentInput = Omit<PendingEnrollmentRecord, "version" | "createdAt">;

/** tokenStorePath(어댑터 토큰 파일 경로 override)와 같은 폴더의 등록 대기 파일 경로. */
export function resolvePendingEnrollmentPath(tokenStorePath?: string): string {
  return join(dirname(resolveAdapterTokenPath(tokenStorePath)), FILE_NAME);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * 저장된 등록 대기 요청을 읽는다. 파일이 없으면 null.
 * 내용이 깨졌거나 칸이 빠진 파일도 null — 회수할 수 없는 요청이므로 호출자가 지우고 새로
 * 요청한다(adapter-token-store 의 손상 파일 처리와 같은 흐름). 읽기 자체의 OS 오류는 던진다.
 */
export function loadPendingEnrollment(tokenStorePath?: string): PendingEnrollmentRecord | null {
  const path = resolvePendingEnrollmentPath(tokenStorePath);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`${STORE_LABEL} 읽기 실패: ${path} — ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Partial<PendingEnrollmentRecord>;
  if (
    !isNonEmptyString(rec.adapterId) ||
    !isNonEmptyString(rec.baseUrl) ||
    !isNonEmptyString(rec.requestId) ||
    !isNonEmptyString(rec.pickupSecret)
  ) {
    return null;
  }
  return {
    version: typeof rec.version === "number" ? rec.version : FILE_VERSION,
    adapterId: rec.adapterId,
    baseUrl: rec.baseUrl,
    requestId: rec.requestId,
    pickupSecret: rec.pickupSecret,
    createdAt: isNonEmptyString(rec.createdAt) ? rec.createdAt : "",
  };
}

/** 등록 대기 요청을 0600 파일로 atomic 저장한다. version·createdAt 은 저장소가 채운다. */
export function savePendingEnrollment(input: PendingEnrollmentInput, tokenStorePath?: string): void {
  const record: PendingEnrollmentRecord = {
    version: FILE_VERSION,
    ...input,
    createdAt: new Date().toISOString(),
  };
  writePrivateJsonAtomic(resolvePendingEnrollmentPath(tokenStorePath), record, STORE_LABEL);
}

/** 등록 대기 파일을 지운다. 파일이 없으면 아무것도 하지 않는다(이미 지워짐). */
export function clearPendingEnrollment(tokenStorePath?: string): void {
  const path = resolvePendingEnrollmentPath(tokenStorePath);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch (err) {
    throw new Error(`${STORE_LABEL} 삭제 실패: ${path} — ${(err as Error).message}`);
  }
}
