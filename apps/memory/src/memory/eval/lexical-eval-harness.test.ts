/**
 * lexical-eval-harness.test.ts — 글자 정답 코퍼스 측정 harness 검증 (S0 골격 +
 * S1 코퍼스 회수 게이트).
 *
 * 이 harness 의 존재 이유 = 곡선 spec 결함 #1(harness 가 legacy 384-dim 경로로 돌아
 * 게이트가 운영에 무효) 해소. 그래서 이 테스트가 가장 먼저 단언하는 것은
 * "harness 가 운영 default 임베더 bge-m3(dim 1024)를 쓴다(legacy 384-dim 아님)"이다.
 *
 * 그다음 S1 코퍼스 6 케이스가 (a) 회수 pool 에 정답이 드는지(회수 게이트 — lexical
 * 가중은 순위만 다루므로 회수 누락은 별 문제로 분리) (b) 현행(wMax=0.0 = w 항 소거)
 * 에서 케이스별 nDCG 가 무엇인지를 console 표로 남긴다 — 이 표가 S6 sweep 의
 * baseline 이다.
 *
 * mock 0 — 실 bge-m3 + 실 :memory: SQLite + 데이터 fixture. 모델 로드가 수십 초~분
 * 걸리므로 timeout 600_000(사전결함 #13 eval 5초 timeout 회피). 모델 미로드는
 * loud fail(buildLexicalHarness 가 throw 전파 — silent skip 금지).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildLexicalHarness,
  runLexicalEval,
  scoreLexicalQuery,
  DEFAULT_LEXICAL_LIMIT,
  type LexicalHarness,
} from "./lexical-eval-harness.ts";
import { LEXICAL_QUERIES } from "../../../test-fixtures/sandbox/lexical-queries.ts";

let harness: LexicalHarness;

beforeAll(async () => {
  // bge-m3 로드 + :memory: DB(dim 1024) + 코퍼스·이미지 fixture 적재. 느림(모델 로드).
  harness = await buildLexicalHarness();
}, 600_000);

afterAll(() => {
  harness?.close();
});

describe("S0 — lexical harness 가 운영 임베더 bge-m3 로 돈다(legacy 384-dim 아님)", () => {
  test(
    "harness 임베더는 dim 1024(bge-m3) 이고 Bgem3Embedder 인스턴스다",
    () => {
      // 곡선 결함 #1 방지의 코드 단언 — 이 harness 의 모든 측정이 운영 임베더로
      // 돈다는 것을 임베더 차원·클래스명으로 못박는다. legacy 384-dim 이었다면 여기서
      // 실패한다.
      expect(harness.store.embedder.dimension).toBe(1024);
      expect(harness.store.embedder.constructor.name).toBe("Bgem3Embedder");
      console.log(
        `[S0] harness 임베더 = ${harness.store.embedder.constructor.name} ` +
          `dim=${harness.store.embedder.dimension} (운영 default = bge-m3, legacy 384-dim 아님)`,
      );
    },
    600_000,
  );

  test(
    "골격 smoke — 임의 질의 retrieve 가 결과를 낸다(파이프라인 가동)",
    async () => {
      const results = await harness.retriever.retrieve("노란후드", {
        limit: DEFAULT_LEXICAL_LIMIT,
      });
      // 코퍼스에 "노란후드" 정확일치 줄이 있으므로 결과가 비어선 안 된다(파이프라인
      // 이 실제로 돈다 — 골격 smoke).
      expect(results.length).toBeGreaterThan(0);
      console.log(`[S0] smoke retrieve("노란후드") → ${results.length}건 회수`);
    },
    600_000,
  );
});

describe("S1 — 글자 코퍼스 6 케이스 회수 게이트 + 현행(w=0) baseline 측정 표", () => {
  test(
    "6 케이스 채점표(현행 w=0) + 회수 게이트 + 오탈자 가드",
    async () => {
      // 현행 운영 default(tuning 미지정 = wMax=0.0 = w 항 소거)로 채점. 이 표가
      // S6 sweep 의 baseline 이다 — S6 가 여기에 tuning.blend.bm25 조합을 주입해
      // 케이스별 nDCG 개선을 비교한다.
      const snapshot = await runLexicalEval(harness);

      console.log(
        `[S1 baseline 측정 표] 임베더 dim=${snapshot.embedderDim} / 코퍼스 ` +
          `${snapshot.corpusLines}줄 / SigLIP=${snapshot.siglipAvailable ? "가용" : "미로드(캡션 FTS만)"} ` +
          `/ 현행 w=0 (S6 sweep baseline)`,
      );
      console.log(
        "  케이스 | 성격 | nDCG | recall | MRR | 회수 | 이미지rank",
      );
      for (const s of snapshot.perQuery) {
        console.log(
          `  ${s.id} | ${s.kind} | ${s.ndcg.toFixed(4)} | ${s.recall.toFixed(2)} | ` +
            `${s.mrr.toFixed(4)} | ${s.recalled ? "예" : "아니오"} | ` +
            `${s.imageRank === -1 ? "없음" : s.imageRank}`,
        );
      }

      // ── 회수 게이트 — 정답이 있는 케이스(typo-guard 제외)는 정답이 회수 pool 에
      //    들어야 한다. 안 들면 lexical 가중(순위)이 아니라 회수 문제이므로 분리
      //    기록 대상(설계 회수 경계). 여기서 회수 0 이면 즉시 드러낸다.
      const byId = new Map(snapshot.perQuery.map((s) => [s.id, s]));
      for (const q of LEXICAL_QUERIES) {
        const s = byId.get(q.id)!;
        if (q.kind === "typo-guard") continue;
        expect(s.recalled).toBe(true);
      }

      // ── 2글자 케이스(LX3 "바라") 회수 확인 — 글 FTS 는 unicode61 이라 2글자를
      //    잡을 수 있다(entity FTS trigram 한계는 S5 별건). sanitizeFtsQuery prefix *
      //    가 조사("바라는")를 흡수해 회수한다는 설계 가정을 여기서 실측으로 확인.
      const lx3 = byId.get("LX3")!;
      expect(lx3.recalled).toBe(true);
      console.log(
        `[S1 2글자 회수] LX3 "바라" recall=${lx3.recall.toFixed(2)} ` +
          `nDCG=${lx3.ndcg.toFixed(4)} — 글 unicode61 FTS 가 2글자를 회수 pool 에 넣음`,
      );

      // ── 오탈자 가드(LX6 "노란훗드") — 코퍼스에 없는 토큰이라 회수 0 이어야 한다.
      //    max IDF 가 존재하지 않는 term 에 최대값을 줘도 회수 pool 이 비어 순위 해가
      //    없음을 격리(설계 케이스 6).
      const lx6 = byId.get("LX6")!;
      expect(lx6.recalled).toBe(false);
      console.log(
        `[S1 오탈자 가드] LX6 "노란훗드" 회수=${lx6.recalled ? "있음(문제)" : "없음(정상)"} ` +
          `— 코퍼스에 없는 오탈자는 회수 0 이라 순위 영향 없음`,
      );
    },
    600_000,
  );

  test(
    "이미지 fixture — 캡션에 희귀 토큰이 있는 이미지가 회수 pool 에 든다",
    async () => {
      // 설계 섹션 3 — 이미지 캡션은 kn_fts_insert 로 FTS 색인되므로 글 노드와 같은
      // lexical 통로를 받는다. LX1("노란후드")의 캡션 이미지가 회수되는지 확인한다.
      // SigLIP 미로드여도 캡션 FTS 통로는 살아 있어야 한다(embedding=null 이 image_vec
      // 채널만 비움 — 캡션 글자 회수는 유지).
      const lx1 = LEXICAL_QUERIES.find((q) => q.id === "LX1")!;
      const score = await scoreLexicalQuery(harness, lx1);
      // LX1 정답에는 캡션 이미지 노드가 포함된다 — 회수 자체는 성립해야 한다.
      expect(score.recalled).toBe(true);
      console.log(
        `[S1 이미지 회수] LX1 "노란후드" 이미지 캡션 rank=` +
          `${score.imageRank === -1 ? "미회수" : score.imageRank} ` +
          `(SigLIP=${harness.load.siglipAvailable ? "가용" : "미로드 — 캡션 FTS만"})`,
      );
      // SigLIP 이 가용하면 이미지가 회수 pool 안에 떠야 한다(캡션+image_vec 두 통로).
      // 미로드면 캡션 FTS 통로만으로도 희귀 토큰 "노란후드" 정확일치가 회수한다.
      expect(score.imageRank).toBeGreaterThan(0);
    },
    600_000,
  );
});
