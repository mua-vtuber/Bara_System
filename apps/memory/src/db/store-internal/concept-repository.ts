/**
 * store-internal/concept-repository.ts — 개념 노드 전담 클래스 (1.0b 재작성).
 *
 * concept_nodes + node_concept_edges 직접 CRUD. 옛 is_concept=1 양식과
 * NodeRepository bridge 패턴을 폐기. 개념 id 는 'cpt_' + crypto.randomUUID().
 *
 * 같은 이름 = 같은 노드(name UNIQUE) — findOrCreate* 가 옛 노드 발견 시
 * 역할 속성만 추가하고 새 노드를 만들지 않는다.
 *
 * P3 G5-a 분해(2026-07-03): 옛 단일 concept-repository.ts(804줄)를 책임별 mixin
 * 으로 나눴다(store.ts C2/store 분해 선례 답습). 필드·생성자는 ConceptRepoBase
 * 한 곳에 모으고, 메서드는 별칭 추가·합류(alias-merge)·별칭 후보 적재·게이트
 * (suggestion)·개념 CRUD + 글→개념 엣지(crud) 세 mixin 으로 옮겼다. 공개 export
 * 3개(ConceptRoleFlags·AliasSuggestion 타입 재노출·ConceptRepository 클래스)와
 * 생성자 시그니처 `(db, embedder, onConceptChange?)`, 모든 공개 메서드 시그니처는
 * 한 글자도 안 바뀐다. 옛 private 헬퍼(newConceptId·newSuggestionId·
 * upsertConceptVec·detectAndSaveAliasSuggestions·appendAliasAndRebuildVec·
 * repointConceptInFkZeroTables·collectAttributeLabelConceptIds)는 mixin 분해 제약
 * (익명 class 표현식은 private/protected 멤버 불가 — TS4094)으로 가시성만
 * 넓어졌다(런타임 동작 동일 — store/base.ts StoreInternals 가시성 확대 선례).
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import { ConceptRepoBase } from "./concept-repo-base.ts";
import { ConceptAliasMergeMixin } from "./concept-repo-alias-merge-mixin.ts";
import { ConceptSuggestionMixin } from "./concept-repo-suggestion-mixin.ts";
import { ConceptCrudMixin } from "./concept-repo-crud-mixin.ts";

// ── Public re-exports (호출자가 from "./concept-repository.ts" 로 가져올 수 있도록) ──
export type { ConceptRoleFlags } from "./concept-repo-crud-mixin.ts";
export type { AliasSuggestion } from "./concept-repo-suggestion-mixin.ts";

// ── Class ───────────────────────────────────────────────────────────────
//
// mixin 합성 순서는 표면 의존을 따른다(메서드 이름 겹침 0): suggestion mixin 이
// alias-merge 표면(findSimilarConcepts·mergeConceptAlias)을, crud mixin 이
// suggestion 표면(detectAndSaveAliasSuggestions)을 `this` 로 호출하므로
// alias-merge → suggestion → crud 순으로 감싼다. ConceptRepoBase 가 필드·생성자를
// 보유하고, 각 mixin 이 그 위에 책임별 메서드를 얹는다.

const ConceptRepoComposed = ConceptCrudMixin(
  ConceptSuggestionMixin(ConceptAliasMergeMixin(ConceptRepoBase)),
);

export class ConceptRepository extends ConceptRepoComposed {
  // 생성자 시그니처를 옛 그대로 재선언한다 — mixin 합성 클래스의 생성자 타입은
  // `(...args: any[])` 로 넓어지므로, 호출처 `new ConceptRepository(db, embedder,
  // onConceptChange?)` 의 엄격한 인자 타입 검사를 보존하기 위한 재선언이다.
  // 생성자 doc(onConceptChange 콜백 의미)은 ConceptRepoBase 참조.
  constructor(db: Database, embedder: Embedder, onConceptChange?: () => void) {
    super(db, embedder, onConceptChange);
  }
}
