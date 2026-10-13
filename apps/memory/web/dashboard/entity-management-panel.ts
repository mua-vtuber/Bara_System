/**
 * entity-management-panel.ts — 엔티티 관리 통합 탭 조율 (엔티티 관리 통합 S6 + S7a 모달 배선).
 *
 * 옛 '분류 어휘'·'엔티티 종류' 두 탭을 "엔티티 관리" 한 탭으로 합친 진입점. 진입 흐름:
 *   1) api.list() 가 세 GET 라우트(/api/entity-types·/api/classify-vocab·/api/relation-vocab)
 *      를 병렬 호출해 한 객체로 받는다.
 *   2) buildEntityManagementRows(순수 함수)가 "표 한 행 = 한 종류" 배열로 조립한다 — 끈
 *      값·관계 키는 이 단계에서 빠진다. 이 배열을 panel 이 메모리에 들고 있다(수정 모달이
 *      새 fetch 없이 그 종류 행을 다시 찾게).
 *   3) renderEntityManagementTable(순수 렌더)이 표 DOM 을 만든다.
 *   4) 추가·수정·삭제 콜백을 배선 — 추가/수정 모달은 entity-management-modal-* 가 그리고,
 *      panel 이 저장 오케스트레이터·reload 를 주입한다. 저장·삭제 직후 목록을 다시 불러온다.
 *
 * S7a 저장 오케스트레이터(부분 저장 옵션 ⓐ): 추가 모달이 모은 입력으로 종류 생성을 먼저
 * 부르고(실패하면 throw → 모달이 .modal-error 노출·어휘 호출 0건), 성공하면 어휘를 slot별
 * 순차 POST 한다(병렬 금지 — 라우트 prospective 불변식이 순서 의존). 각 성공·실패를 모아
 * summarizeAddResult 로 집계한다. 롤백 DELETE 는 안 쓴다(멀쩡한 종류 보존).
 *
 * silent fallback 금지: api.list() 실패 시 명시 에러 박스(.panel-error)를 보인다(빈 표로
 * 안 가린다·옛 패널 양식 정합). 삭제·저장 실패는 toast·modal-error 로 알린다.
 */

import { showToast } from "./form/toast";
import {
  createEntityManagementPanelApi,
  buildEntityManagementRows,
  buildDisabledChips,
  buildTypeRelations,
  buildColumnChips,
  type EntityManagementPanelApi,
  type EntityManagementData,
  type EntityManagementRow,
} from "./entity-management-api";
import { renderEntityManagementTable } from "./entity-management-table";
import { openAddModal, type AddModalInput } from "./entity-management-modal-add";
import { openEditModal } from "./entity-management-modal-edit";
import { createRelationVocabPanelApi } from "./relation-vocab-panel-api";
import {
  summarizeAddResult,
  summarizeAddColumnResult,
  summarizeColumnFailure,
  buildAddTypePayload,
  buildAddVocabCalls,
  toAddVocabPayload,
  type AddResultSummary,
  type VocabCallResult,
} from "./entity-management-save";

/** 사용자 노출 문구 한 곳 모음 — 흩뿌리지 않는다(중앙화·i18n 대비). */
const LABELS = {
  title: "엔티티 관리",
  intro:
    "기억을 어떤 종류로 나누고(분류 이름·영문키), 어떤 단어와 칸을 그 종류로 인식할지(동의어·하위분류·칸·라벨) 한자리에서 봅니다. 기본 종류(사람·작품 등 10가지)와 그 기본 어휘는 읽기전용이고, 사용자가 더한 종류·어휘만 삭제할 수 있습니다. 새로 입력하는 글부터 적용되고, 과거 글은 바뀌지 않습니다.",
  addBtn: "새 종류 추가",
  loadFailed: "엔티티 관리 목록을 불러오지 못했습니다",
  typeDeleted: "종류를 삭제했습니다.",
  typeDeleteFailed: "종류 삭제에 실패했습니다",
  vocabDeleted: "어휘를 삭제했습니다.",
  vocabDeleteFailed: "어휘 삭제에 실패했습니다",
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
 * 엔티티 관리 통합 패널 통째 — 제목 + 안내 + 추가 버튼 + 표. 진입 시점에 세 라우트를 병렬
 * 로드해 표를 그린다. 추가·수정·삭제 직후 목록을 다시 불러와 갱신한다. api 를 인자로 안
 * 주면 실제 createEntityManagementPanelApi() 로 same-origin 호출한다.
 */
export function renderEntityManagementPanel(
  api: EntityManagementPanelApi = createEntityManagementPanelApi(),
): HTMLElement {
  const panel = el("div", "entity-management-panel");
  panel.dataset.section = "entity-management-panel";

  const head = el("div", "entity-management-head");
  head.appendChild(el("h2", "entity-management-title", LABELS.title));
  const addBtn = el("button", "entity-management-add-btn", LABELS.addBtn);
  addBtn.type = "button";
  addBtn.dataset.addType = "true";
  addBtn.addEventListener("click", () => openAddModal(addModalDeps()));
  head.appendChild(addBtn);
  panel.appendChild(head);

  panel.appendChild(el("p", "entity-management-intro", LABELS.intro));

  const tableHost = el("div", "entity-management-table-host");
  panel.appendChild(tableHost);

  // panel 이 들고 있는 마지막 list() 결과 — 수정 모달이 새 fetch 없이 그 종류 행·끈 칩·그
  // 종류 출발 관계를 다시 찾는다(buildEntityManagementRows / buildDisabledChips /
  // buildTypeRelations 입력 단일 출처).
  let currentData: EntityManagementData | undefined;
  let currentRows: EntityManagementRow[] = [];

  // 관계 CRUD api — 수정 모달의 관계 칸이 추가·삭제 시 호출한다(relation-vocab 라우트 재사용·
  // 새 라우트 0). 관계는 종류 표 아래 별 섹션이 아니라 *종류 수정 모달 안*에 들어간다(라이브
  // 정정·모달 편입). 표 아래엔 관계 섹션이 더 이상 부착되지 않는다.
  const relationApi = createRelationVocabPanelApi();

  async function reload(): Promise<void> {
    tableHost.textContent = "";
    try {
      const data = await api.list();
      currentData = data;
      currentRows = buildEntityManagementRows(data);
      tableHost.appendChild(
        renderEntityManagementTable(
          currentRows,
          (typeName) => void deleteTypeThenReload(typeName),
          (id) => void deleteVocabThenReload(id),
          (typeName) => openEditForType(typeName),
        ),
      );
    } catch (e) {
      // fetch 실패는 명시 에러 박스 — 빈 표로 가리지 않는다(옛 패널 .panel-error 양식 정합).
      const box = el(
        "p",
        "panel-error",
        `${LABELS.loadFailed}: ${(e as Error).message}`,
      );
      tableHost.appendChild(box);
    }
  }

  async function deleteTypeThenReload(typeName: string): Promise<void> {
    try {
      await api.removeType(typeName);
      showToast(LABELS.typeDeleted, "success");
      await reload();
    } catch (e) {
      showToast(`${LABELS.typeDeleteFailed}: ${(e as Error).message}`, "error");
    }
  }

  async function deleteVocabThenReload(id: string): Promise<void> {
    try {
      await api.removeVocab(id);
      showToast(LABELS.vocabDeleted, "success");
      await reload();
    } catch (e) {
      showToast(`${LABELS.vocabDeleteFailed}: ${(e as Error).message}`, "error");
    }
  }

  /**
   * 추가 저장 오케스트레이터(부분 저장 옵션 ⓐ). 종류 생성을 먼저 부른다 — 실패하면 throw 해
   * 모달이 라우트 400 을 .modal-error 로 보이고 어휘·칸 호출은 0건이다. 성공하면 어휘를 slot별
   * 순차 POST(병렬 금지·라우트 불변식 순서 의존)하고, 그다음 칸을 순차 POST 한다(저장 전 칸
   * POST 0·종류 저장 후·isPlacementType 400 회피). 각 성공·실패를 모아 집계한다. 롤백 DELETE 는
   * 안 쓴다(부분 결과 정직 표시·옵션 ⓐ).
   */
  async function runAddSave(input: AddModalInput): Promise<AddResultSummary> {
    // 1) 종류 생성 — 실패(코드 10종 충돌·중복 등)는 그대로 throw(모달 catch 가 받는다).
    await api.addType(
      buildAddTypePayload({
        typeName: input.typeName,
        koName: input.koName,
        idPrefix: input.idPrefix,
      }),
    );
    // 2) 어휘 순차 추가 — 각 호출 결과(성공/실패)를 모은다(한 칩 실패가 다음을 안 막는다).
    const calls = buildAddVocabCalls(input.typeName, input.chips);
    const results: VocabCallResult[] = [];
    for (const call of calls) {
      try {
        await api.addVocab(toAddVocabPayload(input.typeName, call));
        results.push({ slot: call.slot, value: call.value, ok: true, message: "" });
      } catch (e) {
        results.push({
          slot: call.slot,
          value: call.value,
          ok: false,
          message: (e as Error).message,
        });
      }
    }
    const summary = summarizeAddResult({ ok: true, message: "" }, results);

    // 3) 칸 순차 추가(S8) — 어휘 다음에 각 로컬 칸을 columns + (number/date) column_types 순차 POST.
    //    api.addColumn 이 columns 후 column_types 를 순차로 부르고 두 결과를 돌려준다. 한 칸의
    //    집계(summarizeAddColumnResult)를 실패 한 줄(summarizeColumnFailure)로 바꿔, 어휘 실패와
    //    한 목록에 섞는다. 한 칸 실패가 다음 칸을 안 막는다(어휘 단계와 같은 정신).
    for (const col of input.columns) {
      try {
        const apiResult = await api.addColumn(input.typeName, col.key, col.dataType);
        const colSummary = summarizeAddColumnResult(
          apiResult.columnsResult,
          apiResult.columnTypesResult,
        );
        const failure = summarizeColumnFailure(col.key, colSummary);
        if (failure) summary.failures.push(failure);
      } catch (e) {
        // 네트워크·예외(라우트가 아닌 fetch 실패 등)도 실패 한 줄로 담는다(빈 상태 위장 0).
        summary.failures.push({ slot: "columns", value: col.key, message: (e as Error).message });
      }
    }
    // 칸 실패가 생겼으면 allOk 를 다시 계산한다(어휘 + 칸 전부 성공이라야 닫힌다).
    summary.allOk = summary.failures.length === 0;
    return summary;
  }

  function addModalDeps() {
    return {
      onSave: (input: AddModalInput) => runAddSave(input),
      onReload: () => reload(),
    };
  }

  /** 표 수정 버튼 → panel 메모리의 그 종류 행으로 수정 모달을 연다(새 fetch 0). */
  function openEditForType(typeName: string): void {
    const row = currentRows.find((r) => r.typeName === typeName);
    if (!row) {
      // 표 행이 있는데 메모리에 없는 건 정상 흐름에선 안 생긴다 — 방어적 toast(빈 모달 위장 0).
      showToast(`'${typeName}' 종류를 찾지 못했습니다.`, "error");
      return;
    }
    // 끈 칩 목록 — 현재 list() 결과에서 그 종류·slot 의 가림표(tombstone)를 모은다(표 row
    // 무변경·모달에 추가 인자로 전달). currentData 가 없으면(진입 reload 전) 빈 목록.
    const disabled = currentData
      ? buildDisabledChips(currentData, typeName)
      : [];
    // 그 종류가 출발(source)인 관계만 — 현재 list() 결과의 relationVocab 전체에서 필터(새
    // fetch 0·단일 출처). 모달 안 관계 칸이 이 목록을 그리고, 추가 폼 출발은 이 종류 고정.
    const relations = currentData
      ? buildTypeRelations(currentData.relationVocab, typeName)
      : [];
    // 그 종류 칸 목록 — entity-types columns[] (배지·dataType) + vocab.entries columns slot
    // (삭제 id·user 만) 조인(buildColumnChips·새 fetch 0). currentData 없으면 빈 목록.
    const columns = currentData
      ? buildColumnChips(currentData, typeName)
      : [];
    openEditModal(
      row,
      {
        addVocab: (tn, slot, value) => api.addVocab({ typeName: tn, slot, value }),
        removeVocab: (id) => api.removeVocab(id),
        disableVocab: (tn, slot, value) => api.disableVocab(tn, slot, value),
        restoreVocab: (tn, slot, value) => api.restoreVocab(tn, slot, value),
        onReload: () => reload(),
        latestRow: (tn) => currentRows.find((r) => r.typeName === tn),
        // reload 후 끈 칩 갱신 — currentData 가 새로 채워졌으면 그걸로 다시 모은다.
        latestDisabled: (tn) =>
          currentData ? buildDisabledChips(currentData, tn) : [],
        // 관계 칸 — 도착 종류 옵션 단일 출처(통합 entityTypes) + 관계 추가·삭제(relation
        // 라우트 재사용) + reload 후 그 종류 출발 관계 갱신.
        entityTypes: () => currentData?.entityTypes ?? [],
        addRelation: (payload) => relationApi.add(payload),
        removeRelation: (relationKey) => relationApi.remove(relationKey),
        latestRelations: (tn) =>
          currentData ? buildTypeRelations(currentData.relationVocab, tn) : [],
        // 칸 칸(S8) — 추가(columns 후 number/date column_types 순차)·삭제(길 B 짝 삭제)·reload 후
        // 그 종류 칸 최신 목록(buildColumnChips 조인·새 fetch 0).
        addColumn: (tn, columnKey, dataType) => api.addColumn(tn, columnKey, dataType),
        removeColumn: (id) => api.removeColumn(id),
        latestColumns: (tn) =>
          currentData ? buildColumnChips(currentData, tn) : [],
      },
      disabled,
      relations,
      columns,
    );
  }

  void reload();
  return panel;
}
