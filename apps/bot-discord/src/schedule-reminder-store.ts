import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { botDataPath } from "./data-dir.ts";

const FILE_NAME = "bot-schedule-reminders.json";

export interface ScheduleReminderState {
  sent: Record<string, string>;
}

function resolveFilePath(filePath?: string): string {
  return filePath ?? botDataPath(FILE_NAME);
}

function emptyState(): ScheduleReminderState {
  return { sent: {} };
}

export class ScheduleReminderLedger {
  constructor(private readonly filePath?: string) {}

  hasSent(key: string): boolean {
    return this.read().sent[key] !== undefined;
  }

  markSent(key: string, sentAt: string): void {
    const state = this.read();
    state.sent[key] = sentAt;
    this.write(state);
  }

  private read(): ScheduleReminderState {
    const path = resolveFilePath(this.filePath);
    if (!existsSync(path)) return emptyState();
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyState();
    }
    const sent = (parsed as { sent?: unknown }).sent;
    if (!sent || typeof sent !== "object" || Array.isArray(sent)) {
      return emptyState();
    }
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(sent)) {
      if (typeof value === "string") cleaned[key] = value;
    }
    return { sent: cleaned };
  }

  private write(state: ScheduleReminderState): void {
    const path = resolveFilePath(this.filePath);
    const dir = dirname(path);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
      renameSync(tmpPath, path);
    } catch (err) {
      if (existsSync(tmpPath)) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // Preserve the original write error.
        }
      }
      throw err;
    }
  }
}

export const _DEFAULT_SCHEDULE_REMINDER_FILE_PATH_FOR_TEST = botDataPath(FILE_NAME, {});
