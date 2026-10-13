/**
 * numeric-field-parse.ts — 글-칸 글자값을 집계 시점에만 숫자로 변환 (단계6b).
 *
 * 칸 값은 metadata_json.fields 에 글자로 저장되므로(단계6 통일·spec §3), SUM/AVG
 * 를 내는 그 순간에만 이 함수로 숫자를 읽는다. 폼 숫자형 칸은 입력 검증으로 항상
 * 단일 숫자라 파싱이 늘 성공하고, 자유 입력 해시태그(`#가격:3,000원`)는 숫자만
 * 추출한다. 못 읽는 값은 null — 호출처(computeNumericAggregate)가 제외 + 건수로
 * 센다(0 변환 금지·No-fallback). LLM 0·결정적 순수 함수.
 */

/**
 * 부호(한 개)·콤마(천단위)·소수점(한 개)을 허용한 첫 숫자 토큰을 잡는다.
 * 콤마는 천단위 구분자라 제거 대상 — 매칭 후 따로 떼고 Number 한다. 여러 숫자가
 * 섞이면(3000~5000) 첫 토큰만(결정적). 단위 문자(원·kg)는 토큰 밖이라 무시된다.
 */
const NUMERIC_TOKEN_REGEX = /-?\d[\d,]*\.?\d*/;

/**
 * 글-칸 글자값에서 숫자를 추출한다. 콤마·소수점·마이너스 허용·단위 문자 무시.
 * 숫자 토큰이 한 개도 없거나 Number 가 NaN 이면 null(못 읽는 값·0 변환 금지).
 */
export function parseNumericFieldValue(raw: string): number | null {
  const m = NUMERIC_TOKEN_REGEX.exec(raw);
  if (!m) return null;
  const cleaned = m[0].replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
