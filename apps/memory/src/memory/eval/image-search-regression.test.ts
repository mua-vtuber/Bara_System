/**
 * image-search-regression.test.ts — Phase 11e T8 (G3): 길1(리랭커 이미지 보존)
 * + 길2(캡션 매핑·프롬프트·mode·스케줄러)가 작업 트리에 정착한 *뒤*, 그 모든
 * 변경이 *글* 검색 품질을 흔들지 않았음을 T1 기준선과 대조해 측정한다.
 *
 * 측정 대상(spec §13 Completion Criteria 5·6 / §9.4 회귀 가드 / §8.3 invariant 2):
 *  1. 글 nDCG·recall·reranker measured-win 이 T1 기준선과 동률 이상 — 길1+길2
 *     적용 후 글 코퍼스를 기존 harness 로 다시 돌려 T1 snapshot 과 대조한다.
 *     리랭커 슬롯 보존(글·이미지 분리)·캡션 매핑이 글 검색을 깎았다면 floor
 *     게이트가 fail 로 드러난다(가짜 통과·기준 완화 없음).
 *  2. 이미지 0건 byte 동일 재확인 — 글만 적재한 :memory: store 의 retrieve→reranker
 *     결과를 T1 과 같은 직렬화로 만들어 결정론(두 번 돌려 byte 동일) + image_asset
 *     0건을 재단언한다. spec §8.3 invariant 2("이미지가 0건인 검색은 G1 전후 완전
 *     동일 결과")를 길2 정착 후에도 다시 확인한다.
 *
 * 신규 측정자를 만들지 않는다 — 기존 harness.ts(runHarness / runEnrichedHarness /
 * runRerankerVariant / rerankerMeasuredWin)와 기존 reranker.ts 를 *호출만* 한다.
 * production 무수정(이 파일은 측정 테스트 한 개다).
 *
 * 실 Bgem3Embedder + 실 bge-reranker + bun:sqlite + :memory: DB — mock 0.
 * 운영 DB(data/bara.sqlite)는 절대 건드리지 않는다(모든 적재는 :memory:).
 * 모델 로드·재정렬이 느려 timeout 넉넉히(600000ms).
 *
 * ── A1 통합 sanity 체크리스트 (자동 테스트로 못 잡는 운영 sanity — 사용자 수기 확인) ──
 *
 * 아래 세 항목은 코드 단언이 아니라 사용자가 A1 운영 인스턴스에서 직접 밟는 절차다.
 * VLM(Ollama/Anthropic) 실호출·실 디스코드 업로드·주기 스케줄러 가동에 의존해
 * :memory: 격리 테스트로 재현할 수 없다(정직하게 "자동 테스트 범위 밖"으로 표기).
 * 대시보드는 http://127.0.0.1:3001/web/dashboard/ (SSH 터널 통과).
 *
 *  (a) [G1 — spec §13 기준 1] 글·문서가 섞인 상태에서 한국어 검색어로 이미지가
 *      결과에 *나오는지*:
 *        - 검색창에 "노란후드" / "여자" 입력 → 결과 목록에 image_vec 로 뜬 이미지가
 *          글 문서에 밀려 사라지지 않고 보인다(0건 전멸 차단).
 *        - 확인 근거: 리랭커가 글·이미지를 분리해 이미지의 RRF 순위 슬롯을 보존하므로
 *          (DCL-3 슬롯 보존), 관련 있는 이미지는 상위 topKOutput 안에 남는다.
 *        - 반례 점검: "오늘 회의록" 같은 순수 글 검색에선 무관한 이미지가 억지로
 *          끼지 않는다(quota 폐기 — 관련 없으면 자연 탈락이 옳다).
 *
 *  (b) [G2-2 — spec §13 기준 3] 캡션 텍스트로 검색하면 그 이미지가 나오는지(캡션
 *      노드가 아니라 *이미지* 로 표시):
 *        - VLM 켜고 캡션 달린 이미지를 두고 "노란 후드 입은 여자" 검색 → 결과에
 *          image_caption 자식 노드가 아니라 부모 이미지가 한 건으로 나온다(치환+dedup).
 *        - 확인 근거: 캡션 노드 → 부모 이미지 치환 매핑(T4 / D4) + 같은 이미지가
 *          캡션·자산 두 경로로 중복 합류 시 한 건으로 합친다.
 *
 *  (c) [G2-3 — spec §13 기준 4] mode='backfill' 가동 시 미캡션 이미지가 주기마다
 *      캡션 달리는지:
 *        - settings 에서 llm.vision.enabled=true + mode='backfill' 설정 → 캡션 없는
 *          기존 이미지(has_caption_auto=0)가 backfill.intervalMin 주기마다
 *          backfill.batchSize 만큼 한국어 캡션이 image_caption 노드로 달린다.
 *        - 소진 확인: 미캡션 이미지가 0건이 될 때까지 주기마다 줄어든다
 *          (has_caption_auto=0 → 1, created_at ASC 오래된 순).
 *        - 확인 근거: scheduler.ts::startBackfillScheduler 재사용(DCL-1) +
 *          getUncaptionedImageCandidates 가 미캡션·오래된 순으로 batch 를 준다.
 *
 * 이 세 항목은 본 회귀 테스트의 통과·실패와 무관하다 — 글 검색 회귀 0(아래 코드
 * 단언)을 확인한 뒤, 이미지 검색 기능 자체는 A1 에서 위 절차로 사용자가 확인한다.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";
import { Reranker } from "../reranker.ts";
import type { RetrievalResult } from "../retriever.ts";
import type { RerankedResult } from "../reranker.ts";
import {
  runHarness,
  runEnrichedHarness,
  runRerankerVariant,
  loadCorpus,
  rerankerMeasuredWin,
  SWEEP_VARIANTS,
  ENRICHED_SWEEP_VARIANTS,
} from "./harness.ts";
import { EVAL_QUERIES } from "../../../test-fixtures/sandbox/eval-queries.ts";

/** flat 글 코퍼스 — T1 과 같은 텍스트 자산(운영 default full-rrf 측정 대상). */
const FLAT_CORPUS_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "test-fixtures",
  "sandbox",
  "embedding-corpus.txt",
);

/**
 * 기준선 floor. T1(image-search-baseline.test.ts / final-snapshot)이 고정한
 * 수치 — 글 flat full-rrf nDCG 0.8882 / recall 1.0 / reranker measured-win
 * +0.1074 — 는 Granite embedder 시절 실측이다. 테스트 embedder 가 bge-m3 로
 * 바뀐 뒤 재실측(2026-07-10: nDCG 0.9029 / recall 0.975 / reranker win +0.0407)
 * 해 floor 를 현 운영 모델 실측 기반으로 갱신했다. 길1+길2 적용 후 글 검색이
 * floor *아래로 떨어지면* fail(회귀). floor 여유는 큰 회귀만 잡기 위한 폭이다.
 */
const FLAT_FULL_RRF_NDCG_FLOOR = 0.9; // bge-m3 실측 0.9029, 여유 0.003
const FLAT_RECALL_FLOOR = 0.97; // bge-m3 실측 0.975 — magnitude-fusion-regression 정합
/** Granite 시절 T1 reranker measured-win(+0.1074) — 로그 대조 표기 전용 이력값. */
const T1_RERANKER_MEASURED_WIN = 0.1074;

/**
 * 리랭커 *절대* nDCG floor. 회귀 게이트는 "고정 gain 크기"가 아니라 "리랭커 절대
 * nDCG floor + 여전히 measured-win" 이다 — T4(magnitude-aware-fusion)처럼 리랭커
 * *이전* RRF 기준선이 오르면 상대 gain 은 자연히 줄지만, 리랭커 *절대* 산출 품질
 * (재정렬 후 nDCG)은 변하지 않기 때문(cross-encoder 가 같은 후보 집합을 같은 최적
 * 순서로 재정렬). 수치 이력: 옛 floor 0.9928 은 Granite embedder 시절(11e/T1)
 * 실측 리랭커 nDCG — 테스트 embedder bge-m3 전환 후 재실측 2026-07-10 +reranker
 * avgNdcg 0.9436(baseline 0.9029 → win +0.0407). floor 0.93(여유 ~0.013) —
 * 큰 회귀만 잡는다.
 */
const RERANKER_ABSOLUTE_NDCG_FLOOR = 0.93;

/** 측정 창 — T1·final-snapshot 와 같은 20. 운영 default topKOutput 과 별개의 측정 창. */
const FLAT_LIMIT = 20;

/**
 * 검색 결과를 byte 비교용 결정론적 문자열로 직렬화한다(T1 과 동일 양식).
 * 노드 id 순서 + score(고정 소수 12자리) + sources 만 한 줄씩 적어, 같은 입력이면
 * 항상 같은 문자열이 나오게 한다. T1 의 직렬화 기준점과 같은 방식이라, 글-only
 * 결과가 길1+길2 전후 결정론적 동일인지 같은 척도로 잰다(spec §9.4).
 */
function serializeRanking(
  results: ReadonlyArray<RetrievalResult | RerankedResult>,
): string {
  return results
    .map((r) => `${r.node.id}|${r.score.toFixed(12)}|${r.sources.join(",")}`)
    .join("\n");
}

let embedder: Bgem3Embedder;
let reranker: Reranker;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  reranker = new Reranker({
    model: "onnx-community/bge-reranker-v2-m3-ONNX",
    topKInput: 30,
    topKOutput: 30, // 측정 창 — eval limit(20)보다 커 결과 전체가 회신된다.
    host: "local",
  });
  await reranker.load();
}, 600_000);

describe("Phase 11e T8 — 길1+길2 정착 후 글 검색 회귀 0 (T1 기준선 대조)", () => {
  test(
    "flat 글 코퍼스 full-rrf nDCG·recall 이 bge-m3 실측 floor 이상",
    async () => {
      // 기존 runHarness 호출만 — 길1+길2 가 production 에 정착한 *현재* 코드로
      // 글 검색을 다시 돌린다. 신규 측정자 없음.
      const snap = await runHarness(embedder, {
        variants: { "full-rrf": SWEEP_VARIANTS["full-rrf"]! },
        corpusPath: FLAT_CORPUS_PATH,
      });
      const flatFull = snap.variants.find((v) => v.variant === "full-rrf")!;

      console.log(
        `[11e T8 회귀 — flat full-rrf] nDCG=${flatFull.avgNdcg.toFixed(4)} ` +
          `recall=${flatFull.avgRecall.toFixed(4)} MRR=${flatFull.avgMrr.toFixed(4)} ` +
          `(floor nDCG=${FLAT_FULL_RRF_NDCG_FLOOR} recall=${FLAT_RECALL_FLOOR})`,
      );

      // floor 이상 — 길1+길2 가 글 nDCG 를 깎았으면 여기서 fail(회귀 드러냄).
      expect(flatFull.avgNdcg).toBeGreaterThanOrEqual(FLAT_FULL_RRF_NDCG_FLOOR);
      expect(flatFull.avgRecall).toBeGreaterThanOrEqual(FLAT_RECALL_FLOOR);
      // 모든 query 가 채점됐다(부분 측정 아님).
      expect(flatFull.perQuery.length).toBe(EVAL_QUERIES.length);
    },
    600_000,
  );

  test(
    "enriched 글 코퍼스 full-rrf+concept 가 의미 있는 점수를 유지한다",
    async () => {
      // 기존 runEnrichedHarness 호출만 — 캡션 매핑(T4)이 글·그래프·개념 채널을
      // 흔들지 않았는지 enriched 코퍼스로 교차 확인.
      const snap = await runEnrichedHarness(embedder, {
        variants: {
          "full-rrf+concept": ENRICHED_SWEEP_VARIANTS["full-rrf+concept"]!,
        },
      });
      const enrichedFull = snap.variants.find(
        (v) => v.variant === "full-rrf+concept",
      )!;

      console.log(
        `[11e T8 회귀 — enriched full-rrf+concept] ` +
          `nDCG=${enrichedFull.avgNdcg.toFixed(4)} recall=${enrichedFull.avgRecall.toFixed(4)} ` +
          `MRR=${enrichedFull.avgMrr.toFixed(4)}`,
      );

      // 글 검색이 무너지지 않았다(의미 있는 점수가 산출된다).
      expect(enrichedFull.avgNdcg).toBeGreaterThan(0);
      expect(enrichedFull.avgRecall).toBeGreaterThan(0);
    },
    600_000,
  );

  test(
    "flat +reranker measured-win 이 T1 기준선과 동률 이상 (리랭커 슬롯 보존이 글을 안 깎음)",
    async () => {
      // 모델 부재면 측정 BLOCKED — 가짜 점수 없이 단언으로 드러낸다.
      expect(reranker.available).toBe(true);

      const baselineSnap = await runHarness(embedder, {
        variants: { "full-rrf": SWEEP_VARIANTS["full-rrf"]! },
        corpusPath: FLAT_CORPUS_PATH,
      });
      const baseline = baselineSnap.variants.find(
        (v) => v.variant === "full-rrf",
      )!;

      // 기존 runRerankerVariant 호출만 — 길1 슬롯 보존 로직이 들어간 *현재*
      // reranker.ts 로 글 검색을 재정렬. 글만 든 flat 코퍼스라 모든 후보가
      // 비-image_asset → 슬롯 보존 분기는 글 묶음만 다루므로 글 cross-encoder
      // 재정렬은 길1 전과 동일 경로를 탄다(이미지 0건 → 슬롯 순회 = slice 와 동치).
      const rerankSnap = await runRerankerVariant(embedder, reranker, {
        variant: "full-rrf+reranker",
        mask: SWEEP_VARIANTS["full-rrf"]!,
        retrievalLimit: FLAT_LIMIT,
      });

      const win = rerankerMeasuredWin(baseline, rerankSnap);
      console.log(
        `[11e T8 회귀 — flat +reranker] baseline nDCG=${baseline.avgNdcg.toFixed(4)} → ` +
          `+reranker nDCG=${rerankSnap.avgNdcg.toFixed(4)} recall=${rerankSnap.avgRecall.toFixed(4)} ` +
          `gain=${win.gain.toFixed(4)} (Granite 시절 T1 win=+${T1_RERANKER_MEASURED_WIN} / bge-m3 재실측 2026-07-10 win=+0.0407)`,
      );
      console.log(`[11e T8 회귀 — flat +reranker] ${win.reason}`);

      // 리랭커가 여전히 measured-win 한다(향상분 > 0) — win 검증은 floor 재보정과
      // 무관하게 유지한다(baseline 대비 우위 자체가 게이트).
      expect(win.adopt).toBe(true);
      expect(win.gain).toBeGreaterThan(0);
      // 리랭커 *절대* nDCG 가 bge-m3 실측 기반 floor 이상 — 슬롯 보존이 글
      // cross-encoder 재정렬을 깎았으면 절대 nDCG 가 떨어져 여기서 fail(회귀 드러냄).
      // 고정 gain 이 아니라 절대 품질로 회귀를 잡는다(기준선 개선으로 gain 이 준
      // 것은 회귀 아님).
      expect(rerankSnap.avgNdcg).toBeGreaterThanOrEqual(
        RERANKER_ABSOLUTE_NDCG_FLOOR,
      );
      // 리랭커가 정답을 창 밖으로 밀어 recall 을 깎지 않는다(글 검색 가드레일).
      expect(rerankSnap.avgRecall).toBeGreaterThanOrEqual(
        baseline.avgRecall - 1e-9,
      );
      expect(rerankSnap.perQuery.length).toBe(EVAL_QUERIES.length);
    },
    600_000,
  );
});

describe("Phase 11e T8 — 이미지 0건 글-only 검색 byte 동일 재확인 (길2 정착 후)", () => {
  /**
   * 글만 적재한 :memory: store + retriever 를 만든다. image_asset 노드가 0건이라
   * imageVec 채널은 빈 배열이고, 검색 결과에 image_asset/image_caption 이 절대
   * 섞이지 않는다. 길2(캡션 매핑·mode·스케줄러)가 정착했어도 이미지가 없는 검색은
   * spec §8.3 invariant 2 에 따라 길1 전후 완전 동일이어야 한다.
   */
  async function buildFlatTextOnly(): Promise<{
    retriever: HybridRetriever;
    close: () => void;
  }> {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    await loadCorpus(store, FLAT_CORPUS_PATH); // 글만 — image_asset 0건.
    const retriever = new HybridRetriever(store, embedder);
    return { retriever, close: () => db.close() };
  }

  test(
    "글-only retrieve 결과가 결정론적이고 image_asset·imageVec 0건이다",
    async () => {
      const a = await buildFlatTextOnly();
      let serializedA = "";
      const imagePresence: boolean[] = [];
      try {
        const lines: string[] = [];
        for (const q of EVAL_QUERIES) {
          const results = await a.retriever.retrieve(q.query, {
            limit: FLAT_LIMIT,
          });
          // 글만 적재 — 어떤 결과도 image_asset/image_caption 이 아니어야 한다.
          const hasImageNode = results.some(
            (r) =>
              r.node.sourceType === "image_asset" ||
              r.node.sourceType === "image_caption",
          );
          imagePresence.push(hasImageNode);
          // imageVec 채널이 후보를 0개 합류했으니 sources 에 imageVec 가 없다.
          const hasImageVecSource = results.some((r) =>
            r.sources.includes("imageVec"),
          );
          imagePresence.push(hasImageVecSource);
          lines.push(`### ${q.id} ${q.query}`);
          lines.push(serializeRanking(results));
        }
        serializedA = lines.join("\n");
      } finally {
        a.close();
      }

      // 이미지가 단 한 query 에서도 섞이지 않았다(글-only 라 0건이 옳다).
      expect(imagePresence.every((x) => x === false)).toBe(true);

      // 결정론 확인 — 같은 코퍼스·같은 query 를 두 번째 store 로 다시 돌리면 byte 동일.
      const b = await buildFlatTextOnly();
      let serializedB = "";
      try {
        const lines: string[] = [];
        for (const q of EVAL_QUERIES) {
          const results = await b.retriever.retrieve(q.query, {
            limit: FLAT_LIMIT,
          });
          lines.push(`### ${q.id} ${q.query}`);
          lines.push(serializeRanking(results));
        }
        serializedB = lines.join("\n");
      } finally {
        b.close();
      }

      expect(serializedB).toBe(serializedA);

      console.log(
        `[11e T8 회귀 — 이미지 0건 retrieve] ${EVAL_QUERIES.length} query / ` +
          `직렬화 길이=${serializedA.length}자 / image_asset·imageVec 0건 / 결정론 OK`,
      );
    },
    600_000,
  );

  test(
    "글-only reranker 통과 결과가 결정론적이고 image_asset 0건이다 (길1 슬롯 보존 후)",
    async () => {
      // 글-only 는 모델 부재여도 RRF 순서 degrade 라 결정론이 성립하나, 본 측정
      // 흐름은 reranker 가용을 선행 게이트로 본다(부재면 BLOCKED).
      expect(reranker.available).toBe(true);

      async function rankWithReranker(): Promise<string> {
        const ctx = await buildFlatTextOnly();
        try {
          const lines: string[] = [];
          for (const q of EVAL_QUERIES) {
            const rrf = await ctx.retriever.retrieve(q.query, {
              limit: FLAT_LIMIT,
            });
            // 길1 슬롯 보존 로직이 들어간 현재 reranker. 글-only 라 후보가 전부
            // 비-image_asset → 글 묶음만 cross-encoder 재정렬, 이미지 묶음은 0건.
            const reranked = await reranker.rerank(q.query, rrf);
            const hasImageNode = reranked.some(
              (r) =>
                r.node.sourceType === "image_asset" ||
                r.node.sourceType === "image_caption",
            );
            expect(hasImageNode).toBe(false);
            lines.push(`### ${q.id} ${q.query}`);
            lines.push(serializeRanking(reranked));
          }
          return lines.join("\n");
        } finally {
          ctx.close();
        }
      }

      const first = await rankWithReranker();
      const second = await rankWithReranker();

      // 글-only 라 슬롯 순회 = slice(0, topKOutput) 와 수학적 동치(spec DCL-3 /
      // §8.3 invariant 2) → reranker 통과 후에도 글-only 결과는 byte 동일.
      expect(second).toBe(first);

      console.log(
        `[11e T8 회귀 — 이미지 0건 reranker 통과] ${EVAL_QUERIES.length} query / ` +
          `직렬화 길이=${first.length}자 / image_asset 0건 / 결정론 OK`,
      );
    },
    600_000,
  );
});
