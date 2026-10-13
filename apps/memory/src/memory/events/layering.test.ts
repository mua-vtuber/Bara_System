/**
 * memory/events/layering.test.ts — 계층 규율 가드 (G5-b).
 *
 * 권위: docs/decisions/2026-07-03-structure-cleanup-spec.md G5-b
 *
 * src/memory/(도메인) 아래 비-test production 파일이 server-internal/(HTTP 서버
 * 내부)을 import 하면 역방향 의존이다. 이 테스트는 파일 스캔으로 그런 import 가
 * 0건임을 단언한다 — 새 역방향 import 가 생기면 파일:줄 목록과 함께 실패한다.
 * (.test.ts 파일이 EventBus 구현체를 server-internal 에서 직접 가져와 통합
 * 검증하는 것은 계층 규율 대상이 아니라 허용.)
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

/** 스캔 뿌리 — 이 테스트 파일 위치(src/memory/events/) 기준 src/memory/. */
const MEMORY_DIR = join(import.meta.dir, "..");

/**
 * import/재export from-절과 side-effect·dynamic import 의 경로 리터럴에서
 * server-internal 을 찾는다. 주석 속 언급(예: "server-internal(event-bus)에
 * 직접 의존하지 않도록")은 from-절 형태가 아니므로 걸리지 않는다.
 */
const REVERSE_IMPORT_PATTERN =
  /(?:from\s+|import\s+|import\s*\(\s*)["'][^"']*server-internal[^"']*["']/;

describe("layering — memory/ 는 server-internal 을 import 하지 않는다", () => {
  it("src/memory 비-test 파일의 server-internal import 0건", async () => {
    const glob = new Bun.Glob("**/*.ts");
    const violations: string[] = [];

    for await (const rel of glob.scan({ cwd: MEMORY_DIR })) {
      if (rel.endsWith(".test.ts")) continue;
      const lines = (await Bun.file(join(MEMORY_DIR, rel)).text()).split("\n");
      lines.forEach((line, index) => {
        if (REVERSE_IMPORT_PATTERN.test(line)) {
          violations.push(`${rel}:${index + 1} — ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
