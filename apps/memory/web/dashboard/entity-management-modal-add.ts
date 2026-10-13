/**
 * entity-management-modal-add.ts — 새 종류 추가 모달 (엔티티 관리 통합 S7a).
 *
 * 필드: 표시명(koName·필수) / 영문키(typeName·필수) / id 접두사(자동 추천·수정 가능) /
 * 동의어·하위분류·라벨 칩 에디터. 관계 칸은 없다(S7b 관계 표로 미룬다 — 새 종류는 저장
 * 전이라 관계의 출발·도착 후보에 아직 없다).
 *
 * 접두사 자동 추천: 영문키를 칠 때마다 suggestIdPrefix 로 접두사를 채운다. 사용자가 접두사
 * 칸을 직접 건드리면 prefixTouched 가 켜져 자동 추천을 멈춘다(사용자 값 보존).
 *
 * 저장 = 부분 저장 옵션 ⓐ: 빈값·형식은 저장 직전 validateAddForm 으로 화면이 막고
 * (.modal-error + 토스트), 통과하면 주입한 onSave 오케스트레이터에 모은 자료를 넘긴다.
 * onSave 가 종류 생성·어휘 순차 추가를 실제로 부르고 집계 결과(AddResultSummary)를 돌려준다.
 *   - allOk → 모달 닫기(panel 이 토스트·reload).
 *   - 종류 성공 + 어휘 일부 실패 → 모달 안 닫음·실패 칩만 "이건 실패: ~" 로 남기고 성공 칩은
 *     입력에서 비운다(재시도 멱등). 종류 생성 실패 → .modal-error 에 라우트 메시지 노출.
 *
 * 이 모달 자체는 fetch 를 안 부른다 — onSave 주입으로 네트워크를 호출자(panel)에 맡겨,
 * 단위 검증이 plain 객체 주입만으로 저장 클릭 흐름을 본다(Mock 클래스 0).
 */

import { showToast } from "./form/toast";
import {
  createModalShell,
  createTextInputRow,
  createChipEditor,
  createColumnEditor,
  validateAddForm,
  suggestIdPrefix,
  el,
  type ChipEditor,
  type ColumnEditor,
} from "./entity-management-modal-fields";
import type {
  AddResultSummary,
  AddVocabChipBundle,
  LocalColumn,
} from "./entity-management-save";

/** 사용자 노출 문구 한 곳 모음 — 흩뿌리지 않는다(중앙화·i18n 대비). */
const LABELS = {
  title: "새 종류 추가",
  koName: "표시명 (예: 장비)",
  typeName: "영문키 (예: equipment)",
  idPrefix: "id 접두사 (자동 추천·고쳐도 됨)",
  synonyms: "동의어",
  subcategories: "하위분류",
  attributes: "라벨",
  columns: "칸",
  columnsHint:
    "칸(예: 금액·날짜)은 그 종류로 기록하는 글에 곁들이는 항목입니다. 숫자형 칸은 계산 탭 대상, 날짜형 칸은 일정탭 후보가 됩니다.",
  save: "저장",
  saving: "저장 중…",
  relationNote:
    "관계(예: 참여자·주인)는 종류를 만든 뒤 그 종류 수정에서 잇습니다.",
  partialFail: "일부 항목을 더하지 못했습니다. 아래를 고쳐 다시 저장하세요.",
  failChip: (slot: string, value: string, message: string): string =>
    `이건 실패: [${slot}] ${value} — ${message}`,
};

/** slot 한국어 표시 — 실패 안내에 쓴다(영문 slot 대신). 칸(columns)도 섞여 들어온다. */
const SLOT_KO: Record<"synonyms" | "subcategories" | "attributes" | "columns", string> = {
  synonyms: "동의어",
  subcategories: "하위분류",
  attributes: "라벨",
  columns: "칸",
};

/** 추가 모달이 모은 입력 — onSave 오케스트레이터 입력. */
export interface AddModalInput {
  typeName: string;
  koName: string;
  idPrefix: string;
  chips: AddVocabChipBundle;
  /** 로컬로 모은 칸(key + dataType). 종류 저장 후 순차 POST 한다(저장 전 칸 POST 0·S8). */
  columns: LocalColumn[];
}

/** 추가 모달 열기 인자 — onSave(실제 저장) + onSuccess(allOk 후 panel reload). */
export interface OpenAddModalDeps {
  /** 모은 입력으로 종류 생성·어휘 순차 추가를 실제 부르고 집계 결과를 돌려준다(네트워크). */
  onSave(input: AddModalInput): Promise<AddResultSummary>;
  /** allOk 또는 부분 성공 직후 호출 — panel 이 표를 다시 그린다(성공 종류·칩 즉시 반영). */
  onReload(): void | Promise<void>;
}

/**
 * 추가 모달을 만들어 document.body 에 붙인다(brower) 또는 host 에 붙인다(테스트). 반환은
 * 오버레이 엘리먼트라 테스트가 그 안 필드·버튼을 data-* 로 찾는다.
 */
export function openAddModal(
  deps: OpenAddModalDeps,
  host: HTMLElement = document.body,
): HTMLElement {
  const shell = createModalShell(LABELS.title, () => shell.close());

  const koRow = createTextInputRow(LABELS.koName, "koName");
  let prefixTouched = false;
  const prefixRow = createTextInputRow(LABELS.idPrefix, "idPrefix");
  // 사용자가 접두사 칸을 직접 건드리면 자동 추천을 멈춘다(사용자 값 보존).
  prefixRow.input.addEventListener("input", () => {
    prefixTouched = true;
  });
  const keyRow = createTextInputRow(LABELS.typeName, "typeName", (value) => {
    if (!prefixTouched) prefixRow.input.value = suggestIdPrefix(value);
  });

  shell.body.appendChild(koRow.wrap);
  shell.body.appendChild(keyRow.wrap);
  shell.body.appendChild(prefixRow.wrap);

  const editors: Record<
    "synonyms" | "subcategories" | "attributes",
    ChipEditor
  > = {
    synonyms: createChipEditor("synonyms"),
    subcategories: createChipEditor("subcategories"),
    attributes: createChipEditor("attributes"),
  };

  // 칸 로컬 에디터(S8·추가 모달 칸 단계) — 저장 전 로컬로 모았다 종류 저장 후 순차 POST.
  const columnEditor: ColumnEditor = createColumnEditor();

  // 섹션 순서(중요도 순·수정 모달과 정합) — 동의어 → 하위분류 → 칸 → 라벨. 칸은 그 종류에
  // 대개 있는 고정 항목이라 라벨(가변·여럿·없을 수도) 위에 둔다. 칩 에디터 한 칸씩 라벨과
  // 함께 그리고, 하위분류 다음에 칸 섹션을 끼운 뒤 라벨을 그 아래 둔다.
  const addChipGroup = (slot: "synonyms" | "subcategories" | "attributes", label: string): void => {
    const group = el("div", "entity-mgmt-chip-group");
    group.appendChild(el("span", "entity-mgmt-chip-group-label", label));
    group.appendChild(editors[slot].wrap);
    shell.body.appendChild(group);
  };
  addChipGroup("synonyms", LABELS.synonyms);
  addChipGroup("subcategories", LABELS.subcategories);

  // 칸 섹션 — 라벨 위(중요도 순). 안내 한 줄 + 로컬 칸 에디터(입력·라디오·로컬 칩).
  const columnGroup = el("div", "entity-mgmt-chip-group");
  columnGroup.dataset.columnGroup = "true";
  columnGroup.appendChild(el("span", "entity-mgmt-chip-group-label", LABELS.columns));
  columnGroup.appendChild(el("p", "entity-mgmt-column-hint", LABELS.columnsHint));
  columnGroup.appendChild(columnEditor.wrap);
  shell.body.appendChild(columnGroup);

  addChipGroup("attributes", LABELS.attributes);

  // 관계는 S7b 관계 표 몫 — 가짜 입력 칸을 두지 않고 안내 문구만 둔다(정직한 공백).
  shell.body.appendChild(
    el("p", "entity-mgmt-relation-note", LABELS.relationNote),
  );

  // 실패 칩 안내를 담는 곳(부분 실패 시 채운다·.modal-error 와 별도로 칩 단위 안내).
  const failBox = el("div", "entity-mgmt-fail-box");
  failBox.dataset.failBox = "true";
  failBox.style.display = "none";
  shell.body.appendChild(failBox);

  const saveBtn = el("button", "entity-mgmt-modal-save", LABELS.save);
  saveBtn.type = "button";
  saveBtn.dataset.modalSave = "true";
  shell.body.appendChild(saveBtn);

  function renderFailures(summary: AddResultSummary): void {
    failBox.textContent = "";
    if (summary.failures.length === 0) {
      failBox.style.display = "none";
      return;
    }
    failBox.style.display = "";
    failBox.appendChild(el("p", "entity-mgmt-fail-head", LABELS.partialFail));
    for (const f of summary.failures) {
      const line = el(
        "p",
        "entity-mgmt-fail-line",
        LABELS.failChip(SLOT_KO[f.slot], f.value, f.message),
      );
      line.dataset.failLine = "true";
      failBox.appendChild(line);
    }
  }

  async function onSaveClick(): Promise<void> {
    shell.clearError();
    const koName = koRow.value().trim();
    const typeName = keyRow.value().trim();
    // 빈값·형식은 저장 직전 화면이 막는다(라우트는 형식 무검사). 코드 10종 충돌·중복은
    // 라우트 400 에 맡긴다(여기서 흉내 안 냄·단일 출처).
    const formCheck = validateAddForm({ koName, typeName });
    if (!formCheck.ok) {
      shell.setError(formCheck.message);
      showToast(formCheck.message, "error");
      return;
    }

    const input: AddModalInput = {
      typeName,
      koName,
      idPrefix: prefixRow.value(),
      chips: {
        synonyms: editors.synonyms.values(),
        subcategories: editors.subcategories.values(),
        attributes: editors.attributes.values(),
      },
      columns: columnEditor.values(),
    };

    saveBtn.disabled = true;
    saveBtn.textContent = LABELS.saving;
    try {
      const summary = await deps.onSave(input);
      if (!summary.typeCreated) {
        // 종류 생성 실패 — 라우트 400 메시지는 onSave 가 throw 해 catch 로 간다.
        // 여기 도달은 typeCreated=false 인데 throw 안 한 경우 = 방어적 에러 노출.
        shell.setError("종류를 만들지 못했습니다.");
        return;
      }
      // 성공 칩은 입력에서 비우고(중복 재시도 방지), 실패 칩은 남겨 재시도(멱등).
      // 종류·성공 칩이 표에 즉시 보이게 reload 를 부른다(부분 성공도 reload).
      await deps.onReload();
      if (summary.allOk) {
        showToast("새 종류를 추가했습니다.", "success");
        shell.close();
        return;
      }
      renderFailures(summary);
    } catch (e) {
      // 종류 생성 자체가 던진 라우트 400(코드 10종 충돌·중복 등)을 그대로 보인다.
      shell.setError((e as Error).message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = LABELS.save;
    }
  }

  saveBtn.addEventListener("click", () => void onSaveClick());

  host.appendChild(shell.overlay);
  return shell.overlay;
}
