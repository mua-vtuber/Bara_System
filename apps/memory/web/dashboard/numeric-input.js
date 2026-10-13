/**
 * numeric-input.js — 숫자형 칸 입력 검증 순수 함수 (그래프 입력검색 보강 S1).
 *
 * isValidNumericInput 하나만 담은 작은 파일이다. 옛 구조에서는 이 함수가 ingest-form.js
 * 에 있었고, entity-fields-widget.js·entity-type-field-picker.ts 가 그 함수 하나 때문에
 * ingest-form.js 전체(DOM 부수효과·mountIngestForm 까지)를 import 해 순환이 생겼다.
 * 의존 없는 순수 함수를 별 파일로 떼어 그 순환을 끊는다 — 세 곳이 이 파일 한 곳에서만
 * import 한다(단일 출처).
 *
 * 빌드 도구 없이 브라우저가 그대로 읽는 ES 모듈이라 .ts → .js 번들 단계를 안 거친다
 * (ingest-form.js·entity-fields-widget.js 선례). 단위 테스트는 ingest-form.test.ts·
 * ingest-form.fields.test.ts 가 fixture 데이터로 검증한다(import 경로는 ingest-form.js
 * re-export 를 그대로 쓴다 — 호출 계약 불변).
 */

/**
 * 폼 숫자형 칸(단계6b dataType="number")에 들어온 글자가 숫자로 읽히는 값인지 본다.
 * parseNumericFieldValue(코어 T2)와 같은 허용 범위 — 천단위 콤마·소수점 한 개·앞 부호 한 개.
 * 한글·단위 문자가 섞이면 거부한다(폼 입력값을 항상 파싱 가능하게 하는 게 목적·spec §3.4).
 *
 * 빈 문자열은 유효로 본다(미입력 칸은 거부 대상 아님 — buildDynamicPayload 가 빈 값을 생략).
 * 입력 중간 상태("-"·"1." 처럼 아직 숫자 미완성)도 막지 않으려 *완성 숫자만* 거부 신호로
 * 쓰는 게 아니라, "명백히 숫자 아님"만 false 로 가른다. 콤마는 자릿수 구분이라 허용한다.
 *
 * @param {string} raw  칸 입력 글자
 * @returns {boolean}   숫자로 읽히면(또는 빈/입력 중간) true, 명백히 비숫자면 false
 */
export function isValidNumericInput(raw) {
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  if (s === "") return true; // 미입력은 거부 대상 아님(빈 값은 페이로드에서 생략됨).
  // 부호(±) 한 개 + 숫자·콤마 + 소수점 한 개 + 숫자. 콤마는 자릿수 구분 허용.
  // 입력 중간 상태("-"·"12."·".")도 통과시켜 타이핑을 막지 않는다 — 완성 검증이 아니라
  // "명백한 비숫자(한글·단위 문자)" 차단이 목적.
  return /^[+-]?[0-9,]*\.?[0-9]*$/.test(s);
}
