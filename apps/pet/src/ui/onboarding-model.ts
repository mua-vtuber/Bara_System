/** The first-run setup's steps and where to resume it. The steps run in this order: where to keep memories
 * (`storage`), which AI answers and tidies up (`ai`), a check of each part (`check`), and whether to keep
 * the pet on screen (`display`). Optional integrations (AI apps over MCP, Discord) are not offered until
 * they exist, so no step stands for them yet.
 *
 * Progress is kept in the main window's storage (`ONBOARDING_KEY`). It only says where to resume: the
 * memory server's own install journal decides whether preparing it is finished, so losing this record
 * never repeats or skips a real install step. */
export const ONBOARDING_STEPS = ["storage", "ai", "check", "display"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const ONBOARDING_KEY = "bara.pet.onboarding.v1";

export interface OnboardingRecord { version: 1; step: OnboardingStep; completed: boolean }

export function parseOnboarding(raw: string | null): OnboardingRecord | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value?.version !== 1 || typeof value.completed !== "boolean" || !ONBOARDING_STEPS.includes(value.step as OnboardingStep)) return null;
    return { version: 1, step: value.step as OnboardingStep, completed: value.completed };
  } catch { return null; }
}

/** The saved setup progress, or null when there is none or it cannot be read (a blocked storage counts as none). */
export function readOnboarding(): OnboardingRecord | null {
  try { return parseOnboarding(localStorage.getItem(ONBOARDING_KEY)); } catch { return null; }
}

/** Where the setup starts, or `"done"` when it should not show.
 * - Without a memory credential the storage step always comes first, whatever the record says.
 * - With a credential but no record, Bara was set up before this setup existed (or its record was lost):
 *   it is not forced on the user again.
 * - A record left on the storage step whose storage is now connected moves on to the next step. */
export function startStep(record: OnboardingRecord | null, hasToken: boolean): OnboardingStep | "done" {
  if (!hasToken) return "storage";
  if (!record || record.completed) return "done";
  return record.step === "storage" ? nextStep("storage") : record.step;
}

export function nextStep(step: OnboardingStep): OnboardingStep | "done" {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[index + 1] ?? "done";
}

export function previousStep(step: OnboardingStep): OnboardingStep | null {
  return ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(step) - 1] ?? null;
}

export function record(step: OnboardingStep | "done"): OnboardingRecord {
  return step === "done" ? { version: 1, step: "display", completed: true } : { version: 1, step, completed: false };
}

/** The 1-based position shown as "2 / 4". */
export function stepNumber(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step) + 1;
}
