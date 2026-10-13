/**
 * entity-management-modal-edit.ts — 종류 어휘 수정 모달 (엔티티 관리 통합 S7a).
 *
 * 표 행 수정 버튼 → 이 모달. panel 이 이미 들고 있는 마지막 list() 결과의 그 종류 행을
 * 넘겨받아(새 fetch 0) 동의어·하위분류·라벨 칩 3칸을 보인다. user 출처 칩(id 보유)만 ✕
 * 삭제(DELETE /api/classify-vocab/:id), yaml 출처 칩(id=null)은 읽기전용이다(라우트 계약).
 * 칩 추가는 POST /api/classify-vocab. 추가·삭제 성공 시 모달 칩을 다시 그리고 panel.reload.
 *
 * 종류 이름(표시명·영문키) 인라인 수정 입력·버튼은 없다(D4) — 상단에 "이름을 바꾸려면
 * 삭제 후 새로 추가하세요" 안내 문구만 둔다(읽기전용). PUT/PATCH api·라우트 호출 0.
 *
 * 끄기/되살리기 토글(S7b·출처 구분):
 *   - 켜진 칩 = user 출처(source==="user"&&id!==null) → ✕삭제만(DELETE /classify-vocab/:id).
 *   - 켜진 칩 = yaml·코드 10종 출처(그 외) → "끄기" 토글(POST /classify-vocab/override).
 *   - 끈 칩 = 가림표(tombstone) → 흐리게(.entity-mgmt-chip--disabled) + "되살리기" 토글
 *     (DELETE /classify-vocab/override). user 칩엔 끄기 버튼을 안 그린다(라우트 400 거부·
 *     source 필드만 보고 판정·자체 추론 0). 끄기 대상 칸은 3칸(synonyms·subcategories·
 *     attributes) — 라우트 OVERRIDE_SLOTS·모달 3칸과 일치.
 *
 * 관계 칸(S7b·라이브 정정·모달 편입): 칩 3칸 아래에 그 종류가 *출발(source)* 인 관계만
 * 목록·편집한다(renderTypeRelations). 옛 "종류 표 아래 별 섹션"을 폐기하고 모달 안으로 옮긴
 * 결정 — 별 섹션이 화면을 길게 만들어서다. 추가 폼 출발 종류는 *현재 종류 고정*(출발 select
 * 없음)·도착 한 종류·관계키·관계명. user 관계만 삭제(code 관계는 삭제 버튼 없음). 그 종류 출발
 * 관계 목록·도착 종류 옵션·관계 추가/삭제 콜백은 panel 이 주입한다(relation 라우트 재사용).
 *
 * 이 모달 자체는 fetch 를 안 부른다 — 칩 추가·삭제·끄기·되살리기·관계 추가·삭제는 주입한
 * 콜백(addVocab/removeVocab/disableVocab/restoreVocab/addRelation/removeRelation)에 맡겨,
 * 단위 검증이 plain 객체 주입만으로 흐름을 본다(Mock 클래스 0). 끈 칩·그 종류 출발 관계는
 * latestDisabled·latestRelations 콜백으로 reload 후 다시 받는다.
 */

import { showToast } from "./form/toast";
import { createModalShell, el } from "./entity-management-modal-fields";
import { renderTypeRelations } from "./entity-management-relations";
import { renderColumnSection } from "./entity-management-columns";
import type { ColumnDataType } from "./entity-management-save";
import type {
  EntityManagementRow,
  VocabChip,
  DisabledChip,
  ColumnChip,
  AddColumnApiResult,
} from "./entity-management-api";
import type { EntityTypeRow } from "./entity-types-panel-api";
import type {
  RelationVocabRow,
  AddRelationVocabPayload,
} from "./relation-vocab-panel-api";

/** 사용자 노출 문구 한 곳 모음 — 흩뿌리지 않는다(중앙화·i18n 대비). */
const LABELS = {
  title: (koName: string): string => `${koName} 어휘 수정`,
  renameNote: "이름(표시명·영문키)을 바꾸려면 이 종류를 삭제 후 새로 추가하세요.",
  synonyms: "동의어",
  subcategories: "하위분류",
  attributes: "라벨",
  addHint: "단어 입력 후 추가",
  add: "추가",
  chipRemove: "삭제",
  chipRemoveTitle: "이 어휘 삭제",
  empty: "등록된 어휘 없음",
  addFailed: "어휘 추가에 실패했습니다",
  removeFailed: "어휘 삭제에 실패했습니다",
  added: "어휘를 추가했습니다.",
  removed: "어휘를 삭제했습니다.",
  // 끄기/되살리기 토글(S7b).
  disable: "끄기",
  disableTitle: "이 기본 어휘를 끈다(새 입력 글부터 빠짐·되살릴 수 있음)",
  restore: "되살리기",
  restoreTitle: "끈 어휘를 다시 켠다",
  disableFailed: "어휘 끄기에 실패했습니다",
  disabled: "어휘를 껐습니다.",
  restoreFailed: "어휘 되살리기에 실패했습니다",
  restored: "어휘를 되살렸습니다.",
};

/** 수정 모달이 다루는 한 slot — 라우트 slot 키와 한국어 라벨. */
type EditSlot = "synonyms" | "subcategories" | "attributes";

/** 수정 모달 열기 인자 — 칩 추가·삭제·끄기·되살리기 콜백(네트워크는 panel 책임) + reload. */
export interface OpenEditModalDeps {
  /** 칩 추가 — POST /api/classify-vocab(typeName·slot·value). 실패 시 throw(라우트 400). */
  addVocab(typeName: string, slot: EditSlot, value: string): Promise<void>;
  /** 칩 삭제 — DELETE /api/classify-vocab/:id. 실패 시 throw. */
  removeVocab(id: string): Promise<void>;
  /** 기본 어휘 끄기 — POST /api/classify-vocab/override. 실패 시 throw(라우트 400). */
  disableVocab(typeName: string, slot: EditSlot, value: string): Promise<void>;
  /** 끈 어휘 되살리기 — DELETE /api/classify-vocab/override. 실패 시 throw. */
  restoreVocab(typeName: string, slot: EditSlot, value: string): Promise<void>;
  /** 추가·삭제·끄기·되살리기·관계 추가/삭제 성공 직후 호출 — panel 이 표를 다시 그린다. */
  onReload(): void | Promise<void>;
  /** 현재 종류의 최신 행을 panel 메모리에서 다시 찾아 준다(새 fetch 0·모달 칩 갱신). */
  latestRow(typeName: string): EntityManagementRow | undefined;
  /** 현재 종류의 최신 끈 칩 목록을 panel 메모리에서 다시 받아 준다(reload 후 끈 칩 갱신). */
  latestDisabled(typeName: string): DisabledChip[];
  /** 도착 종류 select 옵션의 단일 출처 — 통합 entityTypes 를 그대로 넘긴다(관계 칸). */
  entityTypes(): EntityTypeRow[];
  /** 관계 추가 — POST /api/relation-vocab(relation 라우트 재사용). 실패 시 throw(라우트 400). */
  addRelation(payload: AddRelationVocabPayload): Promise<void>;
  /** user 관계 삭제 — DELETE /api/relation-vocab/:relationKey. 실패 시 throw. */
  removeRelation(relationKey: string): Promise<void>;
  /** reload 후 그 종류 출발 관계 최신 목록을 panel 메모리에서 다시 받아 준다(관계 갱신). */
  latestRelations(typeName: string): RelationVocabRow[];
  /** 칸 추가(S8) — columns 후 (number/date) column_types 순차 POST. 두 호출 결과를 돌려준다(부분 실패 옵션 ⓐ). */
  addColumn(
    typeName: string,
    columnKey: string,
    dataType: ColumnDataType,
  ): Promise<AddColumnApiResult>;
  /** user 칸 삭제(S8·길 B) — DELETE /api/classify-vocab/:id(라우트가 column_types 짝도 지운다). */
  removeColumn(columnEntryId: string): Promise<void>;
  /** reload 후 그 종류 칸 최신 목록을 panel 메모리에서 다시 받아 준다(칸 갱신). */
  latestColumns(typeName: string): ColumnChip[];
}

/**
 * 수정 모달을 만들어 host 에 붙인다. row 는 panel 이 들고 있는 그 종류 행(새 fetch 0).
 * disabledChips 는 그 종류의 끈 칩 목록(buildDisabledChips 산출)으로, 켜진 칩 뒤에 흐리게
 * 이어 그린다(되살리기 토글 부착). relations 는 그 종류가 출발인 관계 목록(buildTypeRelations
 * 산출)으로, 칩 3칸 아래 관계 칸에 그린다(출발 고정 추가 폼·목록). 반환은 오버레이라 테스트가
 * 그 안 칩·버튼·관계 폼을 data-* 로 찾는다.
 */
export function openEditModal(
  row: EntityManagementRow,
  deps: OpenEditModalDeps,
  disabledChips: DisabledChip[] = [],
  relations: RelationVocabRow[] = [],
  columns: ColumnChip[] = [],
  host: HTMLElement = document.body,
): HTMLElement {
  const shell = createModalShell(LABELS.title(row.koName), () => shell.close());

  // 끈 칩 목록(가변) — reload 후 latestDisabled 로 다시 받아 갱신한다.
  let currentDisabled: DisabledChip[] = disabledChips;

  // ── 이름 인라인 수정 없음(D4) — 읽기전용 안내 문구만. PUT/PATCH 호출 0 ─────────
  const note = el("p", "entity-mgmt-rename-note", LABELS.renameNote);
  note.dataset.renameNote = "true";
  shell.body.appendChild(note);

  // slot 3칸을 그리는 host 들 — reload 후 그 자리만 다시 그린다.
  const slotHosts: Record<EditSlot, HTMLElement> = {
    synonyms: el("div", "entity-mgmt-edit-slot"),
    subcategories: el("div", "entity-mgmt-edit-slot"),
    attributes: el("div", "entity-mgmt-edit-slot"),
  };

  function chipsOf(r: EntityManagementRow, slot: EditSlot): VocabChip[] {
    if (slot === "synonyms") return r.synonyms;
    if (slot === "subcategories") return r.subcategories;
    return r.labels;
  }

  async function removeChipThenRefresh(id: string): Promise<void> {
    try {
      await deps.removeVocab(id);
      showToast(LABELS.removed, "success");
      await deps.onReload();
      refreshAllSlots();
    } catch (e) {
      showToast(`${LABELS.removeFailed}: ${(e as Error).message}`, "error");
    }
  }

  async function addChipThenRefresh(
    slot: EditSlot,
    value: string,
    input: HTMLInputElement,
  ): Promise<void> {
    const v = value.trim();
    if (v.length === 0) return;
    try {
      await deps.addVocab(row.typeName, slot, v);
      input.value = "";
      showToast(LABELS.added, "success");
      await deps.onReload();
      refreshAllSlots();
    } catch (e) {
      shell.setError(`${LABELS.addFailed}: ${(e as Error).message}`);
    }
  }

  /** 기본 어휘 끄기 — POST override → reload → 끈 칩 갱신. user 칩엔 이 버튼이 안 붙는다. */
  async function disableChipThenRefresh(slot: EditSlot, value: string): Promise<void> {
    try {
      await deps.disableVocab(row.typeName, slot, value);
      showToast(LABELS.disabled, "success");
      await deps.onReload();
      refreshAllSlots();
    } catch (e) {
      shell.setError(`${LABELS.disableFailed}: ${(e as Error).message}`);
    }
  }

  /** 끈 어휘 되살리기 — DELETE override → reload → 끈 칩 갱신. */
  async function restoreChipThenRefresh(slot: EditSlot, value: string): Promise<void> {
    try {
      await deps.restoreVocab(row.typeName, slot, value);
      showToast(LABELS.restored, "success");
      await deps.onReload();
      refreshAllSlots();
    } catch (e) {
      shell.setError(`${LABELS.restoreFailed}: ${(e as Error).message}`);
    }
  }

  function drawSlot(slot: EditSlot, label: string): void {
    const slotHost = slotHosts[slot];
    slotHost.textContent = "";
    slotHost.dataset.editSlot = slot;
    slotHost.appendChild(el("span", "entity-mgmt-edit-slot-label", label));

    const chips = chipsOf(row, slot);
    const disabledHere = currentDisabled.filter((dc) => dc.slot === slot);
    const chipWrap = el("div", "entity-mgmt-edit-chip-wrap");
    // 켜진 칩·끈 칩 둘 다 0건일 때만 "등록된 어휘 없음" 안내(끈 칩이 있으면 그게 보인다).
    if (chips.length === 0 && disabledHere.length === 0) {
      chipWrap.appendChild(el("span", "entity-mgmt-edit-empty", LABELS.empty));
    }
    for (const chip of chips) {
      const chipEl = el("span", "entity-mgmt-edit-chip");
      chipEl.dataset.chip = "true";
      chipEl.dataset.source = chip.source;
      chipEl.appendChild(el("span", "entity-mgmt-edit-chip-text", chip.value));
      // 출처로 가른다(source 필드만 보고 판정·자체 추론 0):
      //   - user 출처 칩(id 보유) → ✕삭제만(DELETE /classify-vocab/:id). 끄기 버튼 안 붙임.
      //   - yaml·코드 10종 출처(그 외) → "끄기" 토글(POST override). 사용자 값만 직접 삭제.
      if (chip.source === "user" && chip.id !== null) {
        const chipId = chip.id;
        const rm = el("button", "entity-mgmt-edit-chip-remove", LABELS.chipRemove);
        rm.type = "button";
        rm.title = LABELS.chipRemoveTitle;
        rm.dataset.chipDelete = "true";
        rm.addEventListener("click", () => void removeChipThenRefresh(chipId));
        chipEl.appendChild(rm);
      } else {
        const value = chip.value;
        const disableBtn = el("button", "entity-mgmt-chip-toggle", LABELS.disable);
        disableBtn.type = "button";
        disableBtn.title = LABELS.disableTitle;
        disableBtn.dataset.chipDisable = "true";
        disableBtn.addEventListener("click", () =>
          void disableChipThenRefresh(slot, value),
        );
        chipEl.appendChild(disableBtn);
      }
      chipWrap.appendChild(chipEl);
    }

    // 끈 칩(가림표·tombstone) — 켜진 칩 뒤에 흐리게 이어 그린다(되살리기 토글 부착).
    // disabledHere 는 이 slot 의 끈 값만(타 slot 끈 칩 안 섞임).
    for (const dc of disabledHere) {
      const chipEl = el("span", "entity-mgmt-edit-chip entity-mgmt-chip--disabled");
      chipEl.dataset.chip = "true";
      chipEl.dataset.disabled = "true";
      chipEl.appendChild(el("span", "entity-mgmt-edit-chip-text", dc.value));
      const value = dc.value;
      const restoreBtn = el(
        "button",
        "entity-mgmt-chip-toggle entity-mgmt-chip-toggle--restore",
        LABELS.restore,
      );
      restoreBtn.type = "button";
      restoreBtn.title = LABELS.restoreTitle;
      restoreBtn.dataset.chipRestore = "true";
      restoreBtn.addEventListener("click", () =>
        void restoreChipThenRefresh(slot, value),
      );
      chipEl.appendChild(restoreBtn);
      chipWrap.appendChild(chipEl);
    }
    slotHost.appendChild(chipWrap);

    // 칩 추가 입력 + 버튼(POST). 엔터로도 추가.
    const addWrap = el("div", "entity-mgmt-edit-add");
    const input = el("input", "entity-mgmt-edit-add-input");
    input.type = "text";
    input.dataset.addInput = slot;
    input.placeholder = LABELS.addHint;
    input.addEventListener("keydown", (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key === "Enter") {
        ev.preventDefault();
        void addChipThenRefresh(slot, input.value, input);
      }
    });
    const addBtn = el("button", "entity-mgmt-edit-add-btn", LABELS.add);
    addBtn.type = "button";
    addBtn.dataset.addBtn = slot;
    addBtn.addEventListener("click", () =>
      void addChipThenRefresh(slot, input.value, input),
    );
    addWrap.appendChild(input);
    addWrap.appendChild(addBtn);
    slotHost.appendChild(addWrap);
  }

  /**
   * 칩 3칸을 다시 그린다. refreshDisabled=true 면(끄기·되살리기·추가·삭제 후) panel 메모리
   * 에서 끈 칩 최신 목록을 다시 받아 갱신한다. 첫 렌더(refreshDisabled=false)는 생성자가
   * 받은 disabledChips(panel 이 buildDisabledChips 로 모은 목록)을 그대로 쓴다 — 첫 그리기에서
   * latestDisabled 로 덮어쓰면 panel 이 넘긴 끈 칩이 사라진다.
   */
  function refreshAllSlots(refreshDisabled = true): void {
    // panel 메모리에서 최신 행을 다시 찾아 칩 3칸을 그린다(새 fetch 0). 종류가 사라졌으면
    // (삭제됨) 옛 행 데이터로 그대로 그린다(모달은 곧 닫히는 게 정상 — 방어적 유지).
    const latest = deps.latestRow(row.typeName);
    if (latest) {
      row.synonyms = latest.synonyms;
      row.subcategories = latest.subcategories;
      row.labels = latest.labels;
    }
    // 끈 칩은 끄기·되살리기·추가·삭제 후에만 panel 메모리에서 다시 받아 갱신한다(reload 반영).
    if (refreshDisabled) currentDisabled = deps.latestDisabled(row.typeName);
    drawSlot("synonyms", LABELS.synonyms);
    drawSlot("subcategories", LABELS.subcategories);
    drawSlot("attributes", LABELS.attributes);
  }

  // 섹션 부착 순서(중요도 순·라이브 정정) — 동의어 → 하위분류 → 칸 → 라벨 → 관계.
  // 칸(columns)은 그 종류에 대개 있는 고정 항목이라 라벨(가변·여럿·없을 수도) 위에 둔다.
  // 칩 3칸은 slotHosts 참조로 refreshAllSlots 가 다시 그리므로, DOM 부착 위치만 가른다 —
  // synonyms·subcategories 를 먼저 붙이고, 칸 섹션을 끼운 뒤, attributes(라벨)를 그 아래 붙인다.
  shell.body.appendChild(slotHosts.synonyms);
  shell.body.appendChild(slotHosts.subcategories);

  // ── 칸 칸(S8·중요도 순으로 라벨 위) — 그 종류 칸 목록·추가/삭제(user 종류만) ────────────
  // source 가름 — code 종류는 읽기전용(타입 배지만), user 종류만 추가/삭제를 연다(row.source
  // 가 그대로 전달된다·EntityTypeRow.source 출처). 추가·삭제 후 panel reload → latestColumns
  // 로 그 종류 칸을 다시 받아 목록을 갱신한다.
  shell.body.appendChild(
    renderColumnSection({
      typeName: row.typeName,
      source: row.source,
      columns,
      addColumn: (columnKey, dataType) =>
        deps.addColumn(row.typeName, columnKey, dataType),
      removeColumn: (id) => deps.removeColumn(id),
      onReload: () => deps.onReload(),
      latestColumns: () => deps.latestColumns(row.typeName),
    }),
  );

  // 라벨(attributes)은 칸 아래 — 가변·여럿이라 중요도상 칸 다음.
  shell.body.appendChild(slotHosts.attributes);

  // 첫 렌더 — 생성자가 받은 disabledChips 를 그대로 쓴다(latestDisabled 로 덮지 않는다).
  refreshAllSlots(false);

  // ── 관계 칸(S7b·라이브 정정·모달 편입) — 맨 아래에 그 종류 출발 관계만 ─────────────────
  // 출발 종류는 이 종류 고정(deps.sourceType = row.typeName·출발 select 없음). 추가·삭제 후
  // panel reload → latestRelations 로 그 종류 출발 관계를 다시 받아 목록을 갱신한다.
  shell.body.appendChild(
    renderTypeRelations({
      sourceType: row.typeName,
      entityTypes: () => deps.entityTypes(),
      relations,
      addRelation: (payload) => deps.addRelation(payload),
      removeRelation: (relationKey) => deps.removeRelation(relationKey),
      onReload: () => deps.onReload(),
      latestRelations: () => deps.latestRelations(row.typeName),
    }),
  );

  host.appendChild(shell.overlay);
  return shell.overlay;
}
