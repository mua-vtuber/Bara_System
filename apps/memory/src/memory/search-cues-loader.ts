/**
 * memory/search-cues-loader.ts — search-cues.yaml 로더 (공통 인프라 1.1c T2 / spec 5.3.3).
 *
 * cue 어휘 자유 추가 통로(search-cues.yaml)를 읽어 SearchCues 로 변환한다.
 * synonym-dictionary.ts 의 loadSynonymDictionary 선례를 따른다:
 *   - 파일 *없음* → builtin 만 가동(빈 추가 어휘 SearchCues 반환 / 에러 아님 —
 *     자연 degrade. builtin 정규식은 코드 상수라 항상 가동 / graceful Level 0).
 *   - 파일 *있는데 형식 어긋남* → 구체 에러 throw(silent fallback 금지).
 *
 * 파일 없음과 형식 어긋남을 명확히 구분한다 — 없음은 정상 운영(추가 어휘 0),
 * 형식 어긋남은 사용자 입력 실수라 가려선 안 된다.
 */
import type { SearchCues } from "./search-cues.ts";
import { readYamlMapping } from "./yaml-mapping.ts";

/** 추가 어휘 0 — 파일 없을 때 돌려주는 자연 degrade 값(builtin 만 가동). */
const EMPTY_CUES: SearchCues = { relation: [], topic: [] };

/**
 * 정규식 문자열 목록을 RegExp 배열로 컴파일한다. 목록이 아니거나 문자열이 아닌
 * 항목·컴파일 실패는 구체 에러 throw(어느 칸·어느 패턴인지 명시).
 */
function compilePatterns(value: unknown, kind: string, path: string): RegExp[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`search-cues: '${kind}' 값이 목록이 아님 (${path})`);
  }
  const out: RegExp[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`search-cues: '${kind}' 항목이 문자열이 아님 (${path})`);
    }
    try {
      out.push(new RegExp(item));
    } catch (e) {
      throw new Error(
        `search-cues: '${kind}' 정규식 컴파일 실패 "${item}" (${path}): ${(e as Error).message}`,
      );
    }
  }
  return out;
}

/**
 * search-cues.yaml 을 읽어 추가 cue 어휘를 돌려준다. 파일이 없으면 builtin 만
 * 가동하는 빈 SearchCues 를 돌려준다(자연 degrade). 형식이 어긋나면 구체 에러.
 *
 * @param path search-cues.yaml 경로.
 */
export function loadSearchCues(path: string): SearchCues {
  // 파일 없음·빈 파일은 builtin 만 가동(graceful Level 0). 형식 어긋남은 구체 에러.
  const result = readYamlMapping(path, "search-cues");
  if (result.kind === "missing") return EMPTY_CUES;

  const obj = result.value as { relation?: unknown; topic?: unknown };
  return {
    relation: compilePatterns(obj.relation, "relation", path),
    topic: compilePatterns(obj.topic, "topic", path),
  };
}
