/**
 * asset-folder-pairing.test.ts — 폴더 쪽 짝 표시 읽기·만들기와 시작 규칙표 판정(WP-B1-20U 설계 17.19 설계 1·2, U11a).
 *
 * 검증 축:
 *   1. decideAssetFolderPairing — 설계 2 의 표 열 줄을 데이터로 돌린다(Q8: 짝 행 없는 빈 DB + 다른 번호 표시만 있는 빈
 *      content/ 는 멈춤 S2). 같은 표를 위 줄부터 읽어 S3 가 S4 보다, S5 가 모든 줄보다 먼저다.
 *   2. readAssetFolderState — 실제 임시 폴더로: 폴더·content/ 없음과 빈 content/ 는 빈 폴더, 항목(파일·디렉터리)이 있으면
 *      표시 없는 항목, 읽을 수 있는 표시는 그 번호, 읽을 수 없는 표시는 원인별 S4 원인, 빈 문자열·공백 폴더 값은 unset.
 *   3. createAssetFolderMarker — 없을 때만 만든다: 폴더가 없으면 만들고 정해진 JSON 을 쓴다. 표시가 이미 있으면 실제
 *      linkSync EEXIST 로 "exists" — 덮어쓰지 않는다. 어느 쪽이든 임시 파일이 남지 않는다.
 *   4. AssetFolderPairingError — 다섯 멈춤 문구가 설계 문구 그대로이고 경로·짝 번호 값을 담지 않는다.
 *
 * 실제 파일 시스템(mkdtemp)만 쓴다. mock 0.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXPECTED_PAIRING_STOP } from "../test-utils/asset-folder-pairing-expected.ts";
import {
  ASSET_PAIRING_FILE_NAME,
  AssetFolderPairingError,
  createAssetFolderMarker,
  decideAssetFolderPairing,
  newAssetPairingId,
  readAssetFolderState,
  type AssetFolderPairingDecision,
  type AssetFolderState,
  type AssetPairingDbState,
} from "./asset-folder-pairing.ts";
import { AssetStore } from "./asset-store.ts";

const X = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const Y = "12345678-9abc-4def-8123-456789abcdef";
const CREATED_AT = "2026-10-02 09:00:00";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bara-pairing-unit-"));
  dirs.push(dir);
  return dir;
}

function markerPath(dir: string): string {
  return join(dir, ASSET_PAIRING_FILE_NAME);
}

describe("decideAssetFolderPairing — 설계 2 시작 규칙표(데이터)", () => {
  const noRowEmptyDb: AssetPairingDbState = { pairingId: null, assetFileRows: 0 };
  const noRowWithAssets: AssetPairingDbState = { pairingId: null, assetFileRows: 3 };
  const pairedX: AssetPairingDbState = { pairingId: X };
  const empty: AssetFolderState = { kind: "empty" };
  const items: AssetFolderState = { kind: "unmarked-items" };
  const markedX: AssetFolderState = { kind: "marked", pairingId: X };
  const markedY: AssetFolderState = { kind: "marked", pairingId: Y };
  const invalid: AssetFolderState = { kind: "invalid", cause: "JSON 형식 오류" };
  const unset: AssetFolderState = { kind: "unset" };

  const rows: Array<[string, AssetPairingDbState, AssetFolderState, AssetFolderPairingDecision]> = [
    ["1 짝 행 없음·asset_files 0 + 빈 폴더 -> 새 짝", noRowEmptyDb, empty, { action: "pair-new" }],
    ["2 짝 행 없음·asset_files 0 + 표시 없이 항목 -> S1", noRowEmptyDb, items, { action: "stop", stop: { reason: "S1" } }],
    ["3 짝 행 없음·asset_files 0 + 다른 번호(Q8) -> S2", noRowEmptyDb, markedY, { action: "stop", stop: { reason: "S2" } }],
    ["4a 짝 행 없음·asset_files 있음 + 빈 폴더 -> S3", noRowWithAssets, empty, { action: "stop", stop: { reason: "S3", assetFileRows: 3 } }],
    ["4b 짝 행 없음·asset_files 있음 + 표시 없이 항목 -> S3", noRowWithAssets, items, { action: "stop", stop: { reason: "S3", assetFileRows: 3 } }],
    ["4c 짝 행 없음·asset_files 있음 + 표시 -> S3", noRowWithAssets, markedX, { action: "stop", stop: { reason: "S3", assetFileRows: 3 } }],
    ["4d 짝 행 없음·asset_files 있음 + 읽을 수 없는 표시 -> S3(위 줄 먼저)", noRowWithAssets, invalid, { action: "stop", stop: { reason: "S3", assetFileRows: 3 } }],
    ["5 짝 X + 빈 폴더 -> 폴더에 X", pairedX, empty, { action: "mark-folder", pairingId: X }],
    ["6 짝 X + 표시 없이 항목 -> S1", pairedX, items, { action: "stop", stop: { reason: "S1" } }],
    ["7 짝 X + 짝 X -> 진행", pairedX, markedX, { action: "proceed" }],
    ["8 짝 X + 짝 Y -> S2", pairedX, markedY, { action: "stop", stop: { reason: "S2" } }],
    ["9a 짝 행 없는 빈 DB + 읽을 수 없는 표시 -> S4", noRowEmptyDb, invalid, { action: "stop", stop: { reason: "S4", cause: "JSON 형식 오류" } }],
    ["9b 짝 X + 읽을 수 없는 표시 -> S4", pairedX, invalid, { action: "stop", stop: { reason: "S4", cause: "JSON 형식 오류" } }],
    ["10a 폴더 값 빈 문자열 + 빈 DB -> S5", noRowEmptyDb, unset, { action: "stop", stop: { reason: "S5" } }],
    ["10b 폴더 값 빈 문자열 + 첨부 기록 있는 DB -> S5", noRowWithAssets, unset, { action: "stop", stop: { reason: "S5" } }],
    ["10c 폴더 값 빈 문자열 + 짝 X -> S5", pairedX, unset, { action: "stop", stop: { reason: "S5" } }],
  ];

  for (const [name, db, folder, expected] of rows) {
    test(name, () => {
      expect(decideAssetFolderPairing(db, folder)).toEqual(expected);
    });
  }
});

describe("readAssetFolderState — 실제 폴더", () => {
  test("폴더 없음·content/ 없음·빈 content/ 는 빈 폴더", () => {
    const dir = tempDir();
    expect(readAssetFolderState(new AssetStore(join(dir, "not-yet")))).toEqual({ kind: "empty" });
    expect(readAssetFolderState(new AssetStore(dir))).toEqual({ kind: "empty" });
    mkdirSync(join(dir, "content"));
    expect(readAssetFolderState(new AssetStore(dir))).toEqual({ kind: "empty" });
  });

  test("content/ 에 파일이나 디렉터리가 하나라도 있으면 표시 없는 항목", () => {
    const withFile = tempDir();
    mkdirSync(join(withFile, "content"));
    writeFileSync(join(withFile, "content", "README-user-note.txt"), "note");
    expect(readAssetFolderState(new AssetStore(withFile))).toEqual({ kind: "unmarked-items" });
    const withDirectory = tempDir();
    mkdirSync(join(withDirectory, "content", "nested"), { recursive: true });
    expect(readAssetFolderState(new AssetStore(withDirectory))).toEqual({ kind: "unmarked-items" });
  });

  test("읽을 수 있는 표시는 content/ 와 무관하게 그 번호", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "content"));
    writeFileSync(join(dir, "content", "a.txt"), "a");
    writeFileSync(markerPath(dir), JSON.stringify({ format: 1, pairingId: X, createdAt: CREATED_AT }));
    expect(readAssetFolderState(new AssetStore(dir))).toEqual({ kind: "marked", pairingId: X });
  });

  test("읽을 수 없는 표시는 원인별로 invalid", () => {
    const cases: Array<[string, (path: string) => void]> = [
      ["JSON 형식 오류", (path) => writeFileSync(path, "{format:1")],
      ["형식 번호 다름", (path) => writeFileSync(path, JSON.stringify({ format: 2, pairingId: X }))],
      ["형식 번호 다름", (path) => writeFileSync(path, JSON.stringify({ format: "1", pairingId: X }))],
      ["형식 번호 다름", (path) => writeFileSync(path, "null")],
      ["짝 번호 모양 틀림", (path) => writeFileSync(path, JSON.stringify({ format: 1, pairingId: X.toUpperCase() }))],
      ["짝 번호 모양 틀림", (path) => writeFileSync(path, JSON.stringify({ format: 1 }))],
      ["파일 자리가 디렉터리", (path) => mkdirSync(path)],
    ];
    for (const [cause, place] of cases) {
      const dir = tempDir();
      place(markerPath(dir));
      expect(readAssetFolderState(new AssetStore(dir))).toEqual({ kind: "invalid", cause });
    }
  });

  test("빈 문자열·공백 폴더 값은 unset — 폴더를 읽지 않는다", () => {
    expect(readAssetFolderState(new AssetStore(""))).toEqual({ kind: "unset" });
    expect(readAssetFolderState(new AssetStore("   "))).toEqual({ kind: "unset" });
  });
});

describe("createAssetFolderMarker — 없을 때만 만들기", () => {
  test("없으면 폴더째 만들고 정해진 JSON 을 쓴다, 임시 파일은 남지 않는다", () => {
    const dir = join(tempDir(), "assets");
    expect(createAssetFolderMarker(dir, { pairingId: X, createdAt: CREATED_AT })).toBe("created");
    expect(readFileSync(markerPath(dir), "utf8")).toBe(`{"format":1,"pairingId":"${X}","createdAt":"${CREATED_AT}"}`);
    expect(readdirSync(dir)).toEqual([ASSET_PAIRING_FILE_NAME]);
    expect(readAssetFolderState(new AssetStore(dir))).toEqual({ kind: "marked", pairingId: X });
  });

  test("표시가 이미 있으면(실제 EEXIST) exists — 덮어쓰지 않고 임시 파일도 남지 않는다", () => {
    const dir = tempDir();
    const existing = JSON.stringify({ format: 1, pairingId: Y, createdAt: CREATED_AT });
    writeFileSync(markerPath(dir), existing);
    expect(createAssetFolderMarker(dir, { pairingId: X, createdAt: CREATED_AT })).toBe("exists");
    expect(readFileSync(markerPath(dir), "utf8")).toBe(existing);
    expect(readdirSync(dir)).toEqual([ASSET_PAIRING_FILE_NAME]);
  });

  test("이미 있는 폴더를 `..` 가 든 상대 경로(../assets)로 줘도 만든다 — Bun 1.3.6 / Windows mkdir EEXIST 회귀", () => {
    const root = tempDir();
    mkdirSync(join(root, "assets"));
    mkdirSync(join(root, "cwd"));
    const before = process.cwd();
    process.chdir(join(root, "cwd"));
    try {
      expect(createAssetFolderMarker("../assets", { pairingId: X, createdAt: CREATED_AT })).toBe("created");
    } finally {
      process.chdir(before);
    }
    expect(readAssetFolderState(new AssetStore(join(root, "assets")))).toEqual({ kind: "marked", pairingId: X });
  });

  test("newAssetPairingId 는 읽을 때 통과하는 모양이다", () => {
    const dir = tempDir();
    const id = newAssetPairingId();
    createAssetFolderMarker(dir, { pairingId: id, createdAt: CREATED_AT });
    expect(readAssetFolderState(new AssetStore(dir))).toEqual({ kind: "marked", pairingId: id });
  });
});

describe("AssetFolderPairingError — 설계 문구 그대로", () => {
  test("다섯 멈춤 문구와 reason", () => {
    const cases: Array<[AssetFolderPairingError, string]> = [
      [new AssetFolderPairingError({ reason: "S1" }), EXPECTED_PAIRING_STOP.S1],
      [new AssetFolderPairingError({ reason: "S2" }), EXPECTED_PAIRING_STOP.S2],
      [new AssetFolderPairingError({ reason: "S3", assetFileRows: 7 }), EXPECTED_PAIRING_STOP.S3(7)],
      [new AssetFolderPairingError({ reason: "S4", cause: "EACCES" }), EXPECTED_PAIRING_STOP.S4("EACCES")],
      [new AssetFolderPairingError({ reason: "S5" }), EXPECTED_PAIRING_STOP.S5],
    ];
    for (const [error, message] of cases) {
      expect(error.message).toBe(message);
      expect(error.name).toBe("AssetFolderPairingError");
      expect(error.reason).toBe(error.stop.reason);
    }
  });
});
