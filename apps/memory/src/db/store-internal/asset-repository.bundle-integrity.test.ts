/**
 * asset-repository.bundle-integrity.test.ts — 자산 묶음은 내용이 sha 와 다른 파일을 쓰지 않는다(U9a 회귀 방어).
 *
 * writeAssetBundleSync 는 호출자가 미리 계산한 sha256·길이(byteSize)를 믿고 파일 자리·asset_files 행을 정한다. 계산 뒤
 * 바이트가 비거나(다른 라이브러리가 ArrayBuffer 를 넘겨 비움) 바뀌면, 쓰기 전에 AssetBundleBytesMismatchError 로 멈추고
 * 그 묶음의 asset_files 행·기록 행·파일을 하나도 쓰지 않는다. 오류는 sha 와 선언·실제 길이를 함께 알린다.
 *
 * 실제 SQLite(:memory:) + 임시 디렉터리의 실제 AssetStore + 저장소의 실제 PDF fixture. 버퍼 비우기는 실제
 * ArrayBuffer.transfer 로 만든다. mock 0.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDatabase } from "../migrations.ts";
import { AssetBundleBytesMismatchError, AssetRepository, type AssetBundleFile } from "./asset-repository.ts";
import { AssetStore, assetSha256 } from "../../assets/asset-store.ts";

const SCANNED_PDF = join(import.meta.dir, "..", "..", "memory", "canonicalize", "__fixtures__", "scanned.pdf");

let db: Database;
let repo: AssetRepository;
let assetDir: string;
let assetStore: AssetStore;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  repo = new AssetRepository(db);
  assetDir = mkdtempSync(join(tmpdir(), "bara-asset-bundle-integrity-"));
  assetStore = new AssetStore(assetDir);
});

afterEach(() => {
  db.close();
  rmSync(assetDir, { recursive: true, force: true });
});

/** 바이트를 읽은 그 순간의 sha·길이를 선언한 묶음 파일. */
function declaredFile(bytes: Uint8Array, ext: string, mimeType: string): AssetBundleFile {
  return { sha256: assetSha256(bytes), byteSize: bytes.byteLength, bytes, ext, assetType: "text", mimeType };
}

function pdfFile(): AssetBundleFile {
  return declaredFile(new Uint8Array(readFileSync(SCANNED_PDF)), "pdf", "application/pdf");
}

const assetRowCount = () => (db.query("SELECT COUNT(*) AS n FROM asset_files").get() as { n: number }).n;
const ledgerRowCount = () => (db.query("SELECT COUNT(*) AS n FROM asset_file_imports").get() as { n: number }).n;

function addLedger(sha256: string): void {
  repo.addAssetImport({ assetSha256: sha256, source: "dashboard:manual", sourceRef: "document:doc_1", author: "owner", userId: "u1" });
}

/** fn 이 던진 오류(던지지 않으면 테스트 실패). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("오류가 나야 하는데 나지 않았습니다");
}

describe("writeAssetBundleSync — 선언한 sha·길이와 다른 바이트는 쓰지 않는다", () => {
  test("sha 계산 뒤 ArrayBuffer 가 넘겨져 비면 sha·선언 길이·실제 길이 0 을 담은 오류, 행·파일 0", () => {
    const pdf = pdfFile();
    const declaredLength = pdf.byteSize;
    (pdf.bytes.buffer as ArrayBuffer).transfer(); // pdf.js getDocumentProxy 가 하던 일 — 원래 Uint8Array 는 0바이트가 된다.
    expect(pdf.bytes.byteLength).toBe(0);
    let recordRowsCalled = false;

    const error = thrownBy(() =>
      repo.writeAssetBundleSync(assetStore, [pdf], () => {
        recordRowsCalled = true;
        addLedger(pdf.sha256);
      }),
    );

    expect(error).toBeInstanceOf(AssetBundleBytesMismatchError);
    const mismatch = error as AssetBundleBytesMismatchError;
    expect(mismatch.name).toBe("AssetBundleBytesMismatchError");
    expect([mismatch.sha256, mismatch.declaredByteSize, mismatch.actualByteSize]).toEqual([pdf.sha256, declaredLength, 0]);
    expect(mismatch.message).toContain(pdf.sha256);
    expect(mismatch.message).toContain(`선언 길이 ${declaredLength}바이트`);
    expect(mismatch.message).toContain("실제 길이 0바이트");
    expect(recordRowsCalled).toBe(false);
    expect([assetRowCount(), ledgerRowCount()]).toEqual([0, 0]);
    expect(existsSync(assetStore.path(pdf.sha256, "pdf"))).toBe(false);
  });

  test("길이는 같고 내용만 바뀌면 실제 바이트의 sha 를 담은 오류, 행·파일 0", () => {
    const pdf = pdfFile();
    pdf.bytes[pdf.bytes.byteLength - 1] = pdf.bytes[pdf.bytes.byteLength - 1]! ^ 0xff;
    const actualSha = assetSha256(pdf.bytes);

    const error = thrownBy(() => repo.writeAssetBundleSync(assetStore, [pdf], () => addLedger(pdf.sha256)));

    expect(error).toBeInstanceOf(AssetBundleBytesMismatchError);
    const mismatch = error as AssetBundleBytesMismatchError;
    expect([mismatch.declaredByteSize, mismatch.actualByteSize]).toEqual([pdf.byteSize, pdf.byteSize]);
    expect(mismatch.actualSha256).toBe(actualSha);
    expect(mismatch.message).toContain(actualSha);
    expect([assetRowCount(), ledgerRowCount()]).toEqual([0, 0]);
    expect(existsSync(assetStore.path(pdf.sha256, "pdf"))).toBe(false);
    expect(existsSync(assetStore.path(actualSha, "pdf"))).toBe(false);
  });

  test("묶음의 둘째 파일만 어긋나도 첫째 파일까지 아무것도 쓰지 않는다", () => {
    const markdown = declaredFile(new TextEncoder().encode("# 변환본"), "md", "text/markdown");
    const pdf = pdfFile();
    (pdf.bytes.buffer as ArrayBuffer).transfer();

    expect(() =>
      repo.writeAssetBundleSync(assetStore, [markdown, pdf], () => {
        addLedger(markdown.sha256);
        addLedger(pdf.sha256);
      }),
    ).toThrow(AssetBundleBytesMismatchError);

    expect([assetRowCount(), ledgerRowCount()]).toEqual([0, 0]);
    expect(existsSync(assetStore.path(markdown.sha256, "md"))).toBe(false);
    expect(existsSync(assetStore.path(pdf.sha256, "pdf"))).toBe(false);
  });

  test("선언과 맞는 바이트는 그대로 쓰고 asset_files.byte_size 는 선언 길이다", () => {
    const pdf = pdfFile();
    const expected = pdf.bytes.slice();

    repo.writeAssetBundleSync(assetStore, [pdf], () => addLedger(pdf.sha256));

    expect(new Uint8Array(readFileSync(assetStore.path(pdf.sha256, "pdf")))).toEqual(expected);
    expect(repo.getAssetFile(pdf.sha256)?.byteSize).toBe(expected.byteLength);
    expect(ledgerRowCount()).toBe(1);
  });
});
