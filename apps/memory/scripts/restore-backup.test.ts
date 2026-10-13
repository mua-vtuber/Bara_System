import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runBackupRound } from "../src/backup/backup-runner.ts";
import { depsOf, makeEnv } from "../src/backup/backup-test-env.ts";
import { RestoreError, type RestorePlan } from "../src/backup/restore.ts";
import { cleanupTempDir, makeWalTempDir } from "../src/db/wal-test-helpers.ts";
import {
  defaultRestoreDataDirForDbPath,
  effectiveRestoreDbPath,
  resolveRestoreDataDir,
} from "./restore-backup.ts";

const PLAN_BARA: RestorePlan = {
  snapshotFile: "bara.sqlite",
  extraFiles: [],
  assetsToRestore: [],
};

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) cleanupTempDir(tempDirs.pop()!);
});

async function runRestoreCli(roundDir: string, dataDir: string, yes = true) {
  const child = Bun.spawn([
    process.execPath, join(import.meta.dir, "restore-backup.ts"), roundDir,
    "--data-dir", dataDir, "--port", "0", ...(yes ? ["--yes"] : []),
  ], {
    cwd: dataDir,
    env: {
      ...process.env,
      MEMORY_SETTINGS_PATH: join(dataDir, "cli-settings.json"),
      BARA_SECRETS_PATH: join(dataDir, "cli-secrets.json"),
      MEMORY_DB_PATH: join(dataDir, "bara.sqlite"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

describe("restore-backup preservation output", () => {
  test("--yes 안내는 현재 DB의 before-restore 보존을 설명한다", async () => {
    const { dir } = makeWalTempDir("bara-restore-cli-gate-");
    tempDirs.push(dir);
    const result = await runRestoreCli(dir, dir, false);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("현재 DB 는 before-restore 폴더로 옮겨 보존한다");
    expect(result.stdout).not.toContain("되돌릴 수 없다");
  });

  for (const existingDb of [true, false]) {
    test(`서버 회차 복원 성공 시 ${existingDb ? "기존 DB 보존 경로를 출력한다" : "빈 대상의 보존 경로를 출력하지 않는다"}`, async () => {
      const e = makeEnv();
      tempDirs.push(e.dir);
      let roundDir: string;
      try {
        ({ roundDir } = await runBackupRound(depsOf(e)));
      } finally {
        e.db.close();
      }
      const { dir: dataDir, file } = makeWalTempDir("bara-restore-cli-output-");
      tempDirs.push(dataDir);
      if (existingDb) {
        const db = new Database(file);
        try {
          db.run("CREATE TABLE previous_state (content TEXT)");
          db.run("INSERT INTO previous_state VALUES ('before restore')");
        } finally {
          db.close();
        }
      }

      const result = await runRestoreCli(roundDir, dataDir);
      if (result.code !== 0) throw new Error(`Restore CLI failed (${result.code}): ${result.stderr}`);
      expect(result.stdout).toContain("[restore] 복원 완료");
      const preservedDirs = readdirSync(dataDir).filter((name) => name.startsWith("before-restore-"));
      expect(preservedDirs).toHaveLength(existingDb ? 1 : 0);
      if (existingDb) {
        expect(result.stdout).toContain(`[restore] 기존 파일 보존: ${join(dataDir, preservedDirs[0]!)}`);
        const db = new Database(join(dataDir, preservedDirs[0]!, "bara.sqlite"), { readonly: true });
        try {
          expect(db.query("SELECT content FROM previous_state").get()).toEqual({ content: "before restore" });
        } finally {
          db.close();
        }
      } else {
        expect(result.stdout).not.toContain("[restore] 기존 파일 보존:");
      }
    });
  }
});

describe("restore-backup target resolution", () => {
  test("다운로드 ZIP은 운영 경로 추론을 거부하고 --data-dir 를 요구한다", () => {
    expect(() => resolveRestoreDataDir(
      { dataDir: "data", dataDirExplicit: false },
      { ...PLAN_BARA, sourceFormat: "download-zip" },
      "data/bara.sqlite",
    )).toThrow(/--data-dir/);
  });
  test("MEMORY_DB_PATH 가 settings.db.path 보다 우선한다", () => {
    const settings = { db: { path: "settings/bara.sqlite" } };
    expect(effectiveRestoreDbPath(settings, "env/live.sqlite")).toBe("env/live.sqlite");
    expect(effectiveRestoreDbPath(settings, "   ")).toBe("settings/bara.sqlite");
  });

  test("기본 dataDir 는 파일 DB 경로의 부모이고 :memory: 는 기본 복원 대상이 없다", () => {
    expect(defaultRestoreDataDirForDbPath(join("data", "bara.sqlite"))).toBe(
      resolve("data"),
    );
    expect(defaultRestoreDataDirForDbPath(":memory:")).toBeNull();
    expect(defaultRestoreDataDirForDbPath("")).toBeNull();
  });

  test("기본 추론은 snapshot 파일명이 live DB 경로와 맞을 때만 허용한다", () => {
    const dbPath = join("data", "bara.sqlite");
    expect(
      resolveRestoreDataDir(
        { dataDir: resolve("data"), dataDirExplicit: false },
        PLAN_BARA,
        dbPath,
      ),
    ).toBe(resolve("data"));
  });

  test("기본 추론에서 snapshot 목적지가 live DB 와 다르면 RestoreError", () => {
    expect(() =>
      resolveRestoreDataDir(
        { dataDir: resolve("data"), dataDirExplicit: false },
        PLAN_BARA,
        join("custom", "live.sqlite"),
      ),
    ).toThrow(RestoreError);
  });

  test("--data-dir 명시는 snapshot/live DB 파일명 불일치를 의도한 리허설로 허용한다", () => {
    expect(
      resolveRestoreDataDir(
        { dataDir: "restore-target", dataDirExplicit: true },
        PLAN_BARA,
        join("custom", "live.sqlite"),
      ),
    ).toBe(resolve("restore-target"));
  });
});
