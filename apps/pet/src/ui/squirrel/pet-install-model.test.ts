import { expect, test } from "bun:test";
import type { ProgressEvent } from "../../shared/contracts.ts";
import { messages } from "../messages.ts";
import { isInstallStage, PetInstallModel } from "./pet-install-model.ts";

// The pet's rules for the install lock, with the real texts.
const text = messages.installLock;
const event = (stage: ProgressEvent["stage"], detail?: ProgressEvent["detail"]): ProgressEvent => ({ requestId: "install-1", stage, ...(detail ? { detail } : {}) });

test("nothing shows and the click is free until the service says an install runs", () => {
  const model = new PetInstallModel();
  expect(model.text).toBeNull();
  expect(model.installing).toBe(false);
  expect(model.status(false)).toBeNull();
  expect(model.text).toBeNull();
  expect(model.installing).toBe(false);
});

test("a running install shows 설치 중 and refuses the click until an answer says it is over", () => {
  const model = new PetInstallModel();
  model.status(true);
  expect(model.installing).toBe(true);
  expect(model.text).toBe(text.petInstalling);
  model.status(false);
  expect(model.installing).toBe(false);
  expect(model.text).toBeNull();
});

test("the stage and the download share follow the install's progress", () => {
  const model = new PetInstallModel();
  model.status(true);
  expect(model.progress(event("prepare"))).toBe("text");
  expect(model.text).toBe(text.petStage(text.petStages.prepare));
  expect(model.progress(event("models", { part: 2, parts: 7, loaded: 421, total: 1000 }))).toBe("text");
  expect(model.text).toBe(text.petModels(2, 7, 42));
  expect(model.text).toContain("42%");
  // A file whose size is unknown shows its count without a share.
  model.progress(event("models", { part: 3, parts: 7, loaded: 10, total: 0 }));
  expect(model.text).toBe(text.petModels(3, 7, null));
  expect(model.text).not.toContain("%");
  model.progress(event("server"));
  expect(model.text).toBe(text.petStage(text.petStages.server));
});

test("the share never reads above 100% when more bytes arrive than announced", () => {
  const model = new PetInstallModel();
  model.status(true);
  model.progress(event("models", { part: 1, parts: 1, loaded: 1500, total: 1000 }));
  expect(model.text).toBe(text.petModels(1, 1, 100));
});

test("an install stage while no install is known asks the service; other stages change nothing", () => {
  const model = new PetInstallModel();
  expect(model.progress(event("prepare"))).toBe("ask");
  expect(model.progress(event("host-key"))).toBe("ask");
  expect(model.text).toBeNull();
  expect(model.progress(event("search"))).toBe("none");
  model.status(true);
  expect(model.progress(event("answer"))).toBe("none");
  expect(model.text).toBe(text.petInstalling);
});

test("an install that ended forgets its stage, so the next one starts with 설치 중", () => {
  const model = new PetInstallModel();
  model.status(true);
  model.progress(event("server"));
  model.status(false);
  model.status(true);
  expect(model.text).toBe(text.petInstalling);
});

test("a failed ask keeps what was known and says so once per run of failures", () => {
  const model = new PetInstallModel();
  model.status(true);
  model.progress(event("transfer"));
  expect(model.statusFailed("서비스가 응답하지 않아요.")).toBe(text.statusFailed("서비스가 응답하지 않아요."));
  expect(model.statusFailed("서비스가 응답하지 않아요.")).toBeNull();
  // The running install's notice stays and the click stays refused.
  expect(model.installing).toBe(true);
  expect(model.text).toBe(text.petStage(text.petStages.transfer));
  // An answer ends the run of failures; the next failure is told again.
  model.status(true);
  expect(model.statusFailed("다시 실패")).toBe(text.statusFailed("다시 실패"));
});

test("a failed first ask does not pretend an install runs either", () => {
  const model = new PetInstallModel();
  expect(model.statusFailed("연결 안 됨")).not.toBeNull();
  expect(model.installing).toBe(false);
  expect(model.text).toBeNull();
});

test("an answer without the install flag counts as a failed ask, not as no install", () => {
  const model = new PetInstallModel();
  model.status(true);
  expect(model.status(undefined)).toBe(text.statusFailed(text.statusFieldMissing));
  expect(model.installing).toBe(true);
});

test("every install stage has a short name, and only those count as install stages", () => {
  for (const stage of ["prepare", "models", "server", "host-key", "preflight", "transfer", "dependencies", "service", "server-update"] as const) {
    expect(isInstallStage(stage)).toBe(true);
  }
  for (const stage of ["search", "answer", "classify", "cleanup", "update-backup", "restore-data", "self-update-download"] as const) {
    expect(isInstallStage(stage)).toBe(false);
  }
});
