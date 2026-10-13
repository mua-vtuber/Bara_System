export const PROVENANCE_VALUES = [
  "user_input",
  "hashtag",
  "regex",
  "llm_extract",
  "image",
  "evolver",
  "migration",
  "system",
] as const;

export type Provenance = (typeof PROVENANCE_VALUES)[number];

const PROVENANCE_VALUE_SET = new Set<string>(PROVENANCE_VALUES);

export function isProvenance(raw: unknown): raw is Provenance {
  return typeof raw === "string" && PROVENANCE_VALUE_SET.has(raw);
}

export function assertProvenance(raw: unknown): asserts raw is Provenance {
  if (!isProvenance(raw)) {
    throw new Error(`unknown relation provenance: ${String(raw)}`);
  }
}
