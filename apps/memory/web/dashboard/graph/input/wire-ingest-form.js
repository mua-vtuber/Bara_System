/**
 * wire-ingest-form.js — 그래프 입력 폼의 미리보기·자동완성·칸 자동 표시 배선(S8·결정 1·6).
 *
 * `ingest-form.js` 의 `mountIngestForm` 이 마크업을 깐 뒤 이 함수를 한 번 불러, 입력창 위
 * 떠 있는 미리보기 패널(S7)·`#` 자동완성 드롭다운(S6)·종류 인식 시 칸 자동 표시(결정 6)를
 * 잇는다. ingest-form.js 가 800줄 상한에 닿아 배선 책임을 이 보조 파일로 떼었다(파일 작게).
 *
 * 빌드 없는 브라우저 ES 모듈이라 .ts 인 ui/dom.ts 를 직접 import 못 한다 — 호출부가 `el`
 * 헬퍼를 넘긴다(ingest-preview.js·compute-tab.js 의 el 주입 선례). 검색(search) 모드 picker
 * (entity-type-field-picker.ts)는 한 줄도 안 건드린다 — 여기 칸 자동 표시는 입력 미리보기
 * 전용이고, GET /api/entity-types 를 따로 한 번 읽어 koName·typeName 으로 columns 를 찾는다.
 * 칸 칩은 실제 별도 입력칸이 아니라, 누르면 본문 textarea 에 `#칸:` 을 끼워 넣는 보조 버튼이다.
 *
 * No-fallback: GET /api/entity-types 실패는 빈 칸으로 위장하지 않고, 종류를 인식했는데 칸을
 * 못 받았으면 식별자와 함께 칸 자리에 드러낸다. 미등록 종류·칸 0 인 종류는 빈 칸 목록을 정직
 * 하게 보인다(가짜 칸 0·spec §5.6). 자동완성 로드 실패는 추천만 끄고 입력은 안 막는다(위젯 내부).
 */

import { apiFetch } from "../../api-fetch.js";
import { mountIngestPreview } from "./ingest-preview.js";
import { extractTags } from "./parse-input-preview.js";
import { createTagAutocomplete } from "./tag-autocomplete.js";

// caret 앞의 `#접두`(한글·영문·숫자·밑줄)를 통째로 잡는 정규식 — 자동완성 선택 시 치환 대상.
// ingest-form.js HASHTAG_RE·tag-autocomplete.js TAG_CHAR 과 같은 글자 종류.
const ACTIVE_TAG_PREFIX_RE = /#[0-9A-Za-z_가-힣㄰-㆏]*$/;
const ACTIVE_TAG_PREFIX_CAPTURE_RE = /#([0-9A-Za-z_가-힣㄰-㆏]+)$/;

/**
 * 입력 폼의 미리보기·자동완성·칸 자동 표시를 잇는다(S8). mountIngestForm 이 마크업을 깐 뒤
 * 한 번 호출한다.
 *
 * @param {object} ctx
 * @param {HTMLTextAreaElement} ctx.inputEl       입력 textarea.
 * @param {HTMLElement} ctx.inputWrapEl           textarea 래퍼(자동완성 드롭다운 앵커).
 * @param {HTMLElement} ctx.previewEl             미리보기 패널 컨테이너.
 * @param {string} ctx.apiBase                    API 베이스("" same-origin).
 * @param {typeof import("../../ui/dom.ts").el} ctx.el  DOM 헬퍼(주입).
 * @returns {{ preview: { refresh: () => void, dispose: () => void } }}
 *          preview=미리보기 핸들(refresh/dispose). 배선 자체는 부수효과로 끝난다.
 */
export function wireIngestExtras(ctx) {
  const { inputEl, inputWrapEl, previewEl, apiBase = "", el } = ctx;
  if (!inputEl || !inputWrapEl || !previewEl || typeof el !== "function") {
    throw new Error(
      `wireIngestExtras: inputEl·inputWrapEl·previewEl·el 누락 ` +
        `(inputEl=${!!inputEl}, inputWrapEl=${!!inputWrapEl}, previewEl=${!!previewEl}, el=${typeof el})`,
    );
  }

  // ── 종류 → columns 맵(결정 6 칸 자동 표시용) ───────────────────────────
  // GET /api/entity-types 를 한 번 읽어 koName·typeName 양쪽을 키로 columns 를 담는다.
  // 미리보기가 종류 토큰(`#가계부:` 의 "가계부"=koName)을 인식하면 그 columns 를 미리보기 옆에
  // "이 종류는 이런 칸을 가질 수 있어요"로 보인다(강제 입력칸 아님·spec §5.6). 칩 클릭은
  // textarea 에 `#칸:` 을 넣어 줄 뿐이고, 저장 매칭은 서버가 본문 태그로 koName→typeName
  // 해석한다(S5).
  /** @type {Map<string, Array<{key: string, label: string, dataType?: string}>>} */
  let columnsByKind = new Map();
  // entity-types 로드 실패를 칸 자동 표시 자리에 드러낼 메시지(없으면 null). No-fallback —
  // 빈 칸 목록으로 위장하지 않고, 종류를 인식했는데 칸을 못 받았으면 식별자와 함께 보인다.
  let entityTypesError = null;

  /**
   * GET /api/entity-types 로 종류별 columns 맵을 채운다(결정 6). koName·typeName 둘 다 키로
   * 넣어 미리보기 토큰(koName)·서버 저장 키(typeName) 어느 쪽으로 인식돼도 칸을 찾게 한다.
   * 실패는 빈 맵으로 위장하지 않고 entityTypesError 에 식별자와 함께 담아 칸 자리에 드러낸다.
   */
  async function loadEntityTypeColumns() {
    const res = await apiFetch(`${apiBase}/api/entity-types`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `종류 칸 조회 실패 — HTTP ${res.status}${text ? `: ${text}` : ""}`,
      );
    }
    const data = await res.json();
    const next = new Map();
    for (const t of data.entityTypes ?? []) {
      const cols = Array.isArray(t.columns) ? t.columns : [];
      if (typeof t.typeName === "string" && t.typeName.length > 0) next.set(t.typeName, cols);
      if (typeof t.koName === "string" && t.koName.length > 0) next.set(t.koName, cols);
    }
    columnsByKind = next;
    entityTypesError = null;
  }

  // ── 종류 인식 시 columns 자동 표시(결정 6) ─────────────────────────────
  // 미리보기 onParsed 콜백이 인식 결과를 줄 때마다 호출된다. 종류(parsed.kind=koName)를
  // 인식했으면 그 columns 를 칸 칩으로 그리고, entity-types 로드가 실패했으면 식별자를 드러낸다.
  const fieldsAutoEl = el("div", { className: "ingest-fields-auto", dataset: { ingestFieldsAuto: "" } });
  previewEl.appendChild(fieldsAutoEl);

  /** 인식 결과로 칸 자동 표시 칩을 다시 그린다(종류 없으면 비운다·로드 실패면 식별자 표시). */
  function renderAutoFields(parsed) {
    const kind = resolveAutoFieldKind(parsed);
    if (!kind) {
      // 종류를 못 알아들었으면 칸 안내를 비운다(가짜 칸 0).
      fieldsAutoEl.replaceChildren();
      return;
    }
    if (entityTypesError !== null) {
      // 종류는 인식했는데 칸 목록을 못 받았다 — 식별자와 함께 정직하게 드러낸다(빈 위장 0).
      fieldsAutoEl.replaceChildren(
        el("div", { className: "ingest-fields-auto-error" }, entityTypesError),
      );
      return;
    }
    const cols = columnsByKind.get(kind);
    if (!cols || cols.length === 0) {
      // 미등록 종류·칸 없는 종류 — 빈 칸 목록을 정직하게 보인다(가짜 칸 0·spec §5.6).
      fieldsAutoEl.replaceChildren();
      return;
    }
    const fieldValues = new Map();
    for (const tag of extractTags(inputEl.value)) {
      if (cols.some((c) => c.key === tag.key)) fieldValues.set(tag.key, tag.value);
    }
    const chips = cols.map((c) => {
      const value = fieldValues.get(c.key);
      if (typeof value === "string" && value.length > 0) {
        return el(
          "span",
          {
            className: "ingest-field-chip ingest-field-chip-filled",
            dataset: { fieldKey: c.key, fieldPreview: "1" },
          },
          `${c.label}: ${value}`,
        );
      }
      return el(
        "button",
        {
          type: "button",
          className: "ingest-field-chip",
          dataset: { fieldKey: c.key },
          title: `본문에 #${c.key}: 삽입`,
        },
        `#${c.label}:`,
      );
    });
    fieldsAutoEl.replaceChildren(
      el("span", { className: "ingest-fields-auto-label" }, "이 종류 칸"),
      ...chips,
    );
  }

  /**
   * 칸 자동 표시용 종류 키. 값이 있는 `#사람:철수` 는 parsed.kind 를 쓰고, 값을 치기 전인
   * `#사람:`·정확한 `#사람` 입력 중에는 textarea 원문에서 키를 읽어 칸 안내를 먼저 띄운다.
   */
  function resolveAutoFieldKind(parsed) {
    if (parsed && typeof parsed.kind === "string") return parsed.kind;
    const tags = extractTags(inputEl.value);
    for (let i = tags.length - 1; i >= 0; i -= 1) {
      const key = tags[i].key;
      if (columnsByKind.has(key)) return key;
    }
    const caret = typeof inputEl.selectionStart === "number" ? inputEl.selectionStart : inputEl.value.length;
    const head = inputEl.value.slice(0, caret);
    const active = ACTIVE_TAG_PREFIX_CAPTURE_RE.exec(head)?.[1] ?? null;
    return active && columnsByKind.has(active) ? active : null;
  }

  // 칸 칩 클릭 → 본문 textarea 에 `#칸:` 을 끼워 넣는다. 별도 fields payload 를 되살리지
  // 않고도 사용자가 곧바로 값을 이어 칠 수 있게 하는 마찰 제거다(spec §5.6 유지).
  fieldsAutoEl.addEventListener("mousedown", (e) => {
    const chip = e.target instanceof Element ? e.target.closest("[data-field-key]") : null;
    if (!chip) return;
    e.preventDefault(); // textarea 포커스 유지
    insertFieldTag(chip.dataset.fieldKey || "");
  });

  // ── 미리보기 패널 배선(S7·결정 2) ──────────────────────────────────────
  // 입력창 위 떠 있는 패널을 입력 textarea 에 잇는다. onParsed 로 종류 인식 결과를 받아
  // 칸 자동 표시를 갱신한다(결정 6). 미리보기는 듣기만 하고 textarea 를 안 건드린다(non-blocking).
  const preview = mountIngestPreview({
    inputEl,
    panelEl: previewEl,
    el,
    onParsed: (parsed) => {
      // 미리보기가 panelEl(previewEl)을 replaceChildren 으로 갈아끼우면서 fieldsAutoEl 이
      // 떨어져 나가므로, 매 갱신마다 다시 붙이고 칸 칩을 그린다(미리보기 본체와 분리 유지).
      previewEl.appendChild(fieldsAutoEl);
      renderAutoFields(parsed);
    },
  });

  // entity-types 를 읽어 칸 맵을 채운 뒤(또는 실패 식별자를 담은 뒤) 미리보기를 한 번 다시
  // 그려 타이핑 전 첫 인식·칸 표시를 복구한다. 입력·전송·미리보기 본체는 로드 결과와 무관히
  // 그대로 돈다(No-fallback — 칸 자동 표시 기능만 로드 결과에 좌우된다).
  loadEntityTypeColumns()
    .then(() => preview.refresh())
    .catch((err) => {
      entityTypesError = err instanceof Error ? err.message : String(err);
      preview.refresh();
    });

  // ── # 자동완성 배선(S6·결정 3) ─────────────────────────────────────────
  // textarea 옆 래퍼에 추천 드롭다운을 둔다. load() 한 번으로 전체 후보를 받고 로컬에서 거른다.
  // 로드 실패는 추천만 끄고 입력은 그대로 둔다(No-fallback·위젯 내부 처리).
  const autocomplete = createTagAutocomplete({ apiBase, inputEl });
  inputWrapEl.appendChild(autocomplete.listEl);
  // 추천 항목 클릭 → 지금 치던 `#토큰` 을 그 태그로 바꿔 넣는다(S8 선택 배선).
  autocomplete.listEl.addEventListener("mousedown", (e) => {
    // mousedown 으로 잡아 textarea blur 보다 먼저 처리한다(blur 가 드롭다운을 닫기 전에).
    const li = e.target instanceof Element ? e.target.closest("[data-tag]") : null;
    if (!li) return;
    e.preventDefault(); // textarea 포커스 유지
    applyTagSuggestion(li.dataset.tag || "");
  });
  autocomplete.load().catch((err) => {
    // 위젯이 자체적으로 available=false 로 추천을 끄지만, 예외 경로도 console 로 드러낸다(silent 금지).
    console.error("[wire-ingest-form] 태그 자동완성 로드 오류:", err);
  });

  /**
   * 추천 태그를 지금 치던 `#토큰` 자리에 끼워 넣는다(자동완성 선택). caret 앞 `#접두` 를
   * `#태그` 로 치환하고 caret 을 그 뒤로 옮긴다. 치환 후 미리보기·자동완성을 다시 그린다.
   */
  function applyTagSuggestion(tag) {
    if (!tag) return;
    const value = inputEl.value;
    const caret = typeof inputEl.selectionStart === "number" ? inputEl.selectionStart : value.length;
    const head = value.slice(0, caret);
    const tail = value.slice(caret);
    const replaced = head.replace(ACTIVE_TAG_PREFIX_RE, `#${tag}`);
    if (replaced === head) return; // `#` 토큰 자리가 아니면 손대지 않는다.
    inputEl.value = replaced + tail;
    const newCaret = replaced.length;
    inputEl.setSelectionRange(newCaret, newCaret);
    inputEl.focus();
    // 값이 바뀌었으니 미리보기·자동완성·자동 높이를 다시 맞춘다(input 이벤트 흐름 재사용).
    inputEl.dispatchEvent(new Event("input"));
    autocomplete.refresh();
  }

  /**
   * 칸 키를 현재 caret 위치에 `#칸:` 형태로 넣고, caret 을 콜론 뒤에 둔다.
   * caret 앞에 이미 `#접두` 를 치는 중이면 그 토큰을 대체하고, 아니면 앞 글과 한 칸 띄워 붙인다.
   */
  function insertFieldTag(fieldKey) {
    if (!fieldKey) return;
    const value = inputEl.value;
    const caret = typeof inputEl.selectionStart === "number" ? inputEl.selectionStart : value.length;
    const head = value.slice(0, caret);
    const tail = value.slice(caret);
    const tag = `#${fieldKey}:`;
    const replaced = head.replace(ACTIVE_TAG_PREFIX_RE, tag);
    const nextHead =
      replaced !== head
        ? replaced
        : `${head}${head.length === 0 || /[\s,]$/.test(head) ? "" : " "}${tag}`;
    inputEl.value = nextHead + tail;
    const newCaret = nextHead.length;
    inputEl.setSelectionRange(newCaret, newCaret);
    inputEl.focus();
    inputEl.dispatchEvent(new Event("input"));
    autocomplete.refresh();
  }

  return { preview };
}
