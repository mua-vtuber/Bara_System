/**
 * concept-embedding-backfill 통합 테스트 (P3 G1-a — 죽은 배선 살림).
 *
 * backfillConceptEmbeddings 는 옛 개념 행에 embedding_text + concept_vec 를 채우는
 * 관리 도구다. P3 이전에는 정의만 있고 호출처가 0(죽은 배선)이었고, 이제
 * scripts/backfill-concept-embeddings.ts CLI 가 이 함수를 실행한다. 이 테스트는 그
 * 코어 함수가 실제 DB + 실제 임베더로 동작함을 실증한다 — CLI 가 부르는 함수가
 * 실행 가능하다는 배선 증거다.
 *
 * 실 Bgem3Embedder(1024 dim) + 실 openMemoryDatabase. mock 금지(CLAUDE.md 정책 —
 * 인터페이스 mock 안 만들고 실제 구현체로 통합 검증). concept_vec 는 embeddingDim
 * 에 맞춰 만들어지므로 embedder(1024)와 DB(1024)를 맞춘다.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { backfillConceptEmbeddings } from "./concept-embedding-backfill.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

afterAll(() => {});

/** concept_vec 없는 개념 행 수를 센다(멱등 검증용). */
function pendingConceptCount(db: Database): number {
  return (
    db
      .query(
        `SELECT COUNT(*) AS n FROM concept_nodes cn
         WHERE cn.rowid NOT IN (SELECT concept_rowid FROM concept_vec)`,
      )
      .get() as { n: number }
  ).n;
}

/** concept_vec 에 든 벡터의 차원을 센다(채워졌는지 확인용). */
function conceptVecCount(db: Database): number {
  return (db.query(`SELECT COUNT(*) AS n FROM concept_vec`).get() as { n: number })
    .n;
}

describe("backfillConceptEmbeddings — CLI 코어 실행(P3 G1-a)", () => {
  let db: Database;

  beforeEach(() => {
    // bge-m3 1024 dim 에 맞춰 concept_vec 을 float[1024] 로 만든다.
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  });

  afterEach(() => {
    db.close();
  });

  test("concept_vec 없는 개념에 embedding_text + concept_vec 를 채운다", async () => {
    // concept_vec 없는 개념 3개 삽입(이름만 — embedding_text 는 NULL).
    db.run("INSERT INTO concept_nodes(concept_id, name) VALUES (?, ?)", [
      "cpt_a",
      "만화",
    ]);
    db.run(
      "INSERT INTO concept_nodes(concept_id, name, ko_name, description) VALUES (?, ?, ?, ?)",
      ["cpt_b", "주술회전", "주술회전", "아쿠타미 게게 만화"],
    );
    db.run("INSERT INTO concept_nodes(concept_id, name) VALUES (?, ?)", [
      "cpt_c",
      "고죠",
    ]);

    expect(pendingConceptCount(db)).toBe(3);
    expect(conceptVecCount(db)).toBe(0);

    const filled = await backfillConceptEmbeddings(db, embedder);

    // 3개 전부 채워졌다.
    expect(filled).toBe(3);
    expect(pendingConceptCount(db)).toBe(0);
    expect(conceptVecCount(db)).toBe(3);

    // embedding_text 도 합성돼 저장됐다(name+ko_name+description 합성 / 여기선 name 포함).
    const b = db
      .query("SELECT embedding_text FROM concept_nodes WHERE concept_id = ?")
      .get("cpt_b") as { embedding_text: string | null };
    expect(b.embedding_text).not.toBeNull();
    expect(b.embedding_text).toContain("주술회전");
    expect(b.embedding_text).toContain("아쿠타미");
  });

  test("멱등 — 이미 concept_vec 있는 개념은 재실행 시 건너뛴다", async () => {
    db.run("INSERT INTO concept_nodes(concept_id, name) VALUES (?, ?)", [
      "cpt_x",
      "토끼",
    ]);
    // 1차 backfill — 1개 채움.
    expect(await backfillConceptEmbeddings(db, embedder)).toBe(1);
    // 2차 backfill — 이미 있으니 0개(멱등).
    expect(await backfillConceptEmbeddings(db, embedder)).toBe(0);
    expect(conceptVecCount(db)).toBe(1);

    // 새 개념을 하나 더 넣으면 그것만 채운다(부분 backfill).
    db.run("INSERT INTO concept_nodes(concept_id, name) VALUES (?, ?)", [
      "cpt_y",
      "거북이",
    ]);
    expect(await backfillConceptEmbeddings(db, embedder)).toBe(1);
    expect(conceptVecCount(db)).toBe(2);
  });

  test("채울 개념 0개면 0 반환(빈 상태 정직)", async () => {
    // concept_nodes 가 비었으면 backfill 은 0개 — 에러 아님(정직한 빈 결과).
    expect(await backfillConceptEmbeddings(db, embedder)).toBe(0);
    expect(conceptVecCount(db)).toBe(0);
  });

  test("차원 불일치는 loud throw — concept_id 를 메시지에 담는다(정직한 실패)", async () => {
    // DB 의 concept_vec 을 embedder 와 다른 차원(384)으로 만들면, embedder(1024)가
    // 낸 벡터 길이가 안 맞아 backfill 이 loud throw 한다(silent fallback 금지).
    const mismatchDb = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    mismatchDb.run("INSERT INTO concept_nodes(concept_id, name) VALUES (?, ?)", [
      "cpt_mismatch",
      "차원어긋남",
    ]);
    // Bgem3Embedder.dimension 은 1024 — concept_vec 은 384. embed 출력(1024)이
    // embedder.dimension(1024)과는 같지만, INSERT 시 concept_vec(384)이 거부한다.
    // 실제 운영 오작동(모델 전환 후 DB 차원 불일치)을 이 경로로 재현한다.
    await expect(
      backfillConceptEmbeddings(mismatchDb, embedder),
    ).rejects.toThrow();
    mismatchDb.close();
  });
});
