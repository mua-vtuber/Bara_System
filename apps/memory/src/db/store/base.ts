/**
 * StoreBase — SqliteMemoryStore 의 필드·생성자 토대(facade 분해 C2/store).
 *
 * 옛 단일 store.ts(1622줄)의 평평한 위임 표를 책임별 mixin 으로 나누되, 모든
 * repository 인스턴스화와 생성자 시그니처 `(db, embedder)` 는 이 base 한 곳에 모은다.
 * mixin 들이 `this.nodeRepo` 같은 repo 를 구조적으로 읽도록 StoreInternals 인터페이스로
 * 필드 타입을 노출하고, base 가 그 인터페이스를 만족한다. 동작은 옛 store.ts 와 동일 —
 * repo 생성 순서·주입 인자·bumpDbRevision 연결까지 한 줄도 의미 변경 없다.
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import type { AutoCleanupTriggerHandle } from "../../memory/auto-cleanup-trigger.ts";
import type { AssetFileRemover } from "../../assets/released-asset-files.ts";
import type { AddNodeArgs, AddNodeResult } from "../store-internal/args-types.ts";
import { NodeRepository } from "../store-internal/node-repository.ts";
import { ConceptRepository } from "../store-internal/concept-repository.ts";
import { PersonRepository } from "../store-internal/person-repository.ts";
import { ProjectRepository } from "../store-internal/project-repository.ts";
import { EntityConceptEdgeRepository } from "../store-internal/entity-concept-edge-repository.ts";
import { EntityRelationEdgeRepository } from "../store-internal/entity-relation-edge-repository.ts";
import { EntityTypeRegistryDb } from "../store-internal/entity-type-registry-db.ts";
import { EntitiesRepository } from "../store-internal/entities-repository.ts";
import { EdgeRepository } from "../store-internal/edge-repository.ts";
import { HierarchyEdgeRepository } from "../store-internal/hierarchy-edge-repository.ts";
import { SearchRepository } from "../store-internal/search-repository.ts";
import { RevisionRepository } from "../store-internal/revision-repository.ts";
import { StatsRepository } from "../store-internal/stats-repository.ts";
import { AssetRepository } from "../store-internal/asset-repository.ts";
import { DocumentRepository } from "../store-internal/document-repository.ts";
import { SummaryRepository } from "../store-internal/summary-repository.ts";
import {
  DocumentGraphRepository,
  type AddDocumentGraphArgs,
  type AddDocumentGraphResult,
} from "../store-internal/document-graph-repository.ts";

/**
 * mixin 생성자 제약용 헬퍼 — `<TBase extends Constructor<StoreInternals>>` 형태로
 * 각 mixin 이 base 의 repo 필드를 구조적으로 읽을 수 있게 한다.
 */
export type Constructor<T = object> = new (...args: any[]) => T;

/**
 * mixin 이 `this` 로 접근하는 repo·핸들 표면. base 가 이 인터페이스를 만족하므로
 * 각 mixin 은 `this.nodeRepo` 등을 타입 안전하게 위임 호출한다. 옛 store.ts 의
 * private/readonly 필드를 mixin 분해를 위해 public 표면으로 노출한 것이며(가시성
 * 확대일 뿐 런타임 동작 동일), cleanup-helpers 의 `(store as {db}).db` 우회와
 * server.ts 의 `store.entityTypeRegistryDb`·테스트의 `store.entitiesRepo` 접근을
 * 그대로 만족한다.
 */
export interface StoreInternals {
  readonly db: Database;
  readonly embedder: Embedder;
  readonly nodeRepo: NodeRepository;
  readonly conceptRepo: ConceptRepository;
  readonly personRepo: PersonRepository;
  readonly projectRepo: ProjectRepository;
  readonly entityConceptEdgeRepo: EntityConceptEdgeRepository;
  readonly entityRelationEdgeRepo: EntityRelationEdgeRepository;
  readonly entityTypeRegistryDb: EntityTypeRegistryDb;
  readonly entitiesRepo: EntitiesRepository;
  readonly edgeRepo: EdgeRepository;
  readonly hierarchyEdgeRepo: HierarchyEdgeRepository;
  readonly searchRepo: SearchRepository;
  readonly revisionRepo: RevisionRepository;
  readonly statsRepo: StatsRepository;
  readonly assetRepo: AssetRepository;
  readonly documentRepo: DocumentRepository;
  readonly summaryRepo: SummaryRepository;
  readonly documentGraphRepo: DocumentGraphRepository;
}

/**
 * 모든 repository 를 만들고 보관하는 토대 클래스. mixin 들이 이 클래스를 감싼다.
 */
export class StoreBase implements StoreInternals {
  readonly nodeRepo: NodeRepository;
  readonly conceptRepo: ConceptRepository;
  readonly personRepo: PersonRepository;
  readonly projectRepo: ProjectRepository;
  readonly entityConceptEdgeRepo: EntityConceptEdgeRepository;
  readonly entityRelationEdgeRepo: EntityRelationEdgeRepository;
  /**
   * 종류 명부 DB repo(분류 단계3) — 사용자가 화면으로 더한 새 종류(entity_types)의
   * 존재·표시명·접두사 단일 출처. server 부팅이 listUserEntityTypes 로 동적 명부를
   * 주입하고, 배치 통로(entity-placement-loop)가 isUserEntityType 으로 새 종류를
   * 가른다. 외부가 같은 db 로 또 인스턴스를 만들지 않도록 public readonly 로 노출한다.
   */
  readonly entityTypeRegistryDb: EntityTypeRegistryDb;
  /**
   * 범용 본체 repo(분류 단계3) — 새 종류 엔티티만 entities·entity_attributes 에
   * 저장·색인한다. 배치 통로(entity-placement-loop)가 새 종류 행 생성·칸/라벨 저장·
   * 임베딩에 쓴다. embedder 단일 출처가 흘러 들어와 차원 하드코딩 0.
   */
  readonly entitiesRepo: EntitiesRepository;
  readonly edgeRepo: EdgeRepository;
  readonly hierarchyEdgeRepo: HierarchyEdgeRepository;
  readonly searchRepo: SearchRepository;
  readonly revisionRepo: RevisionRepository;
  readonly statsRepo: StatsRepository;
  readonly assetRepo: AssetRepository;
  readonly documentRepo: DocumentRepository;
  readonly summaryRepo: SummaryRepository;
  /**
   * 문서 그래프 원자 쓰기 repo(2026-07-18 배치화) — 문서 노드 1 + 청크 노드 N +
   * parent_of 엣지 N + chunk_count 를 embedBatch 1회 + 단일 트랜잭션으로 넣는다.
   * 노드·문서 repo 를 가로지르는 트랜잭션이라 두 repo 를 주입받는 합성 repo 다
   * (ProjectRepository 가 entitiesRepo 를 받는 선례와 동형). 계보 엣지는 노드 repo 의
   * 흡수 규칙이 쓴다(WP-B1-20T).
   */
  readonly documentGraphRepo: DocumentGraphRepository;

  /**
   * db 핸들은 facade 메서드 안에서는 직접 안 읽힌다(모든 SQL 은 repository 가 처리).
   * 다만 cleanup-helpers.ts 의 getDb(store) 가 이 프로퍼티를 런타임 우회 접근(Phase
   * 5.6 W5 한 번성 중복 정리 통로)하므로 프로퍼티 자체는 보존한다. embedder 는 범용
   * 본체 repo(EntitiesRepository·분류 단계3)가 새 종류 임베딩에 쓰므로 생성자에서 그
   * repo 에 흘려 보낸다.
   */
  constructor(
    readonly db: Database,
    readonly embedder: Embedder,
  ) {
    this.nodeRepo = new NodeRepository(db, embedder);
    // 개념 별칭 합류(mergeConceptAlias)도 노드 CRUD 와 같은 db_revision 카운터를
    // 올려 검색 캐시를 무효화한다(T3 선례 합류 — 새 신호 메커니즘 안 만듦).
    this.conceptRepo = new ConceptRepository(db, embedder, () =>
      this.nodeRepo.bumpDbRevision(),
    );
    this.personRepo = new PersonRepository(db, embedder);
    // 분류 단계3 — 종류 명부 DB repo(db 주입) + 범용 본체 repo(db·embedder·registry
    // 주입). registry 가 새 종류 여부·접두사를 판정하고, entitiesRepo 가 그 종류만
    // entities 본체에 저장한다. embedder 단일 출처가 여기서 entitiesRepo 로 흘러
    // 들어가 새 종류 임베딩 차원이 글 모델과 자동 연동된다(하드코딩 0).
    // entitiesRepo 를 projectRepo 보다 먼저 만든다 — 단계4 T7'b 에서 프로젝트 본체가
    // entities(type_name='project')로 통합돼 projectRepo 가 entitiesRepo 에 위임한다.
    this.entityTypeRegistryDb = new EntityTypeRegistryDb(db);
    this.entitiesRepo = new EntitiesRepository(db, embedder, this.entityTypeRegistryDb);
    // 분류 단계4 T7'b — 프로젝트 본체가 전용 projects 테이블에서 범용 entities 로 옮겨져
    // projectRepo 가 entitiesRepo 에 정체성·임베딩을 위임한다. 사람만 별칭 칸·external_refs
    // 구조가 달라 전용 repository(personRepo)를 그대로 유지한다(단계4 person 무변경).
    this.projectRepo = new ProjectRepository(db, this.entitiesRepo);
    this.entityConceptEdgeRepo = new EntityConceptEdgeRepository(db);
    this.entityRelationEdgeRepo = new EntityRelationEdgeRepository(db);
    this.edgeRepo = new EdgeRepository(db);
    this.hierarchyEdgeRepo = new HierarchyEdgeRepository(db);
    this.searchRepo = new SearchRepository(db, embedder);
    this.revisionRepo = new RevisionRepository(db);
    this.statsRepo = new StatsRepository(db, embedder);
    this.assetRepo = new AssetRepository(db);
    this.documentRepo = new DocumentRepository(db);
    this.summaryRepo = new SummaryRepository(db, embedder);
    // 의존 repo(nodeRepo·documentRepo) 생성이 모두 끝난 뒤 마지막에 합성. 청크 → 문서 계보
    // 엣지는 nodeRepo 의 흡수 규칙(node-absorption.ts)이 청크 INSERT 와 함께 쓴다(WP-B1-20T).
    this.documentGraphRepo = new DocumentGraphRepository(
      db,
      embedder,
      this.nodeRepo,
      this.documentRepo,
    );
  }

  /**
   * Phase 5.7.3 W3 — trigger handle 주입. index.ts 가 store 생성 + trigger
   * 작성 두 단계 거친 후 한 줄 호출한다. 생성자 인자로 받는 흐름은 옛
   * SqliteMemoryStore 인스턴스화 호출처 (테스트 + 통합) 모두 갱신 부담이라
   * setter 흐름 — trigger 가 store 에 의존하는데 store 도 trigger 에
   * 의존해서 순환이 일어난다.
   *
   * 실제 emit 은 노드 CRUD (addNode / deleteNode / updateNodeImportance) 가
   * 담당하므로 trigger 는 NodeRepository 로 전달한다.
   */
  setAutoCleanupTrigger(trigger: AutoCleanupTriggerHandle | undefined): void {
    this.nodeRepo.setAutoCleanupTrigger(trigger);
  }

  /**
   * WP-B1-20U 설계 17.17 D31 — 첨부 파일 지우기 함수 주입. createMemoryApi 가 부팅 때 한 번 부른다
   * (setAutoCleanupTrigger 선례). 영구 삭제하는 저장소 메서드가 쓰기 잠금 안 커밋 뒤 이 함수를 스스로 부르므로
   * 라우트·cron 은 따로 할 일이 없다. 넣지 않은 저장소는 파일을 지우지 않고 assetCleanup.failed 로 알린다.
   */
  setAssetFileRemover(remover: AssetFileRemover): void {
    this.nodeRepo.setAssetFileRemover(remover);
  }

  /**
   * Phase 6b T3 (R4) — 노드 데이터 변동 카운터. addNode / deleteNode /
   * deleteBySource / updateNodeImportance 가 한 번씩 올린다(autoCleanupTrigger
   * emit 과 같은 지점). search 라우트가 이 값을 검색 캐시 키에 넣어, 데이터가
   * 바뀐 직후의 같은 query 는 캐시 키가 달라져 자연히 miss 가 된다(spec 10.2.4 —
   * 옛 결과 재사용 차단 / silent fallback 금지). 단조 증가만 한다.
   */
  getDbRevision(): number {
    return this.nodeRepo.getDbRevision();
  }

  /**
   * Phase 11a T5 — 코어 함수가 raw `Database` 핸들을 명시 의존으로 받게 하는 공식
   * 통로. `addImageAssetNode` / `ingestImage` 처럼 한 트랜잭션 안에서 여러 테이블
   * (knowledge_nodes + image_vec + asset_files + asset_file_imports + images)
   * 을 한 번에 다루는 흐름은 store facade 의 작은 단위 메서드 조합으로는 트랜잭션
   * 정합을 보장하기 어렵다 — db 핸들을 명시 의존으로 받는다.
   *
   * cleanup-helpers 의 `getDb(store as unknown as {db}).db` 우회 cast 가 같은
   * 필요에서 출발했으므로 공식 accessor 로 승격해 cast 통로를 줄인다 — 후속 정리
   * 시점에 cleanup-helpers 의 cast 도 본 함수 호출로 통합 예정 (T5 범위 밖).
   */
  getRawDb(): Database {
    return this.db;
  }

  /**
   * Insert a new knowledge node, embed its content, and store the vector
   * in vec_nodes. Returns the new node id.
   *
   * If `args.embedding` is provided it's used directly (and validated
   * against the embedder's expected dimension); otherwise the embedder is
   * invoked here. Inserts are wrapped in a transaction so a vec_nodes
   * failure rolls back the knowledge_nodes row.
   */
  async addNode(args: AddNodeArgs): Promise<number> {
    return this.nodeRepo.addNode(args);
  }

  /**
   * P0-A 입력 멱등성 — `addNode` 와 같되 정확-중복(정규화 content_hash 일치)이면
   * 기존 노드를 재사용하고 재사용 여부(`reused`)까지 반환한다. cacheHit 을 응답에
   * 실어야 하는 호출처(save-input 의 origin 저장·라우트)가 이 메서드를 쓴다. cacheHit
   * 을 신경 안 쓰는 호출처(atomic 자식·청크 등)는 `addNode` 그대로 — 흡수는 여전히
   * 일어난다(둘 다 nodeRepo.addNodeIdempotent 로 수렴).
   */
  async addNodeIdempotent(args: AddNodeArgs): Promise<AddNodeResult> {
    return this.nodeRepo.addNodeIdempotent(args);
  }

  /**
   * P3 G5-d — 배치 입력 통로. 같은 인자로 addNodeIdempotent 를 순차 호출한 것과
   * 의미 동일하되(흡수·document_chunk 제외·mention bump·NFC 전부 그 단일 출처에서
   * 실행), 임베딩 계산만 embedBatch 1회로 묶는다. eval 코퍼스 적재처럼 대량 항목을
   * 한 번에 넣는 호출처용. 반환 배열은 입력 순서. 판정·흡수 세부는
   * NodeRepository.addNodesBatch 주석 참조.
   */
  async addNodesBatch(
    argsList: readonly AddNodeArgs[],
  ): Promise<AddNodeResult[]> {
    return this.nodeRepo.addNodesBatch(argsList);
  }

  /**
   * 문서 그래프 원자 쓰기(2026-07-18 배치화) — 문서 노드 1 + 청크 노드 N +
   * 청크→문서 엣지 N + documents.chunk_count 를 임베딩 embedBatch 1회 계산 후
   * 단일 트랜잭션으로 넣는다. 어느 지점 실패든 문서 전체 롤백(고아 청크·엣지 0).
   * 항목별 흡수·멱등 의미론은 addNodeIdempotent 와 동일. ingestDocument 전용
   * 통로 — 세부는 DocumentGraphRepository 주석 참조.
   */
  async addDocumentGraphAtomic(
    args: AddDocumentGraphArgs,
  ): Promise<AddDocumentGraphResult> {
    return this.documentGraphRepo.addDocumentGraphAtomic(args);
  }
}
