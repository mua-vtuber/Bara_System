/**
 * wal-test-helpers.ts — WAL 동시성 e2e 테스트가 공유하는 파일 DB temp dir 관리 헬퍼.
 *
 * spec: docs/decisions/2026-07-02-wal-concurrency-spec.md
 * plan: docs/decisions/2026-07-02-wal-concurrency-plan.md (T1·T3·T4·T5)
 *
 * 이 파일은 테스트 지원 유틸(mock 아님 — 실제 파일시스템만 다룬다). 프로덕션 코드
 * 경로가 import 하지 않는다(테스트 전용).
 *
 * 정리 정책: Linux(개발 WSL·프로덕션 A1 Flex)에서는 openMemoryDatabase 로 연 파일 DB
 * 를 close 하면 -wal·-shm 사이드파일 핸들이 즉시 해제돼 rmSync 가 성공한다(실측 확정).
 * Windows 네이티브 bun 은 FTS5+다중 vec0 스키마를 가진 파일 DB 를 close 할 때 파일
 * 핸들 해제가 지연돼 rm 이 EBUSY 로 던진다 — 이는 Windows 한정 환경 이슈이고 프로덕션
 * (Linux ARM)·개발(WSL Linux)과 무관하다. 그 환경에서 테스트가 깨지지 않도록 정리를
 * best-effort 로 두되, 남은 temp dir 은 프로세스 종료 시 OS 가 회수한다. 정리 실패를
 * 조용히 삼키지 않고(silent no-op 금지) 무엇이 왜 실패했는지 경고로 남긴다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * temp dir 을 만들고 그 안의 파일 경로를 돌려준다. 호출자가 반환 경로 배열에 dir 을
 * 담아 두고 afterEach 에서 cleanupTempDir 로 지운다.
 */
export function makeWalTempDir(prefix: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, file: join(dir, "bara.sqlite") };
}

/**
 * temp dir 을 지운다. 실패(Windows EBUSY 등)해도 던지지 않되, 조용히 넘기지 않고
 * 경고를 남긴다 — OS 가 프로세스 종료 시 회수한다. Linux 에서는 항상 성공한다.
 */
export function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn(
      `[wal-test-helpers] temp dir 정리 실패(무해, 프로세스 종료 시 OS 회수): ` +
        `${dir} — ${(e as Error).message}`,
    );
  }
}
