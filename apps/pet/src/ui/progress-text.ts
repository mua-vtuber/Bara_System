import type { ProgressDetail, ProgressStage } from "../shared/contracts.ts";
import { messages } from "./messages.ts";

/** Whole decimal megabytes (1,000,000 bytes), as a download size is usually quoted. */
export function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

/** The byte line under a stage's own text, or null when the stage has none to show: only `models` reports
 * bytes today. */
export function downloadText(stage: ProgressStage, detail: ProgressDetail | undefined): string | null {
  if (stage !== "models" || !detail) return null;
  return messages.downloadProgress.models(detail.part, detail.parts, megabytes(detail.loaded),
    detail.total > 0 ? megabytes(detail.total) : null);
}

/** The current part's bar (`<progress>` value and max), only when its size is known. */
export function downloadBar(stage: ProgressStage, detail: ProgressDetail | undefined): { value: number; max: number } | null {
  if (stage !== "models" || !detail || detail.total <= 0) return null;
  return { value: Math.min(detail.loaded, detail.total), max: detail.total };
}
