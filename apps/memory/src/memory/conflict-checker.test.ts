/**
 * Tests for conflict detection — pure helpers only.
 *
 * Class-level integration tests deferred until A1 environment exists,
 * to avoid mock-object contamination during the real store/embedding
 * wiring phase. Past experience: mock objects often outlive their
 * usefulness, get out of sync with real interfaces, and produce
 * passing-but-misleading tests.
 */

import { describe, expect, test } from "bun:test";
import {
  CONFLICT_SIM_HIGH,
  CONFLICT_SIM_LOW,
  IMPORTANCE_DECAY,
  OWNER_CONFLICT_SUBJECT,
  conflictSubjectKey,
  decayedImportance,
  highSimilarityRoute,
  isConflictPair,
  isConflictSimilarity,
  shouldCheckConflict,
} from "./conflict-checker.ts";

describe("isConflictSimilarity", () => {
  // bge-m3 단일 모델 기준 conflict band. 입력값은 절대값 대신 상수 기반으로 잡아
  // 차후 조정에도 회귀 가드가 살아 있게.
  test("below lower bound → false", () => {
    expect(isConflictSimilarity(0.0)).toBe(false);
    expect(isConflictSimilarity(CONFLICT_SIM_LOW - 0.001)).toBe(false);
  });

  test("at lower bound → true (inclusive)", () => {
    expect(isConflictSimilarity(CONFLICT_SIM_LOW)).toBe(true);
  });

  test("in the band → true", () => {
    const midband = (CONFLICT_SIM_LOW + CONFLICT_SIM_HIGH) / 2;
    expect(isConflictSimilarity(midband)).toBe(true);
  });

  test("at upper bound → false (exclusive)", () => {
    expect(isConflictSimilarity(CONFLICT_SIM_HIGH)).toBe(false);
  });

  test("above upper bound → false (duplicates handled elsewhere)", () => {
    expect(isConflictSimilarity(CONFLICT_SIM_HIGH + 0.005)).toBe(false);
    expect(isConflictSimilarity(1.0)).toBe(false);
  });
});

describe("decayedImportance", () => {
  test("multiplies by IMPORTANCE_DECAY", () => {
    expect(decayedImportance(1.0)).toBeCloseTo(IMPORTANCE_DECAY, 5);
    expect(decayedImportance(0.5)).toBeCloseTo(0.5 * IMPORTANCE_DECAY, 5);
  });

  test("never goes below 0", () => {
    expect(decayedImportance(0)).toBe(0);
    expect(decayedImportance(-1)).toBe(0);
  });
});

describe("shouldCheckConflict", () => {
  test("fact + non-empty author → true", () => {
    expect(shouldCheckConflict("fact", "alice")).toBe(true);
  });

  test("preference + author → true", () => {
    expect(shouldCheckConflict("preference", "bob")).toBe(true);
  });

  test("triple/insight/episode → false (only fact/preference processed)", () => {
    expect(shouldCheckConflict("triple", "alice")).toBe(false);
    expect(shouldCheckConflict("insight", "alice")).toBe(false);
    expect(shouldCheckConflict("episode", "alice")).toBe(false);
  });

  test("empty author → false", () => {
    expect(shouldCheckConflict("fact", "")).toBe(false);
  });
});

describe("conflictSubjectKey", () => {
  test("user_id 가 없거나 빈 문자열이면 소유자 본인 — 작성 AI 와 무관하다", () => {
    expect(conflictSubjectKey({ metadata: {} })).toBe(OWNER_CONFLICT_SUBJECT);
    // 즉시 추출 자식은 user_id 가 없을 때 빈 문자열을 싣는다(save-input-immediate.ts).
    expect(conflictSubjectKey({ metadata: { user_id: "" } })).toBe(OWNER_CONFLICT_SUBJECT);
    expect(conflictSubjectKey({ metadata: { user_id: "   " } })).toBe(OWNER_CONFLICT_SUBJECT);
  });

  test("user_id 가 있으면 그 사람 — 앞뒤 공백은 같은 사람으로 본다", () => {
    expect(conflictSubjectKey({ metadata: { user_id: "1001" } })).toBe("user:1001");
    expect(conflictSubjectKey({ metadata: { user_id: " 1001 " } })).toBe("user:1001");
    expect(conflictSubjectKey({ metadata: { user_id: "1002" } })).not.toBe(conflictSubjectKey({ metadata: { user_id: "1001" } }));
  });

  test("문자열이 아닌 user_id 도 소유자와 섞지 않는다", () => {
    expect(conflictSubjectKey({ metadata: { user_id: 1001 } })).toBe("user:1001");
    expect(conflictSubjectKey({ metadata: { user_id: null } })).toBe(OWNER_CONFLICT_SUBJECT);
  });
});

// WP-B1-09R — 충돌 상한 이상 쌍의 경계: 같은 작성 AI 는 중복 흡수 몫, 다른 작성 AI 는 충돌 후보.
describe("highSimilarityRoute", () => {
  test("같은 작성 AI 이거나 새 기억에 작성 AI 가 없으면 중복 흡수 몫이다", () => {
    expect(highSimilarityRoute("claude-code", "claude-code")).toBe("duplicate");
    expect(highSimilarityRoute("", "claude-code")).toBe("duplicate");
  });

  test("작성 AI 가 다르면 충돌 후보 몫이다", () => {
    expect(highSimilarityRoute("codex", "claude-code")).toBe("conflict");
    expect(highSimilarityRoute("codex", "")).toBe("conflict");
  });
});

describe("isConflictPair", () => {
  const pair = (similarity: number, newAuthor: string, existingAuthor: string,
    newContent = "답변은 영어로 해 주세요", existingContent = "답변은 한국어로 해 주세요") => isConflictPair({
    similarity, simLow: CONFLICT_SIM_LOW, simHigh: CONFLICT_SIM_HIGH,
    newAuthor, newContent, existingAuthor, existingContent,
  });

  test("충돌 하한 미만은 작성 AI 와 무관하게 후보가 아니다", () => {
    expect(pair(CONFLICT_SIM_LOW - 0.001, "codex", "claude-code")).toBe(false);
  });

  test("중간 구간은 작성 AI 와 무관하게 후보다", () => {
    expect(pair(CONFLICT_SIM_LOW, "claude-code", "claude-code")).toBe(true);
    expect(pair(CONFLICT_SIM_HIGH - 0.001, "codex", "claude-code")).toBe(true);
  });

  test("충돌 상한 이상은 작성 AI 가 다를 때만 후보다", () => {
    expect(pair(CONFLICT_SIM_HIGH, "codex", "claude-code")).toBe(true);
    expect(pair(0.99, "codex", "claude-code")).toBe(true);
    expect(pair(CONFLICT_SIM_HIGH, "claude-code", "claude-code")).toBe(false);
    expect(pair(0.99, "", "claude-code")).toBe(false);
  });

  test("정규화(NFC + 앞뒤 공백) 후 같은 본문은 작성 AI 가 달라도 후보가 아니다", () => {
    const text = "답변은 한국어로 해 주세요";
    expect(pair(1, "codex", "claude-code", `  ${text.normalize("NFD")}
`, text)).toBe(false);
    // 내부 공백은 정규화하지 않는다(contentHash 규칙) — 다른 본문이다.
    expect(pair(0.99, "codex", "claude-code", "답변은  한국어로 해 주세요", text)).toBe(true);
  });
});
