import { expect, test } from "bun:test";
import { messages } from "./messages.ts";
import { elapsedText, entryLine, lastRestoreText, localDateTime, RESTORE_UNSTOPPABLE_STAGES, restoreDoneText } from "./restore-model.ts";

test("a backup's line names its local date and time, its kind and its counts", () => {
  const createdAt = new Date(2026, 9, 1, 9, 5).toISOString();
  expect(localDateTime(createdAt)).toBe("2026-10-01 09:05");
  expect(entryLine({ createdAt, kind: "manual", memories: 3, attachments: 2 })).toBe("2026-10-01 09:05 · 직접 만든 백업 · 기억 3개 · 첨부 2개");
  expect(entryLine({ createdAt, kind: "pre-update", memories: 0, attachments: 0 })).toBe("2026-10-01 09:05 · 업데이트 전 백업 · 기억 0개 · 첨부 0개");
  expect(localDateTime("not a date")).toBe("not a date");
});

test("the time so far is whole minutes and seconds, never negative", () => {
  expect(elapsedText(1_000, 1_000)).toBe("지난 시간 0초");
  expect(elapsedText(0, 59_999)).toBe("지난 시간 59초");
  expect(elapsedText(0, 754_000)).toBe("지난 시간 12분 34초");
  expect(elapsedText(5_000, 0)).toBe("지난 시간 0초");
});

test("the result names the restored counts and the folder that keeps the previous memories", () => {
  expect(restoreDoneText({ memories: 12, attachments: 3, beforeFolder: "C:\\Users\\me\\AppData\\Local\\Bara\\memory\\before-restore-20261007-090503" }))
    .toBe("되살렸어요: 기억 12개·첨부 3개. 되살리기 전의 기억은 이 폴더에 그대로 있어요: C:\\Users\\me\\AppData\\Local\\Bara\\memory\\before-restore-20261007-090503");
});

test("the last restore's line says how it ended, and nothing when there was none", () => {
  expect(lastRestoreText(null)).toBeNull();
  const base = { at: "2026-10-07T00:00:00.000Z", backupName: "bara-backup-20261001-120000" };
  expect(lastRestoreText({ ...base, outcome: "complete", beforeFolder: "D:\\before", memories: 3, attachments: 1 }))
    .toBe("지난 되살리기: bara-backup-20261001-120000에서 기억 3개·첨부 1개를 되살렸어요. 되살리기 전의 기억은 이 폴더에 있어요: D:\\before");
  expect(lastRestoreText({ ...base, outcome: "swapped", beforeFolder: "D:\\before", memories: 3, attachments: 1 })).toContain("연결 확인");
  expect(lastRestoreText({ ...base, outcome: "rolled-back", beforeFolder: null, memories: null, attachments: null })).toContain("원래 기억으로 되돌렸어요");
  expect(lastRestoreText({ ...base, outcome: "interrupted", beforeFolder: null, memories: null, attachments: null })).toContain("이어서 되살려요");
});

test("the confirmation says where the current memories go, that the server stops, that it may take long and what stays", () => {
  const text = messages.restore.confirmMessage("2026-10-01 09:05 · 직접 만든 백업 · 기억 3개 · 첨부 2개", false);
  for (const part of ["복원 전", "그대로 남겨", "서버를 멈춰", "오래 걸릴 수", "내려받아요", "설정·로그인 정보·AI 키는 그대로"]) expect(text).toContain(part);
  expect(text).not.toContain("이어서");
  expect(messages.restore.confirmMessage("x", true)).toContain("이어서");
});

test("the stop button goes away once the switch begins", () => {
  for (const stage of ["restore-switch", "server", "prepare"]) expect(RESTORE_UNSTOPPABLE_STAGES.has(stage)).toBe(true);
  for (const stage of ["restore-verify", "models", "restore-data"]) expect(RESTORE_UNSTOPPABLE_STAGES.has(stage)).toBe(false);
});

test("every restore error text fits the host's limit for a service message, with a long path and cause", () => {
  const path = `C:\\Users\\${"사용자".repeat(10)}\\AppData\\Local\\Bara\\memory\\before-restore-20261007-090503`;
  const cause = "원인".repeat(40);
  const texts = [messages.restoreErrors.RESTORE_START_FAILED(cause, path), messages.restoreErrors.RESTORE_ROLLBACK_FAILED(cause, path),
    messages.restoreErrors.RESTORE_RECOVERY_FAILED(cause, path), messages.restore.done(1, 1, path)];
  for (const text of texts) expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1_000);
});
