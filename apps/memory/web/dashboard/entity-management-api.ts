/**
 * entity-management-api.ts — 엔티티 관리 통합 탭 데이터 계층 (엔티티 관리 통합 S6).
 *
 * 책임 둘로 가른다:
 *   1. createEntityManagementPanelApi — 기존 세 GET 라우트를 same-origin 으로 불러오는
 *      fetch 부수효과. 새 라우트·새 백엔드를 짜지 않는다(S6 계약). 종류 삭제·어휘 삭제는
 *      이미 있는 entity-types-panel-api·classify-vocab-panel-api 의 remove 를 재사용한다.
 *   2. buildEntityManagementRows — fetch 없이 *순수 함수*. 세 라우트가 준 데이터를
 *      "표 한 행 = 한 엔티티 종류" 배열로 바꾼다. fixture 입력만으로 단위 검증된다.
 *
 * 조인·필터 규칙(메인 확정 설계):
 *   - 행 기준 = entity-types(종류 뼈대). 종류별로 한 행.
 *   - 분류 이름 = koName + 그 종류의 synonyms 칩.
 *   - 영문키 = typeName 직출력(그래프 플래그가 아님).
 *   - 하위분류 = 그 종류의 subcategories 칩.
 *   - 칸 = 그 종류 entity-types columns[] 칩(글자형/숫자형/날짜형 배지 포함).
 *   - 라벨 = 그 종류의 attributes 칩 — 단 relation-vocab 의 relationKey·그 종류의 칸 키
 *     (entity-types columns)와 겹치는 값은 뺀다(칸으로 분류되는 값이 라벨에 유령으로 겹쳐
 *     보이는 표시 버그 차단·백엔드 entity-attribute-wiring 의 라벨 = attributes − 칸 − 관계 키 정합).
 *   - 끈 값(가림표 overrides 매칭)은 칩에서 완전히 뺀다(방법2·소문자 비교).
 *
 * silent fallback 금지: list() 가 세 라우트 중 하나라도 실패하면 그 에러를 그대로 throw
 * 한다(빈 표로 안 가린다). 패널이 그 에러를 명시 박스로 보인다.
 */

import { apiFetch } from "./api-fetch";
import {
  createEntityTypesPanelApi,
  type EntityTypeRow,
  type AddEntityTypePayload,
} from "./entity-types-panel-api";
import {
  createClassifyVocabPanelApi,
  type ClassifyVocabRow,
  type ClassifyVocabSlot,
  type AddClassifyVocabPayload,
} from "./classify-vocab-panel-api";
import type { RelationVocabRow } from "./relation-vocab-panel-api";
import { buildAddColumnCalls, type ColumnDataType } from "./entity-management-save";

const API_BASE = "/api";

/**
 * 가림표(끈 값) 한 건 — GET /api/classify-vocab 응답 overrides[] 한 건.
 * (typeName, slot, value) 가 꺼진 분류 어휘를 가리킨다(kind="tombstone").
 */
export interface ClassifyVocabOverride {
  id: string;
  typeName: string;
  slot: ClassifyVocabSlot;
  value: string;
  kind: string;
}

/** GET /api/classify-vocab 전체 응답 — entries(끈 값 포함 원본) + overrides(끈 값 목록). */
export interface ClassifyVocabListing {
  entries: ClassifyVocabRow[];
  overrides: ClassifyVocabOverride[];
}

/** 세 라우트가 준 데이터 묶음 — buildEntityManagementRows 의 입력. */
export interface EntityManagementData {
  entityTypes: EntityTypeRow[];
  vocab: ClassifyVocabListing;
  /** relation-vocab 의 relationKey 모음(라벨 칸에서 빼는 용도·표시는 안 한다). */
  relationKeys: string[];
  /**
   * relation-vocab 전체 행(sourceTypes·targetTypes 포함). 수정 모달이 "그 종류가 출발인
   * 관계만" 필터(buildTypeRelations)하는 단일 출처다(S7b·라이브 정정·모달 편입). 같은
   * /relation-vocab 응답에서 relationKeys 와 함께 뽑아, 모달이 새 fetch 없이 panel 메모리의
   * 이 배열을 본다.
   */
  relationVocab: RelationVocabRow[];
}

/**
 * 칩 한 개 — 분류 어휘 한 값. user 출처(id 보유)면 칩에 삭제가 붙고, yaml 출처(id=null)면
 * 읽기전용이다(라우트 계약 — yaml 어휘는 id 없음·삭제 불가). 끈 값은 애초에 칩이 안 만들어진다.
 */
export interface VocabChip {
  value: string;
  source: ClassifyVocabRow["source"];
  /** user 출처면 DELETE /api/classify-vocab/:id 용 entryId, yaml 출처면 null. */
  id: string | null;
}

/**
 * 끈 칩 한 개 — 수정 모달이 켜진 칩 뒤에 흐리게 잇는 가림표(tombstone) 한 건(S7b).
 * value 는 끈 어휘 값, slot 은 끈 칸(synonyms·subcategories·attributes 중 하나). 되살리기
 * 토글이 DELETE /api/classify-vocab/override 로 이 (typeName, slot, value) 를 지운다.
 */
export interface DisabledChip {
  value: string;
  slot: ClassifyVocabSlot;
}

/**
 * 칸 칩 한 개 — 수정 모달 "칸" 섹션이 그리는 한 칸(S8). key 는 칸 키(한국어), dataType 은
 * 글자형/숫자형/날짜형 배지·라디오 기본값에 쓴다. id 는 columns slot user 행의 entry_id 로 삭제용
 * (user 종류만 보유), code 종류 칸이나 yaml 기준선 칸은 id=null(읽기전용·삭제 버튼 안 붙음).
 */
export interface ColumnChip {
  key: string;
  dataType: ColumnDataType;
  semantic?: "alias";
  helpText?: string;
  /** user 출처 칸이면 DELETE /api/classify-vocab/:id 용 entryId, 그 외 null(읽기전용). */
  id: string | null;
}

/** 표 한 행 = 한 엔티티 종류. 칩 세 묶음은 끈 값·관계 키를 이미 뺀 결과다. */
export interface EntityManagementRow {
  typeName: string;
  koName: string;
  source: EntityTypeRow["source"];
  /** 분류 이름 칸의 동의어 칩(synonyms·끈 값 제외). */
  synonyms: VocabChip[];
  /** 하위분류 칸 칩(subcategories·끈 값 제외). */
  subcategories: VocabChip[];
  /** 칸 칩(entity-types columns[] + columns slot user id 조인). */
  columns: ColumnChip[];
  /** 라벨 칸 칩(attributes·끈 값 제외·관계 키 제외). */
  labels: VocabChip[];
  /** user 종류면 삭제할 종류 키(=typeName), code 종류면 null(읽기전용). */
  deletableTypeName: string | null;
}

/** 패널이 호출하는 데이터 계약 — 실제 fetch 구현은 createEntityManagementPanelApi. */
export interface EntityManagementPanelApi {
  /** 세 GET 라우트를 병렬 호출해 한 묶음으로 돌려준다(하나라도 실패하면 throw). */
  list(): Promise<EntityManagementData>;
  /**
   * 종류 추가 — POST /api/entity-types(entity-types-panel-api.add 재사용). 실패 시 라우트
   * 400 메시지를 그대로 throw(코드 10종 충돌·중복은 라우트 단일 출처). 새 라우트 0.
   */
  addType(payload: AddEntityTypePayload): Promise<void>;
  /**
   * 어휘 한 건 추가 — POST /api/classify-vocab(classify-vocab-panel-api.add 재사용). 실패 시
   * 라우트 400 메시지를 그대로 throw(불변식 위반 등). 새 라우트 0.
   */
  addVocab(payload: AddClassifyVocabPayload): Promise<void>;
  /** 종류 삭제 — DELETE /api/entity-types/:typeName(기존 api 재사용). */
  removeType(typeName: string): Promise<void>;
  /** 어휘 값 삭제 — DELETE /api/classify-vocab/:id(기존 api 재사용). */
  removeVocab(id: string): Promise<void>;
  /**
   * 기본 어휘 끄기 — POST /api/classify-vocab/override(가림표 추가·S5 라우트 재사용·새
   * 라우트 0). yaml·코드 10종이 준 값만 끈다(사용자 값은 라우트 400 거부). 실패 시 라우트
   * 400 메시지를 그대로 throw.
   */
  disableVocab(typeName: string, slot: ClassifyVocabSlot, value: string): Promise<void>;
  /**
   * 끈 어휘 되살리기 — DELETE /api/classify-vocab/override(가림표 삭제·S5 라우트 재사용).
   * 같은 (typeName, slot, value) 를 가림표에서 지운다(없으면 멱등 no-op). 실패 시 throw.
   */
  restoreVocab(typeName: string, slot: ClassifyVocabSlot, value: string): Promise<void>;
  /**
   * 칸 추가(S8) — columns POST 후 (number/date면) column_types POST 를 *순차* 부른다(둘째가
   * 첫째 칸을 datatype 으로 표지하므로 순서 의존). 결과 묶음을 돌려준다(부분 실패 = 옵션 ⓐ:
   * 칸은 성공했는데 datatype 만 실패하면 칸을 글자형으로 살리고 메시지를 담는다·롤백 0). 라우트
   * 400(기존 10종 동결·칸↔라벨/관계/항목동의어 충돌·중복)은 그대로 메시지에 담아 돌려준다.
   */
  addColumn(
    typeName: string,
    columnKey: string,
    dataType: ColumnDataType,
  ): Promise<AddColumnApiResult>;
  /**
   * 칸 삭제(S8·길 B) — columns slot user 행을 DELETE /api/classify-vocab/:id 한 번 부른다.
   * 라우트가 같은 (종류, 칸 키) 의 column_types 짝 행도 함께 지운다(고아 0). 실패 시 throw.
   */
  removeColumn(columnEntryId: string): Promise<void>;
}

/** addColumn 결과 — columns 호출 결과 + (number/date면) column_types 호출 결과. */
export interface AddColumnApiResult {
  columnsResult: VocabCallApiResult;
  /** number/date일 때만 채워진다(글자형이면 undefined — column_types 호출이 없었다). */
  columnTypesResult?: VocabCallApiResult;
}

/** 한 POST 호출 결과 — 성공/실패 + 라우트 메시지(summarizeAddColumnResult 입력 양식 미러). */
export interface VocabCallApiResult {
  ok: boolean;
  message: string;
}

/** GET 헬퍼 — 실패 시 라우트 이름을 담아 throw(빈 결과로 안 가린다). */
async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GET /api${path} 실패 — HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * 세 GET 라우트를 같은 origin 으로 호출하는 실제 구현. 삭제는 기존 패널 api 의 remove 를
 * 그대로 재사용한다(새 fetch 백엔드를 짜지 않는다·S6 계약). list 는 classify-vocab 의
 * overrides 까지 받아야 해 기존 classify-vocab-panel-api.list(entries 만 반환)를 쓰지 않고
 * raw fetch 한다.
 */
export function createEntityManagementPanelApi(): EntityManagementPanelApi {
  const typesApi = createEntityTypesPanelApi();
  const vocabApi = createClassifyVocabPanelApi();
  return {
    async list() {
      const [typesData, vocabData, relData] = await Promise.all([
        getJson<{ entityTypes: EntityTypeRow[] }>("/entity-types"),
        getJson<ClassifyVocabListing>("/classify-vocab"),
        getJson<{ relationVocab: RelationVocabRow[] }>("/relation-vocab"),
      ]);
      return {
        entityTypes: typesData.entityTypes,
        vocab: {
          entries: vocabData.entries,
          // overrides 가 응답에 없을 수 있는 옛 서버 호환 — 없으면 빈 목록(끄기 기능만
          // 비활성·기존 표시 흐름 무변경). 이건 실패 은폐가 아니라 응답 모양 차이 흡수다
          // (라우트가 200 으로 정상 응답했고, overrides 칸만 옛 서버엔 없을 뿐).
          overrides: Array.isArray(vocabData.overrides) ? vocabData.overrides : [],
        },
        relationKeys: relData.relationVocab.map((r) => r.relationKey),
        // 관계 전체 행 — 수정 모달의 buildTypeRelations 가 그 종류 출발 관계만 필터하는
        // 단일 출처(라벨 칸에서 빼는 relationKeys 와 같은 /relation-vocab 응답에서 뽑는다).
        relationVocab: relData.relationVocab,
      };
    },
    addType(payload) {
      return typesApi.add(payload);
    },
    addVocab(payload) {
      return vocabApi.add(payload);
    },
    removeType(typeName) {
      return typesApi.remove(typeName);
    },
    removeVocab(id) {
      return vocabApi.remove(id);
    },
    async disableVocab(typeName, slot, value) {
      const res = await apiFetch(`${API_BASE}/classify-vocab/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ typeName, slot, value }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          data.error ?? `POST /api/classify-vocab/override 실패 — HTTP ${res.status}`,
        );
      }
    },
    async restoreVocab(typeName, slot, value) {
      const res = await apiFetch(`${API_BASE}/classify-vocab/override`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ typeName, slot, value }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          data.error ?? `DELETE /api/classify-vocab/override 실패 — HTTP ${res.status}`,
        );
      }
    },
    async addColumn(typeName, columnKey, dataType) {
      // 글자형이면 columns 한 건, number/date면 columns + column_types 두 건을 순차 POST 한다
      // (buildAddColumnCalls 가 순서·양식을 정한다). 부분 실패(옵션 ⓐ)를 위해 each 호출이
      // throw 하지 않고 {ok, message} 를 돌려준다 — 칸은 성공했는데 datatype 만 실패한 갈래를
      // 모달이 가려 칸을 글자형으로 살리고 재시도하게 한다(롤백 DELETE 0).
      const calls = buildAddColumnCalls(typeName, columnKey, dataType as ColumnDataType);
      const result: AddColumnApiResult = {
        columnsResult: { ok: false, message: "" },
      };
      // columns 호출(첫째) — 실패하면 column_types 는 아예 안 부른다(칸 없는데 datatype 무의미).
      const columnsCall = calls[0]!;
      result.columnsResult = await postClassifyVocab({
        typeName,
        slot: "columns",
        value: columnsCall.value,
      });
      if (!result.columnsResult.ok) return result;
      // column_types 호출(숫자형일 때만·둘째) — 칸 생성 성공 뒤에만 순차로 부른다.
      const typeCall = calls[1];
      if (typeCall !== undefined) {
        result.columnTypesResult = await postClassifyVocab({
          typeName,
          slot: "column_types",
          value: typeCall.value,
        });
      }
      return result;
    },
    async removeColumn(columnEntryId) {
      // 길 B — columns slot user 행 DELETE 한 번. 라우트가 column_types 짝 행도 함께 지운다.
      return vocabApi.remove(columnEntryId);
    },
  };
}

/**
 * classify-vocab 한 건을 POST 하고 결과를 {ok, message} 로 돌려준다(throw 안 함). addColumn 의
 * 부분 실패(옵션 ⓐ) 처리를 위해, 칸 성공·datatype 실패 같은 갈래를 호출자가 가르게 한다.
 * 라우트 400(동결·충돌·중복)은 error 메시지를 그대로 담는다(화면 복제 0·단일 출처).
 */
async function postClassifyVocab(body: {
  typeName: string;
  slot: "columns" | "column_types";
  value: string;
}): Promise<VocabCallApiResult> {
  const res = await apiFetch(`${API_BASE}/classify-vocab`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true, message: "" };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return {
    ok: false,
    message: data.error ?? `POST /api/classify-vocab 실패 — HTTP ${res.status}`,
  };
}

/** 가림표(끈 값) 매칭 키 — (typeName, slot, 소문자 value). 소문자 정합(가림표 UNIQUE). */
function tombstoneKey(typeName: string, slot: string, value: string): string {
  return `${typeName} ${slot} ${value.trim().toLowerCase()}`;
}

/**
 * 세 라우트 데이터 → 표 행 배열(순수 함수·fetch 없음).
 *
 * 한 행 = 한 엔티티 종류(entity-types 기준). 종류별로 그 종류의 synonyms·subcategories·
 * attributes 칩을 모은다. 다음 셋을 칩에서 뺀다:
 *   1. 끈 값 — overrides 의 (typeName, slot, value) 와 소문자 비교로 매칭되는 칩(방법2).
 *   2. 관계 키 — relationKeys Set 에 든 값은 라벨(attributes)에서만 뺀다(라벨 아님).
 *   3. 칸 키 — 그 종류 entity-types columns 의 key·label 은 라벨(attributes)에서만 뺀다
 *      (칸으로 분류되는 값이 라벨에 유령으로 겹쳐 보이는 표시 버그 차단·칸 자체는 칸 섹션 유지).
 *
 * entries 는 *끈 값을 포함한 원본*이라(buildClassifyVocabListing 이 차감 안 함) 여기서 뺀다.
 */
export function buildEntityManagementRows(
  data: EntityManagementData,
): EntityManagementRow[] {
  const tombstones = new Set(
    data.vocab.overrides.map((o) => tombstoneKey(o.typeName, o.slot, o.value)),
  );
  // 관계 키는 소문자로 비교한다(라벨 어휘 소문자 매칭 정합·라우트 isColumnKey 등과 일관).
  const relationKeysLower = new Set(
    data.relationKeys.map((k) => k.trim().toLowerCase()),
  );

  // 종류별 slot 칩 모음 — entries 를 한 번 순회해 (typeName → slot → 칩 배열) 로 묶는다.
  // 끈 값은 이 단계에서 뺀다(overrides 매칭). 칩은 value + source + id 를 담아 user 출처
  // 어휘만 삭제 버튼이 붙게 한다(DELETE /api/classify-vocab/:id).
  const bySlot = new Map<string, Map<ClassifyVocabSlot, VocabChip[]>>();
  for (const e of data.vocab.entries) {
    if (tombstones.has(tombstoneKey(e.typeName, e.slot, e.value))) continue;
    let slots = bySlot.get(e.typeName);
    if (!slots) {
      slots = new Map();
      bySlot.set(e.typeName, slots);
    }
    const chip: VocabChip = { value: e.value, source: e.source, id: e.id };
    const list = slots.get(e.slot);
    if (list) list.push(chip);
    else slots.set(e.slot, [chip]);
  }

  const rows: EntityManagementRow[] = [];
  for (const t of data.entityTypes) {
    const slots = bySlot.get(t.typeName);
    const synonyms = slots?.get("synonyms") ?? [];
    const subcategories = slots?.get("subcategories") ?? [];
    // 그 종류의 칸 키 집합(소문자) — t.columns 의 key·label 둘 다. 칸으로 분류되는 값(예
    // 일정의 '날짜')이 attributes 어휘에도 있으면 라벨에 유령으로 겹쳐 보이는 표시 버그를
    // 막는다. 백엔드 entity-attribute-wiring 도 라벨 = attributes − columnLabels(칸) −
    // 관계 키 로 칸을 뺀다 — 프론트 라벨 칸을 그 셋째 차집합(칸)까지 맞춘다(칸 자체는 칸
    // 섹션에 그대로 유지·정렬용 보존, 라벨에서만 뺀다).
    const columnKeysLower = new Set(
      (t.columns ?? [])
        .flatMap((col) => [col.key, col.label])
        .map((k) => k.trim().toLowerCase()),
    );
    // 라벨 = attributes − 관계 키 − 칸 키(관계 키 '주인' 등도, 칸 키 '날짜' 등도 라벨이 아니다·D3).
    const labels = (slots?.get("attributes") ?? []).filter((chip) => {
      const v = chip.value.trim().toLowerCase();
      return !relationKeysLower.has(v) && !columnKeysLower.has(v);
    });
    rows.push({
      typeName: t.typeName,
      koName: t.koName,
      source: t.source,
      synonyms,
      subcategories,
      columns: buildColumnChips(data, t.typeName),
      labels,
      deletableTypeName: t.source === "user" ? t.typeName : null,
    });
  }
  return rows;
}

/**
 * 끌 수 있는 칸 — 라우트 OVERRIDE_SLOTS 와 일치(synonyms·subcategories·attributes 3칸).
 * columns·item_synonym·column_types 는 끄기 대상이 아니라, 가림표 목록에 그런 slot 이
 * 와도 끈 칩으로 안 만든다(모달 3칸과 일치·라우트가 애초에 그 slot 만 override 받는다).
 */
const DISABLED_CHIP_SLOTS = new Set<ClassifyVocabSlot>([
  "synonyms",
  "subcategories",
  "attributes",
]);

const ALIAS_COLUMN_TYPE_NAMES = new Set(["person", "work", "project"]);
const ALIAS_COLUMN_HELP = "이름 대신 사용 할 수 있음";

/**
 * 한 종류의 끈 칩 묶음을 만든다(순수 함수·fetch 없음·S7b). data.vocab.overrides(가림표
 * 목록) 에서 그 typeName 의 tombstone 만 골라 {value, slot}[] 로 돌려준다. 수정 모달이 켜진
 * 칩 뒤에 이 끈 칩을 흐리게 이어 그린다(되살리기 토글 부착).
 *
 * 매칭 규칙:
 *   - typeName 은 정확히 같아야 한다(타 종류 끈 칩 안 섞임).
 *   - slot 은 DISABLED_CHIP_SLOTS(3칸) 만 — 그 외 slot override 는 무시(모달 3칸 일치).
 *   - value 는 가림표에 담긴 그대로 돌려준다(가림표 value 는 소문자 정규화·UNIQUE 정합).
 *     소문자 매칭은 buildEntityManagementRows 의 끈 값 제외(tombstoneKey)가 이미 켜진
 *     칩에서 빼므로, 여기서는 그 끈 값을 *모아 보이게* 하는 역할이다.
 */
export function buildDisabledChips(
  data: EntityManagementData,
  typeName: string,
): DisabledChip[] {
  const out: DisabledChip[] = [];
  for (const o of data.vocab.overrides) {
    if (o.typeName !== typeName) continue;
    if (!DISABLED_CHIP_SLOTS.has(o.slot)) continue;
    out.push({ value: o.value, slot: o.slot });
  }
  return out;
}

/**
 * 한 종류가 *출발(source)* 인 관계만 거른다(순수 함수·fetch 없음·S7b 모달 편입).
 * 관계 전체 목록(allRelations) 에서 sourceTypes 에 그 typeName 이 든 관계만 돌려준다 —
 * buildDisabledChips 패턴 정합(전체에서 그 종류 몫만 필터). 수정 모달이 이 결과로 그 종류
 * 출발 관계 목록·추가 폼(출발 고정)을 그린다(타 종류 출발 관계는 안 섞임).
 *
 * 매칭 규칙:
 *   - sourceTypes 배열에 typeName 이 정확히 들어 있어야 한다(부분 일치 아님·종류 키 정확 비교).
 *   - 한 관계가 여러 출발 종류를 가지면(sourceTypes 다중) 그 중 하나가 typeName 이면 포함된다.
 *   - 도착 종류·출처(code/user)·관계명은 그대로 옮긴다(렌더가 출처로 삭제 버튼을 가른다).
 */
export function buildTypeRelations(
  allRelations: RelationVocabRow[],
  typeName: string,
): RelationVocabRow[] {
  return allRelations.filter((r) => r.sourceTypes.includes(typeName));
}

/**
 * 한 종류의 칸 칩 묶음을 만든다(순수 함수·fetch 없음·S8). 두 출처를 조인한다:
 *   1. data.entityTypes 의 그 종류 columns[] — 칸 키·표시명·dataType(글자형/숫자형 배지).
 *      이게 칸 목록의 뼈대다(GET entity-types 가 datatype 까지 준다·계산 탭과 같은 출처).
 *   2. data.vocab.entries 의 columns slot user 행 — 그 칸 키와 소문자 매칭되는 행의 entry_id
 *      를 삭제 id 로 단다(user 행만 id 보유). entity-types 의 columns[] 엔 entry id 가 없어,
 *      삭제 id 는 이 두 번째 출처에서만 얻는다(조인의 이유).
 *
 * 삭제 id 규칙:
 *   - user 종류 칸 — vocab.entries 의 columns slot user 행에 그 키가 있으면 그 entry_id.
 *   - code 종류 칸(기존 10종 전용 컬럼) — vocab.entries 에 매칭 user 행이 없어 id=null(읽기전용).
 *   - 타 종류 칸은 안 섞인다(typeName 정확 비교·columns slot 한정).
 *
 * 매칭은 소문자 정규화(라우트 column key 소문자 비교 정합). 같은 키가 entity-types 와
 * entries 양쪽에 있을 때만 id 를 단다 — entity-types 에만 있고 entries 에 없으면 읽기전용.
 */
export function buildColumnChips(
  data: EntityManagementData,
  typeName: string,
): ColumnChip[] {
  const type = data.entityTypes.find((t) => t.typeName === typeName);
  if (!type) return [];
  // columns slot user 행만 모아 (소문자 칸 키 → entry_id) 인덱스를 만든다(삭제 id 출처).
  const userColumnIdByKey = new Map<string, string>();
  for (const e of data.vocab.entries) {
    if (e.typeName !== typeName) continue;
    if (e.slot !== "columns") continue;
    if (e.source !== "user" || e.id === null) continue;
    userColumnIdByKey.set(e.value.trim().toLowerCase(), e.id);
  }
  const chips: ColumnChip[] = type.columns.map((col) => ({
    key: col.key,
    dataType: col.dataType,
    semantic: col.semantic,
    helpText: col.helpText,
    id: userColumnIdByKey.get(col.key.trim().toLowerCase()) ?? null,
  }));
  if (
    ALIAS_COLUMN_TYPE_NAMES.has(typeName) &&
    !chips.some((col) => col.key.trim().toLowerCase() === "별칭")
  ) {
    chips.push({
      key: "별칭",
      dataType: "text",
      semantic: "alias",
      helpText: ALIAS_COLUMN_HELP,
      id: null,
    });
  }
  return chips;
}
