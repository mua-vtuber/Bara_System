/**
 * document-repository.test.ts — DocumentRepository + facade 위임 검증.
 *
 * 규칙: Mock 객체 없음. :memory: SQLite + openMemoryDatabase 로 실제 스키마
 * 적용 후 검증. 각 테스트는 독립 db 인스턴스 사용.
 *
 * Phase 14a T5.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../migrations.ts";
import { DocumentRepository } from "./document-repository.ts";
import { SqliteMemoryStore } from "../store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";

let db: Database;
let repo: DocumentRepository;

// documents 는 asset_files FK 를 참조하므로, 테스트마다 보조 자산 행을 먼저 삽입한다.
function insertAsset(database: Database, sha256: string): void {
  database
    .prepare(
      `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at)
       VALUES (?, 'text', '/assets/${sha256}.md', 1, ?)`,
    )
    // 1.2 T13(spec 10.1): first_imported_at 은 TEXT datetime.
    .run(sha256, "2026-06-06 00:00:00");
}

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  repo = new DocumentRepository(db);
});

afterEach(() => {
  db.close();
});

describe("DocumentRepository", () => {
  test("createDocument — doc_ 접두사 id 반환 + chunk_count 0 시작", () => {
    insertAsset(db, "sha256_t1");
    const docId = repo.createDocument({
      assetSha256: "sha256_t1",
      title: "회의록 2026-05-27",
      documentType: "meeting_log",
    });
    expect(docId).toMatch(/^doc_/);

    const row = db
      .prepare("SELECT * FROM documents WHERE document_id = ?")
      .get(docId) as { chunk_count: number } | null;
    expect(row).not.toBeNull();
    expect(row!.chunk_count).toBe(0);
  });

  test("createDocument — sourceMetadata 미지정 시 {} 저장 후 getDocument 에서 {} 객체 반환", () => {
    insertAsset(db, "sha256_t2");
    const docId = repo.createDocument({
      assetSha256: "sha256_t2",
      title: "기본 문서",
      documentType: "free",
    });
    const got = repo.getDocument(docId);
    expect(got).not.toBeNull();
    expect(got!.sourceMetadata).toEqual({});
  });

  test("createDocument — sourceMetadata 객체 전달 시 JSON 파싱 후 반환", () => {
    insertAsset(db, "sha256_t3");
    const meta = { author: "banjjagi", language: "ko", pages: 5 };
    const docId = repo.createDocument({
      assetSha256: "sha256_t3",
      title: "시나리오 문서",
      documentType: "scenario",
      sourceMetadata: meta,
    });
    const got = repo.getDocument(docId);
    expect(got).not.toBeNull();
    expect(got!.sourceMetadata).toEqual(meta);
  });

  test("createDocument — created_at / updated_at 이 TEXT datetime(nowKst 양식)으로 저장된다", () => {
    insertAsset(db, "sha256_t4");
    const docId = repo.createDocument({
      assetSha256: "sha256_t4",
      title: "타임스탬프 검증",
      documentType: "reference",
    });

    const row = db
      .prepare("SELECT created_at, updated_at FROM documents WHERE document_id = ?")
      .get(docId) as { created_at: string; updated_at: string } | null;
    expect(row).not.toBeNull();
    // 1.2 T13(spec 10.1): epoch INTEGER → TEXT datetime 'YYYY-MM-DD HH:MM:SS'.
    expect(typeof row!.created_at).toBe("string");
    expect(row!.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row!.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("setChunkCount — chunk_count 갱신 + updated_at 갱신 시각 양식", async () => {
    insertAsset(db, "sha256_t5");
    const docId = repo.createDocument({
      assetSha256: "sha256_t5",
      title: "청크 검증",
      documentType: "free",
    });

    const before = db
      .prepare("SELECT updated_at FROM documents WHERE document_id = ?")
      .get(docId) as { updated_at: string };

    // updated_at 시각이 한 단계 흐르도록 1초 이상 대기 (nowKst 는 초 해상도).
    await new Promise((r) => setTimeout(r, 1100));

    repo.setChunkCount(docId, 7);

    const row = db
      .prepare("SELECT chunk_count, updated_at FROM documents WHERE document_id = ?")
      .get(docId) as { chunk_count: number; updated_at: string } | null;
    expect(row!.chunk_count).toBe(7);
    // TEXT datetime 은 lexicographic 비교가 곧 시간 순서 — 갱신 시각이 이전 이상.
    expect(row!.updated_at >= before.updated_at).toBe(true);
    expect(row!.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("getDocument — 없는 document_id = null 반환", () => {
    const got = repo.getDocument("doc_nonexistent_00000000000000");
    expect(got).toBeNull();
  });

  test("getDocument — 반환 객체에 documentId / assetSha256 / title / documentType / chunkCount 포함", () => {
    insertAsset(db, "sha256_t6");
    const docId = repo.createDocument({
      assetSha256: "sha256_t6",
      title: "필드 검증 문서",
      documentType: "notion_page",
      sourceMetadata: { notion_id: "abc123" },
    });
    const got = repo.getDocument(docId);
    expect(got).not.toBeNull();
    expect(got!.documentId).toBe(docId);
    expect(got!.assetSha256).toBe("sha256_t6");
    expect(got!.title).toBe("필드 검증 문서");
    expect(got!.documentType).toBe("notion_page");
    expect(got!.chunkCount).toBe(0);
    expect(got!.sourceMetadata).toEqual({ notion_id: "abc123" });
  });

  test("listDocumentsByParseStatuses — parse.status 로 OCR 후보를 조회한다", () => {
    insertAsset(db, "sha256_t7");
    insertAsset(db, "sha256_t8");
    const ocrDocId = repo.createDocument({
      assetSha256: "sha256_t7",
      title: "스캔 문서",
      documentType: "free",
      sourceMetadata: {
        parse: {
          status: "needs_ocr",
          method: "tier1",
          originalAssetSha256: "sha256_t7",
          warnings: [],
        },
      },
    });
    repo.createDocument({
      assetSha256: "sha256_t8",
      title: "텍스트 문서",
      documentType: "free",
      sourceMetadata: {
        parse: {
          status: "text_succeeded",
          method: "tier1",
          originalAssetSha256: "sha256_t8",
          warnings: [],
        },
      },
    });

    const got = repo.listDocumentsByParseStatuses(["needs_ocr"]);
    expect(got.map((doc) => doc.documentId)).toEqual([ocrDocId]);
    expect(got[0]!.parseStatus).toBe("needs_ocr");
  });

  test("listDocumentsByParseStatuses — oldest 정렬은 오래된 후보를 먼저 반환한다", () => {
    insertAsset(db, "sha256_o1");
    insertAsset(db, "sha256_o2");
    const older = repo.createDocument({
      assetSha256: "sha256_o1",
      title: "오래된 스캔",
      documentType: "free",
      sourceMetadata: {
        parse: {
          status: "needs_ocr",
          method: "tier1",
          originalAssetSha256: "sha256_o1",
          warnings: [],
        },
      },
    });
    const newer = repo.createDocument({
      assetSha256: "sha256_o2",
      title: "새 스캔",
      documentType: "free",
      sourceMetadata: {
        parse: {
          status: "needs_ocr",
          method: "tier1",
          originalAssetSha256: "sha256_o2",
          warnings: [],
        },
      },
    });
    db.prepare("UPDATE documents SET updated_at = ? WHERE document_id = ?").run(
      "2026-07-01 09:00:00",
      older,
    );
    db.prepare("UPDATE documents SET updated_at = ? WHERE document_id = ?").run(
      "2026-07-01 10:00:00",
      newer,
    );

    const got = repo.listDocumentsByParseStatuses(["needs_ocr"], 10, "oldest");
    expect(got.map((doc) => doc.documentId)).toEqual([older, newer]);
  });

  test("updateDocumentAfterOcr — asset/source_metadata/chunk_count 갱신", () => {
    insertAsset(db, "sha256_t9");
    insertAsset(db, "sha256_t10");
    const docId = repo.createDocument({
      assetSha256: "sha256_t9",
      title: "OCR 전",
      documentType: "free",
      sourceMetadata: {
        parse: {
          status: "needs_ocr",
          method: "tier1",
          originalAssetSha256: "sha256_t9",
          warnings: [],
        },
      },
    });

    const updated = repo.updateDocumentAfterOcr({
      documentId: docId,
      assetSha256: "sha256_t10",
      chunkCount: 2,
      sourceMetadata: {
        parse: {
          status: "ocr_succeeded",
          method: "ocr",
          originalAssetSha256: "sha256_t9",
          canonicalAssetSha256: "sha256_t10",
          warnings: [],
        },
      },
    });

    expect(updated).toBe(true);
    const got = repo.getDocument(docId);
    expect(got!.assetSha256).toBe("sha256_t10");
    expect(got!.chunkCount).toBe(2);
    expect((got!.sourceMetadata.parse as { status: string }).status).toBe("ocr_succeeded");
  });

  test("updateDocumentSourceMetadataIfCurrent — 읽은 metadata 가 같을 때만 갱신한다", () => {
    insertAsset(db, "sha256_meta");
    const initial = {
      parse: {
        status: "needs_ocr",
        method: "tier1",
        originalAssetSha256: "sha256_meta",
        warnings: [],
      },
    };
    const docId = repo.createDocument({
      assetSha256: "sha256_meta",
      title: "metadata 갱신",
      documentType: "free",
      sourceMetadata: initial,
    });

    const ok = repo.updateDocumentSourceMetadataIfCurrent({
      documentId: docId,
      currentSourceMetadata: initial,
      nextSourceMetadata: {
        parse: {
          ...initial.parse,
          lease: {
            workerId: "worker-a",
            claimedAt: "2026-07-01 10:00:00",
            leaseUntil: "2026-07-01 10:30:00",
          },
        },
      },
    });
    expect(ok).toBe(true);

    const stale = repo.updateDocumentSourceMetadataIfCurrent({
      documentId: docId,
      currentSourceMetadata: initial,
      nextSourceMetadata: { parse: { ...initial.parse, status: "ocr_failed" } },
    });
    expect(stale).toBe(false);
    const got = repo.getDocument(docId);
    expect((got!.sourceMetadata.parse as { lease: { workerId: string } }).lease.workerId).toBe(
      "worker-a",
    );
  });
});

describe("DocumentRepository — facade 위임 (SqliteMemoryStore)", () => {
  test("store.createDocument / setChunkCount / getDocument 가 DocumentRepository 를 통해 동작한다", async () => {
    const embedder = new Bgem3Embedder();
    await embedder.load();
    const storeDb = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    insertAsset(storeDb, "sha256_facade");
    const store = new SqliteMemoryStore(storeDb, embedder);

    const docId = store.createDocument({
      assetSha256: "sha256_facade",
      title: "facade 검증 문서",
      documentType: "meeting_log",
      sourceMetadata: { source: "discord" },
    });
    expect(docId).toMatch(/^doc_/);

    store.setChunkCount(docId, 3);

    const got = store.getDocument(docId);
    expect(got).not.toBeNull();
    expect(got!.chunkCount).toBe(3);
    expect(got!.sourceMetadata).toEqual({ source: "discord" });

    expect(store.getDocument("doc_missing")).toBeNull();

    storeDb.close();
  });
});
