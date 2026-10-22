/**
 * retriever.filter-pushdown.test.ts — sqlite-vec 필터 pushdown 실동작 동결 (T4).
 *
 * 실 bun:sqlite + 실 sqlite-vec. 임베더 불필요(방향을 직접 지정한 결정적 벡터를 써서
 * "정답이 전역 순위 꼴찌" 조건을 흔들림 없이 만든다 — 데이터 fixture 만 쓰고 인터페이스
 * 가짜 구현은 만들지 않는다).
 *
 * 왜 이 시험이 있는가 — T3 실사는 `node_id IN (...) AND k = ?` 가 k 절단을 통과 집합
 * *안쪽* 에서 수행한다고 판정했고 T4 1차는 그대로 구현하려 했다. 설치본에서 재현하니
 * 조건부(`|pass| <= k`)로만 성립했다. 재판정 계약은 이 경계를 **역이용** 한다 — 통과
 * 집합을 미리 계산해 그 크기에 맞춰 k 를 올리면 전제조건이 강제 성립해 회수 1.0 이
 * 구조적으로 보장된다. 이 시험은 그 경계 법칙 자체를 수치로 동결해, 상류(sqlite-vec)가
 * 동작을 바꾸면(ANN 도입 포함) 먼저 깨져 재검토 신호가 되게 한다.
 *
 * **sqlite-vec 버전 상향 시 이 파일이 통과하는지 먼저 확인할 것** — 경계가 바뀌면
 * 적응형 공급의 전제(조각마다 k = 조각 크기면 그 조각 전체가 순위화 회신)가 깨진다.
 *
 * 함께 검증: k 상한 4096, 조각 분할 정확성, 전역 변형 필터 = 후보형 짝 동치.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import type { Embedder } from "../embedding/types.ts";
import {
  computeVectorPassSet,
  planVisibleSupply,
  searchVisibleFts,
  searchVisibleVectors,
} from "./retrieve-visibility-pushdown.ts";
import { getMemoryVisibilitySnapshot } from "./shared-memory-read.ts";
import {
  filterNodeIdsByMemoryType,
  filterOutPendingReview,
  filterNodeIdsByDateRange,
  selectNodeIdsByMemoryType,
  selectNodeIdsNotPendingReview,
  selectAllNodeIdsByDateRange,
} from "../db/store-internal/search-repo-filters.ts";
import {
  searchByVectorRaw,
  VEC0_MAX_K,
} from "../db/store-internal/search-repo-vec-fts.ts";
import { globalScope } from "../test-utils/resolved-scope.ts";

/** 시험용 벡터 차원 — 방향만 지정하면 되므로 작게 잡아 빠르게 돌린다. */
const DIM = 8;

/**
 * `searchByVectorRaw` 가 embedder 에서 읽는 것은 `dimension` 하나뿐이다(질의 벡터
 * 차원 검증용). 이 시험들은 방향을 직접 지정한 결정적 벡터를 쓰므로 모델을 띄울
 * 이유가 없어, 차원만 알려주는 최소 객체를 넘긴다.
 *
 * mock 객체가 아니다 — `embed`/`embedBatch`/`load` 를 *가짜로 구현하지 않고* 호출되면
 * 던지게 둔다. 그래서 이 시험이 임베딩 결과에 의존하도록 바뀌는 순간 조용히 통과하지
 * 않고 즉시 실패한다(가짜 임베딩으로 초록불을 만드는 일이 구조적으로 불가능).
 */
function dimensionOnlyEmbedder(): Embedder {
  const notUsed = (name: string) => (): never => {
    throw new Error(
      `dimensionOnlyEmbedder.${name} was called — 이 시험은 embedder 를 쓰지 않아야 한다`,
    );
  };
  return {
    dimension: DIM,
    load: notUsed("load"),
    embed: notUsed("embed"),
    embedBatch: notUsed("embedBatch"),
  };
}

/** 주어진 성분을 L2 정규화한 벡터(cosine 거리 계산이 방향만 보게 한다). */
function unit(components: readonly number[]): Float32Array {
  const v = new Float32Array(DIM);
  components.forEach((x, i) => {
    v[i] = x;
  });
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIM; i++) v[i] = v[i]! / norm;
  return v;
}

describe("sqlite-vec 필터 pushdown 실동작 (T4 실측 동결)", () => {
  let db: Database;
  /** 질의 방향 — [1,0,...]. gold 는 여기 직교(가장 먼 글), 나머지는 가깝다. */
  const query = unit([1, 0, 0, 0, 0, 0, 0, 0]);
  const GOLD_ID = 1;
  const CORPUS = 100;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    const insNode = db.prepare(
      `INSERT INTO knowledge_nodes
         (id, content, memory_type, created_at, updated_at, last_accessed_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
    );
    const insVec = db.prepare(
      "INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)",
    );
    db.exec("BEGIN");
    // gold — 질의와 직교라 전역 유사도 꼴찌. 유일한 preference 글.
    insNode.run(GOLD_ID, "gold", "preference");
    insVec.run(GOLD_ID, unit([0, 1, 0, 0, 0, 0, 0, 0]));
    // distractor — 전부 질의와 거의 같은 방향이라 전역 상위를 독점한다.
    for (let i = 2; i <= CORPUS; i++) {
      insNode.run(i, `distractor ${i}`, "fact");
      insVec.run(i, unit([1, 0.01 * i, 0, 0, 0, 0, 0, 0]));
    }
    db.exec("COMMIT");
  });
  afterEach(() => db.close());

  /** pushdown 질의 — 통과 집합을 IN 으로 주고 k 로 절단. */
  function pushdown(passIds: readonly number[], k: number): number[] {
    const ph = passIds.map(() => "?").join(",");
    return (
      db
        .prepare(
          `SELECT node_id FROM vec_nodes
             WHERE embedding MATCH ? AND node_id IN (${ph}) AND k = ?`,
        )
        .all(query, ...passIds, k) as Array<{ node_id: number }>
    ).map((r) => r.node_id);
  }

  /** 현행 경로 — 전역 k 절단 뒤 JS 로 통과 집합 교집합(사후 필터). */
  function postFilter(passIds: readonly number[], k: number): number[] {
    return (
      db
        .prepare(
          `SELECT node_id FROM vec_nodes
             WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
        )
        .all(query, k) as Array<{ node_id: number }>
    )
      .map((r) => r.node_id)
      .filter((id) => passIds.includes(id));
  }

  test("전제 확인 — gold 는 전역 유사도 꼴찌라 상위 k 밖이다", () => {
    const globalTop20 = (
      db
        .prepare(
          "SELECT node_id FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT ?",
        )
        .all(query, 20) as Array<{ node_id: number }>
    ).map((r) => r.node_id);
    expect(globalTop20).not.toContain(GOLD_ID);
  });

  test("통과 집합이 k 이하면 pushdown 이 pre-filter 로 동작한다(gold 회수)", () => {
    // gold + 전역 하위 distractor 몇 개 → |통과 집합| <= k(20).
    const pass = [GOLD_ID, CORPUS, CORPUS - 1, CORPUS - 2, CORPUS - 3];
    expect(pass.length).toBeLessThanOrEqual(20);
    expect(pushdown(pass, 20)).toContain(GOLD_ID);
    // 같은 조건에서 현행 사후 필터는 gold 를 놓친다 — 이득이 실재하는 구간.
    expect(postFilter(pass, 20)).not.toContain(GOLD_ID);
  });

  test("통과 집합이 k 를 넘으면 pushdown 이 사후 필터로 퇴화한다(이득 0)", () => {
    // |통과 집합| = 40 > k(20). T3 판정대로면 여기서도 gold 를 회수해야 하지만,
    // 설치본은 전역 상위 k 를 먼저 뽑고 IN 으로 거르므로 gold 가 빠진다.
    const pass = [GOLD_ID, ...Array.from({ length: 39 }, (_, i) => CORPUS - i)];
    expect(pass.length).toBeGreaterThan(20);
    // 핵심 손실: 통과 집합 안의 정답을 못 건진다 — 현행 사후 필터와 같은 실패다.
    expect(pushdown(pass, 20)).not.toContain(GOLD_ID);
    expect(postFilter(pass, 20)).not.toContain(GOLD_ID);
    // 회신 행 수는 서로 다를 수 있다(pushdown 이 통과 집합 안에서 더 채워 넣는다).
    // 그래도 "필터를 통과하는 최선의 글을 회수한다"는 목적은 달성되지 않는다 —
    // 회수 여부가 같으므로 도입 이득이 0 이라는 판단은 그대로다.
    expect(pushdown(pass, 20).length).toBeGreaterThan(0);
  });

  test("경계는 정확히 k — k 를 통과 집합 크기까지 올리면 다시 회수된다", () => {
    const pass = [GOLD_ID, ...Array.from({ length: 39 }, (_, i) => CORPUS - i)];
    expect(pushdown(pass, pass.length)).toContain(GOLD_ID);
  });

  test("원소 1개짜리 IN 목록은 빈 결과 — 상류 결함(같은 id 중복이면 회신)", () => {
    // 가장 좁은 필터에서 조용히 0건이 되는 갈래. 이 동작이 고쳐지면 시험이 깨져
    // pushdown 재검토 신호가 된다.
    expect(pushdown([GOLD_ID], 20)).toEqual([]);
    const ph = "?,?";
    const dup = (
      db
        .prepare(
          `SELECT node_id FROM vec_nodes
             WHERE embedding MATCH ? AND node_id IN (${ph}) AND k = ?`,
        )
        .all(query, GOLD_ID, GOLD_ID, 20) as Array<{ node_id: number }>
    ).map((r) => r.node_id);
    expect(dup).toContain(GOLD_ID);
  });

  test("vec0 metadata 칸은 k 절단 안쪽에서 제대로 거른다(후속 결정 근거)", () => {
    // 상류가 문서로 지원한다고 밝힌 pre-filter 통로. vec_nodes 스키마 변경이
    // 필요해 T4 범위 밖이지만, 실제로 동작함을 여기서 못박아 후속 판단 근거로 남긴다.
    db.exec(
      `CREATE VIRTUAL TABLE vec_meta_probe USING vec0(
         embedding float[${DIM}] distance_metric=cosine, memory_type text)`,
    );
    const ins = db.prepare(
      "INSERT INTO vec_meta_probe (rowid, embedding, memory_type) VALUES (?, ?, ?)",
    );
    ins.run(GOLD_ID, unit([0, 1, 0, 0, 0, 0, 0, 0]), "preference");
    for (let i = 2; i <= CORPUS; i++) {
      ins.run(i, unit([1, 0.01 * i, 0, 0, 0, 0, 0, 0]), "fact");
    }
    const rows = (
      db
        .prepare(
          `SELECT rowid FROM vec_meta_probe
             WHERE embedding MATCH ? AND memory_type = ? AND k = ?`,
        )
        .all(query, "preference", 20) as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    expect(rows).toContain(GOLD_ID);
  });

  test("조각 크기 상수는 vec0 k 상한과 같고 바인딩 벽 아래다", () => {
    // 조각 크기 = 상류 k 하드 상한. 이보다 크게 잡으면 질의가 거부되고, 조각당
    // 파라미터가 이 값을 안 넘어 SQLite 바인딩 벽(약 65533)에는 구조적으로 안 닿는다.
    expect(VEC0_MAX_K).toBe(4096);
    expect(VEC0_MAX_K).toBeLessThan(65_533);
  });

  test("vec0 k 상한 4096 — 초과 질의는 상류가 거부한다", () => {
    const over = () =>
      db
        .prepare(
          "SELECT node_id FROM vec_nodes WHERE embedding MATCH ? AND k = ?",
        )
        .all(query, VEC0_MAX_K + 1);
    expect(over).toThrow(/too large/);
    // 상한 자체는 통과(코퍼스가 작아 행 수만큼만 회신).
    const at = db
      .prepare("SELECT node_id FROM vec_nodes WHERE embedding MATCH ? AND k = ?")
      .all(query, VEC0_MAX_K) as Array<{ node_id: number }>;
    expect(at.length).toBe(CORPUS);
  });
});

describe("통과 집합 적응형 공급 — searchByVectorRaw 갈래 (T4 재판정)", () => {
  let db: Database;
  const query = unit([1, 0, 0, 0, 0, 0, 0, 0]);
  const GOLD_ID = 1;
  const CORPUS = 3000;
  const dimOnly = dimensionOnlyEmbedder();

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    const insNode = db.prepare(
      `INSERT INTO knowledge_nodes
         (id, content, memory_type, created_at, updated_at, last_accessed_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
    );
    const insVec = db.prepare(
      "INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)",
    );
    db.exec("BEGIN");
    // gold — 질의와 직교라 전역 유사도 꼴찌(상위 k 밖이 확실).
    insNode.run(GOLD_ID, "gold", "preference");
    insVec.run(GOLD_ID, unit([0, 1, 0, 0, 0, 0, 0, 0]));
    for (let i = 2; i <= CORPUS; i++) {
      insNode.run(i, `d${i}`, i % 3 === 0 ? "preference" : "fact");
      insVec.run(i, unit([1, 0.0001 * i, 0, 0, 0, 0, 0, 0]));
    }
    db.exec("COMMIT");
  });
  afterEach(() => db.close());

  test("통과 집합 전체가 순위화 회신 — 전역 꼴찌 정답도 회수한다", async () => {
    for (const passSize of [2, 5, 20, 21, 100, 1000]) {
      const pass = [GOLD_ID, ...Array.from({ length: passSize - 1 }, (_, i) => CORPUS - i)];
      const hits = await searchByVectorRaw(db, dimOnly, query, 20, pass);
      expect(hits.length).toBe(pass.length);
      expect(hits.map((h) => h.nodeId)).toContain(GOLD_ID);
      // 회신은 통과 집합 밖으로 새지 않는다.
      for (const h of hits) expect(pass).toContain(h.nodeId);
      // 거리 오름차순 — 호출자가 상위 vectorK 를 자를 수 있게.
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i]!.distance).toBeGreaterThanOrEqual(hits[i - 1]!.distance);
      }
    }
  });

  test("|pass|=1 — 상류 1개 IN 결함을 id 2회 기재로 우회(중복 행 없음)", async () => {
    const hits = await searchByVectorRaw(db, dimOnly, query, 20, [GOLD_ID]);
    expect(hits.map((h) => h.nodeId)).toEqual([GOLD_ID]); // 정확히 1행
  });

  test("|pass|=0 — 정직한 빈 결과(미지정과 구분)", async () => {
    expect(await searchByVectorRaw(db, dimOnly, query, 20, [])).toEqual([]);
    // 미지정은 현행 경로가 결과를 낸다 — 두 상태가 뭉개지면 필터가 사라진다.
    const unfiltered = await searchByVectorRaw(db, dimOnly, query, 20);
    expect(unfiltered.length).toBe(20);
  });

  test("k 상한 초과 통과 집합은 조각 분할 — 전수 계산과 상위 순위 일치", async () => {
    // |pass| > VEC0_MAX_K 라 조각이 2개 이상. 조각 경계가 순위를 깨지 않는지 확인한다.
    const pass = Array.from({ length: VEC0_MAX_K + 500 }, (_, i) => i + 1);
    const hits = await searchByVectorRaw(db, dimOnly, query, 20, pass);
    // 코퍼스가 3000이라 통과 집합 중 실재하는 id 만 회신된다.
    expect(hits.length).toBe(CORPUS);
    // 전수 계산(브루트포스) 상위 20 과 완전 일치.
    const rows = db
      .query("SELECT node_id, embedding FROM vec_nodes")
      .all() as Array<{ node_id: number; embedding: Uint8Array }>;
    const truth = rows
      .map((r) => {
        const f = new Float32Array(
          r.embedding.buffer,
          r.embedding.byteOffset,
          r.embedding.byteLength / 4,
        );
        let dot = 0;
        for (let i = 0; i < DIM; i++) dot += f[i]! * query[i]!;
        return { id: r.node_id, d: 1 - dot };
      })
      .sort((a, b) => a.d - b.d);
    // 거리 수열이 전수 계산과 일치하면 순위가 옳다. id 목록으로 비교하지 않는 이유:
    // 이 fixture 는 거리 동점이 생기고(예: 5.96e-8 을 공유하는 두 글) 동점의 id 순서는
    // 규정되지 않는다 — 동점 순서까지 단언하면 의미 없는 취약 시험이 된다. 값 비교도
    // 근사로 한다: 저장은 float32, 여기 전수 계산은 JS float64 라 말단 자리가 갈린다.
    const got = hits.slice(0, 20).map((h) => h.distance);
    const want = truth.slice(0, 20).map((t) => t.d);
    expect(got.length).toBe(want.length);
    got.forEach((d, i) => expect(d).toBeCloseTo(want[i]!, 6));
  });

  test("미지정(undefined)은 현행 질의와 글자 동일 — 회귀 0", async () => {
    const viaFn = await searchByVectorRaw(db, dimOnly, query, 20);
    const direct = (
      db
        .query(
          `SELECT node_id, distance FROM vec_nodes
             WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
        )
        .all(query, 20) as Array<{ node_id: number; distance: number }>
    ).map((r) => ({ nodeId: r.node_id, distance: r.distance }));
    expect(viaFn).toEqual(direct);
  });
});

describe("전역 변형 필터 = 후보형 짝 동치 (T4)", () => {
  let db: Database;
  const ids: number[] = [];

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    ids.length = 0;
    const ins = db.prepare(
      `INSERT INTO knowledge_nodes
         (id, content, memory_type, event_at, metadata_json,
          created_at, updated_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
    );
    for (let i = 1; i <= 12; i++) {
      ins.run(
        i,
        `note ${i}`,
        i % 3 === 0 ? "preference" : "fact",
        `2026-0${(i % 9) + 1}-10`,
        // metadata_json 은 NOT NULL — 칸 없음은 빈 객체로 표현한다(운영 저장 양식).
        i % 5 === 0 ? JSON.stringify({ pending_review: true }) : "{}",
      );
      ids.push(i);
    }
  });
  afterEach(() => db.close());

  test("memory_type — 전역 조회가 후보형에 전 노드를 넘긴 것과 같다", () => {
    expect([...selectNodeIdsByMemoryType(db, "preference")].sort()).toEqual(
      [...filterNodeIdsByMemoryType(db, ids, "preference")].sort(),
    );
  });

  test("pending_review — 전역 조회가 후보형과 같다", () => {
    expect([...selectNodeIdsNotPendingReview(db)].sort()).toEqual(
      [...filterOutPendingReview(db, ids)].sort(),
    );
  });

  test("dateRange — 전역 변형은 상한 없이 겹치는 전부를 낸다", () => {
    const since = "2026-01-01";
    const until = "2026-12-31";
    expect([...selectAllNodeIdsByDateRange(db, since, until)].sort()).toEqual(
      [...filterNodeIdsByDateRange(db, ids, since, until)].sort(),
    );
  });

  test("전역 memory_type 조회는 커버링 색인을 탄다(전수 스캔 아님)", () => {
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM knowledge_nodes WHERE memory_type = ?",
      )
      .all("fact") as Array<{ detail: string }>;
    const detail = plan.map((p) => p.detail).join(" ");
    expect(detail).toContain("idx_kn_memory_type");
    expect(detail).not.toContain("SCAN knowledge_nodes");
  });
});

/**
 * (B) 재정(2026-08-03) 잔여 검증 — 통과 집합이 조각 크기를 넘는 구간.
 *
 * 옛 구현은 `|pass| > 4096` 을 현행 사후 필터로 내렸고, 그 근거는 "통과 집합이 크면
 * 선택도가 넓어 사후 필터도 손실이 없다"는 T3 §3-1 실측이었다. planner 는 이를 불승인
 * 했다 — 그 실측은 *상대* 선택도가 넓을 때의 성질이지 절대 pass 크기의 성질이 아니라,
 * 코퍼스가 자랄수록(예: 코퍼스 10만·통과 5천 = 선택도 5%) 근거가 조용히 무너진다.
 *
 * 그래서 초과 구간도 조각 합집합으로 라우팅한다. 이 시험은 그 라우팅이 실제로 회수를
 * 지키는지를 **결함이 발동하는 조건** 에서 단언한다: 정답이 전역 상위 vectorK 밖이고
 * *동시에* 통과 집합이 4096 을 넘는다. 옛 경로였다면 정답을 잃었을 조건이다.
 */
describe("조각 크기 초과 통과 집합 — 다조각 라우팅 구조 회수 ((B) 재정)", () => {
  let db: Database;
  const query = unit([1, 0, 0, 0, 0, 0, 0, 0]);
  const GOLD_ID = 1;
  /** 통과 집합이 VEC0_MAX_K 를 확실히 넘도록 — preference 가 2/3 라 약 6000건. */
  const CORPUS = 9000;
  const VECTOR_K = 20;
  const dimOnly = dimensionOnlyEmbedder();

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    const insNode = db.prepare(
      `INSERT INTO knowledge_nodes
         (id, content, memory_type, created_at, updated_at, last_accessed_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
    );
    const insVec = db.prepare(
      "INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)",
    );
    db.exec("BEGIN");
    // gold — 질의와 직교라 전역 유사도 꼴찌. 통과 타입(preference).
    insNode.run(GOLD_ID, "gold", "preference");
    insVec.run(GOLD_ID, unit([0, 1, 0, 0, 0, 0, 0, 0]));
    // 나머지 — 질의와 거의 같은 방향이라 전역 상위를 독점한다. 2/3 는 통과 타입이라
    // 통과 집합이 조각 크기를 넘고, 그중 다수가 gold 보다 앞선다.
    for (let i = 2; i <= CORPUS; i++) {
      insNode.run(i, `d${i}`, i % 3 === 0 ? "fact" : "preference");
      insVec.run(i, unit([1, 0.00001 * i, 0, 0, 0, 0, 0, 0]));
    }
    db.exec("COMMIT");
  });
  afterEach(() => db.close());

  test("전제 확인 — 통과 집합이 조각 크기 초과 + 정답이 전역 상위 k 밖", () => {
    const pass = selectNodeIdsByMemoryType(db, "preference");
    expect(pass.size).toBeGreaterThan(VEC0_MAX_K); // 다조각 구간
    expect(pass.has(GOLD_ID)).toBe(true);
    const globalTopK = (
      db
        .prepare(
          "SELECT node_id FROM vec_nodes WHERE embedding MATCH ? AND k = ?",
        )
        .all(query, VECTOR_K) as Array<{ node_id: number }>
    ).map((r) => r.node_id);
    expect(globalTopK).not.toContain(GOLD_ID); // 결함 발동 조건
  });

  test("다조각 라우팅이 정답을 회수한다 — 옛 사후 필터 경로는 놓쳤을 조건", async () => {
    const pass = [...selectNodeIdsByMemoryType(db, "preference")];
    const hits = await searchByVectorRaw(db, dimOnly, query, VECTOR_K, pass);

    // 통과 집합 전체가 순위화돼 돌아온다(조각 수 = ceil(|pass|/4096) >= 2).
    expect(hits.length).toBe(pass.length);
    expect(hits.map((h) => h.nodeId)).toContain(GOLD_ID);

    // 대조 — 옛 경로(전역 상위 k 뒤 사후 필터)라면 정답을 잃는다.
    const passSet = new Set(pass);
    const oldPath = (
      db
        .prepare(
          "SELECT node_id FROM vec_nodes WHERE embedding MATCH ? AND k = ?",
        )
        .all(query, VECTOR_K) as Array<{ node_id: number }>
    )
      .map((r) => r.node_id)
      .filter((id) => passSet.has(id));
    expect(oldPath).not.toContain(GOLD_ID);
  });

  test("조각 경계가 순위를 깨지 않는다 — 전수 계산과 상위 순위 일치", async () => {
    const pass = [...selectNodeIdsByMemoryType(db, "preference")];
    const hits = await searchByVectorRaw(db, dimOnly, query, VECTOR_K, pass);

    const passSet = new Set(pass);
    const truth = (
      db.query("SELECT node_id, embedding FROM vec_nodes").all() as Array<{
        node_id: number;
        embedding: Uint8Array;
      }>
    )
      .filter((r) => passSet.has(r.node_id))
      .map((r) => {
        const f = new Float32Array(
          r.embedding.buffer,
          r.embedding.byteOffset,
          r.embedding.byteLength / 4,
        );
        let dot = 0;
        for (let i = 0; i < DIM; i++) dot += f[i]! * query[i]!;
        return { id: r.node_id, d: 1 - dot };
      })
      .sort((a, b) => a.d - b.d);

    // 거리 수열로 비교한다(동점 id 순서는 규정되지 않음 / float32 저장 vs float64
    // 계산이라 말단 자리가 갈려 근사 비교).
    const got = hits.slice(0, VECTOR_K).map((h) => h.distance);
    const want = truth.slice(0, VECTOR_K).map((t) => t.d);
    expect(got.length).toBe(want.length);
    got.forEach((d, i) => expect(d).toBeCloseTo(want[i]!, 6));
  });
});

/**
 * WP-B1-02 — 가시성 제외 방식(exclusion)이 통과 집합 방식(passSet)과 같은 결과를 KNN 1회로 낸다.
 *
 * 운영 DB 처럼 제외 노드(retracted·계보 부모가 철회된 청크)와 pending_review 노드가 질의 근처에
 * 몰려 있고, 통과 집합이 조각 크기를 넘어 passSet 방식은 조각 여러 개를 돌아야 하는 조건이다.
 * KNN 횟수는 실제 Database 의 prepare/query 호출을 세는 계수기로 잰다(원래 메서드를 그대로
 * 호출하고 vec_nodes KNN 문장 수만 센다 — 가짜 구현체 아님, search.cache.test.ts 선례).
 */
describe("가시성 제외 방식 = 통과 집합 방식 (WP-B1-02)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let knnCount: () => number;
  const query = unit([1, 0, 0, 0, 0, 0, 0, 0]);
  /** 통과 집합이 VEC0_MAX_K 를 넘어 passSet 방식이 조각 3개를 돌도록. */
  const CORPUS = 9000;
  const RETRACTED = JSON.stringify({ sharedMemory: { status: "retracted", revision: 1, assertionKind: "user_statement" } });
  /** 1 = 철회된 원문, 그 청크 5개(계보로 제외), 3000 미만 50 배수 59개 = 철회. */
  const EXCLUDED_COUNT = 1 + 5 + 59;
  /** 2000 미만 97 배수 = 검토 대기(보이지만 통과 집합에서는 빠진다). */
  const PENDING_COUNT = 20;

  /** id 가 작을수록 질의에 가깝다(거리 동점 없음 — 아래 단언이 순서를 비교할 수 있게). */
  const vectorFor = (id: number, spread = 0.001) => unit([1, spread * id, 0, 0, 0, 0, 0, 0]);

  function countVecKnn(): () => number {
    let knn = 0;
    // db.query 가 처음 보는 SQL 을 내부에서 db.prepare 로 만들므로, query 안쪽 prepare 는 세지 않는다.
    let insideQuery = false;
    const isKnn = (sql: string) => /FROM vec_nodes\s+WHERE embedding MATCH/.test(sql);
    const prepare = db.prepare.bind(db);
    const queryStatement = db.query.bind(db);
    db.prepare = ((sql: string, ...rest: []) => {
      if (!insideQuery && isKnn(sql)) knn += 1;
      return prepare(sql, ...rest);
    }) as typeof db.prepare;
    db.query = ((sql: string) => {
      if (isKnn(sql)) knn += 1;
      insideQuery = true;
      try {
        return queryStatement(sql);
      } finally {
        insideQuery = false;
      }
    }) as typeof db.query;
    return () => knn;
  }

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    store = new SqliteMemoryStore(db, dimensionOnlyEmbedder());
    const insNode = db.prepare(
      "INSERT INTO knowledge_nodes (id, content, source_type, metadata_json) VALUES (?, ?, ?, ?)",
    );
    const insVec = db.prepare("INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)");
    const insEdge = db.prepare(
      "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance) VALUES (?, 1, 'parent_of', 'system')",
    );
    db.exec("BEGIN");
    for (let id = 1; id <= CORPUS; id++) {
      const chunk = id > 1 && id <= 11 && id % 2 === 1;
      const metadata = id === 1 || (id % 50 === 0 && id < 3000)
        ? RETRACTED
        : id % 97 === 0 && id < 2000 ? JSON.stringify({ pending_review: true }) : "{}";
      insNode.run(id, `공용 기억 ${id}`, chunk ? "document_chunk" : "user_explicit", metadata);
      insVec.run(id, vectorFor(id));
      if (chunk) insEdge.run(id);
    }
    db.exec("COMMIT");
    knnCount = countVecKnn();
  });
  afterEach(() => db.close());

  test("벡터 — 결과 id·거리가 통과 집합 방식과 같고 KNN 은 1회", async () => {
    const snapshot = getMemoryVisibilitySnapshot(db);
    const view = snapshot.view();
    expect(view.excludedIds!.size).toBe(EXCLUDED_COUNT);
    expect(snapshot.pendingReviewIds.size).toBe(PENDING_COUNT);
    const passIds = computeVectorPassSet(store, {}, view.allowedIds!);
    expect(passIds.length).toBe(CORPUS - EXCLUDED_COUNT - PENDING_COUNT);
    for (const vectorK of [1, 5, 20, 100]) {
      const supply = planVisibleSupply(store, {}, snapshot, view, vectorK);
      expect(supply).toMatchObject({ mode: "exclusion", knnK: vectorK + EXCLUDED_COUNT + PENDING_COUNT });
      const before = knnCount();
      const viaExclusion = await searchVisibleVectors(store, supply, {}, query, vectorK);
      const exclusionKnn = knnCount() - before;
      const viaPassSet = (await store.searchByVectorRaw(query, vectorK, passIds)).slice(0, vectorK);
      const passSetKnn = knnCount() - before - exclusionKnn;

      expect(viaExclusion).toEqual(viaPassSet);
      expect(viaExclusion).toHaveLength(vectorK);
      for (let i = 1; i < viaPassSet.length; i++) {
        expect(viaPassSet[i]!.distance).toBeGreaterThan(viaPassSet[i - 1]!.distance);
      }
      for (const hit of viaExclusion) {
        expect(view.isAllowed(hit.nodeId)).toBe(true);
        expect(snapshot.pendingReviewIds.has(hit.nodeId)).toBe(false);
      }
      expect(exclusionKnn).toBe(1);
      expect(passSetKnn).toBe(Math.ceil(passIds.length / VEC0_MAX_K));
      expect(passSetKnn).toBe(3);
    }
  });

  test("FTS — 허용 hit 보충 결과가 통과 집합 방식과 같다", async () => {
    const snapshot = getMemoryVisibilitySnapshot(db);
    const view = snapshot.view();
    const exclusion = planVisibleSupply(store, {}, snapshot, view, 20);
    expect(exclusion.mode).toBe("exclusion");
    const passSet = { mode: "passSet", ids: computeVectorPassSet(store, {}, view.allowedIds!) } as const;
    for (const ftsLimit of [1, 10, 60, 500]) {
      const viaExclusion = await searchVisibleFts(store, exclusion, "공용 기억", ftsLimit);
      expect(viaExclusion).toEqual(await searchVisibleFts(store, passSet, "공용 기억", ftsLimit));
      expect(viaExclusion).toHaveLength(ftsLimit);
      for (const hit of viaExclusion) {
        expect(view.isAllowed(hit.nodeId)).toBe(true);
        expect(snapshot.pendingReviewIds.has(hit.nodeId)).toBe(false);
      }
    }
  });

  test("여유분 밖 행(노드 없는 벡터 행)이 창을 채우면 통과 집합으로 다시 순위화해 같은 결과", async () => {
    // 노드가 없는 벡터 행 200개가 질의에 가장 가깝다 — 스냅샷은 이 행을 모르므로 여유분에 없다.
    const insVec = db.prepare("INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)");
    for (let i = 1; i <= 200; i++) insVec.run(CORPUS + i, vectorFor(i, 0.000001));
    const snapshot = getMemoryVisibilitySnapshot(db);
    const view = snapshot.view();
    const supply = planVisibleSupply(store, {}, snapshot, view, 20);
    expect(supply.mode).toBe("exclusion");
    const passIds = computeVectorPassSet(store, {}, view.allowedIds!);
    const before = knnCount();
    const viaExclusion = await searchVisibleVectors(store, supply, {}, query, 20);
    expect(knnCount() - before).toBe(1 + Math.ceil(passIds.length / VEC0_MAX_K));
    expect(viaExclusion).toEqual((await store.searchByVectorRaw(query, 20, passIds)).slice(0, 20));
    expect(viaExclusion).toHaveLength(20);
  });

  test("갈래 선택 — scope·다른 필터·큰 여유분은 통과 집합, 제외가 없으면 현행 질의", () => {
    const snapshot = getMemoryVisibilitySnapshot(db);
    const scoped = snapshot.view(globalScope());
    expect(planVisibleSupply(store, { scope: globalScope() }, snapshot, scoped, 20).mode).toBe("passSet");
    const unscoped = snapshot.view();
    expect(planVisibleSupply(store, { memoryType: "fact" }, snapshot, unscoped, 20).mode).toBe("passSet");
    expect(planVisibleSupply(store, {}, snapshot, unscoped, VEC0_MAX_K).mode).toBe("passSet");
    expect(planVisibleSupply(store, {}, snapshot, unscoped, VEC0_MAX_K - EXCLUDED_COUNT - PENDING_COUNT).mode).toBe("exclusion");

    // 제외 노드를 모두 되살리면 가시성 제한이 사라져 현행 전역 질의 그대로다.
    db.run("UPDATE knowledge_nodes SET metadata_json = '{}' WHERE metadata_json = ?", [RETRACTED]);
    db.run("DELETE FROM knowledge_edges");
    const restored = getMemoryVisibilitySnapshot(db);
    expect(restored.view().allowedIds).toBeUndefined();
    expect(planVisibleSupply(store, {}, restored, restored.view(), 20).mode).toBe("unfiltered");
  });
});
