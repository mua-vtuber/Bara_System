// ── FTS5 query sanitization ─────────────────────────────────────────────
//
// FTS5 has its own mini-grammar (quotes, parens, AND/OR/NOT, prefix `*`,
// column filters with `:`, etc.). Passing arbitrary user text produces
// "fts5: syntax error" — and worse, a stray `*` opens a prefix match that
// can blow up the result set.
//
// Strategy chosen here:
//   1. Strip every non-letter / non-digit character (Unicode-aware), so
//      only safe tokens survive — no operator metacharacters can leak in.
//   2. Append `*` to every token (FTS5 prefix match) and OR-join.
//
// Prefix matching is essential for Korean because the bundled `unicode61`
// tokenizer cannot split particles ("커피를" stays one token, so a bare
// "커피" query misses it). Morpheme-aware tokenization (mecab-ko) is
// deferred per architecture.md, so prefix is the right Phase 1 trade-off:
// higher recall for daily memory search, with the precision cost paid
// later by the retriever's vector / graph re-ranking.
//
// OR semantics (any token matches) match the old Python behavior — the
// right default for "find anything related to this content," which is
// what ConflictChecker and the upcoming retriever both need. If we ever
// want AND-strict matching, the join character can change without
// breaking callers.

const FTS_UNSAFE = /[^\p{L}\p{N}\s]/gu;

export function sanitizeFtsQuery(raw: string): string {
  const cleaned = raw.replace(FTS_UNSAFE, " ");
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `${t}*`).join(" OR ");
}

// ── trigram 보조 색인 전용 정리 (1.1a) ──────────────────────────────────────
//
// trigram 토크나이저는 연속 3 코드포인트(3-gram)만 색인한다. 그래서 위
// unicode61 본색인과 정리 규칙이 다르다:
//   (가) prefix `*` 가 무효 — trigram 에서 `'커피*'` 는 0건(격리 검증 확정).
//   (나) 2글자 이하 토큰은 trigram 에서 0건이므로 보낼 이유가 없다.
// 따라서 3 코드포인트 이상 토큰만 prefix 없이 OR-join 한다. 3글자 이상 토큰이
// 하나도 없으면 빈 문자열을 돌려준다 — searchByFts 가 이 경우 trigram 조회를
// 건너뛴다(전부 2글자 검색어 = trigram 후보 0개 자연 degrade).
export function sanitizeTrigramQuery(raw: string): string {
  const cleaned = raw.replace(FTS_UNSAFE, " ");
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => Array.from(t).length >= 3); // 코드포인트 3개 이상만
  if (tokens.length === 0) return "";
  return tokens.join(" OR "); // prefix `*` 미사용 — trigram 에 무효
}
