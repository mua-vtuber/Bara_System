/**
 * wal-external-tool-e2e.test.ts — T5(W5): 외부 read-write 도구(cleanup-duplicates·
 * re-embed-images)가 서버 가동 중 붙어도 WAL·busy_timeout 을 자동 승계함을 동결.
 *
 * spec: docs/decisions/2026-07-02-wal-concurrency-spec.md (Completion Criteria 5)
 * plan: docs/decisions/2026-07-02-wal-concurrency-plan.md (T5)
 *
 * Mock 0. 실제 openMemoryDatabase + 실제 파일 DB + 실제 2개 연결. cleanup-duplicates.ts·
 * re-embed-images.ts 본체를 import 해 실행하지 않고(도구 CLI 는 argv·settings 파일 의존
 * 이라 단위 e2e 부적합), 그들이 쓰는 openMemoryDatabase(settings.db.path) 통로가 같은
 * 계약을 주는지를 검증한다 — 계약이 openMemoryDatabase 통로에서 성립하면 그 통로를 쓰는
 * 두 도구도 성립한다. 데이터 fixture(행 INSERT)만 쓰고 인터페이스 mock 은 없다.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { openMemoryDatabase } from "./migrations.ts";
import { DB_BUSY_TIMEOUT_MS } from "./connection-pragmas.ts";
import { makeWalTempDir, cleanupTempDir } from "./wal-test-helpers.ts";

const tempDirs: string[] = [];

function makeTempFile(): string {
  const { dir, file } = makeWalTempDir("bara-wal-ext-");
  tempDirs.push(dir);
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    cleanupTempDir(tempDirs.pop()!);
  }
});

describe("T5/W5 — 외부 read-write 도구 WAL 계약 승계", () => {
  test("같은 파일을 openMemoryDatabase 로 다시 열면 WAL·busy_timeout 을 승계한다", () => {
    const file = makeTempFile();

    // "서버" 연결 — 스키마 세팅 + 노드 seed.
    const server = openMemoryDatabase(file, { embeddingDim: 384 });
    server.run("CREATE TABLE IF NOT EXISTS probe(id INTEGER PRIMARY KEY, v TEXT)");
    server.run("INSERT INTO probe(v) VALUES ('seed')");

    // "외부 도구" 연결 — cleanup-duplicates 가 하는 것과 동일 경로(openMemoryDatabase).
    const tool = openMemoryDatabase(file, { embeddingDim: 384 });

    // 도구 연결도 WAL·busy_timeout 을 받았는지(승계 증명).
    expect(
      (tool.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toBe("wal");
    expect(
      (tool.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
    ).toBe(DB_BUSY_TIMEOUT_MS);

    tool.close();
    server.close();
  });

  test("서버 읽기 스냅샷 유지 중 외부 도구 연결이 쓰기 성공(WAL 동시)", () => {
    const file = makeTempFile();
    const server = openMemoryDatabase(file, { embeddingDim: 384 });
    server.run("CREATE TABLE IF NOT EXISTS probe(id INTEGER PRIMARY KEY, v TEXT)");
    server.run("INSERT INTO probe(v) VALUES ('a')");

    const tool = openMemoryDatabase(file, { embeddingDim: 384 });

    // 서버가 읽기 트랜잭션(스냅샷)을 연다.
    server.run("BEGIN");
    const snapshot = (server.query("SELECT COUNT(*) c FROM probe").get() as { c: number }).c;
    expect(snapshot).toBe(1);

    // 외부 도구 연결이 쓰기 INSERT → WAL 이라 서버 읽기가 막지 않아 성공.
    expect(() => tool.run("INSERT INTO probe(v) VALUES ('tool')")).not.toThrow();

    server.run("COMMIT");
    // 서버가 새 뷰로 보면 도구가 쓴 행이 보인다.
    expect((server.query("SELECT COUNT(*) c FROM probe").get() as { c: number }).c).toBe(2);

    tool.close();
    server.close();
  });
});
