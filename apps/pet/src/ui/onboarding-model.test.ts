import { expect, test } from "bun:test";
import { nextStep, ONBOARDING_STEPS, parseOnboarding, previousStep, record, startStep, stepNumber } from "./onboarding-model.ts";

test("the steps run storage → ai → check → display, then finish", () => {
  expect(ONBOARDING_STEPS).toEqual(["storage", "ai", "check", "display"]);
  expect(nextStep("storage")).toBe("ai");
  expect(nextStep("display")).toBe("done");
  expect(ONBOARDING_STEPS.map(stepNumber)).toEqual([1, 2, 3, 4]);
  expect(previousStep("storage")).toBeNull();
  expect(previousStep("display")).toBe("check");
});

test("without a memory credential the storage step always comes first", () => {
  expect(startStep(null, false)).toBe("storage");
  expect(startStep(record("check"), false)).toBe("storage");
  expect(startStep(record("done"), false)).toBe("storage");
});

test("a Bara set up before this setup existed is not sent through it again", () => {
  expect(startStep(null, true)).toBe("done");
  expect(startStep(record("done"), true)).toBe("done");
});

test("an interrupted setup resumes where it stopped, past a storage step that is now connected", () => {
  expect(startStep(record("storage"), true)).toBe("ai");
  expect(startStep(record("check"), true)).toBe("check");
  expect(startStep(record("display"), true)).toBe("display");
});

test("only a well-formed record is trusted; anything else counts as no record", () => {
  expect(parseOnboarding(JSON.stringify(record("ai")))).toEqual({ version: 1, step: "ai", completed: false });
  expect(parseOnboarding(JSON.stringify(record("done")))).toEqual({ version: 1, step: "display", completed: true });
  for (const raw of [null, "", "not json", "null", "[]", '{"version":2,"step":"ai","completed":false}',
    '{"version":1,"step":"mcp","completed":false}', '{"version":1,"step":"ai"}']) {
    expect(parseOnboarding(raw)).toBeNull();
  }
});
