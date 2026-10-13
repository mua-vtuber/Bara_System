/** Shared, dependency-free validation for ingest responses and their reconciliation receipts. */
export interface IngestResult extends Record<string, unknown> {
  ok: true;
  originNodeId?: number;
  documentId?: string;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) > 0;

export function isIngestSuccess(value: unknown): value is IngestResult {
  if (!record(value) || value.ok !== true) return false;
  if (value.type === "text") return positiveId(value.originNodeId);
  if (value.type === "entity_patch") return Array.isArray(value.entities) && value.entities.length > 0
    && value.entities.every(entity => record(entity) && typeof entity.id === "string" && entity.id.length > 0 && typeof entity.typeName === "string");
  if (value.type === "image") return Array.isArray(value.images) && value.images.length > 0
    && value.images.every(image => record(image) && positiveId(image.nodeId));
  return typeof value.documentId === "string" && value.documentId.length > 0
    && Array.isArray(value.nodeIds) && value.nodeIds.length > 0 && value.nodeIds.every(positiveId);
}
