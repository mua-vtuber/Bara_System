/**
 * store-internal/asset-repository.ts — asset_files + asset_file_imports CRUD.
 *
 * 자산 자체는 sha256 단위 단일 row(upsert = 기존 row 보존). import 시점별 attribution
 * 은 여러 row — 같은 자산 두 번 입력 = 두 import row. import_id 는 'imp_' + uuid.
 * first_imported_at / imported_at 은 1.2 T13(spec 10.1)에서 다른 코어 테이블과 같은
 * TEXT datetime(nowKst 'YYYY-MM-DD HH:MM:SS')으로 통일했다.
 *
 * WP-B1-20U 설계 17.17 — asset_file_imports 는 원장이다: 파일을 쓰는 기록(문서 기록 = documents 행, 이미지 노드)마다
 * 그 기록이 쓰는 파일당 한 행, source_ref = assetLedgerRef. 원장 행은 기록이 영구 삭제될 때만 지운다. sha 가 아직
 * 쓰이는지는 asset_files 를 FK 로 가리키는 세 표(원장·documents·images)에 그 sha 행이 남았는지다(isAssetUsed).
 * 파일 쓰기와 행 쓰기는 writeAssetBundleSync 한 트랜잭션이다(한 sha 에 디스크 파일 하나).
 *
 * Phase 14a T4 / 공통 인프라 spec 단락 1.
 */

import type { Database } from "bun:sqlite";
import { assetSha256 } from "../../assets/asset-store.ts";
import type { AssetFileWriter, ReleasedAssetRows } from "../../assets/released-asset-files.ts";
import { nowKst } from "./helpers.ts";
import { inIdBatches, sqlPlaceholders } from "./id-batches.ts";

export interface AssetFileRow {
  sha256: string;
  assetType: string;
  assetPath: string;
  byteSize: number;
  mimeType: string | null;
  originalName: string | null;
  firstImportedAt: string;
}

/** 원장 행의 주인 — 문서 기록(documents 행) 또는 이미지 노드. */
export type AssetLedgerOwner =
  | { kind: "document"; documentId: string }
  | { kind: "image"; nodeId: number };

/** 원장 행의 source_ref 를 만드는 한 곳 — `document:<document_id>` / `image:<node_id>`(설계 17.17 D26). */
export function assetLedgerRef(owner: AssetLedgerOwner): string {
  return owner.kind === "document" ? `document:${owner.documentId}` : `image:${owner.nodeId}`;
}

/**
 * 자산 묶음의 파일 하나 — sha 와 길이는 호출자가 같은 순간에 assetSha256(bytes)·bytes.byteLength 로 미리 계산한다.
 * 묶음은 쓰기 전에 bytes 가 이 둘과 맞는지 다시 확인한다(AssetBundleBytesMismatchError).
 */
export interface AssetBundleFile {
  sha256: string;
  /** sha 를 계산한 바이트의 길이 — asset_files.byte_size 로 기록된다. */
  byteSize: number;
  bytes: Uint8Array;
  /** 그 sha 의 asset_files 행이 아직 없을 때 쓸 확장자. 행이 있으면 행의 확장자를 쓴다. */
  ext: string;
  assetType: string;
  mimeType?: string;
  originalName?: string;
}

/** 자산 묶음이 쓴(또는 이미 있던) 파일 하나. cacheHit = 같은 자리에 파일이 이미 있어 다시 쓰지 않았다. */
export interface WrittenAssetFile {
  sha256: string;
  ext: string;
  path: string;
  cacheHit: boolean;
}

/**
 * 자산 묶음 파일의 바이트가 선언한 sha256·길이와 다르다 — 묶음은 행도 파일도 쓰지 않는다. sha 를 계산한 뒤 다른
 * 라이브러리가 그 ArrayBuffer 를 넘겨(transfer) 비웠거나 내용을 바꿨다는 뜻이다(내용이 sha 와 다른 파일 금지).
 */
export class AssetBundleBytesMismatchError extends Error {
  constructor(
    readonly sha256: string,
    readonly declaredByteSize: number,
    readonly actualByteSize: number,
    readonly actualSha256: string,
  ) {
    super(
      `자산 바이트가 선언한 sha256·길이와 달라 쓰지 않음: sha256 ${sha256} — 선언 길이 ${declaredByteSize}바이트, ` +
        `실제 길이 ${actualByteSize}바이트, 실제 바이트의 sha256 ${actualSha256}`,
    );
    this.name = "AssetBundleBytesMismatchError";
  }
}

/** 파일마다 바이트를 한 번 해시해 선언한 sha·길이와 맞는지 본다. 하나라도 어긋나면 그 파일의 오류를 던진다. */
function assertBundleBytesMatchDeclared(files: readonly AssetBundleFile[]): void {
  for (const file of files) {
    const actualSha256 = assetSha256(file.bytes);
    if (actualSha256 !== file.sha256 || file.bytes.byteLength !== file.byteSize) {
      throw new AssetBundleBytesMismatchError(file.sha256, file.byteSize, file.bytes.byteLength, actualSha256);
    }
  }
}

/** sha 쓰임 판정(설계 17.17 공유 규칙) — idx_asset_file_imports_sha256·idx_documents_sha256·images PK. ?1 = sha. */
const ASSET_USED_SQL = `EXISTS (SELECT 1 FROM asset_file_imports WHERE asset_sha256 = ?1)
    OR EXISTS (SELECT 1 FROM documents WHERE asset_sha256 = ?1)
    OR EXISTS (SELECT 1 FROM images WHERE asset_sha256 = ?1)`;

export class AssetRepository implements ReleasedAssetRows {
  constructor(private readonly db: Database) {}

  private newImportId(): string {
    return `imp_${crypto.randomUUID()}`;
  }

  /**
   * 자산 row 를 만든다. 같은 sha256 이 이미 있으면 no-op(첫 row 보존).
   * created=true 이면 신규 INSERT, false 이면 기존 유지.
   * 실패는 구체 에러로 throw — silent no-op 금지.
   */
  upsertAssetFile(args: {
    sha256: string;
    assetType: string;
    assetPath: string;
    byteSize: number;
    mimeType?: string;
    originalName?: string;
  }): { created: boolean } {
    const existing = this.db
      .query("SELECT sha256 FROM asset_files WHERE sha256 = ?")
      .get(args.sha256);
    if (existing) {
      return { created: false };
    }
    this.db
      .query(
        `INSERT INTO asset_files
           (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.sha256,
        args.assetType,
        args.assetPath,
        args.byteSize,
        args.mimeType ?? null,
        args.originalName ?? null,
        nowKst(),
      );
    return { created: true };
  }

  /**
   * import 시점별 attribution row 를 추가한다. import_id = 'imp_' + uuid 로 반환.
   * 같은 자산을 두 번 가져오면 두 row 가 생긴다(캐시 히트 판단은 호출자 몫).
   */
  addAssetImport(args: {
    assetSha256: string;
    source: string;
    sourceRef?: string;
    originalName?: string;
    author: string;
    userId: string;
  }): string {
    const importId = this.newImportId();
    this.db
      .query(
        `INSERT INTO asset_file_imports
           (import_id, asset_sha256, source, source_ref, original_name, imported_at, author, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        importId,
        args.assetSha256,
        args.source,
        args.sourceRef ?? null,
        args.originalName ?? null,
        nowKst(),
        args.author,
        args.userId,
      );
    return importId;
  }

  /**
   * sha256 으로 자산 메타를 반환한다. 없으면 null — 실패와 "없음"을 구별한다.
   * 테이블 접근 실패는 SQLite 구체 에러로 전파(silent fallback 금지).
   */
  getAssetFile(sha256: string): AssetFileRow | null {
    const row = this.db
      .query("SELECT * FROM asset_files WHERE sha256 = ?")
      .get(sha256) as {
      sha256: string;
      asset_type: string;
      asset_path: string;
      byte_size: number;
      mime_type: string | null;
      original_name: string | null;
      first_imported_at: string;
    } | null;

    if (!row) return null;

    return {
      sha256: row.sha256,
      assetType: row.asset_type,
      assetPath: row.asset_path,
      byteSize: row.byte_size,
      mimeType: row.mime_type,
      originalName: row.original_name,
      firstImportedAt: row.first_imported_at,
    };
  }

  // ── 원장·쓰임 판정·해제(WP-B1-20U 설계 17.17) ─────────────────────────

  /**
   * 자산 묶음 한 트랜잭션(설계 17.17 D29). 호출자가 쓰기 잠금을 쥔다.
   *   0) 트랜잭션 전에 파일마다 바이트가 선언한 sha·길이와 맞는지 확인한다. 어긋나면 AssetBundleBytesMismatchError —
   *      행도 파일도 쓰지 않는다. 확인과 쓰기가 같은 동기 실행 안이라 그 사이에 바이트가 바뀔 틈이 없다.
   *   1) 파일마다 자리를 정한다 — 그 sha 의 asset_files 행이 있으면 그 행의 확장자(한 sha 에 디스크 파일 하나),
   *      없으면 파일의 ext. 그리고 asset_files 행을 쓴다(있으면 그대로 둔다).
   *   2) recordRows — 호출자가 기록(documents 행·이미지 노드)과 원장 행을 같은 트랜잭션에서 쓴다.
   *   3) 마지막에 파일을 쓴다. 파일 쓰기가 실패하면 행도 함께 되돌아간다.
   * 트랜잭션이 실패하면 이번에 새로 쓴 파일 중 asset_files 행이 없는 것을 지우고 원래 오류를 던진다 — 기록 없는
   * 파일을 남기지 않는다. 그 지우기마저 실패하면 두 원인을 함께 담은 오류를 던진다.
   */
  writeAssetBundleSync<T>(
    writer: AssetFileWriter,
    files: readonly AssetBundleFile[],
    recordRows: () => T,
  ): { result: T; files: WrittenAssetFile[] } {
    assertBundleBytesMatchDeclared(files);
    const fresh: WrittenAssetFile[] = [];
    try {
      return this.db.transaction(() => {
        const placed = files.map((file) => {
          const recorded = this.getAssetFile(file.sha256);
          const { ext, path } = writer.placement(file.sha256, file.ext, recorded?.assetPath ?? null);
          this.upsertAssetFile({
            sha256: file.sha256,
            assetType: file.assetType,
            assetPath: path,
            byteSize: file.byteSize,
            mimeType: file.mimeType,
            originalName: file.originalName,
          });
          return { file, ext, path };
        });
        const result = recordRows();
        const written = placed.map(({ file, ext, path }): WrittenAssetFile => {
          const { cacheHit } = writer.write(file.bytes, ext, file.sha256);
          const entry = { sha256: file.sha256, ext, path, cacheHit };
          if (!cacheHit) fresh.push(entry);
          return entry;
        });
        return { result, files: written };
      })();
    } catch (e) {
      throw this.discardFreshFiles(writer, fresh, e);
    }
  }

  /** 되돌아간 묶음이 새로 쓴 파일 중 asset_files 행이 없는 것을 지운다. 반환: 호출자가 던질 오류. */
  private discardFreshFiles(writer: AssetFileWriter, fresh: readonly WrittenAssetFile[], cause: unknown): unknown {
    const problems: string[] = [];
    for (const file of fresh) {
      if (this.getAssetFile(file.sha256) !== null) continue;
      try {
        writer.remove(file.sha256, file.ext);
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (problems.length === 0) return cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    return new Error(`${message} — 되돌아간 자산 묶음이 새로 쓴 파일을 지우지 못함: ${problems.join("; ")}`, { cause });
  }

  /**
   * source_ref 가 sourceRefs 중 하나인 원장 행을 모두 지운다(500개씩, idx_asset_file_imports_source_ref — v46). 기록이
   * 영구 삭제될 때만 부른다(설계 17.18 D33). 반환: 지운 행이 가리키던 sha(중복 제거) — 참조를 잃은 sha 후보.
   */
  deleteLedgerRowsByRefs(sourceRefs: readonly string[]): string[] {
    const shas = new Set<string>();
    for (const batch of inIdBatches([...new Set(sourceRefs)])) {
      // dynamic SQL: placeholder count varies, keep prepare()
      const rows = this.db
        .prepare(`DELETE FROM asset_file_imports WHERE source_ref IN (${sqlPlaceholders(batch.length)}) RETURNING asset_sha256`)
        .all(...batch) as Array<{ asset_sha256: string }>;
      for (const row of rows) shas.add(row.asset_sha256);
    }
    return [...shas];
  }

  /**
   * source_ref 가 sourceRef 이고 그 sha 를 가리키는 원장 행이 있는가(idx_asset_file_imports_source_ref). 같은 기록이 같은
   * 파일을 다시 쓸 때(OCR 변환본 재적용) 원장 행을 겹쳐 쓰지 않으려고 쓴다.
   */
  hasLedgerRow(sourceRef: string, sha256: string): boolean {
    const row = this.db
      .query("SELECT 1 AS found FROM asset_file_imports WHERE source_ref = ? AND asset_sha256 = ? LIMIT 1")
      .get(sourceRef, sha256);
    return row !== null;
  }

  /** asset_files 를 FK 로 가리키는 세 표에 그 sha 행이 남았는가(설계 17.17 공유 규칙). */
  isAssetUsed(sha256: string): boolean {
    const row = this.db.query(`SELECT ${ASSET_USED_SQL} AS used`).get(sha256) as { used: number };
    return row.used === 1;
  }

  /** 세 표 어디에도 참조가 없는 asset_files 행의 sha(오름차순) — 서버 시작 때 다시 지울 대상. 표 전체를 훑는다. */
  listUnreferencedAssetSha256s(): string[] {
    const rows = this.db
      .query(
        `SELECT f.sha256 AS sha256 FROM asset_files f
         WHERE NOT EXISTS (SELECT 1 FROM asset_file_imports i WHERE i.asset_sha256 = f.sha256)
           AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.asset_sha256 = f.sha256)
           AND NOT EXISTS (SELECT 1 FROM images m WHERE m.asset_sha256 = f.sha256)
         ORDER BY f.sha256`,
      )
      .all() as Array<{ sha256: string }>;
    return rows.map((row) => row.sha256);
  }

  /** asset_files 행 하나를 지운다 — 파일을 지웠거나 이미 없을 때 파일 지우기 함수가 부른다. */
  deleteAssetFileRow(sha256: string): void {
    this.db.query("DELETE FROM asset_files WHERE sha256 = ?").run(sha256);
  }
}
