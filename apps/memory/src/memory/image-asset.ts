/**
 * image-asset.ts — Phase 11a T3.
 *
 * 이미지 자산 atomic 노드 + image_vec ANN insert 한 트랜잭션 정합.
 *
 * 흐름:
 *  1. `knowledge_nodes` 에 `source_type='image_asset'` + `embedding_text=NULL`
 *     + `metadata.asset_sha256` 행 추가.
 *  2. `embedding` (768-dim Float32Array — SigLIP 2 출력) 가용 시 `image_vec`
 *     가상 테이블에 `(node_id, embedding)` 합류. embedding=null 시 skip +
 *     `console.warn` 한 줄 (silent fallback 금지 정합 — CLAUDE.md).
 *  3. 두 작업을 `db.transaction()` 안에 묶어 한쪽 실패 시 둘 다 롤백
 *     (예: 임베딩 길이 불일치로 image_vec INSERT throw → 노드도 추가 안 됨).
 *
 * 이미지 텍스트 임베딩 없음 — schema v1 `knowledge_nodes.embedding_text` 칸은
 * 의도된 NULL (이미지 검색은 11b 가 SigLIP 채널 별도 합류). `kn_fts_insert`
 * 트리거는 `content` 글자만 색인 — `content` 가 사람 가시 글이라 무해.
 *
 * 자산 dedup 책임은 T5 의 `asset-repository` (sha256 PK). T3 의 노드 흐름은
 * 같은 sha256 두 번 import 시 두 노드를 추가한다(import 가족이 두 번 일어남).
 *
 * 출처(WP-B1-20T): 이미지 자산 노드는 직접 저장이다. 노드 INSERT 와 같은 트랜잭션에서 출처 행
 * (또는 derived 면 계보 엣지)을 저장소 흡수 규칙(node-absorption.ts)으로 남긴다.
 */

import type { Database } from "bun:sqlite";
import { SIGLIP2_DIM } from "../embedding/siglip2.ts";
import { NodeAbsorption, resolveNodeProvenance } from "../db/store-internal/node-absorption.ts";
import type { NodeProvenance } from "./node-sources/source-ref.ts";
import { normalizeProjectId } from "./project-scope.ts";

/**
 * `addImageAssetNode` 인자. 14a/14b 의 다른 source_type 추가 함수와 정합 —
 * `content` 가 사람 가시 글, `author` / `platform` 은 attribution 세 차원
 * 중 첫 차원(2026-05-17 spec 6차 [[attribution-three-axes]]).
 */
export interface AddImageAssetArgs {
  /**
   * 사람 가시 글. 사용자 동반 메시지 또는 자산 식별 글
   * (예: "고양이 일러스트 (assetSha256=abc123)"). FTS5 색인 통로.
   */
  content: string;
  /**
   * SigLIP 2 base-256 출력 (768-dim, L2-normalized) 또는 모델 미로드 시 null.
   * null 분기 = image_vec skip + warn (silent fallback 금지 — 명시 흐름).
   */
  embedding: Float32Array | null;
  /** 자산 sha256. metadata.asset_sha256 합류 — T5 가 images 행 채울 키. */
  assetSha256: string;
  /** Attribution — 디스코드 봇 / 대시보드 / API 호출자 식별. */
  author?: string;
  /** "discord" | "dashboard" | "" 등. */
  platform?: string;
  /** 다중 프로젝트 스코프. 없거나 빈 문자열이면 knowledge_nodes.project_id=NULL. */
  projectId?: string | null;
  /**
   * 추가 metadata — T5 가 채울 thumb_sha256·width·height·mime·isAnimated·
   * warnings_json 묶음. 본 함수는 받은 그대로 `metadata.asset_sha256` 와
   * 합쳐 직렬화한다.
   */
  metadata?: Record<string, unknown>;
  /**
   * WP-B1-20T — 이 노드의 출처. 운영 코드는 항상 명시한다(production-node-provenance.test.ts).
   * 비어 있으면 AddNodeArgs 와 같은 규칙으로 입력 칸(platform·author·metadata)의 직접 저장 출처를
   * 쓴다(테스트의 짧은 호출용).
   */
  provenance?: NodeProvenance;
}

/**
 * 이미지 자산 노드 + image_vec ANN insert 트랜잭션. 신규 `knowledge_nodes.id`
 * 반환.
 *
 * 트랜잭션 정합 — 임베딩 길이 불일치 등으로 `image_vec` INSERT 가 throw 하면
 * 동반 `knowledge_nodes` row 도 자동 롤백된다 (bun:sqlite `db.transaction` 합).
 */
export function addImageAssetNode(
  db: Database,
  args: AddImageAssetArgs,
): number {
  if (args.embedding && args.embedding.length !== SIGLIP2_DIM) {
    // 길이 사전 검증 — image_vec INSERT 가 throw 하기 전에 명시 신호 (test 안
    // 깨진 길이 분기는 본 throw 로 잡힌다).
    throw new Error(
      `addImageAssetNode embedding dim mismatch: got ${args.embedding.length}, expected ${SIGLIP2_DIM}`,
    );
  }

  const metadataJson = JSON.stringify({
    ...(args.metadata ?? {}),
    asset_sha256: args.assetSha256,
  });
  const projectId = normalizeProjectId(args.projectId);

  const insertNode = db.prepare(
    `INSERT INTO knowledge_nodes
       (content, memory_type, source_type, importance, confidence,
        platform, author, metadata_json, embedding_text, project_id)
     VALUES (?, 'fact', 'image_asset', 0.5, 0.7, ?, ?, ?, NULL, ?)`,
  );
  const insertVec = db.prepare(
    "INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)",
  );
  // 비어 있으면 addNode 와 같은 도출 규칙(resolveNodeProvenance)을 쓴다 — 규칙은 한 곳이다.
  const provenance = resolveNodeProvenance({
    content: args.content,
    sourceType: "image_asset",
    platform: args.platform,
    author: args.author,
    metadata: args.metadata,
    provenance: args.provenance,
  });
  const absorption = new NodeAbsorption(db);

  const tx = db.transaction((data: AddImageAssetArgs) => {
    insertNode.run(
      data.content,
      data.platform ?? "",
      data.author ?? "",
      metadataJson,
      projectId,
    );
    const idRow = db
      .prepare("SELECT last_insert_rowid() AS id")
      .get() as { id: number };
    if (data.embedding) {
      insertVec.run(idRow.id, data.embedding);
    }
    absorption.recordNewNodeSync(idRow.id, provenance);
    return idRow.id;
  });

  const newId = tx(args);

  if (!args.embedding) {
    // 명시 신호 — embedding=null 분기 (모델 미로드 또는 호출자 의도 skip).
    // 노드 자체는 정합 생성 (이미지 자산 자체는 보존 가치 / 검색은 11b).
    console.warn(
      `[image-asset] embedding=null — image_vec skip (node_id=${newId}, asset_sha256=${args.assetSha256})`,
    );
  }

  return newId;
}
