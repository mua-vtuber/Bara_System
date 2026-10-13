// regex-strengthen-harness.test.ts
import { test, expect } from "bun:test";
import {
  normalizePatternForDedup,
  testRegexProposal,
  type ProposedPattern,
} from "./regex-strengthen-harness.ts";

const base: ProposedPattern = {
  pattern: "(.{2,40})\\s+몰랐[어다]",
  score: 1,
  category: "fact",
  polarity: "neutral",
  exampleInput: "이거 진짜 몰랐어",
  exampleExtracted: "이거 진짜",
  description: "X 몰랐다",
};
const ctx = {
  overmatchSample: ["오늘 날씨 좋네", "회의 3시", "점심 뭐 먹지"],
  overmatchThreshold: 0.3,
  currentPatterns: [] as RegExp[],
};

test("통과: 정상 제안", () => {
  const r = testRegexProposal(base, ctx);
  expect(r.ok).toBe(true);
  expect(typeof r.overmatchRate).toBe("number");
});

test("reject: 컴파일 실패", () => {
  const r = testRegexProposal({ ...base, pattern: "(unclosed" }, ctx);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("compile");
});

test("reject: 자기 예문 매치 실패", () => {
  const r = testRegexProposal({ ...base, pattern: "절대안나오는글자zzz(.+)" }, ctx);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("self_match");
});

test("reject: 과매치", () => {
  const r = testRegexProposal(
    { ...base, pattern: "(.+)" },
    { ...ctx, overmatchSample: ["a", "b", "c", "d"], overmatchThreshold: 0.3 },
  );
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("overmatch");
  expect(r.overmatchRate).toBeGreaterThan(0.3);
});

test("reject: 중복(현재 양식이 예문을 이미 잡음)", () => {
  const r = testRegexProposal(base, {
    ...ctx,
    currentPatterns: [/(.{2,40})\s+몰랐[어다]/i],
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("redundant");
});

test("reject: score 범위 밖", () => {
  const r = testRegexProposal({ ...base, score: 9 }, ctx);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("validity");
});

test("reject: category 범위 밖", () => {
  const r = testRegexProposal({ ...base, category: "unknown" as any }, ctx);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("validity");
});

test("reject: polarity 범위 밖", () => {
  const r = testRegexProposal({ ...base, polarity: "mixed" as any }, ctx);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("validity");
});

test("reject: 캡처는 됐지만 trim 후 빈 문자열", () => {
  // (\s*) 는 공백 0개를 캡처 → m[1] === "" → trim 후 길이 0 → self_match.
  const r = testRegexProposal(
    { ...base, pattern: "(\\s*)몰랐어", exampleInput: "몰랐어", exampleExtracted: "" },
    ctx,
  );
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("self_match");
});

// ── 사이클 내 정규화 dedup(spec 5.B-3, #15) ──────────────────────────────────

test("normalizePatternForDedup: 공백 정규화 — 앞뒤 공백 제거해도 같은 키", () => {
  const a = normalizePatternForDedup("(.{2,40})\\s+몰랐[어다]");
  const b = normalizePatternForDedup("  (.{2,40})\\s+몰랐[어다]  ");
  expect(a).toBe(b);
});

test("normalizePatternForDedup: 공백 정규화 — 연속 리터럴 공백은 한 칸으로 접혀 같은 키", () => {
  // 정규식 밖 리터럴 스페이스(예: "먹었 다" 같은 원문 공백을 그대로 옮긴 실수)가
  // 한 칸이든 여러 칸이든 같은 규칙으로 취급되도록 접는다. \s(이스케이프 공백류
  // 지시자)는 리터럴 스페이스가 아니라 건드리지 않는다.
  const a = normalizePatternForDedup("먹었 다(.+)");
  const b = normalizePatternForDedup("먹었   다(.+)");
  expect(a).toBe(b);
});

test("normalizePatternForDedup: 플래그 정규화 — 다른 플래그 조합도 같은 키(하네스는 항상 i 로 컴파일)", () => {
  const a = normalizePatternForDedup("몰랐[어다]");
  const b = normalizePatternForDedup("몰랐[어다]", "gi");
  const c = normalizePatternForDedup("몰랐[어다]", "");
  expect(a).toBe(b);
  expect(a).toBe(c);
});

test("normalizePatternForDedup: 실제로 다른 패턴은 다른 키", () => {
  const a = normalizePatternForDedup("몰랐[어다]");
  const b = normalizePatternForDedup("몰랐[다]");
  expect(a).not.toBe(b);
});

test("reject: 사이클 로컬 집합과 중복(같은 사이클 먼저 통과한 패턴의 정규화 형태)", () => {
  const r = testRegexProposal(base, {
    ...ctx,
    cycleLocalPatterns: new Set([normalizePatternForDedup(base.pattern)]),
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("redundant");
});

test("reject: 사이클 로컬 집합 — 정규식 안 리터럴 공백 개수만 다른 동형 패턴도 잡힘", () => {
  // 앞서 통과한 패턴(연속 스페이스 3칸)과 정규화 키는 같지만, 리터럴 그대로는
  // 다른 문자열인 제안(연속 스페이스 1칸)이 뒤이어 와도 사이클 로컬 게이트가 잡는다.
  const firstPass: ProposedPattern = {
    ...base,
    pattern: "먹었   다(.+)",
    exampleInput: "먹었   다 진짜",
    exampleExtracted: "진짜",
  };
  const secondCandidate: ProposedPattern = {
    ...base,
    pattern: "먹었 다(.+)",
    exampleInput: "먹었 다 완전",
    exampleExtracted: "완전",
  };
  // 사전조건 — secondCandidate 는 하네스 단독으로는 통과할 수 있는 정상 제안이다
  // (자기예문 매치 O, 현재 양식과 무관, 과매치 아님).
  const solo = testRegexProposal(secondCandidate, ctx);
  expect(solo.ok).toBe(true);

  const r = testRegexProposal(secondCandidate, {
    ...ctx,
    cycleLocalPatterns: new Set([normalizePatternForDedup(firstPass.pattern)]),
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("redundant");
});

test("통과: cycleLocalPatterns 이 비어 있으면(또는 미전달) 기존 동작과 동일", () => {
  const r1 = testRegexProposal(base, ctx);
  const r2 = testRegexProposal(base, { ...ctx, cycleLocalPatterns: new Set() });
  expect(r1.ok).toBe(true);
  expect(r2.ok).toBe(true);
});
