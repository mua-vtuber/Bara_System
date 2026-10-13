import { expect, test } from "bun:test";
import { MEMORY_DEFAULTS } from "../../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../../settings/memory-settings-types.ts";
import {
  buildCleanupGateInput, buildMemoSavedTrigger, entityRegisterStageConfig, memoSavedRunStarter, memoSavedStages,
  MEMO_SAVED_LOST_RACE_STOP_REASON, MEMO_SAVED_START_FAILED_STOP_REASON,
} from "./boot-wiring.ts";
import { CleanupRunsLedger } from "../cleanup-runs-ledger.ts";
import { openMemoryDatabase } from "../../../db/migrations.ts";
import { cleanupModelKeyMissing } from "../scheduler-gate.ts";

const clone = () => structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;

test("the model key that is empty is named for the chosen provider", () => {
  const s = clone();
  s.llm.cleanup.provider = "anthropic";
  s.llm.cleanup.anthropicModel = "";
  expect(cleanupModelKeyMissing(s.llm.cleanup)).toBe("llm.cleanup.anthropicModel");
  s.llm.cleanup.provider = "ollama";
  s.llm.cleanup.ollamaModel = "qwen3:4b-instruct";
  expect(cleanupModelKeyMissing(s.llm.cleanup)).toBeNull();
});

test("an openai-compatible provider with an empty model names its own key", () => {
  const s = clone();
  s.llm.cleanup.provider = "openai_compatible";
  s.llm.cleanup.openaiModel = "  ";
  expect(cleanupModelKeyMissing(s.llm.cleanup)).toBe("llm.cleanup.openaiModel");
});

test("OpenAI(GPT)·Google(Gemini) providers name their own empty model key", () => {
  const s = clone();
  s.llm.cleanup.provider = "openai";
  expect(cleanupModelKeyMissing(s.llm.cleanup)).toBe("llm.cleanup.gptModel");
  s.llm.cleanup.gptModel = "gpt-4.1";
  expect(cleanupModelKeyMissing(s.llm.cleanup)).toBeNull();
  s.llm.cleanup.provider = "google";
  expect(cleanupModelKeyMissing(s.llm.cleanup)).toBe("llm.cleanup.geminiModel");
  s.llm.cleanup.geminiModel = "gemini-2.5-flash";
  expect(cleanupModelKeyMissing(s.llm.cleanup)).toBeNull();
});

test("gate input reads every stage switch from settings", () => {
  const s = clone();
  s.llm.cleanup.enabled = true;
  s.cleanupDeepPass.entityRegister.enabled = true;
  const input = buildCleanupGateInput(s, { cleanupLlmAvailable: true, regexAvailable: false });
  expect(input.entityRegisterStageOn).toBe(true);
  expect(input.regexStageOn).toBe(false);
  expect(entityRegisterStageConfig(s)).toEqual({ batchSize: 10, autoApply: true });
});

function triggerArgs(s: MemorySettings) {
  return {
    settings: s,
    gate: buildCleanupGateInput(s, { cleanupLlmAvailable: true, regexAvailable: false }),
    ledger: new CleanupRunsLedger(openMemoryDatabase(":memory:", { embeddingDim: 8 })),
    scheduler: { tryTickNow: () => "started" as const, isRunning: () => false },
  };
}

test("interval keeps the scheduler only and builds no per-memo trigger", () => {
  const s = clone();
  s.llm.cleanup.enabled = true;
  s.llm.cleanup.trigger = "interval";
  s.cleanupDeepPass.entityRegister.enabled = true;
  expect(buildMemoSavedTrigger(triggerArgs(s))).toBeNull();
});

test("on_save with both per-memo stages off builds no trigger", () => {
  const s = clone();
  s.llm.cleanup.enabled = true;
  s.llm.cleanup.trigger = "on_save";
  s.cleanupDeepPass.entityRegister.enabled = false;
  s.cleanupDeepPass.personLink.enabled = false;
  expect(buildMemoSavedTrigger(triggerArgs(s))).toBeNull();
});

test("on_save opens a manual run marked memo_saved with only the per-memo stages", () => {
  const s = clone();
  s.llm.cleanup.enabled = true;
  s.llm.cleanup.trigger = "on_save";
  s.cleanupDeepPass.entityRegister.enabled = true;
  s.cleanupDeepPass.personLink.enabled = false;
  const args = triggerArgs(s);
  expect(memoSavedStages(args.gate)).toEqual(["entityRegister"]);
  const trigger = buildMemoSavedTrigger(args);
  expect(trigger).not.toBeNull();
  trigger!.stop();
});

test("a lost race closes the just-opened run as failed", () => {
  const s = clone();
  s.llm.cleanup.enabled = true;
  s.llm.cleanup.trigger = "on_save";
  s.cleanupDeepPass.entityRegister.enabled = true;
  s.cleanupDeepPass.personLink.enabled = false;
  const args = triggerArgs(s);
  const ctxs: unknown[] = [];
  const start = memoSavedRunStarter({
    ...args,
    scheduler: { tryTickNow: (ctx) => { ctxs.push(ctx); return "already_running"; }, isRunning: () => false },
  });
  expect(start([11, 12])).toBe("already_running");
  expect(ctxs).toHaveLength(1);
  const ctx = ctxs[0] as { runId: string; stages: string[]; nodeIds: number[] };
  expect(ctx.stages).toEqual(["entityRegister"]);
  expect(ctx.nodeIds).toEqual([11, 12]);
  const run = args.ledger.getRun(ctx.runId);
  expect(run!.trigger).toBe("manual");
  expect(run!.status).toBe("failed");
  expect(run!.options).toEqual({ stages: ["entityRegister"], nodeIds: [11, 12], reason: "memo_saved" });
  expect(run!.aggregates!.stopReason).toBe(MEMO_SAVED_LOST_RACE_STOP_REASON);
});

test("a started run stays running for the cycle to finish", () => {
  const s = clone();
  s.llm.cleanup.enabled = true;
  s.llm.cleanup.trigger = "on_save";
  s.cleanupDeepPass.entityRegister.enabled = true;
  s.cleanupDeepPass.personLink.enabled = true;
  const args = triggerArgs(s);
  let runId = "";
  const start = memoSavedRunStarter({
    ...args,
    scheduler: { tryTickNow: (ctx) => { runId = ctx.runId; return "started"; }, isRunning: () => false },
  });
  expect(start([3])).toBe("started");
  expect(args.ledger.statusOf(runId)).toBe("running");
  expect(args.ledger.getRun(runId)!.options.stages).toEqual(["entityRegister", "personLink"]);
});

test("a run whose start throws after the row was made is closed failed with the cause", () => {
  const s = clone();
  s.llm.cleanup.enabled = true;
  s.llm.cleanup.trigger = "on_save";
  s.cleanupDeepPass.entityRegister.enabled = true;
  const args = triggerArgs(s);
  let runId = "";
  const start = memoSavedRunStarter({
    ...args,
    scheduler: { tryTickNow: (ctx) => { runId = ctx.runId; throw new Error("scheduler handle closed"); }, isRunning: () => false },
  });
  expect(() => start([21])).toThrow("scheduler handle closed");
  const run = args.ledger.getRun(runId);
  expect(run!.status).toBe("failed");
  expect(run!.aggregates!.stopReason).toBe(`${MEMO_SAVED_START_FAILED_STOP_REASON}: scheduler handle closed`);
});
