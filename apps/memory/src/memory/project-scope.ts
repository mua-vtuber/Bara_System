/**
 * Project scope normalization for memory writes.
 *
 * Wire callers may omit projectId or send form-ish empty strings. Storage and
 * dedup use one shape: either a trimmed project id or SQL NULL.
 */
export function normalizeProjectId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
