/**
 * store-internal/node-repository.ts — 노드 CRUD 전담 클래스.
 *
 * SqliteMemoryStore 에서 노드 14개 메서드를 추출. facade 가 위임 호출.
 * 구현부(SQL·로직)는 옛 store.ts 와 100% 동일 — 동작 변경 0.
 *
 * emit 보존: addNode → 'raw-memory-added', deleteNode → 'node-deleted',
 * updateNodeImportance → 'node-edited'. trigger 는 setter 로 주입.
 *
 * P3 G5-a 분해(2026-07-03): 옛 단일 node-repository.ts(1058줄)를 책임별 mixin
 * 으로 나눴다(store.ts C2/store 분해 선례 답습). 필드·생성자·trigger/db_revision
 * 인프라는 NodeRepoBase 한 곳에 모으고, 메서드는 저장(멱등·배치 — ingest)·
 * 수정삭제(lifecycle)·메타 칸(meta)·조회/후보 선별(read) 네 mixin 으로 옮겼다.
 * 공개 export(NodeRepository 클래스)와 생성자 시그니처 `(db, embedder)`, 모든
 * 공개 메서드 시그니처는 한 글자도 안 바뀐다. 옛 private 필드(autoCleanupTrigger·
 * dbRevision)는 mixin 이 `this` 로 읽고 쓰도록 가시성만 넓어졌다(런타임 동작
 * 동일 — store/base.ts StoreInternals 가시성 확대 선례).
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import { NodeRepoBase } from "./node-repo-base.ts";
import { NodeRepoIngestMixin } from "./node-repo-ingest-mixin.ts";
import { NodeRepoLifecycleMixin } from "./node-repo-lifecycle-mixin.ts";
import { NodeRepoMetaMixin } from "./node-repo-meta-mixin.ts";
import { NodeRepoReadMixin } from "./node-repo-read-mixin.ts";

// ── Class ───────────────────────────────────────────────────────────────
//
// mixin 합성 순서는 동작에 영향 없다(메서드 이름 겹침 0 — 각 mixin 이 서로 다른
// 메서드 표면만 보유하고, 상호 호출은 같은 mixin 안에서만 일어난다). NodeRepoBase
// 가 필드·생성자·변동 카운터 인프라를 보유하고, 각 mixin 이 그 위에 책임별
// 메서드를 얹는다.

const NodeRepoComposed = NodeRepoReadMixin(
  NodeRepoMetaMixin(NodeRepoLifecycleMixin(NodeRepoIngestMixin(NodeRepoBase))),
);

export class NodeRepository extends NodeRepoComposed {
  // 생성자 시그니처를 옛 그대로 재선언한다 — mixin 합성 클래스의 생성자 타입은
  // `(...args: any[])` 로 넓어지므로, 호출처 `new NodeRepository(db, embedder)` 의
  // 엄격한 인자 타입 검사를 보존하기 위한 재선언이다.
  constructor(db: Database, embedder: Embedder) {
    super(db, embedder);
  }
}
