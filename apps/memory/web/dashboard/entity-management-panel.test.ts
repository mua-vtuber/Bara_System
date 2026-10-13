/**
 * entity-management-panel.test.ts — 패널 저장 오케스트레이터 통합 검증 (엔티티 관리 통합 S7a).
 *
 * 검증 정신 — fetch mock 0·Mock 객체 0:
 *   renderEntityManagementPanel 은 api 를 인자로 받는다. 여기 주입하는 api 는 *plain 객체*
 *   (함수 몇 개 담은 데이터)다 — 인터페이스 가짜 구현 클래스가 아니다. 호출 횟수·순서·인자를
 *   배열에 기록해 단언한다. 모달은 panel 의 "새 종류 추가" 버튼 클릭으로 document.body 에
 *   뜨므로, 공개 진입점(renderEntityManagementPanel)만으로 저장 오케스트레이터(runAddSave)
 *   전체 경로를 덮는다(테스트용 export 불필요·프로덕션 동작 무변경).
 *
 * 사용자 확정 핵심 = 부분 저장 옵션 ⓐ. 네 경로를 직접 단언한다:
 *   1) 전부 성공 → 모달 닫힘 + reload(api.list 재호출).
 *   2) 부분 실패(addVocab 하나 throw) → 모달 유지 + 실패 칩 안내 + reload 일어남 +
 *      롤백 removeType 호출 0(멀쩡한 종류 보존·ⓑ 안 씀).
 *   3) 종류 생성 실패(addType throw) → addVocab 0건 호출 + .modal-error 라우트 메시지 + 모달 유지.
 *   4) 순차 보장 → addVocab 호출이 순차(직렬)임을 호출 순서 기록으로 단언.
 */

import "../../test-setup-dom";
import { describe, test, expect, beforeEach } from "bun:test";
import { renderEntityManagementPanel } from "./entity-management-panel";
import type {
  EntityManagementData,
  EntityManagementPanelApi,
} from "./entity-management-api";
import type { AddEntityTypePayload } from "./entity-types-panel-api";
import type { AddClassifyVocabPayload } from "./classify-vocab-panel-api";

/** 빈 데이터 객체 — list() 기본 응답(종류 0·어휘 0·관계 0). */
function emptyData(): EntityManagementData {
  return {
    entityTypes: [],
    vocab: { entries: [], overrides: [] },
    relationKeys: [],
    relationVocab: [],
  };
}

/** 호출 기록을 담는 plain api(인터페이스 가짜 구현 클래스 아님·데이터 + 함수). */
interface RecordingApi extends EntityManagementPanelApi {
  log: string[];
  listCount: { n: number };
  addTypeCalls: AddEntityTypePayload[];
  addVocabCalls: AddClassifyVocabPayload[];
  removeTypeCalls: string[];
  addColumnCalls: Array<[string, string, string]>;
  removeColumnCalls: string[];
}

/**
 * 호출을 배열에 기록하는 plain api 를 만든다. 옵션으로 addType·addVocab 의 실패를 주입해
 * 부분 실패·종류 생성 실패 경로를 만든다(throw = 라우트 400 흉내가 아니라 *결과* 주입).
 * data 를 주면 list() 가 그 데이터를 돌려준다(종류·끈 값 fixture·관계 섹션·끈 칩 검증용).
 */
function makeRecordingApi(opts: {
  addTypeError?: string;
  /** value(소문자) → 에러 메시지. 그 어휘 addVocab 이 throw 한다. */
  vocabErrors?: Record<string, string>;
  /** 칸 키(소문자) → columns POST 실패 메시지(addColumn 의 columnsResult 가 실패로 온다). */
  columnErrors?: Record<string, string>;
  /** 칸 키(소문자) → column_types POST 실패 메시지(숫자형 datatype 지정만 실패·옵션 ⓐ). */
  columnTypeErrors?: Record<string, string>;
  /** list() 가 돌려줄 데이터(미지정 시 빈 데이터). */
  data?: EntityManagementData;
}): RecordingApi {
  const log: string[] = [];
  const listCount = { n: 0 };
  const addTypeCalls: AddEntityTypePayload[] = [];
  const addVocabCalls: AddClassifyVocabPayload[] = [];
  const removeTypeCalls: string[] = [];
  const addColumnCalls: Array<[string, string, string]> = [];
  const removeColumnCalls: string[] = [];
  return {
    log,
    listCount,
    addTypeCalls,
    addVocabCalls,
    removeTypeCalls,
    addColumnCalls,
    removeColumnCalls,
    async list() {
      listCount.n += 1;
      log.push(`list:${listCount.n}`);
      return opts.data ?? emptyData();
    },
    async addType(payload) {
      addTypeCalls.push(payload);
      log.push(`addType:${payload.typeName}`);
      if (opts.addTypeError) throw new Error(opts.addTypeError);
    },
    async addVocab(payload) {
      addVocabCalls.push(payload);
      const value = "value" in payload ? payload.value : "";
      log.push(`addVocab:${value}`);
      const msg = opts.vocabErrors?.[value.toLowerCase()];
      if (msg) throw new Error(msg);
    },
    async removeType(typeName) {
      removeTypeCalls.push(typeName);
      log.push(`removeType:${typeName}`);
    },
    async removeVocab() {
      log.push("removeVocab");
    },
    async disableVocab(typeName, slot, value) {
      log.push(`disableVocab:${typeName}:${slot}:${value}`);
    },
    async restoreVocab(typeName, slot, value) {
      log.push(`restoreVocab:${typeName}:${slot}:${value}`);
    },
    async addColumn(typeName, columnKey, dataType) {
      addColumnCalls.push([typeName, columnKey, dataType]);
      log.push(`addColumn:${typeName}:${columnKey}:${dataType}`);
      const key = columnKey.toLowerCase();
      // columns POST 실패 주입(칸 자체 실패) — column_types 는 안 부른다(칸 없는데 datatype 무의미).
      const colErr = opts.columnErrors?.[key];
      if (colErr) {
        return { columnsResult: { ok: false, message: colErr } };
      }
      // 글자형이면 columns 한 건만(column_types 결과 없음). 숫자형이면 column_types 결과도 담는다.
      if (dataType !== "number") {
        return { columnsResult: { ok: true, message: "" } };
      }
      const typeErr = opts.columnTypeErrors?.[key];
      return {
        columnsResult: { ok: true, message: "" },
        columnTypesResult: typeErr
          ? { ok: false, message: typeErr }
          : { ok: true, message: "" },
      };
    },
    async removeColumn(columnEntryId) {
      removeColumnCalls.push(columnEntryId);
      log.push(`removeColumn:${columnEntryId}`);
    },
  };
}

/** panel 을 렌더하고 초기 list 가 끝나길 기다린다(진입 시 reload). */
async function mountPanel(api: RecordingApi): Promise<HTMLElement> {
  const panel = renderEntityManagementPanel(api);
  document.body.appendChild(panel);
  await flush();
  return panel;
}

/** 추가 버튼을 눌러 모달을 띄운다(document.body 에 뜬다). */
function openAddModalViaButton(panel: HTMLElement): HTMLElement {
  (panel.querySelector("[data-add-type]") as HTMLButtonElement).click();
  const overlay = document.querySelector("[data-section='entity-mgmt-modal']");
  if (!overlay) throw new Error("추가 모달이 뜨지 않았습니다");
  return overlay as HTMLElement;
}

/** 모달 필드·칩을 채운다(표시명·영문키 + 선택 동의어 칩들). */
function fillForm(
  overlay: HTMLElement,
  koName: string,
  typeName: string,
  synonyms: string[] = [],
): void {
  (overlay.querySelector('[data-field="koName"]') as HTMLInputElement).value = koName;
  const keyInput = overlay.querySelector('[data-field="typeName"]') as HTMLInputElement;
  keyInput.value = typeName;
  // input 이벤트를 보내 접두사 자동 추천이 실제 UI 처럼 흐르게 한다(suggestIdPrefix).
  keyInput.dispatchEvent(new Event("input", { bubbles: true }));
  const synInput = overlay.querySelector('[data-chip-input="synonyms"]') as HTMLInputElement;
  for (const s of synonyms) {
    synInput.value = s;
    synInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
}

/** 추가 모달 칸 로컬 에디터에 칸 한 건을 더한다(이름 + datatype). 저장 전 로컬·POST 0. */
function addColumnViaEditor(
  overlay: HTMLElement,
  key: string,
  dataType: "text" | "number" | "date",
): void {
  const sec = overlay.querySelector("[data-section='entity-mgmt-add-columns']");
  if (!sec) throw new Error("칸 에디터가 없습니다");
  const input = sec.querySelector("[data-column-key-input]") as HTMLInputElement;
  const form = sec.querySelector(".entity-mgmt-column-add") as HTMLFormElement;
  input.value = key;
  if (dataType === "number") {
    (sec.querySelector('[data-column-type="number"]') as HTMLInputElement).checked = true;
  } else {
    (sec.querySelector('[data-column-type="text"]') as HTMLInputElement).checked = true;
  }
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

/** 저장 버튼 클릭. */
function clickSave(overlay: HTMLElement): void {
  (overlay.querySelector("[data-modal-save]") as HTMLButtonElement).click();
}

/** 마이크로태스크 큐를 비운다(여러 await 체인이 정착하도록 넉넉히 돌린다). */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe("renderEntityManagementPanel — 저장 오케스트레이터 통합(부분 저장 ⓐ)", () => {
  // 각 테스트 전 document.body 를 비운다 — panel·모달이 body 에 붙으므로 앞 테스트의
  // 잔여 DOM(특히 안 닫힌 부분 실패 모달)이 다음 테스트의 쿼리를 흐리지 않게 한다.
  beforeEach(() => {
    document.body.textContent = "";
  });

  test("경로1 전부 성공 → 모달 닫힘 + reload(api.list 재호출)", async () => {
    const api = makeRecordingApi({});
    const panel = await mountPanel(api);
    const listAfterMount = api.listCount.n; // 진입 reload 1회.

    const overlay = openAddModalViaButton(panel);
    // fillForm 이 영문키에 input 이벤트를 보내 접두사가 'equ_' 로 자동 추천된다(실제 UI 흐름).
    fillForm(overlay, "장비", "equipment", ["키보드", "마우스"]);
    clickSave(overlay);
    await flush();

    // 종류 1건(자동 추천 접두사 포함) + 어휘 2건 호출.
    expect(api.addTypeCalls).toEqual([{ typeName: "equipment", koName: "장비", idPrefix: "equ_" }]);
    expect(api.addVocabCalls).toEqual([
      { typeName: "equipment", slot: "synonyms", value: "키보드" },
      { typeName: "equipment", slot: "synonyms", value: "마우스" },
    ]);
    // reload 가 일어나 list 가 한 번 더 불렸다.
    expect(api.listCount.n).toBeGreaterThan(listAfterMount);
    // 모달이 닫혔다(오버레이가 DOM 에서 빠짐).
    expect(document.querySelector("[data-section='entity-mgmt-modal']")).toBeNull();
    // 롤백 removeType 호출 0(성공 경로).
    expect(api.removeTypeCalls).toEqual([]);
  });

  test("경로2 부분 실패(addVocab 하나 throw) → 모달 유지 + 실패 안내 + reload + 롤백 0", async () => {
    // '마우스' addVocab 이 throw — 종류·'키보드'는 성공.
    const api = makeRecordingApi({ vocabErrors: { "마우스": "이미 등록된 어휘" } });
    const panel = await mountPanel(api);
    const listAfterMount = api.listCount.n;

    const overlay = openAddModalViaButton(panel);
    fillForm(overlay, "장비", "equipment", ["키보드", "마우스"]);
    clickSave(overlay);
    await flush();

    // 종류 1 + 어휘 2 다 시도(한 칩 실패가 다음을 안 막음 — 둘 다 호출됨).
    expect(api.addTypeCalls.length).toBe(1);
    expect(api.addVocabCalls.map((c) => ("value" in c ? c.value : ""))).toEqual([
      "키보드",
      "마우스",
    ]);
    // 모달이 안 닫혔다(부분 실패).
    expect(document.querySelector("[data-section='entity-mgmt-modal']")).not.toBeNull();
    // 실패 칩 안내가 보인다.
    const failLines = overlay.querySelectorAll("[data-fail-line]");
    expect(failLines.length).toBe(1);
    expect(failLines[0]!.textContent).toContain("마우스");
    expect(failLines[0]!.textContent).toContain("이미 등록된 어휘");
    // 성공분 즉시 반영을 위해 reload 가 일어났다.
    expect(api.listCount.n).toBeGreaterThan(listAfterMount);
    // 롤백 removeType 호출 0(멀쩡한 종류 보존·옵션 ⓑ 안 씀).
    expect(api.removeTypeCalls).toEqual([]);
  });

  test("경로3 종류 생성 실패(addType throw) → addVocab 0건 + .modal-error + 모달 유지", async () => {
    const api = makeRecordingApi({
      addTypeError: "addEntityType: 'person' 은 코드 상수 10종이라 새 종류로 더할 수 없다",
    });
    const panel = await mountPanel(api);
    const listAfterMount = api.listCount.n;

    const overlay = openAddModalViaButton(panel);
    fillForm(overlay, "사람2", "person", ["키보드"]);
    clickSave(overlay);
    await flush();

    // 종류 생성만 시도, 어휘는 0건(종류 실패 시 어휘 호출 안 함).
    expect(api.addTypeCalls.length).toBe(1);
    expect(api.addVocabCalls).toEqual([]);
    // .modal-error 에 라우트 메시지 그대로.
    const err = overlay.querySelector("[data-modal-error]") as HTMLElement;
    expect(err.textContent).toContain("코드 상수 10종");
    // 모달 유지(닫히지 않음).
    expect(document.querySelector("[data-section='entity-mgmt-modal']")).not.toBeNull();
    // reload 안 일어남(종류 생성 자체 실패 — 표 변화 없음).
    expect(api.listCount.n).toBe(listAfterMount);
    // 롤백 removeType 0.
    expect(api.removeTypeCalls).toEqual([]);
  });

  test("경로4 순차 보장 → addVocab 호출이 직렬(addType → 키보드 → 마우스 순서)", async () => {
    const api = makeRecordingApi({});
    const panel = await mountPanel(api);
    api.log.length = 0; // 진입 list 로그를 비우고 저장 흐름만 본다.

    const overlay = openAddModalViaButton(panel);
    fillForm(overlay, "장비", "equipment", ["키보드", "마우스"]);
    clickSave(overlay);
    await flush();

    // addType 이 먼저, 그 뒤 어휘가 입력 순서(키보드→마우스)대로 직렬로 불렸다.
    // 어휘 두 건이 addType 뒤에 차례로 와야 한다(병렬이면 순서가 흐트러질 수 있다).
    const addTypeIdx = api.log.indexOf("addType:equipment");
    const kbIdx = api.log.indexOf("addVocab:키보드");
    const msIdx = api.log.indexOf("addVocab:마우스");
    expect(addTypeIdx).toBeGreaterThanOrEqual(0);
    expect(kbIdx).toBeGreaterThan(addTypeIdx);
    expect(msIdx).toBeGreaterThan(kbIdx);
  });
});

describe("renderEntityManagementPanel — 추가 모달 칸 단계(runAddSave·S8)", () => {
  beforeEach(() => {
    document.body.textContent = "";
  });

  test("종류 생성 → 어휘 → 칸 순차 POST(addColumn 이 각 칸으로·어휘 다음에 칸)", async () => {
    const api = makeRecordingApi({});
    const panel = await mountPanel(api);

    const overlay = openAddModalViaButton(panel);
    fillForm(overlay, "가계부", "ledger", ["장부"]);
    addColumnViaEditor(overlay, "메모", "text"); // 글자형.
    addColumnViaEditor(overlay, "금액", "number"); // 숫자형.
    clickSave(overlay);
    await flush();

    // addColumn 이 각 칸으로 불린다(이름·타입 그대로). 어휘 다음에 칸이 온다(로그 순서).
    expect(api.addColumnCalls).toEqual([
      ["ledger", "메모", "text"],
      ["ledger", "금액", "number"],
    ]);
    const vocabIdx = api.log.indexOf("addVocab:장부");
    const colMemoIdx = api.log.indexOf("addColumn:ledger:메모:text");
    const colAmountIdx = api.log.indexOf("addColumn:ledger:금액:number");
    expect(vocabIdx).toBeGreaterThanOrEqual(0);
    expect(colMemoIdx).toBeGreaterThan(vocabIdx); // 칸이 어휘 뒤.
    expect(colAmountIdx).toBeGreaterThan(colMemoIdx); // 칸 순서 유지.
    // 전부 성공 → 모달 닫힘.
    expect(document.querySelector("[data-section='entity-mgmt-modal']")).toBeNull();
    // 롤백 0.
    expect(api.removeTypeCalls).toEqual([]);
    expect(api.removeColumnCalls).toEqual([]);
  });

  test("칸 일부 실패(columns POST 거부) → 종류·앞선 것 살리고 실패 칸만 알림·롤백 0", async () => {
    // '금액' 칸이 columns POST 에서 거부된다(기존 10종 동결 흉내 메시지) — '메모'는 성공.
    const api = makeRecordingApi({ columnErrors: { "금액": "이미 라벨로 정의됨" } });
    const panel = await mountPanel(api);

    const overlay = openAddModalViaButton(panel);
    fillForm(overlay, "가계부", "ledger", []);
    addColumnViaEditor(overlay, "메모", "text");
    addColumnViaEditor(overlay, "금액", "text");
    clickSave(overlay);
    await flush();

    // 두 칸 다 시도된다(한 칸 실패가 다음 칸을 안 막음).
    expect(api.addColumnCalls.map((c) => c[1])).toEqual(["메모", "금액"]);
    // 모달이 안 닫혔다(부분 실패).
    expect(document.querySelector("[data-section='entity-mgmt-modal']")).not.toBeNull();
    // 실패 칸만 안내(금액)·메모는 성공이라 안 뜬다.
    const failLines = Array.from(overlay.querySelectorAll("[data-fail-line]"));
    expect(failLines.length).toBe(1);
    expect(failLines[0]!.textContent).toContain("금액");
    expect(failLines[0]!.textContent).toContain("이미 라벨로 정의됨");
    // [칸] 라벨로 어휘와 갈라 보인다(SLOT_KO columns).
    expect(failLines[0]!.textContent).toContain("칸");
    // 롤백 DELETE 0(멀쩡한 종류·메모 칸 보존·옵션 ⓐ).
    expect(api.removeTypeCalls).toEqual([]);
    expect(api.removeColumnCalls).toEqual([]);
  });

  test("숫자형 칸 datatype 지정만 실패 → 칸은 살리고 실패만 알림(옵션 ⓐ·롤백 0)", async () => {
    // '금액' 칸은 columns 성공·column_types 만 실패(칸은 글자형으로 살아 있다).
    const api = makeRecordingApi({ columnTypeErrors: { "금액": "datatype 거부" } });
    const panel = await mountPanel(api);

    const overlay = openAddModalViaButton(panel);
    fillForm(overlay, "가계부", "ledger", []);
    addColumnViaEditor(overlay, "금액", "number");
    clickSave(overlay);
    await flush();

    // addColumn 이 숫자형으로 불렸다.
    expect(api.addColumnCalls).toEqual([["ledger", "금액", "number"]]);
    // 모달 유지 + 실패 안내(금액·datatype 거부).
    expect(document.querySelector("[data-section='entity-mgmt-modal']")).not.toBeNull();
    const failLines = Array.from(overlay.querySelectorAll("[data-fail-line]"));
    expect(failLines.length).toBe(1);
    expect(failLines[0]!.textContent).toContain("금액");
    expect(failLines[0]!.textContent).toContain("datatype 거부");
    // 롤백 0(칸은 글자형으로 살아 있다).
    expect(api.removeColumnCalls).toEqual([]);
  });

  test("종류 생성 실패 → 어휘·칸 0건 호출(칸 단계도 안 탐)", async () => {
    const api = makeRecordingApi({ addTypeError: "코드 상수 10종 충돌" });
    const panel = await mountPanel(api);

    const overlay = openAddModalViaButton(panel);
    fillForm(overlay, "사람2", "person", []);
    addColumnViaEditor(overlay, "메모", "text");
    clickSave(overlay);
    await flush();

    // 종류 생성 실패 → 어휘도 칸도 0건(throw 가 runAddSave 를 끊는다).
    expect(api.addVocabCalls).toEqual([]);
    expect(api.addColumnCalls).toEqual([]);
    // .modal-error 에 라우트 메시지·모달 유지.
    const err = overlay.querySelector("[data-modal-error]") as HTMLElement;
    expect(err.textContent).toContain("코드 상수 10종");
    expect(document.querySelector("[data-section='entity-mgmt-modal']")).not.toBeNull();
  });
});

describe("renderEntityManagementPanel — 관계 모달 편입·끈 칩 모달 전달(S7b·라이브 정정)", () => {
  beforeEach(() => {
    document.body.textContent = "";
  });

  test("관계 설정 섹션이 종류 표 아래에 더 이상 없다(모달 편입·라이브 정정)", async () => {
    const api = makeRecordingApi({});
    const panel = await mountPanel(api);
    // 옛 "표 아래 별 섹션"을 폐기하고 관계를 수정 모달 안으로 옮겼다. 평소 패널에는 관계
    // 섹션이 안 보인다(모달을 열어야 그 종류 관계가 뜬다).
    expect(panel.querySelector("[data-section='entity-mgmt-relations']")).toBeNull();
  });

  test("수정 모달 열 때 그 종류의 끈 칩이 모달에 흐리게 전달된다(buildDisabledChips 경유)", async () => {
    // work 종류에 yaml '소설' 켜짐 + synonyms '만화' 끈 값(override) fixture.
    const data: EntityManagementData = {
      entityTypes: [
        { typeName: "work", koName: "작품", idPrefix: null, source: "code", columns: [] },
      ],
      vocab: {
        entries: [
          { id: null, typeName: "work", slot: "synonyms", value: "소설", source: "yaml" },
        ],
        overrides: [
          { id: "ov1", typeName: "work", slot: "synonyms", value: "만화", kind: "tombstone" },
        ],
      },
      relationKeys: [],
      relationVocab: [],
    };
    const api = makeRecordingApi({ data });
    const panel = await mountPanel(api);

    // 표 수정 버튼을 눌러 모달을 연다.
    const editBtn = panel.querySelector("[data-edit-type]") as HTMLButtonElement;
    expect(editBtn).not.toBeNull();
    editBtn.click();
    await flush();

    const overlay = document.querySelector("[data-section='entity-mgmt-modal']") as HTMLElement;
    expect(overlay).not.toBeNull();
    // 끈 칩 '만화'가 흐리게 전달돼 그려진다(buildDisabledChips 가 work synonyms 끈 값을 모음).
    const synHost = overlay.querySelector('[data-edit-slot="synonyms"]')!;
    const offChip = synHost.querySelector('[data-disabled="true"]') as HTMLElement;
    expect(offChip).not.toBeNull();
    expect(offChip.textContent).toContain("만화");
    // 켜진 칩 '소설'은 끄기 토글이 붙는다(yaml 출처).
    expect(synHost.textContent).toContain("소설");
  });

  test("수정 모달 열 때 그 종류가 출발인 관계만 모달에 전달된다(buildTypeRelations 경유)", async () => {
    // work 출발 '주인'·project 출발 '참여자' fixture — work 모달엔 '주인'만 보여야 한다.
    const data: EntityManagementData = {
      entityTypes: [
        { typeName: "work", koName: "작품", idPrefix: null, source: "code", columns: [] },
        { typeName: "project", koName: "프로젝트", idPrefix: null, source: "code", columns: [] },
      ],
      vocab: { entries: [], overrides: [] },
      relationKeys: ["주인", "참여자"],
      relationVocab: [
        {
          relationKey: "주인",
          relationName: "owned_by",
          sourceTypes: ["work"],
          targetTypes: ["person"],
          defaultTargetType: "person",
          source: "code",
        },
        {
          relationKey: "참여자",
          relationName: "participated_by",
          sourceTypes: ["project"],
          targetTypes: ["person"],
          defaultTargetType: "person",
          source: "code",
        },
      ],
    };
    const api = makeRecordingApi({ data });
    const panel = await mountPanel(api);

    // 첫 종류(work) 수정 버튼을 눌러 모달을 연다.
    const editBtn = panel.querySelector("[data-edit-type]") as HTMLButtonElement;
    expect(editBtn).not.toBeNull();
    editBtn.click();
    await flush();

    const overlay = document.querySelector("[data-section='entity-mgmt-modal']") as HTMLElement;
    expect(overlay).not.toBeNull();
    // 관계 칸이 모달 안에 그려진다.
    expect(overlay.querySelector("[data-section='entity-mgmt-relations']")).not.toBeNull();
    // work 출발 '주인'만 보인다 — project 출발 '참여자'는 안 섞인다.
    expect(overlay.querySelector('[data-relation-key="주인"]')).not.toBeNull();
    expect(overlay.querySelector('[data-relation-key="참여자"]')).toBeNull();
    // 관계 추가 폼 출발 select 가 없다(현재 종류 work 고정).
    expect(overlay.querySelector("[data-relation-source]")).toBeNull();
  });
});
