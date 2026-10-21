/**
 * summary-cycle-partial-document.test.ts — 요약 사이클이 문서 *일부* 청크만 보는 경우의 관계 발굴 검증
 * (2026-10-19). summary-cycle.test.ts 에서 나눈 파일(800줄 상한).
 *
 * 실 :memory: SQLite + 실 bge-m3 embedder + 실 EventBus, infer 는 데이터 fixture 응답 함수(mock 0).
 *   - 관계 허용 개념은 그 호출 청크에서 나온 것만(요약 끝난 같은 문서 청크 개념 불가).
 *   - 문서에 관계요약이 이미 있어도 새 청크 묶음은 관계 발굴(옛 문서 단위 영구 마감 폐기),
 *     같은 문서 기존 개념 쌍(방향 무관) 중복은 건너뜀.
 *   - 한 문서 청크가 호출당 상한을 넘으면 나눠 부르고 호출마다 청크 수를 넘긴다.
 *   - buildSummaryRunRequest 지시문("문서 일부일 수 있다")·출력 한도(청크 수 비례, 상한 아래).
 */

import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { EventBus } from "../../server-internal/event-bus.ts";
import { EventRepository } from "../../db/store-internal/event-repository.ts";
import {
  buildSummaryRunRequest,
  relationDiscoveryTargetKey,
  runSummaryCycle,
} from "./summary-cycle.ts";
import {
  cleanupStageMaxItemsPerCall,
  cleanupStageMaxOutputTokensFor,
} from "./stage-constants.ts";
import type { SummaryInferFn } from "./summary-gates.ts";
import { getStageResult } from "./stage-results-ledger.ts";
import {
  MODEL_LOAD_TIMEOUT_MS,
  attachAtomics,
  baseDeps as baseDepsWith,
  insertChunk,
  insertChunkSummaryRow,
  insertConcept,
  insertDocument,
  insertRelationSummaryRow,
  linkConcept,
  makeFixture as makeFixtureWith,
  ok,
  type SummaryCycleFixture,
} from "./summary-cycle.test-helpers.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
}, MODEL_LOAD_TIMEOUT_MS);

function makeFixture(): SummaryCycleFixture {
  return makeFixtureWith(embedder, (db) => new EventBus(new EventRepository(db)));
}

const baseDeps = baseDepsWith;

describe("runSummaryCycle — 부분 문서 관계 발굴(2026-10-19)", () => {
  it(
    "관계 허용 개념은 이번 호출 청크에서 나온 것만 — 요약 끝난 같은 문서 청크의 개념으로 만든 관계는 환각으로 버린다",
    async () => {
      const fx = makeFixture();
      insertDocument(fx.db, "doc-a");
      // c0 = 이미 요약 끝난 청크(후보 아님), 개념 X·Y. c1 = 이번 후보, 개념 Z·W.
      const c0 = insertChunk(fx.db, "앞 조각 X 와 Y", "doc-a", 0, "2026-06-05 10:00:00");
      const c0Atomics = attachAtomics(fx.db, c0, 4);
      insertChunkSummaryRow(fx.db, c0, "doc-a");
      const c1 = insertChunk(fx.db, "뒤 조각 Z 와 W", "doc-a", 1, "2026-06-05 10:01:00");
      const c1Atomics = attachAtomics(fx.db, c1, 4);
      const cptX = insertConcept(fx.db, "cpt_X", "개념X");
      const cptY = insertConcept(fx.db, "cpt_Y", "개념Y");
      const cptZ = insertConcept(fx.db, "cpt_Z", "개념Z");
      const cptW = insertConcept(fx.db, "cpt_W", "개념W");
      linkConcept(fx.db, c0Atomics[0]!, cptX);
      linkConcept(fx.db, c0Atomics[1]!, cptY);
      linkConcept(fx.db, c1Atomics[0]!, cptZ);
      linkConcept(fx.db, c1Atomics[1]!, cptW);

      const prompts: string[] = [];
      const infer: SummaryInferFn = async (prompt) => {
        prompts.push(prompt);
        return ok(JSON.stringify({
          chunkSummaries: [{ chunk_id: c1, summary_text: "Z 와 W 이야기.", confidence: 0.9 }],
          relationSummaries: [
            { from_concept_id: cptX, to_concept_id: cptY, relation_name: "라이벌", summary_text: "못 본 글의 관계.", confidence: 0.9 },
            { from_concept_id: cptZ, to_concept_id: cptW, relation_name: "소속", summary_text: "Z 는 W 소속.", confidence: 0.9 },
          ],
        }));
      };

      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const summary = await runSummaryCycle(baseDeps(fx, infer));
      warn.mockRestore();

      // 프롬프트 개념 목록에는 이번 청크(c1) 개념만 — 못 본 청크(c0) 개념 id 는 안 실린다.
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(cptZ);
      expect(prompts[0]).toContain(cptW);
      expect(prompts[0]).not.toContain(cptX);
      expect(prompts[0]).not.toContain(cptY);
      expect(prompts[0]).toContain("문서 일부일 수 있음");
      // X↔Y 는 허용 집합 밖이라 버려지고, Z↔W 만 저장된다.
      expect(summary.rejectedHallucinations).toBe(1);
      expect(summary.relationSummariesCreated).toBe(1);
      const rows = fx.db
        .prepare("SELECT from_concept_id, to_concept_id FROM relation_summaries")
        .all() as { from_concept_id: string; to_concept_id: string }[];
      expect(rows).toEqual([{ from_concept_id: cptZ, to_concept_id: cptW }]);
      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  it(
    "문서에 관계요약이 이미 있어도 새 청크 묶음은 관계 발굴을 받고, 같은 문서에 이미 있는 개념 쌍(방향 무관)은 건너뛴다",
    async () => {
      const fx = makeFixture();
      insertDocument(fx.db, "doc-a");
      const c1 = insertChunk(fx.db, "A·B·C 가 나오는 뒤 조각", "doc-a", 3, "2026-06-05 10:00:00");
      const c1Atomics = attachAtomics(fx.db, c1, 4);
      const cptA = insertConcept(fx.db, "cpt_A", "개념A");
      const cptB = insertConcept(fx.db, "cpt_B", "개념B");
      const cptC = insertConcept(fx.db, "cpt_C", "개념C");
      linkConcept(fx.db, c1Atomics[0]!, cptA);
      linkConcept(fx.db, c1Atomics[1]!, cptB);
      linkConcept(fx.db, c1Atomics[2]!, cptC);
      // 앞선 묶음이 이미 A→B 관계를 저장했다(옛 동작이면 이 문서는 관계 발굴이 영구 마감).
      insertRelationSummaryRow(fx.db, cptA, cptB, "doc-a");

      let called = 0;
      const infer: SummaryInferFn = async () => {
        called += 1;
        return ok(JSON.stringify({
          chunkSummaries: [{ chunk_id: c1, summary_text: "A·B·C 이야기.", confidence: 0.9 }],
          relationSummaries: [
            { from_concept_id: cptB, to_concept_id: cptA, relation_name: "라이벌", summary_text: "B 와 A 는 라이벌.", confidence: 0.9 },
            { from_concept_id: cptB, to_concept_id: cptC, relation_name: "소속", summary_text: "B 는 C 소속.", confidence: 0.9 },
          ],
        }));
      };

      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const summary = await runSummaryCycle(baseDeps(fx, infer));
      warn.mockRestore();

      expect(called).toBe(1);
      // B→A 는 기존 A→B 와 같은 쌍이라 건너뜀, B→C 는 새로 저장.
      expect(summary.relationDuplicatesSkipped).toBe(1);
      expect(summary.relationSummariesCreated).toBe(1);
      const rows = fx.db
        .prepare("SELECT from_concept_id, to_concept_id FROM relation_summaries ORDER BY rowid")
        .all() as { from_concept_id: string; to_concept_id: string }[];
      expect(rows).toEqual([
        { from_concept_id: cptA, to_concept_id: cptB },
        { from_concept_id: cptB, to_concept_id: cptC },
      ]);
      expect(
        getStageResult(fx.db, "relation_discovery", relationDiscoveryTargetKey("doc-a", [c1]))!.status,
      ).toBe("completed");
      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  it(
    "한 문서 청크가 호출당 청크 상한을 넘으면 나눠 부르고, 호출마다 그 묶음 청크 수를 넘긴다",
    async () => {
      const fx = makeFixture();
      insertDocument(fx.db, "doc-a");
      const maxPerCall = cleanupStageMaxItemsPerCall("summary");
      const total = maxPerCall + 1;
      for (let i = 0; i < total; i++) {
        const minute = String(i).padStart(2, "0");
        const chunk = insertChunk(fx.db, `조각 ${i}`, "doc-a", i, `2026-06-05 10:${minute}:00`);
        attachAtomics(fx.db, chunk, 4);
      }

      const chunkCounts: number[] = [];
      const infer: SummaryInferFn = async (_prompt, chunkCount) => {
        chunkCounts.push(chunkCount);
        return ok(JSON.stringify({ chunkSummaries: [], relationSummaries: [] }));
      };

      await runSummaryCycle(baseDeps(fx, infer));
      expect(chunkCounts).toEqual([maxPerCall, 1]);
      fx.db.close();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );
});

describe("buildSummaryRunRequest — 지시문·출력 한도", () => {
  it("지시문은 묶음이 문서 일부일 수 있다고 밝히고, 출력 한도는 청크 수에 비례(상한 아래)", () => {
    const req = buildSummaryRunRequest("본문", 3);
    const system = req.messages[0]!.content;
    expect(system).toContain("문서 전체가 아니라 일부 청크일 수 있다");
    expect(req.maxOutputTokens).toBe(cleanupStageMaxOutputTokensFor("summary", 3));
    const maxPerCall = cleanupStageMaxItemsPerCall("summary");
    expect(buildSummaryRunRequest("본문", maxPerCall).maxOutputTokens).toBeLessThan(req.maxOutputTokensCap);
  });
});
