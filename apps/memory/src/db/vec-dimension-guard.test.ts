/**
 * vec-dimension-guard.test.ts — 벡터 차원: 모델→차원 단일 출처, 글 모델 차원 치환, 차원 불일치 안전.
 *
 * settings.db.embeddingModel 한 줄로 글/개념 벡터 차원이 모델에서 자동으로 정해지는지, 글 모델 vec0
 * 표 6개는 요청 차원으로 만들어지고 SigLIP vec0 표 2개는 항상 768 인지, 이미 만들어진 DB 를 다른
 * 차원으로 열면 어느 표에서 무엇이 어긋났는지 이름을 담은 오류로 멈추고 데이터는 그대로인지를 본다.
 *
 * 옛 migrations.test.ts 의 차원 묶음(모델→차원 단일 출처, legacy 384 치환, bge-m3 1024 생성, 차원
 * 불일치 안전, M3 vec 차원 가드 8 표)에서 옮겼다. 파일 DB 를 쓰는 시험은 작업 폴더가 아니라 OS
 * 임시 폴더(mkdtempSync)에 만들고 removeTempDir 로 지운다 — apps/memory/data/ 에 잔여 파일을 남기지 않는다.
 *
 * Mock 0: 실제 bun:sqlite + sqlite-vec. 임베딩은 결정성 있는 sin 채움 데이터 fixture.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { openMemoryDatabase } from "./migrations.ts";
import {
  DEFAULT_EMBEDDING_DIM,
  EmbeddingDimMismatchError,
  readExistingVecNodesDim,
  readVecTableDim,
  assertVecTableDims,
  TEXT_MODEL_VEC_TABLES,
  SIGLIP_VEC_TABLES,
  SIGLIP_VEC_DIM,
} from "./vec-dimension-guard.ts";
import { removeTempDir } from "./migration-safety.test-helpers.ts";
import {
  embeddingDimensionOf,
  EMBEDDING_DIMENSIONS,
  vectorBaselineOf,
  EMBEDDING_VECTOR_BASELINES,
  conflictThresholdsOf,
  EMBEDDING_CONFLICT_THRESHOLDS,
} from "../embedding/factory";

type SqliteMasterRow = { name: string };
type CountRow = { c: number };
type IdRow = { id: number };
type DistanceRow = { node_id: number; distance: number };

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) removeTempDir(tempDirs.pop()!);
});

/** OS 임시 폴더 안의 파일 DB 경로. 정리는 afterEach 의 removeTempDir. */
function makeTempDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "bara-dimguard-"));
  tempDirs.push(dir);
  return join(dir, "bara.sqlite");
}

/** 차원 N 짜리 테스트 임베딩(데이터 fixture) — 결정성 있는 sin 채움. */
function makeDimEmbedding(seed: number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < v.length; i++) v[i] = Math.sin(seed + i * 0.001);
  return v;
}

describe("모델→차원 단일 출처 (embedding/factory)", () => {
  test("embeddingDimensionOf — bge-m3=1024", () => {
    expect(embeddingDimensionOf("bge-m3")).toBe(1024);
  });

  test("DEFAULT_EMBEDDING_DIM 은 bge-m3 차원과 같다 (운영 default 정합)", () => {
    // 기준 스키마 default 를 운영 모델 bge-m3(1024)에 맞췄다 —
    // "스키마 기본값이 실제 운영 모델과 어긋난 혼란"을 없앤다.
    expect(DEFAULT_EMBEDDING_DIM).toBe(EMBEDDING_DIMENSIONS["bge-m3"]);
    expect(DEFAULT_EMBEDDING_DIM).toBe(1024);
  });

  test("EMBEDDING_DIMENSIONS 맵이 bge-m3 를 보유", () => {
    expect(EMBEDDING_DIMENSIONS).toEqual({
      "bge-m3": 1024,
    });
  });

  // ── 모델 연동 vector baseline — 차원과 같은 양식 단일 출처 ──
  test("vectorBaselineOf — bge-m3=0.5 (A1 실측)", () => {
    expect(vectorBaselineOf("bge-m3")).toBe(0.5);
  });

  test("EMBEDDING_VECTOR_BASELINES 맵이 bge-m3 를 보유", () => {
    expect(EMBEDDING_VECTOR_BASELINES).toEqual({
      "bge-m3": 0.5,
    });
  });

  test("vectorBaselineOf 알 수 없는 모델은 명시 throw (mock/silent fallback 금지)", () => {
    expect(() => vectorBaselineOf("no-such-model" as never)).toThrow(
      /Unknown embedding model/,
    );
  });

  // ── 모델 연동 충돌·중복 임계 — 차원·baseline 과 같은 양식 ──
  test("conflictThresholdsOf — bge-m3 실측 추정", () => {
    expect(conflictThresholdsOf("bge-m3")).toEqual({
      conflictLow: 0.55,
      conflictHigh: 0.85,
      dedupSim: 0.85,
    });
  });

  test("EMBEDDING_CONFLICT_THRESHOLDS 맵이 bge-m3 를 보유", () => {
    expect(EMBEDDING_CONFLICT_THRESHOLDS).toEqual({
      "bge-m3": { conflictLow: 0.55, conflictHigh: 0.85, dedupSim: 0.85 },
    });
  });

  test("bge-m3 충돌 하한은 관련 글(0.559)은 통과·무관 글(≤0.49)은 컷하는 분기점", () => {
    // 실측 분포: 진짜 관련 글 cosine ≈ 0.559, 무관 글 0.28~0.49. conflictLow 0.55 가
    // 관련 글은 충돌 후보로 받고 무관 글은 거른다 — 옛 0.786 은 관련 글(0.559)조차
    // 못 닿아 supersede 가 조용히 꺼지던 흠을 푼다.
    const { conflictLow } = conflictThresholdsOf("bge-m3");
    expect(0.559).toBeGreaterThanOrEqual(conflictLow);
    expect(0.49).toBeLessThan(conflictLow);
  });

  test("conflictThresholdsOf 알 수 없는 모델은 명시 throw (mock/silent fallback 금지)", () => {
    expect(() => conflictThresholdsOf("no-such-model" as never)).toThrow(
      /Unknown embedding model/,
    );
  });
});

describe("legacy 384-dim schema 치환 회귀", () => {
  test("vec_nodes / concept_vec 가 float[384] 그대로 (치환 no-op)", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    expect(readExistingVecNodesDim(db)).toBe(384);
    const conceptSql = (db
      .prepare("SELECT sql FROM sqlite_master WHERE name='concept_vec'")
      .get() as { sql: string }).sql;
    expect(conceptSql).toContain("float[384]");
    db.close();
  });

  test("SigLIP 768 가상 테이블(image_vec / concept_siglip_vec)은 768 보존", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    for (const name of ["image_vec", "concept_siglip_vec"]) {
      const sql = (db
        .prepare("SELECT sql FROM sqlite_master WHERE name=?")
        .get(name) as { sql: string }).sql;
      expect(sql).toContain("float[768]");
      expect(sql).not.toContain("float[384]");
    }
    db.close();
  });

  test("384 글 벡터 round-trip — 기존 흐름 그대로", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES ('384 글')").run();
    const id = (db.prepare("SELECT last_insert_rowid() AS id").get() as IdRow).id;
    db.prepare("INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)")
      .run(id, makeDimEmbedding(1, 384));
    const row = db
      .prepare("SELECT node_id FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT 1")
      .get(makeDimEmbedding(1, 384)) as { node_id: number } | null;
    expect(row?.node_id).toBe(id);
    db.close();
  });
});

describe("bge-m3 1024 생성 (embeddingDim=1024)", () => {
  test("vec_nodes / concept_vec 가 float[1024] 로 생성", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    expect(readExistingVecNodesDim(db)).toBe(1024);
    const conceptSql = (db
      .prepare("SELECT sql FROM sqlite_master WHERE name='concept_vec'")
      .get() as { sql: string }).sql;
    expect(conceptSql).toContain("float[1024]");
    expect(conceptSql).not.toContain("float[384]");
    db.close();
  });

  test("SigLIP 768 가상 테이블은 1024 전환에도 768 보존 (글 임베딩과 무관)", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    for (const name of ["image_vec", "concept_siglip_vec"]) {
      const sql = (db
        .prepare("SELECT sql FROM sqlite_master WHERE name=?")
        .get(name) as { sql: string }).sql;
      expect(sql).toContain("float[768]");
      expect(sql).not.toContain("float[1024]");
    }
    db.close();
  });

  test("두 요약 vec0(chunk_summary_vec·relation_summary_vec) 차원이 1024 로 동적 치환됨 (image_vec 768 리터럴 아님)", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    for (const name of ["chunk_summary_vec", "relation_summary_vec"]) {
      const sql = (db
        .prepare("SELECT sql FROM sqlite_master WHERE name=?")
        .get(name) as { sql: string }).sql;
      expect(sql).toContain("float[1024]");
      expect(sql).not.toContain("float[384]");
      expect(sql).not.toContain("float[768]");
    }
    db.close();
  });

  test("1024 글 벡터 INSERT + KNN round-trip 가동", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES ('A'), ('B')").run();
    db.prepare("INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)")
      .run(1, makeDimEmbedding(1, 1024));
    db.prepare("INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)")
      .run(2, makeDimEmbedding(500, 1024));

    const rows = db
      .prepare("SELECT node_id, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT 2")
      .all(makeDimEmbedding(1, 1024)) as DistanceRow[];
    expect(rows.length).toBe(2);
    expect(rows[0]!.node_id).toBe(1);
    expect(rows[0]!.distance).toBeLessThan(rows[1]!.distance);

    // 384 차원 임베딩을 1024 테이블에 넣으면 sqlite-vec 가 거부 — 차원 강제 확인.
    expect(() =>
      db.prepare("INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)")
        .run(3, makeDimEmbedding(1, 384)),
    ).toThrow();
    db.close();
  });

  test("1024 개념 벡터(concept_vec) round-trip 가동", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_q', '주술회전')").run();
    const rowid = (db
      .prepare("SELECT rowid FROM concept_nodes WHERE concept_id='cpt_q'")
      .get() as { rowid: number }).rowid;
    db.prepare("INSERT INTO concept_vec (concept_rowid, embedding) VALUES (?, ?)")
      .run(rowid, makeDimEmbedding(7, 1024));
    const row = db
      .prepare("SELECT concept_rowid FROM concept_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 1")
      .get(makeDimEmbedding(7, 1024)) as { concept_rowid: number } | null;
    expect(row?.concept_rowid).toBe(rowid);
    db.close();
  });
});

describe("차원 불일치 안전 (loud fail / 운영 DB 자동 삭제 안 함)", () => {
  test("EmbeddingDimMismatchError 메시지 — 두 차원 + 빈 DB 안내 포함", () => {
    const err = new EmbeddingDimMismatchError(384, 1024);
    expect(err).toBeInstanceOf(EmbeddingDimMismatchError);
    expect(err.existingDim).toBe(384);
    expect(err.requestedDim).toBe(1024);
    expect(err.message).toContain("384");
    expect(err.message).toContain("1024");
    expect(err.message).toContain("빈 DB");
    // 옛 DB 를 되살리려면 첨부 파일 폴더도 함께 옮기라는 안내 — DB 만 옮기면 서버가 짝이 맞지 않는 폴더를 만나 아무 파일도 지우지 않고 멈춘다.
    expect(err.message).toContain(
      "옛 기억을 나중에 되살릴 수 있게 남겨 두려면, DB 파일과 첨부 파일 폴더(설정 키 assets.dir(기본 data/assets) 또는 env BARA_ASSET_DIR)를 " +
        "함께 다른 곳으로 옮긴 뒤 다시 시작하세요. 두 곳에는 같은 짝 표시가 있어, 서버는 짝이 맞지 않는 폴더를 만나면 아무 파일도 지우지 않고 멈춥니다 — " +
        "DB 만 옮기고 폴더를 그대로 두면 새 DB 의 시작이 멈춥니다.",
    );
  });

  test("openMemoryDatabase 가 기존 차원과 다른 embeddingDim 요청 시 멈춘다 (파일 DB)", () => {
    // 파일 DB 로 실제 재오픈 흐름을 검증한다 — :memory: 는 핸들마다 별 DB 라 모사 불가.
    const file = makeTempDbFile();
    // 1차: 384로 명시 생성하고 글 벡터 한 줄 넣어 vec_nodes 실체화.
    const db1 = openMemoryDatabase(file, { embeddingDim: 384 });
    db1.prepare("INSERT INTO knowledge_nodes (content) VALUES ('차원 검사')").run();
    db1.prepare("INSERT INTO vec_nodes (node_id, embedding) VALUES (1, ?)")
      .run(makeDimEmbedding(1, 384));
    db1.close();

    // 2차: 같은 파일을 1024 로 열려 하면 구체 에러로 멈춘다 (silent fallback 아님).
    expect(() => openMemoryDatabase(file, { embeddingDim: 1024 }))
      .toThrow(EmbeddingDimMismatchError);

    // 데이터는 그대로 — 코드가 운영 DB 를 자동 삭제하지 않았음을 확인.
    const db2 = openMemoryDatabase(file, { embeddingDim: 384 }); // 384 로 다시 정상 오픈
    const cnt = (db2.prepare("SELECT COUNT(*) AS c FROM knowledge_nodes").get() as CountRow).c;
    expect(cnt).toBe(1);
    db2.close();
  });

  test("readExistingVecNodesDim — vec_nodes 없는 빈 핸들은 null", () => {
    const raw = new Database(":memory:");
    sqliteVec.load(raw);
    expect(readExistingVecNodesDim(raw)).toBeNull();
    raw.close();
  });

  test("같은 384 차원으로 재오픈은 통과 (불일치 아님)", () => {
    const file = makeTempDbFile();
    const db1 = openMemoryDatabase(file, { embeddingDim: 384 });
    db1.prepare("INSERT INTO knowledge_nodes (content) VALUES ('같은 차원')").run();
    db1.close();
    // 같은 차원이면 에러 없이 정상 재오픈, 데이터도 그대로.
    const db2 = openMemoryDatabase(file, { embeddingDim: 384 });
    const cnt = (db2.prepare("SELECT COUNT(*) AS c FROM knowledge_nodes").get() as CountRow).c;
    expect(cnt).toBe(1);
    db2.close();
  });
});

describe("vec 차원 가드 8 표 (글 모델 6 + SigLIP 2)", () => {
  test("TEXT_MODEL_VEC_TABLES 6개 + SIGLIP_VEC_TABLES 2개 = 현존 8 vec0 테이블", () => {
    expect([...TEXT_MODEL_VEC_TABLES]).toEqual([
      "vec_nodes",
      "concept_vec",
      "person_vec",
      "entities_vec",
      "chunk_summary_vec",
      "relation_summary_vec",
    ]);
    expect([...SIGLIP_VEC_TABLES]).toEqual(["concept_siglip_vec", "image_vec"]);
    expect(SIGLIP_VEC_DIM).toBe(768);

    // 그 8개가 실제로 빈 DB 에 모두 만들어졌는지 확인 — 목록이 스키마와 어긋나면
    // 가드에 구멍이 생긴다.
    const db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    for (const t of [...TEXT_MODEL_VEC_TABLES, ...SIGLIP_VEC_TABLES]) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get(t) as SqliteMasterRow | null;
      expect(row?.name).toBe(t);
    }
    db.close();
  });

  test("readVecTableDim — 글 모델 6 테이블은 embeddingDim, SigLIP 2 테이블은 768", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    for (const t of TEXT_MODEL_VEC_TABLES) {
      expect(readVecTableDim(db, t)).toBe(384);
    }
    for (const t of SIGLIP_VEC_TABLES) {
      expect(readVecTableDim(db, t)).toBe(768);
    }
    // 없는 테이블은 null.
    expect(readVecTableDim(db, "no_such_vec")).toBeNull();
    db.close();
  });

  test("assertVecTableDims — 정상 DB(글 384·SigLIP 768)는 통과", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    expect(() => assertVecTableDims(db, 384)).not.toThrow();
    db.close();
  });

  test("assertVecTableDims — 글 모델 테이블 차원이 어긋나면 그 테이블명으로 멈춘다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    // 현존 DB 는 글 384 인데 1024 를 기대하면 첫 글 모델 테이블(vec_nodes)에서 멈춘다.
    expect(() => assertVecTableDims(db, 1024)).toThrow(EmbeddingDimMismatchError);
    try {
      assertVecTableDims(db, 1024);
    } catch (e) {
      const err = e as EmbeddingDimMismatchError;
      expect(err.existingDim).toBe(384);
      expect(err.requestedDim).toBe(1024);
      expect(TEXT_MODEL_VEC_TABLES).toContain(err.tableName as never);
    }
    db.close();
  });

  test("vec_nodes 가 비어도 다른 글 모델 vec 테이블 비대칭을 잡는다", () => {
    // 옛 가드(vec_nodes 1개)가 못 잡던 흐름: vec_nodes 는 안 만들어졌는데
    // concept_vec 만 옛 차원으로 남은 경우. 생짜 핸들에 글 모델 vec 테이블 하나만
    // 1024 로 만들고, vec_nodes 는 없는 상태에서 384 를 기대하면 멈춰야 한다.
    const raw = new Database(":memory:");
    sqliteVec.load(raw);
    raw.run(
      `CREATE VIRTUAL TABLE concept_vec USING vec0(concept_rowid INTEGER PRIMARY KEY, embedding float[1024] distance_metric=cosine)`,
    );
    // vec_nodes 는 없음 → readExistingVecNodesDim 은 null 이라 vec_nodes 단일 검사로는 못 친다.
    expect(readExistingVecNodesDim(raw)).toBeNull();
    // 8 테이블 가드는 concept_vec(1024) vs 384 불일치를 잡는다.
    expect(() => assertVecTableDims(raw, 384)).toThrow(EmbeddingDimMismatchError);
    try {
      assertVecTableDims(raw, 384);
    } catch (e) {
      expect((e as EmbeddingDimMismatchError).tableName).toBe("concept_vec");
    }
    raw.close();
  });

  test("SigLIP 테이블이 768 아닌 차원이면 그 테이블명으로 멈춘다", () => {
    // SigLIP 은 글 모델과 무관하게 768 고정. 만약 image_vec 가 1024 로 잘못
    // 만들어졌다면(글 모델 차원 오연동), 글 차원이 1024 여도 SigLIP 검사가 잡는다.
    const raw = new Database(":memory:");
    sqliteVec.load(raw);
    raw.run(
      `CREATE VIRTUAL TABLE image_vec USING vec0(node_id INTEGER PRIMARY KEY, embedding float[1024] distance_metric=cosine)`,
    );
    expect(() => assertVecTableDims(raw, 1024)).toThrow(EmbeddingDimMismatchError);
    try {
      assertVecTableDims(raw, 1024);
    } catch (e) {
      const err = e as EmbeddingDimMismatchError;
      expect(err.tableName).toBe("image_vec");
      expect(err.existingDim).toBe(1024);
      expect(err.requestedDim).toBe(768);
    }
    raw.close();
  });

  test("openMemoryDatabase 파일 DB 가 글 모델 차원 비대칭에 멈추고 데이터 보존", () => {
    const file = makeTempDbFile();
    const db1 = openMemoryDatabase(file, { embeddingDim: 384 });
    db1.prepare("INSERT INTO knowledge_nodes (content) VALUES ('M3 차원 검사')").run();
    db1.close();

    // 같은 파일을 1024 로 열면 8 테이블 가드가 멈춘다.
    expect(() => openMemoryDatabase(file, { embeddingDim: 1024 })).toThrow(
      EmbeddingDimMismatchError,
    );

    // 운영 DB 자동 삭제 없음 — 데이터 보존.
    const db2 = openMemoryDatabase(file, { embeddingDim: 384 });
    const cnt = (
      db2.prepare("SELECT COUNT(*) AS c FROM knowledge_nodes").get() as CountRow
    ).c;
    expect(cnt).toBe(1);
    db2.close();
  });
});
