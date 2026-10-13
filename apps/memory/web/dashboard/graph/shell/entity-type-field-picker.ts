/**
 * web/dashboard/graph/shell/entity-type-field-picker.ts
 * 공용 picker — 종류 드롭다운 + 동적 칸 위젯. 입력 폼·검색 모달이 공유한다(spec §5·결정 6).
 * GET /api/entity-types 를 load() 한 번으로 읽어 종류 목록·종류별 columns 를 채운다.
 * 의존: apiFetch + compute-tab(filterNumericColumns) + entity-fields-widget(renderEntityFields).
 * 순수 함수만. graph/render·three.js 에 의존하지 않는다(공유 shell 층·의존 방향 일방).
 */
import { apiFetch } from "../../api-fetch.ts";
// compute-tab.js·entity-fields-widget.js 는 브라우저가 그대로 읽는 ES 모듈이라 .js 확장자로 import 한다.
import { filterNumericColumns } from "../../compute-tab.js";
// 칸 렌더는 entity-fields-widget.js 의 renderEntityFields 한 정의를 직접 호출한다(중복 0·결정 6).
import { renderEntityFields } from "../../entity-fields-widget.js";

export type FieldPickerMode = "ingest" | "search";

export interface PickerColumn {
  key: string;
  label: string;
  dataType?: string;
}

export interface FieldPicker {
  selectEl: HTMLSelectElement;
  fieldsEl: HTMLElement;
  /**
   * 하위분류(subcategory) 단일 드롭다운(S7·search 모드 전용). 종류를 고르면 그 종류 갈래로
   * 다시 채워진다. 검색 모달이 칸 입력 자리에 이 드롭다운을 끼운다. ingest 모드는 칸 입력만
   * 쓰고 이 드롭다운은 비어 있다(placeholder 한 개).
   */
  subcategorySelectEl: HTMLSelectElement;
  /**
   * load() 실패를 정직하게 드러내는 전용 자리(No-fallback). 평소엔 비어 숨고(:empty), 로드
   * 실패 시 showLoadError 가 메시지를 채운다. search 모드는 fieldsEl 을 화면에 안 붙이므로,
   * 호출부(graph-entry)가 항상 화면에 붙는 이 요소에 에러를 표시해야 사용자가 본다.
   */
  errorEl: HTMLElement;
  load(): Promise<void>;
  /** load() 실패 메시지를 errorEl 에 채운다(빈 위장 0·console.error 는 호출부가 따로 유지). */
  showLoadError(message: string): void;
  getKind(): string;
  getFields(): Record<string, string>;
  /** 선택한 하위분류 갈래(빈 선택이면 ""·S7). 검색이 filter 값으로 보낸다. */
  getSubcategory(): string;
  getNumericColumns(): Array<{ key: string; label: string }>;
  onKindChange(cb: (kind: string) => void): void;
  /**
   * @internal 테스트 전용 — 운영 코드에서 호출하지 말 것. load() 의 fetch 통로를 안 타고
   * columns 를 직접 주입해 getNumericColumns·onKindChange 를 검증하는 데이터 통로다
   * (fixture·인터페이스 mock 아님·프로젝트 정책). 운영은 load() 만 쓴다.
   */
  setColumnsForTest(typeName: string, cols: PickerColumn[]): void;
  /**
   * @internal 테스트 전용 — 운영 코드에서 호출하지 말 것. load() 의 fetch 통로를 안 타고
   * 하위분류 갈래를 직접 주입해 getSubcategory·search 모드 드롭다운 렌더를 검증하는 데이터
   * 통로다(fixture·인터페이스 mock 아님·setColumnsForTest 양식). 운영은 load() 만 쓴다.
   */
  setSubcategoriesForTest(typeName: string, subs: string[]): void;
}

/** GET /api/entity-types 응답 한 종류 항목 — load() 가 읽는 칸·하위분류만 추린 모양. */
interface EntityTypeResponseItem {
  typeName: string;
  koName?: string;
  columns?: PickerColumn[];
  subcategories?: string[];
}

export function createEntityTypeFieldPicker(opts: {
  apiBase: string;
  mode: FieldPickerMode;
}): FieldPicker {
  const { apiBase, mode } = opts;

  const selectEl = document.createElement("select");
  selectEl.className = "etfp-select";
  selectEl.setAttribute("aria-label", "종류");
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "종류 없음";
  selectEl.appendChild(placeholder);

  const fieldsEl = document.createElement("div");
  fieldsEl.className = "etfp-fields";

  // 하위분류 단일 드롭다운(S7·search 모드 전용). 종류 change 시 그 종류 갈래로 다시 채운다.
  // placeholder("하위분류 없음"·value="")는 항상 첫 항목 — 빈 선택이면 getSubcategory()가 "".
  const subcategorySelectEl = document.createElement("select");
  subcategorySelectEl.className = "etfp-subcategory";
  subcategorySelectEl.setAttribute("aria-label", "하위분류");
  const subPlaceholder = document.createElement("option");
  subPlaceholder.value = "";
  subPlaceholder.textContent = "하위분류 없음";
  subcategorySelectEl.appendChild(subPlaceholder);

  // load() 실패 표시 전용 자리(No-fallback). 평소엔 비어 :empty 로 숨고, 로드 실패 시
  // showLoadError 가 메시지를 채운다. search 모드는 fieldsEl 을 화면에 안 붙이므로 이 요소가
  // 검색 모달 filterRow 에 항상 붙어 있어야 로드 실패를 사용자가 본다(ingest-field-error 양식).
  const errorEl = document.createElement("div");
  errorEl.className = "etfp-error";

  // 종류 이름 → columns 맵(load 이후 채워진다). dataType 은 숫자형 칸 표지.
  let columnsByType = new Map<string, PickerColumn[]>();
  // 종류 이름 → 하위분류 갈래 목록(load 이후 채워진다·S7). 끈 값 차감은 백엔드 merge 가 한다.
  let subcategoriesByType = new Map<string, string[]>();
  const kindChangeCbs: Array<(kind: string) => void> = [];

  /** 현재 종류의 하위분류 갈래로 드롭다운을 다시 채운다(placeholder 한 개 + 갈래들·S7). */
  function renderSubcategories(): void {
    while (subcategorySelectEl.options.length > 1) subcategorySelectEl.remove(1);
    const subs = subcategoriesByType.get(selectEl.value) ?? [];
    for (const sc of subs) {
      const opt = document.createElement("option");
      opt.value = sc;
      opt.textContent = sc; // textContent — XSS 안전
      subcategorySelectEl.appendChild(opt);
    }
  }

  function renderFields(): void {
    if (mode === "search") {
      // 검색 모드는 칸 입력 대신 하위분류 단일 드롭다운으로 좁힌다(S7·사용자 결정). 칸 입력은
      // 그리지 않는다 — fieldsEl 은 비워 두고, 종류 갈래로 subcategorySelectEl 만 다시 채운다.
      fieldsEl.replaceChildren();
      renderSubcategories();
      return;
    }
    // ingest 모드 — 칸 렌더는 entity-fields-widget.js 의 renderEntityFields 한 정의를 그대로
    // 호출한다(중복 0·결정 6). 칸은 .ingest-field* 클래스로 그려져 forms.css 스타일을 입력
    // 폼과 공유한다. ingest 통로는 숫자 차단을 건다(numericGuard true).
    const cols = columnsByType.get(selectEl.value) ?? [];
    renderEntityFields(fieldsEl, cols, { numericGuard: true });
  }

  selectEl.addEventListener("change", () => {
    renderFields();
    for (const cb of kindChangeCbs) cb(selectEl.value);
  });

  async function load(): Promise<void> {
    const res = await apiFetch(`${apiBase}/api/entity-types`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `종류 목록 조회 실패 — HTTP ${res.status}${text ? `: ${text}` : ""}`,
      );
    }
    const data = (await res.json()) as { entityTypes?: EntityTypeResponseItem[] };
    columnsByType = new Map();
    subcategoriesByType = new Map();
    // placeholder 한 개만 남기고 옛 option 을 지운다(load 재호출 안전).
    while (selectEl.options.length > 1) selectEl.remove(1);
    for (const t of data.entityTypes ?? []) {
      columnsByType.set(t.typeName, Array.isArray(t.columns) ? t.columns : []);
      // 하위분류 갈래(S7) — 응답에 없거나 배열 아니면 빈 배열(드롭다운 placeholder 만·정직한 빈 상태).
      subcategoriesByType.set(t.typeName, Array.isArray(t.subcategories) ? t.subcategories : []);
      const opt = document.createElement("option");
      opt.value = t.typeName;
      opt.textContent = t.koName || t.typeName; // textContent — XSS 안전
      selectEl.appendChild(opt);
    }
    // load 가 끝나면 현재 선택 종류로 한 번 다시 그린다 — race 복구. load 가 끝나기 전 사용자가
    // 종류를 고르면 change 가 빈 맵으로 발화해 칸·하위분류가 빈 채 고정되는데, 이 재렌더가
    // 채워진 맵으로 그걸 복구한다. selectEl.value 가 비면 placeholder 만 그려 안전(no-op).
    renderFields();
  }

  /** load() 실패 메시지를 errorEl 에 채운다(빈 위장 0). 호출부 catch 가 console.error 와 함께 부른다. */
  function showLoadError(message: string): void {
    errorEl.textContent = message;
  }

  function getKind(): string {
    return selectEl.value;
  }

  function getFields(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const input of fieldsEl.querySelectorAll<HTMLInputElement>("[data-field-key]")) {
      const k = input.dataset["fieldKey"];
      const v = input.value.trim();
      if (k && v.length > 0) out[k] = v;
    }
    return out;
  }

  function getSubcategory(): string {
    return subcategorySelectEl.value;
  }

  function getNumericColumns(): Array<{ key: string; label: string }> {
    return filterNumericColumns(columnsByType.get(selectEl.value) ?? []);
  }

  function onKindChange(cb: (kind: string) => void): void {
    kindChangeCbs.push(cb);
  }

  /** 그 종류 option 이 selectEl 에 없으면 더한다(테스트가 selectEl.value 를 실제로 고를 수 있게). */
  function ensureKindOption(typeName: string): void {
    const exists = Array.from(selectEl.options).some((o) => o.value === typeName);
    if (!exists) {
      const opt = document.createElement("option");
      opt.value = typeName;
      opt.textContent = typeName;
      selectEl.appendChild(opt);
    }
  }

  function setColumnsForTest(typeName: string, cols: PickerColumn[]): void {
    columnsByType.set(typeName, cols);
    // 그 종류 option 이 없으면 더한다 — selectEl.value=typeName 이 실제로 선택되게 해
    // load() 의 fetch 통로를 안 타고도 getNumericColumns·onKindChange 를 검증할 수 있다.
    // (option 부재 종류는 select 가 value 를 "" 로 되돌리는 DOM 동작 회피.)
    ensureKindOption(typeName);
  }

  function setSubcategoriesForTest(typeName: string, subs: string[]): void {
    subcategoriesByType.set(typeName, subs);
    // setColumnsForTest 와 같은 양식 — 그 종류 option 을 보장해 selectEl.value=typeName change 가
    // renderSubcategories 를 그 종류 갈래로 채우게 한다(fetch 통로 무관 검증).
    ensureKindOption(typeName);
  }

  return {
    selectEl,
    fieldsEl,
    subcategorySelectEl,
    errorEl,
    load,
    showLoadError,
    getKind,
    getFields,
    getSubcategory,
    getNumericColumns,
    onKindChange,
    setColumnsForTest,
    setSubcategoriesForTest,
  };
}
