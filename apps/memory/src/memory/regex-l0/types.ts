/**
 * regex L0 (Level 0) 추출 가족이 공유하는 타입.
 *
 * Level 0 = 메시지 도착 시점에 LLM 대화 호출 없이 정규식 양식 매치 + booster
 * 점수 합산으로 1차 후보를 추출하는 단계 (graceful degradation 기본 동작).
 * Phase 6 spec 단락 2 (양식) · 단락 3 (booster) · 단락 4 (점수 → 저장) 정합.
 *
 * 이 파일은 타입만 정의한다. 한국어 builtin 양식·booster 상수는
 * builtin-patterns.ts / builtin-boosters.ts 가 보유하고, yaml 로더·매치·점수
 * 합산·저장 결정은 후속 task 가 이 타입을 사용해 작성한다.
 *
 * `Polarity` 는 기존 도메인 타입을 재사용한다 (../types.ts:24 — knowledge_nodes
 * .polarity 칸 값). 새 정의를 만들지 않는다.
 */

import type { Polarity } from "../types.ts";

export type { Polarity };

/**
 * regex 양식 분류 — Phase 6 spec 단락 2 양식 갈래 5 + 기술 옵션.
 * decision(+3) / preference(+2) / constraint(+2) / status(+1) / fact(+1~2)
 * / technical(+2).
 */
export type RegexCategory =
  | "decision"
  | "preference"
  | "constraint"
  | "status"
  | "fact"
  | "technical";

/**
 * 정규식 양식 정의 한 항목.
 *
 * `pattern` 은 원본 정규식 문자열 (yaml / DB 저장 형태), `regex` 는 그 문자열을
 * 컴파일한 RegExp. builtin 상수는 두 칸을 같이 보유한다. yaml 로더는 `pattern`
 * 문자열을 읽어 `regex` 를 컴파일한다.
 */
export interface RegexPatternDef {
  /** 양식 식별자 (예: "decision_ko_001"). */
  id: string;
  /** 원본 정규식 문자열. */
  pattern: string;
  /** 컴파일된 RegExp. */
  regex: RegExp;
  /** 양식 1차 점수 (+1 ~ +3). */
  score: number;
  /** 양식 분류. */
  category: RegexCategory;
  /** 감정 극성 라벨 (단락 5 정합). 없으면 default 추론. */
  polarity?: Polarity;
  /** 사람이 읽는 양식 설명. */
  description?: string;
  /** 양식이 매치하는 예시 입력 (fixture 검증·자가 검증에 사용). */
  exampleInput?: string;
  /** 예시 입력에서 추출되는 내용 (자가 검증 표시용). */
  exampleExtracted?: string;
  /** 양식 언어 ('ko' / 'en' / 'ja' 등). */
  lang: string;
  /** 가동 여부. false 면 매치 단계에서 제외한다. */
  enabled: boolean;
}

/**
 * booster 사전 한 항목 — 입력 안 단어 검출 시 점수에 합산 (단락 3).
 * 검출은 단순 부분 문자열 검색 (indexOf), 정규식 아님.
 */
export interface BoosterDef {
  /** 검출 대상 단어 / 어구. */
  word: string;
  /** 합산 점수 (+3 / +2 / -2 / -1 가족). */
  score: number;
  /** 사람이 읽는 booster 설명. */
  description?: string;
  /** booster 언어 ('ko' / 'en' 등). */
  lang: string;
  /** 가동 여부. */
  enabled: boolean;
}

/**
 * 한 입력에 대한 양식 매치 결과 한 항목 — 매치·점수 합산 task 가 형성한다.
 */
export interface RegexMatch {
  /** 매치한 양식의 id. */
  patternId: string;
  /** 양식 분류. */
  category: RegexCategory;
  /** 양식 점수 + booster 합산을 거친 최종 점수. */
  score: number;
  /** 감정 극성 (양식 명시 또는 default 추론 결과). */
  polarity: Polarity;
  /** 추출된 내용 (첫 캡처 그룹 trim). */
  extractedContent: string;
  /** 정규식이 매치한 원문 텍스트 (m[0]). */
  matchText: string;
  /** 매치한 양식의 언어. */
  lang: string;
}
