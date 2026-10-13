/**
 * server-internal/routes/concept-detail.ts — 개념·사람 노드 상세 열람 API
 * (Phase 7 둘째 단계 Task 16·20 / spec §5.4 열람 표시 — 개념·사람 중심).
 *
 * 한 라우트:
 *   GET /concepts/:id — 한 개념(cpt_) 또는 사람(psn_) 노드의 상세를 회신한다.
 *     - concept: 노드 id + 사람이 읽을 이름. 이름은 id prefix 로 가른다 — cpt_ 면
 *       개념(getConcept.name), psn_ 면 사람(getPerson.displayName). getConcept 자체는
 *       개념 전용 의미를 지키고(여러 호출처 공유), psn_ 분기는 이 라우트 계층에서만
 *       한다(Task 20). 어느 쪽에도 없는 id 는 404(빈 응답으로 가리지 않는다 — silent
 *       fallback 금지).
 *
 *   Task 20: concept_edges 양 끝 FK 제거(Task 18)로 관계요약 from/to 가 사람(psn_)일 수
 *   있다. listRelationSummariesForConcept 는 TEXT 텍스트 매칭이라 psn_ id 도 그대로
 *   통과하므로(Task 14 메서드 재사용 — 신규 메서드 0), 사람 노드 상세도 같은 라우트가
 *   같은 "AI 가 찾은 관계" 목록을 회신한다. 상대 노드 이름 보강도 cpt_/psn_ 둘 다 푼다.
 *     - relationSummaries: "AI 가 찾은 관계" 목록. 그 개념이 from·to 어느 쪽에든 든
 *       관계요약(store.listRelationSummariesForConcept)을 confidence 동반으로 모으고,
 *       각 관계의 *상대* 개념 id 와 이름을 보강한다(otherConceptId/otherConceptName).
 *       confidence 가 임계(settings.cleanupDeepPass.summary.relationConfidenceThreshold)
 *       미만이면 edgePresent=false → 표시에서 "발굴됨 (연결 보류)" 라벨로 구분한다.
 *       search.ts 의 후처리와 *같은* gateRelationEdge 로 같은 판정을 재현한다(검색·열람
 *       라벨 일치). 관계 0건이면 빈 배열(정직한 빈 표시 — 가짜 채움 0).
 *     - hierarchy: hierarchy_edges 의 parent_of 위계 이웃(S0-T4 단일 출처 — 옛
 *       concept_edges getConceptNeighbors 필터에서 옮겨 옴). 각 이웃이 부모(이 개념이
 *       자식)인지 자식(이 개념이 부모)인지 direction 으로 구분하고 이름을 보강한다.
 *       "AI 가 찾은 관계"(llm_relation)
 *       와는 서로 다른 칸으로 나뉘어, 표시 측이 위계 vs AI 관계를 시각적으로 구분한다.
 *
 * GET 은 부수효과 0 — 조회만 하고 어떤 엣지·관계도 만들지 않는다. 요약 단계가 꺼져 있어
 * 관계요약이 한 건도 없어도(graceful) relationSummaries 빈 배열로 정직하게 회신한다.
 */

import { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";
import { gateRelationEdge } from "../../memory/cleanup-deep-pass/summary-gates.ts";

/** settings 미주입(테스트 직호출)이면 summary-gates 모듈 default 와 같은 plan 선택값. */
const DEFAULT_RELATION_CONFIDENCE_THRESHOLD = 0.6;

/**
 * 노드 id 한 개의 사람이 읽을 이름을 푼다 — id prefix 로 가른다(Task 20).
 *   - 'psn_' → persons.display_name(getPerson). 사람은 별 테이블에 산다(1.0b 분리).
 *   - 그 외(cpt_ 등) → concept_nodes.name(getConcept).
 * 어느 테이블에도 없으면 null(흡수·삭제로 사라진 노드 — 호출자가 정직한 빈/404 로 처리).
 * getConcept 을 persons 까지 보게 바꾸지 않는다(개념 전용 의미를 여러 호출처가 의존).
 */
async function resolveNodeName(
  store: MemoryApiDeps["store"],
  nodeId: string,
): Promise<string | null> {
  if (nodeId.startsWith("psn_")) {
    const person = await store.getPerson(nodeId);
    return person?.displayName ?? null;
  }
  const concept = await store.getConcept(nodeId);
  return concept?.name ?? null;
}

export function registerConceptDetailRoutes(app: Hono, deps: MemoryApiDeps): void {
  const api = new Hono({ strict: false });

  api.get("/concepts/:id", async (c) => {
    const conceptId = c.req.param("id");

    // 노드 이름을 id prefix 로 푼다 — psn_ 는 사람(display_name), 그 외는 개념(name).
    // 어느 테이블에도 없으면 404 — 빈 상세를 지어내지 않는다(silent fallback 금지).
    const nodeName = await resolveNodeName(deps.store, conceptId);
    if (nodeName === null) {
      return err(c, 404, `node not found: ${conceptId}`);
    }

    // search.ts 후처리가 쓰는 그 임계를 똑같이 읽어 같은 edgePresent 판정을 재현한다.
    const relationThreshold =
      deps.getSettings?.()?.cleanupDeepPass?.summary?.relationConfidenceThreshold ??
      DEFAULT_RELATION_CONFIDENCE_THRESHOLD;

    // ── "AI 가 찾은 관계"(llm_relation 발굴분) — 상대 개념 이름까지 보강 ──────────
    const rawRelations = deps.store.listRelationSummariesForConcept(conceptId);
    const relationSummaries = await Promise.all(
      rawRelations.map(async (r) => {
        // 양방향 조회라 이 개념이 from 일 수도 to 일 수도 있다. *상대* 끝을 골라낸다.
        const otherConceptId =
          r.fromConceptId === conceptId ? r.toConceptId : r.fromConceptId;
        // 상대 끝도 cpt_/psn_ 둘 다일 수 있다 — 같은 prefix 분기로 이름을 푼다(Task 20).
        const otherName = await resolveNodeName(deps.store, otherConceptId);
        return {
          summary_id: r.summaryId,
          relation_name: r.relationName,
          summary_text: r.summaryText,
          confidence: r.confidence,
          // 검색 표시와 같은 게이트 — 임계 미만이면 "발굴됨 (연결 보류)" 라벨.
          edge_present: gateRelationEdge(r.confidence, relationThreshold),
          from_concept_id: r.fromConceptId,
          to_concept_id: r.toConceptId,
          other_concept_id: otherConceptId,
          // 흡수·삭제로 사라진 노드는 null → 빈 문자열(가짜 이름을 만들지 않는다 — 정직).
          other_concept_name: otherName ?? "",
        };
      }),
    );

    // ── parent_of 위계 — "AI 가 찾은 관계" 와 구분되는 칸 ───────────────────────
    // S0-T4(위계 단일 출처) — 옛 getConceptNeighbors(concept_edges) 양방향 이웃에서
    // parent_of 만 걸러 쓰던 것을 hierarchy_edges 직접 조회로 바꾼다. 직접 자식(이
    // 개념이 source) + 직접 부모(이 개념이 target) id 를 모으고, 그 끝점 집합 안
    // 엣지를 getHierarchyEdgesWithin 으로 한 번에 읽어 *실제 weight* 를 그대로
    // 싣는다(상수 추측 없음 — 옛 엣지가 회신하던 그 값을 보존). 이 개념이 source 면
    // 상대는 자식, target 이면 상대는 부모로 direction 을 가른다.
    const childIds = deps.store.getHierarchyDirectChildren(conceptId);
    const parentIds = deps.store.getHierarchyDirectParents(conceptId);
    const hierEdges = deps.store.getHierarchyEdgesWithin([
      conceptId,
      ...childIds,
      ...parentIds,
    ]);
    const hierarchy = await Promise.all(
      hierEdges
        // 이 개념이 한 끝인 엣지만(집합 안 다른 두 노드 사이 엣지는 제외).
        .filter(
          (e) => e.sourceId === conceptId || e.targetId === conceptId,
        )
        .map(async (e) => {
          const isSource = e.sourceId === conceptId;
          const otherId = isSource ? e.targetId : e.sourceId;
          const other = await deps.store.getConcept(otherId);
          return {
            concept_id: otherId,
            name: other?.name ?? "",
            direction: isSource ? ("child" as const) : ("parent" as const),
            weight: e.weight,
          };
        }),
    );

    return c.json({
      concept: { concept_id: conceptId, name: nodeName },
      relation_summaries: relationSummaries,
      hierarchy,
    });
  });

  app.route("/api", api);
}
