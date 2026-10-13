/**
 * P4 D4-b — 앱 버전 단일 출처 = apps/memory/package.json "version".
 * JSON import 는 모듈 상대 해석이라 실행 cwd 와 무관(bun run 비컴파일에서도 안전).
 */
import pkg from "../package.json";
import type { Database } from "bun:sqlite";
import { getAppliedSchemaVersion } from "./db/migrations.ts";

export const APP_VERSION: string = pkg.version;

export function buildVersionInfo(db: Database): { version: string; schemaVersion: number } {
  const applied = getAppliedSchemaVersion(db);
  if (applied === null) {
    throw new Error(
      "buildVersionInfo: schema_version 테이블이 비어 있음 — openMemoryDatabase 를 거치지 않은(마이그레이션 미수행) DB 로 보임",
    );
  }
  return { version: APP_VERSION, schemaVersion: applied };
}
