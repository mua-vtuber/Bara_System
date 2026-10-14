/**
 * store-internal/stats-repository.ts — 통계·유지보수 메서드 모음.
 *
 * SqliteMemoryStore 에서 분리한 메서드를 담당한다:
 *   getStats, resetAllMemory, trashNodesSync·previewTrash(본체 archiveNodesSync), getArchive,
 *   prepareRestore·commitRestoreSync(복원 두 단계), purgeOldArchiveSync, getArchiveSoonToPurge,
 *   logAutoCleanupActivity, logTrashActivity, getEvolverActivity.
 *
 * resetAllMemory 트랜잭션 삭제 순서(분류 단계4 T4 이후 실제 상태 — 8 타입이 범용
 * 본체로 흡수돼 옛 per-type 테이블 나열이 사라졌다):
 *   1) 엔티티 엣지: 통합 entity_concept_edges(라벨·identity 한 테이블)
 *      + entity_relation_edges(참여자 participated_by 포함)
 *      + hierarchy_edges(위계 단일 출처 S0-T1)
 *   2) 글 엣지: node_concept_edges → node_person_edges → concept_edges
 *   3) 요약: chunk_summaries → relation_summaries
 *   4) knowledge_edges → 5) archive → 6) revisions → 7) activity
 *   8) 경계 테이블: concept_alias_suggestions · cleanup_proposal_item_journal ·
 *      cleanup_proposals · cleanup_stage_results · cleanup_runs ·
 *      entity_register_records · entity_register_ignores · document_ocr_page_results ·
 *      document_ocr_daily_usage · backfill_attempts · events · tag_reflow_log · project_vocabularies (전부 "비움" — 설계 D-1~D-5)
 *   9) 부모 본체: 범용 entities(정적 8 타입 + 새 종류) + projects + concept_nodes
 *      + persons + knowledge_nodes
 *   9b) 사용자 사전: synonym_user_entries · classify_vocab_user_entries ·
 *      classify_vocab_overrides · relation_name_user_entries · entity_types(사용자가 더한 새 종류 행만)
 *   10) 자산·문서: images → documents → asset_file_imports → asset_files
 *   11) sqlite_sequence
 * (자식 참조를 먼저 끊고 부모를 정리 — FK ON 상태에서도 안전. 명시 삭제와 CASCADE 를
 *  함께 쓴다: 본체를 비우면 entity_attributes(ON DELETE CASCADE)·FTS/vec 미러(DELETE
 *  트리거)는 따라 정리되고, 그 밖의 엣지·경계는 명시 DELETE 한다. 마지막에 sqlite_sequence
 *  를 비워 AUTOINCREMENT 카운터를 0 으로 돌린다 → 초기화 후 새 노드 id 가 1 부터 시작.)
 *
 * 분류 단계4 T4 — 정적 8 타입(work·creature…) + 새 종류가 모두 범용 본체 entities 한
 * 곳에 살고, 라벨·identity 엣지도 통합 테이블 entity_concept_edges 한 곳에 모였다.
 * 그래서 본체는 entities 한 줄, 엔티티 엣지는 entity_concept_edges 한 줄로 비운다(옛
 * <type>_concept_edges·creatures…schedules per-type 순회 불필요). 보존 대상(reset 이 비우지
 * 않는 학습 자산·메타)과 별개로, concept_nodes·persons·knowledge_nodes·hierarchy_edges·
 * entity_relation_edges·projects 는 위 순서대로 명시 나열해 비운다.
 *
 * FTS/vec 미러는 부모 DELETE 트리거가 같은 트랜잭션 안에서 자동 정리한다 — 미러를
 * 따로 DELETE 하지 않는다(설계 §4). 트리거가 빠짐없이 걸려 있는지는 §9 테스트가
 * 미러 0행을 직접 확인해 보증한다.
 *
 * 복원은 archive 에 임베딩이 없으므로 Embedder 를 주입받아 content 를 재임베딩한다. 임베딩(prepareRestore)은
 * 쓰기 잠금 밖, 보관 행 다시 읽기와 쓰기(commitRestoreSync)는 잠금 안이다 — store facade 가 둘을 잇는다
 * (WP-B1-20U 설계 17.4).
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import type {
  ArchivedNode,
  EvolverActivitySummary,
  MemoryNode,
} from "../../memory/types.ts";
import { nowKst, pastCutoffInZone, rowToNode } from "./helpers.ts";
import { STATIC_PLACEMENT_TYPE_NAMES } from "./entity-type-registry-db.ts";
import type { KnowledgeNodeRow } from "./row-types.ts";
import { readArchivePage, type ArchivePage, type ArchivePageOptions } from "./archive-page.ts";
import { NodeSourceRepository } from "./node-source-repository.ts";
import { inIdBatches, sqlPlaceholders } from "./id-batches.ts";
import { deleteRevisionsOfRemovedNodesSync } from "./revision-repository.ts";
import { planSourceRemoval, type ExplicitRemovalPolicy } from "../../memory/lineage-removal.ts";
import { SHARED_MEMORY_LINEAGE_RELATIONS } from "../../memory/shared-memory-contract.ts";
import type { AssetCleanup, AssetRelease } from "../../assets/released-asset-files.ts";
import {
  REMOVED_HOLDER_RETURNING,
  RemovedAssetHolders,
  releaseRemovedAssetsSync,
  type RemovedNodeRow,
} from "./asset-release.ts";

/** 휴지통 보관 만료 한 번의 결과(store.purgeOldArchive, WP-B1-20U 설계 17.17). */
export interface PurgeOldArchiveResult {
  /** 영구 삭제한 보관 노드 수. */
  nodesPurged: number;
  /**
   * 첨부 파일 정리 — 영구 삭제한 보관 노드가 주인이던 문서 기록, 지운 파일, 이미 없던 파일, 지우지 못한 파일(경로·원인,
   * asset_files 행은 대기로 남아 서버 시작 때 다시 지운다). 보관 노드 삭제는 이미 커밋됐다.
   */
  assetCleanup: AssetCleanup;
}

const LINEAGE_PLACEHOLDERS = sqlPlaceholders(SHARED_MEMORY_LINEAGE_RELATIONS.length);

/** 계획의 뿌리·없앨 노드·막힌 뿌리 → 휴지통 이동 결과. movedIds 는 오름차순으로 받는다. */
function trashResultOf(rootIds: number[], movedIds: number[], blockedIds: number[]): TrashNodesResult {
  const roots = new Set(rootIds);
  return { rootIds, movedIds, cascadeMovedIds: movedIds.filter((id) => !roots.has(id)), blockedIds };
}

/** 명시적 휴지통 이동 한 번(사용자 휴지통·자동 정리·중복 원문 정리)의 결과(WP-B1-20U 설계 17.3). 오름차순. */
export interface TrashNodesResult {
  /** 요청 id 중 실제로 있던 노드. */
  rootIds: number[];
  /** 옮긴 노드 전부(뿌리 포함). */
  movedIds: number[];
  /** movedIds 중 뿌리가 아닌 것 — 계보로 함께 옮긴 출처 없는 자손(selected_only 는 늘 빈 배열). */
  cascadeMovedIds: number[];
  /** selected_only 에서 고르지 않은 노드의 마지막 부모라 이번에 남긴 뿌리. */
  blockedIds: number[];
}

/** 보관 행(knowledge_nodes_archive) 한 개 — 노드 칸 + 보관 시각. */
type ArchivedNodeRow = KnowledgeNodeRow & { archived_at: string };

/** 복원 1단계(쓰기 잠금 밖) 결과 — 그때 읽은 보관 행 스냅샷과 그 본문의 임베딩(WP-B1-20U 설계 17.4). */
export interface PreparedRestore {
  readonly snapshot: ArchivedNodeRow;
  readonly vector: Float32Array;
}

/**
 * 복원을 준비하는 동안 같은 번호의 보관 행이 바뀌었을 때(본문이나 보관 시각이 다름 — 초기화 뒤 번호가 다시
 * 쓰인 경우). 준비한 임베딩이 지금 행의 본문과 맞지 않을 수 있어 아무것도 쓰지 않고 멈춘다. 라우트는 409.
 */
export class ArchivedNodeChangedError extends Error {
  constructor(readonly archivedId: number) {
    super(
      `휴지통의 기억 ${archivedId} 이(가) 복원을 준비하는 동안 바뀌었습니다. 복원한 것은 없습니다 — ` +
        `휴지통 목록을 다시 불러온 뒤 다시 시도해 주세요.`,
    );
    this.name = "ArchivedNodeChangedError";
  }
}

/**
 * resetAllMemory 반환 — 묶음 집계(설계 §7.2). 36칸 평평 객체 대신 그룹별 합을
 * 돌려준다. 핵심 3칸(knowledgeNodes·knowledgeEdges·knowledgeNodesArchive)은
 * 대시보드 표시 호환을 위해 유지한다.
 */
export interface ResetMemoryCounts {
  /** 글 본체 행 수 (대시보드 표시용 — 핵심 칸). */
  knowledgeNodes: number;
  /** 글↔글 엣지 행 수 (대시보드 표시용 — 핵심 칸). */
  knowledgeEdges: number;
  /** 휴지통 행 수 (대시보드 표시용 — 핵심 칸). */
  knowledgeNodesArchive: number;
  /** 엔티티 8 본체 + projects 행 합. */
  entities: number;
  /** 통합 entity_concept_edges + entity_relation_edges + hierarchy_edges 합. */
  entityEdges: number;
  /** chunk_summaries + relation_summaries 합. */
  summaries: number;
  /** concept_nodes + persons + node_concept_edges + node_person_edges + concept_edges 합. */
  conceptsAndPersons: number;
  /** images + documents + asset_file_imports + asset_files 합. */
  assets: number;
  /** evolver_activity + memory_revisions 합 (정리·개정 로그). */
  logs: number;
  /**
   * 경계 테이블 합 (concept_alias_suggestions·cleanup_proposals·events·tag_reflow_log·project_vocabularies
   * + 정리 작업 표 cleanup_proposal_item_journal·cleanup_stage_results·cleanup_runs).
   */
  boundary: number;
  /**
   * 사용자 사전 합 (synonym_user_entries·classify_vocab_user_entries·classify_vocab_overrides·
   * relation_name_user_entries + entity_types 의 사용자 추가 종류 행). 코드 상수 종류 행은 세지도 지우지도 않는다.
   */
  userVocabulary: number;
  /** 위 그룹의 전체 삭제 행 합(knowledge_edges·archive 포함). */
  totalRowsDeleted: number;
}

export class StatsRepository {
  private readonly nodeSources: NodeSourceRepository;

  constructor(
    private readonly db: Database,
    private readonly embedder: Embedder,
  ) {
    this.nodeSources = new NodeSourceRepository(db);
  }

  /** 집계 카운터 반환 — /stats 엔드포인트와 대시보드가 호출한다. */
  async getStats(): Promise<{
    totalMemories: number;
    memoriesLast7Days: number;
    totalEdges: number;
  }> {
    const total = this.db
      .query("SELECT COUNT(*) AS c FROM knowledge_nodes")
      .get() as { c: number };
    const edges = this.db
      .query("SELECT COUNT(*) AS c FROM knowledge_edges")
      .get() as { c: number };

    // P3 G3-b — 컷오프를 설정 시간대 기준으로 만든다. created_at 은 nowKst(설정 zone)
    // 로 저장되므로 컷오프도 같은 zone 이라야 lexicographic 비교가 정확하다. 옛 코드는
    // toISOString()(UTC)으로 만들어 KST 저장값과 9시간 어긋나 "최근 7일" 집계가 상시
    // 틀렸다(실버그 수정 — 저장·컷오프 한 zone).
    const sevenDaysAgoIso = pastCutoffInZone(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    );

    // NodeRepository.countNodesSince 와 동일한 SQL — cross-repo 의존 없이 자체 실행
    const recent = this.db
      .query(
        "SELECT COUNT(*) AS c FROM knowledge_nodes WHERE created_at > ?",
      )
      .get(sevenDaysAgoIso) as { c: number };

    return {
      totalMemories: total.c,
      memoriesLast7Days: recent.c,
      totalEdges: edges.c,
    };
  }

  /**
   * 메모리 + 정리 세션을 한꺼번에 비우기 — settings 페이지 "데이터 초기화"
   * 통로가 호출. 현재 schema 의 메모리·휴지통·엔티티·자산 전 테이블을 한
   * 트랜잭션 안에서 비운다(설계 §7.1).
   *
   * - schema_version 보존 — 기준 스키마(v47)가 적은 버전 기록을 그대로 둔다. 비워도 다음 시작의 버전 판정을 통과한다
   *   (설계 2026-10-02 마이그레이션 압축 5·9절).
   * - regex_user_patterns · regex_user_boosters 보존 — 사용자가 손으로 길들인
   *   학습 자산이라 글이 사라져도 다음 입력에 계속 쓰인다(설계 §5.2).
   * - asset_folder_pairing 보존 — 첨부 파일 폴더의 짝 표시 파일(bara-asset-pairing.json, content/ 밖이라 AssetStore.clearContent
   *   도 지우지 않는다)과 같은 번호라, 초기화 뒤 다시 시작해도 DB 와 폴더의 짝이 맞는다(WP-B1-20U 설계 17.19).
   * - settings JSON 파일(data/memory-settings.json) 은 이 함수 범위 밖 — 보존.
   * - 사용자 사전은 비운다(제품 결정) — 동의어 synonym_user_entries, 분류 어휘 classify_vocab_user_entries,
   *   끄기 표시 classify_vocab_overrides(사용자가 기본 값을 끈 기록뿐 — 기본 값 자체는 yaml·코드라 DB 에 없다),
   *   관계명 relation_name_user_entries, 그리고 entity_types 의 사용자 추가 종류 행. 코드 상수 10종은
   *   entity_types 에 행이 없는 것이 규약이지만(EntityTypeRegistryDb.addEntityType 이 막는다), 혹시 있어도
   *   남기도록 STATIC_PLACEMENT_TYPE_NAMES 밖 행만 지운다. 기준 스키마가 시드하는 행은 entity_types 에 없다
   *   (시드는 memory_visibility_state 한 줄뿐 — 보존 대상).
   * - 정리 작업 표도 비운다 — cleanup_proposal_item_journal(적용 항목 원장·detail), cleanup_stage_results
   *   (단계별 처리 결과·last_error), cleanup_runs(실행 이력·옵션·집계). 모두 지워진 글의 부산물이고, 특히
   *   결과 원장은 target_key 가 글 번호라 초기화 뒤 번호가 1 부터 다시 쓰이면 새 글에 옛 처리 기록이 붙을 수 있다.
   * - memory_visibility_state(보이기 세대 번호 한 줄, 기준 스키마가 시드) 는 지우지 않는다 — 글 삭제 트리거가
   *   번호를 올려 캐시를 무효화한다. memory_mutations · memory_source_events · memory_node_sources(_archive) 는
   *   knowledge_nodes(_archive) 를 ON DELETE CASCADE 로 참조해 부모 삭제 때 함께 사라진다.
   * - 엔티티(정적 8 타입 + 새 종류) 본체는 범용 entities 한 줄, 라벨·identity 엣지는
   *   통합 entity_concept_edges 한 줄로 비운다(분류 단계4 T4 — 옛 per-type 테이블 순회 제거).
   * - FTS/vec 미러는 부모 DELETE 트리거가 같은 트랜잭션에서 자동 정리한다 —
   *   entities 의 entities_fts·entities_vec(+entity_attributes ON DELETE CASCADE),
   *   knowledge_nodes 의 FTS·trigram·vec0·고아 images, 요약의 *_summary_vec 미러 모두 명시 DELETE 하지 않는다
   *   (설계 §4). image_asset 이 아닌 통로로 남은 images 행과 documents·asset_*
   *   메타는 트리거 범위 밖이라 명시 삭제한다.
   * - 삭제 순서(자식 → 부모, FK 의존 역순): 엔티티 엣지(통합 entity_concept_edges
   *   + entity_relation_edges + hierarchy_edges) → 글 엣지(node_concept_edges /
   *   node_person_edges / concept_edges) → 요약(chunk_summaries /
   *   relation_summaries) → knowledge_edges → archive → revisions → activity
   *   → 경계 테이블(concept_alias_suggestions · cleanup_proposal_item_journal ·
   *   cleanup_proposals · cleanup_stage_results · cleanup_runs ·
   *   entity_register_records · entity_register_ignores · events ·
   *   tag_reflow_log · project_vocabularies) → 부모 본체(엔티티 8 + projects +
   *   concept_nodes + persons + knowledge_nodes) → 사용자 사전(FK 없음) → 자산(images / documents /
   *   asset_file_imports / asset_files). 자식 참조를 먼저 끊고 부모를 정리 —
   *   FK ON 상태에서도 안전(CASCADE 에 기대지 않고 명시 삭제). images·documents
   *   ·asset_file_imports 가 asset_files 를 FK 참조하므로 asset_files 를 마지막에 둔다.
   * - 트랜잭션 마지막에 `DELETE FROM sqlite_sequence` 로 AUTOINCREMENT 카운터를
   *   비운다 → 초기화 후 새 노드 id 가 1 부터 시작(고아 번호 이어붙음 차단).
   *   디스크 자산 파일 정리(AssetStore.clearContent)는 이 함수 범위 밖 —
   *   라우트(cleanup.ts)가 DB 트랜잭션 성공 후 별 단계로 호출한다.
   */
  resetAllMemory(): ResetMemoryCounts {
    const countRow = (table: string): number =>
      // dynamic SQL: table name varies, keep prepare()
      (this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

    // 한 테이블을 명시 삭제하고 비우기 전 행 수를 반환한다(count → delete 묶음).
    const wipe = (table: string): number => {
      const c = countRow(table);
      // dynamic SQL: table name varies(레지스트리/명시 나열 모두 코드 리터럴),
      // HTTP 입력 아님 — injection 가드 범위 밖(entity-embedding.ts 주석 정합).
      this.db.run(`DELETE FROM ${table}`);
      return c;
    };

    let entities = 0;
    let entityEdges = 0;
    let summaries = 0;
    let conceptsAndPersons = 0;
    let assets = 0;
    let logs = 0;
    let boundary = 0;
    let userVocabulary = 0;
    let knowledgeNodes = 0;
    let knowledgeEdges = 0;
    let knowledgeNodesArchive = 0;

    const tx = this.db.transaction(() => {
      // ── 1) 엔티티 엣지 (FK 자식 — 부모 본체보다 먼저) ──────────────────
      // 분류 단계4 T4 — 엔티티 라벨·identity 엣지는 범용 통합 테이블
      // entity_concept_edges(entity_id 끝점) 한 곳에 모였다. 옛 per-type
      // <type>_concept_edges 8개 + project_concept_edges 는 단계4 T9'(v30)이, 옛
      // project_person_edges 는 S4(v31)가 DROP 한 테이블이라 비우지 않는다(SELECT/DELETE
      // 대상이 없으면 'no such table' 크래시). 라벨이 entity_concept_edges 로, 참여자
      // 관계가 entity_relation_edges(participated_by)로 옮겨졌으므로 아래 두 줄이
      // 프로젝트 라벨·참여자까지 함께 비운다.
      entityEdges += wipe("entity_concept_edges");
      entityEdges += wipe("entity_relation_edges");
      // 위계 단일 출처(S0-T1 hierarchy_edges, spec 2026-06-14 §4.1). FK 0 이라
      // 삭제 순서 무관이지만 같은 엔티티 엣지 묶음에 합류시켜 entityEdges 로 센다.
      // ENTITY_TYPE_METAS 순회 밖 단일 테이블이라 명시 한 줄로 비운다.
      entityEdges += wipe("hierarchy_edges");

      // ── 2) 글 엣지 ────────────────────────────────────────────────────
      conceptsAndPersons += wipe("node_concept_edges");
      conceptsAndPersons += wipe("node_person_edges");
      conceptsAndPersons += wipe("concept_edges");

      // ── 3) 요약 (knowledge_nodes·documents 보다 먼저 — CASCADE 의존 회피) ─
      summaries += wipe("chunk_summaries");
      summaries += wipe("relation_summaries");

      // ── 4~7) 글 엣지 본체·휴지통·개정·활동 로그 ──────────────────────────
      knowledgeEdges = wipe("knowledge_edges");
      knowledgeNodesArchive = wipe("knowledge_nodes_archive");
      logs += wipe("memory_revisions");
      logs += wipe("evolver_activity");

      // ── 8) 경계 테이블 (전부 "비움" — 설계 D-1~D-5) ─────────────────────
      // 부모 개념/프로젝트보다 먼저 비워 CASCADE 중간 FK 위반을 막는다(보수 패턴).
      boundary += wipe("concept_alias_suggestions");
      // 정리 작업 표 셋은 FK 가 없어 순서 무관 — 적용 원장 → 제안 → 단계 결과 → 실행 이력 순으로 나열.
      boundary += wipe("cleanup_proposal_item_journal");
      boundary += wipe("cleanup_proposals");
      boundary += wipe("cleanup_stage_results");
      boundary += wipe("cleanup_runs");
      // 항목·일정 자동 등록 기록·무시 기록 — 메모를 비우면 기댈 원본이 없다.
      boundary += wipe("entity_register_records");
      boundary += wipe("entity_register_ignores");
      // 문서 OCR 서버 자동 처리의 쪽 결과 원장·하루 호출 수(v49) — 문서를 비우면 기댈 원본이 없고, 하루 호출 수도
      // 지워진 문서의 처리 흔적이다. 원장은 documents 보다 먼저 비운다(FK).
      boundary += wipe("document_ocr_page_results");
      boundary += wipe("document_ocr_daily_usage");
      // 자동 추출·캡션 백필 실패 기록(v50) — 기억을 비우면 기댈 대상이 없다. knowledge_nodes 보다 먼저 비운다(FK).
      boundary += wipe("backfill_attempts");
      boundary += wipe("events");
      boundary += wipe("tag_reflow_log");
      boundary += wipe("project_vocabularies");

      // ── 9) 부모 본체 (FTS/vec 미러는 DELETE 트리거가 자동 정리 — §4) ─────
      // 분류 단계4 T4·T7'b — 정적 8 타입 + 프로젝트 + 새 종류가 모두 범용 본체 entities
      // 한 곳에 산다. entities 를 비우면 entity_attributes(ON DELETE CASCADE)·entities_fts·
      // entities_vec(DELETE 트리거)가 자동 정리된다. 옛 per-type 본체(works·places…)와 옛
      // projects 는 단계4 T9'(v30)이, 옛 project_person_edges 는 S4(v31)가 DROP 한
      // 테이블이라 비우지 않는다('no such table' 회피).
      entities += wipe("entities");
      conceptsAndPersons += wipe("concept_nodes");
      conceptsAndPersons += wipe("persons");
      knowledgeNodes = wipe("knowledge_nodes");

      // ── 9b) 사용자 사전 (제품 결정 — 초기화는 사용자가 쌓은 사전도 지운다) ──
      // 모두 FK 가 없는 독립 표다. 기본 사전(yaml·코드 상수)은 파일이라 영향 없다.
      userVocabulary += wipe("synonym_user_entries");
      userVocabulary += wipe("classify_vocab_user_entries");
      userVocabulary += wipe("classify_vocab_overrides");
      userVocabulary += wipe("relation_name_user_entries");
      // entity_types 는 사용자가 더한 새 종류만 담는 표다(코드 상수 10종은 행이 없는 것이 규약).
      // 그래도 코드 상수 이름의 행은 보존하도록 이름으로 거른다.
      const staticTypePlaceholders = sqlPlaceholders(STATIC_PLACEMENT_TYPE_NAMES.length);
      const userTypeCount = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM entity_types WHERE type_name NOT IN (${staticTypePlaceholders})`,
          )
          .get(...STATIC_PLACEMENT_TYPE_NAMES) as { c: number }
      ).c;
      this.db
        .prepare(`DELETE FROM entity_types WHERE type_name NOT IN (${staticTypePlaceholders})`)
        .run(...STATIC_PLACEMENT_TYPE_NAMES);
      userVocabulary += userTypeCount;

      // ── 10) 자산·문서 메타 ───────────────────────────────────────────────
      // image_asset 노드의 images 행은 images_node_delete 트리거가 위에서 이미
      // 정리했지만, 그 통로 밖으로 남은 images 행과 documents·asset_* 메타는
      // 트리거 범위 밖이라 여기서 명시 삭제(고아 데이터 0). asset_files 는
      // images·documents·asset_file_imports 가 FK 참조하므로 맨 뒤.
      assets += wipe("images");
      this.db.run("DELETE FROM document_record_owners"); // documents 의 자식(주인 표 v46) — CASCADE 에 기대지 않는다.
      assets += wipe("documents");
      assets += wipe("asset_file_imports");
      assets += wipe("asset_files");

      // ── 11) AUTOINCREMENT 카운터 초기화 — 초기화 후 새 노드 id 가 1 부터 ──
      // sqlite_sequence 는 AUTOINCREMENT 칸이 있는 테이블이 하나라도 있으면
      // SQLite 가 자동 생성하는 테이블이라 명시 DELETE 가 안전.
      this.db.run("DELETE FROM sqlite_sequence");
    });

    tx();

    const totalRowsDeleted =
      knowledgeNodes +
      knowledgeEdges +
      knowledgeNodesArchive +
      entities +
      entityEdges +
      summaries +
      conceptsAndPersons +
      assets +
      logs +
      boundary +
      userVocabulary;

    return {
      knowledgeNodes,
      knowledgeEdges,
      knowledgeNodesArchive,
      entities,
      entityEdges,
      summaries,
      conceptsAndPersons,
      assets,
      logs,
      boundary,
      userVocabulary,
      totalRowsDeleted,
    };
  }

  /**
   * 명시적 휴지통 이동의 단일 진입점(WP-B1-20U 설계 17.3) — 사용자 휴지통(cascade), 자동 정리(selected_only),
   * 중복 원문 정리(cascade). 한 트랜잭션에서 explicit 제거 계획을 세우고 그 결과만 보관표로 옮긴다:
   *   - cascade: 고른 노드와, 자기 출처 행도 살아 남는 다른 계보 부모도 없는 자손을 함께 옮긴다.
   *   - selected_only: 고른 노드만 옮긴다. 옮기면 고르지 않은 노드가 마지막 부모를 잃는 뿌리는 남긴다.
   * 어느 정책이든 옮긴 뒤 살아 있는 노드는 자기 출처 행이나 살아 있는 계보 부모를 가진다. 호출자가 쓰기
   * 잠금을 쥔다(store facade 의 trashNodes 가 잡는다).
   */
  trashNodesSync(rootIds: readonly number[], policy: ExplicitRemovalPolicy): TrashNodesResult {
    return this.db.transaction((): TrashNodesResult => {
      const plan = planSourceRemoval(this.db, { kind: "explicit", rootIds, policy });
      const movedIds = this.archiveNodesSync(plan.removeIds, plan.declaredParents);
      return trashResultOf(plan.rootIds, movedIds, plan.blockedIds);
    })();
  }

  /**
   * trashNodesSync 와 같은 계획을 읽기만 해서 돌려준다(쓰지 않음) — 중복 원문 정리 스크립트의 dry-run 이
   * 실제 이동과 같은 수를 세는 데 쓴다. 읽기 트랜잭션 하나에서 계획한다.
   */
  previewTrash(rootIds: readonly number[], policy: ExplicitRemovalPolicy): TrashNodesResult {
    return this.db.transaction((): TrashNodesResult => {
      const plan = planSourceRemoval(this.db, { kind: "explicit", rootIds, policy });
      return trashResultOf(plan.rootIds, plan.removeIds, plan.blockedIds);
    })();
  }

  /**
   * 모든 휴지통 이동의 단일 동기 본체(WP-B1-20T 설계 5.4). 제거 계획의 결과만 받는다(trashNodesSync).
   * 호출자 트랜잭션 안에서도 부를 수 있다(bun:sqlite 가 저장점으로 중첩). 한 트랜잭션에서:
   *   1) 노드 행을 knowledge_nodes_archive 로 복사한다.
   *   2) 노드의 출처 행을 memory_node_sources_archive 로 옮긴다. 자기 출처 행이 없는 노드에는 그 순간의
   *      계보 부모마다(그리고 declaredParents 로 받은 extractedTo 부모마다) archived_lineage 행을 남긴다 —
   *      부모의 메시지가 지워지면 보관표 정리(설계 5.5)가 이 노드도 영구 삭제하게.
   *   3) 원행을 지운다(엣지는 ON DELETE CASCADE).
   * 수정 이력(memory_revisions)은 건드리지 않는다 — 복원될 수 있다. 반환: 옮긴 노드 id(오름차순).
   */
  private archiveNodesSync(
    ids: readonly number[],
    declaredParents: ReadonlyMap<number, readonly number[]>,
  ): number[] {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return [];
    // 1.2 T13(spec 10.3 A-5) + 활용 단계2 ②: embedding_text / polarity / project_id /
    // updated_at / event_at / event_until 6칸을 함께 보존한다 — 옛 INSERT 는 이 칸들을 빠뜨려
    // 복원 시 구조적 유실이 났다(event_until 은 단계2 ② 에서 합류 — 보관·복원이
    // 일정 종료 일시를 그대로 옮긴다). 칼럼 21개 / placeholder 21개.
    const insertArchive = this.db.query(
      `INSERT INTO knowledge_nodes_archive
        (id, content, memory_type, source_type, importance, confidence,
         platform, author, created_at, updated_at, last_accessed_at, access_count,
         mention_count, last_mentioned_at, metadata_json,
         embedding_text, polarity, project_id, event_at, event_until, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    return this.db.transaction((): number[] => {
      const rows: KnowledgeNodeRow[] = [];
      for (const batch of inIdBatches(wanted)) {
        // dynamic SQL: placeholder count varies, keep prepare()
        rows.push(...(this.db
          .prepare(`SELECT * FROM knowledge_nodes WHERE id IN (${sqlPlaceholders(batch.length)})`)
          .all(...batch) as KnowledgeNodeRow[]));
      }
      const movedIds = rows.map((r) => r.id).sort((a, b) => a - b);
      const lineageParents = this.lineageParentsOfSourcelessSync(movedIds, declaredParents);
      const now = nowKst();
      for (const r of rows) {
        insertArchive.run(
          r.id,
          r.content,
          r.memory_type,
          r.source_type,
          r.importance,
          r.confidence,
          r.platform,
          r.author,
          r.created_at,
          r.updated_at ?? null,
          r.last_accessed_at,
          r.access_count,
          r.mention_count,
          r.last_mentioned_at,
          r.metadata_json,
          r.embedding_text ?? null,
          r.polarity ?? null,
          r.project_id ?? null,
          r.event_at ?? null,
          r.event_until ?? null,
          now,
        );
      }
      this.nodeSources.moveToArchiveSync(movedIds, lineageParents);
      for (const batch of inIdBatches(movedIds)) {
        // dynamic SQL: placeholder count varies, keep prepare()
        this.db.prepare(`DELETE FROM knowledge_nodes WHERE id IN (${sqlPlaceholders(batch.length)})`).run(...batch);
      }
      return movedIds;
    })();
  }

  /**
   * 자기 출처 행이 없는 노드 → 계보 부모(엣지 부모 + declaredParents, 자기 자신 제외). 부모가 하나도
   * 없는 노드는 넣지 않는다. 출처 행·엣지를 500개씩 묶어 읽는다.
   */
  private lineageParentsOfSourcelessSync(
    ids: readonly number[],
    declaredParents: ReadonlyMap<number, readonly number[]>,
  ): Map<number, number[]> {
    const sourceless: number[] = [];
    for (const [id, rows] of this.nodeSources.listSync(ids)) if (rows.length === 0) sourceless.push(id);
    const parents = new Map<number, Set<number>>();
    const add = (childId: number, parentId: number) => {
      if (childId === parentId) return;
      const known = parents.get(childId);
      if (known) known.add(parentId);
      else parents.set(childId, new Set([parentId]));
    };
    for (const batch of inIdBatches(sourceless)) {
      // dynamic SQL: placeholder count varies, keep prepare()
      const edges = this.db
        .prepare(
          `SELECT source_id, target_id FROM knowledge_edges
           WHERE source_id IN (${sqlPlaceholders(batch.length)}) AND relation IN (${LINEAGE_PLACEHOLDERS})`,
        )
        .all(...batch, ...SHARED_MEMORY_LINEAGE_RELATIONS) as Array<{ source_id: number; target_id: number }>;
      for (const edge of edges) add(edge.source_id, edge.target_id);
    }
    for (const id of sourceless) {
      for (const parentId of declaredParents.get(id) ?? []) add(id, parentId);
    }
    return new Map([...parents].map(([id, known]) => [id, [...known].sort((a, b) => a - b)]));
  }

  /**
   * archive 목록 조회. 최신 archived_at 순(DESC).
   */
  async getArchive(
    options: { since?: string; limit?: number } = {},
  ): Promise<ArchivedNode[]> {
    const limit = Math.min(options.limit ?? 50, 200);
    let sql = "SELECT * FROM knowledge_nodes_archive";
    const params: (string | number)[] = [];
    if (options.since) {
      sql += " WHERE archived_at >= ?";
      params.push(options.since);
    }
    sql += " ORDER BY archived_at DESC LIMIT ?";
    params.push(limit);

    // dynamic SQL: placeholder count varies, keep prepare()
    const rows = this.db.prepare(sql).all(...params) as (KnowledgeNodeRow & {
      archived_at: string;
    })[];
    return rows.map((r) => ({
      ...rowToNode(r),
      archivedAt: r.archived_at,
    }));
  }

  async getArchivePage(options: ArchivePageOptions = {}): Promise<ArchivePage> {
    return readArchivePage(this.db, options);
  }

  /**
   * 복원 1단계(쓰기 잠금 밖, WP-B1-20U 설계 17.4): 보관 행을 읽고 그 본문을 다시 임베딩한다(archive 에는
   * 임베딩이 없다). 보관 행은 부른 그 자리에서(첫 await 전) 읽는다 — 이 스냅샷이 2단계의 비교 기준이다.
   * 없는 id 면 null. bge-m3 계산은 쓰기 잠금을 잡지 않는다(설계 D18).
   */
  async prepareRestore(id: number): Promise<PreparedRestore | null> {
    const snapshot = this.readArchivedRowSync(id);
    if (!snapshot) return null;
    const vector = await this.embedder.embed(snapshot.content);
    if (vector.length !== this.embedder.dimension) {
      throw new Error(
        `restoreArchived embedding dim mismatch: got ${vector.length}, expected ${this.embedder.dimension}`,
      );
    }
    return { snapshot, vector };
  }

  /**
   * 복원 2단계(호출자가 쓰기 잠금을 쥔다, 한 트랜잭션, WP-B1-20U 설계 17.4): 보관 행을 다시 읽어 1단계 스냅샷과
   * 견준다.
   *   - 없으면(그 사이 메시지 삭제의 보관표 정리·보관 기간 만료·같은 id 의 다른 복원이 지움) 아무것도 쓰지 않고
   *     null — 지운 메시지 본문을 먼저 읽은 행으로 되살리지 않는다.
   *   - 본문이나 보관 시각이 다르면(초기화 뒤 같은 번호가 다시 쓰임) ArchivedNodeChangedError — 준비한 임베딩이
   *     지금 행의 본문과 맞는다는 보장이 없다. 아무것도 쓰지 않는다.
   *   - 같으면 지금 행으로 노드·벡터를 넣고 last_accessed_at 을 복원 시점으로 갱신한다.
   * WP-B1-20T 설계 5.4 — 보관된 출처 행(archived_lineage 제외)을 되돌린다. 되돌릴 행이 없으면 restore:<actor>
   * 출처 행을 더한다 — 되살린 사람의 명시적 보존 의사. actor 는 복원을 요청한 행위자(라우트가 인증 토큰에서
   * 정한다). 계보 엣지는 되살리지 않는다(범위 밖, 설계 13절). 반환: 되살린 노드.
   */
  commitRestoreSync(prepared: PreparedRestore, actor: string): MemoryNode | null {
    const { snapshot, vector } = prepared;
    // 1.2 T13(spec 10.3 A-5) + 활용 단계2 ②: embedding_text / polarity / project_id /
    // updated_at / event_at / event_until 6칸을 그대로 회복한다 — 보관 시 보존한 값을
    // 복원 노드에 다시 채운다(event_until 은 단계2 ② 합류). 칼럼 20개 / placeholder 20개.
    const insertNode = this.db.query(
      `INSERT INTO knowledge_nodes
        (id, content, memory_type, source_type, importance, confidence,
         platform, author, metadata_json, created_at, updated_at, last_accessed_at,
         access_count, mention_count, last_mentioned_at,
         embedding_text, polarity, project_id, event_at, event_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVec = this.db.query(
      "INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)",
    );
    const deleteArchive = this.db.query(
      "DELETE FROM knowledge_nodes_archive WHERE id = ?",
    );

    return this.db.transaction((): MemoryNode | null => {
      const row = this.readArchivedRowSync(snapshot.id);
      if (!row) return null;
      if (row.content !== snapshot.content || row.archived_at !== snapshot.archived_at) {
        throw new ArchivedNodeChangedError(row.id);
      }
      insertNode.run(
        row.id,
        row.content,
        row.memory_type,
        row.source_type,
        row.importance,
        row.confidence,
        row.platform,
        row.author,
        row.metadata_json,
        row.created_at,
        row.updated_at ?? null,
        nowKst(), // 복원 시 last_accessed_at 갱신 — importance 회복 효과
        row.access_count,
        row.mention_count,
        row.last_mentioned_at,
        row.embedding_text ?? null,
        row.polarity ?? null,
        row.project_id ?? null,
        row.event_at ?? null,
        row.event_until ?? null,
      );
      insertVec.run(row.id, vector);
      // 살아 있는 노드 행이 먼저 있어야 하고(외래 키), 보관 노드 행을 지우기 전이어야 한다(CASCADE).
      this.nodeSources.restoreFromArchiveSync(row.id, actor);
      deleteArchive.run(row.id);
      // 복원된 노드를 같은 트랜잭션에서 다시 읽어 반환한다(방금 넣은 행이라 늘 있다).
      const restored = this.db
        .query("SELECT * FROM knowledge_nodes WHERE id = ?")
        .get(row.id) as KnowledgeNodeRow | null;
      if (!restored) throw new Error(`restoreArchived: 복원한 노드 ${row.id} 를 다시 읽지 못했습니다`);
      return rowToNode(restored);
    })();
  }

  /** 보관 행 한 개(없으면 null). 복원 1단계 스냅샷과 2단계 다시 읽기가 같은 질의를 쓴다. */
  private readArchivedRowSync(id: number): ArchivedNodeRow | null {
    return this.db
      .query("SELECT * FROM knowledge_nodes_archive WHERE id = ?")
      .get(id) as ArchivedNodeRow | null;
  }

  /**
   * `archived_at < (now - maxAgeDays)` 인 archive 행을 영구 삭제(휴지통 보관 만료). 호출자(store.purgeOldArchive)가
   * 쓰기 잠금을 쥔다. 반환: 삭제한 행 수와 첨부 해제 결과.
   *
   * 보관 출처 행은 ON DELETE CASCADE 로 함께 지워지고, 지운 노드를 가리키는 수정 이력 행도 같은
   * 트랜잭션에서 지운다(WP-B1-20T 설계 15절 — 영구 삭제된 본문이 이력에 남지 않게).
   * 첨부 해제(WP-B1-20U 설계 17.17·17.18): 지운 행의 `RETURNING id` 로 같은 트랜잭션 끝에서 그 노드 번호가 주인 표
   * (document_record_owners)에 주인으로 적힌 문서 기록을 documents 행과 그 원장 행(`document:<id>`)까지, 지운 노드의 이미지
   * 원장 행(`image:<node_id>`)을 원장 source_ref 로 찾아 지우고, 참조를 잃은 sha 를 돌려준다(assetRelease). 파일과
   * asset_files 행은 커밋 뒤 같은 잠금 안에서 호출자가 파일 지우기 함수로 지운다.
   */
  purgeOldArchiveSync(maxAgeDays: number): Omit<PurgeOldArchiveResult, "assetCleanup"> & { assetRelease: AssetRelease } {
    // P3 G3-b — archived_at 은 archiveNodesSync 가 nowKst(설정 zone)로 저장하므로 컷오프도
    // 같은 zone 이라야 정확하다. 옛 toISOString()(UTC) 컷오프는 KST 저장값과 9시간
    // 어긋나 30일이 실질 30일 9시간(또는 그 반대)이 됐다(실버그 수정).
    const cutoffMs = Date.now() - maxAgeDays * 24 * 3600 * 1000;
    const cutoff = pastCutoffInZone(cutoffMs);
    return this.db.transaction(() => {
      const holders = new RemovedAssetHolders();
      const purged = this.db
        .query(`DELETE FROM knowledge_nodes_archive WHERE archived_at < ? ${REMOVED_HOLDER_RETURNING}`)
        .all(cutoff) as RemovedNodeRow[];
      holders.addRows(purged);
      deleteRevisionsOfRemovedNodesSync(this.db, purged.map((row) => row.id));
      return { nodesPurged: purged.length, assetRelease: releaseRemovedAssetsSync(this.db, holders) };
    })();
  }

  /**
   * 영구 삭제까지 `warnDays` 이내인 archive 노드 반환.
   * 즉, `archived_at` 가 `(now - maxAgeDays)` ~ `(now - (maxAgeDays - warnDays))` 범위.
   */
  async getArchiveSoonToPurge(
    warnDays: number,
    maxAgeDays: number,
  ): Promise<ArchivedNode[]> {
    // P3 G3-b — 두 컷오프도 archived_at 저장 zone(설정 시간대)과 통일한다. 옛
    // toISOString()(UTC) 경계는 KST 저장값과 9시간 어긋나 임박 판정 창이 밀렸다(실버그 수정).
    const nowMs = Date.now();
    const lowerMs = nowMs - maxAgeDays * 24 * 3600 * 1000;
    const upperMs = nowMs - (maxAgeDays - warnDays) * 24 * 3600 * 1000;
    const lower = pastCutoffInZone(lowerMs);
    const upper = pastCutoffInZone(upperMs);

    const rows = this.db
      .query(
        `SELECT * FROM knowledge_nodes_archive
         WHERE archived_at >= ? AND archived_at < ?
         ORDER BY archived_at ASC`,
      )
      .all(lower, upper) as (KnowledgeNodeRow & { archived_at: string })[];
    return rows.map((r) => ({ ...rowToNode(r), archivedAt: r.archived_at }));
  }

  /**
   * Phase 5.7.3 W2 — auto-cleanup-runner.ts 가 호출하는 활동 로그.
   *
   * 옛 `evolver_activity` 테이블 그대로 재사용 — schema 변경 회피. 단계 4
   * 분리에 따라 이 메서드는 `nodesPurged` + `soonToPurgeCount` 입력 안 받음 →
   * DB 그 두 칸은 0 default 채움(호환).
   *
   * 1.2 T13(spec 10.2 A-3): 옛 concepts_emerged / concepts_archived 칸이 죽어
   * 사라져 INSERT 칸 목록에서도 뺐다.
   */
  async logAutoCleanupActivity(summary: {
    clusterEdgesAdded: number;
    nodesArchived: number;
  }): Promise<void> {
    this.db
      .query(
        `INSERT INTO evolver_activity
          (ran_at, cluster_edges_added, nodes_archived, nodes_purged,
           soon_to_purge_count)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        nowKst(),
        summary.clusterEdgesAdded,
        summary.nodesArchived,
        0,
        0,
      );
  }

  /**
   * Phase 5.7.3 W4 — trash-manager.ts 가 호출하는 활동 로그.
   *
   * 옛 `evolver_activity` 테이블 그대로 재사용 — schema 변경 회피. W2
   * `logAutoCleanupActivity` 와 별개 메서드(시스템 분리 정신 정합).
   * 이 메서드는 `clusterEdgesAdded` + `nodesArchived` 입력 미수신 →
   * DB 그 두 칸은 0 default 채움(호환).
   *
   * 1.2 T13(spec 10.2 A-3): 옛 concepts_emerged / concepts_archived 칸이 죽어
   * 사라져 INSERT 칸 목록에서도 뺐다.
   */
  async logTrashActivity(summary: {
    nodesPurged: number;
    soonToPurgeCount: number;
  }): Promise<void> {
    this.db
      .query(
        `INSERT INTO evolver_activity
          (ran_at, cluster_edges_added, nodes_archived, nodes_purged,
           soon_to_purge_count)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        nowKst(),
        0,
        0,
        summary.nodesPurged,
        summary.soonToPurgeCount,
      );
  }

  /**
   * 최근 N개 evolver 사이클 기록 조회(newest first).
   */
  async getEvolverActivity(
    limit: number = 7,
  ): Promise<EvolverActivitySummary[]> {
    const rows = this.db
      .query(
        `SELECT ran_at, cluster_edges_added, nodes_archived, nodes_purged,
                soon_to_purge_count
         FROM evolver_activity ORDER BY ran_at DESC LIMIT ?`,
      )
      .all(Math.min(limit, 100)) as Array<{
      ran_at: string;
      cluster_edges_added: number;
      nodes_archived: number;
      nodes_purged: number;
      soon_to_purge_count: number;
    }>;
    return rows.map((r) => ({
      ranAt: r.ran_at,
      clusterEdgesAdded: r.cluster_edges_added,
      nodesArchived: r.nodes_archived,
      nodesPurged: r.nodes_purged,
      soonToPurgeCount: r.soon_to_purge_count,
    }));
  }
}
