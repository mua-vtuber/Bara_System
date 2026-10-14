import { expect, test } from "bun:test";
import type { SelfUpdateStatus } from "../../shared/contracts.ts";
import { messages } from "../messages.ts";
import { PetUpdateModel } from "./pet-update-model.ts";

const status = (overrides: Partial<SelfUpdateStatus> = {}): SelfUpdateStatus =>
  ({ check: "current", available: null, failure: null, failureNoticeId: null, announce: null, logError: null, recordError: null, ...overrides });
const failing = (id: number, available: string | null = null) =>
  status({ check: "failed", available, failure: { code: "SELF_UPDATE_HTTP", message: "403" }, failureNoticeId: id });

test("the update button shows only while a newer version is offered, also through a failed check", () => {
  const model = new PetUpdateModel();
  expect(model.status(status()).buttonVersion).toBeNull();
  expect(model.status(status({ check: "unknown" })).buttonVersion).toBeNull();
  expect(model.status(status({ check: "available", available: "0.1.9" })).buttonVersion).toBe("0.1.9");
  expect(model.status(failing(1, "0.1.9")).buttonVersion).toBe("0.1.9");
  expect(model.status(failing(1)).buttonVersion).toBeNull();
});

test("a run of failures shows one notice; a new run shows another", () => {
  const model = new PetUpdateModel();
  expect(model.status(failing(1)).notice).toBe(messages.selfUpdate.checkFailed("403"));
  expect(model.status(failing(1)).notice).toBeNull();
  expect(model.status(status()).notice).toBeNull();
  expect(model.status(failing(2)).notice).toBe(messages.selfUpdate.checkFailed("403"));
});

test("the owed notice bubble passes through", () => {
  expect(new PetUpdateModel().status(status({ check: "available", available: "0.1.9", announce: "0.1.9" })).announce).toBe("0.1.9");
});

test("a log that cannot be written is shown once", () => {
  const model = new PetUpdateModel();
  expect(model.status(status({ logError: "EACCES" })).notice).toBe(messages.selfUpdate.logFailed("EACCES"));
  expect(model.status(status({ logError: "EACCES" })).notice).toBeNull();
});

test("a broken record is shown once", () => {
  const model = new PetUpdateModel();
  const cause = "새 버전 알림 기록 파일의 내용이 ... 파일: C:\data\self-update.json";
  expect(model.status(status({ recordError: cause })).notice).toBe(messages.selfUpdate.recordFailed(cause));
  expect(model.status(status({ recordError: cause })).notice).toBeNull();
});

test("asking the service fails: the first failure of a row is shown, until an answer comes again", () => {
  const model = new PetUpdateModel();
  expect(model.pollFailed("연결 끊김")).toBe(messages.selfUpdate.statusFailed("연결 끊김"));
  expect(model.pollFailed("연결 끊김")).toBeNull();
  model.status(status());
  expect(model.pollFailed("연결 끊김")).toBe(messages.selfUpdate.statusFailed("연결 끊김"));
});
