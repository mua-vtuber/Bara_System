/**
 * glob-field-apply.test.ts — collectGlobFields 칸 추출 수렴 검증(순수 함수).
 *
 * 활용 단계6 T3b spec §5: 폼 fields(동적 칸 위젯)와 해시태그 `#키:값` 이 같은 칸 키·
 * 같은 추출 결과로 수렴한다. 한 추출기(collectGlobFields)가 두 입력 통로를 묶어,
 * 폼으로 적든 본문에 `#키:값` 으로 적든 같은 글-칸이 나오게 한다.
 *
 * 정의 밖 칸 키(allowedKeys 에 없음)는 글-칸으로 안 들어간다 — 그 종류의 칸이 아니면
 * 일반 라벨 통로로 떨어진다(spec §4.4). 칸 권위는 종류별 columns(allowedKeys)다.
 */

import { test, expect } from "bun:test";
import { collectGlobFields } from "./glob-field-apply.ts";

test("폼 fields 와 #키:값 해시태그가 같은 칸 키로 수렴", () => {
  const allowed = new Set(["항목", "금액"]);
  const fromForm = collectGlobFields({ 금액: "3000" }, "", allowed);
  const fromTag = collectGlobFields({}, "우유 #금액:3000", allowed);
  expect(fromForm.금액).toBe("3000");
  expect(fromTag.금액).toBe("3000");
  expect(fromForm).toEqual(fromTag);
});

test("정의 밖 칸 키는 글-칸으로 안 들어간다(일반 라벨로 떨어짐·spec §4.4)", () => {
  const out = collectGlobFields({}, "#모르는키:값", new Set(["항목"]));
  expect(out).toEqual({});
});

test("폼 fields 중 정의 밖 키는 걸러지고 정의 안 키만 남는다", () => {
  const out = collectGlobFields(
    { 항목: "우유", 모르는키: "버려짐" },
    "",
    new Set(["항목"]),
  );
  expect(out).toEqual({ 항목: "우유" });
});

test("빈 값·공백 값은 칸으로 안 들어간다", () => {
  const out = collectGlobFields(
    { 항목: "", 금액: "   " },
    "",
    new Set(["항목", "금액"]),
  );
  expect(out).toEqual({});
});

test("폼과 해시태그가 같은 키를 주면 폼 값이 이긴다(직접 위젯 우선)", () => {
  const out = collectGlobFields(
    { 금액: "3000" },
    "#금액:9999",
    new Set(["금액"]),
  );
  expect(out.금액).toBe("3000");
});

test("여러 #키:값 과 폼 fields 가 한 결과 맵에 합류한다", () => {
  const out = collectGlobFields(
    { 사용법: "흔들어 사용" },
    "#주의사항:직사광선피하기 #유통기한:2026-07-01",
    new Set(["사용법", "주의사항", "유통기한"]),
  );
  expect(out).toEqual({
    사용법: "흔들어 사용",
    주의사항: "직사광선피하기",
    유통기한: "2026-07-01",
  });
});

test("formFields 미전달(undefined)이면 해시태그만으로 결과를 만든다", () => {
  const out = collectGlobFields(undefined, "#항목:우유", new Set(["항목"]));
  expect(out).toEqual({ 항목: "우유" });
});

test("빈 allowedKeys 면 어떤 칸도 안 들어간다(종류 칸 0개=칸 승격 0)", () => {
  const out = collectGlobFields({ 항목: "우유" }, "#금액:3000", new Set());
  expect(out).toEqual({});
});
