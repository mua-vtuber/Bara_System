/**
 * regex L0 최종 점수 → 처리 결정 + atomic 저장 metadata 빌더 — Phase 6 spec
 * 단락 4.1 (점수 → 처리 임계) · 단락 4.2 (저장 metadata 양식).
 *
 * 순수 함수 가족 (DB / 네트워크 / 임베딩 의존 0). 매치·점수 합산을 마친 RegexMatch
 * 한 항목을 받아 (1) 처리 갈래를 정하고 (2) knowledge_nodes.metadata 객체를 빌드한다.
 * 실제 INSERT 는 후속 task (extractor 통합) 의 책임이다.
 */

import type { Polarity, RegexCategory, RegexMatch } from "./types.ts";

/** 최종 점수가 정하는 처리 갈래 (spec 4.1). */
export type ScoreDecision = "auto_store" | "pending_review" | "ignore";

/** atomic 저장 시점 metadata 객체 양식 (spec 4.2). */
export interface RegexMetadata {
  /** 출처 표식 — 항상 "regex" (spec 4.2). */
  source: "regex";
  /** 매치 양식 분류. */
  regex_category: RegexCategory;
  /** 매치한 양식의 id. */
  regex_pattern_id: string;
  /** 양식 점수 + booster 합산을 거친 최종 점수. */
  regex_score: number;
  /** 검출된 booster 단어 목록. */
  boosters_hit: string[];
  /** 정규식이 매치한 원문 텍스트. */
  pattern_match_text: string;
  /** 추출된 내용. */
  extracted_content: string;
  /** 감정 극성 — metadata 안 audit 신호 (top-level polarity 칸과 같은 값). */
  regex_polarity: Polarity;
  /** 양식 언어. */
  lang: string;
  /** auto_store → true / pending_review → false (spec 4.1 출처 metadata). */
  auto_stored: boolean;
  /** pending_review 갈래에만 추가되는 칸 (spec 4.1). */
  pending_review?: true;
}

/**
 * 최종 점수를 처리 갈래로 변환한다 (spec 4.1 점수 → 처리 표 + 양식 정밀화 spec §5.4
 * auto_store 승격 게이트).
 *
 * 규칙:
 *   - finalScore ≥ 5 && patternBaseScore ≥ 3 → auto_store
 *   - finalScore ≥ 5 && patternBaseScore < 3 → pending_review (booster 만으로 auto_store 금지)
 *   - finalScore ≥ 3 → pending_review
 *   - 그 외 → ignore
 *
 * auto_store(자동 저장·검색 노출) 도달은 패턴 base 점수가 3 이상일 때만 허용한다.
 * base 가 3 미만인 양식(선호 +2 / 제약 +2 / 상태 +1 / 일부 사실 +1)은 booster 점수가
 * 아무리 붙어 finalScore 가 5 이상이 되어도 auto_store 로 올라가지 못하고 최대
 * pending_review(검토 대기)에 머문다. 같은 단어가 패턴 점수와 booster 점수에 두 번
 * 들어가 긴 false positive 문장이 자동 저장까지 오르던 이중 계산을 구조로 차단한다.
 *
 * @param finalScore 양식 점수 + booster 합산을 거친 최종 점수.
 * @param patternBaseScore booster 합산 전 양식 자체 점수(이중 계산 차단 게이트).
 * @returns 처리 갈래.
 */
export function decideByScore(
  finalScore: number,
  patternBaseScore: number,
): ScoreDecision {
  if (finalScore >= 5) {
    return patternBaseScore >= 3 ? "auto_store" : "pending_review";
  }
  if (finalScore >= 3) return "pending_review";
  return "ignore";
}

/**
 * 최종 점수를 importance (0~1) 로 정규화한다 — clamp(score / 10, 0, 1).
 *
 * 실행 중 검색 노이즈 측정으로 조정 가능 — LLM extractor importance(0.3~0.8 분포)와 척도 비교.
 *
 * @param finalScore 최종 점수.
 * @returns 0 이상 1 이하 importance 값.
 */
export function scoreToImportance(finalScore: number): number {
  const v = finalScore / 10;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * 처리 결정에 맞춘 atomic 저장 metadata 객체를 빌드한다 (spec 4.2 양식).
 *
 * `auto_store` → `auto_stored: true`. `pending_review` → `auto_stored: false`
 * + `pending_review: true`. `ignore` 는 atomic 노드를 형성하지 않으므로 (spec 4.1
 * ≤2 = atomic 노드 형성 X) metadata 를 빌드하면 호출 흐름 오류 — loud throw.
 *
 * @param match 매치·점수 합산을 마친 RegexMatch 한 항목.
 * @param boostersHit 검출된 booster 단어 목록.
 * @param decision decideByScore 가 반환한 처리 갈래.
 * @returns spec 4.2 양식 metadata 객체.
 */
export function buildRegexMetadata(
  match: RegexMatch,
  boostersHit: string[],
  decision: ScoreDecision,
): RegexMetadata {
  if (decision === "ignore") {
    throw new Error(
      `buildRegexMetadata: 'ignore' 결정으로는 atomic metadata 를 빌드할 수 없다 (spec 4.1 ≤2 = atomic 노드 형성 X). pattern_id=${match.patternId}`,
    );
  }

  const base: RegexMetadata = {
    source: "regex",
    regex_category: match.category,
    regex_pattern_id: match.patternId,
    regex_score: match.score,
    boosters_hit: boostersHit,
    pattern_match_text: match.matchText,
    extracted_content: match.extractedContent,
    regex_polarity: match.polarity,
    lang: match.lang,
    auto_stored: decision === "auto_store",
  };

  if (decision === "pending_review") {
    base.pending_review = true;
  }

  return base;
}
