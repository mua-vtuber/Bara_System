/**
 * SqliteMemoryStore — the authoritative MemoryStore implementation.
 *
 * Pairs a bun:sqlite database (created by `openMemoryDatabase`) with an
 * `Embedder` (production: `Bgem3Embedder`) so callers can `addNode(...)` a
 * piece of content and get back an integer id, with the embedding routed
 * into the `vec_nodes` virtual table behind the scenes.
 *
 * Port of backend/app/repositories/memory_store.py limited to the Phase 1
 * surface: knowledge_nodes CRUD, FTS5 search, vec0 KNN, knowledge_edges +
 * BFS graph traversal, and mention/touch bookkeeping. Entity profiles,
 * sentiment history, consolidation log, and sessions land with their
 * consumers.
 *
 * 모든 메서드는 store-internal 의 repository 들로 위임하는 얇은 facade 다. 생성자
 * 외에 this.db 직접 호출은 두 곳뿐(addImageCaption 의 images 갱신·setPlace 의
 * setPlaceFlow 의존 주입).
 *
 * C2/store 분해(2026-06-27): 옛 단일 store.ts(1622줄)의 평평한 위임 표를 책임별
 * mixin 으로 나눴다. 필드·생성자·핵심 인프라(addNode·getRawDb·getDbRevision·
 * setAutoCleanupTrigger)는 StoreBase 한 곳에 모으고, 위임 메서드는 개념·사람·
 * 프로젝트엔티티·노드·검색·엣지·통계자산 일곱 mixin 으로 옮겼다. 공개 export 4개
 * (sanitizeFtsQuery 재노출·MENTION_BOOST/MAX_IMPORTANCE 재노출·AddNodeArgs/FtsHit/
 * VectorHit 타입 재노출·SqliteMemoryStore 클래스)와 생성자 시그니처 `(db, embedder)`,
 * 모든 공개 메서드 시그니처는 한 글자도 안 바뀐다. 동작은 옛 store.ts 와 동일하다.
 */

import type { MemoryStore } from "../memory/types.ts";
import { StoreBase } from "./store/base.ts";
import { ConceptMixin } from "./store/concept-mixin.ts";
import { PersonMixin } from "./store/person-mixin.ts";
import { ProjectEntityMixin } from "./store/project-entity-mixin.ts";
import { NodeMixin } from "./store/node-mixin.ts";
import { SearchMixin } from "./store/search-mixin.ts";
import { EdgeMixin } from "./store/edge-mixin.ts";
import { StatsAssetMixin } from "./store/stats-asset-mixin.ts";

// ── Public re-exports (호출자가 from "./store.ts" 로 가져올 수 있도록) ───
export { sanitizeFtsQuery } from "./store-internal/fts.ts";
export { MENTION_BOOST, MAX_IMPORTANCE } from "./store-internal/constants.ts";
export type {
  AddNodeArgs,
  EditNodeContentArgs,
  EditNodeContentResult,
  FtsHit,
  VectorHit,
} from "./store-internal/args-types.ts";

// ── Class ───────────────────────────────────────────────────────────────
//
// mixin 합성 순서는 동작에 영향 없다(메서드 이름 겹침 0 — 각 mixin 이 서로 다른
// repo 표면만 위임). StoreBase 가 모든 repo 필드와 생성자를 보유하고, 각 mixin 이
// 그 위에 책임별 위임 메서드를 얹는다. `implements MemoryStore` 로 계약 충족을
// 컴파일 시점에 검증한다(소비처 170+ 타입 동일 보장).

const StoreComposed = StatsAssetMixin(
  EdgeMixin(
    SearchMixin(
      NodeMixin(
        ProjectEntityMixin(PersonMixin(ConceptMixin(StoreBase))),
      ),
    ),
  ),
);

export class SqliteMemoryStore extends StoreComposed implements MemoryStore {}
