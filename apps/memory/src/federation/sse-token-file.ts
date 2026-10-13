/**
 * SSE/API 토큰 파일 저장(sse-tokens.ts 에서 분리).
 *
 * 토큰 파일은 임시 파일에 쓴 뒤 이름을 바꿔(rename) 한 번에 교체한다 — 쓰는 도중
 * 서버가 죽어도 반쯤 쓰인 파일이 남지 않는다. 파일 권한은 소유자만 읽고 쓰는 600 이다.
 */

import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** at-rest 파일 권한(소유자만 읽기·쓰기). */
const FILE_MODE = 0o600;
/** 토큰 파일이 들어갈 폴더를 새로 만들 때의 권한(소유자만). */
const DIR_MODE = 0o700;

/** text 를 filePath 에 atomic 저장(tmp 쓰기 -> rename) + 권한 600. 실패는 경로를 담아 던진다. */
export function writeTokenFileAtomic(filePath: string, text: string): void {
  const dir = dirname(filePath);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, text, { encoding: "utf-8", mode: FILE_MODE });
    chmodSync(tmpPath, FILE_MODE);
    renameSync(tmpPath, filePath);
    chmodSync(filePath, FILE_MODE);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // 원래 저장 실패를 가리지 않는다.
      }
    }
    throw new Error(`SSE 토큰 파일 저장 실패: ${filePath} — ${(err as Error).message}`);
  }
}
