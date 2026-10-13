/**
 * migration-safety.test-helpers.ts — 마이그레이션 안전 테스트 공용 정리 헬퍼.
 *
 * 런타임 코드가 아니다(production 경로 어디도 import 하지 않는다 — `.test-helpers.ts`
 * 규약). 여러 테스트 파일이 임시 파일 DB 를
 * 만들고 지우므로 정리 로직을 한곳에 둔다.
 */
import { rmSync, existsSync } from "node:fs";

/**
 * 임시 폴더 정리(테스트 한정). Windows 는 db.close() 직후에도 SQLite 파일 핸들이
 * 잠깐 잠겨 rmSync 가 EBUSY 를 낸다. Bun 의 rmSync 는 Node 의 maxRetries/retryDelay
 * 를 안 기다리므로, 짧은 동기 대기 루프로 몇 번 재시도한다. 여기서 검증(expect)은
 * 이미 끝났고 임시 폴더는 OS 가 결국 정리하므로, 끝까지 실패해도 정리 실패만
 * 삼킨다(프로덕션 fallback 이 아니라 테스트 teardown 이식성 처리다).
 */
export function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!existsSync(dir)) return;
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // 잠금 해제를 기다린다 — 짧은 busy-wait.
      const until = Date.now() + 50;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}
