/**
 * asset-file-remover-boot.test.ts — 서버 시작 때 content/ 를 훑어 행 없는 파일을 지운다(WP-B1-20U 설계 17.18 설계 5, 결정 D31,
 * 단계 U10e).
 *
 * 재QA 재현(먼저 옮긴 빨간 테스트): content/ 에 asset_files 행이 없는 `{sha}.{ext}` 파일이 남아도 어떤 시작 정리도 보지 못했다 —
 * 저장에 실패한 첨부 바이트가 디스크에 그대로 남았다(행 없는 파일은 `/assets/:sha` 로 열리지 않아 아무도 모른다). 이제
 * installAssetFileRemover 가 시작 정리 마지막(쓰기 잠금 안)에 content/ 를 한 번 훑는다:
 *   - `.tmp-` 조각(쓰다 중단된 임시 파일), asset_files 행이 없는 `{64자 sha}.{ext}`, 행의 확장자와 다른 사본은 지운다.
 *   - 행이 있는 파일(행의 확장자와 같은 이름)과 알아볼 수 없는 이름은 건드리지 않고, 알아볼 수 없는 이름은 unrecognized 로 알린다.
 *   - 파일 자리의 디렉터리처럼 지우지 못하는 항목은 failed 에 이름·원인을 담고 지우지 않는다.
 *   - 훑기는 다른 쓰기 잠금 보유자가 놓은 뒤에 돈다. 결과는 { cleanup, strayFiles } 와 로그 줄로 알린다.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 임시 디렉터리의 실제 AssetStore + 실제 Hono 라우트(살아 있는 문서는 실제 /ingest 로
 * 만든다). 지울 파일은 content/ 에 직접 둔다. 모든 정리 뒤 계보·자산 불변식 도우미가 빈 목록이다. mock 0.
 */

import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ASSET_CONTENT_SUBDIR, AssetStore, assetSha256 } from "../assets/asset-store.ts";
import type { AssetCleanup } from "../assets/released-asset-files.ts";
import type { StrayFileSweep } from "../assets/stray-asset-files.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { ContextAssembler } from "../memory/context-assembler.ts";
import { HybridRetriever } from "../memory/retriever.ts";
import { withMemoryMutationLock } from "../memory/shared-memory-mutation-lock.ts";
import { buildMemoryApi } from "../server.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import { assetContentFiles, assetInvariantViolations } from "../test-utils/asset-invariant.ts";
import { lineageOrphans } from "../test-utils/lineage-invariant.ts";
import { installAssetFileRemover } from "./asset-file-remover-boot.ts";

const DASHBOARD_SOURCE = "dashboard:manual";
const ATTRIBUTION = { author: "owner", userId: "user-1" };
const JSON_HEADERS = { "content-type": "application/json" };
const LOCK_SETTLE_MS = 500;
const NOTE_TXT = "주말 등산 계획\n\n토요일 아침 여덟시에 북한산 입구에서 만난다. 점심은 각자 준비한다.";

const NO_STRAY_FILES: StrayFileSweep = { removed: [], failed: [], unrecognized: [] };
const NO_CLEANUP: AssetCleanup = { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] };
/** 서버가 쓰다 중단된 임시 조각의 접미사 형식(`.tmp-<pid>-<ms>`). */
const TMP_SUFFIX = ".tmp-4242-1790000000000";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
}, 180_000);

interface Harness { app: Hono; db: Database; store: SqliteMemoryStore; assetStore: AssetStore; dir: string }
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "bara-asset-boot-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const assetStore = new AssetStore(dir);
  await installAssetFileRemover(store, assetStore);
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
    assetStore, getSettings: () => settings,
  });
  const h = { app, db, store, assetStore, dir };
  harnesses.push(h);
  return h;
}

/** 살아 있는 문서 하나를 실제 /ingest 로 올린다 — content/ 에 `{sha}.txt` 와 그 행이 생긴다. */
async function uploadLiveNote(h: Harness): Promise<{ assetSha256: string }> {
  const res = await h.app.request("/ingest", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      source: DASHBOARD_SOURCE,
      content: { type: "text", data: NOTE_TXT, mimeType: "text/plain", originalName: "hiking.txt" },
      attribution: ATTRIBUTION,
    }),
  });
  expect(res.status).toBe(201);
  return { assetSha256: ((await res.json()) as { assetSha256: string }).assetSha256 };
}

const sha = (seed: string) => assetSha256(new TextEncoder().encode(seed));
const sorted = (names: readonly string[]) => [...names].sort();
const contentPath = (h: Harness, name: string) => join(h.dir, ASSET_CONTENT_SUBDIR, name);

function placeFile(h: Harness, name: string, body = "서버가 쓰지 않은 바이트"): void {
  mkdirSync(join(h.dir, ASSET_CONTENT_SUBDIR), { recursive: true });
  writeFileSync(contentPath(h, name), body);
}

/** 파일 자리를 차지한 디렉터리 — unlink 가 지우지 못한다. */
function placeDirectory(h: Harness, name: string): void {
  mkdirSync(contentPath(h, name), { recursive: true });
  writeFileSync(join(contentPath(h, name), "occupant.txt"), "자리 차지");
}

function removeEntries(h: Harness, names: readonly string[]): void {
  for (const name of names) rmSync(contentPath(h, name), { recursive: true, force: true });
}

/** work 를 돌리는 동안 console 의 한 함수가 받은 줄(인자를 이어 붙인 글). */
async function captureConsole<T>(method: "error" | "log" | "warn", work: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const spy = spyOn(console, method);
  try {
    const value = await work();
    return { value, lines: spy.mock.calls.map((args) => args.map(String).join(" ")) };
  } finally {
    spy.mockRestore();
  }
}

function expectInvariants(h: Harness): void {
  expect(lineageOrphans(h.db)).toEqual([]);
  expect(assetInvariantViolations(h.db, h.dir)).toEqual([]);
}

/** 서버가 만들 수 없는 이름 — 건드리지 않고 unrecognized 로 알린다. */
function unrecognizedNames(): string[] {
  return [
    "README.txt",
    ".gitkeep",
    `${sha("short").slice(0, 63)}.txt`,
    `${sha("uppercase").toUpperCase()}.txt`,
    `${sha("two-dots")}.tar.gz`,
    `${sha("backup")}.txt.bak`,
    sha("no-extension"),
  ];
}

describe("서버 시작 때 content/ 훑기", () => {
  test("재QA 재현: 행 없는 파일·다른 확장자 사본·.tmp- 조각은 지우고, 행 있는 파일과 알아볼 수 없는 이름은 둔다", async () => {
    const h = await makeHarness();
    const live = await uploadLiveNote(h);
    const liveName = `${live.assetSha256}.txt`;
    const liveBytes = readFileSync(contentPath(h, liveName));
    const strays = [
      `${sha("no-row")}.md`,
      `${sha("no-row-pdf")}.pdf`,
      `${live.assetSha256}.md`,
      `${sha("fragment")}.pdf${TMP_SUFFIX}`,
      `${live.assetSha256}.txt${TMP_SUFFIX}`,
    ];
    const unrecognized = unrecognizedNames();
    for (const name of [...strays, ...unrecognized]) placeFile(h, name);

    const boot = await installAssetFileRemover(h.store, h.assetStore);

    expect(boot.cleanup).toEqual(NO_CLEANUP);
    expect(boot.strayFiles).toEqual({ removed: sorted(strays), failed: [], unrecognized: sorted(unrecognized) });
    expect(assetContentFiles(h.dir)).toEqual(sorted([liveName, ...unrecognized]));
    expect(readFileSync(contentPath(h, liveName))).toEqual(liveBytes);
    expect(h.store.getAssetFile(live.assetSha256)?.assetPath).toBe(h.assetStore.path(live.assetSha256, "txt"));

    // 알아볼 수 없는 이름만 치우면 불변식이 선다 — 훑기가 행 있는 파일은 건드리지 않았다.
    removeEntries(h, unrecognized);
    expectInvariants(h);

    // 같은 상태로 다시 시작해도 더 지울 것이 없다(멱등).
    expect((await installAssetFileRemover(h.store, h.assetStore)).strayFiles).toEqual(NO_STRAY_FILES);
  }, 180_000);

  test("파일 자리의 디렉터리처럼 지우지 못하는 항목은 failed 에 이름과 원인을 담고 지우지 않는다", async () => {
    const h = await makeHarness();
    const live = await uploadLiveNote(h);
    const blockedStray = `${sha("blocked-stray")}.md`;
    const blockedFragment = `${sha("blocked-fragment")}.pdf${TMP_SUFFIX}`;
    const removableStray = `${sha("removable")}.png`;
    placeDirectory(h, blockedStray);
    placeDirectory(h, blockedFragment);
    placeFile(h, removableStray);

    const { value: boot, lines } = await captureConsole("error", () => installAssetFileRemover(h.store, h.assetStore));

    expect(boot.cleanup).toEqual(NO_CLEANUP);
    expect(boot.strayFiles.removed).toEqual([removableStray]);
    expect(boot.strayFiles.unrecognized).toEqual([]);
    expect(boot.strayFiles.failed.map((failure) => failure.name)).toEqual(sorted([blockedStray, blockedFragment]));
    for (const failure of boot.strayFiles.failed) {
      expect(failure.error).toContain(contentPath(h, failure.name));
      expect(lines.some((line) => line.includes(failure.name) && line.includes(failure.error))).toBe(true);
    }
    expect(existsSync(join(contentPath(h, blockedStray), "occupant.txt"))).toBe(true);
    expect(existsSync(join(contentPath(h, blockedFragment), "occupant.txt"))).toBe(true);
    expect(existsSync(contentPath(h, `${live.assetSha256}.txt`))).toBe(true);

    // 자리를 비운 뒤 다시 시작하면 남은 것이 없다.
    removeEntries(h, [blockedStray, blockedFragment]);
    expect((await installAssetFileRemover(h.store, h.assetStore)).strayFiles).toEqual(NO_STRAY_FILES);
    expectInvariants(h);
  }, 180_000);

  test("행의 asset_path 에 확장자가 없어 어느 사본이 맞는지 정할 수 없으면 지우지 않고 failed 로 알린다", async () => {
    const h = await makeHarness();
    const live = await uploadLiveNote(h);
    const liveName = `${live.assetSha256}.txt`;
    h.db.query("UPDATE asset_files SET asset_path = ? WHERE sha256 = ?").run(`broken-path-${live.assetSha256}`, live.assetSha256);

    const boot = await installAssetFileRemover(h.store, h.assetStore);

    expect(boot.strayFiles.removed).toEqual([]);
    expect(boot.strayFiles.failed).toHaveLength(1);
    expect(boot.strayFiles.failed[0]!.name).toBe(liveName);
    expect(boot.strayFiles.failed[0]!.error).toContain("확장자 없음");
    expect(assetContentFiles(h.dir)).toEqual([liveName]);
  }, 180_000);

  test("content/ 가 없거나 비어 있으면 빈 결과다", async () => {
    const h = await makeHarness();
    expect(existsSync(join(h.dir, ASSET_CONTENT_SUBDIR))).toBe(false);
    const missing = await installAssetFileRemover(h.store, h.assetStore);
    expect(missing).toEqual({ cleanup: NO_CLEANUP, strayFiles: NO_STRAY_FILES });

    mkdirSync(join(h.dir, ASSET_CONTENT_SUBDIR), { recursive: true });
    expect(await installAssetFileRemover(h.store, h.assetStore)).toEqual({ cleanup: NO_CLEANUP, strayFiles: NO_STRAY_FILES });
  }, 180_000);

  test("지운 수·실패 수·알 수 없는 이름 수를 로그하고, 지운 이름과 알 수 없는 이름을 줄로 남긴다", async () => {
    const h = await makeHarness();
    const stray = `${sha("log-stray")}.md`;
    const fragment = `${sha("log-fragment")}.pdf${TMP_SUFFIX}`;
    placeFile(h, stray);
    placeFile(h, fragment);
    placeFile(h, "README.txt");
    placeDirectory(h, `${sha("log-blocked")}.md`);

    const { value: logged, lines: warnings } = await captureConsole("warn", () =>
      captureConsole("log", () => installAssetFileRemover(h.store, h.assetStore)));
    const { value: boot, lines } = logged;

    expect(boot.strayFiles.removed).toEqual(sorted([stray, fragment]));
    expect(lines).toContain("[memory-api] 시작 때 content/ 훑기 — 지움 2, 실패 1, 알 수 없는 이름 1");
    expect(lines).toContain(`[memory-api] 시작 때 content/ 에서 지운 파일: ${sorted([stray, fragment]).join(", ")}`);
    expect(warnings).toContain("[memory-api] content/ 에 알 수 없는 이름 1개 — 건드리지 않음: README.txt");
  }, 180_000);

  test("다른 쓰기 잠금 보유자가 있는 동안 기다렸다가, 놓은 뒤에 훑는다", async () => {
    const h = await makeHarness();
    const stray = `${sha("locked-stray")}.md`;
    placeFile(h, stray);

    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const holder = withMemoryMutationLock(h.store, () => gate);
    let finished = false;
    const booting = installAssetFileRemover(h.store, h.assetStore).then((result) => {
      finished = true;
      return result;
    });
    await Bun.sleep(LOCK_SETTLE_MS);
    expect(finished).toBe(false);
    expect(existsSync(contentPath(h, stray))).toBe(true);

    open();
    await holder;
    const boot = await booting;
    expect(boot.strayFiles.removed).toEqual([stray]);
    expect(existsSync(contentPath(h, stray))).toBe(false);
  }, 180_000);
});
