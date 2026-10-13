/**
 * entity-management-save.ts — 추가 모달 저장 순수 함수 (엔티티 관리 통합 S7a).
 *
 * fetch 를 일절 안 부른다. 추가 모달이 종류 생성·어휘 추가를 *호출한 결과*만 받아,
 * 화면 분기에 쓸 자료를 만든다(순수 함수·데이터 fixture 로 단위 검증). 영문키 형식·빈값
 * 검증도 여기 모은다 — 라우트는 형식을 안 막으므로(addEntityType 은 빈값·코드 10종 충돌·
 * 중복 다른값만 막음) 화면이 저장 직전 약하게 거른다. 코드 10종 충돌·중복은 흉내 내지
 * 않고 라우트 400 을 그대로 보인다(단일 출처·화면에 코드 10종 목록 복제 안 함).
 *
 * 부분 저장 = 옵션 ⓐ(사용자 확정): 종류 생성이 실패하면 어휘 호출은 0건이고, 종류가
 * 성공했는데 어휘 일부가 실패하면 종류·성공 어휘는 살리고 실패 어휘만 모달에 남긴다.
 * 롤백 DELETE(옵션 ⓑ)는 안 쓴다 — 멀쩡한 종류를 지우면 사용자가 처음부터 다시 입력한다.
 */

import type { AddClassifyVocabPayload } from "./classify-vocab-panel-api";

/** 칩 세 칸 평탄화 입력 — 모달의 로컬 칩 배열(저장 전이라 아직 POST 안 한 값). */
export interface AddVocabChipBundle {
  synonyms: string[];
  subcategories: string[];
  attributes: string[];
}

/** 어휘 한 건 추가 호출 자료 — slot + value 한 쌍. buildAddVocabCalls 산출. */
export interface AddVocabCall {
  slot: "synonyms" | "subcategories" | "attributes";
  value: string;
}

/** 어휘 한 건 추가의 결과 — 성공/실패와 그 메시지(summarizeAddResult 입력). */
export interface VocabCallResult {
  slot: AddVocabCall["slot"];
  value: string;
  ok: boolean;
  /** 실패 시 라우트·검증이 준 메시지. 성공이면 빈 문자열. */
  message: string;
}

/** 종류 생성 결과 — 성공/실패와 메시지(코드 10종 충돌·중복은 라우트 400 메시지 그대로). */
export interface TypeCallResult {
  ok: boolean;
  message: string;
}

/**
 * 실패 한 건의 칸 라벨 — 어휘 3칸 + "columns"(칸). 모달이 한국어로 풀어 "이건 실패: ~" 로
 * 남긴다. 칸도 어휘와 같은 실패 목록에 섞어 한 곳에서 재시도 안내를 그린다(추가 모달 칸 단계·S8).
 */
export type AddFailureSlot = AddVocabCall["slot"] | "columns";

/** 저장 집계 산출 — 화면 분기 자료. allOk 면 닫고, 아니면 실패만 남겨 재시도. */
export interface AddResultSummary {
  /** 종류 행이 만들어졌는가(이미 있던 멱등 통과 포함). */
  typeCreated: boolean;
  /** 실패한 어휘·칸 칩 — slot·value·메시지. 모달이 "이건 실패: ~" 로 남긴다(칸도 섞인다). */
  failures: Array<{ slot: AddFailureSlot; value: string; message: string }>;
  /** 성공한 어휘 칩 — 입력에서 비울 대상. */
  succeeded: AddVocabCall[];
  /** 종류 성공 + 어휘·칸 전부 성공이면 true(모달 닫기·토스트). */
  allOk: boolean;
}

/** 영문키 형식 가드 정규식 — 영문 소문자 시작 + 소문자·숫자·언더스코어. */
const TYPE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** 폼 검증 결과 — ok 면 통과, 아니면 안내 메시지. */
export interface ValidationResult {
  ok: boolean;
  message: string;
}

/**
 * 영문키 형식 검증(순수). 라우트는 형식을 안 막으므로 화면이 저장 직전 약하게 거른다.
 * 빈값은 여기서 안 다룬다(validateAddForm 이 빈값을 먼저 잡는다) — 형식만 본다.
 */
export function validateTypeName(typeName: string): ValidationResult {
  if (TYPE_NAME_PATTERN.test(typeName)) {
    return { ok: true, message: "" };
  }
  return {
    ok: false,
    message:
      "영문키는 영문 소문자로 시작하고 소문자·숫자·언더스코어만 권장합니다",
  };
}

/**
 * id 접두사 자동 추천(순수). 영문키를 소문자화 → 영문·숫자만 남기고 → 앞 3글자 + '_'.
 * 영문·숫자가 없으면 빈 문자열을 돌려준다(라우트가 빈 접두사 + UUID 로 식별자를 만든다).
 * 예: 'equipment' → 'equ_', 'a1b2c3' → 'a1b_', '한글' → ''.
 */
export function suggestIdPrefix(typeName: string): string {
  const cleaned = typeName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleaned.length === 0) return "";
  return `${cleaned.slice(0, 3)}_`;
}

/**
 * 추가 폼 빈값·형식 검증(순수). 표시명·영문키 둘 다 필수, 영문키는 형식까지 본다.
 * 통과해야 저장을 시작한다(코드 10종 충돌·중복은 여기서 안 보고 라우트 400 에 맡긴다).
 */
export function validateAddForm(input: {
  koName: string;
  typeName: string;
}): ValidationResult {
  const koName = input.koName.trim();
  const typeName = input.typeName.trim();
  if (koName.length === 0) {
    return { ok: false, message: "표시명을 입력하세요" };
  }
  if (typeName.length === 0) {
    return { ok: false, message: "영문키를 입력하세요" };
  }
  return validateTypeName(typeName);
}

/**
 * 칩 세 칸을 어휘 추가 호출 자료로 평탄화(순수). 칸별 순서를 지키고(synonyms →
 * subcategories → attributes), 빈/공백 값과 같은 칸 안 중복(소문자 비교)을 뺀다.
 * 순차 POST 가 라우트 prospective 불변식에 순서 의존이라 결정적 순서를 유지한다.
 */
export function buildAddVocabCalls(
  typeName: string,
  chips: AddVocabChipBundle,
): AddVocabCall[] {
  void typeName; // typeName 은 호출 측이 payload 에 더한다(여기선 slot·value 만 평탄화).
  const calls: AddVocabCall[] = [];
  const slots: Array<AddVocabCall["slot"]> = [
    "synonyms",
    "subcategories",
    "attributes",
  ];
  for (const slot of slots) {
    const seen = new Set<string>();
    for (const raw of chips[slot]) {
      const value = raw.trim();
      if (value.length === 0) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({ slot, value });
    }
  }
  return calls;
}

/**
 * 종류 생성 payload(순수). 접두사가 빈 문자열이면 idPrefix 를 빼서 라우트가 빈 접두사로
 * 만들게 한다(undefined 와 빈 문자열을 같은 뜻으로 다룬다).
 */
export function buildAddTypePayload(input: {
  typeName: string;
  koName: string;
  idPrefix: string;
}): { typeName: string; koName: string; idPrefix?: string } {
  const idPrefix = input.idPrefix.trim();
  const payload: { typeName: string; koName: string; idPrefix?: string } = {
    typeName: input.typeName.trim(),
    koName: input.koName.trim(),
  };
  if (idPrefix.length > 0) payload.idPrefix = idPrefix;
  return payload;
}

/**
 * 어휘 추가 payload(순수). buildAddVocabCalls 한 건 + typeName 을 라우트 body 모양으로.
 * synonyms·subcategories·attributes 는 모두 {typeName, slot, value} 한 갈래라 단순 매핑.
 */
export function toAddVocabPayload(
  typeName: string,
  call: AddVocabCall,
): AddClassifyVocabPayload {
  return { typeName, slot: call.slot, value: call.value };
}

/**
 * 저장 집계(순수·fetch 없음). 종류 생성 결과 + 어휘 호출 결과 배열을 받아 화면 분기 자료를
 * 만든다. 네 갈래를 한 함수로 가른다:
 *   1. 종류 실패 → typeCreated=false·failures 빈·allOk=false (어휘는 애초에 0건 호출).
 *   2. 종류 성공 + 어휘 전부 성공 → allOk=true.
 *   3. 종류 성공 + 어휘 일부 실패 → typeCreated=true·failures 채움·allOk=false.
 *   4. 종류 성공 + 어휘 전부 실패 → typeCreated=true·failures 가 전부·allOk=false.
 */
export function summarizeAddResult(
  typeResult: TypeCallResult,
  vocabResults: VocabCallResult[],
): AddResultSummary {
  if (!typeResult.ok) {
    return {
      typeCreated: false,
      failures: [],
      succeeded: [],
      allOk: false,
    };
  }
  const failures: AddResultSummary["failures"] = [];
  const succeeded: AddVocabCall[] = [];
  for (const r of vocabResults) {
    if (r.ok) {
      succeeded.push({ slot: r.slot, value: r.value });
    } else {
      failures.push({ slot: r.slot, value: r.value, message: r.message });
    }
  }
  return {
    typeCreated: true,
    failures,
    succeeded,
    allOk: failures.length === 0,
  };
}

// ── 칸(columns) 추가 순수 함수 (엔티티 관리 통합 S8) ─────────────────────────────
//
// 칸은 수정 모달 안 "칸" 섹션에서 user 종류에만 추가한다. 글자형(text)이면 columns 한 건만,
// 숫자형(number)·날짜형(date)이면 columns + column_types(`칸키\t타입`) 두 건을 보낸다(라우트 분기 정합).
// fetch 는 여기서 안 부른다 — api(addColumn) 가 이 평탄화 결과를 순차 POST 한다.

/** 칸 datatype — 라우트 column_types 가 number/date 를 받고 미지정은 text 기본이다. */
export type ColumnDataType = "text" | "number" | "date";

/**
 * 로컬 칸 한 개 — 추가 모달이 저장 전 로컬로 모으는 칸(key + dataType). 네트워크 없이 칩으로
 * 쌓았다가 종류 저장 후 순차 POST 한다(동의어 등 칩 에디터와 같은 로컬 방식·단 타입 포함).
 */
export interface LocalColumn {
  key: string;
  dataType: ColumnDataType;
}

/** 칸 datatype 구분자 — column_types value 의 `칸키\t타입` 두 토큰을 잇는 tab(라우트 정합). */
const COLUMN_TYPE_SEPARATOR = "\t";

/** 칸 추가 한 건 호출 자료 — slot + value 한 쌍(buildAddColumnCalls 산출·순차 POST 입력). */
export interface AddColumnCall {
  slot: "columns" | "column_types";
  value: string;
}

/** 한 POST 호출의 성공/실패 결과 — summarizeAddColumnResult 가 .ok·.message 만 본다(api 결과 미러). */
export interface ColumnCallOutcome {
  ok: boolean;
  message: string;
}

/**
 * 칸 키 약한 검증(순수). 빈값만 막는다 — 칸↔라벨·관계 키·항목 동의어 충돌, 기존 10종 동결,
 * 같은 칸 키 중복은 흉내 내지 않고 라우트 400 을 그대로 노출한다(단일 출처·화면 복제 0).
 */
export function validateColumnKey(columnKey: string): ValidationResult {
  if (columnKey.trim().length === 0) {
    return { ok: false, message: "칸 이름을 입력하세요" };
  }
  return { ok: true, message: "" };
}

/**
 * 칸 한 건을 추가 호출 자료로 평탄화(순수). 글자형이면 columns 한 건, 숫자형·날짜형이면
 * columns 를 먼저(칸 자체 생성) 그다음 column_types(`칸키\t타입` 표지)를 보낸다 — 순서가 중요하다.
 * column_types 는 columns 행이 있어야 datatype 표지로 의미가 있어, 칸 생성 POST 를 앞에 둔다.
 * 칸 키는 trim 한 값으로 양쪽 호출에 같이 쓴다(같은 키로 묶이게).
 */
export function buildAddColumnCalls(
  typeName: string,
  columnKey: string,
  dataType: ColumnDataType,
): AddColumnCall[] {
  void typeName; // typeName 은 api(addColumn) 가 payload 에 더한다(여기선 slot·value 만 평탄화).
  const key = columnKey.trim();
  const calls: AddColumnCall[] = [{ slot: "columns", value: key }];
  if (dataType !== "text") {
    calls.push({ slot: "column_types", value: `${key}${COLUMN_TYPE_SEPARATOR}${dataType}` });
  }
  return calls;
}

/** 칸 추가 집계 산출 — 화면 분기 자료(네 갈래). 모달이 부분 실패를 "이건 실패: ~" 로 남긴다. */
export interface AddColumnSummary {
  /** 칸(columns) 행이 만들어졌는가. false 면 칸 자체가 실패(아래 columnFailMessage 채움). */
  columnCreated: boolean;
  /** datatype 지정(column_types)까지 성공했는가. 글자형이거나 미시도면 true(해당 없음). */
  dataTypeApplied: boolean;
  /** columns 호출이 실패했을 때 라우트 메시지(성공이면 빈 문자열). */
  columnFailMessage: string;
  /** 칸은 성공했으나 datatype 지정만 실패했을 때 라우트 메시지(그 외 빈 문자열·옵션 ⓐ). */
  dataTypeFailMessage: string;
  /** 칸 성공 + (글자형이거나 숫자형 지정까지 성공) 이면 true(모달 갱신·토스트). */
  allOk: boolean;
}

/**
 * 칸 추가 집계(순수·fetch 없음·S8 옵션 ⓐ). columns 결과 + (number/date면) column_types 결과를
 * 받아 네 갈래로 가른다:
 *   1. 칸 성공 + 글자형(column_types 미시도) → allOk=true·dataTypeApplied=true.
 *   2. 칸 성공 + datatype 지정 성공 → allOk=true·dataTypeApplied=true.
 *   3. 칸 성공 + datatype 지정 실패 → allOk=false·dataTypeApplied=false·dataTypeFailMessage 채움
 *      (칸은 글자형으로 살아 있다·롤백 DELETE 안 씀·재시도 가능).
 *   4. 칸 실패 → allOk=false·columnCreated=false·columnFailMessage 채움(column_types 미시도).
 *
 * columnTypesResult 가 undefined 면 글자형(둘째 호출 자체가 없었다) — dataTypeApplied=true.
 */
export function summarizeAddColumnResult(
  columnsResult: ColumnCallOutcome,
  columnTypesResult?: ColumnCallOutcome,
): AddColumnSummary {
  if (!columnsResult.ok) {
    return {
      columnCreated: false,
      dataTypeApplied: false,
      columnFailMessage: columnsResult.message,
      dataTypeFailMessage: "",
      allOk: false,
    };
  }
  if (columnTypesResult === undefined) {
    // 글자형 — column_types 호출이 애초에 없었다(해당 없음·성공으로 친다).
    return {
      columnCreated: true,
      dataTypeApplied: true,
      columnFailMessage: "",
      dataTypeFailMessage: "",
      allOk: true,
    };
  }
  if (columnTypesResult.ok) {
    return {
      columnCreated: true,
      dataTypeApplied: true,
      columnFailMessage: "",
      dataTypeFailMessage: "",
      allOk: true,
    };
  }
  // 칸은 만들었으나 datatype 지정만 실패 — 칸을 글자형으로 살린다(롤백 안 씀·옵션 ⓐ).
  return {
    columnCreated: true,
    dataTypeApplied: false,
    columnFailMessage: "",
    dataTypeFailMessage: columnTypesResult.message,
    allOk: false,
  };
}

/**
 * 한 칸의 집계(AddColumnSummary)를 추가 모달 실패 목록 한 줄로 바꾼다(순수·fetch 없음). 전부
 * 성공이면 null(실패 목록에 안 들어간다). 갈래:
 *   - 칸 자체 실패(columnCreated=false) → columnFailMessage 를 담아 실패 한 줄(칸 안 만들어짐).
 *   - 칸 성공·숫자형 지정만 실패(allOk=false) → dataTypeFailMessage 를 담아 실패 한 줄(칸은
 *     글자형으로 살아 있다·옵션 ⓐ·재시도). slot 은 "columns" 로 고정해 어휘 실패와 한 목록에 섞는다.
 */
export function summarizeColumnFailure(
  columnKey: string,
  summary: AddColumnSummary,
): { slot: AddFailureSlot; value: string; message: string } | null {
  if (summary.allOk) return null;
  const message = summary.columnCreated
    ? summary.dataTypeFailMessage
    : summary.columnFailMessage;
  return { slot: "columns", value: columnKey, message };
}
