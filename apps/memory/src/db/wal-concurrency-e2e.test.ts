/**
 * wal-concurrency-e2e.test.ts — T4(W7·W8): WAL 동시성 계약 동결.
 *   W7 — 읽기 스냅샷을 잡은 채 쓰기 성공(WAL: 읽기가 쓰기를 안 막음).
 *   W8 — busy_timeout=0 이면 경합 시 즉시 SQLITE_BUSY, 설정값이면 대기 후 성공(대조).
 *
 * spec: docs/decisions/2026-07-02-wal-concurrency-spec.md (Completion Criteria 3·4)
 * plan: docs/decisions/2026-07-02-wal-concurrency-plan.md (T4)
 *
 * Mock 0. 실제 bun:sqlite + sqlite-vec + 실제 파일 DB + 실제 2개 이상 연결. W8 의
 * "대기 후 성공"은 별 프로세스(wal-lock-holder.fixture.ts)가 실제로 쓰기 락을 쥐었다
 * 놓아 재현한다(동기 API 라 한 프로세스 안에서는 대기 재현 불가). 데이터 fixture(행
 * INSERT)만 쓰고 인터페이스 mock 은 없다.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { openMemoryDatabase } from "./migrations.ts";
import { applyBusyTimeout, applyConnectionPragmas } from "./connection-pragmas.ts";
import { makeWalTempDir, cleanupTempDir } from "./wal-test-helpers.ts";

const LOCK_HOLDER = join(import.meta.dir, "wal-lock-holder.fixture.ts");
const tempDirs: string[] = [];

function makeTempFile(): string {
  const { dir, file } = makeWalTempDir("bara-wal-conc-");
  tempDirs.push(dir);
  return file;
}

/** probe 테이블을 가진 WAL 파일 DB 를 세운다(openMemoryDatabase 경유 = 서버 연결 재현). */
function seedProbeDb(file: string): void {
  const w = openMemoryDatabase(file, { embeddingDim: 384 });
  w.run("CREATE TABLE IF NOT EXISTS probe(id INTEGER PRIMARY KEY, v TEXT)");
  w.run("INSERT INTO probe(v) VALUES ('seed')");
  w.close();
}

afterEach(() => {
  while (tempDirs.length > 0) {
    cleanupTempDir(tempDirs.pop()!);
  }
});

describe("T4/W7 — 읽기 스냅샷 잡은 채 쓰기 성공", () => {
  test("reader 가 읽기 트랜잭션을 유지하는 동안 writer INSERT 가 성공한다", () => {
    const file = makeTempFile();
    const writer = openMemoryDatabase(file, { embeddingDim: 384 });
    writer.run("CREATE TABLE IF NOT EXISTS probe(id INTEGER PRIMARY KEY, v TEXT)");
    writer.run("INSERT INTO probe(v) VALUES ('a')");

    // reader 는 read-only 연결로 읽기 트랜잭션을 연다(스냅샷 고정).
    const reader = new Database(file, { readonly: true });
    applyBusyTimeout(reader);
    reader.run("BEGIN");
    const snapshot = (reader.query("SELECT COUNT(*) c FROM probe").get() as { c: number }).c;
    expect(snapshot).toBe(1);

    // reader 가 스냅샷을 잡은 상태에서 writer 가 새 행 INSERT → WAL 이라 성공해야 한다.
    expect(() => writer.run("INSERT INTO probe(v) VALUES ('b')")).not.toThrow();

    // reader 스냅샷은 여전히 옛 뷰(1행) — WAL 스냅샷 격리.
    const stillSnapshot = (reader.query("SELECT COUNT(*) c FROM probe").get() as { c: number }).c;
    expect(stillSnapshot).toBe(1);

    reader.run("COMMIT");
    // COMMIT 후 새 뷰 = 2행.
    expect((reader.query("SELECT COUNT(*) c FROM probe").get() as { c: number }).c).toBe(2);

    reader.close();
    writer.close();
  });
});

describe("T4/W8 — busy_timeout 이 쓰기 경합을 대기로 흡수", () => {
  test("busy_timeout=0 연결은 락 경합 시 즉시 SQLITE_BUSY 로 실패한다(옛 결함 재현)", () => {
    const file = makeTempFile();
    seedProbeDb(file);

    // writer1 이 쓰기 락을 쥔다(같은 프로세스, BEGIN IMMEDIATE).
    const w1 = new Database(file);
    applyConnectionPragmas(w1, file);
    w1.run("BEGIN IMMEDIATE");
    w1.run("INSERT INTO probe(v) VALUES ('w1')");

    // writer2 를 busy_timeout=0 으로 열어 같은 순간 쓰기 시도 → 즉시 실패.
    const w2 = new Database(file);
    w2.query("PRAGMA journal_mode = WAL").get();
    w2.run("PRAGMA busy_timeout = 0");
    const t0 = Date.now();
    let message = "";
    try {
      w2.run("BEGIN IMMEDIATE");
      w2.run("INSERT INTO probe(v) VALUES ('w2')");
    } catch (e) {
      message = (e as Error).message;
    }
    const elapsed = Date.now() - t0;
    // 즉시(대기 없이) database is locked.
    expect(message).toContain("locked");
    expect(elapsed).toBeLessThan(500);

    w2.close();
    w1.run("COMMIT");
    w1.close();
  });

  test("busy_timeout=5000 연결은 별 프로세스가 락을 쥔 동안 대기 후 성공한다", async () => {
    const file = makeTempFile();
    seedProbeDb(file);

    const HOLD_MS = 300;
    // 별 프로세스가 쓰기 락을 HOLD_MS 동안 쥔다.
    const holder = spawn(process.execPath, [LOCK_HOLDER, file, String(HOLD_MS)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 홀더가 락을 획득했다는 신호를 기다린다.
    await new Promise<void>((resolve, reject) => {
      let out = "";
      holder.stdout!.on("data", (d) => {
        out += String(d);
        if (out.includes("HOLDER_LOCKED")) resolve();
      });
      holder.on("error", reject);
      holder.on("exit", (code) => {
        if (!out.includes("HOLDER_LOCKED")) {
          reject(new Error(`홀더가 락 신호 전에 종료됨(code=${code})`));
        }
      });
    });

    // 메인 writer2 는 busy_timeout=5000 — 홀더가 락을 놓을 때까지 대기 후 성공해야 한다.
    const w2 = new Database(file);
    w2.query("PRAGMA journal_mode = WAL").get();
    applyBusyTimeout(w2);
    const t0 = Date.now();
    let ok = false;
    let message = "";
    try {
      w2.run("INSERT INTO probe(v) VALUES ('w2wait')");
      ok = true;
    } catch (e) {
      message = (e as Error).message;
    }
    const elapsed = Date.now() - t0;
    w2.close();

    await new Promise<void>((resolve) => holder.on("exit", () => resolve()));

    // 대기 후 성공 — busy_timeout 이 즉시 실패를 대기로 바꿨다(err 없음).
    expect(ok).toBe(true);
    expect(message).toBe("");
    // 홀더가 HOLD_MS 동안 락을 쥐었으므로 최소 그만큼 대기했다(즉시 성공이 아님).
    expect(elapsed).toBeGreaterThanOrEqual(HOLD_MS - 50);
  });
});
