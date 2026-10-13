/**
 * entity-management-table.ts — 엔티티 관리 통합 표 순수 렌더 (엔티티 관리 통합 S6).
 *
 * renderEntityManagementTable 은 *순수 DOM 조립*. 행 배열을 인자로 받아 표 DOM 만 만들고
 * 네트워크는 일절 안 건드린다(실제 fetch 는 entity-management-api 별도 책임). 삭제 콜백은
 * 인자로 주입한 함수가 user 행·user 칩에서만 호출된다(네트워크는 호출자 책임).
 *
 * 표 한 행 = 한 엔티티 종류. 컬럼:
 *   - 분류 이름: 표시명(koName) + 동의어 칩(synonyms).
 *   - 영문키: typeName 직출력(그래프 플래그가 아니다).
 *   - 하위분류: subcategories 칩.
 *   - 칸: columns 칩(글자형/숫자형/날짜형 배지).
 *   - 라벨: attributes 칩(관계 키·끈 값은 데이터 계층에서 이미 빠진 결과).
 *   - 수정: 모든 종류에 수정 버튼, user 종류만 종류 삭제 버튼(code 10종은 읽기전용).
 *
 * S6 범위 — 수정 버튼·추가 폼은 만들지 않는다(S7 모달 몫). 칩 삭제는 user 출처 어휘만
 * (yaml 어휘는 읽기전용·id 없음). 끈 값 되살리기 토글도 S7 몫.
 *
 * data-* 속성으로 DOM 쿼리 가능하게 한다(옛 패널 테스트 양식 정합).
 */

import type {
  ColumnChip,
  EntityManagementRow,
  VocabChip,
} from "./entity-management-api";

/** 사용자 노출 문구 한 곳 모음 — 흩뿌리지 않는다(중앙화·i18n 대비). */
const LABELS = {
  colName: "분류 이름",
  colKey: "영문키",
  colSub: "하위분류",
  colColumn: "칸",
  colLabel: "라벨",
  colActions: "수정",
  editType: "수정",
  deleteType: "종류 삭제",
  deleteChip: "삭제",
  sourceCode: "코드",
  sourceUser: "추가",
  empty: "등록된 엔티티 종류가 없습니다.",
  chipDeleteTitle: "이 어휘 삭제",
  editTitle: "이 종류의 어휘 수정",
  badgeText: "글자",
  badgeNumber: "숫자",
  badgeDate: "날짜",
  badgeAlias: "별칭",
  aliasHelp: "이름 대신 사용 할 수 있음",
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
 * 어휘 칩 한 개를 만든다. user 출처 칩(id 보유)만 작은 삭제 버튼이 붙고, yaml 출처 칩은
 * 읽기전용이다(라우트 계약 — yaml 어휘는 삭제 불가). onDeleteVocab(id) 는 user 칩 삭제
 * 버튼 클릭 시만 호출한다.
 */
function renderChip(
  chip: VocabChip,
  onDeleteVocab: (id: string) => void,
): HTMLElement {
  const chipEl = el("span", "entity-mgmt-chip");
  chipEl.dataset.chip = "true";
  chipEl.dataset.source = chip.source;
  chipEl.appendChild(el("span", "entity-mgmt-chip-text", chip.value));
  if (chip.source === "user" && chip.id !== null) {
    const chipId = chip.id;
    const delBtn = el("button", "entity-mgmt-chip-delete", LABELS.deleteChip);
    delBtn.type = "button";
    delBtn.title = LABELS.chipDeleteTitle;
    delBtn.dataset.chipDelete = "true";
    delBtn.addEventListener("click", () => onDeleteVocab(chipId));
    chipEl.appendChild(delBtn);
  }
  return chipEl;
}

/** 표 칸 한 개에 어휘 칩들을 그린다(하위분류·라벨 칸). 빈 배열이면 빈 칸. */
function renderChipCell(
  chips: VocabChip[],
  onDeleteVocab: (id: string) => void,
): HTMLElement {
  const cell = el("td", "entity-mgmt-chip-cell");
  for (const chip of chips) cell.appendChild(renderChip(chip, onDeleteVocab));
  return cell;
}

/** 표의 칸 셀 — 칸 이름과 글자형/숫자형/날짜형 배지만 보이고, 편집은 행 수정 버튼으로 들어간다. */
function renderColumnCell(columns: ColumnChip[]): HTMLElement {
  const cell = el("td", "entity-mgmt-chip-cell entity-mgmt-column-table-cell");
  cell.dataset.columnCell = "true";
  for (const col of columns) {
    const chip = el("span", "entity-mgmt-column-chip");
    chip.dataset.columnChip = "true";
    chip.dataset.dataType = col.dataType;
    if (col.semantic) chip.dataset.semantic = col.semantic;
    if (col.semantic === "alias") chip.title = col.helpText ?? LABELS.aliasHelp;
    chip.appendChild(el("span", "entity-mgmt-column-chip-text", col.key));
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
    if (col.semantic === "alias") badge.title = col.helpText ?? LABELS.aliasHelp;
    chip.appendChild(badge);
    cell.appendChild(chip);
  }
  return cell;
}

/**
 * 엔티티 관리 통합 표 순수 렌더. 행 배열 → 표 DOM. 0건이면 빈 안내만(가짜 샘플 0).
 * onDeleteType(typeName) 은 user 종류 행의 종류 삭제 버튼에서만, onDeleteVocab(id) 는 user
 * 출처 칩 삭제 버튼에서만 호출한다(네트워크는 호출자 책임). onEditType(typeName) 은 모든
 * 종류 행(code·user 다)의 수정 버튼에서 호출한다 — 어휘 칩 편집은 code 종류도 가능하다
 * (종류 이름은 못 고치고 어휘만·D4). 표는 버튼을 그리고 콜백만 부른다(모달·fetch 안 건드림).
 */
export function renderEntityManagementTable(
  rows: EntityManagementRow[],
  onDeleteType: (typeName: string) => void,
  onDeleteVocab: (id: string) => void,
  onEditType: (typeName: string) => void,
): HTMLElement {
  const wrap = el("div", "entity-mgmt-table-wrap");
  wrap.dataset.section = "entity-management-table";

  if (rows.length === 0) {
    const empty = el("p", "entity-mgmt-empty", LABELS.empty);
    empty.dataset.entityMgmtEmpty = "true";
    wrap.appendChild(empty);
    return wrap;
  }

  const table = el("table", "entity-mgmt-table");
  const thead = el("thead");
  const headRow = el("tr");
  for (const [cls, text] of [
    ["entity-mgmt-th-name", LABELS.colName],
    ["entity-mgmt-th-key", LABELS.colKey],
    ["entity-mgmt-th-sub", LABELS.colSub],
    ["entity-mgmt-th-column", LABELS.colColumn],
    ["entity-mgmt-th-label", LABELS.colLabel],
    ["entity-mgmt-th-actions", LABELS.colActions],
  ] as const) {
    headRow.appendChild(el("th", cls, text));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr", "entity-mgmt-row");
    tr.dataset.entityMgmtRow = "true";
    tr.dataset.source = row.source;
    tr.dataset.typeName = row.typeName;

    // ── 분류 이름: 표시명 + 출처 배지 + 동의어 칩 ──────────────────────────────
    const nameCell = el("td", "entity-mgmt-name-cell");
    nameCell.appendChild(el("span", "entity-mgmt-ko", row.koName));
    const badge = el(
      "span",
      "entity-mgmt-source-badge",
      row.source === "code" ? LABELS.sourceCode : LABELS.sourceUser,
    );
    badge.dataset.source = row.source;
    nameCell.appendChild(badge);
    // 동의어 칩은 분류 이름 칸 안에 함께 그린다(분류 이름 = 표시명 + 동의어).
    const synWrap = el("span", "entity-mgmt-synonyms");
    for (const chip of row.synonyms) synWrap.appendChild(renderChip(chip, onDeleteVocab));
    nameCell.appendChild(synWrap);
    tr.appendChild(nameCell);

    // ── 영문키: typeName 직출력 ────────────────────────────────────────────────
    const keyCell = el("td", "entity-mgmt-key-cell");
    keyCell.appendChild(el("span", "entity-mgmt-key", row.typeName));
    tr.appendChild(keyCell);

    // ── 하위분류 / 칸 / 라벨 칩 칸 ────────────────────────────────────────────
    tr.appendChild(renderChipCell(row.subcategories, onDeleteVocab));
    tr.appendChild(renderColumnCell(row.columns));
    tr.appendChild(renderChipCell(row.labels, onDeleteVocab));

    // ── 수정·삭제: 수정은 모든 종류(어휘만·이름 고정), 삭제는 user 종류만 ─────────
    const actionCell = el("td", "entity-mgmt-action-cell");
    const editTypeName = row.typeName;
    const editBtn = el("button", "entity-mgmt-edit-type", LABELS.editType);
    editBtn.type = "button";
    editBtn.title = LABELS.editTitle;
    editBtn.dataset.editType = "true";
    editBtn.addEventListener("click", () => onEditType(editTypeName));
    actionCell.appendChild(editBtn);
    if (row.deletableTypeName !== null) {
      const typeName = row.deletableTypeName;
      const delBtn = el("button", "entity-mgmt-delete-type", LABELS.deleteType);
      delBtn.type = "button";
      delBtn.dataset.deleteType = "true";
      delBtn.addEventListener("click", () => onDeleteType(typeName));
      actionCell.appendChild(delBtn);
    }
    tr.appendChild(actionCell);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}
