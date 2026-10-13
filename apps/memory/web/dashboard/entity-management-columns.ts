/**
 * entity-management-columns.ts — 종류 수정 모달 안 "칸" 섹션 순수 렌더 (엔티티 관리 통합 S8).
 *
 * 칸(columns)은 그 종류로 기록하는 글에 곁들이는 색인 속성이다 — 예를 들어 가계부 종류의
 * '금액' 을 숫자형 칸으로 만들면, 계산 탭에서 그 칸의 합계·평균을 낼 수 있다(범용·도메인
 * 무지). 옛 패널엔 칸 편집 화면이 없어 라우트만 있었는데, 이 섹션이 그 자리를 채운다.
 *
 * 자리 — 칩 3칸(동의어·하위분류·라벨) + 관계 칸 아래, 종류 수정 모달의 4번째 섹션이다
 * (관계 섹션 renderTypeRelations 와 동형 패턴). 추가 모달엔 칸 입력이 없다(종류 저장 전엔
 * 라우트가 isPlacementType 400 으로 막아 — 라벨처럼 안내 문구만).
 *
 * 설계 정신 — 순수 렌더와 콜백 분리(renderTypeRelations 정합):
 *   - renderColumnSection 은 *순수 DOM 조립*. 칸 칩 데이터를 인자로 받아 DOM 만 만든다.
 *   - 네트워크(add/remove/reload) 는 modal-edit 이 주입한 콜백에 맡긴다(Mock 클래스 0).
 *   - 칩 타입 배지([숫자]/[글자]/[날짜])는 col.dataType 으로 그린다(계산 탭과 같은 출처).
 *   - 추가 폼 datatype 라디오 기본값 = 글자형(라우트 text 기본과 일치).
 *
 * source 가름(S7b 끄기 토글 패턴 정합) — code 종류 칸은 읽기전용(타입 배지만·추가/삭제 없음),
 * user 종류 칸만 추가/삭제를 연다. 칸 칩 삭제 id 는 user 행만 보유(buildColumnChips 조인).
 *
 * silent fallback 금지: 빈 목록(칸 0개)은 "칸 없음" 안내만(정직한 빈 상태). 추가/삭제 실패는
 * 라우트 메시지를 그대로 노출한다(부분 실패 = 옵션 ⓐ: 칸 성공·숫자형 실패는 칸을 살린다).
 */

import { showToast } from "./form/toast";
import {
  validateColumnKey,
  summarizeAddColumnResult,
  type ColumnDataType,
} from "./entity-management-save";
import type { ColumnChip, AddColumnApiResult } from "./entity-management-api";

/** 사용자 노출 문구 한 곳 모음 — 흩뿌리지 않는다(중앙화·i18n 대비). */
const LABELS = {
  title: "칸 설정",
  intro:
    "이 종류로 기록하는 글에 곁들일 칸을 정합니다. 숫자형은 계산 탭에서 합계·평균 대상이 되고, 날짜형은 일정탭 후보가 됩니다. 글자형은 메모용입니다. 칸은 새 종류에만 더할 수 있고, 기본 종류(사람·작품 등)의 칸은 읽기전용입니다.",
  listTitle: "칸 목록",
  addTitle: "새 칸 추가",
  keyPlaceholder: "칸 이름 (예: 금액)",
  typeText: "글자형",
  typeNumber: "숫자형",
  typeDate: "날짜형",
  addBtn: "칸 추가",
  deleteBtn: "삭제",
  badgeText: "글자",
  badgeNumber: "숫자",
  badgeDate: "날짜",
  badgeAlias: "별칭",
  aliasHelp: "이름 대신 사용 할 수 있음",
  empty: "이 종류에 칸이 없습니다.",
  readonlyNote: "기본 종류의 칸은 읽기전용입니다.",
  needKey: "칸 이름을 입력하세요.",
  addFailed: "칸 추가에 실패했습니다",
  deleteFailed: "칸 삭제에 실패했습니다",
  addedToast: "칸을 추가했습니다.",
  deletedToast: "칸을 삭제했습니다.",
  dataTypePartialFail: (key: string, message: string): string =>
    `칸 '${key}' 은(는) 만들었으나 타입 지정 실패: ${message} (글자형으로 남았습니다·다시 시도하세요)`,
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 칸 섹션이 받는 의존 — 현재 종류 + source(code/user 가름) + 칸 칩 목록 + 추가·삭제·목록
 * 콜백. 네트워크는 modal-edit 이 주입한다(panel api 재사용·Mock 0·renderTypeRelations 정합).
 */
export interface ColumnSectionDeps {
  /** 현재 종류 이름(addColumn payload typeName). */
  typeName: string;
  /** 종류 출처 — "user" 면 추가/삭제를 열고, "code" 면 읽기전용(타입 배지만). */
  source: "code" | "user";
  /** 그 종류의 칸 칩 목록(buildColumnChips 산출). reload 후 latestColumns 로 갱신. */
  columns: ColumnChip[];
  /** 칸 추가 — columns 후 (number/date) column_types 순차 POST. 두 호출 결과를 돌려준다(부분 실패 옵션 ⓐ). */
  addColumn(columnKey: string, dataType: ColumnDataType): Promise<AddColumnApiResult>;
  /** user 칸 삭제 — DELETE /api/classify-vocab/:id(라우트가 column_types 짝도 지운다). 실패 시 throw. */
  removeColumn(columnEntryId: string): Promise<void>;
  /** 추가·삭제 성공 직후 호출 — panel 이 표·칸을 다시 불러온다(reload). */
  onReload(): void | Promise<void>;
  /** reload 후 그 종류 칸 최신 목록을 panel 메모리에서 다시 받아 준다(목록 갱신). */
  latestColumns(): ColumnChip[];
}

/** 칸 칩 한 개를 만든다 — 칸 키 + 타입 배지([숫자]/[글자]) + (user 면) 삭제 버튼. */
function renderColumnChip(
  col: ColumnChip,
  editable: boolean,
  onRemove: (id: string) => void,
): HTMLElement {
  const chip = el("span", "entity-mgmt-column-chip");
  chip.dataset.columnChip = "true";
  chip.dataset.dataType = col.dataType;
  if (col.semantic) chip.dataset.semantic = col.semantic;
  if (col.semantic === "alias") chip.title = col.helpText ?? LABELS.aliasHelp;
  chip.appendChild(el("span", "entity-mgmt-column-chip-text", col.key));

  // 타입 배지 — 숫자형·날짜형·글자형을 같은 출처에서 구분한다.
  const badgeKind = col.semantic === "alias" ? "alias" : col.dataType;
  const badge = el(
    "span",
    `entity-mgmt-column-type-badge entity-mgmt-column-type-badge--${badgeKind}`,
    col.semantic === "alias"
      ? LABELS.badgeAlias
      : col.dataType === "number"
        ? LABELS.badgeNumber
        : col.dataType === "date"
          ? LABELS.badgeDate
          : LABELS.badgeText,
  );
  badge.dataset.dataType = col.dataType;
  if (col.semantic === "alias") badge.title = col.helpText ?? LABELS.aliasHelp;
  chip.appendChild(badge);

  // user 칸이면서 삭제 id 가 있을 때만 삭제 버튼(code 칸·읽기전용 칸은 안 붙음).
  if (editable && col.id !== null) {
    const id = col.id;
    const rm = el("button", "entity-mgmt-column-chip-remove", LABELS.deleteBtn);
    rm.type = "button";
    rm.dataset.columnDelete = "true";
    rm.addEventListener("click", () => onRemove(id));
    chip.appendChild(rm);
  }
  return chip;
}

/**
 * 모달 안 칸 섹션 통째 — 제목 + 안내 + (user 면) 추가 폼(칸 이름·datatype 라디오) + 칸 목록.
 * code 종류면 추가 폼을 안 그리고 읽기전용 안내만 둔다(source 가름·S7b 토글 패턴 정합).
 * 추가·삭제 직후 목록을 다시 그린다(latestColumns 로 갱신). 반환은 칸 섹션 컨테이너라 테스트가
 * 그 안 폼·칩을 data-* 로 찾는다.
 */
export function renderColumnSection(deps: ColumnSectionDeps): HTMLElement {
  // 그 종류 칸 목록(가변) — 추가·삭제 후 latestColumns 로 다시 받아 갱신한다.
  let currentColumns: ColumnChip[] = deps.columns;
  const editable = deps.source === "user";

  const section = el("div", "entity-mgmt-column-section");
  section.dataset.section = "entity-mgmt-columns";

  section.appendChild(el("h3", "entity-mgmt-column-section-label", LABELS.title));
  section.appendChild(el("p", "entity-mgmt-column-hint", LABELS.intro));

  // ── 부분 실패 박스(옵션 ⓐ) — 칸 성공·숫자형 실패 메시지를 담는다(.modal-error 와 별도). ──
  const failBox = el("div", "entity-mgmt-column-fail");
  failBox.dataset.columnFail = "true";
  failBox.style.display = "none";

  // ── 추가 폼: 칸 이름 + datatype 라디오 3개 (user 종류만) ──────────────────────────
  let keyInput: HTMLInputElement | undefined;
  let textRadio: HTMLInputElement | undefined;
  let numberRadio: HTMLInputElement | undefined;
  let dateRadio: HTMLInputElement | undefined;
  let addBtn: HTMLButtonElement | undefined;

  if (editable) {
    const addForm = el("form", "entity-mgmt-column-add");
    addForm.appendChild(el("h4", "entity-mgmt-column-add-title", LABELS.addTitle));

    keyInput = el("input", "entity-mgmt-column-input");
    keyInput.type = "text";
    keyInput.dataset.columnKeyInput = "true";
    keyInput.placeholder = LABELS.keyPlaceholder;
    addForm.appendChild(keyInput);

    // datatype 라디오 3개 — 기본 선택 = 글자형(라우트 text 기본 일치). 좁으면 세로로(flex-wrap).
    const radioWrap = el("div", "entity-mgmt-column-radio-wrap");
    const radioName = `entity-mgmt-column-type-${deps.typeName}`;
    const mkRadio = (
      value: ColumnDataType,
      labelText: string,
      checked: boolean,
    ): HTMLInputElement => {
      const label = el("label", "entity-mgmt-column-radio");
      const radio = el("input");
      radio.type = "radio";
      radio.name = radioName;
      radio.value = value;
      radio.checked = checked;
      radio.dataset.columnType = value;
      label.appendChild(radio);
      label.appendChild(el("span", "entity-mgmt-column-radio-text", labelText));
      radioWrap.appendChild(label);
      return radio;
    };
    textRadio = mkRadio("text", LABELS.typeText, true);
    numberRadio = mkRadio("number", LABELS.typeNumber, false);
    dateRadio = mkRadio("date", LABELS.typeDate, false);
    addForm.appendChild(radioWrap);

    addBtn = el("button", "entity-mgmt-column-add-btn", LABELS.addBtn);
    addBtn.type = "submit";
    addForm.appendChild(addBtn);

    addForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void addColumnThenReload();
    });
    section.appendChild(addForm);
  } else {
    section.appendChild(
      el("p", "entity-mgmt-column-readonly", LABELS.readonlyNote),
    );
  }

  section.appendChild(failBox);

  // ── 칸 목록 ────────────────────────────────────────────────────────────────
  section.appendChild(el("h4", "entity-mgmt-column-list-title", LABELS.listTitle));
  const listHost = el("div", "entity-mgmt-column-chip-wrap");
  section.appendChild(listHost);

  /** 그 종류 칸 목록을 다시 그린다(currentColumns 기준·새 fetch 0). */
  function drawList(): void {
    listHost.textContent = "";
    if (currentColumns.length === 0) {
      const empty = el("span", "entity-mgmt-column-empty", LABELS.empty);
      empty.dataset.columnEmpty = "true";
      listHost.appendChild(empty);
      return;
    }
    for (const col of currentColumns) {
      listHost.appendChild(
        renderColumnChip(col, editable, (id) => void removeColumnThenReload(id)),
      );
    }
  }

  async function removeColumnThenReload(id: string): Promise<void> {
    try {
      await deps.removeColumn(id);
      showToast(LABELS.deletedToast, "success");
      await deps.onReload();
      currentColumns = deps.latestColumns();
      drawList();
    } catch (e) {
      showToast(`${LABELS.deleteFailed}: ${(e as Error).message}`, "error");
    }
  }

  async function addColumnThenReload(): Promise<void> {
    if (!keyInput || !numberRadio || !dateRadio || !addBtn) return;
    const keyCheck = validateColumnKey(keyInput.value);
    if (!keyCheck.ok) {
      showToast(LABELS.needKey, "error");
      return;
    }
    const dataType: ColumnDataType = dateRadio.checked
      ? "date"
      : numberRadio.checked
        ? "number"
        : "text";
    const columnKey = keyInput.value.trim();
    addBtn.disabled = true;
    try {
      const apiResult = await deps.addColumn(columnKey, dataType);
      const summary = summarizeAddColumnResult(
        apiResult.columnsResult,
        apiResult.columnTypesResult,
      );
      if (!summary.columnCreated) {
        // 칸 자체 실패(기존 10종 동결·칸↔라벨/관계/항목동의어 충돌·중복) — 라우트 메시지 노출.
        showToast(`${LABELS.addFailed}: ${summary.columnFailMessage}`, "error");
        return;
      }
      // 칸 생성 성공 — 표·칸 즉시 반영(부분 성공도 reload). 입력은 비운다(재시도 멱등).
      keyInput.value = "";
      await deps.onReload();
      currentColumns = deps.latestColumns();
      drawList();
      if (summary.allOk) {
        failBox.style.display = "none";
        showToast(LABELS.addedToast, "success");
        return;
      }
      // 부분 실패(옵션 ⓐ) — 칸은 글자형으로 살아 있고, 숫자형 지정만 실패. 박스에 안내(롤백 0).
      failBox.textContent = LABELS.dataTypePartialFail(columnKey, summary.dataTypeFailMessage);
      failBox.style.display = "";
    } catch (e) {
      // 네트워크·예외(라우트가 아닌 fetch 실패 등) — 그대로 노출(빈 상태 위장 0).
      showToast(`${LABELS.addFailed}: ${(e as Error).message}`, "error");
    } finally {
      addBtn.disabled = false;
    }
  }

  // 첫 그리기 — 그 종류 칸 목록을 그린다(새 fetch 0).
  drawList();

  return section;
}
