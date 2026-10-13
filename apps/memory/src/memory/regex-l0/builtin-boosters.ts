/**
 * 한국어 builtin importance booster 사전 — Phase 6 spec 단락 3.2.
 *
 * 이 상수는 가짜 데이터가 아니라 regex L0 점수 합산의 실제 default 사전이다.
 * 사용자 입력 안에서 booster 단어를 단순 부분 문자열 검색(indexOf)으로 검출해
 * 양식 점수에 합산한다(정규식 아님 — spec 3.4). 같은 내용을
 * booster-dictionary.yaml 이 사용자 갱신 진입점으로 보유한다.
 *
 * 점수 가족: 강한 결정 신호 +3 / 강한 의지 표현 +2 / 약한 부정 신호 -2 /
 * 잡담 신호 -1.
 */

import type { BoosterDef } from "./types.ts";

/** booster 한 줄을 lang/enabled default 와 함께 형성하는 helper. */
function boost(
  word: string,
  score: number,
  description: string,
): BoosterDef {
  return { word, score, description, lang: "ko", enabled: true };
}

/**
 * 한국어 builtin booster 목록 (31개).
 * +3 결정 신호 11 / +2 의지 표현 8 / -2 부정 신호 6 / -1 잡담 신호 6.
 */
export const BUILTIN_BOOSTERS: readonly BoosterDef[] = [
  // ── 강한 결정 신호 (+3) ──────────────────────────────────────────
  boost("앞으로", 3, "선언적 결정 / 지속 의지"),
  boost("계속", 3, "지속 의지"),
  boost("항상", 3, "원칙 강조"),
  boost("기본값", 3, "default 결정"),
  boost("원칙", 3, "사용자 원칙 신호"),
  boost("정했다", 3, "결정 명시"),
  boost("하기로 했다", 3, "결정 명시"),
  boost("확정", 3, "결정 동결"),
  boost("유지", 3, "현 결정 보존"),
  boost("동결", 3, "변경 차단"),
  boost("확립", 3, "원칙 정착"),

  // ── 강한 의지 표현 (+2) ──────────────────────────────────────────
  boost("선호", 2, "선호 명시"),
  boost("좋아", 2, "선호 신호"),
  boost("마음에 들어", 2, "선호 신호"),
  boost("해야", 2, "제약 신호"),
  boost("필수", 2, "제약 강조"),
  boost("금지", 2, "제약 강조"),
  boost("절대", 2, "강조"),
  boost("반드시", 2, "강조"),

  // ── 약한 부정 신호 (-2) ──────────────────────────────────────────
  boost("임시", -2, "임시 자산 / 자산 저장 가치 ↓"),
  boost("나중에", -2, "지연 신호"),
  boost("잠깐", -2, "짧은 시점 한정"),
  boost("일회성", -2, "1회 한정"),
  boost("가정", -2, "가정 신호"),
  boost("만약", -2, "조건 신호"),

  // ── 잡담 신호 (-1) ───────────────────────────────────────────────
  boost("ㅋㅋ", -1, "잡담 신호"),
  boost("ㅎㅎ", -1, "잡담 신호"),
  boost("잡담", -1, "잡담 명시"),
  boost("농담", -1, "농담 명시"),
  boost("추임새", -1, "추임새 명시"),
  boost("그냥", -1, "약한 의지 신호"),
];
