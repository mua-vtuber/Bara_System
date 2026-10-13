/**
 * routes/cleanup-proposals-entity-register.ts — entity_register 승인·거절 라우트 몸통.
 * cleanup-proposals.ts 는 kind 분기 한 줄로 여기에 넘긴다(새 종류의 적용 로직을 라우트에 직접 쓰지 않는다 —
 * spec 6장). 적용 자체는 memory 층 approveEntityRegisterProposal·rejectEntityRegisterProposal 이 한다.
 *
 * 응답: 고른 항목 없음·본문 형식 오류 = 400(제안 pending 유지), 그 사이 다른 요청이 처리함 = 409,
 * 오래된 제안 = 400(needs_revision 으로 닫힘·사유 동봉). 그 밖의 오류는 잡지 않는다 — app.onError 가 500 으로
 * 돌려주고, 쓰기 트랜잭션은 되돌려져 제안은 pending 이다.
 */
import type { Context } from "hono";
import type { CleanupProposal, CleanupProposalsRepository } from "../../db/store-internal/cleanup-proposals-repository.ts";
import { EVENT_TYPES } from "../../memory/events/event-contract.ts";
import {
  approveEntityRegisterProposal, EntityRegisterChoiceError, EntityRegisterProposalNotPendingError, parseEntityRegisterChoices,
  rejectEntityRegisterProposal, validateEntityRegisterPayload, type EntityRegisterProposalPayload,
} from "../../memory/cleanup-deep-pass/entity-register/proposal.ts";
import { EntityRegisterRecordsRepository } from "../../memory/cleanup-deep-pass/entity-register/records-repository.ts";
import { err } from "../http-helpers.ts";
import type { MemoryApiDeps } from "../types.ts";

export async function approveEntityRegisterRoute(c: Context, deps: MemoryApiDeps, repo: CleanupProposalsRepository, proposal: CleanupProposal): Promise<Response> {
  if (proposal.status !== "pending") return err(c, 400, `이미 처리된 proposal — status: ${proposal.status}`);
  const valid = validateEntityRegisterPayload(proposal.payload);
  if (!valid.ok) return err(c, 400, valid.message);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return err(c, 400, "entity_register 승인 본문은 { choices } JSON 이어야 함");
  }
  const payload = proposal.payload as unknown as EntityRegisterProposalPayload;
  let result;
  try {
    const choices = parseEntityRegisterChoices(body, payload);
    const records = new EntityRegisterRecordsRepository(deps.store.getRawDb());
    result = await approveEntityRegisterProposal({ store: deps.store, proposals: repo, records, proposal, choices });
  } catch (e) {
    if (e instanceof EntityRegisterChoiceError) return err(c, 400, e.message);
    if (e instanceof EntityRegisterProposalNotPendingError) return err(c, 409, e.message);
    throw e;
  }
  if (result.appliedCount > 0) {
    deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "entity-register-approved", nodeId: payload.nodeId });
  }
  if (result.appliedCount === 0 && result.status === "needs_revision") {
    return c.json({ error: result.staleReason ?? "적용된 항목 없음", status: result.status, items: result.items }, 400);
  }
  return c.json({ approved: proposal.id, status: result.status, appliedCount: result.appliedCount, items: result.items });
}

export async function rejectEntityRegisterRoute(c: Context, deps: MemoryApiDeps, repo: CleanupProposalsRepository, proposal: CleanupProposal): Promise<Response> {
  try {
    await rejectEntityRegisterProposal({
      store: deps.store, proposals: repo, records: new EntityRegisterRecordsRepository(deps.store.getRawDb()), proposal,
    });
  } catch (e) {
    if (e instanceof EntityRegisterProposalNotPendingError) return err(c, 409, e.message);
    throw e;
  }
  return c.json({ rejected: proposal.id });
}
