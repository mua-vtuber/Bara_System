import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { DateOccurrenceResponse } from "../../memory/src/api-client-types.ts";
import {
  pollScheduleReminders,
  selectDueScheduleReminders,
} from "./schedule-reminders.ts";
import { ScheduleReminderLedger } from "./schedule-reminder-store.ts";

const TMP_ROOT = join(import.meta.dir, "_tmp-schedule-reminders");
let tmpDir: string;
let counter = 0;
const SETTINGS = { dateOnlyTime: "09:00", dueWindowMinutes: 5 };

function uniqueDir(): string {
  counter += 1;
  return join(TMP_ROOT, `case-${process.pid}-${Date.now()}-${counter}`);
}

beforeEach(() => {
  tmpDir = uniqueDir();
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function response(
  overrides: Partial<DateOccurrenceResponse["upcoming"][number]> = {},
): DateOccurrenceResponse {
  return {
    upcoming: [
      {
        kind: "event",
        date: "2026-07-11",
        dateTime: "2026-07-11T10:00",
        role: "event",
        title: "치과 예약",
        target: {
          nodeId: "node:10",
          type: "memory",
          id: 10,
          label: "치과 예약",
        },
        source: { type: "event", id: 10 },
        originalDateText: "2026-07-11T10:00",
        ...overrides,
      },
    ],
    past: [],
    window: {
      today: "2026-07-10",
      until: "2026-07-12",
      pastSince: "2026-07-10",
      days: 2,
      pastDays: 0,
    },
    generatedAt: "2026-07-10T09:00:00.000Z",
  };
}

describe("selectDueScheduleReminders", () => {
  test("시각 있는 일정은 하루 전과 2시간 전 알림 대상이 된다", () => {
    const dayBefore = selectDueScheduleReminders(
      response(),
      new Date(2026, 6, 10, 10, 0),
      SETTINGS,
    );
    expect(dayBefore.map((r) => r.lead)).toEqual(["day-before"]);
    expect(dayBefore[0]?.message).toBe("치과 예약 일정 하루 전입니다.");

    const twoHours = selectDueScheduleReminders(
      response(),
      new Date(2026, 6, 11, 8, 0),
      SETTINGS,
    );
    expect(twoHours.map((r) => r.lead)).toEqual(["two-hours"]);
    expect(twoHours[0]?.message).toBe("치과 예약 일정 2시간 전입니다.");
  });

  test("날짜만 있는 일정은 설정 시각 기준 하루 전만 알리고 2시간 전은 만들지 않는다", () => {
    const due = selectDueScheduleReminders(
      response({ dateTime: undefined, originalDateText: "2026-07-11" }),
      new Date(2026, 6, 10, 9, 0),
      SETTINGS,
    );

    expect(due.map((r) => r.lead)).toEqual(["day-before"]);
  });

  test("폴링 창을 지난 낡은 알림은 뒤늦게 보내지 않는다", () => {
    const due = selectDueScheduleReminders(
      response(),
      new Date(2026, 6, 10, 10, 6),
      SETTINGS,
    );

    expect(due).toEqual([]);
  });

  test("이미 시작한 일정은 알림 대상에서 제외한다", () => {
    const due = selectDueScheduleReminders(
      response(),
      new Date(2026, 6, 11, 10, 1),
      SETTINGS,
    );

    expect(due).toEqual([]);
  });
});

describe("pollScheduleReminders", () => {
  test("보낸 알림은 장부에 남아 다음 poll 에서 중복 발송하지 않는다", async () => {
    const ledger = new ScheduleReminderLedger(join(tmpDir, "ledger.json"));
    const sent: string[] = [];
    const api = {
      async listDateOccurrences() {
        return response();
      },
    };

    const first = await pollScheduleReminders({
      client: api,
      ledger,
      sendDm: async (message) => {
        sent.push(message);
      },
      now: new Date(2026, 6, 10, 10, 0),
      dateOnlyTime: "09:00",
    });
    const second = await pollScheduleReminders({
      client: api,
      ledger,
      sendDm: async (message) => {
        sent.push(message);
      },
      now: new Date(2026, 6, 10, 10, 5),
      dateOnlyTime: "09:00",
    });

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(sent).toEqual(["치과 예약 일정 하루 전입니다."]);
  });
});
