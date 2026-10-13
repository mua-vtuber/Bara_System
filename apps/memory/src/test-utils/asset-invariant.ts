/**
 * test-utils/asset-invariant.ts — 첨부 파일 불변식 검사 도우미(WP-B1-20U 설계 17.17).
 *
 * 불변식: asset_files 행마다 참조 행(원장 asset_file_imports·documents·images) 또는 지우기 대기 표시가 있고, 그 행의
 * 디스크 파일(asset_path 확장자로 정한 자리)이 있다. content/ 의 파일마다 같은 sha·확장자의 asset_files 행이 있다 —
 * 기록 없이 남는 사본(같은 sha 의 다른 확장자 파일)이 없다. 대기 표시는 파일 지우기에 실패해 남긴 행이라, 테스트가 그
 * sha 를 pendingSha256s 로 넘긴다.
 *
 * 문서 기록 주인(설계 17.18 설계 1): 문서 기록(documents 행)마다 주인 행(document_record_owners)이 있고, 그 주인 노드가
 * 살아 있는 표나 휴지통 표 어디엔가 있다. PRAGMA foreign_key_check 가 비어 있다. document 노드(두 표 모두)의 metadata
 * documentId 는 그 노드가 주인인 기록이다. 원장 행의 source_ref 는 있는 기록(`document:<id>`)이나 있는 노드
 * (`image:<node_id>`, 두 표 중 하나)를 가리킨다.
 *
 * 모든 제거 동작 뒤 테스트가 부르고 빈 목록을 단언한다(계보 불변식 도우미 lineage-invariant.ts 와 함께). 운영 코드는
 * import 하지 않는다.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ASSET_CONTENT_SUBDIR, AssetStore, extOfAssetPath } from "../assets/asset-store.ts";
import { AssetRepository, assetLedgerRef } from "../db/store-internal/asset-repository.ts";

/** 불변식을 어긴 행·파일 설명(정렬). 빈 목록이면 불변식이 선다. */
export function assetInvariantViolations(
  db: Database,
  assetDir: string,
  pendingSha256s: readonly string[] = [],
): string[] {
  const violations: string[] = [];
  const pending = new Set(pendingSha256s);
  const assets = new AssetRepository(db);
  const store = new AssetStore(assetDir);
  const rows = db.query("SELECT sha256, asset_path FROM asset_files ORDER BY sha256").all() as Array<{
    sha256: string;
    asset_path: string;
  }>;
  const recordedExt = new Map<string, string | null>();
  for (const row of rows) {
    const ext = extOfAssetPath(row.asset_path);
    recordedExt.set(row.sha256, ext);
    if (!assets.isAssetUsed(row.sha256) && !pending.has(row.sha256)) {
      violations.push(`asset_files ${row.sha256}: 참조 행도 지우기 대기 표시도 없음`);
    }
    if (ext === null) {
      violations.push(`asset_files ${row.sha256}: asset_path 확장자 없음 (${row.asset_path})`);
      continue;
    }
    const path = store.path(row.sha256, ext);
    if (!existsSync(path)) violations.push(`asset_files ${row.sha256}: 디스크 파일 없음 (${path})`);
  }
  const contentDir = join(assetDir, ASSET_CONTENT_SUBDIR);
  const entries = existsSync(contentDir) ? readdirSync(contentDir) : [];
  for (const name of entries) {
    const dot = name.indexOf(".");
    const sha = dot === -1 ? name : name.slice(0, dot);
    const ext = dot === -1 ? null : name.slice(dot + 1);
    if (!recordedExt.has(sha)) {
      violations.push(`content/${name}: asset_files 행 없음`);
    } else if (recordedExt.get(sha) !== ext) {
      violations.push(`content/${name}: asset_files 행의 확장자(${recordedExt.get(sha)})와 다른 사본`);
    }
  }
  violations.push(...documentOwnerViolations(db));
  return violations.sort();
}

/** 위 문서 기록 주인·외래 키·원장 source_ref 불변식(설계 17.18). */
function documentOwnerViolations(db: Database): string[] {
  const violations: string[] = [];
  const nodeIds = new Set(
    (db.query("SELECT id FROM knowledge_nodes UNION ALL SELECT id FROM knowledge_nodes_archive").all() as Array<{ id: number }>)
      .map((row) => row.id),
  );
  const owners = db.query(
    `SELECT d.document_id AS documentId, o.node_id AS nodeId FROM documents d
     LEFT JOIN document_record_owners o ON o.document_id = d.document_id ORDER BY d.document_id`,
  ).all() as Array<{ documentId: string; nodeId: number | null }>;
  const ownerOf = new Map<string, number>();
  for (const { documentId, nodeId } of owners) {
    if (nodeId === null) {
      violations.push(`documents ${documentId}: 주인 행 없음`);
      continue;
    }
    ownerOf.set(documentId, nodeId);
    if (!nodeIds.has(nodeId)) violations.push(`documents ${documentId}: 주인 노드 ${nodeId} 가 두 표 어디에도 없음`);
  }
  const fkViolations = db.query("PRAGMA foreign_key_check").all() as Array<{ table: string; parent: string }>;
  for (const row of fkViolations) violations.push(`foreign_key_check: ${row.table} -> ${row.parent}`);
  const documentNodes = db.query(
    `SELECT id, metadata_json ->> '$.documentId' AS documentId FROM knowledge_nodes WHERE source_type = 'document'
     UNION ALL
     SELECT id, metadata_json ->> '$.documentId' AS documentId FROM knowledge_nodes_archive WHERE source_type = 'document'`,
  ).all() as Array<{ id: number; documentId: string | null }>;
  for (const node of documentNodes) {
    if (node.documentId === null || ownerOf.get(node.documentId) !== node.id) {
      violations.push(`document 노드 ${node.id}: metadata.documentId(${node.documentId}) 가 자기 주인 행이 아님`);
    }
  }
  const validRefs = new Set([
    ...owners.map(({ documentId }) => assetLedgerRef({ kind: "document", documentId })),
    ...[...nodeIds].map((nodeId) => assetLedgerRef({ kind: "image", nodeId })),
  ]);
  const ledgerRows = db.query("SELECT import_id AS importId, source_ref AS ref FROM asset_file_imports").all() as Array<{
    importId: string;
    ref: string | null;
  }>;
  for (const row of ledgerRows) {
    if (row.ref === null || !validRefs.has(row.ref)) {
      violations.push(`asset_file_imports ${row.importId}: source_ref(${row.ref}) 가 있는 기록·노드를 가리키지 않음`);
    }
  }
  return violations;
}

/** content/ 의 파일 이름(정렬). 디렉토리가 없으면 빈 목록. */
export function assetContentFiles(assetDir: string): string[] {
  const contentDir = join(assetDir, ASSET_CONTENT_SUBDIR);
  return existsSync(contentDir) ? readdirSync(contentDir).sort() : [];
}
