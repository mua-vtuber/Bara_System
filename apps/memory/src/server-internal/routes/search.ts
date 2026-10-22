/**
 * server-internal/routes/search.ts — POST /search 라우트 등록기 (파사드)
 *
 * 하이브리드 검색 + 선택적 컨텍스트 조립(ContextAssembler)을 담당한다.
 * retriever / assembler 는 부팅 시점에 고정되는 의존이라 구조분해 후 사용.
 *
 * 응답 형태 (옛 server.ts 그대로 보존):
 *   { query, count, results[], context? }
 *   context 는 body.contextBudget > 0 일 때만 포함.
 *
 * MCP T4 추출(spec 4.4 HTTP 자기호출 금지) — body 검증부터 응답 조립까지의
 * 파이프라인 본체를 search-service.ts 의 runSearchPipeline 으로 옮겼다. 이 파일은
 * body JSON 파싱 + runSearchPipeline 호출 + SearchInputError→400 매핑만 남은
 * 얇은 라우트다. MCP search_memory 도구가 같은 runSearchPipeline 을 직접 호출해
 * REST 와 동작을 공유한다(HTTP 자기호출 없이).
 *
 * resolvePlaceSignal 은 search-service.ts 로 본문이 옮겨갔고, 여기서는 옛 import
 * 표면(search.test.ts 등 외부 소비처) 보존을 위해 re-export 만 한다.
 */

import type { Hono } from "hono";
import type { MemoryApiDeps, SearchBody } from "../types.ts";
import { err } from "../http-helpers.ts";
import { runSearchPipeline, SearchInputError } from "./search-service.ts";
import { ProjectScopeError } from "../../memory/project-scope-resolver.ts";

export { resolvePlaceSignal } from "./search-service.ts";

export function registerSearchRoutes(app: Hono, deps: MemoryApiDeps): void {
  // ── POST /search — 하이브리드 검색 ─────────────────────────────────────
  app.post("/search", async (c) => {
    let body: SearchBody;
    try {
      body = await c.req.json<SearchBody>();
    } catch {
      return err(c, 400, "invalid JSON body");
    }
    try {
      const response = await runSearchPipeline(
        deps,
        body,
        new URL(c.req.url).searchParams,
        // T20(spec F / 단락 11 확정 3) — 대시보드가 쓰는 사람 눈 경로라 결과
        // 하한선을 *끈* 상태로 명시한다. 낮은 점수 결과도 사람에게는 단서가
        // 되므로 화면 검색은 현행대로 전체를 표시한다. 하한선은 MCP
        // search_memory(AI 경로)만 켠다 — 이 옵션을 여기서 true 로 바꾸면
        // 대시보드 표시가 곧바로 줄어든다는 뜻이니 spec 재확인 없이 바꾸지 말 것.
        { applyResultFloor: false },
      );
      return c.json(response);
    } catch (e) {
      if (e instanceof SearchInputError) return err(c, 400, e.message);
      // 모르는·애매한 프로젝트 범위 — MCP search_memory 와 같은 code·문구로 400.
      if (e instanceof ProjectScopeError) return c.json(e.toPayload(), 400);
      throw e;
    }
  });
}
