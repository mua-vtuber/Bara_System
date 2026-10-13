/**
 * entity-management-save.test.ts — 추가 저장 순수 함수 검증 (엔티티 관리 통합 S7a).
 *
 * 검증 정신 — fetch mock 0·Mock 객체 0:
 *   summarizeAddResult·buildAddVocabCalls·suggestIdPrefix·validateTypeName·validateAddForm·
 *   buildAddTypePayload·toAddVocabPayload 는 *순수 함수*다. 호출 결과·문자열만 입력해
 *   분기 자료를 만든다. 네트워크·인터페이스 가짜 구현을 일절 안 건드린다(데이터 fixture).
 *
 * 핵심 갈래:
 *   - suggestIdPrefix 접두사 추천 규칙.
 *   - validateTypeName/validateAddForm 형식·빈값 가드.
 *   - buildAddVocabCalls 평탄화·순서·중복 제거.
 *   - summarizeAddResult 부분 실패 4케이스(전부성공·종류실패·일부실패·전부실패).
 */

import { describe, test, expect } from "bun:test";
import {
  suggestIdPrefix,
  validateTypeName,
  validateAddForm,
  buildAddVocabCalls,
  buildAddTypePayload,
  toAddVocabPayload,
  summarizeAddResult,
  buildAddColumnCalls,
  summarizeAddColumnResult,
  summarizeColumnFailure,
  validateColumnKey,
  type VocabCallResult,
} from "./entity-management-save";

describe("suggestIdPrefix — 접두사 자동 추천(순수)", () => {
  test("앞 3글자 + 언더스코어", () => {
    expect(suggestIdPrefix("equipment")).toBe("equ_");
  });

  test("영문·숫자만 남긴다(대문자는 소문자화)", () => {
    expect(suggestIdPrefix("Vehicle")).toBe("veh_");
    expect(suggestIdPrefix("a1b2c3")).toBe("a1b_");
  });

  test("영문·숫자가 하나도 없으면 빈 문자열(라우트가 빈 접두사 + UUID 로 식별자 생성)", () => {
    expect(suggestIdPrefix("한글")).toBe("");
    expect(suggestIdPrefix("")).toBe("");
  });

  test("3글자 미만이면 있는 글자만 + 언더스코어", () => {
    expect(suggestIdPrefix("ab")).toBe("ab_");
  });
});

describe("validateTypeName — 영문키 형식 가드(순수)", () => {
  test("영문 소문자 시작 + 소문자·숫자·언더스코어는 통과", () => {
    expect(validateTypeName("equipment").ok).toBe(true);
    expect(validateTypeName("vehicle_2").ok).toBe(true);
  });

  test("대문자·숫자 시작·한글·공백은 거부 + 안내 메시지", () => {
    expect(validateTypeName("Equipment").ok).toBe(false);
    expect(validateTypeName("2vehicle").ok).toBe(false);
    expect(validateTypeName("장비").ok).toBe(false);
    expect(validateTypeName("two words").ok).toBe(false);
    expect(validateTypeName("equipment").message).toBe("");
    expect(validateTypeName("Equipment").message).toContain("영문 소문자");
  });
});

describe("validateAddForm — 빈값·형식 검증(순수)", () => {
  test("표시명·영문키 둘 다 채워지고 형식 맞으면 통과", () => {
    expect(validateAddForm({ koName: "장비", typeName: "equipment" }).ok).toBe(true);
  });

  test("표시명 빈값은 거부", () => {
    const r = validateAddForm({ koName: "  ", typeName: "equipment" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("표시명");
  });

  test("영문키 빈값은 거부", () => {
    const r = validateAddForm({ koName: "장비", typeName: "" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("영문키");
  });

  test("영문키 형식 불일치는 거부(형식 메시지)", () => {
    const r = validateAddForm({ koName: "장비", typeName: "Equipment" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("영문 소문자");
  });
});

describe("buildAddVocabCalls — 칩 평탄화(순수)", () => {
  test("slot 순서(synonyms→subcategories→attributes) 유지", () => {
    const calls = buildAddVocabCalls("equipment", {
      synonyms: ["키보드"],
      subcategories: ["입력장치"],
      attributes: ["무선"],
    });
    expect(calls.map((c) => c.slot)).toEqual([
      "synonyms",
      "subcategories",
      "attributes",
    ]);
    expect(calls.map((c) => c.value)).toEqual(["키보드", "입력장치", "무선"]);
  });

  test("빈/공백 값과 같은 칸 중복(소문자 비교)은 뺀다", () => {
    const calls = buildAddVocabCalls("work", {
      synonyms: ["소설", " ", "소설", "Manga", "manga"],
      subcategories: [],
      attributes: [],
    });
    // '소설' 한 번, 'Manga'/'manga' 는 소문자 같아 한 번.
    expect(calls.map((c) => c.value)).toEqual(["소설", "Manga"]);
  });

  test("전부 빈 칩이면 빈 배열", () => {
    const calls = buildAddVocabCalls("x", {
      synonyms: [],
      subcategories: [],
      attributes: [],
    });
    expect(calls).toEqual([]);
  });
});

describe("buildAddTypePayload·toAddVocabPayload — payload 조립(순수)", () => {
  test("접두사 빈값이면 idPrefix 를 뺀다(라우트가 빈 접두사로 만든다)", () => {
    const p = buildAddTypePayload({ typeName: " equipment ", koName: " 장비 ", idPrefix: "  " });
    expect(p).toEqual({ typeName: "equipment", koName: "장비" });
  });

  test("접두사 있으면 trim 후 담는다", () => {
    const p = buildAddTypePayload({ typeName: "equipment", koName: "장비", idPrefix: " eqp_ " });
    expect(p).toEqual({ typeName: "equipment", koName: "장비", idPrefix: "eqp_" });
  });

  test("toAddVocabPayload 는 typeName·slot·value 한 갈래", () => {
    const p = toAddVocabPayload("work", { slot: "synonyms", value: "소설" });
    expect(p).toEqual({ typeName: "work", slot: "synonyms", value: "소설" });
  });
});

describe("summarizeAddResult — 부분 실패 4케이스(순수)", () => {
  const okType = { ok: true, message: "" };

  test("케이스1 전부 성공 → allOk·failures 0", () => {
    const results: VocabCallResult[] = [
      { slot: "synonyms", value: "소설", ok: true, message: "" },
      { slot: "attributes", value: "연재중", ok: true, message: "" },
    ];
    const s = summarizeAddResult(okType, results);
    expect(s.typeCreated).toBe(true);
    expect(s.allOk).toBe(true);
    expect(s.failures).toEqual([]);
    expect(s.succeeded.map((c) => c.value)).toEqual(["소설", "연재중"]);
  });

  test("케이스2 종류 실패 → typeCreated false·allOk false·failures 0(어휘 0건 호출)", () => {
    const s = summarizeAddResult({ ok: false, message: "코드 10종 충돌" }, []);
    expect(s.typeCreated).toBe(false);
    expect(s.allOk).toBe(false);
    expect(s.failures).toEqual([]);
  });

  test("케이스3 종류 성공 + 어휘 일부 실패 → typeCreated true·allOk false·실패만 모음", () => {
    const results: VocabCallResult[] = [
      { slot: "synonyms", value: "소설", ok: true, message: "" },
      { slot: "subcategories", value: "소설", ok: false, message: "동의어와 중복" },
    ];
    const s = summarizeAddResult(okType, results);
    expect(s.typeCreated).toBe(true);
    expect(s.allOk).toBe(false);
    expect(s.failures).toEqual([
      { slot: "subcategories", value: "소설", message: "동의어와 중복" },
    ]);
    expect(s.succeeded.map((c) => c.value)).toEqual(["소설"]);
  });

  test("케이스4 종류 성공 + 어휘 전부 실패 → typeCreated true·allOk false·failures 전부", () => {
    const results: VocabCallResult[] = [
      { slot: "synonyms", value: "a", ok: false, message: "x" },
      { slot: "attributes", value: "b", ok: false, message: "y" },
    ];
    const s = summarizeAddResult(okType, results);
    expect(s.typeCreated).toBe(true);
    expect(s.allOk).toBe(false);
    expect(s.failures.length).toBe(2);
    expect(s.succeeded).toEqual([]);
  });
});

// ── 칸(columns) 추가 순수 함수 (엔티티 관리 통합 S8) ─────────────────────────────

describe("validateColumnKey — 칸 키 약한 검증(빈값만)", () => {
  test("빈값·공백은 막는다", () => {
    expect(validateColumnKey("").ok).toBe(false);
    expect(validateColumnKey("   ").ok).toBe(false);
  });

  test("값이 있으면 통과(충돌·중복은 라우트 400 에 맡긴다)", () => {
    expect(validateColumnKey("금액").ok).toBe(true);
  });
});

describe("buildAddColumnCalls — 칸 평탄화(글자형 1건/number/date 2건·tab 양식)", () => {
  test("글자형이면 columns 한 건만(column_types 없음)", () => {
    const calls = buildAddColumnCalls("ledger", "메모", "text");
    expect(calls).toEqual([{ slot: "columns", value: "메모" }]);
  });

  test("숫자형이면 columns 후 column_types(`칸키\\tnumber`) 두 건·순서 유지", () => {
    const calls = buildAddColumnCalls("ledger", "금액", "number");
    expect(calls).toEqual([
      { slot: "columns", value: "금액" },
      { slot: "column_types", value: "금액\tnumber" },
    ]);
  });

  test("날짜형이면 columns 후 column_types(`칸키\\tdate`) 두 건·순서 유지", () => {
    const calls = buildAddColumnCalls("ledger", "구입일", "date");
    expect(calls).toEqual([
      { slot: "columns", value: "구입일" },
      { slot: "column_types", value: "구입일\tdate" },
    ]);
  });

  test("칸 키는 trim 한 값으로 양쪽에 같이 들어간다(같은 키로 묶임)", () => {
    const calls = buildAddColumnCalls("ledger", "  금액  ", "number");
    expect(calls[0]!.value).toBe("금액");
    expect(calls[1]!.value).toBe("금액\tnumber");
  });
});

describe("summarizeAddColumnResult — 칸 추가 집계 네 갈래(옵션 ⓐ)", () => {
  test("칸 성공 + 글자형(둘째 미시도) → allOk·dataTypeApplied true", () => {
    const s = summarizeAddColumnResult({ ok: true, message: "" });
    expect(s.columnCreated).toBe(true);
    expect(s.dataTypeApplied).toBe(true);
    expect(s.allOk).toBe(true);
  });

  test("칸 성공 + datatype 지정 성공 → allOk true", () => {
    const s = summarizeAddColumnResult(
      { ok: true, message: "" },
      { ok: true, message: "" },
    );
    expect(s.columnCreated).toBe(true);
    expect(s.dataTypeApplied).toBe(true);
    expect(s.allOk).toBe(true);
  });

  test("칸 성공 + datatype 지정 실패 → allOk false·칸 살림·실패 메시지 담음(롤백 0)", () => {
    const s = summarizeAddColumnResult(
      { ok: true, message: "" },
      { ok: false, message: "datatype 거부" },
    );
    expect(s.columnCreated).toBe(true);
    expect(s.dataTypeApplied).toBe(false);
    expect(s.dataTypeFailMessage).toBe("datatype 거부");
    expect(s.allOk).toBe(false);
  });

  test("칸 실패 → columnCreated false·columnFailMessage 채움·둘째 미시도", () => {
    const s = summarizeAddColumnResult({ ok: false, message: "기존 10종 동결" });
    expect(s.columnCreated).toBe(false);
    expect(s.columnFailMessage).toBe("기존 10종 동결");
    expect(s.allOk).toBe(false);
  });
});

describe("summarizeColumnFailure — 칸 집계 → 실패 한 줄(순수·S8 추가 모달 칸 단계)", () => {
  test("전부 성공이면 null(실패 목록에 안 들어간다)", () => {
    const ok = summarizeAddColumnResult({ ok: true, message: "" });
    expect(summarizeColumnFailure("메모", ok)).toBeNull();
  });

  test("칸 자체 실패 → columnFailMessage 를 담은 실패 한 줄(slot columns)", () => {
    const s = summarizeAddColumnResult({ ok: false, message: "이미 라벨로 정의됨" });
    expect(summarizeColumnFailure("금액", s)).toEqual({
      slot: "columns",
      value: "금액",
      message: "이미 라벨로 정의됨",
    });
  });

  test("칸 성공·datatype 지정만 실패 → dataTypeFailMessage 를 담은 실패 한 줄(칸은 살아 있음)", () => {
    const s = summarizeAddColumnResult(
      { ok: true, message: "" },
      { ok: false, message: "datatype 거부" },
    );
    expect(summarizeColumnFailure("금액", s)).toEqual({
      slot: "columns",
      value: "금액",
      message: "datatype 거부",
    });
  });
});
