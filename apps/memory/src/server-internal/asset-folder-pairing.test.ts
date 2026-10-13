/**
 * asset-folder-pairing.test.ts — DB·첨부 폴더 짝 확인 뒤에만 시작 정리가 그 폴더의 파일을 지운다(WP-B1-20U 설계 17.19,
 * 결정 D39·D40·D41, 단계 U11a).
 *
 * 재QA2 재현(먼저 옮긴 빨간 테스트): 빈 :memory: DB 로 createMemoryApi 를 부르면, 짝 표시 없이 content/ 에 `{sha}.pdf` 가
 * 있는 첨부 폴더의 그 파일을 시작 때 content/ 훑기가 모두 지웠다(설정의 운영 폴더를 고른 부팅 테스트가 운영 첨부 파일을
 * 지운 Critical). 이제 createMemoryApi 는 넘긴 assetDir 만 쓰고, 정리 전에 짝을 판정해 S1·S2 로 멈춘다 — 파일 바이트가
 * 그대로이고 짝 표시 파일도 생기지 않는다.
 *
 * 이어서 시작 규칙표(설계 2)의 줄을 installAssetFileRemover 로 돈다 — 실제 파일 DB 를 닫았다 다시 열어 재시작을 흉내 내고,
 * 짝 표시는 실제 파일이다. 짝이 맞을 때만 훑기가 행 없는 파일을 지우고, 멈춘 저장소의 영구 삭제는 파일을 지우지 못하며,
 * 두 서버가 한 빈 폴더를 동시에 잡으면 하나만 짝을 맺는다. 데이터 초기화(실제 POST /admin/reset-memory)와 회차 복원(실제
 * runBackupRound → executeRestore)은 짝을 지킨다(설계 3).
 *
 * 실제 SQLite(파일·:memory:) + 실제 bge-m3 + 임시 폴더의 실제 AssetStore + 실제 Hono 라우트. mock 0.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ASSET_PAIRING_FILE_NAME, AssetFolderPairingError, createAssetFolderMarker } from "../assets/asset-folder-pairing.ts";
import { AssetStore, assetSha256 } from "../assets/asset-store.ts";
import { runBackupRound } from "../backup/backup-runner.ts";
import { depsOf, makeEnv } from "../backup/backup-test-env.ts";
import { executeRestore, RestoreError } from "../backup/restore.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { AssetFolderPairingRepository } from "../db/store-internal/asset-folder-pairing-repository.ts";
import { ASSET_FILE_REMOVER_MISSING } from "../db/store-internal/asset-release.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { cleanupTempDir } from "../db/wal-test-helpers.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { ContextAssembler } from "../memory/context-assembler.ts";
import { HybridRetriever } from "../memory/retriever.ts";
import { buildMemoryApi, createMemoryApi } from "../server.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import { EXPECTED_PAIRING_STOP, EXPECTED_RESTORE_PAIRING_MISMATCH } from "../test-utils/asset-folder-pairing-expected.ts";
import { ensureAssetFolderPairing, installAssetFileRemover } from "./asset-file-remover-boot.ts";

const JSON_HEADERS = { "content-type": "application/json" };
const NOTE_TXT = "주말 등산 계획\n\n토요일 아침 여덟시에 북한산 입구에서 만난다. 점심은 각자 준비한다.";
const OTHER_ID = "12345678-9abc-4def-8123-456789abcdef";
const CREATED_AT = "2026-10-02 09:00:00";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
}, 180_000);

const dirs: string[] = [];
const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const sha = (seed: string) => assetSha256(new TextEncoder().encode(seed));

function writeContent(assetDir: string, name: string, body = `bytes of ${name}`): void {
  mkdirSync(join(assetDir, "content"), { recursive: true });
  writeFileSync(join(assetDir, "content", name), body);
}

/** content/ 의 이름 → 바이트(base64). content/ 가 없으면 빈 객체. */
function contentSnapshot(assetDir: string): Record<string, string> {
  const contentDir = join(assetDir, "content");
  if (!existsSync(contentDir)) return {};
  const out: Record<string, string> = {};
  for (const name of readdirSync(contentDir).sort()) out[name] = readFileSync(join(contentDir, name)).toString("base64");
  return out;
}

function placeMarker(assetDir: string, pairingId: string): void {
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(join(assetDir, ASSET_PAIRING_FILE_NAME), JSON.stringify({ format: 1, pairingId, createdAt: CREATED_AT }));
}

/** 폴더 표시 파일의 원문. 없으면 null. */
function markerText(assetDir: string): string | null {
  const path = join(assetDir, ASSET_PAIRING_FILE_NAME);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function markerId(assetDir: string): string | null {
  const text = markerText(assetDir);
  return text === null ? null : (JSON.parse(text) as { pairingId: string }).pairingId;
}

const dbPairingId = (db: Database) => new AssetFolderPairingRepository(db).getPairingIdSync();

interface Boot { db: Database; store: SqliteMemoryStore; assetStore: AssetStore }

/** 실제 파일(또는 :memory:) DB 를 연다 — 같은 파일을 닫았다 다시 열면 서버 재시작과 같다. */
function openBoot(dbFile: string, assetDir: string): Boot {
  const db = openMemoryDatabase(dbFile, { embeddingDim: 1024 });
  openDbs.push(db);
  return { db, store: new SqliteMemoryStore(db, embedder), assetStore: new AssetStore(assetDir) };
}

function close(boot: Boot): void {
  openDbs.splice(openDbs.indexOf(boot.db), 1);
  boot.db.close();
}

function newDbFile(): string {
  return join(tempDir("bara-pairing-db-"), "bara.sqlite");
}

/** work 가 AssetFolderPairingError 로 멈추는지 보고 그 오류를 돌려준다. */
async function stopOf(work: Promise<unknown>): Promise<AssetFolderPairingError> {
  let caught: unknown = null;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AssetFolderPairingError);
  return caught as AssetFolderPairingError;
}

/** 새 파일 DB 를 assetDir 와 짝지은 뒤 닫는다. 반환 = DB 파일, 짝 번호. */
async function pairedDb(assetDir: string): Promise<{ file: string; pairingId: string }> {
  const file = newDbFile();
  const boot = openBoot(file, assetDir);
  await installAssetFileRemover(boot.store, boot.assetStore);
  const pairingId = dbPairingId(boot.db)!;
  close(boot);
  return { file, pairingId };
}

/** createMemoryApi 부팅 옵션 — 토큰·설정·백업 파일도 임시 폴더라 운영 파일(env SSE_TOKEN_PATH 등)에 닿지 않는다. */
function bootOptions(assetDir: string) {
  const files = tempDir("bara-pairing-files-");
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.reranker.enabled = false;
  settings.db.embeddingModel = "bge-m3";
  settings.backup.dir = join(files, "backups");
  return {
    dbPath: ":memory:", assetDir, llmProvider: "none" as const, settings,
    sseTokenFilePath: join(files, "sse-tokens.json"), settingsFilePath: join(files, "memory-settings.json"),
  };
}

function appOf(boot: Boot) {
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  return buildMemoryApi({
    store: boot.store, retriever: new HybridRetriever(boot.store, embedder), assembler: new ContextAssembler(),
    assetStore: boot.assetStore, getSettings: () => settings,
  });
}

async function uploadNote(app: ReturnType<typeof appOf>): Promise<{ nodeId: number; assetSha256: string }> {
  const res = await app.request("/ingest", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      source: "dashboard:manual",
      content: { type: "text", data: NOTE_TXT, mimeType: "text/plain", originalName: "hiking.txt" },
      attribution: { author: "owner", userId: "user-1" },
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { nodeIds: number[]; assetSha256: string };
  return { nodeId: body.nodeIds[0]!, assetSha256: body.assetSha256 };
}

describe("재QA2 재현 — createMemoryApi 는 넘긴 폴더만 쓰고, 짝이 아니면 아무것도 지우지 않고 멈춘다", () => {
  test("빈 :memory: DB + 짝 표시 없이 content/ 에 파일 -> S1, 네 파일 바이트 그대로, 표시 안 생김; 다른 번호 표시 -> S2", async () => {
    const assetDir = tempDir("bara-pairing-repro-");
    for (const seed of ["one", "two", "three"]) writeContent(assetDir, `${sha(seed)}.pdf`);
    writeContent(assetDir, "README-user-note.txt", "user note");
    const before = contentSnapshot(assetDir);
    expect(Object.keys(before)).toHaveLength(4);

    const s1 = await stopOf(createMemoryApi(bootOptions(assetDir)));
    expect(s1.reason).toBe("S1");
    expect(s1.message).toBe(EXPECTED_PAIRING_STOP.S1);
    expect(contentSnapshot(assetDir)).toEqual(before);
    expect(markerText(assetDir)).toBeNull();

    placeMarker(assetDir, OTHER_ID);
    const marker = markerText(assetDir);
    const s2 = await stopOf(createMemoryApi(bootOptions(assetDir)));
    expect(s2.reason).toBe("S2");
    expect(s2.message).toBe(EXPECTED_PAIRING_STOP.S2);
    expect(contentSnapshot(assetDir)).toEqual(before);
    expect(markerText(assetDir)).toBe(marker);
  }, 120_000);
});

describe("시작 규칙표 — installAssetFileRemover, 실제 파일 DB 재시작", () => {
  test("빈 DB + 아직 없는 폴더 -> 새 짝(DB 행과 표시가 같은 번호), 다시 시작하면 짝이 맞아 행 없는 파일을 지운다", async () => {
    const assetDir = join(tempDir("bara-pairing-new-"), "assets");
    const file = newDbFile();
    const first = openBoot(file, assetDir);
    expect(await ensureAssetFolderPairing(first.store, first.assetStore)).toBe("paired-new");
    const pairingId = dbPairingId(first.db);
    expect(pairingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(JSON.parse(markerText(assetDir)!)).toMatchObject({ format: 1, pairingId });
    close(first);

    const stray = `${sha("stray")}.pdf`;
    writeContent(assetDir, stray);
    const restart = openBoot(file, assetDir);
    expect(await ensureAssetFolderPairing(restart.store, restart.assetStore)).toBe("matched");
    const boot = await installAssetFileRemover(restart.store, restart.assetStore);
    expect(boot.strayFiles.removed).toEqual([stray]);
    expect(contentSnapshot(assetDir)).toEqual({});
    expect(dbPairingId(restart.db)).toBe(pairingId);
  }, 120_000);

  test("빈 DB + 표시 없이 항목 -> S1: DB 행·표시를 쓰지 않고 파일이 그대로", async () => {
    const assetDir = tempDir("bara-pairing-s1-");
    writeContent(assetDir, `${sha("foreign")}.pdf`);
    const before = contentSnapshot(assetDir);
    const boot = openBoot(newDbFile(), assetDir);
    const stop = await stopOf(installAssetFileRemover(boot.store, boot.assetStore));
    expect(stop.message).toBe(EXPECTED_PAIRING_STOP.S1);
    expect(dbPairingId(boot.db)).toBeNull();
    expect(markerText(assetDir)).toBeNull();
    expect(contentSnapshot(assetDir)).toEqual(before);
  }, 120_000);

  test("Q8: 빈 DB + 다른 번호 표시만 있는 빈 폴더 -> S2, DB 행을 쓰지 않는다", async () => {
    const assetDir = tempDir("bara-pairing-q8-");
    placeMarker(assetDir, OTHER_ID);
    mkdirSync(join(assetDir, "content"));
    const boot = openBoot(newDbFile(), assetDir);
    const stop = await stopOf(installAssetFileRemover(boot.store, boot.assetStore));
    expect(stop.message).toBe(EXPECTED_PAIRING_STOP.S2);
    expect(dbPairingId(boot.db)).toBeNull();
    expect(markerId(assetDir)).toBe(OTHER_ID);
  }, 120_000);

  test("S3: 짝 행 없는 DB 에 asset_files 행(SQL) -> 폴더가 비었든 표시가 있든 S3, 문구에 행 수", async () => {
    const file = newDbFile();
    const seed = openBoot(file, tempDir("bara-pairing-s3-unused-"));
    for (const name of ["sha_1", "sha_2"]) {
      seed.db.run(
        "INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at) VALUES (?, 'text', ?, 10, ?)",
        [name, `/x/${name}.md`, CREATED_AT],
      );
    }
    close(seed);

    const emptyDir = join(tempDir("bara-pairing-s3-"), "assets");
    const markedDir = tempDir("bara-pairing-s3-marked-");
    placeMarker(markedDir, OTHER_ID);
    for (const assetDir of [emptyDir, markedDir]) {
      const boot = openBoot(file, assetDir);
      const stop = await stopOf(installAssetFileRemover(boot.store, boot.assetStore));
      expect(stop.message).toBe(EXPECTED_PAIRING_STOP.S3(2));
      expect(dbPairingId(boot.db)).toBeNull();
      close(boot);
    }
    expect(existsSync(emptyDir)).toBe(false);
    expect(markerId(markedDir)).toBe(OTHER_ID);
  }, 120_000);

  test("짝 X + 빈 폴더(새 폴더로 바꾼 경우) -> 폴더에 X 를 적고 진행", async () => {
    const { file, pairingId } = await pairedDb(tempDir("bara-pairing-x-old-"));
    const newDir = join(tempDir("bara-pairing-x-new-"), "assets");
    const boot = openBoot(file, newDir);
    expect(await ensureAssetFolderPairing(boot.store, boot.assetStore)).toBe("marked-folder");
    expect(markerId(newDir)).toBe(pairingId);
    expect(dbPairingId(boot.db)).toBe(pairingId);
    await installAssetFileRemover(boot.store, boot.assetStore);
  }, 120_000);

  test("짝 X + 표시 없이 항목 -> S1, 파일 그대로", async () => {
    const { file } = await pairedDb(tempDir("bara-pairing-x1-old-"));
    const otherDir = tempDir("bara-pairing-x1-");
    writeContent(otherDir, `${sha("foreign")}.pdf`);
    const before = contentSnapshot(otherDir);
    const boot = openBoot(file, otherDir);
    expect((await stopOf(installAssetFileRemover(boot.store, boot.assetStore))).message).toBe(EXPECTED_PAIRING_STOP.S1);
    expect(contentSnapshot(otherDir)).toEqual(before);
    expect(markerText(otherDir)).toBeNull();
  }, 120_000);

  test("짝 X + 짝 Y -> S2 로 파일 그대로, 그 폴더의 짝 DB 로 시작할 때만 훑기가 행 없는 파일을 지운다", async () => {
    const dbX = await pairedDb(tempDir("bara-pairing-dirx-"));
    const dirY = tempDir("bara-pairing-diry-");
    const dbY = await pairedDb(dirY);
    expect(dbY.pairingId).not.toBe(dbX.pairingId);
    const stray = `${sha("rowless")}.pdf`;
    writeContent(dirY, stray);
    const before = contentSnapshot(dirY);

    const wrong = openBoot(dbX.file, dirY);
    expect((await stopOf(installAssetFileRemover(wrong.store, wrong.assetStore))).message).toBe(EXPECTED_PAIRING_STOP.S2);
    expect(contentSnapshot(dirY)).toEqual(before);
    expect(markerId(dirY)).toBe(dbY.pairingId);
    close(wrong);

    const right = openBoot(dbY.file, dirY);
    expect((await installAssetFileRemover(right.store, right.assetStore)).strayFiles.removed).toEqual([stray]);
    expect(contentSnapshot(dirY)).toEqual({});
  }, 120_000);

  test("읽을 수 없는 표시 -> 원인을 담은 S4, 파일 그대로", async () => {
    const file = newDbFile();
    const cases: Array<[string, (path: string) => void]> = [
      ["JSON 형식 오류", (path) => writeFileSync(path, "{format:1")],
      ["형식 번호 다름", (path) => writeFileSync(path, JSON.stringify({ format: 2, pairingId: OTHER_ID }))],
      ["짝 번호 모양 틀림", (path) => writeFileSync(path, JSON.stringify({ format: 1, pairingId: "not-a-uuid" }))],
      ["파일 자리가 디렉터리", (path) => mkdirSync(path)],
    ];
    for (const [cause, place] of cases) {
      const assetDir = tempDir("bara-pairing-s4-");
      writeContent(assetDir, `${sha("kept")}.pdf`);
      place(join(assetDir, ASSET_PAIRING_FILE_NAME));
      const before = contentSnapshot(assetDir);
      const boot = openBoot(file, assetDir);
      expect((await stopOf(installAssetFileRemover(boot.store, boot.assetStore))).message).toBe(EXPECTED_PAIRING_STOP.S4(cause));
      expect(dbPairingId(boot.db)).toBeNull();
      expect(contentSnapshot(assetDir)).toEqual(before);
      close(boot);
    }
  }, 120_000);

  test("폴더 값이 빈 문자열·공백 -> S5", async () => {
    for (const assetDir of ["", "  "]) {
      const boot = openBoot(":memory:", assetDir);
      const stop = await stopOf(installAssetFileRemover(boot.store, boot.assetStore));
      expect(stop.reason).toBe("S5");
      expect(stop.message).toBe(EXPECTED_PAIRING_STOP.S5);
      expect(dbPairingId(boot.db)).toBeNull();
    }
  }, 120_000);
});

describe("멈춘 저장소와 경쟁", () => {
  test("멈춘 뒤 그 저장소의 영구 삭제는 파일을 지우지 않고 failed 에 ASSET_FILE_REMOVER_MISSING", async () => {
    const assetDir = tempDir("bara-pairing-stopped-");
    writeContent(assetDir, `${sha("foreign")}.pdf`);
    const boot = openBoot(":memory:", assetDir);
    expect((await stopOf(installAssetFileRemover(boot.store, boot.assetStore))).reason).toBe("S1");

    const app = appOf(boot);
    const note = await uploadNote(app);
    const filePath = boot.assetStore.path(note.assetSha256, "txt");
    const before = contentSnapshot(assetDir);
    const res = await app.request(`/memories/${note.nodeId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assetCleanup: { removedSha256s: string[]; failed: unknown[] } };
    expect(body.assetCleanup.removedSha256s).toEqual([]);
    expect(body.assetCleanup.failed).toEqual([{ sha256: note.assetSha256, path: filePath, error: ASSET_FILE_REMOVER_MISSING }]);
    expect(contentSnapshot(assetDir)).toEqual(before);
  }, 120_000);

  test("두 서버(다른 DB)가 한 빈 폴더로 동시에 시작 -> 하나만 짝을 맺고 다른 하나는 S2, 진 쪽 DB 에는 행이 없다", async () => {
    const assetDir = join(tempDir("bara-pairing-race-"), "assets");
    const a = openBoot(newDbFile(), assetDir);
    const b = openBoot(newDbFile(), assetDir);
    const results = await Promise.allSettled([
      installAssetFileRemover(a.store, a.assetStore),
      installAssetFileRemover(b.store, b.assetStore),
    ]);
    const won = results.findIndex((r) => r.status === "fulfilled");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results[1 - won] as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(AssetFolderPairingError);
    expect((lost.reason as AssetFolderPairingError).message).toBe(EXPECTED_PAIRING_STOP.S2);
    const [winner, loser] = won === 0 ? [a, b] : [b, a];
    expect(markerId(assetDir)).toBe(dbPairingId(winner.db));
    expect(dbPairingId(loser.db)).toBeNull();
  }, 120_000);
});

describe("짝을 지키는 통로 — 데이터 초기화와 회차 복원(설계 3)", () => {
  test("실제 POST /admin/reset-memory 뒤 DB 행·표시 그대로 -> 다시 시작하면 짝이 맞다", async () => {
    const assetDir = tempDir("bara-pairing-reset-");
    const file = newDbFile();
    const boot = openBoot(file, assetDir);
    await installAssetFileRemover(boot.store, boot.assetStore);
    const pairingId = dbPairingId(boot.db);
    const marker = markerText(assetDir);
    const app = appOf(boot);
    await uploadNote(app);
    expect(Object.keys(contentSnapshot(assetDir))).toHaveLength(1);

    const res = await app.request("/admin/reset-memory", {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ confirm: "RESET ALL MEMORY" }),
    });
    expect(res.status).toBe(200);
    expect(contentSnapshot(assetDir)).toEqual({});
    expect(dbPairingId(boot.db)).toBe(pairingId);
    expect(markerText(assetDir)).toBe(marker);
    close(boot);

    const restart = openBoot(file, assetDir);
    expect(await ensureAssetFolderPairing(restart.store, restart.assetStore)).toBe("matched");
  }, 120_000);

  test("회차 복원: 새 dataDir 에는 복원한 DB 의 번호로 표시가 생기고, 다른 번호 폴더는 RestoreError·쓴 파일 0", async () => {
    const env = makeEnv();
    dirs.push(env.dir);
    new AssetFolderPairingRepository(env.db).insertPairingIfAbsentSync(OTHER_ID, CREATED_AT);
    createAssetFolderMarker(env.assetDir, { pairingId: OTHER_ID, createdAt: CREATED_AT });
    const { roundDir } = await runBackupRound(depsOf(env));
    env.db.close();
    const mirrorDir = join(env.backupDir, "assets-mirror");

    const freshDataDir = join(tempDir("bara-pairing-restore-"), "data");
    executeRestore(roundDir, mirrorDir, freshDataDir);
    expect(markerId(join(freshDataDir, "assets"))).toBe(OTHER_ID);
    const restored = openBoot(join(freshDataDir, "bara.sqlite"), join(freshDataDir, "assets"));
    expect(dbPairingId(restored.db)).toBe(OTHER_ID);
    expect(await ensureAssetFolderPairing(restored.store, restored.assetStore)).toBe("matched");

    const foreignDataDir = tempDir("bara-pairing-restore-foreign-");
    placeMarker(join(foreignDataDir, "assets"), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    const unmarkedDataDir = tempDir("bara-pairing-restore-unmarked-");
    writeContent(join(unmarkedDataDir, "assets"), `${sha("foreign")}.pdf`);
    for (const dataDir of [foreignDataDir, unmarkedDataDir]) {
      const listing = () => readdirSync(dataDir, { recursive: true }).map(String).sort();
      const before = listing();
      expect(() => executeRestore(roundDir, mirrorDir, dataDir)).toThrow(RestoreError);
      expect(() => executeRestore(roundDir, mirrorDir, dataDir)).toThrow(EXPECTED_RESTORE_PAIRING_MISMATCH);
      expect(listing()).toEqual(before);
    }
  }, 120_000);
});
