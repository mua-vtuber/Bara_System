/**
 * tag-autocomplete.js — # 태그 자동완성 위젯 (그래프 입력 해시태그 개편 S6 / 결정 3).
 *
 * 그래프 입력에서 사용자가 `#` 를 치는 동안, 이미 저장된 태그를 추천해 재사용을 돕는다.
 * 오타로 같은 엔티티가 둘(`#작업컴퓨터` vs `#작업컴`)로 쪼개지는 걸 막는 게 목적이다.
 * 강제 아님 — 추천을 무시하고 새 값(치과 등)을 끝까지 치면 그냥 새로 생성된다.
 *
 * 데이터 출처 = GET /api/tag-suggest (저장된 개념 목록·usage_count 정렬). 빌드 도구 없이
 * 브라우저가 그대로 읽는 ES 모듈이라 .ts → .js 번들 단계를 거치지 않는다(compute-tab.js·
 * ingest-form.js 선례). 순수 로직(접두 추출·필터)은 export 해 단위 테스트가 fixture 로 검증한다.
 *
 * 접두 필터 위치(spec AC "둘 중 한 곳에서만"): 런타임 필터는 *여기 클라* 가 맡는다 —
 * load() 한 번으로 전체 후보를 받아 두고, `#` 뒤 토큰이 바뀔 때마다 filterSuggestions 로
 * 그 자리에서 거른다(네트워크 재호출 0). 라우트 ?prefix 는 직접 호출용 통로라 위젯은 안 쓴다.
 *
 * No-fallback(프로젝트 정책): 비2xx 응답이면 추천만 끄고(available=false) 입력은 절대 막지
 * 않는다 — 추천 실패가 사용자가 글을 마저 치는 걸 가로막으면 안 된다. 후보가 0건이면 빈
 * 목록(가짜 항목 0·정직한 빈 상태)이라 드롭다운이 안 뜬다.
 */

import { apiFetch } from "../../api-fetch.js";

// 한 태그로 보는 글자 묶음 — ingest-form.js HASHTAG_RE 와 같은 글자 종류(한국어·영문·숫자·
// 밑줄). 토큰 추출이 이 글자 종류에서만 이어지고, 공백·문장부호에서 끊긴다. 입력·추출이
// 같은 규칙을 써야 사용자가 친 토큰과 추천 대상이 어긋나지 않는다.
const TAG_CHAR = "0-9A-Za-z_가-힣㄰-㆏";
// caret 바로 앞이 `#token` 인지 보는 정규식 — 문자열 끝(=caret 위치)에 고정(`$`). `#` 직후
// 토큰 글자 0개 이상이라, `#` 만 친 직후(빈 토큰)도 잡아 전체 목록을 띄운다.
const ACTIVE_TAG_RE = new RegExp(`#([${TAG_CHAR}]*)$`);

/**
 * caret 위치까지의 입력에서 *지금 치고 있는* 해시태그 접두를 뽑는다(순수 함수).
 * caret 바로 앞이 `#` 으로 시작하는 토큰이면 그 토큰(`#` 제외)을 돌리고, 아니면 null.
 * `#` 만 친 직후면 빈 문자열("")을 돌려 전체 후보를 띄우는 신호가 된다(null 과 구분).
 *
 * @param {string} text 입력 칸 전체 값
 * @param {number} caretPos caret(커서) 위치 — text.slice(0, caretPos) 까지가 "지금까지 친 글"
 * @returns {string | null} 활성 태그 접두(빈 문자열 포함) 또는 null(태그 입력 중 아님)
 */
export function extractActiveTagPrefix(text, caretPos) {
  if (typeof text !== "string") return null;
  const pos = typeof caretPos === "number" && caretPos >= 0 ? caretPos : text.length;
  const head = text.slice(0, pos);
  const m = ACTIVE_TAG_RE.exec(head);
  return m ? m[1] : null;
}

/**
 * 후보 이름 목록을 접두로 거른다(순수 함수·클라 단일 필터 위치). 공백 제거 후 startsWith
 * 비교 — 빈 접두면 전체 통과(거르지 않는다). 대소문자는 needle 을 소문자로 내려 비교한다
 * (개념 name 이 소문자 정규화돼 저장되므로 영문 태그도 일치한다).
 *
 * @param {string[]} names 추천 후보 이름 목록(/api/tag-suggest 의 name 칸)
 * @param {string} prefix 지금 친 태그 접두(`#` 제외)
 * @returns {string[]} 접두 일치만 추린 목록(입력 순서 보존 = usage_count 정렬 보존)
 */
export function filterSuggestions(names, prefix) {
  if (!Array.isArray(names)) return [];
  const needle = (typeof prefix === "string" ? prefix : "").trim().toLowerCase();
  if (needle.length === 0) return names.slice();
  return names.filter((n) => typeof n === "string" && n.toLowerCase().startsWith(needle));
}

/**
 * 자동완성 위젯을 만든다. 입력 칸(inputEl) 옆에 추천 드롭다운(<ul>)을 두고, `#` 입력 중
 * 후보를 띄운다. load() 한 번으로 전체 후보를 받아 두고 로컬에서 거른다(런타임 필터 한 곳).
 *
 * @param {{ apiBase?: string, inputEl: HTMLInputElement | HTMLTextAreaElement }} opts
 * @returns {{
 *   listEl: HTMLElement,
 *   load: () => Promise<void>,
 *   isAvailable: () => boolean,
 *   refresh: () => void,
 *   getVisibleSuggestions: () => string[],
 *   setSuggestionsForTest: (names: string[]) => void,
 * }}
 */
export function createTagAutocomplete(opts) {
  const apiBase = (opts && opts.apiBase) || "";
  const inputEl = opts && opts.inputEl;
  if (!inputEl) throw new Error("createTagAutocomplete: inputEl 필수");

  const listEl = document.createElement("ul");
  listEl.className = "tag-autocomplete";
  listEl.setAttribute("role", "listbox");
  listEl.hidden = true;

  // 전체 후보 이름(load 이후 채워진다). 비2xx·미로드면 available=false 라 추천이 꺼진다 —
  // 입력은 그대로 두고 드롭다운만 안 뜬다(No-fallback: 추천 실패가 입력을 막지 않는다).
  /** @type {string[]} */
  let allNames = [];
  let available = false;

  /** 드롭다운을 숨기고 비운다(후보 0·태그 입력 아님·로드 실패 공통). */
  function hide() {
    listEl.hidden = true;
    listEl.replaceChildren();
  }

  /** 현재 입력·caret 기준으로 드롭다운을 다시 그린다. 추천 꺼졌으면 항상 숨는다. */
  function refresh() {
    if (!available) {
      hide();
      return;
    }
    const caret = typeof inputEl.selectionStart === "number" ? inputEl.selectionStart : inputEl.value.length;
    const prefix = extractActiveTagPrefix(inputEl.value, caret);
    if (prefix === null) {
      // 지금 `#` 토큰을 치는 중이 아니다 — 드롭다운을 띄우지 않는다.
      hide();
      return;
    }
    const matches = filterSuggestions(allNames, prefix);
    if (matches.length === 0) {
      // 후보 0건(새 값을 끝까지 친 경우 포함) — 빈 목록이라 안 띄운다(정직한 빈 상태).
      hide();
      return;
    }
    renderList(matches);
  }

  /** 후보 목록을 <li> 로 그린다. textContent 만 써 XSS 안전(사용자 저장 태그가 들어온다). */
  function renderList(names) {
    listEl.replaceChildren();
    for (const name of names) {
      const li = document.createElement("li");
      li.className = "tag-autocomplete-item";
      li.setAttribute("role", "option");
      li.dataset.tag = name;
      li.textContent = name; // textContent — XSS 안전
      listEl.appendChild(li);
    }
    listEl.hidden = false;
  }

  /**
   * GET /api/tag-suggest 로 전체 후보를 한 번 받는다(?prefix 안 씀 — 로컬 필터 정신).
   * 비2xx·예외면 available=false 로 두고 추천을 끈다 — 입력은 절대 막지 않는다(No-fallback).
   * 라우트 503(store 미주입)도 비2xx 라 같은 경로로 추천만 꺼진다(정직한 비활성).
   */
  async function load() {
    try {
      const res = await apiFetch(`${apiBase}/api/tag-suggest`);
      if (!res.ok) {
        // 비2xx — 추천만 끄고 입력은 그대로(추천 실패가 입력을 막지 않는다).
        available = false;
        hide();
        return;
      }
      const data = await res.json();
      allNames = Array.isArray(data && data.tags)
        ? data.tags.map((t) => (t && typeof t.name === "string" ? t.name : "")).filter((n) => n.length > 0)
        : [];
      available = true;
    } catch {
      // 네트워크·파싱 예외 — 같은 정신으로 추천만 끈다. 입력 흐름은 무사하다.
      available = false;
      hide();
    }
  }

  inputEl.addEventListener("input", refresh);
  // caret 이동(화살표·클릭)으로 활성 토큰이 바뀔 수 있어 같은 재계산을 건다.
  inputEl.addEventListener("keyup", refresh);
  inputEl.addEventListener("click", refresh);
  // 포커스가 나가면 드롭다운을 닫는다(클릭 선택 처리는 S8 배선 몫 — 여기선 추천 표시까지).
  inputEl.addEventListener("blur", () => {
    // blur 직후 li 클릭을 가로채지 않게 한 박자 늦춘다(브라우저 mousedown→blur 순서 대응).
    setTimeout(hide, 0);
  });

  return {
    listEl,
    load,
    isAvailable: () => available,
    refresh,
    /** 지금 드롭다운에 뜬 후보 이름(테스트·배선 측이 읽는다). 숨김이면 빈 배열. */
    getVisibleSuggestions: () =>
      listEl.hidden
        ? []
        : Array.from(listEl.querySelectorAll("[data-tag]")).map((li) => li.dataset.tag || ""),
    /**
     * @internal 테스트 전용 — 운영 코드에서 호출하지 말 것. load() 의 fetch 통로를 안 타고
     * 후보를 직접 주입해 refresh·필터를 검증하는 데이터 통로다(fixture·인터페이스 mock 아님·
     * 프로젝트 정책·entity-type-field-picker setColumnsForTest 양식). 운영은 load() 만 쓴다.
     */
    setSuggestionsForTest: (names) => {
      allNames = Array.isArray(names) ? names.slice() : [];
      available = true;
    },
  };
}
