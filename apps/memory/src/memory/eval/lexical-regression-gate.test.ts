/**
 * lexical-regression-gate.test.ts — 글 회귀 게이트 (일치성 검색 재설계 GB).
 *
 * ## 이 게이트가 동결하는 것 (측정 후 재설계 축 1 = 결말 B)
 *
 * S0 harness 측정이 재설계의 근본 전제를 뒤집었다. 원래 전제는 "글자 신호가 최종
 * 점수에서 버려져(BM25_CROSS_WEIGHT=0.0) 정확일치가 semantic 을 못 이긴다"였는데,
 * 실측하니 글 정확일치는 bge-m3 dense(vec_nodes) 채널이 태워서 이미 상위에 온다.
 * bge-m3 의 XLM-R 서브워드 토크나이저가 글자 겹침을 dense cosine 에 반영하기 때문이다.
 * 그래서 글은 IDF/곡선/글자항을 새로 켤 실측 근거가 0 이고(결말 B), 대신 "현행이
 * 옳음"을 margin 으로 동결하는 회귀 게이트를 둔다 — 미래 임베더·튜닝 변경이 이 글자
 * 보장을 깨면 실패하는 감시 테스트다.
 *
 * ## 지표 = margin (nDCG 로는 못 본다 / GM)
 *
 * computeNdcg 는 group-first-hit 이라 정답이 1위면 nDCG=1.0 으로 포화한다 — 글
 * 6케이스가 전부 nDCG 1.0 인 것은 "정확일치가 1위"라는 뜻이지 개선 여지가 없다는
 * 뜻이 아니다. 정답과 top-distractor 의 점수 격차를 못 본다. 그래서 GB 는
 * margin = (정답 최고 score) − (top-distractor score)(scoreMargin / GM)로 동결한다.
 *
 * ## 취약 케이스 "회의록" 은 known-weak 로 정직히 노출 (측정이 spec 전제를 정정)
 *
 * spec:71 은 "회의록 흔한 합성어 margin 0.048(impl 측정 유일 취약점)"을 GB 에 반드시
 * 포함하라고 지시한다. 이 세션 실측(실 bge-m3, 결정적 재현)은 그 값을 정정한다:
 * "회의록" 질의에서 정확일치 노드(코퍼스 줄8 "…회의록을 자동으로 정리해준다")의
 * margin 은 **음수(-0.0008)**다 — top1 이 줄11("…회의에서 다룬 안건", "회의록" 미포함·
 * "회의"만)이고 정확일치 줄8 이 근소하게 밀린다. dense 가 "회의록"→"회의" 부분매치를
 * 정확일치보다 살짝 위에 놓기 때문이다.
 *
 * 이는 결말 B 의 주장("dense 가 글 정확일치를 상위에 둔다")의 반례다. 그래서 이
 * 케이스를 "margin>0" 으로 hard-assert 하면 주장 자체가 거짓이 된다(존재하지 않는
 * 보장을 만드는 셈). 대신:
 *  - LX1~LX5(정상 케이스): margin > 0 을 hard-assert 해 "대체로 정확일치가 이긴다"를
 *    동결한다. 가장 아슬아슬한 LX1(0.0178)을 감시선으로 기록.
 *  - "회의록"(known-weak): 음수임을 측정 표에 정직히 노출하고, "지금보다 더 나빠지지
 *    않게"만 감시한다(margin >= 실측 baseline − ε). 흔한 합성어에서 dense 가 정확일치
 *    보장을 이미 아슬아슬하게 놓치는 지점을 미래 회귀로부터 지킨다(더 음수로 가면 실패).
 *
 * 새 운영 값 변경 0 — 이 게이트는 tuning 미지정(현행 w=0)으로만 잰다. 운영 코드
 * (search-tuning.ts 등)는 한 글자도 안 건드린다.
 *
 * mock 0 — 실 bge-m3 + 실 :memory: SQLite + 데이터 fixture. 모델 로드로 timeout
 * 600_000(사전결함 #13 회피).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildLexicalHarness,
  DEFAULT_LEXICAL_LIMIT,
  type LexicalHarness,
} from "./lexical-eval-harness.ts";
import { scoreMargin } from "./lexical-margin.ts";
import { LEXICAL_QUERIES } from "../../../test-fixtures/sandbox/lexical-queries.ts";

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

/**
 * 글 케이스 = typo-guard(정답 없음) 제외, 이미지 fixture 제외(순수 글 margin 측정).
 * 이미지 노드는 정답 그룹에 안 넣고 글 정답 줄만 본다.
 */
const textQueries = LEXICAL_QUERIES.filter((q) => q.kind !== "typo-guard");

describe("GB — 글 회귀 게이트 (bge-m3 dense 글자 보장 동결)", () => {
  test(
    "LX1~LX5 글 정확일치 margin > 0 (정확일치가 top-distractor 위) hard-assert",
    async () => {
      console.log(
        "\n[GB 글 margin 표] 현행 w=0 (운영 default) — 정확일치 margin (dense 보장)",
      );
      console.log("  케이스 | 성격 | 글 margin | 판정");
      for (const q of textQueries) {
        // 이미지 노드는 제외하고 글 정답 줄만 정답으로 본다(순수 글 margin).
        const answerIds = idsForLines(q.answers);
        const results = await harness.retriever.retrieve(q.query, {
          limit: DEFAULT_LEXICAL_LIMIT,
        });
        const margin = scoreMargin(results, answerIds);
        const pass = margin > 0;
        console.log(
          `  ${q.id} | ${q.kind} | ${margin.toFixed(6)} | ${pass ? "정확일치 위(양수)" : "정확일치 밀림(음수!)"}`,
        );
        // hard-assert — 글 정확일치가 top-distractor 보다 위(margin 양수). bge-m3
        // dense 가 이 보장을 미래에 잃으면 여기서 실패한다.
        expect(margin).toBeGreaterThan(0);
      }
    },
    600_000,
  );

  test(
    "가장 아슬아슬한 케이스(LX1) margin 이 감시선 위 — 미래 회귀 감지",
    async () => {
      // LX1 "노란후드" 는 실측 글 margin 이 가장 낮은 정상 케이스(0.0178). 이걸
      // 감시선으로 못박아, bge-m3 가 이 최저 여유를 더 깎으면(회귀) 잡는다. floor 는
      // 감이 아니라 실측(0.0178)에서 여유 1e-3 뺀 측정 기준선.
      const lx1 = textQueries.find((q) => q.id === "LX1")!;
      const answerIds = idsForLines(lx1.answers);
      const results = await harness.retriever.retrieve(lx1.query, {
        limit: DEFAULT_LEXICAL_LIMIT,
      });
      const margin = scoreMargin(results, answerIds);
      const FLOOR = 0.0178 - 1e-3; // 실측 0.0178 기준 회귀 감시선.
      console.log(
        `\n[GB 감시선] LX1 "노란후드" 글 margin=${margin.toFixed(6)} (floor=${FLOOR.toFixed(6)}) — 최저 여유 케이스 회귀 감시`,
      );
      expect(margin).toBeGreaterThan(FLOOR);
    },
    600_000,
  );

  test(
    'known-weak "회의록" — 흔한 합성어에서 정확일치가 이미 음수(측정 정정) + 회귀 감시',
    async () => {
      // spec 전제("회의록 margin 0.048 양수")를 실측이 정정한다: 정확일치 줄8 의
      // margin 은 음수다(줄11 "회의"만 든 문장이 근소하게 위). 이는 결말 B 의 반례라
      // margin>0 hard-assert 대상이 아니라 "known-weak" 로 노출한다 — dense 가 흔한
      // 합성어에서 정확일치 보장을 이미 아슬아슬하게 놓치는 지점.
      const results = await harness.retriever.retrieve("회의록", {
        limit: DEFAULT_LEXICAL_LIMIT,
      });
      // 정답 = 줄8("…회의록을 자동으로 정리해준다", "회의록" 정확 포함).
      const answerIds = idsForLines([8]);
      const margin = scoreMargin(results, answerIds);

      console.log(
        `\n[GB known-weak] "회의록" 정확일치(줄8) margin=${margin.toFixed(6)} ` +
          `— 흔한 합성어라 dense 가 "회의" 부분매치(줄11)를 근소하게 위에 둠. ` +
          `spec 의 "margin 0.048 양수"를 실측이 음수로 정정.`,
      );

      // 회수는 성립해야 한다(정확일치가 회수 pool 에는 든다 — 순위 문제지 회수 문제 아님).
      expect(margin).not.toBe(-Infinity);
      // 회귀 감시 — "지금보다 더 나빠지지 않게". 실측 baseline(-0.0008)에서 여유
      // 5e-3 뺀 선. margin>0 을 강요하지 않는다(그건 거짓 보장). 미래에 dense 가
      // 이 정확일치를 지금보다 더 아래로 밀면(더 음수) 여기서 잡는다.
      const WEAK_FLOOR = -0.0008 - 5e-3;
      expect(margin).toBeGreaterThan(WEAK_FLOOR);
    },
    600_000,
  );
});
