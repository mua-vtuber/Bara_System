/**
 * entity-management-modal-edit.test.ts — 어휘 수정 모달 DOM 검증 (엔티티 관리 통합 S7a).
 *
 * 검증 정신 — fetch mock 0·Mock 객체 0:
 *   openEditModal 은 addVocab/removeVocab/onReload/latestRow(plain 함수)를 주입받는다.
 *   panel 이 들고 있는 행을 넘겨받아(새 fetch 0) 칩 3칸을 보인다. 종류 이름 인라인 수정
 *   입력·버튼이 없는지(D4·PUT 호출 0), user 칩만 삭제되는지, 칩 추가가 콜백을 부르는지를
 *   확인한다(데이터·콜백 fixture).
 *
 * 핵심 갈래:
 *   - 칩 3칸(동의어·하위분류·라벨)이 행 데이터로 그려진다.
 *   - **종류 이름 수정 입력·버튼 부재 단언(D4)** + PUT/PATCH 호출 0(주입 콜백에 그런 게 없다).
 *   - user 칩만 삭제 버튼 + removeVocab(id) 호출, yaml 칩은 읽기전용.
 *   - 칩 추가 → addVocab(typeName, slot, value) 호출.
 */

import "../../test-setup-dom";
import { describe, test, expect } from "bun:test";
import { openEditModal } from "./entity-management-modal-edit";
import type {
  EntityManagementRow,
  DisabledChip,
  ColumnChip,
  AddColumnApiResult,
} from "./entity-management-api";
import type {
  RelationVocabRow,
  AddRelationVocabPayload,
} from "./relation-vocab-panel-api";
import type { EntityTypeRow } from "./entity-types-panel-api";

function freshHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

function row(overrides: Partial<EntityManagementRow> = {}): EntityManagementRow {
  return {
    typeName: "work",
    koName: "작품",
    source: "code",
    synonyms: [],
    subcategories: [],
    columns: [],
    labels: [],
    deletableTypeName: null,
    ...overrides,
  };
}

const noopDeps = {
  addVocab: async () => {},
  removeVocab: async () => {},
  disableVocab: async () => {},
  restoreVocab: async () => {},
  onReload: () => {},
  latestRow: (): EntityManagementRow | undefined => undefined,
  latestDisabled: (): DisabledChip[] => [],
  // 관계 칸 콜백(S7b·모달 편입) — 기본은 no-op. 관계 검증 테스트가 개별로 덮는다.
  entityTypes: (): EntityTypeRow[] => [],
  addRelation: async (_payload: AddRelationVocabPayload) => {},
  removeRelation: async (_relationKey: string) => {},
  latestRelations: (): RelationVocabRow[] => [],
  // 칸 칸 콜백(S8) — 기본은 no-op. 칸 검증 테스트가 개별로 덮는다.
  addColumn: async (
    _tn: string,
    _columnKey: string,
    _dataType: "text" | "number" | "date",
  ): Promise<AddColumnApiResult> => ({ columnsResult: { ok: true, message: "" } }),
  removeColumn: async (_id: string) => {},
  latestColumns: (): ColumnChip[] => [],
};

describe("openEditModal — 어휘 수정 모달 DOM", () => {
  test("칩 3칸(동의어·하위분류·라벨)이 행 데이터로 그려진다", () => {
    const host = freshHost();
    const r = row({
      synonyms: [{ value: "소설", source: "yaml", id: null }],
      subcategories: [{ value: "장편", source: "user", id: "u1" }],
      labels: [{ value: "연재중", source: "user", id: "u2" }],
    });
    const overlay = openEditModal(r, { ...noopDeps, latestRow: () => r }, [], [], [], host);
    expect(overlay.querySelector('[data-edit-slot="synonyms"]')).not.toBeNull();
    expect(overlay.querySelector('[data-edit-slot="subcategories"]')).not.toBeNull();
    expect(overlay.querySelector('[data-edit-slot="attributes"]')).not.toBeNull();
    const text = overlay.textContent ?? "";
    expect(text).toContain("소설");
    expect(text).toContain("장편");
    expect(text).toContain("연재중");
  });

  test("종류 이름 인라인 수정 입력·버튼 부재(D4) + 읽기전용 안내 문구만", () => {
    const host = freshHost();
    const r = row();
    const overlay = openEditModal(r, { ...noopDeps, latestRow: () => r }, [], [], [], host);
    // 표시명·영문키를 고치는 입력이 없다.
    expect(overlay.querySelector('[data-field="koName"]')).toBeNull();
    expect(overlay.querySelector('[data-field="typeName"]')).toBeNull();
    // 이름 변경 버튼류가 없다(rename/save-name).
    expect(overlay.querySelector("[data-rename-save]")).toBeNull();
    // 읽기전용 안내 문구만 있다.
    const note = overlay.querySelector("[data-rename-note]") as HTMLElement;
    expect(note).not.toBeNull();
    expect(note.textContent).toContain("삭제 후 새로 추가");
  });

  test("user 칩만 ✕삭제 버튼 + removeVocab(id) 호출, yaml 칩은 ✕삭제 없이 끄기 토글", async () => {
    const host = freshHost();
    const removed: string[] = [];
    const r = row({
      synonyms: [
        { value: "소설", source: "yaml", id: null },
        { value: "장편소설", source: "user", id: "u1" },
      ],
    });
    const overlay = openEditModal(
      r,
      { ...noopDeps, removeVocab: async (id) => void removed.push(id), latestRow: () => r },
      [],
      [],
      [],
      host,
    );
    const slotHost = overlay.querySelector('[data-edit-slot="synonyms"]')!;
    const chips = Array.from(slotHost.querySelectorAll("[data-chip]"));
    const yamlChip = chips.find((c) => c.textContent?.includes("소설") && !c.textContent?.includes("장편"))!;
    const userChip = chips.find((c) => c.textContent?.includes("장편소설"))!;
    // yaml 칩은 ✕삭제가 없고(직접 삭제 불가) 끄기 토글이 붙는다(POST override).
    expect(yamlChip.querySelector("[data-chip-delete]")).toBeNull();
    expect(yamlChip.querySelector("[data-chip-disable]")).not.toBeNull();
    // user 칩은 ✕삭제만(끄기 토글 없음·라우트 400 거부·source 필드로 가름).
    expect(userChip.querySelector("[data-chip-disable]")).toBeNull();
    const delBtn = userChip.querySelector("[data-chip-delete]") as HTMLButtonElement;
    expect(delBtn).not.toBeNull();
    delBtn.click();
    await Promise.resolve();
    expect(removed).toEqual(["u1"]);
  });

  test("칩 추가 버튼 → addVocab(typeName, slot, value) 호출", async () => {
    const host = freshHost();
    const added: Array<[string, string, string]> = [];
    const r = row({ typeName: "equipment", koName: "장비", source: "user", deletableTypeName: "equipment" });
    const overlay = openEditModal(
      r,
      {
        ...noopDeps,
        addVocab: async (tn, slot, value) => void added.push([tn, slot, value]),
        latestRow: () => r,
      },
      [],
      [],
      [],
      host,
    );
    const synInput = overlay.querySelector('[data-add-input="synonyms"]') as HTMLInputElement;
    synInput.value = "키보드";
    (overlay.querySelector('[data-add-btn="synonyms"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(added).toEqual([["equipment", "synonyms", "키보드"]]);
  });

  test("어휘 0건 slot 은 '등록된 어휘 없음' 안내(가짜 칩 0)", () => {
    const host = freshHost();
    const r = row();
    const overlay = openEditModal(r, { ...noopDeps, latestRow: () => r }, [], [], [], host);
    const synHost = overlay.querySelector('[data-edit-slot="synonyms"]')!;
    expect(synHost.querySelector(".entity-mgmt-edit-empty")).not.toBeNull();
  });

  test("yaml 칩 끄기 토글 클릭 → disableVocab(typeName, slot, value) 호출", async () => {
    const host = freshHost();
    const disabled: Array<[string, string, string]> = [];
    const r = row({
      synonyms: [{ value: "소설", source: "yaml", id: null }],
    });
    const overlay = openEditModal(
      r,
      {
        ...noopDeps,
        disableVocab: async (tn, slot, value) => void disabled.push([tn, slot, value]),
        latestRow: () => r,
      },
      [],
      [],
      [],
      host,
    );
    const slotHost = overlay.querySelector('[data-edit-slot="synonyms"]')!;
    const disableBtn = slotHost.querySelector("[data-chip-disable]") as HTMLButtonElement;
    expect(disableBtn).not.toBeNull();
    disableBtn.click();
    await Promise.resolve();
    expect(disabled).toEqual([["work", "synonyms", "소설"]]);
  });

  test("끈 칩은 흐린 클래스 + 되살리기 토글 → restoreVocab(typeName, slot, value) 호출", async () => {
    const host = freshHost();
    const restored: Array<[string, string, string]> = [];
    const r = row();
    const overlay = openEditModal(
      r,
      {
        ...noopDeps,
        restoreVocab: async (tn, slot, value) => void restored.push([tn, slot, value]),
        latestRow: () => r,
      },
      [{ value: "만화", slot: "synonyms" }],
      [],
      [],
      host,
    );
    const slotHost = overlay.querySelector('[data-edit-slot="synonyms"]')!;
    const offChip = slotHost.querySelector('[data-disabled="true"]') as HTMLElement;
    expect(offChip).not.toBeNull();
    // 흐린 클래스가 붙는다(취소선·회색조 시각은 CSS·여기선 클래스 부여만 본다).
    expect(offChip.classList.contains("entity-mgmt-chip--disabled")).toBe(true);
    expect(offChip.textContent).toContain("만화");
    const restoreBtn = offChip.querySelector("[data-chip-restore]") as HTMLButtonElement;
    expect(restoreBtn).not.toBeNull();
    restoreBtn.click();
    await Promise.resolve();
    expect(restored).toEqual([["work", "synonyms", "만화"]]);
  });

  test("끈 칩은 같은 slot 에만 — 타 slot 끈 칩은 안 섞인다", () => {
    const host = freshHost();
    const r = row();
    const overlay = openEditModal(
      r,
      { ...noopDeps, latestRow: () => r },
      [
        { value: "만화", slot: "synonyms" },
        { value: "절판", slot: "attributes" },
      ],
      [],
      [],
      host,
    );
    const synHost = overlay.querySelector('[data-edit-slot="synonyms"]')!;
    const attrHost = overlay.querySelector('[data-edit-slot="attributes"]')!;
    // synonyms 끈 칩엔 '만화'만, attributes 끈 칩엔 '절판'만.
    expect(synHost.textContent).toContain("만화");
    expect(synHost.textContent).not.toContain("절판");
    expect(attrHost.textContent).toContain("절판");
    expect(attrHost.textContent).not.toContain("만화");
  });

  test("끄기 후 reload — latestDisabled 가 갱신된 끈 칩을 다시 그린다", async () => {
    const host = freshHost();
    let off: DisabledChip[] = [];
    const r = row({ synonyms: [{ value: "소설", source: "yaml", id: null }] });
    const overlay = openEditModal(
      r,
      {
        ...noopDeps,
        // 끄기 콜백이 불리면 latestDisabled 가 그 값을 끈 칩으로 돌려주도록 바꾼다(reload 흉내).
        disableVocab: async (_tn, slot, value) => {
          off = [{ value, slot: slot as DisabledChip["slot"] }];
        },
        latestRow: () => r,
        latestDisabled: () => off,
      },
      [],
      [],
      [],
      host,
    );
    let slotHost = overlay.querySelector('[data-edit-slot="synonyms"]')!;
    (slotHost.querySelector("[data-chip-disable]") as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    // refreshAllSlots 후 그 slot 에 끈 칩 '소설'이 흐리게 다시 그려진다.
    slotHost = overlay.querySelector('[data-edit-slot="synonyms"]')!;
    const offChip = slotHost.querySelector('[data-disabled="true"]') as HTMLElement;
    expect(offChip).not.toBeNull();
    expect(offChip.textContent).toContain("소설");
  });
});

function relRow(overrides: Partial<RelationVocabRow> = {}): RelationVocabRow {
  return {
    relationKey: "창작자",
    relationName: "created_by",
    sourceTypes: ["work"],
    targetTypes: ["person"],
    defaultTargetType: "person",
    source: "code",
    ...overrides,
  };
}

function typeRow(overrides: Partial<EntityTypeRow> = {}): EntityTypeRow {
  return {
    typeName: "work",
    koName: "작품",
    idPrefix: null,
    source: "code",
    columns: [],
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe("openEditModal — 관계 칸(S7b·모달 편입·출발 고정)", () => {
  test("칩 3칸 아래에 관계 칸이 그려진다(그 종류 출발 관계만 목록)", () => {
    const host = freshHost();
    const r = row({ typeName: "work", koName: "작품" });
    const overlay = openEditModal(
      r,
      {
        ...noopDeps,
        latestRow: () => r,
        entityTypes: () => [typeRow({ typeName: "work" }), typeRow({ typeName: "person", koName: "사람" })],
      },
      [],
      [relRow({ relationKey: "주인", source: "code" }), relRow({ relationKey: "감독", source: "user" })],
      [],
      host,
    );
    // 관계 칸이 모달 안에 그려진다.
    const relSection = overlay.querySelector("[data-section='entity-mgmt-relations']");
    expect(relSection).not.toBeNull();
    // 그 종류 출발 관계 2건이 목록에 보인다(panel 이 buildTypeRelations 로 거른 결과를 넘김).
    expect(overlay.querySelector('[data-relation-key="주인"]')).not.toBeNull();
    expect(overlay.querySelector('[data-relation-key="감독"]')).not.toBeNull();
  });

  test("관계 추가 폼에 출발·기본도착 select 가 없다(출발 현재 종류 고정·도착 한 칸)", () => {
    const host = freshHost();
    const r = row({ typeName: "work" });
    const overlay = openEditModal(
      r,
      { ...noopDeps, latestRow: () => r, entityTypes: () => [typeRow()] },
      [],
      [],
      [],
      host,
    );
    // 출발 select 부재(현재 종류 고정·출발 select 안 그림).
    expect(overlay.querySelector("[data-relation-source]")).toBeNull();
    // 기본 도착 select 도 부재(도착 한 칸이라 폐기·사용자 단순화).
    expect(overlay.querySelector("[data-relation-default-target]")).toBeNull();
    // 도착 select 만 있다.
    expect(overlay.querySelector("[data-relation-target]")).not.toBeNull();
  });

  test("관계 추가 → addRelation 이 출발 고정·도착 한 종류 payload 로 불린다", async () => {
    const host = freshHost();
    const addCalls: AddRelationVocabPayload[] = [];
    const r = row({ typeName: "work" });
    const overlay = openEditModal(
      r,
      {
        ...noopDeps,
        latestRow: () => r,
        entityTypes: () => [typeRow({ typeName: "work" }), typeRow({ typeName: "person", koName: "사람" })],
        addRelation: async (payload) => void addCalls.push(payload),
      },
      [],
      [],
      [],
      host,
    );
    (overlay.querySelector("[data-relation-key-input]") as HTMLInputElement).value = "감독";
    (overlay.querySelector("[data-relation-name-input]") as HTMLInputElement).value = "directed_by";
    const targetSelect = overlay.querySelector("[data-relation-target]") as HTMLSelectElement;
    // 도착 한 종류만 고른다 — 'person' 선택.
    targetSelect.value = "person";
    const form = overlay.querySelector(".entity-mgmt-relation-add-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    // 출발은 row.typeName('work') 고정, 도착 한 종류 'person' 이 targetTypes 한 칸·
    // defaultTargetType 둘 다로 들어간다(라우트 계약 유지·UI 단일 입력).
    expect(addCalls).toEqual([
      {
        relationKey: "감독",
        relationName: "directed_by",
        sourceTypes: ["work"],
        targetTypes: ["person"],
        defaultTargetType: "person",
      },
    ]);
  });

  test("user 관계만 삭제 버튼 + removeRelation 호출, code 관계는 삭제 버튼 부재", async () => {
    const host = freshHost();
    const removeCalls: string[] = [];
    const r = row({ typeName: "work" });
    const overlay = openEditModal(
      r,
      {
        ...noopDeps,
        latestRow: () => r,
        entityTypes: () => [typeRow()],
        removeRelation: async (relationKey) => void removeCalls.push(relationKey),
      },
      [],
      [relRow({ relationKey: "주인", source: "code" }), relRow({ relationKey: "감독", source: "user" })],
      [],
      host,
    );
    const codeRow = overlay.querySelector('[data-relation-key="주인"]')!;
    const userRow = overlay.querySelector('[data-relation-key="감독"]')!;
    // code 관계는 삭제 버튼 없음.
    expect(codeRow.querySelector("[data-relation-delete]")).toBeNull();
    // user 관계는 삭제 버튼 있음 → removeRelation 호출.
    const delBtn = userRow.querySelector("[data-relation-delete]") as HTMLButtonElement;
    expect(delBtn).not.toBeNull();
    delBtn.click();
    await flush();
    expect(removeCalls).toEqual(["감독"]);
  });
});

describe("openEditModal — 칸 섹션 위치·user 종류 추가 폼(S8·라이브 정정)", () => {
  test("칸 섹션이 라벨(attributes) 슬롯보다 DOM 앞에 그려진다(중요도 순)", () => {
    const host = freshHost();
    const r = row();
    const overlay = openEditModal(r, { ...noopDeps, latestRow: () => r }, [], [], [], host);
    const columnSection = overlay.querySelector("[data-section='entity-mgmt-columns']")!;
    const attrSlot = overlay.querySelector('[data-edit-slot="attributes"]')!;
    expect(columnSection).not.toBeNull();
    expect(attrSlot).not.toBeNull();
    // 칸 섹션이 라벨 슬롯보다 문서상 앞에 온다(DOCUMENT_POSITION_FOLLOWING = 라벨이 칸 뒤).
    const pos = columnSection.compareDocumentPosition(attrSlot);
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("동의어·하위분류는 칸 섹션보다 앞·관계 칸은 라벨 뒤(전체 순서 유지)", () => {
    const host = freshHost();
    const r = row({ source: "user" });
    const overlay = openEditModal(
      r,
      { ...noopDeps, latestRow: () => r, entityTypes: () => [typeRow()] },
      [],
      [],
      [],
      host,
    );
    const syn = overlay.querySelector('[data-edit-slot="synonyms"]')!;
    const sub = overlay.querySelector('[data-edit-slot="subcategories"]')!;
    const col = overlay.querySelector("[data-section='entity-mgmt-columns']")!;
    const attr = overlay.querySelector('[data-edit-slot="attributes"]')!;
    const rel = overlay.querySelector("[data-section='entity-mgmt-relations']")!;
    // 순서: 동의어 → 하위분류 → 칸 → 라벨 → 관계. 각 앞 요소가 뒤 요소보다 문서상 앞이어야 한다.
    const before = (a: Element, b: Element): boolean =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(syn, sub)).toBe(true);
    expect(before(sub, col)).toBe(true);
    expect(before(col, attr)).toBe(true);
    expect(before(attr, rel)).toBe(true);
  });

  test("user 종류 → 칸 추가 폼(입력·라디오·추가 버튼) 그려짐", () => {
    const host = freshHost();
    const r = row({ typeName: "ledger", koName: "가계부", source: "user", deletableTypeName: "ledger" });
    const overlay = openEditModal(r, { ...noopDeps, latestRow: () => r }, [], [], [], host);
    const colSection = overlay.querySelector("[data-section='entity-mgmt-columns']")!;
    // user 종류면 칸 이름 입력·datatype 라디오 2개·추가 버튼이 있다(추가 가능).
    expect(colSection.querySelector("[data-column-key-input]")).not.toBeNull();
    expect(colSection.querySelector('[data-column-type="text"]')).not.toBeNull();
    expect(colSection.querySelector('[data-column-type="number"]')).not.toBeNull();
    expect(colSection.querySelector(".entity-mgmt-column-add-btn")).not.toBeNull();
  });

  test("code 종류 → 칸 추가 폼 없음(읽기전용)", () => {
    const host = freshHost();
    const r = row({ source: "code" }); // 기본 work·code
    const overlay = openEditModal(r, { ...noopDeps, latestRow: () => r }, [], [], [], host);
    const colSection = overlay.querySelector("[data-section='entity-mgmt-columns']")!;
    // code 종류는 추가 폼·삭제 버튼이 없다(읽기전용).
    expect(colSection.querySelector("[data-column-key-input]")).toBeNull();
    expect(colSection.querySelector("[data-column-delete]")).toBeNull();
  });

  test("칸 추가 폼 제출 → addColumn(typeName, key, dataType) 가 그 종류로 불린다", async () => {
    const host = freshHost();
    const calls: Array<[string, string, string]> = [];
    const r = row({ typeName: "ledger", koName: "가계부", source: "user", deletableTypeName: "ledger" });
    const overlay = openEditModal(
      r,
      {
        ...noopDeps,
        latestRow: () => r,
        addColumn: async (tn, key, dataType) => {
          calls.push([tn, key, dataType]);
          return { columnsResult: { ok: true, message: "" } };
        },
      },
      [],
      [],
      [],
      host,
    );
    const colSection = overlay.querySelector("[data-section='entity-mgmt-columns']")!;
    (colSection.querySelector("[data-column-key-input]") as HTMLInputElement).value = "메모";
    const form = colSection.querySelector(".entity-mgmt-column-add") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    // 출발 종류는 row.typeName('ledger') 고정·기본 datatype 글자형.
    expect(calls).toEqual([["ledger", "메모", "text"]]);
  });
});
