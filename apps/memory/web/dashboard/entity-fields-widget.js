/**
 * entity-fields-widget.js — 동적 칸 위젯 공유 규칙 (그래프 입력검색 보강 S1).
 *
 * 종류별 columns 를 입력 칸으로 그리고(renderEntityFields), 그 칸들에서 값을 읽는
 * (collectDynamicFields) 규칙을 한 정의로 모은 곳이다. 입력 폼(ingest-form.js)과 검색
 * 모달의 공용 picker(graph/shell/entity-type-field-picker.ts)가 같은 규칙을 쓰게 해
 * 칸 렌더·읽기가 두 곳으로 갈라지지 않게 한다(중복 0·결정 6).
 *
 * 빌드 도구 없이 브라우저가 그대로 읽는 ES 모듈이라 .ts → .js 번들 단계를 안 거친다
 * (ingest-form.js·compute-tab.js 선례). 숫자형 칸 입력 검증은 numeric-input.js 의
 * isValidNumericInput 한 정의를 재사용한다(입력 폼·picker 도 같은 함수를 재사용).
 *
 * 순환 차단(S1) — 옛 구조는 ingest-form.js 와 서로 import 해 순환이었다(ingest-form 이
 * 여기서 두 렌더·읽기 함수를, 여기가 ingest-form 에서 isValidNumericInput 을). 그 한 함수를
 * 의존 없는 numeric-input.js 로 떼어 두 파일이 그 단일 출처에서만 가져오게 했다 — 이제
 * ingest-form → entity-fields-widget 단방향이고 순환이 없다.
 */

import { isValidNumericInput } from "./numeric-input.js";

/**
 * 동적 칸 컨테이너(fieldsEl)의 입력들에서 값 있는 칸만 {칸키: 값} 으로 읽는다.
 *
 * [data-field-key] input 에서 dataset.fieldKey 와 trim 한 value 만 읽고, 빈 칸은
 * 생략한다(buildDynamicPayload 가 빈 값을 빼는 정신 그대로). 공용 picker 의 getFields()
 * 와 *같은 산출 계약*이다 — 입력 폼과 검색 모달이 칸을 같은 규칙으로 읽는다.
 *
 * @param {Element|null} fieldsEl  동적 칸 컨테이너(없으면 빈 객체).
 * @returns {Record<string,string>}  값 있는 칸만 {칸키: 값}.
 */
export function collectDynamicFields(fieldsEl) {
  const out = {};
  if (!fieldsEl || typeof fieldsEl.querySelectorAll !== "function") return out;
  for (const input of fieldsEl.querySelectorAll("[data-field-key]")) {
    const k = input.dataset.fieldKey;
    const v = typeof input.value === "string" ? input.value.trim() : "";
    if (k && v.length > 0) out[k] = v;
  }
  return out;
}

/**
 * 한 종류의 columns 를 동적 칸 입력으로 그려 fieldsEl 에 채운다(읽기 전용 — 칸 추가 없음).
 *
 * label.textContent(XSS 안전) + dataType==="number" 면 숫자 입력, dataType==="date" 면
 * date input 으로 그린다. 숫자형은 isValidNumericInput 으로 비숫자 차단(되돌리기).
 * 입력 폼(ingest-form.js)과 공용 picker
 * (entity-type-field-picker.ts)가 이 한 정의를 직접 호출한다 — 칸 렌더가 두 곳으로
 * 갈라지지 않게 한 단일 정의다(중복 0·결정 6). 한글·단위 문자를 치면 그 입력을 직전 유효값
 * 으로 되돌려 입력값이 항상 파싱 가능하게 한다.
 *
 * numericGuard 옵션 — picker 의 search 모드는 숫자 칸에도 차단을 걸지 않는다(검색은 값을
 * 파싱하지 않고 거름망 조건으로만 쓴다). ingest 통로(입력 폼·picker ingest 모드)는 기본값
 * true 로 차단을 건다. 차단을 안 걸어도 inputmode·numeric 표지는 그대로 단다(숫자 키패드
 * 힌트는 두 모드 공통).
 *
 * @param {Element} fieldsEl  동적 칸 컨테이너.
 * @param {Array<{key: string, label: string, dataType?: string}>} cols  그릴 칸 목록.
 * @param {{ numericGuard?: boolean }} [opts]  numericGuard=false 면 숫자 차단을 안 건다(기본 true).
 */
export function renderEntityFields(fieldsEl, cols, opts = {}) {
  const numericGuard = opts.numericGuard !== false;
  fieldsEl.replaceChildren();
  const list = Array.isArray(cols) ? cols : [];
  for (const col of list) {
    const wrap = document.createElement("label");
    wrap.className = "ingest-field";
    const name = document.createElement("span");
    name.className = "ingest-field-label";
    name.textContent = col.label; // textContent — XSS 안전
    const input = document.createElement("input");
    input.type = col.dataType === "date" ? "date" : "text";
    input.className = "ingest-field-input";
    input.dataset.fieldKey = col.key;
    if (col.dataType === "date") {
      input.dataset.date = "1";
    } else if (col.dataType === "number") {
      // 숫자형 칸 — 모바일 숫자 키패드 힌트(두 모드 공통).
      input.setAttribute("inputmode", "decimal");
      input.dataset.numeric = "1";
      if (numericGuard) {
        // 비숫자 입력 차단(되돌리기) — ingest 통로 한정.
        let lastValid = "";
        input.addEventListener("input", () => {
          if (isValidNumericInput(input.value)) {
            lastValid = input.value;
          } else {
            // 명백한 비숫자(한글·단위 문자)는 받지 않고 직전 유효값으로 되돌린다.
            input.value = lastValid;
          }
        });
      }
    }
    wrap.append(name, input);
    fieldsEl.appendChild(wrap);
  }
}
