/**
 * proposal-notify.test.ts — 제안 근거 표시 + 버튼 customId 파싱 (Phase 7 2차 Task 7).
 *
 * 디스코드 DM 전송·버튼 클릭(ButtonInteraction)은 실 디스코드 게이트웨이가 필요한
 * UI 라 수동 sanity 대상이다(보고서에 정직 표기). 여기서는 데이터 fixture 로
 * 검증 가능한 순수 로직만 다룬다 — 근거 풀어쓰기 + customId 파싱(왕복).
 */

import { describe, expect, test } from "bun:test";
import {
  PROPOSAL_BUTTON_PREFIX,
  describeProposal,
  parseProposalButton,
} from "./proposal-notify.ts";
import type { CleanupProposal } from "../../memory/src/api-client.ts";

function makeProposal(
  kind: string,
  payload: Record<string, unknown>,
): CleanupProposal {
  return {
    id: "cp_00000000-0000-0000-0000-000000000001",
    kind,
    payload,
    status: "pending",
    createdAt: "2026-06-04T00:00:00Z",
    resolvedAt: null,
  };
}

describe("describeProposal — 근거 표시", () => {
  test("(d1) metadata_fill place — 노드·칸·값·근거를 풀어쓴다", () => {
    const p = makeProposal("metadata_fill", {
      nodeId: 42,
      field: "place",
      value: "에버랜드",
      evidence: "직전 '에버랜드에 왔다'",
    });
    const text = describeProposal(p);
    expect(text).toContain("#42");
    expect(text).toContain("장소");
    expect(text).toContain("에버랜드");
    expect(text).toContain("근거: 직전 '에버랜드에 왔다'");
  });

  test("(d2) metadata_fill event_at — 시각 칸 라벨", () => {
    const p = makeProposal("metadata_fill", {
      nodeId: 7,
      field: "event_at",
      value: "2026-05-01",
    });
    const text = describeProposal(p);
    expect(text).toContain("#7");
    expect(text).toContain("시각");
    expect(text).toContain("2026-05-01");
  });

  test("(d3) 근거 없으면 근거 줄을 안 만든다(지어내지 않음)", () => {
    const p = makeProposal("metadata_fill", {
      nodeId: 1,
      field: "place",
      value: "집",
    });
    const text = describeProposal(p);
    expect(text).not.toContain("근거:");
  });

  test("(d4) 모르는 kind 는 kind 만 정직하게 표시(값 안 지어냄)", () => {
    const p = makeProposal("classification", { nodeId: 1 });
    const text = describeProposal(p);
    expect(text).toContain("classification");
  });

  test("(d5) regex_pattern_add — 풀이 + 놓친 원문 예시를 한 줄로", () => {
    const p = makeProposal("regex_pattern_add", {
      sourceNodeId: 9,
      pattern: "(?:먹었다|마셨다)",
      score: 0.6,
      category: "fact",
      polarity: "neutral",
      exampleInput: "오늘 점심에 김치찌개를 먹었다",
      exampleExtracted: "김치찌개를 먹었다",
      description: "음식 섭취 표현을 잡는 패턴",
      testResult: { overmatchRate: 0.0 },
    });
    const text = describeProposal(p);
    expect(text).toContain("음식 섭취 표현을 잡는 패턴");
    expect(text).toContain("오늘 점심에 김치찌개를 먹었다");
  });

  test("(d6) regex_pattern_add — rationale 있으면 근거 줄을 더한다", () => {
    const p = makeProposal("regex_pattern_add", {
      sourceNodeId: 3,
      pattern: "도착했다",
      score: 0.5,
      category: "status",
      polarity: "neutral",
      exampleInput: "방금 회사에 도착했다",
      exampleExtracted: "회사에 도착했다",
      description: "이동·도착 표현",
      rationale: "도착 표현이 추출기에서 자주 누락됨",
      testResult: { overmatchRate: 0.0 },
    });
    const text = describeProposal(p);
    expect(text).toContain("이동·도착 표현");
    expect(text).toContain("근거: 도착 표현이 추출기에서 자주 누락됨");
  });

  test("(d7) regex_pattern_add — rationale 없으면 근거 줄 안 만든다(지어내지 않음)", () => {
    const p = makeProposal("regex_pattern_add", {
      sourceNodeId: 1,
      pattern: "샀다",
      score: 0.4,
      category: "preference",
      polarity: "neutral",
      exampleInput: "마트에서 우유를 샀다",
      exampleExtracted: "우유를 샀다",
      description: "구매 표현",
      testResult: { overmatchRate: 0.0 },
    });
    const text = describeProposal(p);
    expect(text).not.toContain("근거:");
  });
});

describe("parseProposalButton — customId 왕복", () => {
  test("(e1) approve/reject/hold 를 파싱한다", () => {
    const id = "cp_abcd";
    expect(parseProposalButton(`${PROPOSAL_BUTTON_PREFIX}:approve:${id}`)).toEqual({
      action: "approve",
      proposalId: id,
    });
    expect(parseProposalButton(`${PROPOSAL_BUTTON_PREFIX}:reject:${id}`)).toEqual({
      action: "reject",
      proposalId: id,
    });
    expect(parseProposalButton(`${PROPOSAL_BUTTON_PREFIX}:hold:${id}`)).toEqual({
      action: "hold",
      proposalId: id,
    });
  });

  test("(e2) proposal 네임스페이스가 아니면 null(다른 버튼은 안 가로챔)", () => {
    expect(parseProposalButton("other:approve:cp_x")).toBeNull();
    expect(parseProposalButton("approve")).toBeNull();
    expect(parseProposalButton("")).toBeNull();
  });

  test("(e3) 모르는 action 은 null", () => {
    expect(parseProposalButton(`${PROPOSAL_BUTTON_PREFIX}:delete:cp_x`)).toBeNull();
  });

  test("(e4) proposalId 빈 값은 null", () => {
    expect(parseProposalButton(`${PROPOSAL_BUTTON_PREFIX}:approve:`)).toBeNull();
  });
});
