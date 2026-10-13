/**
 * category-synonyms.ts — Phase 11b T8.
 *
 * 이미지 분류 카테고리 키 builtin 동의어 정규화.
 * `image-categories.yaml` 한 한 읽고 process 안 cache.
 *
 * 사용 흐름:
 *   recognizeCategorySynonym('캐릭터') → 'character'
 *   recognizeCategorySynonym('character') → 'character'   (canonical 자체 통과)
 *   recognizeCategorySynonym('Character') → 'character'   (대소문자 무관)
 *   recognizeCategorySynonym('unknown_key') → 'unknown_key' (정직한 passthrough — silent X)
 *
 * LLM 호출 X / builtin yaml 한 한. LLM 통합 제안은 Phase 7 권위.
 *
 * 옛 `synonym-dictionary.ts` (D9) 양식 정합 — readFileSync + yaml.parse + 구체 에러 throw.
 * 정규화 호출 = `parsers/classification-tag.ts` T1 안 추출 직후 자연 합류.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const YAML_FILENAME = "image-categories.yaml";

/** canonical key → 동의어 한 묶음. canonical 자체는 동의어 묶음에 포함 X (자가 매핑은 빌드 단계). */
type CategorySynonymDictionary = Map<string, string[]>;

/** 동의어 (lowercase) → canonical key. recognizeCategorySynonym 안 조회 양식. */
type ReverseLookupMap = Map<string, string>;

interface CachedDictionary {
  forward: CategorySynonymDictionary;
  reverse: ReverseLookupMap;
}

let cached: CachedDictionary | null = null;

/**
 * yaml 사전을 process 안 한 번 읽고 cache.
 * 파일 없음 / 파싱 실패 / 형식 불일치는 구체 에러 throw — silent fallback 금지.
 */
function loadCategorySynonyms(): CachedDictionary {
  if (cached) return cached;

  const here = dirname(fileURLToPath(import.meta.url));
  const yamlPath = resolve(here, YAML_FILENAME);

  let raw: string;
  try {
    raw = readFileSync(yamlPath, "utf8");
  } catch (e) {
    throw new Error(
      `image-categories: yaml 파일을 읽지 못함 (${yamlPath}): ${(e as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (e) {
    throw new Error(
      `image-categories: yaml 파싱 실패 (${yamlPath}): ${(e as Error).message}`,
    );
  }

  const synonyms = (parsed as { synonyms?: unknown } | null)?.synonyms;
  if (!synonyms || typeof synonyms !== "object" || Array.isArray(synonyms)) {
    throw new Error(
      `image-categories: 'synonyms' 매핑이 없음 (${yamlPath})`,
    );
  }

  const forward: CategorySynonymDictionary = new Map();
  const reverse: ReverseLookupMap = new Map();

  for (const [canonical, list] of Object.entries(
    synonyms as Record<string, unknown>,
  )) {
    if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) {
      throw new Error(
        `image-categories: '${canonical}' 값이 문자열 배열이 아님 (${yamlPath})`,
      );
    }
    const canonicalLower = canonical.toLowerCase();
    const synonymList = list as string[];
    forward.set(canonicalLower, synonymList);

    // canonical 자체도 reverse 안 자가 매핑 — recognizeCategorySynonym('character') → 'character'
    reverse.set(canonicalLower, canonicalLower);
    for (const syn of synonymList) {
      reverse.set(syn.toLowerCase(), canonicalLower);
    }
  }

  cached = { forward, reverse };
  return cached;
}

/**
 * 사용자 입력 카테고리 키를 canonical 키로 정규화.
 *
 * - 매치 = canonical 한 한 (lowercase) 통과.
 * - 매치 X = 입력값을 *그대로* 통과 (정직한 passthrough — silent 변환 X).
 *   호출 측이 옛 입력을 그대로 저장할 자유 보존.
 *
 * 대소문자 무관 — 'Character' / 'CHARACTER' / 'character' 모두 'character' 통과.
 */
export function recognizeCategorySynonym(input: string): string {
  if (!input) return input;
  const { reverse } = loadCategorySynonyms();
  const lower = input.toLowerCase();
  const canonical = reverse.get(lower);
  return canonical ?? input;
}

/**
 * test 격리용 — cache 한 한 비운다. 운영 코드 안 호출 X.
 */
export function resetCategorySynonymCache(): void {
  cached = null;
}
