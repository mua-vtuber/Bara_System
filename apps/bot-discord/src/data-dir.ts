import { isAbsolute, join } from "node:path";

/**
 * 어댑터 데이터 폴더 환경변수 (docs/decisions/2026-10-08-single-deploy-path-spec.md 6.3 ②).
 * 펫 방식 배치에서는 `bara-adapter-discord.service` 가 `<서버 폴더>/adapters/discord/data` 를 넘긴다.
 * 이 폴더는 어느 업데이트에도 움직이지 않는다. 값이 없으면 지금 기본값 `data/` 를 그대로 쓴다.
 * 이름은 배포 쪽(apps/pet/src/service/install/adapter-registry.ts `ADAPTER_DATA_DIR_ENV`)과 맞춘 두 프로그램 사이 약속이다.
 */
export const ADAPTER_DATA_DIR_ENV = "BARA_ADAPTER_DATA_DIR";
const DEFAULT_DATA_DIR = "data";

/** 봇 데이터 파일 경로. 상대 경로 값은 실행 폴더(버전 폴더)에 따라 위치가 바뀌므로 변수 이름을 담아 거부한다. */
export function botDataPath(fileName: string, env: Record<string, string | undefined> = process.env): string {
  const configured = env[ADAPTER_DATA_DIR_ENV]?.trim();
  if (!configured) return `${DEFAULT_DATA_DIR}/${fileName}`;
  if (!isAbsolute(configured)) throw new Error(`${ADAPTER_DATA_DIR_ENV} 는 절대 경로여야 합니다: ${configured}`);
  return join(configured, fileName);
}
