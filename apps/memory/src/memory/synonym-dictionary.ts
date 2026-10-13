/**
 * synonym-dictionary.ts — 한국어 동의어 사전 로더 (D9).
 *
 * BM25/FTS5 채널 한정 query expansion용. 임베딩 채널은 bge-m3 cosine이
 * 자연 합류하므로 사전 expansion 합류 X (공통 인프라 spec 단락 13.3).
 *
 * ⚠️ 1.0a 소비자 없음 — 실제 query expansion wiring은 Wave 1.1 검색 통합.
 * 이 모듈은 로더 + 조회 헬퍼까지. 자유 추가 통로(대시보드)는 후속.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type SynonymDictionary = Map<string, string[]>;

/**
 * yaml 파일에서 동의어 사전을 로드한다. 파일 없음/파싱 실패/형식 불일치는
 * 구체 에러 throw — silent fallback 금지. 빈 사전을 돌려주지 않는다.
 */
export function loadSynonymDictionary(path: string): SynonymDictionary {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`synonym_dictionary: 파일을 읽지 못함 (${path}): ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (e) {
    throw new Error(`synonym_dictionary: yaml 파싱 실패 (${path}): ${(e as Error).message}`);
  }

  const synonyms = (parsed as { synonyms?: unknown } | null)?.synonyms;
  if (!synonyms || typeof synonyms !== "object" || Array.isArray(synonyms)) {
    throw new Error(`synonym_dictionary: 'synonyms' 매핑이 없음 (${path})`);
  }

  const dict: SynonymDictionary = new Map();
  for (const [term, list] of Object.entries(synonyms as Record<string, unknown>)) {
    if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) {
      throw new Error(`synonym_dictionary: '${term}' 값이 문자열 배열이 아님 (${path})`);
    }
    dict.set(term, list as string[]);
  }
  return dict;
}

/**
 * term을 동의어로 확장한다. 매치가 있으면 [term, ...동의어들](중복 제거),
 * 없으면 [term] 그대로. 검색 측(1.1)이 BM25 query 조립에 사용 예정.
 */
export function expandTerm(dict: SynonymDictionary, term: string): string[] {
  const syns = dict.get(term);
  if (!syns || syns.length === 0) return [term];
  return [...new Set([term, ...syns])];
}
