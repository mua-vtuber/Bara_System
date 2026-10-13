/**
 * wal-readonly-tool-e2e.test.ts — T6(W6): read-only 도구(check-relations·
 * diagnose_preserved_raw)의 read-only 연결에 busy_timeout 이 걸리는지 + read-only
 * 연결로도 checkRelations 가 회귀 0 으로 동작하는지 동결.
 *
 * spec: docs/decisions/2026-07-02-wal-concurrency-spec.md (Completion Criteria 6)
 * plan: docs/decisions/2026-07-02-wal-concurrency-plan.md (T6)
 *
 * Mock 0. 실제 openMemoryDatabase 로 파일 DB 를 만들고 close 한 뒤, CLI 가 하는 것과
 * 동일하게 new Database(file, { readonly: true }) + applyBusyTimeout 을 재현한다. 도구
 * CLI 의 import.meta.main 블록은 함수가 아니라 top-level 스크립트라 직접 단위 테스트가
 * 어려우므로, CLI 가 여는 연결 계약(readonly + applyBusyTimeout)을 파일 DB 로 재현해
 * 검증한다. 데이터 fixture(행 INSERT)만 쓰고 인터페이스 mock 은 없다.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openMemoryDatabase } from "./migrations.ts";
import { applyBusyTimeout, DB_BUSY_TIMEOUT_MS } from "./connection-pragmas.ts";
import { checkRelations } from "../tools/check-relations.ts";
import { makeWalTempDir, cleanupTempDir } from "./wal-test-helpers.ts";

const tempDirs: string[] = [];

function makeTempFile(): string {
  const { dir, file } = makeWalTempDir("bara-wal-ro-");
  tempDirs.push(dir);
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    cleanupTempDir(tempDirs.pop()!);
  }
});

describe("T6/W6 — read-only 도구 busy_timeout 배선", () => {
  test("read-only 연결 + applyBusyTimeout → busy_timeout=5000", () => {
    const file = makeTempFile();
    // 파일 DB 를 세우고 close(운영 DB 재현).
    const setup = openMemoryDatabase(file, { embeddingDim: 384 });
    setup.close();

    // CLI 가 하는 것과 동일: readonly 연결 + applyBusyTimeout.
    const ro = new Database(file, { readonly: true });
    applyBusyTimeout(ro);
    expect(
      (ro.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
    ).toBe(DB_BUSY_TIMEOUT_MS);
    // read-only 연결도 WAL 모드로 자동 연결된다(모드는 파일에 지속 기록됨).
    expect(
      (ro.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toBe("wal");
    ro.close();
  });

  test("read-only 연결로도 checkRelations 가 회귀 0 으로 동작한다", () => {
    const file = makeTempFile();
    // 파일 DB 에 비표준 relation 을 하나 심어 두고 close.
    const setup = openMemoryDatabase(file, { embeddingDim: 384 });
    setup
      .prepare(
        `INSERT INTO entity_relation_edges (source_type, source_id, target_type, target_id, relation, provenance, source_node_id) VALUES ('project', 'prj_x', 'person', 'psn_x', 'made_byy', 'user_input', NULL)`,
      )
      .run();
    setup.close();

    // read-only 연결 + busy_timeout(CLI 계약) 로 checkRelations 실행.
    const ro = new Database(file, { readonly: true });
    applyBusyTimeout(ro);
    const report = checkRelations(ro, file);

    // 기존 report 동작 회귀 0 — 비표준 relation·orphan endpoint 를 그대로 잡는다.
    expect(report.checkedTables).toContain("entity_relation_edges");
    expect(report.rowCounts.entity_relation_edges).toBe(1);
    expect(
      report.findings.some(
        (f) => f.table === "entity_relation_edges" && f.check === "orphan-endpoint",
      ),
    ).toBe(true);
    ro.close();
  });
});
