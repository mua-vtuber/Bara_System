/**
 * entity-management-relations.ts — 엔티티 관리 통합 탭 관계 설정 부품 (엔티티 관리 통합 S7b).
 *
 * 옛 entity-types-panel.ts 의 관계 추가 폼·renderRelationVocabList 를 통합 패널로 이식한
 * 모듈(검증된 로직 그대로 옮김·알고리즘 신설 0). 라이브 정정(2026-06-27 사용자)으로 관계는
 * *종류 수정 모달 안*에 들어간다 — 종류 표 아래 별 섹션이 화면을 길게 만들어 모달 편입을
 * 택함. 그래서 출발 종류는 *현재 종류 고정*(출발 select 없음)이고, 그 종류가 출발(source)인
 * 관계만 목록·편집한다. D3 의 "주인을 라벨에서 빼 관계로" 대조는 종류 단위로 모달 안에서
 * 이뤄진다(작품 모달에 작품 라벨 + 작품 출발 관계 같이).
 *
 * 설계 정신 — 순수 렌더와 콜백 분리:
 *   - renderRelationList 는 *순수 DOM 조립*. 관계 행 데이터를 인자로 받아 DOM 만 만든다.
 *   - buildRelationAddPayload 는 *순수 함수*. 폼 입력을 POST body 로 바꾼다(빈 키·이름 거름).
 *     출발은 단일(현재 종류) 이라 [sourceType] 한 배열로 감싼다.
 *   - renderTypeRelations 는 모달용 관계 칸 — 출발 고정·도착 한 종류·관계키·관계명·목록·삭제.
 *     네트워크(add/remove/reload) 는 modal-edit 이 주입한 콜백에 맡긴다(Mock 클래스 0).
 *     도착은 사용자 단순화로 한 종류만 고른다(여럿 선택 + 기본 도착 두 칸 헷갈림 해소).
 *
 * 도착 종류 select 옵션은 통합 entityTypes 단일 출처를 재사용한다(하드코딩 0·단일 출처).
 *
 * silent fallback 금지: 빈 목록(그 종류 출발 관계 0건)은 "관계 없음" 안내만(정직한 빈 상태).
 */

import { showToast } from "./form/toast";
import {
  type RelationVocabRow,
  type AddRelationVocabPayload,
} from "./relation-vocab-panel-api";
import type { EntityTypeRow } from "./entity-types-panel-api";

/** 사용자 노출 문구 한 곳 모음 — 흩뿌리지 않는다(중앙화·i18n 대비). */
const LABELS = {
  title: "관계 설정",
  intro:
    "이 종류가 다른 종류를 가리키는 관계를 정합니다. 예를 들어 작품이 사람을 가리키는 '창작자' 같은 관계입니다. 기본 관계(주인·창작자 등)는 읽기전용이고, 새 관계를 더하면 그 관계 태그(#관계키:대상)로 글을 입력할 때 두 대상이 이어집니다. 새로 입력하는 글부터 적용됩니다.",
  addTitle: "새 관계 추가",
  keyPlaceholder: "관계 태그 키 (예: 감독)",
  namePlaceholder: "영문 관계명 (예: directed_by)",
  targetLabel: "도착 종류",
  addBtn: "관계 추가",
  listTitle: "관계 목록",
  arrow: "→",
  colon: ":",
  sourceCode: "코드",
  sourceUser: "추가",
  deleteBtn: "삭제",
  empty: "이 종류가 출발인 관계가 없습니다. 기본 관계만 있습니다.",
  addFailed: "관계 추가에 실패했습니다",
  deleteFailed: "관계 삭제에 실패했습니다",
  addedToast: "새 관계를 추가했습니다.",
  deletedToast: "관계를 삭제했습니다.",
  needKey: "관계 태그 키를 입력하세요.",
  needName: "영문 관계명을 입력하세요.",
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

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

/**
 * 관계 추가 폼 입력 한 벌 — buildRelationAddPayload 의 입력. sourceType 은 단일 출발 종류
 * (모달에선 현재 종류 고정), targetType 은 단일 도착 종류(사용자 단순화·한 종류만 고름).
 * 도착이 한 칸이라 라우트의 targetTypes 배열·defaultTargetType 둘 다 이 한 값으로 채운다.
 */
export interface RelationFormInput {
  relationKey: string;
  relationName: string;
  sourceType: string;
  targetType: string;
}

/**
 * 관계 추가 폼 입력 → POST body(순수 함수·fetch 없음). 관계키·관계명을 trim 한 뒤 빈값이면
 * null 을 돌려준다(폼이 toast 로 안내하고 호출 0). 출발 종류는 단일이라 [sourceType] 한 배열로
 * 감싼다(라우트 sourceTypes 배열 계약). 도착도 단일 입력이라 [targetType] 한 배열로 감싸고
 * defaultTargetType 도 그 한 값을 쓴다 — 라우트 계약(targetTypes[]·defaultTargetType)은 그대로
 * 두고 UI 만 한 종류로 단순화한다(여럿 선택 + 기본 도착 두 칸 헷갈림 해소·사용자 결정).
 */
export function buildRelationAddPayload(
  input: RelationFormInput,
): AddRelationVocabPayload | null {
  const relationKey = input.relationKey.trim();
  const relationName = input.relationName.trim();
  if (relationKey.length === 0) return null;
  if (relationName.length === 0) return null;
  return {
    relationKey,
    relationName,
    sourceTypes: [input.sourceType],
    targetTypes: [input.targetType],
    defaultTargetType: input.targetType,
  };
}

/**
 * 관계 목록 순수 렌더 — 관계 키 → 관계명 + (출발 종류 → 도착 종류) + 출처 배지. user 출처만
 * 삭제 버튼이 붙는다(code 씨앗은 읽기전용). onDelete(relationKey) 는 user 행 삭제 버튼 클릭
 * 시만 호출한다(네트워크는 호출자 책임). 그 종류 출발 관계 0건이면 안내만.
 */
export function renderRelationList(
  rows: RelationVocabRow[],
  onDelete: (relationKey: string) => void,
): HTMLElement {
  const list = el("div", "entity-mgmt-relation-list");

  if (rows.length === 0) {
    const empty = el("p", "entity-mgmt-relation-empty", LABELS.empty);
    empty.dataset.relationEmpty = "true";
    list.appendChild(empty);
  }

  for (const row of rows) {
    const item = el("div", "entity-mgmt-relation-row");
    item.dataset.relationRow = "true";
    item.dataset.source = row.source;
    item.dataset.relationKey = row.relationKey;

    const pair = el("div", "entity-mgmt-relation-pair");
    pair.appendChild(el("span", "entity-mgmt-relation-key", row.relationKey));
    pair.appendChild(el("span", "entity-mgmt-relation-colon", ` ${LABELS.colon} `));
    pair.appendChild(el("span", "entity-mgmt-relation-name", row.relationName));
    // 출발 종류 → 도착 종류(여럿이면 '/' 로 잇는다).
    const types = el(
      "span",
      "entity-mgmt-relation-types",
      ` (${row.sourceTypes.join("/")} ${LABELS.arrow} ${row.targetTypes.join("/")})`,
    );
    pair.appendChild(types);
    item.appendChild(pair);

    const badge = el(
      "span",
      "entity-mgmt-relation-source-badge",
      row.source === "code" ? LABELS.sourceCode : LABELS.sourceUser,
    );
    badge.dataset.source = row.source;
    item.appendChild(badge);

    // 씨앗(code)은 읽기전용 — 삭제 버튼 없음. 새 관계(user)만 삭제 가능.
    if (row.source === "user") {
      const deleteBtn = el("button", "entity-mgmt-relation-delete", LABELS.deleteBtn);
      deleteBtn.type = "button";
      deleteBtn.dataset.relationDelete = "true";
      const relationKey = row.relationKey;
      deleteBtn.addEventListener("click", () => onDelete(relationKey));
      item.appendChild(deleteBtn);
    }

    list.appendChild(item);
  }

  return list;
}

/**
 * 모달용 관계 칸이 받는 의존 — 출발 고정(현재 종류) + 도착 종류 옵션 단일 출처 + 관계
 * 추가·삭제·목록 콜백. 네트워크는 modal-edit 이 주입한다(panel api 재사용·Mock 0).
 */
export interface TypeRelationsDeps {
  /** 출발 종류 = 현재 종류 고정(모달의 typeName). 추가 폼이 이 값을 sourceType 으로 보낸다. */
  sourceType: string;
  /** 도착 종류 select 옵션의 단일 출처 — 통합 data.entityTypes 를 그대로 넘긴다. */
  entityTypes(): EntityTypeRow[];
  /** 그 종류 출발 관계만 거른 현재 목록(buildTypeRelations 산출). reload 후 latest 로 갱신. */
  relations: RelationVocabRow[];
  /** 관계 추가 — POST /api/relation-vocab. 실패 시 throw(라우트 400). */
  addRelation(payload: AddRelationVocabPayload): Promise<void>;
  /** user 관계 삭제 — DELETE /api/relation-vocab/:relationKey. 실패 시 throw. */
  removeRelation(relationKey: string): Promise<void>;
  /** 추가·삭제 성공 직후 호출 — panel 이 표·관계를 다시 불러온다(reload). */
  onReload(): void | Promise<void>;
  /** reload 후 그 종류 출발 관계 최신 목록을 panel 메모리에서 다시 받아 준다(목록 갱신). */
  latestRelations(): RelationVocabRow[];
}

/**
 * 모달 안 관계 칸 통째 — 제목 + 안내 + 추가 폼(관계키·관계명·도착 한 종류) + 그 종류 출발
 * 관계 목록. 출발 종류 select 는 없다(현재 종류 고정 — deps.sourceType). 도착도 한 종류만
 * 고른다(사용자 단순화). 추가·삭제 직후 목록을 다시 그린다(latestRelations 로 갱신). 도착
 * 종류 옵션은 deps.entityTypes() 단일 출처. 반환은 관계 칸 컨테이너라 테스트가 그 안 폼·
 * 목록을 data-* 로 찾는다.
 */
export function renderTypeRelations(deps: TypeRelationsDeps): HTMLElement {
  // 그 종류 출발 관계 목록(가변) — 추가·삭제 후 latestRelations 로 다시 받아 갱신한다.
  let currentRelations: RelationVocabRow[] = deps.relations;

  const section = el("div", "entity-mgmt-relation-section");
  section.dataset.section = "entity-mgmt-relations";

  section.appendChild(el("h3", "entity-mgmt-relation-title", LABELS.title));
  section.appendChild(el("p", "entity-mgmt-relation-intro", LABELS.intro));

  // ── 추가 폼: 관계키 + 관계명 + 도착 한 종류 (출발 select 없음·현재 종류 고정) ──────────
  const addForm = el("form", "entity-mgmt-relation-add-form");
  addForm.appendChild(el("h4", "entity-mgmt-relation-add-title", LABELS.addTitle));

  const keyInput = el("input", "entity-mgmt-relation-key-input");
  keyInput.type = "text";
  keyInput.dataset.relationKeyInput = "true";
  keyInput.placeholder = LABELS.keyPlaceholder;

  const nameInput = el("input", "entity-mgmt-relation-name-input");
  nameInput.type = "text";
  nameInput.dataset.relationNameInput = "true";
  nameInput.placeholder = LABELS.namePlaceholder;

  // 도착 종류 select — 통합 종류 목록(코드 10종 + 새 종류)을 단일 출처로 채운다. 도착은 한
  // 종류만 고른다(사용자 단순화·single select). 출발 select 는 없다(현재 종류 고정 —
  // deps.sourceType 을 그대로 payload 출발로 보낸다). 기본 도착 칸도 없앤다(도착 한 칸이라
  // 라우트 defaultTargetType 은 그 한 값으로 자동 채운다·UI 두 칸 헷갈림 해소).
  const targetSelect = el("select", "entity-mgmt-relation-select");
  targetSelect.dataset.relationTarget = "true";

  const addBtn = el("button", "entity-mgmt-relation-add-btn", LABELS.addBtn);
  addBtn.type = "submit";

  addForm.appendChild(keyInput);
  addForm.appendChild(nameInput);
  addForm.appendChild(el("label", "entity-mgmt-relation-field-label", LABELS.targetLabel));
  addForm.appendChild(targetSelect);
  addForm.appendChild(addBtn);
  section.appendChild(addForm);

  // ── 관계 목록 ─────────────────────────────────────────────────────────────
  section.appendChild(el("h4", "entity-mgmt-relation-list-title", LABELS.listTitle));
  const listHost = el("div", "entity-mgmt-relation-list-host");
  section.appendChild(listHost);

  /**
   * 도착 종류 select 옵션을 통합 종류 목록(코드 10종 + 새 종류)으로 채운다(한 종류만 고름).
   * deps.entityTypes() 를 단일 출처로 본다(옛 별도 list() 호출 대체·하드코딩 0).
   */
  function refreshTypeOptions(): void {
    const rows = deps.entityTypes();
    targetSelect.textContent = "";
    for (const r of rows) {
      const label = `${r.koName} (${r.typeName})`;
      targetSelect.appendChild(option(r.typeName, label));
    }
  }

  /** 그 종류 출발 관계 목록을 다시 그린다(currentRelations 기준·새 fetch 0). */
  function drawList(): void {
    listHost.textContent = "";
    listHost.appendChild(
      renderRelationList(currentRelations, (relationKey) =>
        void deleteRelationThenReload(relationKey),
      ),
    );
  }

  async function deleteRelationThenReload(relationKey: string): Promise<void> {
    try {
      await deps.removeRelation(relationKey);
      showToast(LABELS.deletedToast, "success");
      await deps.onReload();
      currentRelations = deps.latestRelations();
      drawList();
    } catch (e) {
      showToast(`${LABELS.deleteFailed}: ${(e as Error).message}`, "error");
    }
  }

  // 새 관계 추가 — buildRelationAddPayload 가 폼 입력을 POST body 로 바꾼다(빈 키·이름이면
  // null → toast 안내·호출 0). 출발 종류는 deps.sourceType 고정(현재 종류). 서버 400(씨앗
  // 충돌·3분법 충돌·미등록 타입 등)은 그대로 노출.
  addForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void (async () => {
      const payload = buildRelationAddPayload({
        relationKey: keyInput.value,
        relationName: nameInput.value,
        sourceType: deps.sourceType,
        // 도착은 한 종류 — single select 의 value 한 값을 라우트 targetTypes[]·defaultTargetType
        // 둘 다로 채운다(buildRelationAddPayload 가 [targetType]·targetType 으로 감싼다).
        targetType: targetSelect.value,
      });
      if (payload === null) {
        // 빈 관계키·관계명 — 어느 쪽이 비었는지 갈라 안내한다(폼 검증 정합).
        showToast(
          keyInput.value.trim().length === 0 ? LABELS.needKey : LABELS.needName,
          "error",
        );
        return;
      }
      addBtn.disabled = true;
      try {
        await deps.addRelation(payload);
        showToast(LABELS.addedToast, "success");
        keyInput.value = "";
        nameInput.value = "";
        await deps.onReload();
        currentRelations = deps.latestRelations();
        drawList();
      } catch (e) {
        showToast(`${LABELS.addFailed}: ${(e as Error).message}`, "error");
      } finally {
        addBtn.disabled = false;
      }
    })();
  });

  // 첫 그리기 — 도착 종류 옵션을 채우고 그 종류 출발 관계 목록을 그린다(새 fetch 0).
  refreshTypeOptions();
  drawList();

  return section;
}
