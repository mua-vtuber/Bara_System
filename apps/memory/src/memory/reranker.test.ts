/**
 * Reranker — cross-encoder 재정렬 + graceful degrade (Phase 6b T5).
 *
 * 테스트 정책(프로젝트 CLAUDE.md): mock 객체 금지. RetrievalResult 모양
 * fixture 데이터를 직접 작성해 입력하고, 실제 cross-encoder 모델로 점수를
 * 매긴다(인터페이스 가짜 구현체 안 만든다). 긍정 경로는 실제 모델 로드(첫 1회
 * 캐시 다운로드 ~13초) — embedding 테스트와 같은 넉넉한 timeout 를 둔다.
 *
 * graceful degrade 경로는 *실제로 부재하는* 모델 ID 로 load 를 실패시켜
 * 정직한 RRF 순서 보존을 단언한다. 가짜 점수로 실패를 가리는 일은 금지 —
 * 부재 = "재정렬 안 함" 정직한 진술(spec 11.2).
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { Reranker, type RerankerConfig } from "./reranker.ts";
import type { RetrievalResult } from "./retriever.ts";

const MODEL_LOAD_TIMEOUT_MS = 180_000;
const RERANK_TIMEOUT_MS = 60_000;

/** Task 1 settings default(model/topK_input/topK_output/host)와 같은 운영 값. */
const REAL_CONFIG: RerankerConfig = {
  model: "onnx-community/bge-reranker-v2-m3-ONNX",
  topKInput: 30,
  topKOutput: 5,
  host: "local",
};

/**
 * 최소 RetrievalResult fixture. content 가 (query, content) pair 의 doc 텍스트가
 * 된다. score = RRF finalScore — 재정렬 후에도 audit 용으로 보존돼야 한다.
 */
function makeResult(
  id: number,
  content: string,
  score: number,
  sourceType: RetrievalResult["node"]["sourceType"] = "user_explicit",
): RetrievalResult {
  return {
    node: {
      id,
      content,
      memoryType: "fact",
      sourceType,
      author: "tester",
      platform: "test",
      importance: 0.5,
      confidence: 0.9,
      createdAt: "2026-05-27T00:00:00Z",
      updatedAt: null,
      lastAccessedAt: "2026-05-27T00:00:00Z",
      accessCount: 0,
      mentionCount: 0,
      lastMentionedAt: null,
      metadata: {},
      polarity: null,
      eventAt: null,
      eventUntil: null,
      projectId: null,
    },
    score,
    sources: ["vector", "fts"],
    components: {
      rrf: score,
      boostedRrf: score,
      bm25Cross: 0,
      recency: 0,
      importance: 0.5,
      mentionBoost: 0,
      supersedePenalty: 1.0,
      precisionStrength: 0,
      cueGraphBoost: 1.0,
    },
  };
}

// ── 실제 모델 로드 + 재정렬 ──────────────────────────────────────────────
let real: Reranker;

beforeAll(async () => {
  real = new Reranker(REAL_CONFIG);
  await real.load();
}, MODEL_LOAD_TIMEOUT_MS);

describe("Reranker — 실제 모델 로드 + 재정렬", () => {
  test("load() 후 available=true", () => {
    expect(real.available).toBe(true);
  });

  test(
    "query 에 직접 관련된 후보가 RRF 하위에 있어도 재정렬 후 1위로 오른다",
    async () => {
      const query = "고양이는 어떤 동물인가?";
      // RRF 순서로는 관련 없는 후보(score 높음)가 앞, 관련 후보(score 낮음)가 뒤.
      // 재정렬이 query↔content pair 적합도로 순서를 바꾸는지 본다.
      const candidates: RetrievalResult[] = [
        makeResult(1, "오늘 점심으로 김치찌개를 먹었다.", 0.9),
        makeResult(2, "주식 시장이 어제 크게 하락했다.", 0.8),
        makeResult(3, "고양이는 포유류이며 야행성 동물이다.", 0.2),
      ];

      const t0 = performance.now();
      const out = await real.rerank(query, candidates);
      const elapsedMs = performance.now() - t0;
      console.log(
        `[reranker.test] 실제 재정렬 ${candidates.length}개 처리 시간: ${elapsedMs.toFixed(1)}ms`,
      );

      // 관련 후보(id 3)가 1위.
      expect(out[0]!.node.id).toBe(3);
      // rerankerScore 가 components 에 붙었다 + 1위가 가장 높다.
      expect(out[0]!.components.rerankerScore).toBeGreaterThan(0.5);
      for (let i = 1; i < out.length; i++) {
        expect(out[0]!.components.rerankerScore!).toBeGreaterThanOrEqual(
          out[i]!.components.rerankerScore!,
        );
      }
    },
    RERANK_TIMEOUT_MS,
  );

  test(
    "RRF score(finalScore)는 보존되고 정렬 키만 reranker score 로 바뀐다",
    async () => {
      const query = "강아지 산책";
      const candidates: RetrievalResult[] = [
        makeResult(10, "강아지를 매일 아침 공원에서 산책시킨다.", 0.3),
        makeResult(11, "세금 신고 기한이 다음 주로 다가왔다.", 0.95),
      ];
      const out = await real.rerank(query, candidates);

      // 각 결과의 audit score 는 입력 RRF score 그대로(보존).
      const byId = new Map(out.map((r) => [r.node.id, r] as const));
      expect(byId.get(10)!.score).toBe(0.3);
      expect(byId.get(11)!.score).toBe(0.95);
      // 관련 후보(id 10)가 RRF 로는 뒤였으나 재정렬 1위.
      expect(out[0]!.node.id).toBe(10);
    },
    RERANK_TIMEOUT_MS,
  );

  test(
    "topKInput 한도 — 입력 후보가 한도보다 많으면 상위 topKInput 만 채점, topKOutput 만 회신",
    async () => {
      const small = new Reranker({ ...REAL_CONFIG, topKInput: 3, topKOutput: 2 });
      await small.load();
      // RRF score 내림차순 5개. topKInput=3 이라 상위 3개만 채점 대상.
      const candidates: RetrievalResult[] = [
        makeResult(1, "고양이는 포유류 동물이다.", 0.99),
        makeResult(2, "고양이는 야행성이다.", 0.98),
        makeResult(3, "고양이 사료를 매일 준다.", 0.97),
        makeResult(4, "전혀 무관한 주제 — 자동차 정비.", 0.96),
        makeResult(5, "전혀 무관한 주제 — 부동산 시세.", 0.95),
      ];
      const out = await small.rerank("고양이", candidates);
      // topKOutput=2 만 회신.
      expect(out.length).toBe(2);
      // 회신된 노드는 모두 상위 topKInput=3 안의 후보(id 1~3)에서 나온다.
      for (const r of out) {
        expect([1, 2, 3]).toContain(r.node.id);
      }
    },
    RERANK_TIMEOUT_MS,
  );
});

// ── graceful degrade — 부재 모델 ──────────────────────────────────────────
describe("Reranker — graceful degrade(모델 부재)", () => {
  test(
    "부재하는 모델 ID → load() 가 available=false + RRF 순서 보존",
    async () => {
      const broken = new Reranker({
        ...REAL_CONFIG,
        model: "onnx-community/this-model-does-not-exist-bara-6b-t5",
      });
      await broken.load(); // throw 안 함 — graceful degrade.
      expect(broken.available).toBe(false);

      // RRF score 내림차순(0.9, 0.5, 0.2). 재정렬 못하므로 이 순서 그대로 + topKOutput.
      const candidates: RetrievalResult[] = [
        makeResult(1, "관련 없는 문장 A.", 0.9),
        makeResult(2, "관련 없는 문장 B.", 0.5),
        makeResult(3, "고양이는 포유류이며 야행성 동물이다.", 0.2),
      ];
      const out = await broken.rerank("고양이는 어떤 동물인가?", candidates);

      // RRF 순서(score 내림차순) 그대로 — 모델이 있었으면 id 3 이 올랐겠지만
      // 부재 경로는 정직하게 RRF 순서를 회신한다.
      expect(out.map((r) => r.node.id)).toEqual([1, 2, 3]);
      // 가짜 reranker score 안 붙인다 — 재정렬 안 했으니 undefined.
      expect(out[0]!.components.rerankerScore).toBeUndefined();
      // audit score 보존.
      expect(out[0]!.score).toBe(0.9);
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  test("load() 호출 전 rerank() — available=false 라 RRF 순서로 degrade", async () => {
    const notLoaded = new Reranker(REAL_CONFIG);
    expect(notLoaded.available).toBe(false);
    const candidates: RetrievalResult[] = [
      makeResult(1, "문장 하나.", 0.7),
      makeResult(2, "문장 둘.", 0.4),
    ];
    const out = await notLoaded.rerank("질의", candidates);
    expect(out.map((r) => r.node.id)).toEqual([1, 2]);
    expect(out[0]!.components.rerankerScore).toBeUndefined();
  });

  test("degrade 경로도 topKOutput 한도를 지킨다", async () => {
    const notLoaded = new Reranker({ ...REAL_CONFIG, topKOutput: 1 });
    const candidates: RetrievalResult[] = [
      makeResult(1, "A.", 0.7),
      makeResult(2, "B.", 0.4),
      makeResult(3, "C.", 0.1),
    ];
    const out = await notLoaded.rerank("질의", candidates);
    expect(out.length).toBe(1);
    expect(out[0]!.node.id).toBe(1);
  });
});

describe("Reranker — 빈 입력", () => {
  test("후보 0개면 모델 호출 없이 [] 회신", async () => {
    const out = await real.rerank("질의", []);
    expect(out).toEqual([]);
  });
});

// ── Phase 11e T2 (G1) — image_asset 분리 + RRF 순위 슬롯 보존 ─────────────────
//
// spec DCL-3: 이미지는 cross-encoder 채점에서 빼고 image_vec 합류 최종 점수(RRF
// score) 순위 자리를 그대로 지킨다. quota(최소 N건 보장)는 폐기 — 관련 없으면
// 자연 탈락. 캡션 노드(image_caption)는 content 가 글이라 글 갈래에서 채점된다.

/**
 * image_asset fixture. content 는 운영처럼 짧은 라벨이라 cross-encoder 적합도가
 * 바닥 — 글과 한 묶음으로 채점하면 전멸한다. 분리 보존이 이를 살린다. sources 에
 * imageVec 를 넣어 image_vec 채널 합류 후보임을 드러낸다(슬롯 분기는 sourceType
 * 만 보므로 sources 는 단언 의도 표시용).
 */
function makeImageResult(id: number, score: number): RetrievalResult {
  const r = makeResult(id, `이미지 자산 sha256-${id}`, score, "image_asset");
  return { ...r, sources: ["imageVec"] };
}

describe("Reranker — 이미지 자산 분리 + RRF 순위 슬롯 보존 (Phase 11e G1)", () => {
  test(
    "이미지 0건이면 글-only 재정렬과 동일 — image_asset 없는 입력은 cross-encoder 순서 그대로",
    async () => {
      const query = "고양이는 어떤 동물인가?";
      const candidates: RetrievalResult[] = [
        makeResult(1, "오늘 점심으로 김치찌개를 먹었다.", 0.9),
        makeResult(2, "주식 시장이 어제 크게 하락했다.", 0.8),
        makeResult(3, "고양이는 포유류이며 야행성 동물이다.", 0.2),
      ];
      const out = await real.rerank(query, candidates);

      // 이미지 0건이라 모든 슬롯이 글 → 병합 = 옛 reranked.slice(topKOutput) 와 동일.
      // 관련 후보(id 3)가 cross-encoder 로 1위에 오르고 전부 rerankerScore 가 붙는다.
      expect(out[0]!.node.id).toBe(3);
      for (const r of out) {
        expect(r.node.sourceType).not.toBe("image_asset");
        expect(typeof r.components.rerankerScore).toBe("number");
      }
      // rerankerScore 내림차순(글 갈래 재정렬 그대로).
      for (let i = 1; i < out.length; i++) {
        expect(out[i - 1]!.components.rerankerScore!).toBeGreaterThanOrEqual(
          out[i]!.components.rerankerScore!,
        );
      }
    },
    RERANK_TIMEOUT_MS,
  );

  test(
    "이미지가 RRF 상위면 슬롯에 그대로 살아남고 rerankerScore 는 undefined",
    async () => {
      // image_asset 이 가장 높은 RRF score → 첫 슬롯이 이미지.
      const candidates: RetrievalResult[] = [
        makeImageResult(100, 0.95),
        makeResult(1, "강아지를 매일 공원에서 산책시킨다.", 0.7),
        makeResult(2, "세금 신고 기한이 다음 주다.", 0.6),
      ];
      const out = await real.rerank("강아지 산책", candidates);

      // 이미지가 살아남았다 — cross-encoder 가 라벨을 강등해 버리지 못한다(옛 고장 해결).
      const img = out.find((r) => r.node.id === 100);
      expect(img).toBeDefined();
      expect(img!.node.sourceType).toBe("image_asset");
      // 이미지는 RRF 순위만 쓰고 가짜 rerankerScore 를 안 붙인다(정직한 "재정렬 안 함").
      expect(img!.components.rerankerScore).toBeUndefined();
      // RRF score 보존(audit).
      expect(img!.score).toBe(0.95);
    },
    RERANK_TIMEOUT_MS,
  );

  test(
    "이미지가 RRF 하위면 글이 슬롯을 먼저 채워 자연 탈락 — quota 0 (억지 보장 없음)",
    async () => {
      // topKOutput=2. 글 2개가 image 보다 높은 RRF score, 이미지는 맨 아래.
      const small = new Reranker({ ...REAL_CONFIG, topKInput: 30, topKOutput: 2 });
      await small.load();
      const candidates: RetrievalResult[] = [
        makeResult(1, "고양이는 포유류 동물이다.", 0.9),
        makeResult(2, "고양이는 야행성이다.", 0.8),
        makeImageResult(100, 0.1), // RRF 최하위 이미지.
      ];
      const out = await small.rerank("고양이", candidates);

      // topKOutput=2 를 글이 먼저 채워 이미지는 결과에 안 나온다 — 억지 보장 없음(quota 0).
      expect(out.length).toBe(2);
      expect(out.some((r) => r.node.id === 100)).toBe(false);
      for (const r of out) {
        expect(r.node.sourceType).not.toBe("image_asset");
      }
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  test(
    "글 슬롯 내부는 여전히 cross-encoder 적합도로 순서가 바뀐다 (글 재정렬 보존)",
    async () => {
      const query = "고양이는 어떤 동물인가?";
      // 글끼리 RRF 순서로는 관련 후보가 뒤(0.2)지만 cross-encoder 가 앞으로 끌어온다.
      // 이미지는 중간 RRF 순위에 섞어 글 갈래 재정렬과 독립임을 본다.
      const candidates: RetrievalResult[] = [
        makeResult(1, "오늘 점심으로 김치찌개를 먹었다.", 0.9),
        makeImageResult(100, 0.5),
        makeResult(3, "고양이는 포유류이며 야행성 동물이다.", 0.2),
      ];
      const out = await real.rerank(query, candidates);

      // 글만 모으면 관련 후보(id 3)가 무관 글(id 1)보다 앞에 온다(cross-encoder 재정렬).
      const textOrder = out
        .filter((r) => r.node.sourceType !== "image_asset")
        .map((r) => r.node.id);
      expect(textOrder.indexOf(3)).toBeLessThan(textOrder.indexOf(1));
    },
    RERANK_TIMEOUT_MS,
  );

  test(
    "글·이미지 섞이면 이미지는 원래 RRF 순위 자리에 온다 (슬롯 위치 보존)",
    async () => {
      // RRF 순서: 글(0.9) → 이미지(0.5) → 글(0.3). 이미지 슬롯은 2번째 자리.
      // 글끼리는 cross-encoder 로 순서가 바뀔 수 있으나, 이미지 슬롯 위치(2번째)는 고정.
      const candidates: RetrievalResult[] = [
        makeResult(1, "오늘 회의록을 정리했다.", 0.9),
        makeImageResult(100, 0.5),
        makeResult(2, "내일 일정은 비어 있다.", 0.3),
      ];
      const out = await real.rerank("회의록", candidates);

      // 이미지는 2번째 슬롯(인덱스 1) — byRrf 의 이미지 원래 자리.
      expect(out.length).toBe(3);
      expect(out[1]!.node.id).toBe(100);
      expect(out[1]!.node.sourceType).toBe("image_asset");
      // 0번째·2번째 슬롯은 글(cross-encoder 재정렬된 글이 순서대로 채움).
      expect(out[0]!.node.sourceType).not.toBe("image_asset");
      expect(out[2]!.node.sourceType).not.toBe("image_asset");
    },
    RERANK_TIMEOUT_MS,
  );

  test(
    "이미지만(글 0건) 입력 → cross-encoder 빈 호출 안 하고 image_vec(RRF) 순위 보존",
    async () => {
      // 이미지 보관소에서 그림만 검색하는 흐름(spec §4.6). 글 후보가 0건이라
      // 빈 입력으로 토크나이저를 부르면 transformers 가 throw → 옛 경계 버그.
      // 빈 가드가 cross-encoder 호출을 건너뛰고 RRF 순위를 그대로 보존해야 한다.
      const candidates: RetrievalResult[] = [
        makeImageResult(100, 0.9),
        makeImageResult(101, 0.6),
        makeImageResult(102, 0.3),
      ];

      // throw 0 — 빈 입력 채점을 안 한다.
      const out = await real.rerank("노란 후드 캐릭터", candidates);

      // image_vec(RRF score) 순위 그대로 — 내림차순(0.9, 0.6, 0.3).
      expect(out.map((r) => r.node.id)).toEqual([100, 101, 102]);
      // 전부 image_asset 이고 가짜 rerankerScore 안 붙는다(재정렬할 글이 없음).
      for (const r of out) {
        expect(r.node.sourceType).toBe("image_asset");
        expect(r.components.rerankerScore).toBeUndefined();
      }
      // audit score 보존.
      expect(out[0]!.score).toBe(0.9);
    },
    RERANK_TIMEOUT_MS,
  );

  test(
    "캡션 노드(image_caption)는 글로 취급돼 cross-encoder 채점된다 ((A)+(C) 병행)",
    async () => {
      const query = "노란 후드를 입은 캐릭터";
      // image_caption 은 content 가 한국어 캡션이라 글 갈래에서 채점·재정렬된다.
      // 무관 글(높은 RRF)보다 query 적합 캡션(낮은 RRF)이 앞으로 와야 한다.
      const candidates: RetrievalResult[] = [
        makeResult(1, "오늘 점심으로 김치찌개를 먹었다.", 0.9, "user_explicit"),
        makeResult(2, "노란 후드티를 입은 캐릭터 일러스트.", 0.3, "image_caption"),
      ];
      const out = await real.rerank(query, candidates);

      // 캡션 노드가 글로 채점돼 rerankerScore 가 붙는다(image_asset 처럼 보존되지 않음).
      const caption = out.find((r) => r.node.id === 2)!;
      expect(typeof caption.components.rerankerScore).toBe("number");
      // query 적합 캡션이 무관 글보다 앞.
      expect(out[0]!.node.id).toBe(2);
    },
    RERANK_TIMEOUT_MS,
  );
});
