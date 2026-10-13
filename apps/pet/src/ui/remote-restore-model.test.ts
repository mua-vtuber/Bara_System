import { expect, test } from "bun:test";
import { messages } from "./messages.ts";
import { remoteRestoreRows, restoreChoice } from "./remote-restore-model.ts";
import { entryLine } from "./restore-model.ts";

const entry = { id: "a".repeat(32), kind: "manual" as const, name: "bara-backup-20261008-120000", createdAt: "2026-10-08T03:00:00.000Z",
  memories: 120, attachments: 4, resumable: false };

test("each backup becomes one line, as the restore screen writes it", () => {
  expect(remoteRestoreRows({ entries: [entry], last: null })).toEqual([{ id: entry.id, line: entryLine(entry) }]);
  expect(remoteRestoreRows({ entries: [], last: null })).toEqual([]);
});

test("the install sends the chosen backup only when the option is on, and asks for one when none is chosen", () => {
  expect(restoreChoice(false, null)).toEqual({});
  expect(restoreChoice(false, entry.id)).toEqual({});
  expect(restoreChoice(true, entry.id)).toEqual({ restoreFrom: entry.id });
  expect(restoreChoice(true, null)).toEqual({ error: messages.remoteRestorePick.pickRequired });
});
