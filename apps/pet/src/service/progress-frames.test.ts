import { expect, test } from "bun:test";
import type { ProgressFrame } from "../shared/contracts.ts";
import { PROGRESS_DETAIL_INTERVAL_MS, progressReporter } from "./progress-frames.ts";

function reporter() {
  const frames: ProgressFrame[] = [];
  let clock = 1_000;
  const progress = progressReporter("install-1", (frame) => frames.push(frame), () => clock);
  return { frames, progress, advance: (ms: number) => { clock += ms; } };
}
const detail = (loaded: number) => ({ part: 1, parts: 5, loaded, total: 100 });

test("byte progress of one stage is sent at most once per interval; stage frames always go out", () => {
  const { frames, progress, advance } = reporter();
  progress("prepare");
  progress("models");
  progress("models", detail(1));
  advance(100); progress("models", detail(2));
  advance(100); progress("models", detail(3));
  advance(PROGRESS_DETAIL_INTERVAL_MS - 200); progress("models", detail(4));
  advance(10); progress("models");
  progress("server");
  expect(frames).toEqual([
    { event: "progress", requestId: "install-1", stage: "prepare" },
    { event: "progress", requestId: "install-1", stage: "models" },
    { event: "progress", requestId: "install-1", stage: "models", detail: detail(1) },
    { event: "progress", requestId: "install-1", stage: "models", detail: detail(4) },
    { event: "progress", requestId: "install-1", stage: "models" },
    { event: "progress", requestId: "install-1", stage: "server" },
  ]);
});

test("a detail that comes with a new stage is not held back by the last stage's detail", () => {
  const { frames, progress, advance } = reporter();
  progress("models", detail(1));
  advance(1); progress("server", detail(2));
  advance(1); progress("models", detail(3));
  expect(frames.map((frame) => [frame.stage, frame.detail?.loaded])).toEqual([["models", 1], ["server", 2], ["models", 3]]);
});

test("requests are throttled apart", () => {
  const frames: ProgressFrame[] = [];
  const first = progressReporter("a", (frame) => frames.push(frame), () => 0);
  const second = progressReporter("b", (frame) => frames.push(frame), () => 0);
  first("models", detail(1)); second("models", detail(1)); first("models", detail(2));
  expect(frames.map((frame) => frame.requestId)).toEqual(["a", "b"]);
});

test("a part's first and finished counts are never held back, so the screen does not stop short", () => {
  const { frames, progress, advance } = reporter();
  progress("models", detail(10));
  advance(10); progress("models", detail(50));
  advance(10); progress("models", detail(100));
  advance(10); progress("models", { part: 2, parts: 5, loaded: 1, total: 100 });
  advance(10); progress("models", { part: 2, parts: 5, loaded: 2, total: 100 });
  expect(frames.map((frame) => [frame.detail?.part, frame.detail?.loaded])).toEqual([[1, 10], [1, 100], [2, 1]]);
});
