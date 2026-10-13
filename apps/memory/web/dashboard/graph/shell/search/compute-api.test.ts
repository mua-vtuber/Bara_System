/**
 * compute-api 단위 테스트 (그래프 입력검색 보강 S5·함정 A).
 *
 * buildComputeBody 가 compute-tab.js buildComputePayloadOpts 의 opts(kind=op·concept·
 * field·avgDivisor·since·until·place·project)를 /compute body 로 감쌀 때, 종류(concept)를
 * body.filter:{종류} 로 바꾸는 매핑(index.html:1249 한 줄)을 그대로 재현하는지 검증한다.
 * 이 매핑을 누락하면 종류 필터가 통째로 안 먹혀 모든 글이 집계되는 silent 결함이 난다(함정 A).
 *
 * fetch 부수효과는 안 건드리고 순수 body 조립만 fixture 로 본다(데이터 fixture·mock 0).
 */
import { test, expect } from "bun:test";
import { buildComputeBody } from "./compute-api.ts";

test("concept → filter:{종류} 매핑(함정 A·index.html:1249)", () => {
  const body = buildComputeBody({ query: "", kind: "count", concept: "가계부" });
  expect(body).toEqual({ query: "", kind: "count", filter: { 종류: "가계부" } });
});

test("sum + field + 기간 — 값 있을 때만 합류", () => {
  const body = buildComputeBody({
    query: "",
    kind: "sum",
    concept: "가계부",
    field: "금액",
    since: "2026-05-01",
    until: "2026-05-31",
  });
  expect(body).toEqual({
    query: "",
    kind: "sum",
    filter: { 종류: "가계부" },
    field: "금액",
    since: "2026-05-01",
    until: "2026-05-31",
  });
});

test("avg + avgDivisor — 분모 단위까지 합류", () => {
  const body = buildComputeBody({
    query: "",
    kind: "avg",
    concept: "가계부",
    field: "금액",
    avgDivisor: "day",
    since: "2026-05-01",
    until: "2026-05-31",
  });
  expect(body).toEqual({
    query: "",
    kind: "avg",
    filter: { 종류: "가계부" },
    field: "금액",
    avgDivisor: "day",
    since: "2026-05-01",
    until: "2026-05-31",
  });
});

test("project·place 도 값 있을 때만 합류", () => {
  const body = buildComputeBody({
    query: "마트",
    kind: "count",
    project: "프로젝트A",
    place: "서울",
  });
  expect(body).toEqual({
    query: "마트",
    kind: "count",
    project: "프로젝트A",
    place: "서울",
  });
});

test("concept 없으면 filter 키 자체 없음(전 글 집계 위장 방지)", () => {
  const body = buildComputeBody({ query: "마트", kind: "count" });
  expect(body).toEqual({ query: "마트", kind: "count" });
  expect("filter" in body).toBe(false);
});

test("query 부재면 빈 문자열로 채운다(index.html const body = { query } 정합)", () => {
  const body = buildComputeBody({ kind: "count", concept: "가계부" });
  expect(body).toEqual({ query: "", kind: "count", filter: { 종류: "가계부" } });
});
