/**
 * compute-tab.test.ts — 계산 탭 순수 로직 단위 검증 (활용 단계6b T4).
 *
 * 검증 정신 — mock 0:
 *   filterNumericColumns·buildComputePayloadOpts·describeComputeResult·localizeComputeError
 *   순수 함수만 fixture 데이터로 검증한다. DOM·fetch 부수효과는 여기서 안 건드린다(그 통로는
 *   라이브 수동 확인 + index.html DOM 토글 happy-dom 테스트가 맡는다).
 *
 * 핵심 — spec §4.4 세 경우 구분이 응답에서 서로 다른 산출로 갈리는지:
 *   1) 진짜 합 0   value:0 + numericFieldPresent:true + excludedCount:0 + readCount>0 → "0" 그대로.
 *   2) 칸 부재     numericFieldPresent:false → "수치 데이터 없음"(분모 표기 안 덧씀).
 *   3) 못 읽는 값  excludedCount>0 → 합계 + "N건은 숫자가 아니라 제외함"(읽힌 0건=readCount:0 이면 "읽을 수 있는 값 없음").
 *
 * "읽힌 값 0건" 판단은 백엔드 readCount 로 한다(C1). count 는 총 글 수라 전부 못 읽어도 양수다.
 * 픽스처는 실제 백엔드 모양을 따른다 — count=총 글 수·readCount=숫자로 읽힌 건수(count:0 가짜 금지).
 */

import { test, expect, describe } from "bun:test";
import {
  COMPUTE_TEXT,
  filterNumericColumns,
  buildComputePayloadOpts,
  describeComputeResult,
  localizeComputeError,
} from "./compute-tab.js";

describe("filterNumericColumns — 숫자형 칸만 추림", () => {
  test("dataType==='number' 인 칸만 남기고 글자 칸은 제외", () => {
    const cols = [
      { key: "항목", label: "항목", dataType: "text" },
      { key: "금액", label: "금액", dataType: "number" },
      { key: "구입일", label: "구입일", dataType: "date" },
      { key: "비고", label: "비고", dataType: "text" },
      { key: "무게", label: "무게", dataType: "number" },
    ];
    const out = filterNumericColumns(cols);
    expect(out).toEqual([
      { key: "금액", label: "금액" },
      { key: "무게", label: "무게" },
    ]);
  });

  test("숫자형 칸 0개면 빈 배열(정직한 빈 상태)", () => {
    expect(
      filterNumericColumns([
        { key: "항목", label: "항목", dataType: "text" },
      ]),
    ).toEqual([]);
  });

  test("비배열·빈 입력은 빈 배열(방어)", () => {
    expect(filterNumericColumns(undefined)).toEqual([]);
    expect(filterNumericColumns(null)).toEqual([]);
    expect(filterNumericColumns([])).toEqual([]);
  });

  test("dataType 칸이 없는 옛 columns 항목은 글자형으로 보고 제외(정직)", () => {
    expect(filterNumericColumns([{ key: "금액", label: "금액" }])).toEqual([]);
  });
});

describe("buildComputePayloadOpts — 연산별 opts 조립", () => {
  test("개수(count)는 kind만·field·avgDivisor 미포함", () => {
    const opts = buildComputePayloadOpts({
      op: "count",
      concept: "가계부",
      field: "금액",
      divisor: "day",
    });
    expect(opts.kind).toBe("count");
    expect(opts.concept).toBe("가계부");
    expect("field" in opts).toBe(false);
    expect("avgDivisor" in opts).toBe(false);
  });

  test("더하기(sum)는 kind + field(숫자형 칸)", () => {
    const opts = buildComputePayloadOpts({ op: "sum", field: "금액" });
    expect(opts.kind).toBe("sum");
    expect(opts.field).toBe("금액");
    expect("avgDivisor" in opts).toBe(false);
  });

  test("평균(avg) + 기준=하루 → kind + field + avgDivisor:'day'(분모 B)", () => {
    const opts = buildComputePayloadOpts({
      op: "avg",
      field: "무게",
      divisor: "day",
    });
    expect(opts.kind).toBe("avg");
    expect(opts.field).toBe("무게");
    expect(opts.avgDivisor).toBe("day");
  });

  test("평균(avg) + 기준=한 건당(count) → avgDivisor 미전달(분모 A)", () => {
    const opts = buildComputePayloadOpts({
      op: "avg",
      field: "무게",
      divisor: "count",
    });
    expect(opts.kind).toBe("avg");
    expect(opts.field).toBe("무게");
    expect("avgDivisor" in opts).toBe(false);
  });

  test("빈 값은 키 생략(값 있을 때만 합류·미입력 미전달)", () => {
    const opts = buildComputePayloadOpts({
      op: "sum",
      concept: "  ",
      project: "",
      since: "",
      until: "",
      place: "   ",
      field: "",
    });
    expect(opts).toEqual({ kind: "sum" });
  });

  test("기간·장소·프로젝트는 값 있을 때만 합류", () => {
    const opts = buildComputePayloadOpts({
      op: "sum",
      field: "금액",
      since: "2026-06-01",
      until: "2026-06-30",
      place: "강남",
      project: "p1",
    });
    expect(opts).toEqual({
      kind: "sum",
      field: "금액",
      since: "2026-06-01",
      until: "2026-06-30",
      place: "강남",
      project: "p1",
    });
  });
});

describe("describeComputeResult — 세 경우 구분(spec §4.4)", () => {
  test("개수(count)는 개수+건 강조(숫자형 칸 무관)", () => {
    const out = describeComputeResult({ kind: "count", count: 7 });
    expect(out.header).toBe(COMPUTE_TEXT.headerByKind.count);
    expect(out.headline).toBe("7건");
    expect(out.notes).toEqual([]);
  });

  test("case1 진짜 합 0 — value:0 + 칸 present + 제외 0 + readCount>0 → '0' 그대로(위장 아님)", () => {
    const out = describeComputeResult({
      kind: "sum",
      count: 3,
      readCount: 3, // 세 글 모두 0 으로 읽힘(전부 못 읽은 게 아니라 진짜 0)
      value: 0,
      numericFieldPresent: true,
      excludedCount: 0,
    });
    expect(out.headline).toBe("0");
    expect(out.notes).toEqual([]);
  });

  test("case1 실합계 — 천단위 콤마 표시", () => {
    const out = describeComputeResult({
      kind: "sum",
      count: 2,
      readCount: 2, // 두 글 모두 숫자로 읽힘
      value: 15000,
      numericFieldPresent: true,
      excludedCount: 0,
    });
    expect(out.header).toBe("합계");
    expect(out.headline).toBe("15,000");
  });

  test("case2 칸 부재 — numericFieldPresent:false → '수치 데이터 없음'", () => {
    const out = describeComputeResult({
      kind: "sum",
      count: 0,
      numericFieldPresent: false,
    });
    expect(out.headline).toBe(COMPUTE_TEXT.numericFieldAbsent);
    expect(out.notes).toEqual([]);
  });

  test("case2 분모 B 평균 + 칸 부재 → 분모 표기('하루 평균') 없이 '수치 데이터 없음'만(§4.4 case2)", () => {
    const out = describeComputeResult({
      kind: "avg",
      count: 0,
      numericFieldPresent: false,
      avgDivisor: 0,
      avgDivisorKind: "day",
    });
    // 분모 표기('하루')를 칸 부재 위에 덧쓰지 않는다 — 기본 헤더만.
    expect(out.header).toBe("평균");
    expect(out.header).not.toContain("하루");
    expect(out.headline).toBe(COMPUTE_TEXT.numericFieldAbsent);
  });

  test("case3 못 읽는 값 제외 — 합계 + 'N건은 숫자가 아니라 제외함'", () => {
    const out = describeComputeResult({
      kind: "sum",
      count: 3, // 총 글 3건(2건 읽힘 + 1건 제외)
      readCount: 2, // 숫자로 읽힌 2건 → 합계 표시 경로 유지
      value: 15000,
      numericFieldPresent: true,
      excludedCount: 1,
    });
    expect(out.headline).toBe("15,000");
    expect(out.notes).toEqual([COMPUTE_TEXT.excludedNote(1)]);
  });

  test("case3 변형 — 전부 못 읽음(count=글수·readCount:0) → '읽을 수 있는 값 없음'(0 위장 아님)", () => {
    // 실제 백엔드 모양: 글 3개 전부 비숫자값이면 count=3(총 글 수)·readCount=0(읽힌 0건)·
    // excludedCount=3. 옛 가짜 픽스처(count:0)는 백엔드가 count=nodes.length 라 불일치였다(C1).
    const out = describeComputeResult({
      kind: "sum",
      count: 3, // 총 글 3건
      readCount: 0, // 숫자로 읽힌 0건 → "읽을 수 있는 값 없음"
      value: 0,
      numericFieldPresent: true,
      excludedCount: 3,
    });
    expect(out.headline).toBe(COMPUTE_TEXT.noReadableValue);
    expect(out.notes).toEqual([COMPUTE_TEXT.excludedNote(3)]);
  });

  test("case3 변형 — avg 0/divisor=0(count=글수·readCount:0) 이 '하루 평균 0' 으로 오인되지 않는다", () => {
    // 글 2개 전부 비숫자값 → count=2·readCount=0·excludedCount=2·avgDivisor=0(분모 0).
    const out = describeComputeResult({
      kind: "avg",
      count: 2, // 총 글 2건
      readCount: 0, // 숫자로 읽힌 0건
      value: 0,
      numericFieldPresent: true,
      excludedCount: 2,
      avgDivisor: 0,
      avgDivisorKind: "day",
    });
    // 읽힌 값이 0건이라 '하루 평균 0' 이 아니라 '읽을 수 있는 값 없음'.
    expect(out.headline).toBe(COMPUTE_TEXT.noReadableValue);
    expect(out.headline).not.toBe("0");
  });

  test("avg 분모 B — 헤더에 분모 표기('하루 평균')", () => {
    const out = describeComputeResult({
      kind: "avg",
      count: 15,
      readCount: 15, // 15건 전부 숫자로 읽힘 → 평균값 표시 경로
      value: 1000,
      numericFieldPresent: true,
      excludedCount: 0,
      avgDivisor: 30,
      avgDivisorKind: "day",
    });
    expect(out.header).toBe("하루 평균");
    expect(out.headline).toBe("1,000");
  });

  test("avg 분모 A(한 건당) — 분모 표기 없이 '평균'", () => {
    const out = describeComputeResult({
      kind: "avg",
      count: 3,
      readCount: 3, // 3건 전부 숫자로 읽힘
      value: 500,
      numericFieldPresent: true,
      excludedCount: 0,
      avgDivisor: 3,
      avgDivisorKind: "count",
    });
    expect(out.header).toBe("평균");
    expect(out.headline).toBe("500");
  });
});

describe("localizeComputeError — 라우트 영어 400 → 한국어", () => {
  test("field 미선택 400 → '더할 칸을 골라주세요.'", () => {
    const msg = localizeComputeError("400 Bad Request — field required for sum/avg");
    expect(msg).toBe("더할 칸을 골라주세요.");
  });

  test("기간 부재 400(분모 B) → '기간을 골라주세요...'", () => {
    const msg = localizeComputeError(
      "400 Bad Request — period required for time-unit average — specify since/until or a date phrase in query",
    );
    expect(msg).toContain("기간을 골라주세요");
  });

  test("condition required → 좁히기 안내", () => {
    expect(localizeComputeError("400 — condition required")).toContain("좁혀주세요");
  });

  test("알려지지 않은 message 는 원문을 가리지 않고 그대로 덧붙임(정직)", () => {
    const msg = localizeComputeError("500 Internal Server Error — sqlite: no such table");
    expect(msg).toContain("sqlite: no such table");
  });
});
