/**
 * input-estimate.ts — 결정적 입력 토큰 추정 + 토큰 인지 microbatch (spec 4.A-6).
 *
 * 유료 강모델은 입력 토큰이 지출의 주축이라, 호출 전에 프롬프트 크기를 추정해 (1) 사이클
 * 예산의 추정 입력 차원에 실어 주고(cleanup-llm-executor 의 InputEstimateHook 자리), (2)
 * 호출당 상한(budget.maxEstimatedInputTokensPerCall)을 넘는 대상은 자연 경계로 분할하거나
 * 분할 불가면 호출 없이 terminal(input_over_cap) 처리하고, (3) 후보를 고정 개수가 아니라
 * 추정 입력 토큰 합이 상한 안에 들도록 묶어(microbatch) 보낸다.
 *
 * 추정은 문자 수 기반 근사다 — 정밀 tokenizer 를 도입하지 않는다(추정 목적엔 근사로 충분,
 * 의존성 최소). 비율·오버헤드는 이 파일의 단일 출처 상수로만 관리한다(하드코딩 0). 이
 * 모듈은 전부 순수 함수 — DB·난수·시간 의존 0, 같은 입력이면 같은 결과.
 */

import type { ChatMessage } from "../../llm/types.ts";
import type { InputEstimateHook } from "./cleanup-llm-executor.ts";

// ── 추정 비율·오버헤드 (단일 출처 상수 — 맵 밖 리터럴 금지) ────────────────────

/**
 * 문자 수 → 추정 토큰 나눗셈 비율. 한국어/영어 혼합 메모에서 토큰 하나가 대략 몇 글자에
 * 대응하는지의 보수적 근사다. 값이 작을수록 토큰 추정이 커져(상한을 일찍 침) 과금을
 * 보수적으로 막는다. bge-m3·강모델 프롬프트가 한국어 위주라 영어 기준(~4)보다 촘촘하게
 * 잡는다 — 추정은 과대가 과소보다 안전(과소 추정은 조용한 상한 초과를 부른다).
 */
export const CHARS_PER_TOKEN_ESTIMATE = 2.5;

/**
 * 메시지 한 건의 고정 오버헤드(추정 토큰). role 태그·구분자 등 본문 밖 프레이밍 몫을
 * 근사한다. 여러 짧은 메시지가 실제보다 싸게 추정되는 것을 막는 하한 가산.
 */
export const PER_MESSAGE_OVERHEAD_TOKENS = 4;

// ── 텍스트·메시지 추정 ────────────────────────────────────────────────────────

/**
 * 한 텍스트의 추정 입력 토큰. 문자 수를 비율로 나눠 올림한다(부분 토큰도 한 토큰으로 셈 —
 * 과소 추정 회피). 빈 문자열은 0.
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * 메시지 묶음(system+user 등)의 추정 입력 토큰. 각 메시지 본문 추정 + 메시지당 고정
 * 오버헤드의 합. cleanup-llm-executor 의 InputEstimateHook.estimate 가 이 함수를 쓴다 —
 * 프롬프트 전체(모든 메시지)를 추정해 예산 판정에 넘긴다(spec 4.A-6 "프롬프트 전체 추정").
 */
export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTextTokens(m.content) + PER_MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

/**
 * cleanup-llm-executor 의 InputEstimateHook 실체(spec 4.A-6). T4 의 ZERO_INPUT_ESTIMATE_HOOK
 * 을 대신해 실행층 예산 판정에 실제 프롬프트 추정을 공급한다 — 이 훅을 executor 에 주입하면
 * 사이클 예산의 추정 입력 차원이 0 이 아니라 실측 근사로 채워진다(index 배선이 교체).
 */
export function createInputEstimateHook(): InputEstimateHook {
  return {
    estimate: (messages: readonly ChatMessage[]): number =>
      estimateMessagesTokens(messages),
  };
}

// ── 호출당 상한 판정 (분할/terminal 갈래) ─────────────────────────────────────

/**
 * 한 대상의 추정 입력이 호출당 상한 안에 드는지 판정한다. 상한 초과면 splittable 로
 * 자연 경계 분할 가능 여부를 함께 실어, 글루가 (a) 분할 재구성 (b) 호출 없이 terminal
 * (input_over_cap) 을 가른다(spec 4.A-6 (a)/(b)).
 */
export type PerCallInputDecision =
  | { fits: true; estimatedTokens: number }
  | { fits: false; estimatedTokens: number; splittable: boolean };

/**
 * 대상 프롬프트 추정과 자연 경계 분할 가능 여부로 호출당 상한 판정을 낸다.
 *
 * @param estimatedTokens 대상 프롬프트 전체 추정 입력 토큰.
 * @param perCallCap budget.maxEstimatedInputTokensPerCall.
 * @param splittable 이 대상 본문이 자연 경계(문단 등)로 쪼갤 수 있는지(글루가 판정해 전달).
 */
export function classifyPerCallInput(
  estimatedTokens: number,
  perCallCap: number,
  splittable: boolean,
): PerCallInputDecision {
  if (estimatedTokens <= perCallCap) {
    return { fits: true, estimatedTokens };
  }
  return { fits: false, estimatedTokens, splittable };
}

// ── 자연 경계 분할 (청크·문단) ────────────────────────────────────────────────

/**
 * 긴 본문을 자연 경계로 쪼갠다 — 우선 빈 줄(문단) 경계, 문단 하나가 여전히 maxChars 를
 * 넘으면 그 문단은 줄(개행) 단위로 더 쪼갠다. 어떤 조각도 원자적으로 maxChars 를 넘을 수
 * 있다(한 줄이 너무 길면) — 그 경우 그 조각은 그대로 둔다(더 쪼갤 자연 경계가 없음 =
 * 글루가 분할 불가로 판정해 terminal). 빈 조각은 버린다.
 *
 * @returns 조각 목록(입력 순서 보존). 경계가 없으면 [원문] 하나.
 */
export function splitTextOnNaturalBoundaries(
  text: string,
  maxChars: number,
): string[] {
  if (maxChars <= 0) return [text];
  const paragraphs = text.split(/\n\s*\n/);
  const parts: string[] = [];
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length <= maxChars) {
      parts.push(trimmed);
      continue;
    }
    // 문단이 여전히 크면 줄 단위로 더 쪼갠다(다음 자연 경계).
    for (const line of trimmed.split("\n")) {
      const lineTrimmed = line.trim();
      if (lineTrimmed.length > 0) parts.push(lineTrimmed);
    }
  }
  return parts.length > 0 ? parts : [text];
}

/**
 * 본문이 호출당 상한 안에 드는 조각들로 자연 경계 분할이 가능한지 판정한다. 분할 후
 * *모든* 조각이 상한 안에 들면 분할 가능(true) — 한 조각이라도 (자연 경계가 없어) 여전히
 * 상한을 넘으면 분할 불가(false). fixedOverheadTokens 는 본문 밖 프롬프트 프레이밍 몫
 * (system 프롬프트·양식 안내 등)으로, 조각마다 다시 붙으므로 조각 추정에 더해 판정한다.
 */
export function canSplitUnderCap(
  text: string,
  perCallCap: number,
  fixedOverheadTokens: number,
): boolean {
  const bodyBudgetTokens = perCallCap - fixedOverheadTokens;
  if (bodyBudgetTokens <= 0) return false;
  const maxBodyChars = Math.floor(bodyBudgetTokens * CHARS_PER_TOKEN_ESTIMATE);
  if (maxBodyChars <= 0) return false;
  const parts = splitTextOnNaturalBoundaries(text, maxBodyChars);
  // 조각이 하나뿐이면(경계 없음) 원문 그대로라 분할 의미 없음.
  if (parts.length <= 1) return false;
  return parts.every(
    (p) => estimateTextTokens(p) + fixedOverheadTokens <= perCallCap,
  );
}

// ── 토큰 인지 microbatch ──────────────────────────────────────────────────────

/** microbatch 구성 결과 — 상한 안에 묶인 그룹들 + 단독으로도 상한 초과인 대상. */
export interface MicrobatchResult<T> {
  /** 각 그룹: 고정 오버헤드 + 원소 추정 합이 상한 안. 입력 순서 보존. */
  batches: T[][];
  /**
   * 자기 추정 하나 + 고정 오버헤드만으로도 상한을 넘어 어떤 그룹에도 못 드는 대상.
   * 글루가 이들을 분할 시도(regex 본문 분할) 또는 terminal(input_over_cap)로 가른다.
   */
  oversized: T[];
}

/**
 * 후보를 고정 개수가 아니라 추정 입력 토큰 합이 호출당 상한 안에 들도록 묶는다(spec
 * 4.A-6 토큰 인지 microbatch). 그리디 — 입력 순서로 훑으며 현재 그룹에 넣어도 상한 안이면
 * 넣고, 넘치면 새 그룹을 연다. 원소 하나가 (고정 오버헤드 + 자기 추정) 만으로 상한을
 * 넘으면 oversized 로 뺀다(그 원소는 어떤 그룹에도 못 든다 — 글루가 별도 처리).
 *
 * @param items 묶을 후보(입력 순서 보존).
 * @param opts.fixedOverheadTokens 그룹마다 붙는 본문 밖 몫(system 프롬프트·공유 명단 등).
 * @param opts.perCallCap budget.maxEstimatedInputTokensPerCall.
 * @param opts.tokensOf 한 원소의 추정 입력 토큰(글루가 원소별 프롬프트 조각을 추정해 준다).
 * @param opts.maxItemsPerBatch 한 그룹 최대 원소 수(선택). 출력이 원소 수에 비례하는 단계가
 *   출력 한도 상한(stage-constants cleanupStageMaxItemsPerCall)을 넘지 않게 함께 건다. 없으면
 *   입력 토큰만 본다. 1 이상 정수가 아니면 던진다.
 */
export function splitIntoMicrobatches<T>(
  items: readonly T[],
  opts: {
    fixedOverheadTokens: number;
    perCallCap: number;
    tokensOf: (item: T) => number;
    maxItemsPerBatch?: number;
  },
): MicrobatchResult<T> {
  const { fixedOverheadTokens, perCallCap, tokensOf, maxItemsPerBatch } = opts;
  if (
    maxItemsPerBatch !== undefined &&
    (!Number.isInteger(maxItemsPerBatch) || maxItemsPerBatch < 1)
  ) {
    throw new Error(
      `microbatch 원소 수 상한은 1 이상 정수여야 함 (받은 값: ${maxItemsPerBatch})`,
    );
  }
  const batches: T[][] = [];
  const oversized: T[] = [];
  let current: T[] = [];
  let currentTokens = fixedOverheadTokens;

  for (const item of items) {
    const itemTokens = tokensOf(item);
    // 원소 하나 + 고정 오버헤드만으로도 상한 초과 = 어떤 그룹에도 못 든다.
    if (fixedOverheadTokens + itemTokens > perCallCap) {
      oversized.push(item);
      continue;
    }
    // 현재 그룹에 더하면 입력 상한을 넘거나 원소 수 상한에 닿았으면 그룹을 닫고 새로 연다.
    const full =
      maxItemsPerBatch !== undefined && current.length >= maxItemsPerBatch;
    if (current.length > 0 && (full || currentTokens + itemTokens > perCallCap)) {
      batches.push(current);
      current = [];
      currentTokens = fixedOverheadTokens;
    }
    current.push(item);
    currentTokens += itemTokens;
  }
  if (current.length > 0) batches.push(current);
  return { batches, oversized };
}
