/**
 * entity-register/eval-scoring.ts — 평가 자료 읽기와 채점(spec 10장 2번). 순수 함수 — 모델·DB 없음.
 * 실제 모델 실행은 scripts/entity-register-eval.ts(수동)가 한다.
 */
import { readFileSync } from "node:fs";
import { nameKey, normalizeName } from "./name-match.ts";
import type { EntityRegisterAiResult, MemoJudgement, NameIndexEntry } from "./types.ts";

export interface ExpectedEntity { types: string[]; names: string[] }
export interface ExpectedSchedule { dateTexts: string[]; date: string | null; required: boolean }
export interface EvalCase {
  id: number; src: "real" | "synthetic"; createdAt: string; text: string;
  expect: { entities: ExpectedEntity[]; acceptable: ExpectedEntity[]; forbidden: string[]; schedule: ExpectedSchedule | null };
  note: string;
}
export interface EvalFixture { version: 1; existing: NameIndexEntry[]; cases: EvalCase[] }
export interface CaseScore { id: number; hits: number; required: number; extra: string[]; forbiddenHit: string[]; scheduleOk: boolean | null }
export interface EvalSummary {
  hits: number; required: number; extra: number; forbiddenHit: number; scheduleOk: number; scheduleScored: number;
  decisions: { auto: number; propose: number; discard: number };
  /**
   * 메모 날짜 채우기 판정(yearless-date-cleanup spec 3.3) — 항목·일정 판정(decisions)과 따로 센다. autoNodeIds 는
   * 자동으로 채울 메모 번호(과거형 메모의 지난 날짜가 실제로 채워지는지 평가 결과에서 바로 보이게).
   */
  memoDate: { auto: number; propose: number; none: number; autoNodeIds: number[] };
}

export function loadEvalFixture(path: string): EvalFixture {
  const value = JSON.parse(readFileSync(path, "utf8")) as EvalFixture;
  if (value.version !== 1 || !Array.isArray(value.cases) || !Array.isArray(value.existing)) {
    throw new Error(`entity-register 평가 자료 형식이 아님: ${path}`);
  }
  return value;
}

const matches = (e: ExpectedEntity, type: string, name: string) =>
  e.types.includes(type) && e.names.some((n) => nameKey(n) === nameKey(name));

export function scoreCase(c: EvalCase, r: EntityRegisterAiResult): CaseScore {
  const used = new Set<number>();
  let hits = 0;
  for (const e of c.expect.entities) {
    const idx = r.entities.findIndex((x, i) => !used.has(i) && matches(e, x.type, x.name));
    if (idx >= 0) { used.add(idx); hits += 1; }
  }
  const extra = r.entities
    .filter((x, i) => !used.has(i) && !c.expect.acceptable.some((a) => matches(a, x.type, x.name)))
    .map((x) => normalizeName(x.name));
  const forbiddenHit = r.entities.map((x) => normalizeName(x.name)).filter((n) => c.expect.forbidden.some((f) => nameKey(f) === nameKey(n)));
  const s = c.expect.schedule;
  let scheduleOk: boolean | null = null;
  if (s?.required) {
    const textOk = r.eventDateText !== null && s.dateTexts.some((t) => normalizeName(r.eventDateText!).includes(normalizeName(t)));
    scheduleOk = textOk && (s.date === null || r.eventDate === s.date);
  }
  return { id: c.id, hits, required: c.expect.entities.length, extra, forbiddenHit, scheduleOk };
}

/**
 * 모델이 답을 돌려주지 않은 메모의 점수. 빈 답(정답처럼 보일 수 있음)으로 채점하지 않고 오류로 센다 —
 * 맞힘 0, 필수 일정이 있으면 실패.
 */
export function scoreMissing(c: EvalCase): CaseScore {
  return {
    id: c.id, hits: 0, required: c.expect.entities.length, extra: [], forbiddenHit: [],
    scheduleOk: c.expect.schedule?.required ? false : null,
  };
}

export function summarize(scores: CaseScore[], judgements: MemoJudgement[]): EvalSummary {
  const decisions = { auto: 0, propose: 0, discard: 0 };
  const memoDate = { auto: 0, propose: 0, none: 0, autoNodeIds: [] as number[] };
  for (const j of judgements) {
    if (j.memoDate.action === "auto") {
      memoDate.auto += 1;
      memoDate.autoNodeIds.push(j.nodeId);
    } else if (j.memoDate.action === "propose") memoDate.propose += 1;
    else memoDate.none += 1;
    for (const e of j.entities) {
      if (e.action === "discard") decisions.discard += 1;
      else if (e.action === "propose") decisions.propose += 1;
      else decisions.auto += 1;
    }
    if (j.schedule.action === "auto") decisions.auto += 1;
    if (j.schedule.action === "propose") decisions.propose += 1;
  }
  return {
    hits: scores.reduce((n, s) => n + s.hits, 0),
    required: scores.reduce((n, s) => n + s.required, 0),
    extra: scores.reduce((n, s) => n + s.extra.length, 0),
    forbiddenHit: scores.reduce((n, s) => n + s.forbiddenHit.length, 0),
    scheduleOk: scores.filter((s) => s.scheduleOk === true).length,
    scheduleScored: scores.filter((s) => s.scheduleOk !== null).length,
    decisions,
    memoDate,
  };
}

/** 한 묶음의 답을 보낸 메모에 맞춘 결과 — 받아들인 답과 버린 답 수. */
export interface BatchAnswers {
  accepted: Map<number, EntityRegisterAiResult>;
  /** 보내지 않은 메모 번호로 온 답 수. */
  strayAnswers: number;
  /** 같은 메모에 둘 이상 온 답 수(그 메모의 답 전부를 버린다 — 사이클처럼 어느 쪽도 믿지 않는다). */
  duplicateAnswers: number;
}

/** 묶음에 보낸 메모 번호(asked)로 답을 거른다. 버린 답은 세어 돌려준다(조용히 덮어쓰지 않는다). */
export function collectBatchAnswers(asked: readonly number[], parsed: readonly EntityRegisterAiResult[]): BatchAnswers {
  const inBatch = new Set(asked);
  const byNode = new Map<number, EntityRegisterAiResult[]>();
  let strayAnswers = 0;
  for (const r of parsed) {
    if (!inBatch.has(r.nodeId)) {
      strayAnswers += 1;
      continue;
    }
    byNode.set(r.nodeId, [...(byNode.get(r.nodeId) ?? []), r]);
  }
  const accepted = new Map<number, EntityRegisterAiResult>();
  let duplicateAnswers = 0;
  for (const [nodeId, answers] of byNode) {
    if (answers.length > 1) duplicateAnswers += answers.length;
    else accepted.set(nodeId, answers[0]!);
  }
  return { accepted, strayAnswers, duplicateAnswers };
}

