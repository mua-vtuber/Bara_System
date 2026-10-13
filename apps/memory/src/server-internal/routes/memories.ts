/**
 * server-internal/routes/memories.ts — /memories 계열 라우트 등록기 (파사드).
 *
 * POST /memories, GET /memories, GET /memories/:id, GET /memories/:id/revisions,
 * PATCH /memories/:id, POST /memories/:id/tags, POST /memories/:id/append,
 * DELETE /memories/by-source, DELETE /memories/:id, POST /memories/from-text
 * 열 라우트를 한 함수로 묶는다.
 *
 * P3 G5-a 분할(docs/decisions/2026-07-03-structure-cleanup-spec.md) — 옛 852줄
 * 단일 파일을 책임 경계로 나눴다. 이 파일은 하위 등록기를 옛 등록 순서 그대로
 * 부르는 파사드로 남고(export registerMemoriesRoutes 이름 그대로), 저장·조회는
 * memories-crud.ts, 수동 편집·태그는 memories-edit.ts, 덧붙이기는
 * memories-append.ts, 삭제는 memories-delete.ts, LLM 추출 통로는
 * memories-from-text.ts, 공용 헬퍼는 memories-shared.ts 가 진다. 동작 불변.
 *
 * 절대 제약:
 *   1. 등록 순서 — DELETE /memories/by-source 가 DELETE /memories/:id 보다
 *      먼저 와야 한다. Hono 는 등록 순서대로 매칭하므로 `:id` 가 먼저면
 *      "by-source" 를 id 로 받아 400 으로 떨어진다. 두 DELETE 는
 *      memories-delete.ts 한 함수 안에 순서 고정으로 있고, 아래 하위 등록기
 *      호출 순서는 옛 파일의 라우트 등록 순서를 그대로 보존한다.
 *   2. deps 동적 lookup — autoCleanupTrigger / getSettings / extractor 는
 *      createMemoryApi 의 setAutoCleanupTrigger 가 나중에 mutate 한다.
 *      구조분해로 미리 꺼내면 부팅 시점 undefined 가 고정된다.
 *      반드시 호출 시점에 deps.xxx 로 접근한다(하위 등록기 공통 규율).
 */

import type { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { registerMemoriesCrudRoutes } from "./memories-crud.ts";
import { registerMemoriesEditRoutes } from "./memories-edit.ts";
import { registerMemoriesAppendRoutes } from "./memories-append.ts";
import { registerMemoriesDeleteRoutes } from "./memories-delete.ts";
import { registerMemoriesFromTextRoutes } from "./memories-from-text.ts";

/**
 * /memories 계열 열 라우트를 app 에 등록한다.
 *
 * deps 객체 자체를 받는다 (구조분해 금지).
 * autoCleanupTrigger / getSettings / extractor 는 createMemoryApi 가
 * 나중에 mutate 하므로 핸들러 안에서 호출 시점에 deps.xxx 로 lookup.
 * store 같은 부팅 시점 고정 의존만 구조분해 허용.
 */
export function registerMemoriesRoutes(app: Hono, deps: MemoryApiDeps): void {
  // 하위 등록기 호출 순서 = 옛 단일 파일의 라우트 등록 순서(메서드별 상대 순서 보존).
  registerMemoriesCrudRoutes(app, deps);
  registerMemoriesEditRoutes(app, deps);
  registerMemoriesAppendRoutes(app, deps);
  registerMemoriesDeleteRoutes(app, deps);
  registerMemoriesFromTextRoutes(app, deps);
}
