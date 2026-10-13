/**
 * bm25-cross.test.ts — computeBM25Cross 통합 테스트.
 *
 * 실 `:memory:` SQLite + FTS5 색인을 직접 사용한다(mock 없음).
 * 후보 nodeId 목록과 확장 query 를 넘기면 단일-doc BM25 점수가
 * 관련 노드에서 더 높게 나오는지 검증한다.
 */
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { computeBM25Cross } from "./bm25-cross.ts";

let db: Database;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  // 테스트용 노드 삽입 — 임베딩 없이 content 만 넣는다.
  // knowledge_nodes_fts 는 migrations 에서 생성되므로 별도 DDL 불필요.
  const insert = db.prepare(
    "INSERT INTO knowledge_nodes(content, source_type, importance, mention_count) VALUES(?, 'test', 0.5, 0)",
  );
  insert.run("커피 원두 에스프레소 로스팅 향미");      // id=1 — 커피 관련
  insert.run("커피 드립 핸드드립 원두 분쇄");          // id=2 — 커피 관련
  insert.run("프로그래밍 TypeScript 타입 시스템");     // id=3 — 무관
  insert.run("날씨 오늘 맑음 기온 25도");               // id=4 — 무관
});

afterEach(() => {
  db.close();
});

describe("computeBM25Cross", () => {
  test("커피 query — 관련 노드가 무관 노드보다 점수 높음", async () => {
    // 노드 id 는 삽입 순서에 따라 자동 증가. 실제 id 를 조회한다.
    const rows = db
      .prepare("SELECT id FROM knowledge_nodes ORDER BY id ASC")
      .all() as Array<{ id: number }>;
    const [id1, id2, id3, id4] = rows.map((r) => r.id);

    const scores = await computeBM25Cross(db, "커피 원두", [id1!, id2!, id3!, id4!]);

    expect(scores.size).toBe(4);

    const score1 = scores.get(id1!) ?? 0;
    const score2 = scores.get(id2!) ?? 0;
    const score3 = scores.get(id3!) ?? 0;
    const score4 = scores.get(id4!) ?? 0;

    // 커피 관련 노드가 무관 노드보다 높아야 한다.
    expect(score1).toBeGreaterThan(score3);
    expect(score1).toBeGreaterThan(score4);
    expect(score2).toBeGreaterThan(score3);
    expect(score2).toBeGreaterThan(score4);

    // 모든 점수는 0~1 범위.
    for (const s of [score1, score2, score3, score4]) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  test("후보 0개 → 빈 Map 반환(에러 없음)", async () => {
    const scores = await computeBM25Cross(db, "커피", []);
    expect(scores.size).toBe(0);
  });

  test("query 가 어느 노드와도 매치 안 됨 → 모든 점수 0.5 미만", async () => {
    const rows = db
      .prepare("SELECT id FROM knowledge_nodes ORDER BY id ASC")
      .all() as Array<{ id: number }>;
    const ids = rows.map((r) => r.id);

    // 코퍼스에 전혀 없는 단어
    const scores = await computeBM25Cross(db, "zxqwerty99", ids);
    for (const id of ids) {
      // 매치 없음 → sigmoid(0) = 0.5, 실제론 FTS5 가 후보를 못 찾아 0 처리됨
      expect(scores.get(id) ?? 0).toBeLessThanOrEqual(0.5);
    }
  });

  test("단일 후보 — Map 크기 1, 점수 0~1", async () => {
    const rows = db
      .prepare("SELECT id FROM knowledge_nodes ORDER BY id ASC LIMIT 1")
      .all() as Array<{ id: number }>;
    const [id] = rows.map((r) => r.id);

    const scores = await computeBM25Cross(db, "커피", [id!]);
    expect(scores.size).toBe(1);
    const s = scores.get(id!) ?? -1;
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});
