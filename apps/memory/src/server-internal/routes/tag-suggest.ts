/**
 * server-internal/routes/tag-suggest.ts — # 태그 자동완성 데이터 통로 등록기
 * (그래프 입력 해시태그 개편 S6 / 결정 3).
 *
 * 한 라우트:
 *   GET /api/tag-suggest[?prefix=작업] — 저장된 개념 목록을 추천 후보로 회신한다.
 *     store.listConcepts() 를 재사용하고(새 테이블 0), 각 개념의 name 과 usage_count
 *     (tag_usage_count + classification_usage_count 합)을 {name,count} 로 직렬화한다.
 *     listConcepts 가 이미 tag_usage_count DESC, classification_usage_count DESC 로
 *     정렬해 내려주므로, 추천 순서는 자주 쓴 태그가 위로 온다(별도 정렬 0).
 *
 * 접두 필터 위치(spec AC "둘 중 한 곳에서만"): 런타임 필터는 클라이언트
 * (tag-autocomplete.js 의 filterSuggestions) 가 맡는다 — 사용자가 # 뒤를 한 글자씩
 * 칠 때마다 네트워크를 다시 치지 않고, 한 번 받은 목록을 그 자리에서 거른다. 이 라우트의
 * ?prefix 파라미터는 같은 접두 일치를 *서버에서도* 제공하는 직접 호출용 통로다 — 클라
 * 위젯은 이 파라미터를 안 쓰고(목록을 통째로 받아 로컬 필터), 직접 API 호출자가 한 번에
 * 좁혀 받고 싶을 때만 쓴다. 두 필터는 같은 접두 규칙을 쓰되 런타임에는 한 곳(클라)만 돈다.
 *
 * No-fallback / No-mock(프로젝트 정책):
 *   - store(또는 listConcepts) 미주입 = 503(정직한 비활성). 빈 배열로 가리지 않는다 —
 *     데이터 통로가 없는 것과 후보가 0건인 것은 다른 사실이다.
 *   - 후보가 진짜 0건이면 빈 배열(가짜 항목 0 · 정직한 빈 상태). 새 태그를 끝까지 친
 *     사용자는 추천을 못 받는 게 맞는 동작이라, 빈 목록이 정답이다.
 */

import { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";

/** 추천 후보 한 건 — 개념 이름 + 합산 usage_count(자주 쓴 태그 표지). */
interface TagSuggestion {
  name: string;
  count: number;
}

/**
 * 접두 일치 필터(서버 통로·?prefix 용). 클라 filterSuggestions 와 같은 규칙 —
 * 공백 제거 후 startsWith 비교. 빈 접두(공백만/부재)면 전체 통과(거르지 않는다).
 * 대소문자는 listConcepts 가 소문자 name 을 들고 있어 그대로 비교한다(개념 name UNIQUE
 * 가 소문자 정규화 — findConceptByName 정합).
 */
function filterByPrefix(suggestions: TagSuggestion[], prefix: string): TagSuggestion[] {
  const needle = prefix.trim();
  if (needle.length === 0) return suggestions;
  return suggestions.filter((s) => s.name.startsWith(needle));
}

export function registerTagSuggestRoutes(app: Hono, deps: MemoryApiDeps): void {
  const api = new Hono({ strict: false });

  // store(listConcepts 보유)가 있어야 가동한다. deps.store 는 타입상 항상 있으나, 가드
  // 자체가 silent fallback 금지 보장으로 존재한다 — 미주입이면 빈 목록으로 가리지 않고 503
  // (entity-types 라우트 registryReady 게이트 양식 미러).
  const storeReady = (): boolean =>
    deps.store !== undefined && typeof deps.store.listConcepts === "function";

  // ── GET /tag-suggest — 저장된 개념을 추천 후보로 회신 ────────────────────
  api.get("/tag-suggest", async (c) => {
    if (!storeReady()) {
      return err(c, 503, "tag-suggest 비활성 — store(listConcepts) 미주입");
    }

    const concepts = await deps.store.listConcepts();
    // usage_count 는 두 칸 합 — 태그 사용 + 분류 사용 모두 "자주 쓴" 신호다. listConcepts
    // 정렬(tag DESC, classification DESC)을 그대로 보존하려고 재정렬하지 않는다.
    const tags: TagSuggestion[] = concepts.map((cpt) => ({
      name: cpt.name,
      count: cpt.tagUsageCount + cpt.classificationUsageCount,
    }));

    // ?prefix 직접 호출 통로 — 부재·공백이면 전체 회신(클라 위젯은 이 통로를 안 쓰고
    // 로컬 filterSuggestions 로 거른다). 후보 0건이면 빈 배열 그대로(정직한 빈 상태).
    const prefix = c.req.query("prefix") ?? "";
    return c.json({ tags: filterByPrefix(tags, prefix) });
  });

  app.route("/api", api);
}
