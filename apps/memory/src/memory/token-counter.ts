/**
 * CJK-aware token estimation without external tokenizer dependencies.
 *
 * Provides a lightweight heuristic for estimating token counts across mixed
 * CJK/Latin text, tuned for Ollama models (roughly BPE-style tokenization).
 *
 * Port of backend/app/services/memory/token_counter.py.
 */

/**
 * CJK Unicode ranges (Unified Ideographs + common extensions).
 *
 * Identical to the source module's `_CJK_RE` pattern. The `g` flag enables
 * `.match()` to return all occurrences (parity with Python `findall`).
 * The `u` flag enables proper Unicode interpretation of the escape ranges.
 */
const CJK_RE =
  /[⺀-⻿　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿가-힯]/gu;

/** Average tokens per CJK character (~2 for BPE tokenizers). */
const CJK_TOKENS_PER_CHAR = 2.0;

/** Average tokens per Latin word (~0.75 due to common word merges). */
const LATIN_TOKENS_PER_WORD = 0.75;

/**
 * Estimate the token count for mixed CJK/Latin text.
 *
 * Fast heuristic — not exact, but close enough for budget allocation
 * without requiring tiktoken or sentencepiece.
 *
 * @param text Input text (may contain CJK, Latin, or mixed content).
 * @returns Estimated token count (always >= 0; >= 1 if non-empty).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Use a fresh regex execution by matching with the global flag.
  const cjkMatches = text.match(CJK_RE);
  const cjkChars = cjkMatches ? cjkMatches.length : 0;

  const nonCjk = text.replace(CJK_RE, "");
  // Python str.split() (no args) splits on whitespace and discards empties.
  // JS split returns empty strings at boundaries, so we filter them.
  const latinWords = nonCjk
    .split(/\s+/)
    .filter((w) => w.length > 0).length;

  const tokens =
    cjkChars * CJK_TOKENS_PER_CHAR + latinWords * LATIN_TOKENS_PER_WORD;

  // Python: max(1, int(tokens + 0.5)) -- round half up, but never below 1
  // for non-empty input (since cjkChars+latinWords would be at least 1).
  return Math.max(1, Math.round(tokens));
}

/**
 * Truncate text to fit within a token budget.
 *
 * Uses binary search to find the longest prefix that fits. The cost is
 * O(log n) * O(tokenize) per call, which is acceptable for our scale
 * (memory snippets, not entire books).
 *
 * @param text Input text.
 * @param budget Maximum number of tokens allowed.
 * @returns Truncated text (or original if it already fits).
 */
export function truncateToBudget(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (estimateTokens(text) <= budget) return text;

  let low = 0;
  let high = text.length;
  let result = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (estimateTokens(candidate) <= budget) {
      result = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}
