/**
 * store-internal/concept-repo-base.ts — ConceptRepository 의 필드·생성자 토대
 * (P3 G5-a 분해 — 옛 concept-repository.ts 에서 이동, 내용 무변경).
 *
 * 옛 단일 concept-repository.ts(804줄)를 책임별 mixin 으로 나누되, 생성자
 * 시그니처 `(db, embedder, onConceptChange?)` 는 이 base 한 곳에 모은다.
 * mixin 들이 `this.db`·`this.embedder`·`this.onConceptChange` 를 구조적으로
 * 읽도록 ConceptRepoInternals 인터페이스로 필드 타입을 노출하고, base 가 그
 * 인터페이스를 만족한다. 옛 private 필드의 가시성 확대일 뿐 런타임 동작 동일
 * (store/base.ts StoreInternals 선례).
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";

/**
 * mixin 생성자 제약용 헬퍼 — `<TBase extends Constructor<ConceptRepoInternals>>`
 * 형태로 각 mixin 이 base 의 필드를 구조적으로 읽을 수 있게 한다(store/base.ts
 * Constructor 선례와 동형 — store-internal 이 db/store 를 역참조하지 않도록
 * 여기 별도 선언).
 */
export type Constructor<T = object> = new (...args: any[]) => T;

/** mixin 이 `this` 로 접근하는 필드 표면. base 가 이 인터페이스를 만족한다. */
export interface ConceptRepoInternals {
  readonly db: Database;
  readonly embedder: Embedder;
  readonly onConceptChange?: () => void;
}

/** 필드·생성자를 보관하는 토대 클래스. mixin 들이 이 클래스를 감싼다. */
export class ConceptRepoBase implements ConceptRepoInternals {
  /**
   * 개념 데이터가 바뀌었을 때(별칭 합류 — mergeConceptAlias) 호출하는 콜백.
   * facade(SqliteMemoryStore)가 NodeRepository 의 db_revision 카운터를 한 칸
   * 올리도록 주입한다(setAutoCleanupTrigger 와 같은 wiring 선례). 미주입이면
   * 호출 안 함 — 캐시 무효화 신호 없이도 합류 자체는 동작(외부 호출자·테스트 호환).
   * 검색 캐시(R4)는 db_revision 을 키에 넣으므로, 합류 후 같은 query 는 캐시 키가
   * 달라져 자연히 miss 가 된다(spec 10.2.4 — 옛 결과 재사용 차단).
   */
  constructor(
    readonly db: Database,
    readonly embedder: Embedder,
    readonly onConceptChange?: () => void,
  ) {}
}
