import { expect, test } from "bun:test";
import { messages } from "./messages.ts";
import { downloadBar, downloadText, megabytes } from "./progress-text.ts";

test("model download progress reads as the part and whole decimal megabytes", () => {
  expect(downloadText("models", { part: 2, parts: 5, loaded: 312_400_000, total: 569_700_000 })).toBe("모델 받는 중 (2/5) · 312MB / 570MB");
  expect(downloadText("models", { part: 1, parts: 5, loaded: 499_999, total: 0 })).toBe("모델 받는 중 (1/5) · 0MB");
  expect(downloadText("models", { part: 5, parts: 5, loaded: 17_100_000, total: 0 })).toBe(messages.downloadProgress.models(5, 5, 17, null));
  expect(megabytes(1_500_000)).toBe(2);
});

test("only a model stage with a detail shows bytes, and only a known size shows a bar", () => {
  expect(downloadText("models", undefined)).toBeNull();
  expect(downloadText("server", { part: 1, parts: 1, loaded: 1, total: 1 })).toBeNull();
  expect(downloadBar("models", { part: 3, parts: 5, loaded: 40, total: 100 })).toEqual({ value: 40, max: 100 });
  expect(downloadBar("models", { part: 3, parts: 5, loaded: 140, total: 100 })).toEqual({ value: 100, max: 100 });
  expect(downloadBar("models", { part: 3, parts: 5, loaded: 40, total: 0 })).toBeNull();
  expect(downloadBar("prepare", { part: 3, parts: 5, loaded: 40, total: 100 })).toBeNull();
});
