/**
 * re-embed-images.recreate.test.ts — recreateImageVecTable 의 원자성: DROP + CREATE VIRTUAL TABLE + CREATE TRIGGER 세 문장이
 * 한 트랜잭션이라, 중간 문장이 실패해도 DB 에 image_vec 이 없는 채로 남지 않는다.
 *
 * Mock 0: 실제 파일 DB(OS 임시 폴더) + sqlite-vec. 실패는 자연 실패 — sqlite-vec 는 차원이 8192 를 넘는 vec0 표 생성을
 * 거부하고, 그 거부는 DROP 이 끝난 뒤의 CREATE VIRTUAL TABLE 문장에서 일어난다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { removeTempDir } from "../../db/migration-safety.test-helpers.ts";
import { __internals } from "./re-embed-images.ts";

/** 기준 스키마의 image_vec 차원(SigLIP 2 base-256). */
const BASELINE_IMAGE_DIM = 768;
/** 다시 만들기가 성공하는 다른 차원(SigLIP 2 So400m). */
const OTHER_VALID_DIM = 1152;
/** sqlite-vec 가 vec0 표 생성을 거부하는 차원(최대 8192 초과). */
const TOO_LARGE_VEC_DIM = 9000;

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bara-re-embed-recreate-"));
  db = openMemoryDatabase(join(tmpDir, "bara.sqlite"));
});

afterEach(() => {
  db.close();
  removeTempDir(tmpDir);
});

function sqliteMasterRow(name: string): { type: string; sql: string } | null {
  return db.query("SELECT type, sql FROM sqlite_master WHERE name = ?").get(name) as { type: string; sql: string } | null;
}

/** image_vec 의 CREATE 문 — 없으면 던진다(차원 선언 float[N] 을 읽는 데 쓴다). */
function imageVecDeclaration(): string {
  const row = sqliteMasterRow("image_vec");
  if (!row) throw new Error("image_vec 표가 없습니다");
  return row.sql;
}

/** 노드 하나와 그 노드의 image_vec 행 하나를 만든다. 노드 id 를 돌려준다. */
function seedImageVecRow(): number {
  const nodeId = Number(db.query("INSERT INTO knowledge_nodes (content) VALUES (?)").run("이미지 노드").lastInsertRowid);
  db.query("INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)").run(nodeId, new Float32Array(BASELINE_IMAGE_DIM).fill(0.5));
  return nodeId;
}

describe("recreateImageVecTable 원자성", () => {
  test("CREATE VIRTUAL TABLE 이 실패하면 DROP 까지 되돌려져 image_vec 과 그 행이 그대로 남는다", () => {
    const nodeId = seedImageVecRow();
    expect(imageVecDeclaration()).toContain(`float[${BASELINE_IMAGE_DIM}]`);

    expect(() => __internals.recreateImageVecTable(db, TOO_LARGE_VEC_DIM)).toThrow("Dimension on vector column too large");

    expect(db.inTransaction).toBe(false);
    expect(sqliteMasterRow("image_vec")?.type).toBe("table");
    expect(imageVecDeclaration()).toContain(`float[${BASELINE_IMAGE_DIM}]`);
    expect(sqliteMasterRow("image_vec_delete")?.type).toBe("trigger");
    expect(db.query("SELECT node_id FROM image_vec").all()).toEqual([{ node_id: nodeId }]);
    // 되돌려진 뒤에도 표가 실제로 쓸 수 있다 — 노드를 지우면 트리거가 image_vec 행을 지운다.
    db.query("DELETE FROM knowledge_nodes WHERE id = ?").run(nodeId);
    expect(db.query("SELECT node_id FROM image_vec").all()).toEqual([]);
  });

  test("성공하면 새 차원의 image_vec 과 image_vec_delete 트리거가 생긴다", () => {
    const nodeId = seedImageVecRow();

    __internals.recreateImageVecTable(db, OTHER_VALID_DIM);

    expect(db.inTransaction).toBe(false);
    expect(imageVecDeclaration()).toContain(`float[${OTHER_VALID_DIM}]`);
    expect(sqliteMasterRow("image_vec_delete")?.type).toBe("trigger");
    expect(db.query("SELECT node_id FROM image_vec").all()).toEqual([]);
    db.query("INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)").run(nodeId, new Float32Array(OTHER_VALID_DIM).fill(0.5));
    db.query("DELETE FROM knowledge_nodes WHERE id = ?").run(nodeId);
    expect(db.query("SELECT node_id FROM image_vec").all()).toEqual([]);
  });

  test("차원이 정수 양수가 아니면 DB 를 건드리기 전에 던진다", () => {
    seedImageVecRow();
    expect(() => __internals.recreateImageVecTable(db, 0)).toThrow("recreateImageVecTable: invalid dim 0");
    expect(imageVecDeclaration()).toContain(`float[${BASELINE_IMAGE_DIM}]`);
    expect(db.query("SELECT COUNT(*) AS c FROM image_vec").get()).toEqual({ c: 1 });
  });
});
