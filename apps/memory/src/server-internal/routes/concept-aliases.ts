/**
 * server-internal/routes/concept-aliases.ts — D2 별칭 후보 게이트 API 등록기
 * (Phase 6b T10 / spec 8.3 / 사용자 결정 1 = 대시보드 게이트, 디스코드 알람 아님).
 *
 * 두 라우트:
 *   1. GET  /api/concept-aliases?status=pending — 임계 이상(모델별
 *      EMBEDDING_ALIAS_THRESHOLDS) 별칭 후보 목록. 각 후보의
 *      두 개념 id 를 사람이 읽을 이름(getConcept)으로 보강해 (new ↔ candidate)
 *      cosine 과 함께 반환한다. 후보 0건이면 빈 목록(정직한 빈 게이트 — 가짜 후보
 *      0). GET 은 부수효과 0 — 절대 합류를 트리거하지 않는다(자동 합류 금지).
 *   2. POST /api/concept-aliases/:id/resolve — body { action: 'merged' | 'rejected' }.
 *      merged → store.resolveAliasSuggestion(id,'merged')(=mergeConceptAlias 호출)
 *      rejected → status 만 갱신. 사용자가 [합치기]/[거절] 을 직접 눌렀을 때만 가동.
 *
 * silent fallback 금지: 없는 id 는 store 가 구체 에러로 throw → 404(빈 응답으로
 * 가리지 않는다). 잘못된 action 은 구체 400. 합류는 이 한 통로뿐 — GET·목록은
 * 절대 데이터를 바꾸지 않는다.
 *
 * Phase 8 경계: 6b 게이트는 후보 목록 + 합치기/거절 결정만. 색·아이콘·그래프
 * 시각화·검색 결과 펼침은 Phase 8(W10/R9) 권위라 여기 없다.
 */

import { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";

/** 게이트 결정 action — store.resolveAliasSuggestion 계약과 일치. */
const VALID_ACTIONS = ["merged", "rejected"] as const;
type ResolveAction = (typeof VALID_ACTIONS)[number];

function parseAction(raw: unknown): ResolveAction | undefined {
  return typeof raw === "string" && (VALID_ACTIONS as readonly string[]).includes(raw)
    ? (raw as ResolveAction)
    : undefined;
}

/** status 쿼리 — pending/merged/rejected 중 하나일 때만 필터, 그 외 전체. */
function parseStatus(raw: string | undefined): "pending" | "merged" | "rejected" | undefined {
  return raw === "pending" || raw === "merged" || raw === "rejected" ? raw : undefined;
}

export function registerConceptAliasRoutes(app: Hono, deps: MemoryApiDeps): void {
  const api = new Hono({ strict: false });

  // ── GET /concept-aliases — 후보 목록(두 개념 이름 + cosine) ────────────────
  api.get("/concept-aliases", async (c) => {
    const status = parseStatus(c.req.query("status"));
    const suggestions = await deps.store.listAliasSuggestions(status);

    // 두 개념 id 를 사람이 읽을 이름으로 보강 — getConcept 으로 조회. 흡수로 사라진
    // 개념(merged 후보의 new)은 null 일 수 있어 그 경우 빈 문자열로 노출(가짜 이름을
    // 만들지 않는다 — 정직). pending 후보는 두 개념 모두 살아 있다.
    const candidates = await Promise.all(
      suggestions.map(async (s) => {
        const [newConcept, candidateConcept] = await Promise.all([
          deps.store.getConcept(s.newConceptId),
          deps.store.getConcept(s.candidateConceptId),
        ]);
        return {
          suggestion_id: s.suggestionId,
          new_concept_id: s.newConceptId,
          new_concept_name: newConcept?.name ?? "",
          candidate_concept_id: s.candidateConceptId,
          candidate_concept_name: candidateConcept?.name ?? "",
          cosine: s.cosine,
          status: s.status,
          created_at: s.createdAt,
          resolved_at: s.resolvedAt,
        };
      }),
    );

    return c.json({ candidates });
  });

  // ── POST /concept-aliases/:id/resolve — 합치기/거절 ───────────────────────
  api.post("/concept-aliases/:id/resolve", async (c) => {
    const id = c.req.param("id");

    let body: { action?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    const action = parseAction(body.action);
    if (action === undefined) {
      return err(
        c,
        400,
        `action must be one of ${VALID_ACTIONS.join("/")}`,
      );
    }

    // 없는 id 는 store 가 구체 에러로 throw — 404 로 노출(빈 응답으로 가리지 않는다).
    // merged 면 store 가 mergeConceptAlias 까지 실행한다(사용자 클릭 = 명시 합류).
    try {
      await deps.store.resolveAliasSuggestion(id, action);
    } catch (e) {
      return err(c, 404, (e as Error).message);
    }

    return c.json({ resolved: id, action });
  });

  app.route("/api", api);
}
