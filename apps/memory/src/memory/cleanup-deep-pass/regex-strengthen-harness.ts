/**
 * 데이터 정리 깊은 패스 — 정규식 강화 기계 시험 하네스 (순수 함수).
 *
 * 강한 LLM 이 낸 한국어 정규식 제안 하나를, 사람에게 보여주기 전에 결정적으로
 * 거르는 5겹 시험. 품질 보증은 LLM 이 아니라 이 결정적 기계 시험이다.
 * DB·LLM·네트워크 의존 없음 — 입력을 받아 accept/reject 와 사유를 회신한다.
 * spec §5 (5겹 시험) 정합.
 *
 * 순서는 싼 검사 먼저: 유효성 → 컴파일 → 자기예문 → 중복 → 과매치.
 */

import type { RegexCategory, Polarity } from "../regex-l0/types.ts";

/**
 * 컴파일·과매치 시험 시 사용하는 정규식 플래그 — patterns-loader / user-repo 와 일관. "u" 가
 * 없으므로 \p{...} 같은 유니코드 속성 표기는 쓸 수 없다. 지시문(buildRegexStrengthenInstruction)이
 * 이 값을 읽어 정규식 종류를 알려 준다(단일 출처).
 */
export const REGEX_FLAGS = "i";

/**
 * 유효 양식 분류 — RegexCategory 6-enum 과 일치. 지시문(regex-strengthen-cycle.ts
 * buildRegexStrengthenInstruction)·외부 등록 검증(cleanup-external/proposals.ts)이 이 목록을
 * 읽어 문장과 검사 기준이 어긋나지 않게 한다(단일 출처).
 */
export const REGEX_PROPOSAL_CATEGORIES: readonly RegexCategory[] = [
  "decision",
  "preference",
  "constraint",
  "status",
  "fact",
  "technical",
];
const VALID_CATEGORIES: ReadonlySet<string> = new Set(REGEX_PROPOSAL_CATEGORIES);

/** 유효 감정 극성 — Polarity 3-enum 과 일치. 지시문이 같은 목록을 읽는다(단일 출처). */
export const REGEX_PROPOSAL_POLARITIES: readonly Polarity[] = [
  "positive",
  "negative",
  "neutral",
];
const VALID_POLARITY: ReadonlySet<string> = new Set(REGEX_PROPOSAL_POLARITIES);

/** 점수 허용 범위 (정수 1~3). 지시문의 "score 는 1~3" 문장이 이 값을 읽는다. */
export const REGEX_SCORE_MIN = 1;
export const REGEX_SCORE_MAX = 3;

/** LLM 이 낸 정규식 제안 한 항목. */
export interface ProposedPattern {
  pattern: string;
  score: number;
  category: RegexCategory;
  polarity: Polarity;
  exampleInput: string;
  /**
   * LLM 이 "이 정규식이 뽑을 부분"이라 주장하는 값. 하네스는 이 값을 *검증하지
   * 않는다* — gate 2 는 첫 캡처가 비어 있지 않은지만 본다(spec §5). 이 칸은
   * 대시보드 카드 "뽑을 부분" 표시(spec §7.2)와 cleanup_proposals payload 전달용.
   */
  exampleExtracted: string;
  description: string;
  rationale?: string;
}

export interface HarnessContext {
  /** 과매치 시험용 무관 노드 본문 표본. */
  overmatchSample: string[];
  /** 과매치 매치율 임계(0~1). 초과 시 reject. */
  overmatchThreshold: number;
  /** 현재 가동 양식의 컴파일된 RegExp 목록(중복 판정). */
  currentPatterns: RegExp[];
  /**
   * 같은 사이클 안에서 이미 하네스를 통과한 제안들의 정규화 형태(spec 5.B-3, #15) —
   * currentPatterns 는 사이클 시작 시 고정이라 같은 사이클 후보끼리 중복 패턴이
   * 통과할 수 있는 구멍을 메운다. 호출자(regex-strengthen-cycle.ts)가 통과 패턴마다
   * normalizePatternForDedup 결과를 이 집합에 누적해 다음 후보 호출에 실어 보낸다.
   * 생략하거나 빈 집합이면 기존 동작과 동일(하위 호환).
   */
  cycleLocalPatterns?: ReadonlySet<string>;
  /**
   * 이 제안을 만든 놓친 글 원문. 주면 (a) exampleInput 이 이 원문에 글자 그대로 있는지,
   * (b) 정규식이 이 원문을 실제로 잡고 첫 캡처가 비어 있지 않은지 본다 — "주어진 예문을 실제로
   * 잡는 규칙만" 을 모델 말이 아니라 원문으로 확인한다. 생략하면 이 검사를 건너뛴다(원문을 모르는
   * 호출자 하위 호환).
   */
  sourceText?: string;
}

export type HarnessReason =
  | "compile"
  | "self_match"
  | "source_match"
  | "overmatch"
  | "redundant"
  | "validity";

export interface HarnessResult {
  ok: boolean;
  reason?: HarnessReason;
  /** 측정한 과매치율(통과·overmatch reject 양쪽에서 표시용). */
  overmatchRate?: number;
  detail?: string;
}

/**
 * 정규식 패턴을 사이클 내 중복 판정용 키로 정규화한다(spec 5.B-3 "공백·플래그
 * 정규화 문자열", 순수 함수). 두 가지를 정규화한다:
 *   - 공백: 연속 공백(스페이스·탭·개행 등)을 한 칸으로 접고 앞뒤를 trim — 사람이
 *     보기엔 같은 규칙인데 공백 하나 차이로 다른 문자열이 되는 경우를 하나로 묶는다.
 *   - 플래그: 하네스는 컴파일·과매치 시험을 항상 REGEX_FLAGS("i")로 고정하므로
 *     (본 모듈 상단), 제안이 어떤 플래그 문자열을 달고 와도 실제 매칭 동작은 항상
 *     "i" 기준이다. 그래서 flags 인자는 결과에 반영하지 않고 고정 플래그를 키에
 *     새겨 넣는다 — 다른 플래그 표기로 온 동일 패턴이 다른 키가 되는 걸 막는다.
 *
 * flags 는 앞으로 하네스가 플래그별로 다르게 컴파일하게 되면 그대로 반영되도록
 * 시그니처에는 남겨두되, 현재는 REGEX_FLAGS 로 고정한다(구현이 시그니처를 앞서가지
 * 않게 — 실제 동작과 정규화 키를 항상 일치시킨다).
 */
export function normalizePatternForDedup(
  pattern: string,
  _flags: string = REGEX_FLAGS,
): string {
  const normalizedBody = pattern.trim().replace(/\s+/g, " ");
  return `${REGEX_FLAGS}:${normalizedBody}`;
}

/**
 * 제안 정규식 하나를 결정적으로 시험한다. 순서: 유효성 → 컴파일 → 자기예문 →
 * 원문 매치(sourceText 를 줄 때만) → 중복(현재 양식) → 중복(사이클 로컬) → 과매치.
 * 하나라도 떨어지면 reason 과 함께 ok=false.
 */
export function testRegexProposal(
  p: ProposedPattern,
  ctx: HarnessContext,
): HarnessResult {
  // 1. 유효성 — 싼 검사 먼저.
  if (!Number.isInteger(p.score) || p.score < REGEX_SCORE_MIN || p.score > REGEX_SCORE_MAX) {
    return { ok: false, reason: "validity", detail: `score ${p.score}` };
  }
  if (!VALID_CATEGORIES.has(p.category)) {
    return { ok: false, reason: "validity", detail: `category ${p.category}` };
  }
  if (!VALID_POLARITY.has(p.polarity)) {
    return { ok: false, reason: "validity", detail: `polarity ${p.polarity}` };
  }

  // 2. 컴파일.
  let re: RegExp;
  try {
    re = new RegExp(p.pattern, REGEX_FLAGS);
  } catch (e) {
    return { ok: false, reason: "compile", detail: (e as Error).message };
  }

  // 3. 자기 예문 매치 + 첫 캡처 비어 있지 않음.
  const m = re.exec(p.exampleInput);
  if (m === null) {
    return { ok: false, reason: "self_match", detail: "예문 매치 0" };
  }
  const captured = (m[1] ?? m[0]).trim();
  if (captured.length === 0) {
    return { ok: false, reason: "self_match", detail: "첫 캡처 빈 문자열" };
  }

  // 3b. 원문 매치 — 예문이 원문에서 베낀 글인지, 정규식이 원문 자체를 잡는지.
  if (ctx.sourceText !== undefined) {
    if (!ctx.sourceText.includes(p.exampleInput)) {
      return { ok: false, reason: "source_match", detail: "예문이 원문에 글자 그대로 없음" };
    }
    const sm = new RegExp(p.pattern, REGEX_FLAGS).exec(ctx.sourceText);
    if (sm === null) {
      return { ok: false, reason: "source_match", detail: "원문 매치 0" };
    }
    if ((sm[1] ?? sm[0]).trim().length === 0) {
      return { ok: false, reason: "source_match", detail: "원문 첫 캡처 빈 문자열" };
    }
  }

  // 4. 중복 — 현재 양식 중 하나라도 예문을 이미 잡으면 안 놓친 것.
  for (const cur of ctx.currentPatterns) {
    if (cur.test(p.exampleInput)) {
      return { ok: false, reason: "redundant", detail: "현재 양식이 예문 매치" };
    }
  }

  // 4b. 중복 — 같은 사이클 안에서 이미 통과한 제안과 정규화 형태가 같으면 안 놓친 것.
  // currentPatterns 는 사이클 시작 시 고정이라 못 잡는 "같은 사이클 후보끼리 중복
  // 제안" 구멍을 메운다(spec 5.B-3, #15).
  if (ctx.cycleLocalPatterns && ctx.cycleLocalPatterns.size > 0) {
    const key = normalizePatternForDedup(p.pattern);
    if (ctx.cycleLocalPatterns.has(key)) {
      return { ok: false, reason: "redundant", detail: "사이클 내 이미 통과한 양식과 동형" };
    }
  }

  // 5. 과매치 — 무관 표본 매치율.
  const sample = ctx.overmatchSample;
  let hits = 0;
  for (const s of sample) {
    // 새 RegExp 인스턴스로 lastIndex 오염 회피(global flag 아니라 안전하나 명시).
    if (new RegExp(p.pattern, REGEX_FLAGS).test(s)) hits += 1;
  }
  const rate = sample.length === 0 ? 0 : hits / sample.length;
  if (rate > ctx.overmatchThreshold) {
    return { ok: false, reason: "overmatch", overmatchRate: rate };
  }

  return { ok: true, overmatchRate: rate };
}
