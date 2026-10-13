/**
 * query-expansion.ts — 검색어 동의어 확장(공통 인프라 1.1b T2 / D9).
 *
 * BM25/FTS5 채널 한정. retriever 가 searchByFts·searchConceptsByFts 입력 query
 * 에만 이 확장을 적용하고, 임베딩 채널(searchByVectorRaw·searchConceptsByVector)
 * 입력 query 는 *원본 그대로* 둔다(spec 13.3). 임베딩은 bge-m3 cosine 이 의미
 * 매치를 자연 처리하므로, 동의어를 임베딩 query 에도 합류시키면 같은 신호를 두 번
 * 세는 중복 가중 회귀가 된다.
 *
 * 순수 함수 — DB·임베딩 의존 0. 사전이 비거나 매치가 0이면 원본 query 를 그대로
 * 돌려준다(자연 degrade — 동작 불변이지 silent fallback 아님). 사전 파일 없음/형식
 * 어긋남은 loadSynonymDictionary 가 이미 구체 에러를 던진다(synonym-dictionary.ts).
 */
import type { SynonymDictionary } from "./synonym-dictionary.ts";
import { expandTerm } from "./synonym-dictionary.ts";

/**
 * query 를 공백 토큰화 → 각 토큰을 expandTerm 으로 확장 → 매치된 토큰의 동의어를
 * OR 후보로 더해 확장 query 문자열(공백 join)을 반환한다.
 *
 * - 매치 0이면 원본 query 를 그대로 반환(자연 degrade — 동작 불변).
 * - 토큰이 0개(빈/공백 query)면 원본 query 를 그대로 반환.
 * - 확장 후보는 중복 제거(같은 토큰이 두 번 들어가지 않음).
 *
 * FTS5 는 공백 분리 토큰을 암묵 OR 로 묶으므로, 동의어를 공백으로 이어 붙이면
 * 그대로 OR 확장이 된다.
 */
export function expandQueryWithSynonyms(
  query: string,
  dict: SynonymDictionary,
): string {
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return query;

  const out: string[] = [];
  let expanded = false;
  for (const token of tokens) {
    const variants = expandTerm(dict, token);
    if (variants.length > 1) expanded = true;
    out.push(...variants);
  }

  // 매치 0 = 원본 그대로(동작 불변). 매치가 있을 때만 확장 query 를 조립한다.
  return expanded ? [...new Set(out)].join(" ") : query;
}
