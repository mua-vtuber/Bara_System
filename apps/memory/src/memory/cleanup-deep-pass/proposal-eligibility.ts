import { cleanupEligibleNodeSql } from "./cleanup-eligibility.ts";

/** Internal SQL aliases only. Keep excluded drafts for history, outside the actionable queue. */
export function cleanupEligibleProposalSql(alias: string): string {
  // Leave malformed historical payloads to each caller's existing validation/error handling.
  const payload = `(CASE WHEN json_valid(${alias}.payload_json) THEN ${alias}.payload_json ELSE '{}' END)`;
  const nodeId = `CAST(${payload} ->> '$.nodeId' AS INTEGER)`;
  const sourceNodeId = `CAST(${payload} ->> '$.sourceNodeId' AS INTEGER)`;
  return `(CASE
    WHEN ${alias}.kind IN ('entity_register', 'person_link', 'metadata_fill')
      THEN ${cleanupEligibleNodeSql(nodeId)}
    WHEN ${alias}.kind = 'regex_pattern_add'
      THEN ${cleanupEligibleNodeSql(sourceNodeId)}
    WHEN ${alias}.kind = 'lens_draft' THEN NOT EXISTS (
      SELECT 1 FROM json_each(${payload}, '$.fingerprintGuard.evidenceNodeIds') evidence
      WHERE NOT (${cleanupEligibleNodeSql("CAST(evidence.value AS INTEGER)")})
    )
    ELSE 1
  END)`;
}
