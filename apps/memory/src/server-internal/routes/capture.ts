/** User-facing capture classification, separate from the existing MemoryType. */
export const CAPTURE_KINDS = ["idea", "decision", "question", "preference", "task", "information"] as const;
export type Capture = { kind: (typeof CAPTURE_KINDS)[number]; source: "user" | "ai" };

export function parseCapture(value: unknown): Capture | null | undefined {
  if (value === undefined || value === null) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid capture");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "kind,source" ||
      !CAPTURE_KINDS.includes(record.kind as Capture["kind"]) ||
      (record.source !== "user" && record.source !== "ai")) throw new Error("invalid capture");
  return { kind: record.kind as Capture["kind"], source: record.source };
}
