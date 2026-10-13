import { expect, test } from "bun:test";
import { getLanguageProfile } from "../../lang/profile-loader.ts";
import { addDaysToCreatedAt, checkScheduleDate } from "./date-check.ts";

const profile = getLanguageProfile().eventDate;
const check = (dateText: string, aiDate: string, createdAt = "2026-10-10 09:00:00") =>
  checkScheduleDate({ dateText, aiDate, createdAt, profile });

test.each([
  ["11월 3일", "2026-11-03", "auto"],
  ["11월 3일", "2026-11-04", "mismatch"],
  ["2006년 9월 28일", "2006-09-28", "auto"],
  ["2006년 9월 28일", "2007-09-28", "mismatch"],
  ["2020년 08월 20일", "2020-08-20", "auto"],
  ["11/3", "2026-11-03", "auto"],
  ["10월 14일 2시반", "2026-10-14", "auto"],
  ["5월 12일", "2026-05-12", "auto"],
  ["내일", "2026-10-11", "auto"],
  ["내일", "2026-10-12", "mismatch"],
  ["어제", "2026-10-09", "auto"],
  ["그저께", "2026-10-08", "auto"],
  ["다음 주", "2026-10-17", "relative"],
  ["토요일", "2026-10-17", "relative"],
  ["다음 달 15일", "2026-11-15", "relative"],
  ["몇 년 후", "2029-10-10", "relative"],
  ["11월 3일", "2026-13-40", "mismatch"],
  ["2006/9/28", "2007-09-28", "relative"],
  ["06년 9월 28일", "2007-09-28", "relative"],
  ["10월 14일 14:30", "2026-10-14", "auto"],
] as const)("%s with AI date %s → %s", (text, ai, expected) => {
  expect(check(text, ai)).toBe(expected);
});

test("a day word counts from the memo's creation date, across a year boundary", () => {
  expect(check("내일", "2027-01-01", "2026-12-31 23:10:00")).toBe("auto");
  expect(addDaysToCreatedAt("2026-12-31 23:10:00", 1)).toBe("2027-01-01");
});
