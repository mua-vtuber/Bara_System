/**
 * stage-results-ledger.test.ts — 결과 원장 upsert·상태 전이·후보 대조 통합 검증 (spec 4.A-3).
 *
 * 실 :memory: SQLite(실 기준 스키마 · sqlite-vec 로드) — mock 0. openMemoryDatabase 가
 * cleanup_stage_results 테이블을 만든다. 원장 헬퍼가 status 전이·attempt 누적·재처리
 * 조건(fingerprint/stage_version 변화)·retryable next_retry_at 경계를 실 DB 로 지키는지
 * 검증한다.
 */

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import {
  getStageResult,
  recordStageSuccess,
  recordStageRetryable,
  recordStageDeterministicFailure,
  recordStageTerminal,
  isCandidateExcluded,
  filterCandidatesByLedger,
} from "./stage-results-ledger.ts";

function makeDb(): Database {
  return openMemoryDatabase(":memory:", { embeddingDim: 384 });
}

const STAGE = "regex_strengthen" as const;
const FP = "fingerprint-a";
const VER = 1;

test("completed 기록·조회 — status·fingerprint·attempt 0 보존", () => {
  const db = makeDb();
  recordStageSuccess(db, {
    stage: STAGE,
    targetKey: "n1",
    inputFingerprint: FP,
    stageVersion: VER,
    noop: false,
  });
  const row = getStageResult(db, STAGE, "n1")!;
  expect(row.status).toBe("completed");
  expect(row.inputFingerprint).toBe(FP);
  expect(row.stageVersion).toBe(VER);
  expect(row.attemptCount).toBe(0);
  expect(row.nextRetryAt).toBeNull();
  db.close();
});

test("completed_noop 기록 — 무산출 성공 상태", () => {
  const db = makeDb();
  recordStageSuccess(db, {
    stage: STAGE,
    targetKey: "n1",
    inputFingerprint: FP,
    stageVersion: VER,
    noop: true,
  });
  expect(getStageResult(db, STAGE, "n1")!.status).toBe("completed_noop");
  db.close();
});

test("upsert 멱등 — 같은 대상 재기록은 행 1개, 마지막 값으로 덮어씀", () => {
  const db = makeDb();
  recordStageSuccess(db, { stage: STAGE, targetKey: "n1", inputFingerprint: FP, stageVersion: VER, noop: false });
  recordStageSuccess(db, { stage: STAGE, targetKey: "n1", inputFingerprint: "fp-b", stageVersion: VER, noop: true });
  const count = (
    db.prepare("SELECT COUNT(*) AS c FROM cleanup_stage_results WHERE stage=? AND target_key=?").get(STAGE, "n1") as { c: number }
  ).c;
  expect(count).toBe(1);
  const row = getStageResult(db, STAGE, "n1")!;
  expect(row.status).toBe("completed_noop");
  expect(row.inputFingerprint).toBe("fp-b");
  db.close();
});

test("성공은 이전 실패 흔적을 지운다 — attempt·next_retry_at·last_error 리셋", () => {
  const db = makeDb();
  recordStageRetryable(db, {
    stage: STAGE,
    targetKey: "n1",
    inputFingerprint: FP,
    stageVersion: VER,
    nextRetryAt: "2099-01-01 00:00:00",
    lastError: "429 transient",
  });
  expect(getStageResult(db, STAGE, "n1")!.attemptCount).toBe(1);

  recordStageSuccess(db, { stage: STAGE, targetKey: "n1", inputFingerprint: FP, stageVersion: VER, noop: false });
  const row = getStageResult(db, STAGE, "n1")!;
  expect(row.status).toBe("completed");
  expect(row.attemptCount).toBe(0);
  expect(row.nextRetryAt).toBeNull();
  expect(row.lastError).toBeNull();
  db.close();
});

test("retryable — 같은 fingerprint 반복 실패는 attempt 누적, fingerprint 바뀌면 1 재시작", () => {
  const db = makeDb();
  const base = { stage: STAGE, targetKey: "n1", stageVersion: VER, nextRetryAt: "2099-01-01 00:00:00", lastError: "5xx" };
  recordStageRetryable(db, { ...base, inputFingerprint: FP });
  recordStageRetryable(db, { ...base, inputFingerprint: FP });
  expect(getStageResult(db, STAGE, "n1")!.attemptCount).toBe(2);

  recordStageRetryable(db, { ...base, inputFingerprint: "fp-changed" });
  const row = getStageResult(db, STAGE, "n1")!;
  expect(row.attemptCount).toBe(1);
  expect(row.inputFingerprint).toBe("fp-changed");
  db.close();
});

test("결정적 실패 — attempt 누적, 상한 도달 시 terminal_failure", () => {
  const db = makeDb();
  const base = { stage: STAGE, targetKey: "n1", inputFingerprint: FP, stageVersion: VER, maxAttemptsPerTarget: 3, lastError: "parse fail" };

  const r1 = recordStageDeterministicFailure(db, base);
  expect(r1).toEqual({ status: "retryable_failure", attemptCount: 1 });
  const r2 = recordStageDeterministicFailure(db, base);
  expect(r2).toEqual({ status: "retryable_failure", attemptCount: 2 });
  const r3 = recordStageDeterministicFailure(db, base);
  expect(r3).toEqual({ status: "terminal_failure", attemptCount: 3 });

  expect(getStageResult(db, STAGE, "n1")!.status).toBe("terminal_failure");
  db.close();
});

test("결정적 실패 — fingerprint 바뀌면 attempt 재시작(입력이 달라졌으니 새 시도)", () => {
  const db = makeDb();
  recordStageDeterministicFailure(db, { stage: STAGE, targetKey: "n1", inputFingerprint: FP, stageVersion: VER, maxAttemptsPerTarget: 3, lastError: "e" });
  recordStageDeterministicFailure(db, { stage: STAGE, targetKey: "n1", inputFingerprint: FP, stageVersion: VER, maxAttemptsPerTarget: 3, lastError: "e" });
  const changed = recordStageDeterministicFailure(db, { stage: STAGE, targetKey: "n1", inputFingerprint: "fp-new", stageVersion: VER, maxAttemptsPerTarget: 3, lastError: "e" });
  expect(changed.attemptCount).toBe(1);
  db.close();
});

test("terminal 즉시 기록 — input_over_cap 류(attempt 누적 없이 terminal)", () => {
  const db = makeDb();
  recordStageTerminal(db, { stage: STAGE, targetKey: "n1", inputFingerprint: FP, stageVersion: VER, lastError: "input_over_cap" });
  const row = getStageResult(db, STAGE, "n1")!;
  expect(row.status).toBe("terminal_failure");
  expect(row.lastError).toBe("input_over_cap");
  db.close();
});

test("후보 제외 — 행 없으면 포함(제외 false)", () => {
  const db = makeDb();
  expect(isCandidateExcluded(db, STAGE, { targetKey: "n1", inputFingerprint: FP, stageVersion: VER })).toBe(false);
  db.close();
});

test("후보 제외 — completed/completed_noop/terminal 은 같은 지문·버전이면 제외", () => {
  const db = makeDb();
  recordStageSuccess(db, { stage: STAGE, targetKey: "c", inputFingerprint: FP, stageVersion: VER, noop: false });
  recordStageSuccess(db, { stage: STAGE, targetKey: "noop", inputFingerprint: FP, stageVersion: VER, noop: true });
  recordStageTerminal(db, { stage: STAGE, targetKey: "term", inputFingerprint: FP, stageVersion: VER, lastError: "x" });

  for (const key of ["c", "noop", "term"]) {
    expect(isCandidateExcluded(db, STAGE, { targetKey: key, inputFingerprint: FP, stageVersion: VER })).toBe(true);
  }
  db.close();
});

test("후보 제외 — fingerprint 변화 OR stage_version 상승 시 재평가(포함)", () => {
  const db = makeDb();
  recordStageSuccess(db, { stage: STAGE, targetKey: "n1", inputFingerprint: FP, stageVersion: VER, noop: false });

  // 지문 변화 → 포함.
  expect(isCandidateExcluded(db, STAGE, { targetKey: "n1", inputFingerprint: "fp-changed", stageVersion: VER })).toBe(false);
  // stage_version 상승 → 포함.
  expect(isCandidateExcluded(db, STAGE, { targetKey: "n1", inputFingerprint: FP, stageVersion: VER + 1 })).toBe(false);
  // 같은 지문·버전 → 제외.
  expect(isCandidateExcluded(db, STAGE, { targetKey: "n1", inputFingerprint: FP, stageVersion: VER })).toBe(true);
  db.close();
});

test("후보 제외 — retryable 은 next_retry_at 경과 시에만 포함", () => {
  const db = makeDb();
  recordStageRetryable(db, {
    stage: STAGE,
    targetKey: "n1",
    inputFingerprint: FP,
    stageVersion: VER,
    nextRetryAt: "2026-07-12 12:00:00",
    lastError: "429",
  });
  // now 가 next_retry_at 이전 → 아직 제외.
  expect(isCandidateExcluded(db, STAGE, { targetKey: "n1", inputFingerprint: FP, stageVersion: VER }, "2026-07-12 11:59:59")).toBe(true);
  // now 가 next_retry_at 이후 → 후보 포함(제외 false).
  expect(isCandidateExcluded(db, STAGE, { targetKey: "n1", inputFingerprint: FP, stageVersion: VER }, "2026-07-12 12:00:01")).toBe(false);
  db.close();
});

test("filterCandidatesByLedger — 제외 대상만 걸러 포함할 후보만 회신", () => {
  const db = makeDb();
  recordStageSuccess(db, { stage: STAGE, targetKey: "done", inputFingerprint: FP, stageVersion: VER, noop: false });
  recordStageRetryable(db, { stage: STAGE, targetKey: "later", inputFingerprint: FP, stageVersion: VER, nextRetryAt: "2099-01-01 00:00:00", lastError: "e" });

  const probes = [
    { targetKey: "done", inputFingerprint: FP, stageVersion: VER }, // 제외
    { targetKey: "later", inputFingerprint: FP, stageVersion: VER }, // 아직 재시도 전 → 제외
    { targetKey: "fresh", inputFingerprint: FP, stageVersion: VER }, // 행 없음 → 포함
    { targetKey: "done", inputFingerprint: "fp-changed", stageVersion: VER }, // 지문 변화 → 포함
  ];
  const kept = filterCandidatesByLedger(db, STAGE, probes, "2026-07-12 00:00:00").map((p) => p.targetKey);
  expect(kept.sort()).toEqual(["done", "fresh"]);
  db.close();
});

test("stage 도메인 분리 — 같은 target_key 라도 stage 가 다르면 별 행", () => {
  const db = makeDb();
  recordStageSuccess(db, { stage: "regex_strengthen", targetKey: "k", inputFingerprint: FP, stageVersion: VER, noop: false });
  recordStageSuccess(db, { stage: "summary", targetKey: "k", inputFingerprint: FP, stageVersion: VER, noop: true });
  expect(getStageResult(db, "regex_strengthen", "k")!.status).toBe("completed");
  expect(getStageResult(db, "summary", "k")!.status).toBe("completed_noop");
  db.close();
});

// ── 큐 비봉쇄 동결 검증 (spec 5-3 잔여 — terminal 제외 / 무변화 지문 생략) ──────
// 아래 둘은 이미 구현된 동작을 *고정*한다(T29 실사 결과 결함 없음). 두 규칙 중
// 하나라도 무너지면 유료 강모델이 같은 대상에 영구 재과금하거나(지문 규칙),
// 독성 대상 하나가 배치 자리를 영원히 점유해 뒤 후보를 굶긴다(terminal 규칙).

test("terminal_failure 대상은 큐를 막지 않는다 — 배치가 뒤 후보로 채워진다", () => {
  const db = makeDb();
  // 독성 대상 하나가 결정적 실패로 terminal 확정됐다(파싱 불가·input_over_cap 등).
  recordStageTerminal(db, {
    stage: STAGE,
    targetKey: "poison",
    inputFingerprint: FP,
    stageVersion: VER,
    lastError: "input_over_cap",
  });
  const probes = [
    { targetKey: "poison", inputFingerprint: FP, stageVersion: VER },
    { targetKey: "healthy_1", inputFingerprint: "fp-1", stageVersion: VER },
    { targetKey: "healthy_2", inputFingerprint: "fp-2", stageVersion: VER },
  ];

  const kept = filterCandidatesByLedger(db, STAGE, probes).map((p) => p.targetKey);

  // 독성 대상만 빠지고 나머지는 그대로 회신된다 — 한 건이 큐 전체를 쐐기지 않는다.
  expect(kept).toEqual(["healthy_1", "healthy_2"]);
  db.close();
});

test("terminal 대상도 내용이 바뀌면(지문 변화) 다시 후보가 된다 — 영구 사망 아님", () => {
  const db = makeDb();
  recordStageTerminal(db, {
    stage: STAGE,
    targetKey: "poison",
    inputFingerprint: FP,
    stageVersion: VER,
    lastError: "json_parse_failed",
  });
  // 같은 지문이면 제외(같은 입력 = 같은 실패 재발 — 재과금 차단).
  expect(isCandidateExcluded(db, STAGE, { targetKey: "poison", inputFingerprint: FP, stageVersion: VER })).toBe(true);
  // 사용자가 글을 고쳐 지문이 바뀌면 재평가 대상으로 돌아온다.
  expect(isCandidateExcluded(db, STAGE, { targetKey: "poison", inputFingerprint: "fp-edited", stageVersion: VER })).toBe(false);
  db.close();
});

test("무변화 지문 — 완료·무산출 대상은 재사이클에서 다시 안 뽑힌다(LLM 재호출 0)", () => {
  const db = makeDb();
  // 지난 사이클에 산출 있음(completed) / 산출 0(completed_noop) 으로 끝난 두 대상.
  recordStageSuccess(db, { stage: STAGE, targetKey: "had_output", inputFingerprint: FP, stageVersion: VER, noop: false });
  recordStageSuccess(db, { stage: STAGE, targetKey: "no_output", inputFingerprint: FP, stageVersion: VER, noop: true });

  // 다음 사이클 — 내용이 그대로라 지문도 그대로다.
  const kept = filterCandidatesByLedger(db, STAGE, [
    { targetKey: "had_output", inputFingerprint: FP, stageVersion: VER },
    { targetKey: "no_output", inputFingerprint: FP, stageVersion: VER },
  ]);

  // 후보가 0 이면 그 대상에 LLM 호출 자체가 발생하지 않는다(조용한 사이클).
  expect(kept).toEqual([]);
  db.close();
});

test("무변화 지문 생략은 stage_version 이 오르면 풀린다 — 프롬프트 개정 재평가", () => {
  const db = makeDb();
  recordStageSuccess(db, { stage: STAGE, targetKey: "t", inputFingerprint: FP, stageVersion: VER, noop: true });
  // 같은 지문 + 같은 버전 = 생략.
  expect(isCandidateExcluded(db, STAGE, { targetKey: "t", inputFingerprint: FP, stageVersion: VER })).toBe(true);
  // 프롬프트·파서 계약이 개정돼 stage_version 이 오르면 다시 평가한다.
  expect(isCandidateExcluded(db, STAGE, { targetKey: "t", inputFingerprint: FP, stageVersion: VER + 1 })).toBe(false);
  db.close();
});
