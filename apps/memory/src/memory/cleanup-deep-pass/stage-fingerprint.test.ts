/**
 * stage-fingerprint.test.ts — 단계별 입력 지문 결정론 검증 (spec 4.A-3).
 *
 * 순수 함수 데이터 fixture — DB·mock 0. 같은 입력이면 같은 지문, 다른 입력이면 다른
 * 지문, 목록은 순서 비의존, 단계별 도메인 분리(같은 텍스트라도 stage 가 다르면 다른
 * 지문)를 검증한다.
 */

import { expect, test } from "bun:test";
import {
  regexFingerprint,
  summaryFingerprint,
  relationDiscoveryFingerprint,
  personLinkFingerprint,
  lensDraftFingerprint,
  entityRegisterFingerprint,
} from "./stage-fingerprint.ts";

const HEX64 = /^[0-9a-f]{64}$/;

test("regex — 같은 content 는 같은 지문, 다른 content 는 다른 지문", () => {
  const a = regexFingerprint({ content: "노란 후드를 입은 마스코트" });
  const a2 = regexFingerprint({ content: "노란 후드를 입은 마스코트" });
  const b = regexFingerprint({ content: "파란 후드를 입은 마스코트" });
  expect(a).toMatch(HEX64);
  expect(a).toBe(a2);
  expect(a).not.toBe(b);
});

test("summary — atomic 목록 순서가 달라도 같은 지문", () => {
  const a = summaryFingerprint({ chunkContent: "청크", atomics: ["x", "y", "z"] });
  const b = summaryFingerprint({ chunkContent: "청크", atomics: ["z", "x", "y"] });
  expect(a).toBe(b);
});

test("summary — atomic 내용이 바뀌면 지문이 달라진다", () => {
  const a = summaryFingerprint({ chunkContent: "청크", atomics: ["x", "y"] });
  const b = summaryFingerprint({ chunkContent: "청크", atomics: ["x", "y2"] });
  expect(a).not.toBe(b);
});

test("summary — chunkContent 와 atomics 경계가 섞이지 않는다(필드 구분자)", () => {
  // "ab" + [] 와 "a" + ["b"] 가 우연히 같은 문자열로 합쳐지면 충돌. 구분자로 갈린다.
  const a = summaryFingerprint({ chunkContent: "ab", atomics: [] });
  const b = summaryFingerprint({ chunkContent: "a", atomics: ["b"] });
  expect(a).not.toBe(b);
});

test("relation_discovery — 청크 목록 순서 비의존 + 개념 id 집합 순서 비의존", () => {
  const a = relationDiscoveryFingerprint({
    chunks: [
      { id: 1, content: "c1" },
      { id: 2, content: "c2" },
    ],
    allowedConceptIds: ["cpt_a", "cpt_b"],
  });
  const b = relationDiscoveryFingerprint({
    chunks: [
      { id: 2, content: "c2" },
      { id: 1, content: "c1" },
    ],
    allowedConceptIds: ["cpt_b", "cpt_a"],
  });
  expect(a).toBe(b);
});

test("relation_discovery — 허용 개념 집합이 바뀌면 지문이 달라진다", () => {
  const base = {
    chunks: [{ id: 1, content: "c1" }],
    allowedConceptIds: ["cpt_a"],
  };
  const a = relationDiscoveryFingerprint(base);
  const b = relationDiscoveryFingerprint({ ...base, allowedConceptIds: ["cpt_a", "cpt_c"] });
  expect(a).not.toBe(b);
});

test("relation_discovery — 청크 id 가 같고 content 만 달라도 지문이 달라진다", () => {
  const a = relationDiscoveryFingerprint({
    chunks: [{ id: 1, content: "c1" }],
    allowedConceptIds: [],
  });
  const b = relationDiscoveryFingerprint({
    chunks: [{ id: 1, content: "c1-edited" }],
    allowedConceptIds: [],
  });
  expect(a).not.toBe(b);
});

test("person_link — 후보·top-K 순서 비의존, 빈 top-K 자리 유지(A-7 도입 전)", () => {
  const a = personLinkFingerprint({
    content: "노드",
    personCandidates: ["p1", "p2"],
    topKPersonIds: [],
  });
  const b = personLinkFingerprint({
    content: "노드",
    personCandidates: ["p2", "p1"],
    topKPersonIds: [],
  });
  expect(a).toBe(b);
  expect(a).toMatch(HEX64);
});

test("person_link — top-K 가 채워지면(A-7) 지문이 달라져 재평가된다", () => {
  const before = personLinkFingerprint({
    content: "노드",
    personCandidates: ["p1", "p2"],
    topKPersonIds: [],
  });
  const after = personLinkFingerprint({
    content: "노드",
    personCandidates: ["p1", "p2"],
    topKPersonIds: ["p1"],
  });
  expect(before).not.toBe(after);
});

test("lens_draft — 근거 노드 id 순서 비의존, 렌즈·엔티티 값 변화 시 지문 변화", () => {
  const a = lensDraftFingerprint({
    entityStructuredValue: "{}",
    lensSerialization: "lens-v1",
    evidenceNodeIds: [3, 1, 2],
  });
  const b = lensDraftFingerprint({
    entityStructuredValue: "{}",
    lensSerialization: "lens-v1",
    evidenceNodeIds: [1, 2, 3],
  });
  expect(a).toBe(b);

  const c = lensDraftFingerprint({
    entityStructuredValue: '{"name":"x"}',
    lensSerialization: "lens-v1",
    evidenceNodeIds: [1, 2, 3],
  });
  expect(a).not.toBe(c);
});

test("단계 도메인 분리 — 같은 텍스트라도 stage 가 다르면 다른 지문", () => {
  // regex(content="같은글") vs person_link(content="같은글", 빈 후보/빈 top-K).
  const regex = regexFingerprint({ content: "같은글" });
  const person = personLinkFingerprint({
    content: "같은글",
    personCandidates: [],
    topKPersonIds: [],
  });
  expect(regex).not.toBe(person);
});

test("entity_register fingerprint changes only with memo content or creation time", () => {
  const base = entityRegisterFingerprint({ content: "민수가 11월 3일 결혼한다더라", createdAt: "2026-10-10 09:00:00" });
  expect(base).toMatch(/^[a-f0-9]{64}$/);
  expect(entityRegisterFingerprint({ content: "민수가 11월 3일 결혼한다더라", createdAt: "2026-10-10 09:00:00" })).toBe(base);
  expect(entityRegisterFingerprint({ content: "민수가 11월 4일 결혼한다더라", createdAt: "2026-10-10 09:00:00" })).not.toBe(base);
  expect(entityRegisterFingerprint({ content: "민수가 11월 3일 결혼한다더라", createdAt: "2026-10-11 09:00:00" })).not.toBe(base);
});
