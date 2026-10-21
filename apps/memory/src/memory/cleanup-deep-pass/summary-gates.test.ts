/**
 * summary-gates.test.ts — 깊은 패스 둘째 단계 "요약" 품질 게이트 + JSON 파싱 테스트
 * (Phase 7 / Task 5). 데이터 입력 fixture 검증 — 실 LLM 호출 0, mock 객체 0.
 *
 * 권위 spec: docs/decisions/2026-06-05-phase7-summary-stage-spec.md 단락 4.3·4.5
 * 권위 plan: docs/decisions/2026-06-05-phase7-summary-stage-plan.md Task 5
 *
 * 검증 대상은 전부 순수 함수다 — DB·LLM 의존 없이 데이터를 넣고 출력을 본다.
 * 글루(summary-cycle.ts)는 Task 6 이 이 재료를 import 해서 쓴다.
 */

import { describe, expect, it, spyOn } from "bun:test";
import {
  gateRelationEdge,
  parseSummaryResponse,
  validateChunkSummary,
  validateRelationSummary,
} from "./summary-gates.ts";

describe("validateChunkSummary — 청크요약 ID 결정적 매치", () => {
  it("청크 id 가 입력 묶음 집합에 있으면 통과한다", () => {
    const allowed = new Set([10, 11, 12]);
    expect(validateChunkSummary(11, allowed)).toBe(true);
  });

  it("청크 id 가 입력 묶음 밖(환각)이면 버리고 식별자 담은 loud warn 을 낸다", () => {
    const allowed = new Set([10, 11, 12]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(validateChunkSummary(99, allowed)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]?.[0] ?? "");
      // 식별자(환각 id + 허용 집합) 가 메시지에 담겨야 한다 — silent 폐기 금지.
      expect(msg).toContain("99");
      expect(msg).toContain("10,11,12");
    } finally {
      warn.mockRestore();
    }
  });

  it("warn 메시지에 logPrefix 가 들어간다(주입 시)", () => {
    const allowed = new Set([1]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      validateChunkSummary(7, allowed, "[deep-pass:summary]");
      const msg = String(warn.mock.calls[0]?.[0] ?? "");
      expect(msg).toContain("[deep-pass:summary]");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("validateRelationSummary — 관계요약 from·to 개념 id 실재 검증", () => {
  it("from·to 둘 다 개념 집합에 있으면 통과한다(개념 id 는 cpt_/psn_ 문자열)", () => {
    const allowed = new Set(["cpt_a", "cpt_b", "psn_c"]);
    expect(validateRelationSummary("cpt_a", "psn_c", allowed)).toBe(true);
  });

  it("from 이 환각이면 그 관계 통째 버리고 loud warn(둘 다 식별자 담음)", () => {
    const allowed = new Set(["cpt_a", "cpt_b", "psn_c"]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(validateRelationSummary("cpt_zzz", "psn_c", allowed)).toBe(false);
      const msg = String(warn.mock.calls[0]?.[0] ?? "");
      expect(msg).toContain("cpt_zzz");
      expect(msg).toContain("psn_c");
      expect(msg).toContain("cpt_a,cpt_b,psn_c");
    } finally {
      warn.mockRestore();
    }
  });

  it("to 가 환각이면 그 관계 통째 버리고 loud warn", () => {
    const allowed = new Set(["cpt_a", "cpt_b", "psn_c"]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(validateRelationSummary("cpt_a", "cpt_yyy", allowed)).toBe(false);
      const msg = String(warn.mock.calls[0]?.[0] ?? "");
      expect(msg).toContain("cpt_a");
      expect(msg).toContain("cpt_yyy");
    } finally {
      warn.mockRestore();
    }
  });

  it("from·to 둘 다 환각이면 버리고 loud warn", () => {
    const allowed = new Set(["cpt_a", "cpt_b", "psn_c"]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(validateRelationSummary("cpt_xxx", "cpt_yyy", allowed)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("from·to 가 같은 개념(자기 관계)이면 버린다 — 자기 자신을 잇는 엣지 금지", () => {
    const allowed = new Set(["cpt_a", "cpt_b"]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(validateRelationSummary("cpt_a", "cpt_a", allowed)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("gateRelationEdge — confidence 임계 게이트(엣지 승격/보류)", () => {
  it("confidence 가 임계 이상이면 엣지 승격(true)", () => {
    expect(gateRelationEdge(0.9, 0.6)).toBe(true);
  });

  it("confidence 가 임계와 같으면 승격(>= 경계 포함)", () => {
    expect(gateRelationEdge(0.6, 0.6)).toBe(true);
  });

  it("confidence 가 임계 미만이면 엣지 보류(false) — 요약 문장은 저장(글루 판정)", () => {
    expect(gateRelationEdge(0.4, 0.6)).toBe(false);
  });

  it("임계는 인자다 — 하드코딩 0 (임계를 낮추면 같은 confidence 가 승격으로 바뀜)", () => {
    expect(gateRelationEdge(0.4, 0.3)).toBe(true);
    expect(gateRelationEdge(0.4, 0.5)).toBe(false);
  });
});

describe("parseSummaryResponse — 통합 JSON 파싱(코드펜스·잡담 허용)", () => {
  it("순수 JSON 두 갈래를 파싱한다(청크요약 + 관계요약)", () => {
    const raw = JSON.stringify({
      chunkSummaries: [{ chunk_id: 10, summary_text: "청크 한 문장 요약.", confidence: 0.8 }],
      relationSummaries: [
        {
          from_concept_id: "cpt_a",
          to_concept_id: "psn_b",
          relation_name: "라이벌",
          summary_text: "둘은 라이벌 사이다.",
          confidence: 0.9,
        },
      ],
    });
    const out = parseSummaryResponse(raw);
    expect(out.chunkSummaries.length).toBe(1);
    expect(out.chunkSummaries[0]).toEqual({
      chunkId: 10,
      summaryText: "청크 한 문장 요약.",
      confidence: 0.8,
    });
    expect(out.relationSummaries.length).toBe(1);
    expect(out.relationSummaries[0]).toEqual({
      fromConceptId: "cpt_a",
      toConceptId: "psn_b",
      relationName: "라이벌",
      summaryText: "둘은 라이벌 사이다.",
      confidence: 0.9,
    });
  });

  it("코드펜스(```json)와 앞뒤 잡담을 붙여도 첫 { ~ 마지막 } 를 추출한다", () => {
    const raw =
      '여기 결과입니다:\n```json\n{"chunkSummaries":[{"chunk_id":5,"summary_text":"요약.","confidence":0.7}],"relationSummaries":[]}\n```\n끝.';
    const out = parseSummaryResponse(raw);
    expect(out.chunkSummaries.length).toBe(1);
    expect(out.chunkSummaries[0]?.chunkId).toBe(5);
    expect(out.relationSummaries.length).toBe(0);
  });

  it("camelCase 키(chunkId·summaryText)도 받아 정규화한다", () => {
    const raw = JSON.stringify({
      chunkSummaries: [{ chunkId: 3, summaryText: "캐멀 요약.", confidence: 0.6 }],
      relationSummaries: [
        {
          fromConceptId: "cpt_x",
          toConceptId: "cpt_y",
          relationName: "소속",
          summaryText: "A 는 B 소속.",
          confidence: 0.7,
        },
      ],
    });
    const out = parseSummaryResponse(raw);
    expect(out.chunkSummaries[0]?.chunkId).toBe(3);
    expect(out.relationSummaries[0]?.fromConceptId).toBe("cpt_x");
  });

  it("두 키가 없으면 빈 배열로 채운다(둘 다 부재해도 throw 아님)", () => {
    const raw = "{}";
    const out = parseSummaryResponse(raw);
    expect(out.chunkSummaries).toEqual([]);
    expect(out.relationSummaries).toEqual([]);
  });

  it("형식 어긋난 원소는 거른다(청크요약: id 비숫자 / 관계요약: 칸 부재·개념 id 비문자열)", () => {
    const raw = JSON.stringify({
      chunkSummaries: [
        { chunk_id: "열", summary_text: "비숫자 id 라 버려짐.", confidence: 0.8 },
        { chunk_id: 12, summary_text: "정상.", confidence: 0.5 },
        { chunk_id: 13, summary_text: "", confidence: 0.5 },
      ],
      relationSummaries: [
        {
          from_concept_id: "cpt_a",
          to_concept_id: "cpt_b",
          summary_text: "relation_name 부재.",
          confidence: 0.9,
        },
        {
          from_concept_id: 1,
          to_concept_id: 2,
          relation_name: "개념 id 가 정수라 버려짐.",
          summary_text: "정수 개념 id 거름.",
          confidence: 0.9,
        },
        {
          from_concept_id: "cpt_a",
          to_concept_id: "cpt_b",
          relation_name: "정상관계",
          summary_text: "정상.",
          confidence: 0.9,
        },
      ],
    });
    const out = parseSummaryResponse(raw);
    expect(out.chunkSummaries.length).toBe(1);
    expect(out.chunkSummaries[0]?.chunkId).toBe(12);
    expect(out.relationSummaries.length).toBe(1);
    expect(out.relationSummaries[0]?.relationName).toBe("정상관계");
  });

  it("청크요약 confidence 는 선택 — 빠지거나 비숫자·0~1 밖이어도 요약은 남기고 값만 뺀다(2026-10-20)", () => {
    const raw = JSON.stringify({
      chunkSummaries: [
        { chunk_id: 1, summary_text: "범위 밖.", confidence: 1.5 },
        { chunk_id: 2, summary_text: "음수.", confidence: -0.1 },
        { chunk_id: 3, summary_text: "비숫자.", confidence: "높음" },
        { chunk_id: 4, summary_text: "정상.", confidence: 0.5 },
        { chunk_id: 5, summary_text: "confidence 없음." },
      ],
      relationSummaries: [],
    });
    const out = parseSummaryResponse(raw);
    expect(out.chunkSummaries.map((c) => c.chunkId)).toEqual([1, 2, 3, 4, 5]);
    expect(out.chunkSummaries.find((c) => c.chunkId === 4)?.confidence).toBe(0.5);
    for (const id of [1, 2, 3, 5]) {
      expect(out.chunkSummaries.find((c) => c.chunkId === id)?.confidence).toBeUndefined();
    }
  });

  it("관계요약 confidence 는 그대로 필수 — 빠지거나 0~1 밖이면 그 관계를 거른다", () => {
    const raw = JSON.stringify({
      chunkSummaries: [],
      relationSummaries: [
        { from_concept_id: "cpt_a", to_concept_id: "cpt_b", relation_name: "라이벌", summary_text: "s" },
        { from_concept_id: "cpt_a", to_concept_id: "cpt_b", relation_name: "라이벌", summary_text: "s", confidence: 2 },
        { from_concept_id: "cpt_a", to_concept_id: "cpt_b", relation_name: "라이벌", summary_text: "s", confidence: 0.7 },
      ],
    });
    expect(parseSummaryResponse(raw).relationSummaries.map((r) => r.confidence)).toEqual([0.7]);
  });

  it("코드 울타리 밖 설명 글에 중괄호가 섞여도 울타리 안 객체를 읽는다", () => {
    const obj = JSON.stringify({ chunkSummaries: [{ chunk_id: 9, summary_text: "한 문장." }], relationSummaries: [] });
    const raw = ["양식 {예시} 대로 냅니다:", "```json", obj, "```", "끝 {완료}"].join("\n");
    expect(parseSummaryResponse(raw).chunkSummaries.map((c) => c.chunkId)).toEqual([9]);
  });

  it("{ 를 못 찾으면 throw 한다(글루가 그 문서 loud warn 으로 건너뜀 — silent 0건 위장 금지)", () => {
    expect(() => parseSummaryResponse("아무 JSON 없는 잡담뿐")).toThrow();
  });

  it("JSON 문법이 깨졌으면 throw 한다", () => {
    expect(() => parseSummaryResponse('{"chunkSummaries": [,,,] 깨짐')).toThrow();
  });

  it("객체 경계가 아예 없는 배열만(`{` 없음) 이면 throw 한다", () => {
    // 첫 `{` ~ 마지막 `}` 추출이라, `{` 가 없는 순수 스칼라 배열은 객체를 못 찾아 throw.
    expect(() => parseSummaryResponse("[1, 2, 3]")).toThrow();
  });
});
