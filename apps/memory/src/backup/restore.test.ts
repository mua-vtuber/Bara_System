/**
 * restore 통합 테스트 — 실 SQLite + 실 파일시스템으로 왕복을 검증한다.
 * 가짜 구현체 없음(mock 0). 검색 왕복(임베더)은 DB 파일 복사에 관여하지 않으므로
 * 노드 행 수·자산 존재 일치로 충분하다(임베딩 왕복은 게이트 절 라이브 확인에 위임).
 *
 * T2 의 makeEnv/depsOf 를 backup-test-env.ts 에서 그대로 재사용한다(복제 금지).
 * env 구조: DB=`<dir>/bara.sqlite` · 자산=`<dir>/assets/content/` · 설정·비밀값은
 * `<dir>/` 바로 아래. 그러므로 executeRestore 의 dataDir 는 `<dir>`(DB·설정·자산의
 * 부모)이고, 자산 목적지는 `<dataDir>/assets/content/` 이다.
 */
import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cleanupTempDir, makeWalTempDir } from "../db/wal-test-helpers.ts";
import { runBackupRound } from "./backup-runner.ts";
import { makeEnv, depsOf, TEST_ASSET_NAME } from "./backup-test-env.ts";
import { planRestore, executeRestore, RestoreError } from "./restore.ts";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    cleanupTempDir(tempDirs.pop()!);
  }
});

/** 실제 SQLite 파일을 만들되 Windows 에 파일 연결 핸들을 남기지 않는다. */
function writeExistingDatabase(path: string): Buffer {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE original (content TEXT)");
    db.run("INSERT INTO original VALUES ('복원 전 기억')");
    const bytes = db.serialize();
    writeFileSync(path, bytes);
    return bytes;
  } finally {
    db.close();
  }
}

test("기존 DB·사이드파일·덮어쓸 설정은 내용과 파일 식별자를 유지해 보존하고 자산은 옮기지 않는다", async () => {
  const e = makeEnv();
  tempDirs.push(e.dir);
  const { roundDir } = await runBackupRound(depsOf(e));
  e.db.close();
  const { dir } = makeWalTempDir("bara-restore-preserve-");
  tempDirs.push(dir);
  const originalDb = writeExistingDatabase(join(dir, "bara.sqlite"));
  const originals = new Map<string, Buffer>([
    ["bara.sqlite", originalDb],
    ["bara.sqlite-wal", Buffer.from("old-wal")],
    ["bara.sqlite-shm", Buffer.from("old-shm")],
    ["memory-settings.json", Buffer.from('{"old":true}')],
    ["secrets.json", Buffer.from('{"oldSecret":true}')],
  ]);
  for (const [name, bytes] of originals) writeFileSync(join(dir, name), bytes);
  const inodes = new Map([...originals.keys()].map((name) => [name, statSync(join(dir, name)).ino]));
  writeFileSync(join(dir, "sse-tokens.json"), "not-in-round");
  const oldBefore = join(dir, "before-restore-20000101-000000");
  mkdirSync(oldBefore);
  writeFileSync(join(oldBefore, "keep.txt"), "user-owned");
  const contentDir = join(dir, "assets", "content");
  mkdirSync(contentDir, { recursive: true });
  writeFileSync(join(contentDir, TEST_ASSET_NAME), "png-bytes");
  const assetInode = statSync(join(contentDir, TEST_ASSET_NAME)).ino;

  const out = executeRestore(roundDir, join(e.backupDir, "assets-mirror"), dir);
  expect(out.beforeRestoreDir).toBeDefined();
  const before = out.beforeRestoreDir!;
  expect(basename(before)).toMatch(/^before-restore-\d{8}-\d{6}(?:-\d+)?$/);
  expect(readdirSync(before).sort()).toEqual([...originals.keys()].sort());
  for (const [name, bytes] of originals) {
    expect(readFileSync(join(before, name)).equals(bytes)).toBe(true);
    expect(statSync(join(before, name)).ino).toBe(inodes.get(name)!);
  }
  const preserved = Database.deserialize(readFileSync(join(before, "bara.sqlite")), { readonly: true });
  try {
    expect(preserved.query("SELECT content FROM original").get()).toEqual({ content: "복원 전 기억" });
  } finally {
    preserved.close();
  }
  expect(readFileSync(join(dir, "bara.sqlite"))).toEqual(readFileSync(join(roundDir, "bara.sqlite")));
  expect(existsSync(join(dir, "bara.sqlite-wal"))).toBe(false);
  expect(existsSync(join(dir, "bara.sqlite-shm"))).toBe(false);
  expect(statSync(join(contentDir, TEST_ASSET_NAME)).ino).toBe(assetInode);
  expect(readFileSync(join(dir, "sse-tokens.json"), "utf8")).toBe("not-in-round");
  expect(readFileSync(join(oldBefore, "keep.txt"), "utf8")).toBe("user-owned");
});

test("빈 대상에는 보존 폴더를 만들지 않고 복원한다", async () => {
  const e = makeEnv();
  tempDirs.push(e.dir);
  const { roundDir } = await runBackupRound(depsOf(e));
  e.db.close();
  const dir = join(e.dir, "empty-restore");

  const out = executeRestore(roundDir, join(e.backupDir, "assets-mirror"), dir);

  expect(out.beforeRestoreDir).toBeUndefined();
  expect(readdirSync(dir).filter((name) => name.startsWith("before-restore-"))).toEqual([]);
  expect(readFileSync(join(dir, "bara.sqlite"))).toEqual(readFileSync(join(roundDir, "bara.sqlite")));
});

test.skipIf(process.platform !== "win32")("실제 파일 잠금으로 중간 보존 이동이 실패하면 DB·사이드파일·설정을 원위치로 되돌린다", async () => {
  const e = makeEnv();
  tempDirs.push(e.dir);
  const { roundDir } = await runBackupRound(depsOf(e));
  e.db.close();
  const { dir } = makeWalTempDir("bara-restore-rollback-");
  tempDirs.push(dir);
  writeExistingDatabase(join(dir, "bara.sqlite"));
  writeFileSync(join(dir, "bara.sqlite-wal"), "old-wal");
  writeFileSync(join(dir, "bara.sqlite-shm"), "old-shm");
  writeFileSync(join(dir, "memory-settings.json"), '{"old":true}');
  writeFileSync(join(dir, "secrets.json"), '{"oldSecret":true}');
  const originals = readdirSync(dir).map((name) => ({ name, bytes: readFileSync(join(dir, name)), ino: statSync(join(dir, name)).ino }));
  // 읽기는 허용하되 rename/delete/write 는 거부하는 OS 의 실제 파일 핸들.
  const lock = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
    "$f = [System.IO.File]::Open($env:BARA_RESTORE_LOCK_PATH, 'Open', 'Read', 'Read'); try { [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }",
  ], {
    env: { ...process.env, BARA_RESTORE_LOCK_PATH: join(dir, "secrets.json") },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    const ready = await lock.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    expect(() => executeRestore(roundDir, join(e.backupDir, "assets-mirror"), dir)).toThrow(RestoreError);
    for (const original of originals) {
      expect(readFileSync(join(dir, original.name))).toEqual(original.bytes);
      expect(statSync(join(dir, original.name)).ino).toBe(original.ino);
    }
    expect(readdirSync(dir).sort()).toEqual(originals.map(({ name }) => name).sort());
    expect(existsSync(join(dir, "assets"))).toBe(false);
  } finally {
    lock.stdin.write("\n");
    lock.stdin.end();
    await lock.exited;
  }
}, 15_000);

test.skipIf(process.platform !== "win32")("보존 뒤 단계가 실패하면 오류가 보존 폴더 경로를 알리고 원본은 그 폴더에 남는다", async () => {
  const e = makeEnv();
  tempDirs.push(e.dir);
  const { roundDir } = await runBackupRound(depsOf(e));
  e.db.close();
  const { dir } = makeWalTempDir("bara-restore-after-preserve-");
  tempDirs.push(dir);
  const originalDb = writeExistingDatabase(join(dir, "bara.sqlite"));
  const contentDir = join(dir, "assets", "content");
  mkdirSync(contentDir, { recursive: true });
  const lockedAsset = join(contentDir, TEST_ASSET_NAME);
  writeFileSync(lockedAsset, "png-bytes");
  // 보존 단계는 자산을 옮기지 않으므로, 덮어쓸 자산 파일을 잠그면 보존 이후의 자산 복사 단계가 실패한다.
  const lock = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
    "$f = [System.IO.File]::Open($env:BARA_RESTORE_LOCK_PATH, 'Open', 'Read', 'Read'); try { [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }",
  ], {
    env: { ...process.env, BARA_RESTORE_LOCK_PATH: lockedAsset },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    const ready = await lock.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    let caught: unknown;
    try { executeRestore(roundDir, join(e.backupDir, "assets-mirror"), dir); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RestoreError);
    const before = readdirSync(dir).filter((name) => name.startsWith("before-restore-"));
    expect(before.length).toBe(1);
    const beforeDir = join(dir, before[0]!);
    expect((caught as Error).message).toContain(beforeDir);
    expect(readFileSync(join(beforeDir, "bara.sqlite")).equals(originalDb)).toBe(true);
  } finally {
    lock.stdin.write("\n");
    lock.stdin.end();
    await lock.exited;
  }
}, 15_000);

test("백업 → 원본 변경 → 깨끗한 대상 복원 → 백업 시점 행 수로 되돌아온다", async () => {
  const e = makeEnv();
  tempDirs.push(e.dir);
  // 백업은 여기서 1행 시점을 담는다.
  const { roundDir } = await runBackupRound(depsOf(e));
  // 백업 이후 원본을 2행으로 바꿔, "복원이 백업 시점(1행)으로 실제로 되돌리는지"를
  // 삭제 성공 여부와 무관하게 판별할 수 있게 한다.
  e.db
    .prepare("INSERT INTO knowledge_nodes (content, memory_type, created_at) VALUES (?, ?, ?)")
    .run("복원으로 사라져야 할 글", "note", "2026-07-03 13:00:00");
  e.db.close();

  // 원본 DB 파일은 Windows native Bun 에서 sqlite-vec 핸들 해제가 프로세스 종료까지
  // 지연될 수 있다. 운영 복원은 서버 프로세스가 완전히 내려간 뒤 수행하므로, 테스트는
  // 별도 복구 디렉터리에 낡은 파일을 두고 그 파일이 스냅샷으로 덮이는지 검증한다.
  const { dir: restoreDir } = makeWalTempDir("bara-restore-roundtrip-");
  tempDirs.push(restoreDir);
  await Bun.write(join(restoreDir, "bara.sqlite"), "stale-db");
  await Bun.write(join(restoreDir, "bara.sqlite-wal"), "stale-wal");
  await Bun.write(join(restoreDir, "bara.sqlite-shm"), "stale-shm");

  const out = executeRestore(roundDir, join(e.backupDir, "assets-mirror"), restoreDir);
  // bara.sqlite + memory-settings.json + secrets.json = 3 (sse 토큰은 백업에 부재).
  expect(out.files).toBeGreaterThanOrEqual(2);
  expect(out.assets).toBe(1);

  // 복원 후 1행 — 백업 이후 넣은 2번째 행이 사라졌다 = 스냅샷을 실제로 덮어썼다.
  const restoredDbPath = join(restoreDir, "bara.sqlite");
  expect(existsSync(restoredDbPath + "-wal")).toBe(false);
  expect(existsSync(restoredDbPath + "-shm")).toBe(false);
  const db = new Database(restoredDbPath, { readonly: true });
  expect(
    (db.prepare("SELECT COUNT(*) AS c FROM knowledge_nodes").get() as { c: number }).c,
  ).toBe(1);
  db.close();

  expect(existsSync(join(restoreDir, "assets", "content", TEST_ASSET_NAME))).toBe(true);
  expect(existsSync(join(restoreDir, "memory-settings.json"))).toBe(true);
  expect(existsSync(join(restoreDir, "secrets.json"))).toBe(true);
});

test("복원은 목적지의 낡은 -wal/-shm 사이드파일을 제거한다", async () => {
  const e = makeEnv();
  tempDirs.push(e.dir);
  const { roundDir } = await runBackupRound(depsOf(e));
  e.db.close();

  // 별도의 깨끗한 dataDir 로 복원한다 — 원본 DB 핸들(Windows 지연 해제)과 얽히지
  // 않으면서 "복원이 목적지의 낡은 사이드파일을 남기지 않는지"만 순수하게 본다.
  const { dir: destDir } = makeWalTempDir("bara-restore-dest-");
  tempDirs.push(destDir);
  const destDb = join(destDir, "bara.sqlite");
  // 복원 전 낡은 사이드파일이 목적지에 남아 있으면 새 DB 와 어긋난 트랜잭션을
  // 되살릴 수 있어 복원이 반드시 지워야 한다. 손작성으로 잔재를 만들어 둔다.
  Bun.write(destDb + "-wal", "stale-wal");
  Bun.write(destDb + "-shm", "stale-shm");

  executeRestore(roundDir, join(e.backupDir, "assets-mirror"), destDir);

  expect(existsSync(destDb + "-wal")).toBe(false);
  expect(existsSync(destDb + "-shm")).toBe(false);
  const db = new Database(destDb, { readonly: true });
  expect(
    (db.prepare("SELECT COUNT(*) AS c FROM knowledge_nodes").get() as { c: number }).c,
  ).toBe(1);
  db.close();
});

test("이미 있는 복원 폴더·자산 폴더를 `..` 가 든 상대 경로(../dest)로 줘도 복원한다 — Bun 1.3.6 / Windows mkdir EEXIST 회귀", async () => {
  const e = makeEnv();
  tempDirs.push(e.dir);
  const { roundDir } = await runBackupRound(depsOf(e));
  e.db.close();

  const { dir: base } = makeWalTempDir("bara-restore-rel-");
  tempDirs.push(base);
  mkdirSync(join(base, "dest", "assets", "content"), { recursive: true });
  mkdirSync(join(base, "cwd"));
  const before = process.cwd();
  process.chdir(join(base, "cwd"));
  let out = { files: 0, assets: 0 };
  try {
    out = executeRestore(roundDir, join(e.backupDir, "assets-mirror"), "../dest");
  } finally {
    process.chdir(before);
  }
  expect(out.assets).toBe(1);
  expect(existsSync(join(base, "dest", "bara.sqlite"))).toBe(true);
  expect(existsSync(join(base, "dest", "assets", "content", TEST_ASSET_NAME))).toBe(true);
});

test("planRestore 는 스냅샷·설정·자산을 나열한다", async () => {
  const e = makeEnv();
  tempDirs.push(e.dir);
  const { roundDir } = await runBackupRound(depsOf(e));
  e.db.close();

  const plan = planRestore(roundDir);
  expect(plan.snapshotFile).toBe("bara.sqlite");
  expect(plan.extraFiles).toContain("memory-settings.json");
  expect(plan.extraFiles).toContain("secrets.json");
  // 스냅샷·manifest 는 extraFiles 에 섞이지 않는다.
  expect(plan.extraFiles).not.toContain("bara.sqlite");
  expect(plan.assetsToRestore).toEqual([TEST_ASSET_NAME]);
});

test("짝 표가 없는 스냅샷은 그 SQLite 오류를 담은 RestoreError 로 거부하고 대상은 그대로 둔다", async () => {
  const e = makeEnv();
  tempDirs.push(e.dir);
  // 기준 스키마는 짝 표를 늘 갖는다 — 손상·손으로 지운 경우를 재현하려고 백업 전에 표를 지운다.
  e.db.run("DROP TABLE asset_folder_pairing");
  const { roundDir } = await runBackupRound(depsOf(e));
  e.db.close();
  const { dir: restoreDir } = makeWalTempDir("bara-restore-no-pairing-");
  tempDirs.push(restoreDir);
  await Bun.write(join(restoreDir, "bara.sqlite"), "existing");

  expect(() => executeRestore(roundDir, join(e.backupDir, "assets-mirror"), restoreDir)).toThrow(
    "의 DB·첨부 폴더 짝 표를 읽을 수 없다: no such table: asset_folder_pairing",
  );
  expect(await Bun.file(join(restoreDir, "bara.sqlite")).text()).toBe("existing");
});

test("manifest 없는 회차 = RestoreError 거부", () => {
  const { dir } = makeWalTempDir("bara-restore-bad-");
  tempDirs.push(dir);
  expect(() => planRestore(dir)).toThrow(RestoreError);
});

test("스냅샷(.sqlite) 없는 회차 = RestoreError 거부", () => {
  const { dir } = makeWalTempDir("bara-restore-nosnap-");
  tempDirs.push(dir);
  // manifest 는 있으나 files 에 .sqlite 가 없는 손상 회차 — 무효로 거부해야 한다.
  mkdirSync(dir, { recursive: true });
  Bun.write(
    join(dir, "manifest.json"),
    JSON.stringify({
      timestamp: "2026-07-03 04:00:00",
      epochMs: 0,
      appVersion: "0.1.0",
      schemaVersion: 1,
      files: [{ name: "memory-settings.json", bytes: 2 }],
      assets: [],
      durationMs: 1,
    }),
  );
  expect(() => planRestore(dir)).toThrow(RestoreError);
});
