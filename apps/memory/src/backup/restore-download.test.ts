import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { strToU8, unzipSync, zipSync, type Unzipped } from "fflate";
import { BASELINE_VERSION } from "../db/baseline-schema.ts";
import { CURRENT_SCHEMA_VERSION } from "../db/migrations.ts";
import { cleanupTempDir, makeWalTempDir } from "../db/wal-test-helpers.ts";
import { registerBackupRoutes } from "../server-internal/routes/backup.ts";
import { makeEnv, depsOf } from "./backup-test-env.ts";
import { runBackupRound } from "./backup-runner.ts";
import { executeRestore, planRestore, RestoreError } from "./restore.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanupTempDir(dirs.pop()!); });

async function download(settings?: unknown) {
  const env = makeEnv();
  dirs.push(env.dir);
  if (settings) writeFileSync(env.settingsPath, JSON.stringify(settings));
  const app = new Hono();
  registerBackupRoutes(app, {
    store: { getRawDb: () => env.db },
    backup: {
      backupDir: env.backupDir, dbPath: env.file, settingsFilePath: env.settingsPath,
      appVersion: "0.1.0", schemaVersion: CURRENT_SCHEMA_VERSION,
    },
  } as never);
  try {
    const res = await app.request("/backup/download");
    expect(res.status).toBe(200);
    const zip = new Uint8Array(await res.arrayBuffer());
    const path = join(env.dir, "download.zip");
    writeFileSync(path, zip);
    return { path, entries: unzipSync(zip), dir: env.dir };
  } finally { env.db.close(); }
}

test("실제 다운로드 ZIP의 DB 행·설정을 새 위치에 복원하고 자산·키는 만들지 않는다", async () => {
  const source = await download({ time: { zone: "Asia/Seoul" }, db: { path: "/original/bara.sqlite" }, assets: { dir: "/original/assets" }, backup: { dir: "/original/backups" } });
  const sourceSettings = source.entries["memory-settings.json"]!.slice();
  const target = join(source.dir, "restored");
  expect(planRestore(source.path).snapshotFile).toBe("bara.sqlite");
  expect(executeRestore(source.path, "unused-mirror", target)).toEqual({ files: 2, assets: 0 });
  const restored = new Database(join(target, "bara.sqlite"), { readonly: true });
  try {
    expect(restored.query("SELECT content FROM knowledge_nodes").get()).toEqual({ content: "백업 검증 글" });
  } finally { restored.close(); }
  const settings = JSON.parse(readFileSync(join(target, "memory-settings.json"), "utf8"));
  expect(settings.time.zone).toBe("Asia/Seoul");
  expect(settings.db.path).toBe(join(target, "bara.sqlite"));
  expect(settings.assets.dir).toBe(join(target, "assets"));
  expect(settings.backup.dir).toBe(join(target, "backups"));
  expect(unzipSync(readFileSync(source.path))["memory-settings.json"]).toEqual(sourceSettings);
  expect(existsSync(join(target, "assets"))).toBe(false);
  expect(existsSync(join(target, "secrets.json"))).toBe(false);
  expect(existsSync(join(target, "sse-tokens.json"))).toBe(false);
});

test("다운로드는 설정에 남아 있던 API 키도 제거한다", async () => {
  const source = await download({ time: { zone: "Asia/Seoul" }, llm: { extractor: { anthropicApiKey: "private-fixture-key" } } });
  expect(new TextDecoder().decode(source.entries["memory-settings.json"])).not.toContain("private-fixture-key");
});

test("예전 contents manifest 다운로드도 지원한다", async () => {
  const source = await download();
  source.entries["manifest.json"] = strToU8(JSON.stringify({
    timestamp: "2026-07-03T10-00-00-000Z", appVersion: "0.1.0",
    schemaVersion: CURRENT_SCHEMA_VERSION, contents: ["bara.sqlite", "memory-settings.json"],
  }));
  writeFileSync(source.path, zipSync(source.entries));
  const target = join(source.dir, "legacy-restored");
  expect(executeRestore(source.path, "", target).files).toBe(2);
  const settings = JSON.parse(readFileSync(join(target, "memory-settings.json"), "utf8"));
  expect(settings.db?.path).toBe(join(target, "bara.sqlite"));
  expect(settings.assets?.dir).toBe(join(target, "assets"));
  expect(settings.backup?.dir).toBe(join(target, "backups"));
});

const invalidArchives: [string, (entries: Unzipped) => void][] = [
  ["누락 DB", (e) => { delete e["bara.sqlite"]; }],
  ["깨진 DB", (e) => { e["bara.sqlite"] = strToU8("not sqlite"); }],
  ["설정 배열", (e) => { e["memory-settings.json"] = strToU8("[]"); }],
  ["잘못된 설정 필드", (e) => { e["memory-settings.json"] = strToU8('{"db":{"port":"wrong"}}'); }],
  ["잘못된 manifest", (e) => { e["manifest.json"] = strToU8("{}"); }],
  ["스키마 불일치", (e) => {
    const m = JSON.parse(new TextDecoder().decode(e["manifest.json"]));
    m.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
    e["manifest.json"] = strToU8(JSON.stringify(m));
  }],
  ["기준 스키마 이전 표기", (e) => {
    const m = JSON.parse(new TextDecoder().decode(e["manifest.json"]));
    m.schemaVersion = BASELINE_VERSION - 1;
    e["manifest.json"] = strToU8(JSON.stringify(m));
  }],
  ["manifest와 다른 DB 버전", (e) => {
    // manifest 는 그대로(지원 범위 안) 두고 DB 의 schema_version 만 다른 값으로 바꾼다.
    const db = Database.deserialize(e["bara.sqlite"]!);
    try {
      db.run("DELETE FROM schema_version");
      db.query("INSERT INTO schema_version (version) VALUES (?)").run(CURRENT_SCHEMA_VERSION + 1);
      e["bara.sqlite"] = new Uint8Array(db.serialize());
    } finally { db.close(); }
  }],
  ["상위 경로", (e) => { e["../outside.txt"] = strToU8("escape"); }],
  ["Windows 경로", (e) => { e["C:\\outside.txt"] = strToU8("escape"); }],
  ["비밀 파일", (e) => { e["secrets.json"] = strToU8('{"key":"secret"}'); }],
];
test.each(invalidArchives)("ZIP %s는 대상 생성 전에 거부한다", async (_name, mutate) => {
  const source = await download();
  mutate(source.entries);
  writeFileSync(source.path, zipSync(source.entries));
  const target = join(source.dir, "invalid-target");
  expect(() => executeRestore(source.path, "", target)).toThrow(RestoreError);
  expect(existsSync(target)).toBe(false);
  expect(existsSync(join(source.dir, "outside.txt"))).toBe(false);
});

test("기준 스키마 이전 백업은 옛 앱 버전으로만 복원하라는 문구로 거부한다", async () => {
  const source = await download();
  const m = JSON.parse(new TextDecoder().decode(source.entries["manifest.json"]));
  m.schemaVersion = BASELINE_VERSION - 1;
  source.entries["manifest.json"] = strToU8(JSON.stringify(m));
  writeFileSync(source.path, zipSync(source.entries));
  expect(() => planRestore(source.path)).toThrow(
    `복원 거부 — 새로 시작(기준 스키마 v${BASELINE_VERSION}) 이전 백업이라 이 버전으로 열 수 없다. 옛 앱 버전으로만 복원한다.`,
  );
});

test("다운로드 ZIP은 기존 대상 파일을 덮어쓰지 않는다", async () => {
  const source = await download();
  const { dir: target } = makeWalTempDir("bara-download-existing-");
  dirs.push(target);
  writeFileSync(join(target, "bara.sqlite"), "existing");
  expect(() => executeRestore(source.path, "", target)).toThrow(/비어/);
  expect(readFileSync(join(target, "bara.sqlite")).equals(Buffer.from("existing"))).toBe(true);
});

test("ZIP의 중복 파일명도 거부한다", async () => {
  const source = await download();
  source.entries["cara.sqlite"] = source.entries["bara.sqlite"]!;
  const bytes = Buffer.from(zipSync(source.entries));
  let at = bytes.indexOf("cara.sqlite");
  while (at >= 0) {
    bytes.write("bara.sqlite", at);
    at = bytes.indexOf("cara.sqlite", at + 11);
  }
  writeFileSync(source.path, bytes);
  expect(() => planRestore(source.path)).toThrow(RestoreError);
});

test("실제 CLI는 서버 정지와 명시 확인 후 ZIP을 새 폴더에 복원한다", async () => {
  const source = await download();
  const target = join(source.dir, "cli-restored");
  const settingsPath = join(source.dir, "cli-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ db: { path: join(source.dir, "original.sqlite") } }));
  const service = Bun.serve({ port: 0, fetch: () => new Response("healthy") });
  const port = service.port!;
  const args = [process.execPath, join(import.meta.dir, "../../scripts/restore-backup.ts"), source.path, "--data-dir", target, "--port", String(port)];
  const env = { ...process.env, MEMORY_SETTINGS_PATH: settingsPath, MEMORY_DB_PATH: join(source.dir, "original.sqlite"), BARA_SECRETS_PATH: join(source.dir, "cli-secrets.json"), SSE_TOKEN_PATH: join(source.dir, "cli-tokens.json") };
  try {
    // Async subprocess lets the parent answer the health request.
    const child = Bun.spawn([...args, "--yes"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("서버가 살아있다");
    expect(existsSync(target)).toBe(false);
  } finally { service.stop(true); }
  const unconfirmed = Bun.spawnSync(args, { env });
  expect(unconfirmed.exitCode).toBe(1);
  expect(existsSync(target)).toBe(false);
  const confirmed = Bun.spawnSync([...args, "--yes"], { env });
  expect(confirmed.exitCode).toBe(0);
  expect(confirmed.stdout.toString()).toContain("다운로드 ZIP");
  expect(confirmed.stdout.toString()).toContain("문서 원본");
  const restored = new Database(join(target, "bara.sqlite"), { readonly: true });
  try { expect(restored.query("SELECT count(*) AS n FROM knowledge_nodes").get()).toEqual({ n: 1 }); }
  finally { restored.close(); }
  expect(JSON.parse(readFileSync(settingsPath, "utf8")).db.path).toBe(join(source.dir, "original.sqlite"));
}, 10000);

test("회차의 자산 누락·경로 탈출은 기존 DB를 바꾸기 전에 거부한다", async () => {
  const e = makeEnv();
  dirs.push(e.dir);
  const { roundDir, manifest } = await runBackupRound(depsOf(e));
  e.db.close();
  const { dir: target } = makeWalTempDir("bara-round-preflight-");
  dirs.push(target);
  writeFileSync(join(target, "bara.sqlite"), "existing");
  expect(() => executeRestore(roundDir, join(e.dir, "missing-mirror"), target)).toThrow(RestoreError);
  expect(readFileSync(join(target, "bara.sqlite")).equals(Buffer.from("existing"))).toBe(true);
  manifest.files.push({ name: "../outside.txt", bytes: 1 });
  writeFileSync(join(roundDir, "manifest.json"), JSON.stringify(manifest));
  expect(() => planRestore(roundDir)).toThrow(RestoreError);
});

test("자산 대상이 폴더가 아니면 서버 회차도 DB 복사 전에 거부한다", async () => {
  const e = makeEnv();
  dirs.push(e.dir);
  const { roundDir } = await runBackupRound(depsOf(e));
  e.db.close();
  const { dir: target } = makeWalTempDir("bara-round-bad-target-");
  dirs.push(target);
  writeFileSync(join(target, "bara.sqlite"), "existing");
  writeFileSync(join(target, "assets"), "not-directory");
  expect(() => executeRestore(roundDir, join(e.backupDir, "assets-mirror"), target)).toThrow(RestoreError);
  expect(readFileSync(join(target, "bara.sqlite")).equals(Buffer.from("existing"))).toBe(true);
});
