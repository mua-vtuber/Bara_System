/**
 * source-type-prefix.test.ts — W10 검색 결과 자산 종류 prefix 양식 검증.
 *
 * Phase 6b T11(W10) = 결정 기록 task. spec 단락 12.1 의 prefix 양식
 * (5 종류)을 코드 단일 출처 상수 + 순수 매핑 함수로 정착시킨다. 실제 UI
 * 표시(색상·아이콘·레이아웃)는 Phase 8 권위(spec 12.2) — 여기서는 데이터
 * fixture 로 5 종류 -> 정확한 prefix 매핑만 검증한다.
 *
 * 데이터 fixture 검증 — mock 없음 / DB 없음 / 모델 없음(순수 함수).
 */

import { describe, expect, it } from "bun:test";
import {
  RESULT_SOURCE_TYPES,
  SOURCE_TYPE_PREFIX,
  formatSourceTypePrefix,
  type ResultSourceType,
} from "./source-type-prefix.ts";

describe("SOURCE_TYPE_PREFIX 상수 — spec 12.1 의 5 종류 prefix 단일 출처", () => {
  it("5 종류를 정확히 포함한다(누락·추가 없음)", () => {
    expect(Object.keys(SOURCE_TYPE_PREFIX).sort()).toEqual(
      [
        "atomic",
        "chunk_summary",
        "document_chunk",
        "image_caption",
        "relation_summary",
      ].sort(),
    );
  });

  it("RESULT_SOURCE_TYPES 순서 목록도 같은 5 종류를 담는다", () => {
    const listed: string[] = [...RESULT_SOURCE_TYPES].sort();
    expect(listed).toEqual(Object.keys(SOURCE_TYPE_PREFIX).sort());
  });
});

describe("formatSourceTypePrefix — 데이터 fixture: 5 종류 -> 정확한 prefix", () => {
  // spec 단락 12.1 양식 그대로의 fixture.
  const cases: ReadonlyArray<readonly [ResultSourceType, string]> = [
    ["atomic", "[atomic]"],
    ["document_chunk", "[document_chunk]"],
    ["image_caption", "[image_caption]"],
    ["relation_summary", "[relation_summary]"],
    ["chunk_summary", "[chunk_summary]"],
  ];

  for (const [sourceType, expected] of cases) {
    it(`${sourceType} -> ${expected}`, () => {
      expect(formatSourceTypePrefix(sourceType)).toBe(expected);
    });
  }
});

describe("formatSourceTypePrefix — 미지의 종류 처리(silent fake 금지)", () => {
  it("정의되지 않은 종류는 빈 prefix 를 돌려준다(가짜 라벨 만들지 않음)", () => {
    // Phase 8 가 정밀화. 여기서는 가짜 라벨 대신 빈 문자열로 명시 처리한다.
    expect(formatSourceTypePrefix("nonexistent_type")).toBe("");
    expect(formatSourceTypePrefix("")).toBe("");
  });

  it("정의된 5 종류는 절대 빈 prefix 가 아니다", () => {
    for (const sourceType of RESULT_SOURCE_TYPES) {
      expect(formatSourceTypePrefix(sourceType)).not.toBe("");
    }
  });
});
