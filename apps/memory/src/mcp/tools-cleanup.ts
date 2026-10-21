/**
 * mcp/tools-cleanup.ts — 정리 엔진 도구 4종 (spec 5.3). 신설 REST 3표면과 같은
 * 공유 함수(listExternalCandidates / submitExternalProposal / reportExternalNoFinding)
 * + run 원장 조회를 재노출한다. run 시작·취소는 사용자 확정 목록 밖 — 등록하지 않는다.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EXTERNAL_CANDIDATE_STAGES } from "../server-internal/cleanup-external/stage-map.ts";
import {
  CleanupExternalDisabledError,
  CleanupExternalInputError,
  EXTERNAL_NODE_IDS_MAX,
  listExternalCandidates,
} from "../server-internal/cleanup-external/candidates.ts";
import {
  reportExternalNoFinding,
  submitExternalProposal,
} from "../server-internal/cleanup-external/proposals.ts";
import { ENTITY_REGISTER_KIND } from "../memory/cleanup-deep-pass/entity-register/constants.ts";
import { TOOL_DESCRIPTIONS, CLEANUP_LIST_CANDIDATES_READ_ONLY } from "./descriptions.ts";
import { TOOL_ANNOTATIONS } from "./annotations.ts";
import { toolError, toolJson, type McpToolContext } from "./server.ts";
import type { BaraToolErrorCode } from "./errors.ts";
import { canUseMcpTool } from "./access.ts";

const STAGE_ENUM = z.enum(EXTERNAL_CANDIDATE_STAGES);

/**
 * payload 모양 안내 — 단계(candidate.stage)별로 한 줄씩. 서버 검사는
 * cleanup-external/proposals.ts(validateProposalPayload·6단 정합)가 권위다.
 * 이 문구는 tools/list 의 payload 칸 설명으로 실린다 — 도구 문안(descriptions.ts)에는
 * 되풀이하지 않는다(server.test.ts 가 실제 회신으로 감시).
 */
export const PROPOSAL_PAYLOAD_DESCRIPTION =
  "Shape depends on candidate.stage. " +
  "entityRegister / regexStrengthen: the object shared.instruction asks for " +
  "(nodeId / sourceNodeId is filled from targetKey when absent; a different value is rejected). " +
  "personLink: {nodeId, personId} - nodeId must equal targetKey, personId an existing person id. " +
  "lensDraft: {typeName, entityId, values: {columns, labels, relations, metadata}} - " +
  "typeName and entityId must match targetKey, each values part an object; " +
  "the server ignores relations and metadata.";

/**
 * SubmitProposalOutcome / NoFindingOutcome 의 httpStatus(REST 라우트 계약) 를 도구
 * 코드로 옮긴다(spec 6.2·6.3 검증 순서 그대로 — 매핑만 T8 신설). 409 는 이 두 공유
 * 함수 안에서 전부 stageVersion·재제출·지문 불일치 갈래라 STALE_CANDIDATE 한 코드로
 * 묶인다(브리핑 T8 §4 — fingerprint/stageVersion mismatch, 대상 실종은 404 로 별도).
 * 503 은 entity_register 서버 판정에 필요한 설정 배선(getSettings)이 없는 꺼진 상태라 DISABLED.
 */
function httpStatusToCode(status: 400 | 404 | 409 | 503): BaraToolErrorCode {
  if (status === 400) return "INVALID_INPUT";
  if (status === 404) return "NOT_FOUND";
  if (status === 503) return "DISABLED";
  return "STALE_CANDIDATE";
}

export function registerCleanupTools(server: McpServer, ctx: McpToolContext): void {
  const { deps } = ctx;

  server.registerTool(
    "cleanup_list_candidates",
    {
      // read-only 토큰은 제출 도구가 tools/list 에서 빠지므로(access.ts) 제출을 권하는 문안을 쓰지 않는다.
      description: canUseMcpTool(ctx.scope, "cleanup_submit_proposal")
        ? TOOL_DESCRIPTIONS.cleanup_list_candidates
        : CLEANUP_LIST_CANDIDATES_READ_ONLY,
      annotations: TOOL_ANNOTATIONS.cleanup_list_candidates,
      inputSchema: {
        stage: STAGE_ENUM,
        limit: z.number().int().min(1).max(100).optional(),
        nodeIds: z.array(z.number().int().min(1)).max(EXTERNAL_NODE_IDS_MAX).optional(),
      },
    },
    async (args) => {
      if (!canUseMcpTool(ctx.scope, "cleanup_list_candidates")) return toolError("FORBIDDEN", "cleanup_list_candidates is not allowed by this token");
      try {
        return toolJson(await listExternalCandidates(deps, args.stage, args.limit ?? 20, args.nodeIds));
      } catch (e) {
        if (e instanceof CleanupExternalInputError) return toolError("INVALID_INPUT", e.message);
        // T16 — 배선·설정이 없어 기능이 꺼져 있는 상태는 서버 결함(INTERNAL)이
        // 아니라 DISABLED 다. 호출 AI 가 "고장났으니 재시도"와 "꺼져 있으니
        // 재시도 무의미"를 구분할 수 있어야 한다(문구는 그대로 — 코드만 정정).
        if (e instanceof CleanupExternalDisabledError) return toolError("DISABLED", e.message);
        return toolError(
          "INTERNAL",
          `Candidate lookup failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "cleanup_submit_proposal",
    {
      description: TOOL_DESCRIPTIONS.cleanup_submit_proposal,
      annotations: TOOL_ANNOTATIONS.cleanup_submit_proposal,
      inputSchema: {
        // metadata_fill 은 외부 통로가 없어(stage-map.ts 대응 stage 부재) 항상 400 이라 열거하지 않는다.
        kind: z.enum(["person_link", "regex_pattern_add", "lens_draft", ENTITY_REGISTER_KIND]),
        payload: z.record(z.string(), z.unknown()).describe(PROPOSAL_PAYLOAD_DESCRIPTION),
        candidate: z.object({
          stage: STAGE_ENUM,
          targetKey: z.string(),
          inputFingerprint: z.string(),
          stageVersion: z.number().int(),
        }),
      },
    },
    async (args) => {
      try {
        if (!canUseMcpTool(ctx.scope, "cleanup_submit_proposal")) return toolError("FORBIDDEN", "cleanup_submit_proposal is not allowed by this token");
        const outcome = await submitExternalProposal(deps, args);
        if (!outcome.ok) {
          return toolError(
            httpStatusToCode(outcome.httpStatus),
            outcome.message,
            outcome.current ? { current: outcome.current } : undefined,
          );
        }
        // entity_register 는 서버 판정 결과 제안 없이 자동 반영만 될 수 있다(proposalId null → status none).
        // regex_pattern_add 는 서버 하네스에서 탈락하면 제안 없이 탈락 사유를 싣는다(status rejected).
        return toolJson({
          proposalId: outcome.proposalId,
          status: outcome.rejected ? "rejected" : outcome.proposalId === null ? "none" : "pending",
          ledgerRecorded: true,
          ...(outcome.autoApplied !== undefined ? { autoApplied: outcome.autoApplied } : {}),
          ...(outcome.rejected ? { rejected: outcome.rejected } : {}),
        });
      } catch (e) {
        // 정상 검증 실패는 outcome 갈래로 회신된다 — 이 catch 는 지문 재계산 DB 조회나
        // 등록 트랜잭션 내부의 예상 밖 예외를 SDK 프로토콜 오류로 새어나가지 않게 잡는다.
        return toolError(
          "INTERNAL",
          `제안 등록 실패: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "cleanup_report_no_finding",
    {
      description: TOOL_DESCRIPTIONS.cleanup_report_no_finding,
      annotations: TOOL_ANNOTATIONS.cleanup_report_no_finding,
      inputSchema: {
        stage: STAGE_ENUM,
        targetKey: z.string(),
        inputFingerprint: z.string(),
        stageVersion: z.number().int(),
      },
    },
    async (args) => {
      try {
        if (!canUseMcpTool(ctx.scope, "cleanup_report_no_finding")) return toolError("FORBIDDEN", "cleanup_report_no_finding is not allowed by this token");
        const outcome = await reportExternalNoFinding(deps, args);
        if (!outcome.ok) {
          return toolError(
            httpStatusToCode(outcome.httpStatus),
            outcome.message,
            outcome.current ? { current: outcome.current } : undefined,
          );
        }
        return toolJson({ recorded: true, status: "completed_noop" });
      } catch (e) {
        // 정상 검증 실패는 outcome 갈래로 회신된다 — 이 catch 는 지문 재계산 DB 조회나
        // 원장 기록 중의 예상 밖 예외를 SDK 프로토콜 오류로 새어나가지 않게 잡는다.
        return toolError(
          "INTERNAL",
          `무산출 신고 실패: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "cleanup_run_status",
    {
      description: TOOL_DESCRIPTIONS.cleanup_run_status,
      annotations: TOOL_ANNOTATIONS.cleanup_run_status,
      inputSchema: { runId: z.string().min(1).describe("Run id the user gave you; no tool returns one.") },
    },
    async (args) => {
      if (!canUseMcpTool(ctx.scope, "cleanup_run_status")) return toolError("FORBIDDEN", "cleanup_run_status is not allowed by this token");
      const runs = deps.cleanupRuns;
      if (!runs) {
        // T16 — 배선 부재는 고장이 아니라 꺼진 상태라 DISABLED (문구 불변).
        return toolError(
          "DISABLED",
          "cleanup run API 비활성 — 깊은 패스 스케줄러 배선이 없다(llm.cleanup.enabled 및 단계 게이트 확인)",
        );
      }
      const row = runs.ledger.getRun(args.runId);
      if (!row) return toolError("NOT_FOUND", `run 없음 — id 확인 (runId=${args.runId})`);
      return toolJson(row);
    },
  );
}
