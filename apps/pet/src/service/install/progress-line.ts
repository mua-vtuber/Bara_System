import type { ProgressDetail } from "../../shared/contracts.ts";
import nativeHost from "../../shared/native-host.json";

/** The download scripts' byte-progress line (`apps/setup/src/managed-models.ts`,
 * `apps/memory/scripts/prefetch-core-models.ts`): this prefix, then one JSON object. */
export const PROGRESS_LINE_PREFIX = "@@bara-progress ";
/** Environment variable that asks the download scripts to write progress lines (apps/memory/src/tools/install-progress.ts
 * `PROGRESS_ENV`); without it they stay silent, so a CLI setup's terminal is not filled with them. */
export const PROGRESS_LINES_ENV = "BARA_INSTALL_PROGRESS";
const FIELDS = ["part", "parts", "loaded", "total"] as const;
/** The most parts one detail may name; the host checks the same contract value (`policy::progress_detail`). */
export const PROGRESS_MAX_PARTS: number = nativeHost.contract.progressDetailMaxParts;

/** Whether `value` is a detail the host would forward: exactly the four non-negative safe integers, with
 * `1 <= part <= parts <= PROGRESS_MAX_PARTS`. */
export function isProgressDetail(value: unknown): value is ProgressDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== FIELDS.length || !FIELDS.every((field) => keys.includes(field))) return false;
  const detail = value as Record<string, unknown>;
  if (!FIELDS.every((field) => Number.isSafeInteger(detail[field]) && (detail[field] as number) >= 0)) return false;
  const { part, parts } = detail as unknown as ProgressDetail;
  return part >= 1 && part <= parts && parts <= PROGRESS_MAX_PARTS;
}

/** The detail a child's stdout line carries, or null for any other line. Strict on purpose: the line is
 * child output, so a near miss (another prefix, an extra field, a fraction, a string) is ignored rather
 * than read generously. */
export function parseProgressLine(line: string): ProgressDetail | null {
  if (!line.startsWith(PROGRESS_LINE_PREFIX)) return null;
  let value: unknown;
  try { value = JSON.parse(line.slice(PROGRESS_LINE_PREFIX.length)); } catch { return null; }
  if (!isProgressDetail(value)) return null;
  return { part: value.part, parts: value.parts, loaded: value.loaded, total: value.total };
}

/** A script's own detail placed in the install's one model sequence: `before` parts came earlier and `after`
 * are still to come. Null when the sequence would name more than `PROGRESS_MAX_PARTS` parts. */
export function inSequence(detail: ProgressDetail, before: number, after: number): ProgressDetail | null {
  const placed = { ...detail, part: before + detail.part, parts: before + detail.parts + after };
  return isProgressDetail(placed) ? placed : null;
}
