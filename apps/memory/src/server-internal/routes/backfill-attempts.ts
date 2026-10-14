/**
 * routes/backfill-attempts.ts — 자동 추출·캡션 백필 실패 기록 관리 API (2026-10-14 backfill-retry-ledger spec 5장).
 *
 *   GET  /api/backfill-attempts/status?kind=extraction|caption → BackfillAttemptsStatusResponse
 *   POST /api/backfill-attempts/retry  { kind, targetKeys } | { kind, all: true } → { cleared }
 *        해당 줄(멈춤·대기 모두)을 지울 뿐 즉시 실행하지 않는다 — 다음 주기에 다시 후보가 된다.
 *
 * 권한: full 토큰만. token-scope.ts 의 SCOPED_HTTP_ROUTES 에 넣지 않는다(문서 OCR 관리 경로와 같은 방식 — 제한 토큰은
 * 표에 없는 경로를 모두 거부한다). 잘못된 kind·본문은 400 과 이유 문장. 경로·형식은 memory/backfill-attempts/contract.ts.
 */
import type { Hono } from "hono";
import {
  BACKFILL_ATTEMPT_KINDS,
  BACKFILL_ATTEMPTS_RETRY_PATH,
  BACKFILL_ATTEMPTS_STATUS_PATH,
  isBackfillAttemptKind,
  type BackfillRetryRequest,
  type BackfillRetryResponse,
} from "../../memory/backfill-attempts/contract.ts";
import { BackfillAttemptsLedger } from "../../memory/backfill-attempts/ledger.ts";
import { err } from "../http-helpers.ts";
import type { MemoryApiDeps } from "../types.ts";

/** 이유 문장에 받은 값을 보인다 — 없으면 "없음", 있으면 JSON 그대로. */
function shown(value: unknown): string {
  return value === undefined ? "없음" : JSON.stringify(value);
}

function kindError(value: unknown): string {
  return `kind 는 ${BACKFILL_ATTEMPT_KINDS.join(" | ")} 중 하나여야 함 (받은 값: ${shown(value)})`;
}

/** 다시 시도 본문 해석. 문자열을 돌려주면 그것이 400 이유다. */
export function parseBackfillRetryRequest(body: unknown): BackfillRetryRequest | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "본문은 { kind, targetKeys } 또는 { kind, all: true } 객체여야 함";
  }
  const rec = body as Record<string, unknown>;
  if (!isBackfillAttemptKind(rec.kind)) return kindError(rec.kind);
  const hasTargets = "targetKeys" in rec;
  const hasAll = "all" in rec;
  if (hasTargets && hasAll) return "targetKeys 와 all 은 함께 보낼 수 없음";
  if (hasAll) return rec.all === true ? { kind: rec.kind, all: true } : "all 은 true 여야 함";
  if (!hasTargets) return "targetKeys 또는 all 중 하나가 필요함";
  const keys = rec.targetKeys;
  if (!Array.isArray(keys) || keys.length === 0) return "targetKeys 는 비어 있지 않은 배열이어야 함";
  if (!keys.every((k) => typeof k === "string" && k.length > 0)) {
    return "targetKeys 의 원소는 모두 빈 문자열이 아닌 문자열이어야 함";
  }
  return { kind: rec.kind, targetKeys: keys as string[] };
}

export function registerBackfillAttemptsRoutes(app: Hono, deps: MemoryApiDeps): void {
  app.get(BACKFILL_ATTEMPTS_STATUS_PATH, (c) => {
    const kind = c.req.query("kind");
    if (!isBackfillAttemptKind(kind)) return err(c, 400, kindError(kind));
    return c.json(new BackfillAttemptsLedger(deps.store.getRawDb()).status(kind));
  });

  app.post(BACKFILL_ATTEMPTS_RETRY_PATH, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "본문이 JSON 이 아님");
    }
    const request = parseBackfillRetryRequest(body);
    if (typeof request === "string") return err(c, 400, request);
    const ledger = new BackfillAttemptsLedger(deps.store.getRawDb());
    const cleared = "all" in request ? ledger.clearKind(request.kind) : ledger.clearTargets(request.kind, request.targetKeys);
    const response: BackfillRetryResponse = { cleared };
    return c.json(response);
  });
}
