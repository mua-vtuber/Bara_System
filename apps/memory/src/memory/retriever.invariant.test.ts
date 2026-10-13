/**
 * retriever.invariant.test.ts — Phase 11b T5 회귀 0 불변식.
 *
 * RRF 코어(rrf.ts)와 운영 튜닝 상수(search-tuning.ts)의 핵심 글자가 그대로
 * 보존되는지 fs.readFileSync 로 직접 검증한다. 다음 task 안 누군가 본 파일
 * 글자를 잘못 수정하면 본 test 가 fail 신호를 낸다.
 *
 * 검증 대상:
 *   1. rrf.ts — reciprocalRankFusion 시그니처 + RRF_K=60 + 1/(k+i+1) 공식.
 *   2. search-tuning.ts — RRF_BLEND_WEIGHT / BM25_CROSS_WEIGHT / SOURCE_BOOST
 *      / RELATION_CUE_GRAPH_BOOST / TOPIC_CUE_GRAPH_BOOST 운영 default 값.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const MEMORY_DIR = path.resolve(__dirname);

describe("RRF 코어 회귀 0 불변식 (Phase 11b T5)", () => {
  test("rrf.ts — RRF_K = 60 고정", () => {
    const src = fs.readFileSync(path.join(MEMORY_DIR, "rrf.ts"), "utf-8");
    expect(src).toContain("export const RRF_K = 60");
  });

  test("rrf.ts — reciprocalRankFusion 시그니처 그대로", () => {
    const src = fs.readFileSync(path.join(MEMORY_DIR, "rrf.ts"), "utf-8");
    expect(src).toContain("export function reciprocalRankFusion");
    expect(src).toContain(
      "rankings: ReadonlyArray<readonly number[]>",
    );
    expect(src).toContain("k: number = RRF_K");
  });

  test("rrf.ts — 합산 공식 1 / (k + i + 1) 그대로", () => {
    const src = fs.readFileSync(path.join(MEMORY_DIR, "rrf.ts"), "utf-8");
    expect(src).toContain("1 / (k + i + 1)");
  });
});

describe("search-tuning.ts 운영 default 회귀 0 불변식 (Phase 11b T5)", () => {
  test("RRF_BLEND_WEIGHT = 1.0 (floor-중립 / DCL-5)", () => {
    const src = fs.readFileSync(
      path.join(MEMORY_DIR, "search-tuning.ts"),
      "utf-8",
    );
    expect(src).toContain("export const RRF_BLEND_WEIGHT = 1.0");
  });

  test("BM25_CROSS_WEIGHT = 0.0 (floor-중립 / DCL-5)", () => {
    const src = fs.readFileSync(
      path.join(MEMORY_DIR, "search-tuning.ts"),
      "utf-8",
    );
    expect(src).toContain("export const BM25_CROSS_WEIGHT = 0.0");
  });

  test("SOURCE_BOOST — bm25/vector/graph/concept 전부 1.0 (floor-중립 / DCL-5)", () => {
    const src = fs.readFileSync(
      path.join(MEMORY_DIR, "search-tuning.ts"),
      "utf-8",
    );
    expect(src).toContain('"bm25" | "vector" | "graph" | "concept"');
    expect(src).toMatch(/bm25:\s*1\.0/);
    expect(src).toMatch(/vector:\s*1\.0/);
    expect(src).toMatch(/graph:\s*1\.0/);
    expect(src).toMatch(/concept:\s*1\.0/);
  });

  test("RELATION_CUE_GRAPH_BOOST = 1.0 / TOPIC_CUE_GRAPH_BOOST = 1.0 (2026-07-10 중립화)", () => {
    // bge-m3 재측정에서 measured-win 부재(EQ5 정답이 vector 직접 회수로 graph-hop
    // 전제 붕괴) — 둘 다 한 결정으로 묶어 중립 1.0(search-tuning.ts 이력 주석).
    const src = fs.readFileSync(
      path.join(MEMORY_DIR, "search-tuning.ts"),
      "utf-8",
    );
    expect(src).toContain("export const RELATION_CUE_GRAPH_BOOST = 1.0");
    expect(src).toContain("export const TOPIC_CUE_GRAPH_BOOST = 1.0");
  });

  test("BM25_RRF_K = 60 (RRF_K 동일 스케일)", () => {
    const src = fs.readFileSync(
      path.join(MEMORY_DIR, "search-tuning.ts"),
      "utf-8",
    );
    expect(src).toContain("export const BM25_RRF_K = 60");
  });
});

describe("retrieve-constants.ts 장소 소프트 가산 상수 글자 동결 (활용 단계4 T3 / D8)", () => {
  // 장소 칸 소프트 가산 상수는 step 9 blended 식의 post-RRF 가산 항이라 mentionBoost
  // 상수 가족(MENTION_BOOST_*)과 같은 파일(retrieve-constants.ts)에 둔다. D8 = 모듈
  // 상수 고정(settings 미노출). 이 default 가 바뀌면 칸 사용 검색 점수가 달라지므로
  // fs.readFileSync 로 글자 동결한다(다음 task 안 누군가 값을 바꾸면 fail 신호).

  test("PLACE_SOFT_BOOST_WEIGHT = 0.1 / PLACE_SOFT_BOOST_CAP = 0.1 (T3 운영 default)", () => {
    const src = fs.readFileSync(
      path.join(MEMORY_DIR, "retrieve-constants.ts"),
      "utf-8",
    );
    expect(src).toContain("export const PLACE_SOFT_BOOST_WEIGHT = 0.1");
    expect(src).toContain("export const PLACE_SOFT_BOOST_CAP = 0.1");
  });

  test("MENTION_BOOST 상수 가족도 그대로(장소 상수 추가가 옆 상수를 안 건드림)", () => {
    // 장소 상수를 mentionBoost 옆에 추가했으므로, 같은 파일의 mentionBoost default 가
    // 그대로 보존되는지 함께 동결한다(post-RRF 가산 가족 글자 동결).
    const src = fs.readFileSync(
      path.join(MEMORY_DIR, "retrieve-constants.ts"),
      "utf-8",
    );
    expect(src).toContain("export const MENTION_BOOST_PER_COUNT = 0.05");
    expect(src).toContain("export const MENTION_BOOST_CAP = 0.1");
  });
});
