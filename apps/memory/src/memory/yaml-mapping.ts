/**
 * yaml-mapping.ts — yaml 설정 파일 로더 공통 머리부 (M-7 후속 정리).
 *
 * search-cues-loader.ts / regex-l0/patterns-loader.ts 가 똑같이 반복하던
 * "파일 읽기 → yaml parse → 최상위가 매핑인지 확인" 머리부를 한 함수로 모은다.
 * 두 로더는 다음 형식을 공유한다:
 *   - 파일 *없음*(ENOENT) → 자연 degrade(builtin 만 가동 / 에러 아님).
 *   - 빈 파일(null/undefined) → 자연 degrade.
 *   - 파일 *있는데* 읽기 실패(권한 등)·yaml 파싱 실패·최상위가 매핑이 아님
 *     → 구체 에러 throw(silent fallback 금지).
 *
 * 에러 메시지 접두어(label)와 자연 degrade 판정은 호출 측이 결정한다 —
 * 접두어가 로더마다 다르고("search-cues" / "regex-patterns"), degrade 값도
 * 다르기 때문이다. 그래서 이 함수는 "매핑을 돌려주거나, 비어 있음을 알린다" 만
 * 책임지고, 비어 있을 때 무엇을 돌려줄지는 호출 측이 정한다.
 *
 * synonym-dictionary.ts 는 의도적으로 합치지 않았다: 거기서는 파일 없음도
 * 구체 에러로 throw 하고(자연 degrade 아님), 최상위 매핑 확인 대신 중첩 칸
 * (synonyms)을 바로 검사한다 — 형식이 달라 억지로 합치면 메시지가 바뀐다.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

/**
 * readYamlMapping 결과. `kind: "missing"` 은 자연 degrade 대상(파일 없음 또는
 * 빈 파일)이라 호출 측이 자기 builtin 기본값을 돌려주면 된다. `kind: "mapping"`
 * 은 최상위가 매핑으로 확인된 경우로, value 에 그 매핑을 담는다.
 */
export type YamlMappingResult =
  | { kind: "missing" }
  | { kind: "mapping"; value: Record<string, unknown> };

/**
 * yaml 파일 한 장을 읽어 최상위 매핑을 돌려준다.
 *
 * 파일 없음(ENOENT)과 빈 파일(null/undefined)은 `{ kind: "missing" }` 로 알려
 * 호출 측이 자연 degrade 하도록 둔다. 권한 등 다른 읽기 실패·yaml 파싱 실패·
 * 최상위가 매핑이 아님은 label 접두어를 붙인 구체 에러로 throw 한다.
 *
 * @param path  읽을 yaml 경로.
 * @param label 에러 메시지 접두어(예: "search-cues", "regex-patterns").
 */
export function readYamlMapping(path: string, label: string): YamlMappingResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // 파일 없음 = 자연 degrade. builtin 양식은 코드 상수라 항상 가동.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    // 권한 등 다른 읽기 실패는 가리지 않고 구체 에러로 알린다.
    throw new Error(`${label}: 파일을 읽지 못함 (${path}): ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (e) {
    throw new Error(`${label}: yaml 파싱 실패 (${path}): ${(e as Error).message}`);
  }

  // 빈 파일(null) = 추가 양식 0.
  if (parsed === null || parsed === undefined) return { kind: "missing" };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}: 최상위가 매핑이 아님 (${path})`);
  }

  return { kind: "mapping", value: parsed as Record<string, unknown> };
}
