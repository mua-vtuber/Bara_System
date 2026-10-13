/**
 * concept-siglip-backfill.test.ts — Task 4 (b-B2) 검증.
 *
 * 실제 SQLite(`openMemoryDatabase(":memory:", { embeddingDim: 384 })`) + 실제 concept_siglip_vec 로
 * 검증한다. Mock 클래스 금지(CLAUDE.md). 임베더는 두 경로로 검증한다:
 *
 *  1. 실제 SigLIP text encoder 통합(E2E) — WSL bun 에서 ~2.2초 로드 정상 확인됨
 *     (Phase 11d 의 onnxruntime hang 미재현). 실제 768-dim 임베딩이 적재되고
 *     멱등이 성립하는지 확인.
 *  2. 데이터 fixture 임베더(mock 클래스 아님 — 순수 함수 + 미리 계산한 Float32Array)
 *     로 SQLite 적재 / 멱등 / dim mismatch throw / graceful skip 의 *로직* 분기를
 *     모델 부담 없이 명시 검증.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../migrations.ts";
import {
  backfillConceptSiglipEmbeddings,
  defaultSiglipTextEmbedder,
  type SiglipTextEmbedder,
} from "./concept-siglip-backfill.ts";
import { SIGLIP2_TEXT_DIM } from "../../embedding/siglip2-text.ts";

/** 개념 노드 하나 직접 INSERT (concept_id NOT NULL, name UNIQUE NOT NULL). */
function insertConcept(db: Database, conceptId: string, name: string): number {
  db.run(
    "INSERT INTO concept_nodes(concept_id, name, is_tag) VALUES (?, ?, 1)",
    [conceptId, name],
  );
  return Number(
    (db.prepare("SELECT rowid AS r FROM concept_nodes WHERE concept_id = ?").get(
      conceptId,
    ) as { r: number }).r,
  );
}

function countSiglipVec(db: Database): number {
  return Number(
    (db.prepare("SELECT COUNT(*) AS c FROM concept_siglip_vec").get() as {
      c: number;
    }).c,
  );
}

/**
 * 데이터 fixture 임베더 — 미리 계산한(여기선 결정적 합성) 768-dim Float32Array 를
 * 반환하는 순수 어댑터. mock 클래스 아님. dim/null 분기를 옵션으로 강제할 수 있다.
 */
function makeFixtureEmbedder(opts?: {
  available?: boolean;
  forceDim?: number;
  returnNullFor?: string;
}): SiglipTextEmbedder {
  const available = opts?.available ?? true;
  const dim = SIGLIP2_TEXT_DIM;
  return {
    dim,
    load: async () => available,
    embed: async (text: string) => {
      if (opts?.returnNullFor !== undefined && text === opts.returnNullFor) {
        return null;
      }
      const len = opts?.forceDim ?? dim;
      const v = new Float32Array(len);
      // 텍스트에서 결정적 채움 — 같은 입력은 같은 벡터(멱등 검증 안정).
      for (let i = 0; i < len; i++) {
        v[i] = ((text.charCodeAt(i % Math.max(text.length, 1)) % 17) + 1) / 17;
      }
      return v;
    },
  };
}

describe("backfillConceptSiglipEmbeddings — fixture 로직 분기", () => {
  let db: Database;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  });
  afterEach(() => {
    db.close();
  });

  test("concept_siglip_vec 없는 개념 전체를 768-dim 으로 채운다", async () => {
    insertConcept(db, "cpt_a", "만화");
    insertConcept(db, "cpt_b", "주술회전");
    insertConcept(db, "cpt_c", "일러스트");

    const filled = await backfillConceptSiglipEmbeddings(db, makeFixtureEmbedder());
    expect(filled).toBe(3);
    expect(countSiglipVec(db)).toBe(3);

    // 적재된 벡터 차원 확인 — vec0 가 768-dim 으로 받았다.
    const row = db
      .prepare(
        "SELECT vec_length(embedding) AS n FROM concept_siglip_vec LIMIT 1",
      )
      .get() as { n: number };
    expect(row.n).toBe(SIGLIP2_TEXT_DIM);
  });

  test("멱등 — 두 번 실행해도 중복 0 (이미 있는 개념 건너뜀)", async () => {
    insertConcept(db, "cpt_a", "만화");
    insertConcept(db, "cpt_b", "주술회전");

    const first = await backfillConceptSiglipEmbeddings(db, makeFixtureEmbedder());
    expect(first).toBe(2);
    expect(countSiglipVec(db)).toBe(2);

    // 두 번째 실행 — 채운 개념 0, 총 행 수 불변.
    const second = await backfillConceptSiglipEmbeddings(db, makeFixtureEmbedder());
    expect(second).toBe(0);
    expect(countSiglipVec(db)).toBe(2);
  });

  test("멱등 — 새 개념만 증분으로 채운다", async () => {
    insertConcept(db, "cpt_a", "만화");
    await backfillConceptSiglipEmbeddings(db, makeFixtureEmbedder());
    expect(countSiglipVec(db)).toBe(1);

    insertConcept(db, "cpt_b", "주술회전");
    const filled = await backfillConceptSiglipEmbeddings(db, makeFixtureEmbedder());
    expect(filled).toBe(1); // 새로 추가된 cpt_b 만
    expect(countSiglipVec(db)).toBe(2);
  });

  test("dim mismatch — 768 아닌 임베딩이면 구체 에러 throw (concept_id 포함)", async () => {
    insertConcept(db, "cpt_bad", "잘못된차원");
    const bad = makeFixtureEmbedder({ forceDim: 384 });

    expect(backfillConceptSiglipEmbeddings(db, bad)).rejects.toThrow(
      /dim mismatch.*got 384.*expected 768.*cpt_bad/,
    );
    // 실패 전에는 적재 안 됨(첫 행에서 throw).
    expect(countSiglipVec(db)).toBe(0);
  });

  test("embed null — 구체 에러 throw (silent skip 아님)", async () => {
    insertConcept(db, "cpt_null", "널반환");
    const nullEmb = makeFixtureEmbedder({ returnNullFor: "널반환" });

    expect(backfillConceptSiglipEmbeddings(db, nullEmb)).rejects.toThrow(
      /returned null.*cpt_null/,
    );
    expect(countSiglipVec(db)).toBe(0);
  });

  test("graceful — 모델 미가용이면 backfill 건너뜀 + 0 반환 (가짜 임베딩 0)", async () => {
    insertConcept(db, "cpt_a", "만화");
    insertConcept(db, "cpt_b", "주술회전");

    const offline = makeFixtureEmbedder({ available: false });
    const filled = await backfillConceptSiglipEmbeddings(db, offline);
    expect(filled).toBe(0);
    // 가짜 임베딩(0 벡터)을 채우지 않았다 — 행 0.
    expect(countSiglipVec(db)).toBe(0);
  });

  test("개념 0개 DB — 0 반환, 에러 없음", async () => {
    const filled = await backfillConceptSiglipEmbeddings(db, makeFixtureEmbedder());
    expect(filled).toBe(0);
    expect(countSiglipVec(db)).toBe(0);
  });
});

describe("backfillConceptSiglipEmbeddings — 실제 SigLIP text encoder 통합(E2E)", () => {
  let db: Database;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  });
  afterEach(() => {
    db.close();
  });

  test("실제 모델로 개념 name 임베딩 적재 + 멱등", async () => {
    insertConcept(db, "cpt_a", "만화");
    insertConcept(db, "cpt_b", "주술회전");

    const filled = await backfillConceptSiglipEmbeddings(
      db,
      defaultSiglipTextEmbedder,
    );
    expect(filled).toBe(2);
    expect(countSiglipVec(db)).toBe(2);

    const row = db
      .prepare(
        "SELECT vec_length(embedding) AS n FROM concept_siglip_vec LIMIT 1",
      )
      .get() as { n: number };
    expect(row.n).toBe(SIGLIP2_TEXT_DIM);

    // 멱등 — 같은 모델 두 번째 실행은 0.
    const second = await backfillConceptSiglipEmbeddings(
      db,
      defaultSiglipTextEmbedder,
    );
    expect(second).toBe(0);
    expect(countSiglipVec(db)).toBe(2);
  }, 60_000);
});
