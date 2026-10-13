import { afterAll, beforeAll, beforeEach, afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import {
  computeNumericAggregate,
  divisorForRange,
} from "./compute-numeric-aggregate.ts";

test("일 단위 = since~until 달력 일수(일 차이+1)", () => {
  expect(divisorForRange("2026-06-01", "2026-06-30", "day")).toBe(30);
  expect(divisorForRange("2026-06-15", "2026-06-15", "day")).toBe(1); // 같은 날
});

test("주 단위 = 일수 ÷ 7", () => {
  expect(divisorForRange("2026-06-01", "2026-06-07", "week")).toBe(1); // 7일
});

test("달·해 단위 = 평균 일수 분모(소수 허용)", () => {
  // 6/1~6/30 = 30일 → 달수 ≈ 30/30.4375 (≈0.9856)
  expect(divisorForRange("2026-06-01", "2026-06-30", "month")).toBeCloseTo(30 / 30.4375, 6);
});

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

let db: Database;
let store: SqliteMemoryStore;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => db.close());

test("SUM — 좁혀진 글의 숫자형 칸 값 합(못 읽는 값 제외+건수)", async () => {
  // 글 a:#금액 3,000원, 글 b:#금액 12000, 글 c:#금액 비쌈(못 읽음) — setGlobField 로 저장.
  const a = await store.addNode({ content: "가계부 a" });
  const b = await store.addNode({ content: "가계부 b" });
  const c = await store.addNode({ content: "가계부 c" });
  await store.setGlobField(a, "금액", "3,000원", "direct");
  await store.setGlobField(b, "금액", "12000", "direct");
  await store.setGlobField(c, "금액", "비쌈", "direct");
  const r = await computeNumericAggregate(store, new Set([a, b, c]), "금액", "sum");
  expect(r.value).toBe(15000);          // 3000+12000
  expect(r.readCount).toBe(2);          // 숫자로 읽힌 2건(count=3·readCount=2 구분)
  expect(r.excludedCount).toBe(1);      // '비쌈' 제외(0 안 됨)
  expect(r.numericFieldPresent).toBe(true);
});

test("칸 부재 — 좁혀진 글에 그 칸 값이 0건 → numericFieldPresent false(0 위장 아님)", async () => {
  const id = await store.addNode({ content: "금액 칸 안 채운 글" });
  const r = await computeNumericAggregate(store, new Set([id]), "금액", "sum");
  expect(r.numericFieldPresent).toBe(false);
  expect(r.readCount).toBe(0);     // 읽힌 0건(칸 부재라 제외도 0)
  expect(r.value).toBeUndefined(); // 0 으로 위장 안 함
});

test("진짜 합 0 — 글들이 전부 0원이면 value 0·numericFieldPresent true·excludedCount 0(칸 부재 0 위장과 명확히 구분)", async () => {
  // Mock Policy 세 경우 중 1번(진짜 합이 0)을 고정한다. '0'·'0원' 은 parseNumericFieldValue
  // 가 0 으로 읽는 실값이라 칸 미입력(부재)이 아니다 — value 가 실제 0 으로 나오고
  // numericFieldPresent 가 true 다. 위 칸 부재 테스트(value undefined·present false)와
  // 같은 0 처럼 보이지만 응답이 다름을 한 자리에서 대비한다(0 위장 차단의 핵심 회귀).
  const a = await store.addNode({ content: "0원 글 a" });
  const b = await store.addNode({ content: "0원 글 b" });
  await store.setGlobField(a, "금액", "0", "direct");
  await store.setGlobField(b, "금액", "0원", "direct");
  const r = await computeNumericAggregate(store, new Set([a, b]), "금액", "sum");
  expect(r.value).toBe(0); // 진짜 0 — undefined 가 아니다(실값 회신)
  expect(r.readCount).toBe(2); // 둘 다 0 으로 읽힘(전부 못 읽음 아님·readCount>0)
  expect(r.numericFieldPresent).toBe(true); // 값이 실제로 읽혔다(칸 부재 false 와 구분)
  expect(r.excludedCount).toBe(0); // 둘 다 숫자로 읽혔다 — 제외 0(못 읽는 값 위장 아님)
});

test("AVG 분모 A(글당) = SUM ÷ 읽힌 건수", async () => {
  const a = await store.addNode({ content: "금액 a" });
  const b = await store.addNode({ content: "금액 b" });
  await store.setGlobField(a, "금액", "10000", "direct");
  await store.setGlobField(b, "금액", "20000", "direct");
  const r = await computeNumericAggregate(store, new Set([a, b]), "금액", "avg");
  expect(r.value).toBe(15000);          // (10000+20000)/2
  expect(r.readCount).toBe(2);          // 읽힌 2건 = 분모 A
  expect(r.avgDivisor).toBe(2);
  expect(r.avgDivisorKind).toBe("count");
});

test("AVG 분모 B(하루) = SUM ÷ 기간 전체 일수(안 쓴 날 0 포함)", async () => {
  // 6월 금액 합 300000 을 두 글로 나눠 저장(15일만 기록해도 달력 30일로 나눔 확인).
  const a = await store.addNode({ content: "6월 금액 a" });
  const b = await store.addNode({ content: "6월 금액 b" });
  await store.setGlobField(a, "금액", "100000", "direct");
  await store.setGlobField(b, "금액", "200000", "direct");
  const r = await computeNumericAggregate(
    store, new Set([a, b]), "금액", "avg",
    { unit: "day", since: "2026-06-01", until: "2026-06-30" },
  );
  expect(r.value).toBeCloseTo(300000 / 30, 6); // 달력 30일로 나눔
  expect(r.readCount).toBe(2);                 // 읽힌 2건(분모 B 라도 readCount 는 읽힌 건수)
  expect(r.avgDivisor).toBe(30);
  expect(r.avgDivisorKind).toBe("day");
});

test("전부 못 읽음 — 글 전부 비숫자값(read=0·excluded>0) avg 분모A → readCount 0·value 미산출(C1)", async () => {
  // 글 3개 전부 비숫자값. 칸은 채워졌으나(numericFieldPresent true) 숫자로 읽힌 0건.
  // avg 분모 A(읽힌 건수=0)면 divisor 0 → value 미산출(NaN 회피·sum 은 0 을 돌려주므로 avg 로 본다).
  // 백엔드 count(=총 글 3)와 readCount(=읽힌 0)가 다름을 고정한다 — UI 오인(C1)의 근원.
  const a = await store.addNode({ content: "비숫자 a" });
  const b = await store.addNode({ content: "비숫자 b" });
  const c = await store.addNode({ content: "비숫자 c" });
  await store.setGlobField(a, "금액", "비쌈", "direct");
  await store.setGlobField(b, "금액", "많음", "direct");
  await store.setGlobField(c, "금액", "적당", "direct");
  const r = await computeNumericAggregate(store, new Set([a, b, c]), "금액", "avg");
  expect(r.count).toBe(3);                  // 총 글 3건
  expect(r.readCount).toBe(0);              // 숫자로 읽힌 0건(count 와 다름)
  expect(r.excludedCount).toBe(3);          // 셋 다 제외
  expect(r.numericFieldPresent).toBe(true); // 칸은 채워짐(부재 아님)
  expect(r.value).toBeUndefined();          // 분모 0 → value 미산출(0 위장 아님)
  expect(r.avgDivisor).toBe(0);
  expect(r.avgDivisorKind).toBe("count");   // 분모 A(글당)
});
