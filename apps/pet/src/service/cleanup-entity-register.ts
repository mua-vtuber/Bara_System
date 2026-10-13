import { serviceError } from "./errors.ts";
import { messages } from "../ui/messages.ts";
import type { Candidate } from "./cleanup.ts";

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const nullableString = (v: unknown) => v === null || typeof v === "string";

/** One name the model gave with a type the server did not offer: left out of the answer, not a reason to refuse it. */
export interface SkippedEntityName { type: string; name: string }

/**
 * The model's answer for one memo is kept as data; the server judges it with the same rules as its own cycle.
 * A name whose type is not in the server's allowedTypes is dropped from the answer and returned in
 * skippedNames (the server's own cycle drops it the same way, D7); every other malformed shape refuses the
 * whole answer.
 */
export function parseEntityRegisterDecision(candidate: Candidate, raw: Record<string, unknown>): {
  finding: true; kind: "entity_register"; payload: Record<string, unknown>; skippedNames: SkippedEntityName[];
} {
  const content = record(candidate.content);
  const nodeId = content?.nodeId;
  const allowed = Array.isArray(content?.allowedTypes) ? (content!.allowedTypes as unknown[]) : null;
  const keys = Object.keys(raw).sort().join(",");
  const entities = raw.entities;
  if (
    keys !== "entities,eventDate,eventDateText,scheduleTitle" || !Number.isSafeInteger(nodeId) || String(nodeId) !== candidate.targetKey || !allowed ||
    !Array.isArray(entities) || entities.some((e) => { const r = record(e); return !r || Object.keys(r).sort().join(",") !== "name,type" || typeof r.name !== "string" || typeof r.type !== "string"; }) ||
    !nullableString(raw.eventDateText) || !nullableString(raw.eventDate) || !nullableString(raw.scheduleTitle)
  ) throw serviceError("AI_PROPOSAL", messages.cleanupService.entityRegisterUnconfirmed);
  const named = entities as SkippedEntityName[];
  const kept = named.filter((e) => allowed.includes(e.type));
  const skippedNames = named.filter((e) => !allowed.includes(e.type)).map((e) => ({ type: e.type, name: e.name }));
  return {
    finding: true, kind: "entity_register", skippedNames,
    payload: { nodeId, entities: kept, eventDateText: raw.eventDateText, eventDate: raw.eventDate, scheduleTitle: raw.scheduleTitle },
  };
}
