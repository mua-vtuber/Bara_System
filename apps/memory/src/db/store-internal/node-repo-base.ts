/**
 * store-internal/node-repo-base.ts — NodeRepository 의 필드·생성자 토대
 * (P3 G5-a 분해 — 옛 node-repository.ts 에서 이동, 내용 무변경).
 *
 * 옛 단일 node-repository.ts(1058줄)를 책임별 mixin 으로 나누되, 생성자 시그니처
 * `(db, embedder)` 와 trigger·db_revision 인프라(setAutoCleanupTrigger·
 * getDbRevision·bumpDbRevision)는 이 base 한 곳에 모은다. mixin 들이
 * `this.db`·`this.embedder`·`this.dbRevision`·`this.autoCleanupTrigger` 를
 * 구조적으로 읽고 쓰도록 NodeRepoInternals 인터페이스로 필드 타입을 노출하고,
 * base 가 그 인터페이스를 만족한다. 옛 private 필드의 가시성 확대일 뿐 런타임
 * 동작 동일(store/base.ts StoreInternals 선례).
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import type { AutoCleanupTriggerHandle } from "../../memory/auto-cleanup-trigger.ts";
import type { AssetFileRemover } from "../../assets/released-asset-files.ts";
import { NodeAbsorption } from "./node-absorption.ts";
import { NodeSourceRepository } from "./node-source-repository.ts";

/**
 * mixin 생성자 제약용 헬퍼 — `<TBase extends Constructor<NodeRepoInternals>>`
 * 형태로 각 mixin 이 base 의 필드를 구조적으로 읽을 수 있게 한다(store/base.ts
 * Constructor 선례와 동형 — store-internal 이 db/store 를 역참조하지 않도록
 * 여기 별도 선언).
 */
export type Constructor<T = object> = new (...args: any[]) => T;

/**
 * mixin 이 `this` 로 접근하는 필드 표면. dbRevision 은 mixin 의 데이터 변동
 * 지점들이 `this.dbRevision += 1` 로 직접 올리므로 쓰기 가능해야 한다.
 */
export interface NodeRepoInternals {
  readonly db: Database;
  readonly embedder: Embedder;
  /** WP-B1-20T — 기억 노드 출처 목록 표(memory_node_sources) 저장소. */
  readonly nodeSources: NodeSourceRepository;
  /** WP-B1-20T — 저장·흡수 한 번의 출처 기록과 계보 연결 규칙(node-absorption.ts). */
  readonly absorption: NodeAbsorption;
  autoCleanupTrigger: AutoCleanupTriggerHandle | undefined;
  /** WP-B1-20U 설계 17.17 — 영구 삭제 커밋 뒤 같은 잠금 안에서 부르는 첨부 파일 지우기 함수. 미주입이면 failed 로 알린다. */
  assetFileRemover: AssetFileRemover | undefined;
  dbRevision: number;
}

/** 필드·생성자·변동 카운터 인프라를 보관하는 토대 클래스. mixin 들이 감싼다. */
export class NodeRepoBase implements NodeRepoInternals {
  autoCleanupTrigger: AutoCleanupTriggerHandle | undefined;
  assetFileRemover: AssetFileRemover | undefined;

  /**
   * Phase 6b T3 (R4) — 노드 데이터 변동 카운터. addNode / deleteNode /
   * deleteBySource / updateNodeImportance 가 한 번씩 올린다. search 라우트가
   * 이 값을 검색 캐시 키에 넣어, 데이터가 바뀐 직후의 같은 query 는 캐시 키가
   * 달라져 자연히 miss 가 된다(spec 10.2.4 — 옛 결과 재사용 차단).
   *
   * 단조 증가만 한다(절대값 의미 없음 — 변했는지만 본다). autoCleanupTrigger
   * emit 과 같은 지점에서 올려 새 신호 메커니즘을 만들지 않는다(기존 선례 합류).
   */
  dbRevision = 0;

  readonly nodeSources: NodeSourceRepository;
  readonly absorption: NodeAbsorption;

  constructor(
    readonly db: Database,
    readonly embedder: Embedder,
  ) {
    this.nodeSources = new NodeSourceRepository(db);
    this.absorption = new NodeAbsorption(db);
  }

  setAutoCleanupTrigger(trigger: AutoCleanupTriggerHandle | undefined): void {
    this.autoCleanupTrigger = trigger;
  }

  /** WP-B1-20U 설계 17.17 D31 — 부팅 때 한 번 주입(store.setAssetFileRemover 가 넘긴다). */
  setAssetFileRemover(remover: AssetFileRemover): void {
    this.assetFileRemover = remover;
  }

  /** Phase 6b T3 — 현재 데이터 변동 카운터. search 라우트 캐시 키 합류용. */
  getDbRevision(): number {
    return this.dbRevision;
  }

  /**
   * Phase 6b T9 — 노드 외 데이터 변동(개념 별칭 합류 등)도 이 한 카운터를 올려
   * 검색 캐시를 무효화하도록 공개한 bump 통로. facade 가 ConceptRepository 의
   * onConceptChange 콜백으로 이 메서드를 주입한다 — 새 신호 메커니즘을 만들지
   * 않고 기존 db_revision 카운터에 합류시킨다(T3 선례). 단조 증가만 한다.
   */
  bumpDbRevision(): void {
    this.dbRevision += 1;
  }
}
