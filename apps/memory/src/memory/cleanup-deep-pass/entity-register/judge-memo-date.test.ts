/**
 * judge-memo-date.test.ts — 메모 날짜 판정 judgeMemoDate (2026-10-16 yearless-date-cleanup spec 3.3, 10장 T5).
 * 순수 함수 — AI 답·메모 상태는 데이터로 넣는다.
 */
import { describe, expect, test } from "bun:test";
import { judgeMemo, judgeProfileFromLanguage, type JudgeInput } from "./judge.ts";

const PROFILE = judgeProfileFromLanguage();
const CREATED = "2026-10-16 10:00:00";
const MEMO = "1월 5일까지 제출";

function input(
  ai: { dateText: string | null; date: string | null; title?: string | null },
  over: Partial<JudgeInput> & { content?: string } = {},
): JudgeInput {
  const content = over.content ?? MEMO;
  return {
    memo: { nodeId: 1, content, createdAt: CREATED, alreadyLinked: [] },
    result: { nodeId: 1, entities: [], eventDateText: ai.dateText, eventDate: ai.date, scheduleTitle: ai.title === undefined ? "서류 제출" : ai.title },
    index: { byType: new Map() },
    allowedTypes: new Set(["person"]),
    ignoredNames: new Set(),
    scheduleIgnored: false,
    activeSchedule: null,
    memoEventAt: { found: true, eventAt: null, source: null },
    memoDateIgnored: false,
    autoApply: true,
    profile: PROFILE,
    ...over,
  };
}

const memoDate = (i: JudgeInput) => judgeMemo(i).memoDate;

describe("spec 3.3 rows", () => {
  test("AI 가 다가올 해를 고르면 자동 채움", () => {
    expect(memoDate(input({ dateText: "1월 5일", date: "2027-01-05" }))).toEqual({ action: "auto", date: "2027-01-05", dateText: "1월 5일" });
  });

  test("연도는 AI 몫 — 지난 해를 골라도 월·일이 맞으면 자동", () => {
    expect(memoDate(input({ dateText: "1월 5일", date: "2026-01-05" }))).toEqual({ action: "auto", date: "2026-01-05", dateText: "1월 5일" });
  });

  test("월·일이 다르면 제안 mismatch, 날짜 칸은 AI 날짜로 미리 채움", () => {
    expect(memoDate(input({ dateText: "1월 5일", date: "2027-01-06" }))).toEqual({ action: "propose", reason: "mismatch", date: "2027-01-06", dateText: "1월 5일" });
  });

  test("AI 날짜가 실제 날짜가 아니면 제안 mismatch, 날짜 칸 비움", () => {
    expect(memoDate(input({ dateText: "1월 5일", date: "2027-02-30" }))).toEqual({ action: "propose", reason: "mismatch", date: null, dateText: "1월 5일" });
  });

  test("연도가 따로 적혀 코드가 못 읽는 모양('06년 9월 28일')은 제안 relative", () => {
    const i = input({ dateText: "06년 9월 28일", date: "2006-09-28" }, { content: "06년 9월 28일 졸업" });
    expect(memoDate(i)).toEqual({ action: "propose", reason: "relative", date: "2006-09-28", dateText: "06년 9월 28일" });
  });

  test("연도 있는 숫자 날짜('2006/9/28')는 저장 경로 몫이라 다루지 않음(T1b)", () => {
    const i = input({ dateText: "2006/9/28", date: "2006-09-28" }, { content: "2006/9/28 졸업" });
    expect(memoDate(i)).toEqual({ action: "none", reason: "not_yearless" });
  });

  test("'내일' 같은 다른 표현은 다루지 않음", () => {
    const i = input({ dateText: "내일", date: "2026-10-17" }, { content: "내일 1월 5일 서류" });
    expect(memoDate(i)).toEqual({ action: "none", reason: "not_yearless" });
  });

  test("연도 있는 '2025년 1월 5일' 은 다루지 않음", () => {
    const i = input({ dateText: "2025년 1월 5일", date: "2025-01-05" }, { content: "2025년 1월 5일 회의" });
    expect(memoDate(i)).toEqual({ action: "none", reason: "not_yearless" });
  });

  test("날짜 표현이 없으면 no_date", () => {
    expect(memoDate(input({ dateText: null, date: null }))).toEqual({ action: "none", reason: "no_date" });
    expect(memoDate(input({ dateText: "1월 5일", date: null }))).toEqual({ action: "none", reason: "no_date" });
  });

  test("표현이 본문에 없으면 date_text_not_in_text", () => {
    expect(memoDate(input({ dateText: "1월 6일", date: "2027-01-06" }))).toEqual({ action: "none", reason: "date_text_not_in_text" });
  });

  test("메모 날짜가 이미 있으면 already_set (출처 무관)", () => {
    const i = input({ dateText: "1월 5일", date: "2027-01-05" }, { memoEventAt: { found: true, eventAt: "2026-01-05", source: null } });
    expect(memoDate(i)).toEqual({ action: "none", reason: "already_set" });
  });

  test("메모 날짜 무시 기록이 있으면 ignored", () => {
    const i = input({ dateText: "1월 5일", date: "2027-01-05" }, { memoDateIgnored: true });
    expect(memoDate(i)).toEqual({ action: "none", reason: "ignored" });
  });

  test("메모 행이 없으면 memo_missing", () => {
    const i = input({ dateText: "1월 5일", date: "2027-01-05" }, { memoEventAt: { found: false } });
    expect(memoDate(i)).toEqual({ action: "none", reason: "memo_missing" });
  });

  test("자동 반영이 꺼져 있으면 맞는 날짜도 제안 auto_apply_off", () => {
    const i = input({ dateText: "1월 5일", date: "2027-01-05" }, { autoApply: false });
    expect(memoDate(i)).toEqual({ action: "propose", reason: "auto_apply_off", date: "2027-01-05", dateText: "1월 5일" });
  });

  test("일정 제목이 없어도 메모 날짜 판정은 그대로(일정과 독립)", () => {
    const i = input({ dateText: "1월 5일", date: "2027-01-05", title: null });
    expect(memoDate(i)).toEqual({ action: "auto", date: "2027-01-05", dateText: "1월 5일" });
    expect(judgeMemo(i).schedule.action).toBe("propose");
  });

  test("과거형 메모의 지난 날짜도 채운다", () => {
    const i = input({ dateText: "1월 5일", date: "2026-01-05", title: null }, { content: "1월 5일에 서류 냈음" });
    expect(memoDate(i)).toEqual({ action: "auto", date: "2026-01-05", dateText: "1월 5일" });
  });

  test("'1/5' 빗금 표현도 연도 없는 날짜로 다룬다", () => {
    const i = input({ dateText: "1/5", date: "2027-01-05" }, { content: "1/5 회의" });
    expect(memoDate(i)).toEqual({ action: "auto", date: "2027-01-05", dateText: "1/5" });
  });
});
