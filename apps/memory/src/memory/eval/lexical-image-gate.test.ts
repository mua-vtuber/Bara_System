/**
 * lexical-image-gate.test.ts — 그림 글자항 측정·판정 (일치성 검색 재설계 IM).
 *
 * ## 왜 그림만 별도 측정인가 (설계 섹션 3 / 측정 후 재설계 축 2)
 *
 * 글(text) 정확일치는 bge-m3 dense(vec_nodes)가 이미 상위에 올린다(GB 가 동결).
 * 그러나 이미지 캡션 노드는 다르다 — addImageAssetNode 가 image_vec(SigLIP)만
 * 채우고 글 dense vec_nodes 에는 안 넣는다(image-asset.ts:88 embedding_text=NULL).
 * 그래서 "축 1 = dense 가 보장" 논리가 그림에는 적용 안 된다. 이미지의 글자 일치는
 * FTS 채널로만 들어오는데, 그 FTS 글자항(bm25Cross)이 운영 default w=0 이라 최종
 * 점수에서 버려진다. LX1 "노란후드" 정확 캡션 이미지가 8위로 밀리는 실측이 이를 보인다.
 *
 * ## 이 테스트가 재는 것 (측정 표 — 채택 배선 아님)
 *
 * IM 은 "이미지 캡션 노드에 한해 글자항을 켜는 게 순위·margin 상 값어치가 있는가"를
 * 측정 표로 뽑는다. 실제 운영 배선(채택)은 이 표를 보고 사용자가 결정한다 — 이
 * 테스트는 운영 상수(search-tuning.ts)를 한 글자도 안 바꾸고, tuning 주입/후처리로만
 * 시연한다(DCL 원칙 — 측정 없이 운영 값 변경 금지).
 *
 * 여섯 측정을 담는다(사용자 "그림도 일치" 의도의 두 해석을 나눠 재기 위해):
 *  - IM-1 전역 글자항: retrieve(tuning.blend.bm25=W). 모든 노드에 글자항이 실린다.
 *    이미지 순위는 오르지만, 전역이라 글 노드에도 bm25Cross 가 실린다(전역 on 위험).
 *  - IM-2 이미지 한정: w=0 baseline 결과의 각 노드 score 에, 이미지 노드(source_type=
 *    'image_asset')에만 W×bm25Cross 를 가산해 재정렬. blendedRrf = 1.0×boostedRrf +
 *    W×bm25Cross 식과 정확히 일치하되(assembleNodeScore) 이미지 노드에만 적용 →
 *    글 노드 score 는 baseline 과 byte 동일(글 회귀 0 을 수학적으로 보장·측정 확인).
 *  - IM-3 판정 요약: 섞인 결과(해석1)에서 LX1 이미지 8→5위 순위 변화.
 *  - IM-4 그림 전용 회수(해석2): 이미지 노드만 pool 로 좁혀, "노란후드" 정확일치 캡션
 *    이미지가 의미유사·무관 캡션 이미지보다 위인가. w=0(SigLIP+dense캡션FTS)만으로
 *    이미 정확일치가 위면 → 그림도 결말 B(글자항 불필요). 사용자 "그림 검색 시 정확일치
 *    위" 의도의 직접 답.
 *  - IM-5 전역 글자항의 flat 의미 코퍼스 회귀 여부 + 포화 한계. spec 의 "전역 on 은
 *    글을 회귀시킨다"(옛 DCL-5 nDCG 0.8882→0.7967)가 legacy 기준이었음을 bge-m3 로
 *    확인 — 단 포화 코퍼스라 "무해"로 단정 못 함(정직히 명시).
 *  - IM-6 회의록 구제: 이미지 한정 글자항이 글 취약 케이스("회의록", GB known-weak)에
 *    영향 0 임을 확인. 회의록은 글 노드 문제(dense)라 이미지 한정 배선 밖에 남는다.
 *
 * 사용자 "그림도 일치" 두 해석(팀리드 지정):
 *  - 해석1 = 글+그림 섞인 결과에서 그림 상위 → IM-1/IM-2/IM-3(8→5위, 여전히 글 아래).
 *  - 해석2 = 그림만 볼 때 정확일치 그림이 다른 그림보다 위 → IM-4(SigLIP 이 이미 충족?).
 *
 * mock 0 — 실 bge-m3 + 실 SigLIP + 실 :memory: SQLite + 데이터 fixture. IM-4 는
 * addImageAssetNode 로 비교용 이미지(의미유사·무관 캡션)를 실제 노드로 넣는다(테스트
 * fixture — 인터페이스 가짜 구현 아님). 모델 로드로 timeout 600_000(사전결함 #13 회피).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildLexicalHarness,
  DEFAULT_LEXICAL_LIMIT,
  type LexicalHarness,
} from "./lexical-eval-harness.ts";
import { scoreMargin, type MarginScorable } from "./lexical-margin.ts";
import { LEXICAL_QUERIES } from "../../../test-fixtures/sandbox/lexical-queries.ts";
import { addImageAssetNode } from "../image-asset.ts";
import { embedQuerySiglipText } from "../../embedding/siglip2-text.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { runHarness } from "./harness.ts";

/** 이미지 글자항 sweep grid — 0(현행) 부터 2.0 까지. planner sweep 선례와 정합. */
const IMAGE_BM25_SWEEP = [0, 0.2, 0.5, 1.0, 2.0] as const;

let harness: LexicalHarness;

beforeAll(async () => {
  harness = await buildLexicalHarness();
}, 600_000);

afterAll(() => {
  harness?.close();
});

/** 코퍼스 줄번호 배열 → 노드 id 집합(정답 매핑). */
function idsForLines(lines: readonly number[]): Set<number> {
  const s = new Set<number>();
  for (const line of lines) {
    const id = harness.load.lineToNodeId.get(line);
    if (id === undefined) throw new Error(`no node for line ${line}`);
    s.add(id);
  }
  return s;
}

/** imageCaption 이 있는 질의(LX1·LX2)만 — 이미지 글자항 측정 대상. */
const imageQueries = LEXICAL_QUERIES.filter((q) => q.imageCaption);

describe("IM — 그림 글자항 측정 (이미지 순위·margin, 측정 표)", () => {
  test(
    "IM-1 전역 글자항 sweep — 이미지 순위·margin 표 + 순위 비악화",
    async () => {
      console.log("\n[IM-1] 전역 글자항 sweep (tuning.blend.bm25) — 이미지 순위·margin");
      console.log("  질의 | bm25 | 이미지rank | 이미지margin");
      for (const q of imageQueries) {
        const imageNodeId = harness.load.imageNodeIdByQuery.get(q.id)!;
        let prevRank = Infinity;
        for (const w of IMAGE_BM25_SWEEP) {
          const tuning =
            w === 0 ? undefined : { blend: { rrf: 1.0, bm25: w } };
          const results = await harness.retriever.retrieve(q.query, {
            limit: DEFAULT_LEXICAL_LIMIT,
            tuning,
          });
          const ranked = results.map((r) => r.node.id);
          const rank = ranked.indexOf(imageNodeId) + 1; // 0 = 미회수
          const margin = scoreMargin(results, new Set([imageNodeId]));
          console.log(
            `  ${q.id} | ${w.toFixed(1)} | ${rank || "미회수"} | ${margin.toFixed(4)}`,
          );
          // 이미지가 회수됐다면(rank>0) 글자항을 올릴수록 순위가 나빠지지 않아야
          // 한다(글자 일치를 반영하는 유일 통로라 단조 비악화 = 값어치 방향 확인).
          if (rank > 0 && prevRank !== Infinity) {
            expect(rank).toBeLessThanOrEqual(prevRank);
          }
          if (rank > 0) prevRank = rank;
        }
      }
    },
    600_000,
  );

  test(
    "IM-2 이미지 한정 글자항 — 글 노드 score 불변(글 회귀 0) + 이미지 순위 개선",
    async () => {
      console.log(
        "\n[IM-2] 이미지 한정 글자항(source_type='image_asset'만 가산) — 글 회귀 0",
      );
      console.log("  질의 | bm25(img한정) | 이미지rank | 이미지margin | 글노드score변화");
      for (const q of imageQueries) {
        const imageNodeId = harness.load.imageNodeIdByQuery.get(q.id)!;

        // w=0 baseline(현행) 결과 — 이 score 를 글 노드는 그대로 유지한다.
        const base = await harness.retriever.retrieve(q.query, {
          limit: DEFAULT_LEXICAL_LIMIT,
        });
        const candidateIds = base.map((r) => r.node.id);
        const baseScoreById = new Map(base.map((r) => [r.node.id, r.score]));
        // ftsQuery = query — harness 는 synonym 미주입이라 retriever 와 동일 통로.
        const bm25 = await harness.store.computeBM25Cross(q.query, candidateIds);

        let prevRank = Infinity;
        for (const w of IMAGE_BM25_SWEEP) {
          // 이미지 노드에만 W×bm25Cross 가산. 글 노드는 base score 그대로.
          //   blendedRrf = 1.0×boostedRrf + W×bm25Cross (assembleNodeScore 식과 동일)
          //   이미지 노드에만 이 항을 켜므로 글 노드 finalScore 는 baseline byte 동일.
          const rescored: MarginScorable[] = base.map((r) => {
            const isImage = r.node.sourceType === "image_asset";
            const add = isImage ? w * (bm25.get(r.node.id) ?? 0) : 0;
            return { node: { id: r.node.id }, score: r.score + add };
          });
          rescored.sort((a, b) => b.score - a.score);

          const rank =
            rescored.findIndex((r) => r.node.id === imageNodeId) + 1;
          const margin = scoreMargin(rescored, new Set([imageNodeId]));

          // ── 글 회귀 0 (핵심 hard-assert) — 글 노드(비이미지)의 재점수 score 가
          //    baseline 과 byte 동일해야 한다. 이미지 한정 가산이 글에 새는지 감시.
          let textNodesUnchanged = true;
          for (const r of rescored) {
            const orig = base.find((b) => b.node.id === r.node.id)!;
            if (orig.node.sourceType === "image_asset") continue;
            if (r.score !== baseScoreById.get(r.node.id)) {
              textNodesUnchanged = false;
              break;
            }
          }
          expect(textNodesUnchanged).toBe(true);

          console.log(
            `  ${q.id} | ${w.toFixed(1)} | ${rank || "미회수"} | ${margin.toFixed(4)} | ${textNodesUnchanged ? "불변(회귀0)" : "변함(회귀!)"}`,
          );

          // 이미지 순위 비악화 — 이미지 한정 글자항이 이미지 순위를 떨어뜨리지 않는다.
          if (rank > 0 && prevRank !== Infinity) {
            expect(rank).toBeLessThanOrEqual(prevRank);
          }
          if (rank > 0) prevRank = rank;
        }
      }
    },
    600_000,
  );

  test(
    "IM-3 판정 요약 — 이미지 한정 글자항이 LX1 이미지 순위를 개선하는가",
    async () => {
      // 사용자 결정 입력용 판정 표 — LX1(캡션 정확일치 이미지가 8위로 밀리던 케이스)
      // 에서 이미지 한정 글자항 w=0 vs w=2.0 의 순위 변화를 명시한다.
      const q = imageQueries.find((x) => x.id === "LX1")!;
      const imageNodeId = harness.load.imageNodeIdByQuery.get(q.id)!;

      const base = await harness.retriever.retrieve(q.query, {
        limit: DEFAULT_LEXICAL_LIMIT,
      });
      const candidateIds = base.map((r) => r.node.id);
      const bm25 = await harness.store.computeBM25Cross(q.query, candidateIds);

      function rankAt(w: number): number {
        const rescored = base
          .map((r) => {
            const isImage = r.node.sourceType === "image_asset";
            const add = isImage ? w * (bm25.get(r.node.id) ?? 0) : 0;
            return { id: r.node.id, score: r.score + add };
          })
          .sort((a, b) => b.score - a.score);
        return rescored.findIndex((r) => r.id === imageNodeId) + 1;
      }

      const rank0 = rankAt(0);
      const rank2 = rankAt(2.0);
      console.log(
        `\n[IM-3 판정] LX1 "노란후드" 이미지 한정 글자항: rank ${rank0}위(w=0) → ${rank2}위(w=2.0). ` +
          `글 회귀 0(이미지 노드에만 가산). imgBm25=${(bm25.get(imageNodeId) ?? 0).toFixed(4)}. ` +
          `개선폭이 사용자 "그림도" 의도 충족에 값어치 있는지는 사용자 판단(채택 배선은 별 task).`,
      );
      // 판정 사실 동결 — 이미지 한정 글자항은 LX1 이미지 순위를 비악화(개선 또는 유지).
      expect(rank2).toBeLessThanOrEqual(rank0);
      // 이미지가 회수 pool 에 있다(측정 성립 전제).
      expect(rank0).toBeGreaterThan(0);
    },
    600_000,
  );
});

describe("IM-4 — 그림 전용 회수(해석2): 정확일치 그림이 다른 그림보다 위인가", () => {
  test(
    "이미지 pool 만 좁혔을 때 정확일치 캡션이 의미유사·무관보다 위 (w=0 SigLIP 만으로?)",
    async () => {
      // 사용자 "그림의 순위가 높아야"의 해석2 = "노란후드 그림 찾을 때, 정확일치 그림이
      // 다른 그림보다 위". 이걸 재려면 비교용 이미지가 필요하다 — 정확일치 캡션 외에
      // 의미유사(노란후드 없는 노란 옷)·무관 캡션 이미지를 실제 노드로 넣고(테스트
      // fixture), 이미지 노드만 pool 로 좁혀 정확일치가 위인지 본다.
      //
      // 핵심 판별: w=0(현행 SigLIP + dense 캡션 FTS)만으로 이미 정확일치 그림이 위면
      // → SigLIP 이 해석2 를 이미 충족 → 그림도 결말 B(글자항 불필요). w=0 에서 밀리면
      // → 글자항이 진짜 필요한 자리(채택 근거).
      const db = harness.store.getRawDb();

      // 비교용 이미지 3종을 실제 노드로 추가(SigLIP text 임베딩 — 미로드 시 null 이면
      // 캡션 FTS 통로만 살아 정직히 노출). 캡션에 질의 토큰이 없거나 있는 대비군.
      const captions: Record<string, string> = {
        exact2: "노란후드 소년이 등장하는 만화 한 컷 이미지", // 정확일치 2
        similar: "노란 옷을 입은 인물을 그린 일러스트 이미지", // 의미유사(노란후드 없음)
        unrelated: "파란 바다와 하늘을 찍은 풍경 사진 이미지", // 무관
      };
      const addedIds: Record<string, number> = {};
      for (const [k, cap] of Object.entries(captions)) {
        const emb = await embedQuerySiglipText(cap);
        addedIds[k] = addImageAssetNode(db, {
          content: cap,
          embedding: emb,
          assetSha256: `im4-${k}`,
        });
      }
      // LX1 정확일치 이미지(캡션 "노란후드 캐릭터 일러스트 이미지 자산").
      const exact1 = harness.load.imageNodeIdByQuery.get("LX1")!;

      // 정확일치 = {exact1, exact2}. distractor = {similar, unrelated}.
      const exactSet = new Set([exact1, addedIds.exact2!]);
      const distractorSet = new Set([addedIds.similar!, addedIds.unrelated!]);

      console.log(
        "\n[IM-4 그림 전용 회수] 노란후드 질의 — 이미지 노드만 pool (정확일치 vs 유사 vs 무관)",
      );
      console.log("  bm25 | 정확-(유사·무관) margin | 정확일치가 유사·무관 위?");

      let w0Margin = 0;
      for (const w of IMAGE_BM25_SWEEP) {
        const tuning = w === 0 ? undefined : { blend: { rrf: 1.0, bm25: w } };
        const results = await harness.retriever.retrieve("노란후드", {
          limit: 50,
          tuning,
        });
        // 이미지 노드만 남긴다(글 제외) → 그림 pool 내 순위.
        const imgOnly = results.filter(
          (r) => r.node.sourceType === "image_asset",
        );
        const margin = scoreMargin(imgOnly, exactSet, distractorSet);
        if (w === 0) w0Margin = margin;
        console.log(
          `  ${w.toFixed(1)} | ${margin.toFixed(4)} | ${margin > 0 ? "예(정확일치 위)" : "아니오(밀림)"}`,
        );
        // 정확일치 그림이 유사·무관 그림보다 위(margin>0)는 sweep 전 구간에서 유지.
        expect(margin).toBeGreaterThan(0);
      }

      // 핵심 판정 hard-assert — w=0(SigLIP+dense캡션FTS 만, 글자항 없음)에서 이미
      // 정확일치 그림이 유사·무관 그림보다 위. 해석2 를 SigLIP 이 이미 충족한다.
      console.log(
        `[IM-4 판정] w=0 정확일치-(유사·무관) margin=${w0Margin.toFixed(4)} (>0) — ` +
          `SigLIP+dense캡션FTS 만으로 그림들 중 정확일치가 이미 위. 해석2 는 글자항 없이 성립 ` +
          `→ 그림 전용 검색은 결말 B 로 종결 가능(글자항은 margin 을 더 벌릴 뿐 순위 불변).`,
      );
      expect(w0Margin).toBeGreaterThan(0);
    },
    600_000,
  );
});

describe("IM-5 — 전역 글자항의 flat 의미 코퍼스 회귀 + 포화 한계", () => {
  test(
    "전역 bm25 sweep 이 flat 의미 코퍼스 nDCG 를 깎는가 (bge-m3, 포화 한계 명시)",
    async () => {
      // spec 은 "전역 on 은 글을 회귀시킨다"(옛 DCL-5: BM25 켜면 nDCG 0.8882→0.7967)를
      // 이미지 한정 배선의 근거로 든다. 그런데 그 0.8882→0.7967 은 legacy 기준이었다.
      // 운영 임베더 bge-m3 로 flat 의미 코퍼스(runHarness full-rrf)에 전역 bm25 를
      // sweep 해 회귀 여부를 실측한다.
      const embedder = new Bgem3Embedder();
      await embedder.load();
      const variants = {
        "full-rrf": { vector: true, fts: true, graph: true, concept: false },
      };

      console.log(
        "\n[IM-5 flat 전역 회귀] bge-m3 flat 의미 코퍼스 — 전역 bm25 sweep nDCG",
      );
      console.log("  bm25 | avgNdcg | avgRecall");
      const ndcgs: number[] = [];
      let recallAtZero = 0;
      for (const w of IMAGE_BM25_SWEEP) {
        const tuning = w === 0 ? undefined : { blend: { rrf: 1.0, bm25: w } };
        const snap = await runHarness(embedder, { variants, tuning });
        const v = snap.variants[0]!;
        ndcgs.push(v.avgNdcg);
        if (w === 0) recallAtZero = v.avgRecall;
        console.log(
          `  ${w.toFixed(1)} | ${v.avgNdcg.toFixed(4)} | ${v.avgRecall.toFixed(4)}`,
        );
      }

      // 실측: bge-m3 에서 전역 bm25 는 flat nDCG 를 깎지 않는다(옛 legacy 회귀 미재현).
      // 회귀 감시 — 어느 sweep 값도 baseline(w=0) 대비 유의미하게(1e-3 이상) 안 깎여야.
      const baseline = ndcgs[0]!;
      for (const n of ndcgs) {
        expect(n).toBeGreaterThanOrEqual(baseline - 1e-3);
      }

      // 포화 한계 정직 명시 — flat 이 w=0 에서 이미 recall 1.0 + nDCG 포화 근처라,
      // "nDCG 불변"이 (a) bm25 무해인지 (b) 코퍼스 포화라 순위 흔들림을 nDCG 가 못
      // 봐서인지 구분 못 한다. "전역 bm25 안전"으로 단정하지 않는다(enriched·margin
      // 으로 재면 다를 수 있음).
      console.log(
        `[IM-5 판정] bge-m3 에서 전역 bm25 는 flat 의미 코퍼스 nDCG 를 안 깎음 ` +
          `(baseline=${baseline.toFixed(4)}, recall(w=0)=${recallAtZero.toFixed(4)}). ` +
          `단 flat 이 recall 1.0 + nDCG 포화라 "무해 vs 포화 못 봄"은 미구분 — ` +
          `spec 의 "전역=글 회귀"(legacy 기준)가 bge-m3 에선 약하나, "전역 안전"으로 ` +
          `단정 금지. 이미지 한정을 굳이 배제할 근거도 채택할 근거도 이 코퍼스로는 약함.`,
      );
      // 포화 확인(측정 해석 전제) — flat 은 w=0 에서 recall 이 높다.
      expect(recallAtZero).toBeGreaterThan(0.9);
    },
    600_000,
  );
});

describe("IM-6 — 회의록(글 취약 케이스) 구제: 이미지 한정 글자항 영향 0", () => {
  test(
    "이미지 한정 글자항은 글 취약 케이스 '회의록' 에 영향 0 (dense 문제로 남음)",
    async () => {
      // GB known-weak "회의록"(정확일치 줄8 margin 음수)은 글 노드 문제(dense 가
      // "회의" 부분매치를 위에 둠)다. 이미지 한정 글자항은 source_type='image_asset'
      // 노드에만 가산하므로, "회의록" 케이스의 정답(줄8)·distractor(줄11)가 둘 다 글
      // 노드라 영향이 0 이어야 한다 — 즉 회의록 취약점은 이미지 한정 배선 밖에 남는다.
      // 이걸 측정으로 확인해 "이미지 한정 글자항으로 회의록을 구제할 수 없다"를 못박는다.
      const base = await harness.retriever.retrieve("회의록", {
        limit: DEFAULT_LEXICAL_LIMIT,
      });
      const candidateIds = base.map((r) => r.node.id);
      const bm25 = await harness.store.computeBM25Cross("회의록", candidateIds);
      const answerIds = idsForLines([8]); // "…회의록을 자동으로 정리해준다" 정확일치.
      const baseMargin = scoreMargin(base, answerIds);

      console.log(
        "\n[IM-6 회의록 구제] 이미지 한정 글자항 sweep — 글 취약 케이스 margin 변화",
      );
      console.log("  bm25(img한정) | 회의록 margin | baseline 대비");

      for (const w of IMAGE_BM25_SWEEP) {
        // 이미지 노드에만 글자항 가산(회의록 결과에는 이미지 노드가 없거나, 있어도
        // 정답·distractor 는 글 노드라 margin 불변).
        const rescored: MarginScorable[] = base.map((r) => {
          const isImage = r.node.sourceType === "image_asset";
          const add = isImage ? w * (bm25.get(r.node.id) ?? 0) : 0;
          return { node: { id: r.node.id }, score: r.score + add };
        });
        const margin = scoreMargin(rescored, answerIds);
        console.log(
          `  ${w.toFixed(1)} | ${margin.toFixed(6)} | ${margin === baseMargin ? "불변(영향0)" : "변함!"}`,
        );
        // 이미지 한정 글자항은 글 취약 케이스 margin 을 한 톨도 안 바꾼다(byte 동일).
        expect(margin).toBe(baseMargin);
      }

      console.log(
        `[IM-6 판정] "회의록" margin=${baseMargin.toFixed(6)} 이 이미지 한정 글자항 ` +
          `전 구간 불변 — 회의록 취약점은 글 노드(dense) 문제라 이미지 한정 배선 밖에 ` +
          `남는다(IM 범위 밖 = dense 문제, GB known-weak 로 별도 감시).`,
      );
    },
    600_000,
  );
});
