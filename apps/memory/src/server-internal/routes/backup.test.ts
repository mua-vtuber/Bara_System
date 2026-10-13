import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { Hono } from "hono";
import { CURRENT_SCHEMA_VERSION, openMemoryDatabase } from "../../db/migrations.ts";
import { makeWalTempDir, cleanupTempDir } from "../../db/wal-test-helpers.ts";
import { isPublicPath } from "../auth-gate-public-paths.ts";
import { resetBackupStatus } from "../../backup/backup-status.ts";
import { registerBackupRoutes } from "./backup.ts";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) cleanupTempDir(tempDirs.pop()!); });

// backup-status 는 프로세스 공유 싱글턴 — 다른 테스트 파일이 먼저 로드되며 남긴 상태가
// 여기 "이력 없음" 기대를 깨지 않게, 각 테스트 시작 전에 초기 가동 상태로 되돌린다.
beforeEach(resetBackupStatus);

test("공개 경로 아님 — 외곽 auth 게이트 보호 대상 (D2 401 근거)", () => {
  expect(isPublicPath("/backup/status")).toBe(false);
  expect(isPublicPath("/backup/download")).toBe(false);
});

function makeApp() {
  const { dir, file } = makeWalTempDir("bara-route-");
  tempDirs.push(dir);
  const db = openMemoryDatabase(file);
  db.prepare("INSERT INTO knowledge_nodes (content, memory_type, created_at) VALUES (?, ?, ?)")
    .run("다운로드 검증 글", "fact", "2026-07-03 12:00:00");
  const settingsPath = join(dir, "memory-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ time: { zone: "Asia/Seoul" } }));
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const app = new Hono({ strict: false });
  registerBackupRoutes(app, {
    store: { getRawDb: () => db } as never,
    backup: { backupDir, dbPath: file, settingsFilePath: settingsPath, appVersion: "0.1.0", schemaVersion: CURRENT_SCHEMA_VERSION },
  } as never);
  return { app, db };
}

test("GET /backup/status — 이력 없음 정직 표기", async () => {
  const { app } = makeApp();
  const res = await app.request("/backup/status");
  expect(res.status).toBe(200);
  const body = await res.json() as { lastResult: unknown; rounds: unknown[] };
  expect(body.lastResult).toBeNull();
  expect(body.rounds).toEqual([]);
});

test("GET /backup/download — zip 회신 + secrets 부재 + DB 스냅샷 유효", async () => {
  const { app } = makeApp();
  const res = await app.request("/backup/download");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("application/zip");
  const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const names = Object.keys(entries);
  expect(names).toContain("bara.sqlite");
  expect(names).toContain("memory-settings.json");
  expect(names).toContain("manifest.json");
  expect(names).not.toContain("secrets.json");
  expect(strFromU8(entries["memory-settings.json"]!)).toContain("Asia/Seoul");
  expect(entries["bara.sqlite"]!.length).toBeGreaterThan(0);
});

test("deps.backup 미주입 — 503 정직 실패", async () => {
  const app = new Hono({ strict: false });
  registerBackupRoutes(app, { store: {} } as never);
  expect((await app.request("/backup/status")).status).toBe(503);
  expect((await app.request("/backup/download")).status).toBe(503);
});
