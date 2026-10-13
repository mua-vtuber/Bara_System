/**
 * image-asset.test.ts — Phase 11a T3.
 *
 * `addImageAssetNode` 트랜잭션 정합 단위 검증. 실제 bun:sqlite + sqlite-vec
 * + schema v7 마이그레이션 위에서 돌아간다 — Mock 클래스 0 (CLAUDE.md 정합).
 *
 * 4 갈래:
 *  (a) embedding 가용 → knowledge_nodes + image_vec 둘 다 row 추가
 *  (b) embedding=null → knowledge_nodes 만 추가 / image_vec skip + warn
 *  (c) 같은 asset_sha256 두 번 호출 → 두 노드 + 두 image_vec row (자산 dedup
 *      은 T5/asset-repository 책임, T3 는 노드 흐름 정합 검증)
 *  (d) 트랜잭션 정합 — 임베딩 길이 깨뜨려 INSERT 실패 → knowledge_nodes 행
 *      0 (롤백)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SIGLIP2_DIM } from "../embedding/siglip2.ts";
import { addImageAssetNode } from "./image-asset.ts";

interface NodeRow {
  id: number;
  content: string;
  source_type: string;
  embedding_text: string | null;
  metadata_json: string;
  platform: string;
  author: string;
  project_id: string | null;
}

interface CountRow {
  c: number;
}

function freshDb(): Database {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  // asset_files (Phase 14a) 안 dummy row — FK 무결성 정합 (images 테이블이
  // asset_sha256 → asset_files.sha256 외래키 두지만 T3 자체는 images 행을
  // 쓰지 않는다. T5 가 images 행을 쓰는 단계).
  db.run(
    `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, mime_type, first_imported_at)
     VALUES ('abc123', 'image', 'image/ab/c/abc123.png', 100, 'image/png', ?)`,
    [Date.now()],
  );
  return db;
}

function makeImageEmbedding(seed: number): Float32Array {
  const v = new Float32Array(SIGLIP2_DIM);
  for (let i = 0; i < v.length; i++) v[i] = Math.sin(seed + i * 0.001);
  return v;
}

describe("addImageAssetNode", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
  });

  // (a) embedding 가용 분기 — 두 row 정합
  test("embedding 가용 — knowledge_nodes + image_vec 둘 다 추가, source_type='image_asset', embedding_text NULL, metadata.asset_sha256 정합", () => {
    const embedding = makeImageEmbedding(1);
    const nodeId = addImageAssetNode(db, {
      content: "고양이 일러스트 (assetSha256=abc123)",
      embedding,
      assetSha256: "abc123",
      author: "user",
      platform: "discord",
      projectId: " prj_image ",
      metadata: { width: 512, height: 512, mime: "image/png" },
    });
    expect(nodeId).toBeGreaterThan(0);

    const node = db
      .prepare("SELECT * FROM knowledge_nodes WHERE id = ?")
      .get(nodeId) as NodeRow | null;
    expect(node).not.toBeNull();
    expect(node!.source_type).toBe("image_asset");
    expect(node!.embedding_text).toBeNull();
    expect(node!.platform).toBe("discord");
    expect(node!.author).toBe("user");
    expect(node!.project_id).toBe("prj_image");
    const meta = JSON.parse(node!.metadata_json) as Record<string, unknown>;
    expect(meta.asset_sha256).toBe("abc123");
    expect(meta.width).toBe(512);
    expect(meta.mime).toBe("image/png");

    const vecRow = db
      .prepare("SELECT node_id FROM image_vec WHERE node_id = ?")
      .get(nodeId) as { node_id: number } | null;
    expect(vecRow).not.toBeNull();
    expect(vecRow!.node_id).toBe(nodeId);
  });

  // (b) embedding=null 분기 — 노드만 추가, image_vec skip, warn
  test("embedding=null — knowledge_nodes 만 추가 / image_vec 행 0 / console.warn 한 줄", () => {
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };

    try {
      const nodeId = addImageAssetNode(db, {
        content: "이미지 자산 (임베딩 미가용)",
        embedding: null,
        assetSha256: "abc123",
      });
      expect(nodeId).toBeGreaterThan(0);

      const node = db
        .prepare("SELECT id, source_type, embedding_text FROM knowledge_nodes WHERE id = ?")
        .get(nodeId) as Pick<NodeRow, "id" | "source_type" | "embedding_text"> | null;
      expect(node).not.toBeNull();
      expect(node!.source_type).toBe("image_asset");
      expect(node!.embedding_text).toBeNull();

      const vecCount = (
        db
          .prepare("SELECT COUNT(*) AS c FROM image_vec WHERE node_id = ?")
          .get(nodeId) as CountRow
      ).c;
      expect(vecCount).toBe(0);

      expect(warns.some((line) => line.includes("[image-asset]"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  // (c) 같은 asset_sha256 두 번 호출 — 두 노드 + 두 image_vec row
  test("같은 asset_sha256 두 번 호출 — 두 knowledge_nodes + 두 image_vec row (노드 흐름 dedup 책임 X)", () => {
    const e1 = makeImageEmbedding(10);
    const e2 = makeImageEmbedding(20);
    const id1 = addImageAssetNode(db, {
      content: "첫 import abc123",
      embedding: e1,
      assetSha256: "abc123",
    });
    const id2 = addImageAssetNode(db, {
      content: "두 번째 import abc123",
      embedding: e2,
      assetSha256: "abc123",
    });
    expect(id2).toBeGreaterThan(id1);

    const nodeCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM knowledge_nodes WHERE source_type='image_asset'",
        )
        .get() as CountRow
    ).c;
    expect(nodeCount).toBe(2);

    const vecCount = (
      db
        .prepare("SELECT COUNT(*) AS c FROM image_vec WHERE node_id IN (?, ?)")
        .get(id1, id2) as CountRow
    ).c;
    expect(vecCount).toBe(2);
  });

  // (d) 트랜잭션 정합 — 깨진 임베딩 양식 → 둘 다 롤백
  test("깨진 임베딩 길이 → throw + knowledge_nodes 신규 row 0 (트랜잭션 롤백)", () => {
    const beforeCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM knowledge_nodes WHERE source_type='image_asset'",
        )
        .get() as CountRow
    ).c;

    // 768 이 정합 — 100 차원 Float32Array 는 image_vec(FLOAT[768]) INSERT 실패.
    const broken = new Float32Array(100);
    expect(() =>
      addImageAssetNode(db, {
        content: "롤백 검증용",
        embedding: broken,
        assetSha256: "abc123",
      }),
    ).toThrow();

    const afterCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM knowledge_nodes WHERE source_type='image_asset'",
        )
        .get() as CountRow
    ).c;
    expect(afterCount).toBe(beforeCount);
  });
});
