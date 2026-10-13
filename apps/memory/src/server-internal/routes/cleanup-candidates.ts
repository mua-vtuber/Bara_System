/**
 * routes/cleanup-candidates.ts — 정리 후보 조회 + 무산출 신고 표면 (MCP spec 6.1·6.3).
 * 내부 전용이던 후보 검출을 내용까지 회신하는 조회 표면으로 노출한다. 원장 필터는
 * listExternalCandidates 안에서 필수 적용된다. auth-gate 뒤(어댑터 토큰 필수).
 */
import { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err, parseLimit } from "../http-helpers.ts";
import { EXTERNAL_CANDIDATE_STAGES, externalStageContractOf } from "../cleanup-external/stage-map.ts";
import {
  CleanupExternalDisabledError,
  CleanupExternalInputError,
  EXTERNAL_NODE_IDS_MAX,
  listExternalCandidates,
} from "../cleanup-external/candidates.ts";
import { reportExternalNoFinding } from "../cleanup-external/proposals.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const POSITIVE_INT = /^[1-9][0-9]*$/;

/**
 * nodeIds 쿼리(`1,2,3`)를 읽는다. 없으면 undefined(전체 후보). 조각 하나라도 양의 정수가 아니면 오류 문장을
 * 돌려준다 — 잘못된 조각을 버리고 나머지만 쓰면 호출자가 "그 메모만 받았다"고 오해한다.
 */
function parseNodeIds(raw: string | undefined): { ok: true; nodeIds?: number[] } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true };
  const parts = raw.split(",");
  if (!parts.every((p) => POSITIVE_INT.test(p))) {
    return { ok: false, message: `nodeIds 는 쉼표로 이은 양의 정수 (받은 값: '${raw}')` };
  }
  if (parts.length > EXTERNAL_NODE_IDS_MAX) {
    return { ok: false, message: `nodeIds 는 한 번에 최대 ${EXTERNAL_NODE_IDS_MAX}개 (받은 개수: ${parts.length})` };
  }
  return { ok: true, nodeIds: parts.map(Number) };
}

export function registerCleanupCandidatesRoutes(app: Hono, deps: MemoryApiDeps): void {
  const api = new Hono({ strict: false });

  api.get("/api/cleanup-candidates", async (c) => {
    const stage = c.req.query("stage") ?? "";
    if (externalStageContractOf(stage) === null) {
      return err(
        c,
        400,
        `미지원 stage '${stage}' — 유효 값: ${EXTERNAL_CANDIDATE_STAGES.join("/")}`,
      );
    }
    const limit = parseLimit(c.req.query("limit"), DEFAULT_LIMIT, MAX_LIMIT);
    const ids = parseNodeIds(c.req.query("nodeIds"));
    if (!ids.ok) return err(c, 400, ids.message);
    try {
      const list = await listExternalCandidates(
        deps,
        stage as (typeof EXTERNAL_CANDIDATE_STAGES)[number],
        limit,
        ids.nodeIds,
      );
      return c.json(list);
    } catch (e) {
      if (e instanceof CleanupExternalInputError) return err(c, 400, e.message);
      if (e instanceof CleanupExternalDisabledError) return err(c, 503, e.message);
      throw e;
    }
  });

  // ── POST /api/cleanup-candidates/no-finding — 무산출 신고 (spec 6.3·6.4) ────
  // 검증·원장 기록 권위는 reportExternalNoFinding 한 곳 — MCP cleanup_report_no_finding
  // 과 공유. candidate 4칸 전부 필수(GET 회신 형태와 동일 — 조회한 것을 그대로 되돌림).
  api.post("/api/cleanup-candidates/no-finding", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return err(c, 400, "invalid JSON body");
    }
    const outcome = await reportExternalNoFinding(deps, {
      stage: body.stage,
      targetKey: body.targetKey,
      inputFingerprint: body.inputFingerprint,
      stageVersion: body.stageVersion,
    });
    if (!outcome.ok) {
      if (outcome.httpStatus === 409) {
        return c.json({ error: outcome.message, current: outcome.current }, 409);
      }
      return err(c, outcome.httpStatus, outcome.message);
    }
    return c.json({ recorded: true, status: "completed_noop" });
  });

  app.route("/", api);
}
