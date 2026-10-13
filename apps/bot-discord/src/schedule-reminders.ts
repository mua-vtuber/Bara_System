import type {
  DateOccurrence,
  DateOccurrenceResponse,
} from "../../memory/src/api-client-types.ts";
import { ScheduleReminderLedger } from "./schedule-reminder-store.ts";

export type ScheduleReminderLead = "day-before" | "two-hours";

export interface ScheduleReminder {
  key: string;
  lead: ScheduleReminderLead;
  occurrence: DateOccurrence;
  message: string;
  dueAt: Date;
  eventAt: Date;
}

export interface ScheduleReminderSettings {
  dateOnlyTime: string;
  dueWindowMinutes: number;
}

export interface DateOccurrenceClient {
  listDateOccurrences(options?: {
    days?: number;
    pastDays?: number;
    limit?: number;
    kind?: string;
  }): Promise<DateOccurrenceResponse>;
}

export function selectDueScheduleReminders(
  response: DateOccurrenceResponse,
  now: Date,
  settings: ScheduleReminderSettings,
): ScheduleReminder[] {
  const due: ScheduleReminder[] = [];
  for (const occurrence of response.upcoming) {
    if (occurrence.kind !== "event") continue;
    const start = occurrenceStart(occurrence, settings.dateOnlyTime);
    if (!start) continue;
    const { eventAt, hasExplicitTime } = start;
    if (now >= eventAt) continue;

    const dayBeforeDue = addMinutes(eventAt, -24 * 60);
    if (isWithinDueWindow(dayBeforeDue, now, settings.dueWindowMinutes)) {
      due.push(
        buildReminder(occurrence, "day-before", dayBeforeDue, eventAt),
      );
    }

    if (hasExplicitTime) {
      const twoHoursDue = addMinutes(eventAt, -120);
      if (isWithinDueWindow(twoHoursDue, now, settings.dueWindowMinutes)) {
        due.push(
          buildReminder(occurrence, "two-hours", twoHoursDue, eventAt),
        );
      }
    }
  }
  return due;
}

export async function pollScheduleReminders(args: {
  client: DateOccurrenceClient;
  ledger: ScheduleReminderLedger;
  sendDm(message: string): Promise<void>;
  now?: Date;
  dateOnlyTime: string;
  dueWindowMinutes?: number;
}): Promise<{ sent: number; due: number }> {
  const now = args.now ?? new Date();
  const response = await args.client.listDateOccurrences({
    kind: "event",
    days: 2,
    pastDays: 0,
    limit: 200,
  });
  const due = selectDueScheduleReminders(response, now, {
    dateOnlyTime: args.dateOnlyTime,
    dueWindowMinutes: args.dueWindowMinutes ?? 5,
  });

  let sent = 0;
  for (const reminder of due) {
    if (args.ledger.hasSent(reminder.key)) continue;
    await args.sendDm(reminder.message);
    args.ledger.markSent(reminder.key, now.toISOString());
    sent += 1;
  }
  return { sent, due: due.length };
}

function buildReminder(
  occurrence: DateOccurrence,
  lead: ScheduleReminderLead,
  dueAt: Date,
  eventAt: Date,
): ScheduleReminder {
  return {
    key: reminderKey(occurrence, lead),
    lead,
    occurrence,
    message:
      lead === "day-before"
        ? `${cleanTitle(occurrence.title)} 일정 하루 전입니다.`
        : `${cleanTitle(occurrence.title)} 일정 2시간 전입니다.`,
    dueAt,
    eventAt,
  };
}

function reminderKey(
  occurrence: DateOccurrence,
  lead: ScheduleReminderLead,
): string {
  const when = occurrence.dateTime ?? occurrence.date;
  return `${lead}|${occurrence.target.nodeId}|${when}`;
}

function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

function occurrenceStart(
  occurrence: DateOccurrence,
  dateOnlyTime: string,
): { eventAt: Date; hasExplicitTime: boolean } | null {
  if (occurrence.dateTime) {
    const parsed = parseLocalDateTime(occurrence.dateTime);
    return parsed ? { eventAt: parsed, hasExplicitTime: true } : null;
  }
  const parsed = parseLocalDateTime(`${occurrence.date}T${dateOnlyTime}`);
  return parsed ? { eventAt: parsed, hasExplicitTime: false } : null;
}

function parseLocalDateTime(raw: string): Date | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?$/.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  if (hour > 23 || minute > 59) return null;
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    d.getFullYear() !== year ||
    d.getMonth() + 1 !== month ||
    d.getDate() !== day
  ) {
    return null;
  }
  return d;
}

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

function isWithinDueWindow(
  dueAt: Date,
  now: Date,
  windowMinutes: number,
): boolean {
  const elapsedMs = now.getTime() - dueAt.getTime();
  if (elapsedMs < 0) return false;
  return elapsedMs <= Math.max(1, windowMinutes) * 60_000;
}
