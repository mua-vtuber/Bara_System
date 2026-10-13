import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDatabase } from "../migrations.ts";
import { AssetRepository, assetLedgerRef, type AssetBundleFile } from "./asset-repository.ts";
import { AssetStore, assetSha256 } from "../../assets/asset-store.ts";
import { SqliteMemoryStore } from "../store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";

let db: Database;
let repo: AssetRepository;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  repo = new AssetRepository(db);
});

afterEach(() => {
  db.close();
});

describe("AssetRepository", () => {
  test("upsertAssetFile — 새 자산 INSERT, created=true 반환", () => {
    const result = repo.upsertAssetFile({
      sha256: "sha256abc",
      assetType: "text",
      assetPath: "/assets/content/sha256abc.md",
      byteSize: 42,
      mimeType: "text/markdown",
      originalName: "meeting-notes.md",
    });
    expect(result.created).toBe(true);
    const cnt = (
      db.prepare("SELECT COUNT(*) AS c FROM asset_files WHERE sha256='sha256abc'").get() as {
        c: number;
      }
    ).c;
    expect(cnt).toBe(1);
  });

  test("upsertAssetFile — 같은 sha256 재호출 = no-op, created=false, DB 행 1개 유지", () => {
    repo.upsertAssetFile({
      sha256: "sha256dup",
      assetType: "text",
      assetPath: "/assets/content/sha256dup.md",
      byteSize: 10,
    });
    const second = repo.upsertAssetFile({
      sha256: "sha256dup",
      assetType: "text",
      assetPath: "/assets/content/sha256dup.md",
      byteSize: 10,
    });
    expect(second.created).toBe(false);
    const cnt = (
      db.prepare("SELECT COUNT(*) AS c FROM asset_files").get() as { c: number }
    ).c;
    expect(cnt).toBe(1);
  });

  test("addAssetImport — imp_ 접두사 id 반환", () => {
    repo.upsertAssetFile({
      sha256: "sha256imp",
      assetType: "text",
      assetPath: "/assets/content/sha256imp.md",
      byteSize: 5,
    });
    const importId = repo.addAssetImport({
      assetSha256: "sha256imp",
      source: "discord",
      author: "banjjagi",
      userId: "u1",
    });
    expect(importId).toMatch(/^imp_/);
  });

  test("addAssetImport — 같은 자산에 두 번 = asset_files 1행 + asset_file_imports 2행", () => {
    repo.upsertAssetFile({
      sha256: "sha256two",
      assetType: "text",
      assetPath: "/assets/content/sha256two.md",
      byteSize: 7,
    });
    const id1 = repo.addAssetImport({
      assetSha256: "sha256two",
      source: "discord",
      author: "banjjagi",
      userId: "u1",
    });
    const id2 = repo.addAssetImport({
      assetSha256: "sha256two",
      source: "notion",
      author: "banjjagi",
      userId: "u1",
    });
    expect(id1).not.toBe(id2);

    const assetCnt = (
      db.prepare("SELECT COUNT(*) AS c FROM asset_files WHERE sha256='sha256two'").get() as {
        c: number;
      }
    ).c;
    expect(assetCnt).toBe(1);

    const importCnt = (
      db
        .prepare("SELECT COUNT(*) AS c FROM asset_file_imports WHERE asset_sha256='sha256two'")
        .get() as { c: number }
    ).c;
    expect(importCnt).toBe(2);
  });

  test("getAssetFile — 저장된 자산 메타 반환", () => {
    repo.upsertAssetFile({
      sha256: "sha256meta",
      assetType: "text",
      assetPath: "/assets/content/sha256meta.md",
      byteSize: 99,
      mimeType: "text/markdown",
      originalName: "doc.md",
    });
    const got = repo.getAssetFile("sha256meta");
    expect(got).not.toBeNull();
    expect(got?.sha256).toBe("sha256meta");
    expect(got?.assetType).toBe("text");
    expect(got?.byteSize).toBe(99);
    expect(got?.mimeType).toBe("text/markdown");
    expect(got?.originalName).toBe("doc.md");
    // 1.2 T13(spec 10.1): first_imported_at 은 TEXT datetime(nowKst).
    expect(typeof got?.firstImportedAt).toBe("string");
    expect(got!.firstImportedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("getAssetFile — 없는 sha256 = null 반환", () => {
    const got = repo.getAssetFile("sha256nonexistent");
    expect(got).toBeNull();
  });

  test("addAssetImport — optional 칸(sourceRef, originalName) null 정상 저장", () => {
    repo.upsertAssetFile({
      sha256: "sha256opt",
      assetType: "text",
      assetPath: "/assets/content/sha256opt.md",
      byteSize: 3,
    });
    const importId = repo.addAssetImport({
      assetSha256: "sha256opt",
      source: "dashboard:manual",
      author: "user",
      userId: "u9",
      // sourceRef, originalName 미지정
    });
    const row = db
      .prepare("SELECT source_ref, original_name FROM asset_file_imports WHERE import_id=?")
      .get(importId) as { source_ref: string | null; original_name: string | null };
    expect(row.source_ref).toBeNull();
    expect(row.original_name).toBeNull();
  });

  test("first_imported_at 이 TEXT datetime(nowKst 양식)으로 저장된다", () => {
    repo.upsertAssetFile({
      sha256: "sha256ts",
      assetType: "text",
      assetPath: "/x/sha256ts.md",
      byteSize: 1,
    });
    const row = db
      .prepare("SELECT first_imported_at FROM asset_files WHERE sha256='sha256ts'")
      .get() as { first_imported_at: string };
    // 1.2 T13(spec 10.1): epoch INTEGER → TEXT datetime 'YYYY-MM-DD HH:MM:SS'.
    expect(typeof row.first_imported_at).toBe("string");
    expect(row.first_imported_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe("AssetRepository — facade 위임 (SqliteMemoryStore)", () => {
  test("store.upsertAssetFile / addAssetImport / getAssetFile 가 AssetRepository 를 통해 동작한다", async () => {
    const embedder = new Bgem3Embedder();
    await embedder.load();
    const storeDb = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(storeDb, embedder);

    const upsertResult = store.upsertAssetFile({
      sha256: "ftest_sha256",
      assetType: "text",
      assetPath: "/assets/content/ftest.md",
      byteSize: 20,
      mimeType: "text/plain",
      originalName: "facade-test.txt",
    });
    expect(upsertResult.created).toBe(true);

    const importId = store.addAssetImport({
      assetSha256: "ftest_sha256",
      source: "discord",
      author: "tester",
      userId: "u_facade",
    });
    expect(importId).toMatch(/^imp_/);

    const got = store.getAssetFile("ftest_sha256");
    expect(got?.sha256).toBe("ftest_sha256");
    expect(got?.mimeType).toBe("text/plain");

    expect(store.getAssetFile("nope")).toBeNull();

    storeDb.close();
  });
});

// ── WP-B1-20U 설계 17.17 — 원장·쓰임 판정·자산 묶음 ─────────────────────────────────────────────
describe("AssetRepository — 원장·쓰임 판정·자산 묶음", () => {
  let assetDir: string;
  let assetStore: AssetStore;

  beforeEach(() => {
    assetDir = mkdtempSync(join(tmpdir(), "bara-asset-repo-"));
    assetStore = new AssetStore(assetDir);
  });

  afterEach(() => {
    rmSync(assetDir, { recursive: true, force: true });
  });

  function addRow(sha256: string, ext = "md"): void {
    repo.upsertAssetFile({ sha256, assetType: "text", assetPath: `/assets/content/${sha256}.${ext}`, byteSize: 1 });
  }

  function addLedger(sha256: string, sourceRef: string): void {
    repo.addAssetImport({ assetSha256: sha256, source: "discord-channel", sourceRef, author: "owner", userId: "u1" });
  }

  function textFile(text: string, ext: string): AssetBundleFile {
    const bytes = new TextEncoder().encode(text);
    return {
      sha256: assetSha256(bytes), byteSize: bytes.byteLength, bytes, ext,
      assetType: "text", mimeType: "text/plain", originalName: `a.${ext}`,
    };
  }

  const ledgerRefs = () =>
    (db.query("SELECT asset_sha256 AS sha, source_ref AS ref FROM asset_file_imports ORDER BY sha, ref").all() as Array<{
      sha: string;
      ref: string | null;
    }>);

  test("assetLedgerRef — 문서 기록 document:<id>, 이미지 노드 image:<node_id>", () => {
    expect(assetLedgerRef({ kind: "document", documentId: "doc_1" })).toBe("document:doc_1");
    expect(assetLedgerRef({ kind: "image", nodeId: 42 })).toBe("image:42");
  });

  test("deleteLedgerRowsByRefs — 받은 source_ref 의 행을 모두 지우고 그 행들의 sha 를 중복 없이 돌려준다", () => {
    for (const sha of ["sha_a", "sha_b", "sha_c"]) addRow(sha);
    addLedger("sha_a", "document:doc_1");
    addLedger("sha_b", "document:doc_1");
    addLedger("sha_a", "image:7");
    addLedger("sha_c", "document:doc_2");

    expect(repo.deleteLedgerRowsByRefs(["document:doc_1", "image:7", "document:doc_1", "image:8"]).sort()).toEqual([
      "sha_a", "sha_b",
    ]);
    expect(repo.deleteLedgerRowsByRefs([])).toEqual([]);
    expect(ledgerRefs()).toEqual([{ sha: "sha_c", ref: "document:doc_2" }]);
  });

  test("deleteLedgerRowsByRefs — source_ref 조회가 v46 색인을 탄다(표 전체 훑기 없음)", () => {
    const detail = (db.query("EXPLAIN QUERY PLAN DELETE FROM asset_file_imports WHERE source_ref IN (?, ?)").all() as Array<{
      detail: string;
    }>).map((row) => row.detail).join(" | ");
    expect(detail).toMatch(/^SEARCH asset_file_imports USING (COVERING )?INDEX idx_asset_file_imports_source_ref /);
  });

  test("isAssetUsed — 원장·documents·images 중 어느 표든 그 sha 행이 있으면 쓰인다", () => {
    for (const sha of ["by_ledger", "by_document", "by_image", "unused"]) addRow(sha);
    addLedger("by_ledger", "image:7");
    db.query(
      `INSERT INTO documents (document_id, asset_sha256, title, document_type, source_metadata, created_at, updated_at)
       VALUES ('doc_x', 'by_document', 't', 'free', '{}', '2026-10-01 00:00:00', '2026-10-01 00:00:00')`,
    ).run();
    db.query(
      `INSERT INTO images (asset_sha256, thumb_sha256, width, height, mime, preserve_mode, is_animated, warnings_json)
       VALUES ('by_image', NULL, 1, 1, 'image/png', 'original', 0, '[]')`,
    ).run();

    expect(["by_ledger", "by_document", "by_image", "unused"].map((sha) => repo.isAssetUsed(sha))).toEqual([
      true, true, true, false,
    ]);
    expect(repo.listUnreferencedAssetSha256s()).toEqual(["unused"]);
    repo.deleteAssetFileRow("unused");
    expect(repo.getAssetFile("unused")).toBeNull();
    expect(repo.listUnreferencedAssetSha256s()).toEqual([]);
  });

  test("writeAssetBundleSync — 행·기록·파일을 한 트랜잭션으로 쓰고, 이미 행이 있는 sha 는 그 행의 확장자로 쓴다", () => {
    const txt = textFile("같은 바이트", "txt");
    const first = repo.writeAssetBundleSync(assetStore, [txt], () => {
      addLedger(txt.sha256, "document:doc_1");
      return "first";
    });
    expect(first.result).toBe("first");
    expect(first.files).toEqual([{ sha256: txt.sha256, ext: "txt", path: assetStore.path(txt.sha256, "txt"), cacheHit: false }]);
    expect(repo.getAssetFile(txt.sha256)?.assetPath).toBe(assetStore.path(txt.sha256, "txt"));

    // 같은 바이트가 .md 로 와도 파일은 하나 — 기록된 확장자(txt)로 쓰고 cacheHit.
    const asMd = { ...txt, ext: "md" };
    const second = repo.writeAssetBundleSync(assetStore, [asMd], () => addLedger(asMd.sha256, "document:doc_2"));
    expect(second.files).toEqual([{ sha256: txt.sha256, ext: "txt", path: assetStore.path(txt.sha256, "txt"), cacheHit: true }]);
    expect(readdirSync(join(assetDir, "content"))).toEqual([`${txt.sha256}.txt`]);
    expect(ledgerRefs()).toEqual([
      { sha: txt.sha256, ref: "document:doc_1" },
      { sha: txt.sha256, ref: "document:doc_2" },
    ]);
  });

  test("writeAssetBundleSync — 커밋이 실패하면 행이 되돌아가고 이번에 새로 쓴 파일만 지운 뒤 원래 오류를 던진다", () => {
    const kept = textFile("먼저 있던 파일", "md");
    repo.writeAssetBundleSync(assetStore, [kept], () => addLedger(kept.sha256, "document:doc_kept"));
    const fresh = textFile("이번에 새로 쓰는 파일", "md");
    // 실제 SQLite 조건: 외래 키 검사를 커밋 때로 미루고, 기록 단계가 없는 sha 를 가리키는 원장 행을 쓴다 — 파일을 다
    // 쓴 뒤 COMMIT 이 "FOREIGN KEY constraint failed" 로 실패한다.
    db.run("PRAGMA defer_foreign_keys = ON");

    expect(() =>
      repo.writeAssetBundleSync(assetStore, [kept, fresh], () => addLedger("sha_without_row", "document:doc_bad")),
    ).toThrow("FOREIGN KEY");

    expect(existsSync(assetStore.path(fresh.sha256, "md"))).toBe(false);
    expect(repo.getAssetFile(fresh.sha256)).toBeNull();
    expect(existsSync(assetStore.path(kept.sha256, "md"))).toBe(true);
    expect(repo.getAssetFile(kept.sha256)).not.toBeNull();
    expect(ledgerRefs()).toEqual([{ sha: kept.sha256, ref: "document:doc_kept" }]);
  });
});
