import { serviceError } from "./errors.ts";
import { messages } from "../ui/messages.ts";
import type { Candidate } from "./cleanup.ts";

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The text fields of one rule proposal, all required (the server's own cycle reads the same ones). */
const TEXT_FIELDS = ["pattern", "category", "polarity", "exampleInput", "exampleExtracted", "description"] as const;
const REQUIRED_FIELDS: readonly string[] = [...TEXT_FIELDS, "score"];
const ALLOWED_FIELDS: readonly string[] = [...REQUIRED_FIELDS, "rationale"];
/** Longest pattern the Pet forwards; a longer one is not a rule a person can review. */
export const REGEX_PATTERN_MAX_CHARS = 240;

/**
 * The model's rule proposal for one missed memo, checked for its shape only. The score range, the category
 * and polarity lists, compiling the pattern and matching its example are the server's quality checks (the
 * same harness its own cycle runs), so the Pet keeps no copy of those rules and forwards the proposal for the
 * server to judge.
 */
export function parseRegexStrengthenDecision(candidate: Candidate, raw: Record<string, unknown>): {
  finding: true; kind: "regex_pattern_add"; payload: Record<string, unknown>;
} {
  const content = record(candidate.content);
  const sourceNodeId = content?.id;
  const keys = Object.keys(raw);
  if (
    keys.some((key) => !ALLOWED_FIELDS.includes(key)) || REQUIRED_FIELDS.some((key) => !keys.includes(key)) ||
    TEXT_FIELDS.some((key) => typeof raw[key] !== "string" || !(raw[key] as string).trim()) ||
    (raw.pattern as string).length > REGEX_PATTERN_MAX_CHARS || !Number.isInteger(raw.score) ||
    ("rationale" in raw && typeof raw.rationale !== "string") ||
    !Number.isSafeInteger(sourceNodeId) || String(sourceNodeId) !== candidate.targetKey
  ) throw serviceError("AI_PROPOSAL", messages.cleanupService.regexUnconfirmed);
  const payload: Record<string, unknown> = { sourceNodeId };
  for (const key of REQUIRED_FIELDS) payload[key] = raw[key];
  if (typeof raw.rationale === "string") payload.rationale = raw.rationale;
  return { finding: true, kind: "regex_pattern_add", payload };
}
