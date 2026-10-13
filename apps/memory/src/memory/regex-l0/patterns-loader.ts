/**
 * patterns-loader.ts — regex-patterns.yaml 로더 + builtin 합집합 (Phase 6a T2).
 *
 * regex-patterns.yaml 가족을 읽어 RegexPatternDef[] 로 변환하고 builtin 코드
 * 상수(BUILTIN_PATTERNS)와 합집합한다. search-cues-loader.ts 의 ENOENT/parse/
 * 형식 구분 구조를 그대로 따른다:
 *   - 파일 *없음*(ENOENT) → builtin 만 가동(graceful Level 0 / 에러 아님).
 *   - 파일 *있는데 형식 어긋남* → 구체 에러 throw(silent fallback 금지).
 *
 * 합집합 규칙: builtin 을 Map<id> 으로 깔고, yaml 항목으로 같은 id 를 덮어쓴다
 * (사용자 갱신 우선). 그 뒤 enabled:false 를 걸러낸다 — yaml 이 builtin id 를
 * enabled:false 로 덮으면 그 builtin 도 빠진다.
 *
 * yaml 정규식은 `\\s*` 식 더블 백슬래시로 적혀 있고 parse 후 `\s*` 단일로
 * 환원된다. 그 환원된 문자열을 new RegExp 로 컴파일한다(컴파일 실패 = 구체 에러).
 */
import { BUILTIN_PATTERNS } from "./builtin-patterns.ts";
import type { RegexCategory, RegexPatternDef, Polarity } from "./types.ts";
import { readYamlMapping } from "../yaml-mapping.ts";

/** 허용 분류 집합 — yaml 값 검증용. */
const CATEGORIES: ReadonlySet<string> = new Set<RegexCategory>([
  "decision",
  "preference",
  "constraint",
  "status",
  "fact",
  "technical",
]);

/** 허용 극성 집합 — yaml 값 검증용. */
const POLARITIES: ReadonlySet<string> = new Set<Polarity>([
  "positive",
  "negative",
  "neutral",
]);

/** RegExp 컴파일에 쓰는 flag — builtin(builtin-patterns.ts def())과 일관성. */
const REGEX_FLAGS = "i";

/**
 * 한 yaml 항목(매핑)을 RegexPatternDef 로 변환한다. 필수 칸 누락·타입 어긋남·
 * 정규식 컴파일 실패는 어느 id·어느 문자열인지 명시한 구체 에러로 알린다.
 */
function toPatternDef(item: unknown, index: number, path: string): RegexPatternDef {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new Error(`regex-patterns: patterns[${index}] 항목이 매핑이 아님 (${path})`);
  }
  const o = item as Record<string, unknown>;
  const id = o.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`regex-patterns: patterns[${index}] 'id' 칸 누락/형식 어긋남 (${path})`);
  }

  const pattern = o.pattern;
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error(`regex-patterns: id "${id}" 'pattern' 칸 누락/형식 어긋남 (${path})`);
  }

  const score = o.score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new Error(`regex-patterns: id "${id}" 'score' 칸이 숫자가 아님 (${path})`);
  }

  const category = o.category;
  if (typeof category !== "string" || !CATEGORIES.has(category)) {
    throw new Error(`regex-patterns: id "${id}" 'category' 칸 값 어긋남 "${String(category)}" (${path})`);
  }

  let polarity: Polarity | undefined;
  if (o.polarity !== undefined && o.polarity !== null) {
    if (typeof o.polarity !== "string" || !POLARITIES.has(o.polarity)) {
      throw new Error(`regex-patterns: id "${id}" 'polarity' 칸 값 어긋남 "${String(o.polarity)}" (${path})`);
    }
    polarity = o.polarity as Polarity;
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, REGEX_FLAGS);
  } catch (e) {
    throw new Error(
      `regex-patterns: id "${id}" 정규식 컴파일 실패 "${pattern}" (${path}): ${(e as Error).message}`,
    );
  }

  const lang = typeof o.lang === "string" && o.lang.length > 0 ? o.lang : "ko";
  const enabled = o.enabled === undefined ? true : o.enabled === true;

  return {
    id,
    pattern,
    regex,
    score,
    category: category as RegexCategory,
    polarity,
    description: typeof o.description === "string" ? o.description : undefined,
    // yaml 은 snake_case(example_input), 타입은 camelCase(exampleInput).
    exampleInput: typeof o.example_input === "string" ? o.example_input : undefined,
    exampleExtracted: typeof o.example_extracted === "string" ? o.example_extracted : undefined,
    lang,
    enabled,
  };
}

/**
 * yaml 파일 한 장을 읽어 RegexPatternDef[] 로 변환한다. 파일 없음(ENOENT)은
 * 빈 목록(builtin 만 가동 — 자연 degrade)으로 돌려준다. 그 외 읽기 실패·yaml
 * 파싱 실패·형식 어긋남은 구체 에러로 throw 한다.
 */
function loadOneFile(path: string): RegexPatternDef[] {
  // 파일 없음·빈 파일 = 추가 양식 0(builtin 만 가동). 형식 어긋남은 구체 에러.
  const result = readYamlMapping(path, "regex-patterns");
  if (result.kind === "missing") return [];

  const patterns = (result.value as { patterns?: unknown }).patterns;
  // patterns 칸 없음 = 추가 양식 0 (version/lang 만 적힌 파일).
  if (patterns === undefined || patterns === null) return [];
  if (!Array.isArray(patterns)) {
    throw new Error(`regex-patterns: 'patterns' 값이 목록이 아님 (${path})`);
  }

  return patterns.map((item, i) => toPatternDef(item, i, path));
}

/**
 * 주어진 yaml 경로 가족을 읽어 builtin + yaml 합집합을 돌려준다.
 *
 * builtin 을 id Map 으로 깔고, 경로 순서대로 yaml 항목이 같은 id 를 덮어쓴다
 * (뒤 경로가 앞 경로를 덮음 — 사용자 갱신 우선). 마지막에 enabled:false 를
 * 걸러낸다. 파일 없음은 builtin 만 반환(graceful Level 0), 형식 어긋남은
 * 구체 에러 throw.
 *
 * @param paths regex-patterns.yaml 경로 가족(빈 배열이면 builtin 만).
 */
export function loadPatterns(paths: string[]): RegexPatternDef[] {
  const byId = new Map<string, RegexPatternDef>();
  for (const b of BUILTIN_PATTERNS) byId.set(b.id, b);

  for (const path of paths) {
    for (const def of loadOneFile(path)) byId.set(def.id, def);
  }

  return [...byId.values()].filter((p) => p.enabled);
}
