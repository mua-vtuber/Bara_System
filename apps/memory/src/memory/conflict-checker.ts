/**
 * Conflict detection for memory nodes.
 *
 * Similarity identifies candidates, not truth. A new ambiguous assertion is
 * marked disputed and linked with contradicts; prior assertions are retained.
 * Authoritative replacement is only performed by explicit shared-memory mutations.
 *
 * Port of backend/app/services/memory/conflict_checker.py. Embeddings are
 * now sourced from vec_nodes via the store rather than carried inline on
 * MemoryNode rows.
 *
 * 수동 편집 경로(PATCH /memories/:id · /memories/by-source)는 recheckAfterEdit
 * 로 같은 검사를 편집한 기억에 다시 적용한다 — 새로 충돌 band 에 든 상대가 있으면
 * contradicts 엣지를 만들고 편집한 기억을 disputed 로 표시한다. 기존 엣지(contradicts·
 * supersedes)는 지우지 않는다: 유사도가 band 를 벗어나도 옛 충돌 기록과 명시 대체는 남는다.
 * 편집한 기억의 계보(조상·자손)는 한 글에서 나온 같은 내용이라 상대로 잇지 않는다(WP-B1-20T T6).
 *
 * 비교 대상은 같은 "주장의 주체"(conflictSubjectKey)·프로젝트·기억 종류다. 작성 AI(author)는
 * 주체가 아니다 — MCP 저장의 author 는 토큰 adapterId 라 AI 마다 달라, 같은 사용자에 대한
 * Claude 의 기록과 Codex 의 기록이 서로 비교되지 않던 문제(SL-4)를 막는다.
 *
 * 유사도가 충돌 상한(simHigh) 이상인 쌍은 작성 AI 로 가른다(highSimilarityRoute — 추출 중복
 * 흡수와 함께 쓰는 단일 출처): 같은 작성 AI 면 추출의 중복 흡수 몫이라 충돌이 아니고, 다른
 * 작성 AI 면 충돌 후보다. 두 AI 가 거의 같은 문장으로 반대 선호를 남기면("답변은 한국어로" 대
 * "답변은 영어로", bge-m3 0.867) 흡수도 충돌도 아닌 채 둘 다 표시 없이 남던 틈(WP-B1-09R)을 막는다.
 * 정규화 후 같은 본문(contentHash 가 같음)은 같은 주장이라 충돌이 아니다.
 */

import type { Database } from "bun:sqlite";
import { cosineSimilarity } from "../embedding/vector-utils.ts";
import type { EdgeRelation, MemoryNode, MemoryType } from "./types.ts";
import type { SqliteMemoryStore } from "../db/store.ts";
import type { KnowledgeNodeRow } from "../db/store-internal/row-types.ts";
import { nowKst, rowToNode } from "../db/store-internal/helpers.ts";
import { readSharedMemory, isCurrentMemory, REGEX_EDGE_PROVENANCE } from "./shared-memory-contract.ts";
import { withMemoryMutationLock } from "./shared-memory-mutation-lock.ts";
import { readMemoryVisibility } from "./shared-memory-read.ts";
import type { MemoryVisibilityCheck } from "./extraction-visibility.ts";
import { normalizeProjectId } from "./project-scope.ts";
import { contentHash } from "./content-hash.ts";
import { originWholeLineageSync } from "./extractor-internal/origin-lineage.ts";

/**
 * Lower bound of "moderate similarity" range that triggers conflict.
 *
 * bge-m3 단일 모델 기준 fallback 값. 운영 경로에서는 server.ts 가
 * factory.conflictThresholdsOf("bge-m3").conflictLow 를 주입하지만, 테스트나 도구가
 * ConflictChecker 를 직접 생성하는 경우도 같은 기준을 쓰게 한다.
 */
export const CONFLICT_SIM_LOW = 0.55;

/**
 * Upper bound of "moderate similarity" range.
 *
 * bge-m3 단일 모델 기준 fallback 값. 이 값 이상은 "거의 같은 문장" 구간이다 — 같은 작성
 * AI 의 쌍은 추출 중복 흡수 몫이고, 다른 작성 AI 의 쌍은 충돌 후보다(highSimilarityRoute,
 * isConflictPair).
 */
export const CONFLICT_SIM_HIGH = 0.85;

/**
 * Multiplier applied to the superseded node's importance.
 *
 * 본 값은 similarity threshold가 아니라 importance를 깎는 곱수 (0~1).
 * similarity threshold가 아니라 importance multiplier라 모델 교체와 무관하다.
 */
export const IMPORTANCE_DECAY = 0.7;

/**
 * 충돌 후보로 쓸 FTS 상위 건수의 상한(설계 17.5, D19). 같은 계보(excludeNodeIds)와 새 노드 자신을 거른 뒤
 * 앞에서 이만큼만 후보로 쓴다. FTS 에 맡기는 창은 이 값에 제외 수를 더해 넓힌다(check) — 제외 대상이 상위를
 * 채워도 거른 뒤 이 건수가 남도록.
 */
export const CONFLICT_FTS_CANDIDATE_LIMIT = 10;

/** Memory types the conflict checker considers. Others are skipped. */
const CONFLICT_ELIGIBLE_TYPES: ReadonlySet<MemoryType> = new Set([
  "fact",
  "preference",
]);

/**
 * Pure: is this similarity score in the conflict band?
 *
 * 디폴트 인자는 모듈 상수 (CONFLICT_SIM_LOW/HIGH) — 설정 override 없을 때.
 * caller (ConflictChecker) 는 settings.search.conflictLow/High 를 명시적으로 전달.
 */
export function isConflictSimilarity(
  sim: number,
  simLow: number = CONFLICT_SIM_LOW,
  simHigh: number = CONFLICT_SIM_HIGH,
): boolean {
  return sim >= simLow && sim < simHigh;
}

/**
 * 고유사도 쌍의 처리 경로 — 추출 중복 흡수(MemoryExtractor.findDedupTarget)와 충돌 후보
 * (ConflictChecker)가 한 쌍을 두 번 처리하지 않도록 경계를 정하는 단일 출처.
 *
 * - "duplicate": 새 기억에 작성 AI 가 없거나 기존 기억과 같은 작성 AI — 같은 AI 가 같은 말을
 *   다시 남긴 것으로 보고 중복 흡수에 맡긴다. 충돌 검사는 이 쌍을 후보로 쓰지 않는다.
 * - "conflict": 작성 AI 가 다름 — 흡수하지 않고(남의 기록으로 흡수하면 새 AI 의 주장이 사라진다)
 *   충돌 후보로 표시해 사용자가 확인하게 한다.
 *
 * 유사도 임계는 호출처가 각자 가진다(흡수 = duplicateSim, 충돌 = simHigh). 이 함수는 "누구의 몫인가"만
 * 정한다.
 */
export type HighSimilarityRoute = "duplicate" | "conflict";

export function highSimilarityRoute(
  newAuthor: string,
  existingAuthor: string,
): HighSimilarityRoute {
  return newAuthor === "" || newAuthor === existingAuthor ? "duplicate" : "conflict";
}

/**
 * Pure: 같은 주체·프로젝트·기억 종류로 이미 걸러진 한 쌍이 충돌 후보인가.
 *
 * - 유사도 simLow 미만: 무관한 글 — 아니다.
 * - simLow 이상 simHigh 미만(isConflictSimilarity): 작성 AI 와 무관하게 후보다.
 * - simHigh 이상: highSimilarityRoute 가 "conflict"(작성 AI 가 다름)이고 정규화 후 본문이 다를 때만
 *   후보다. 정규화(contentHash — NFC + 앞뒤 trim, 정확-중복 흡수 키와 같은 규칙) 후 같은 본문은
 *   같은 주장이라 충돌이 아니다.
 */
export function isConflictPair(pair: {
  similarity: number;
  simLow: number;
  simHigh: number;
  newAuthor: string;
  newContent: string;
  existingAuthor: string;
  existingContent: string;
}): boolean {
  if (pair.similarity < pair.simLow) return false;
  if (pair.similarity < pair.simHigh) return true;
  return highSimilarityRoute(pair.newAuthor, pair.existingAuthor) === "conflict" &&
    contentHash(pair.newContent) !== contentHash(pair.existingContent);
}

/**
 * Pure: importance after a node is superseded (never negative).
 *
 * 디폴트 decay 는 모듈 상수 (IMPORTANCE_DECAY). caller 는 settings.search.importanceDecay
 * 전달.
 */
export function decayedImportance(
  currentImportance: number,
  decay: number = IMPORTANCE_DECAY,
): number {
  return Math.max(0.0, currentImportance * decay);
}

/** 소유자 본인에 대한 기억의 충돌 주체 키 — metadata.user_id 가 없는 기억. */
export const OWNER_CONFLICT_SUBJECT = "owner";

/**
 * Pure: 이 기억이 누구에 대한 주장인가(충돌 비교 단위).
 *
 * - metadata.user_id 가 있으면 `user:<id>` — Discord 봇처럼 다른 사람의 발언을 중계한 기억.
 *   서로 다른 사람의 선호·사실은 충돌 후보가 아니다.
 * - 없으면(빈 문자열 포함) OWNER_CONFLICT_SUBJECT — AI·Pet·대시보드가 기록한 사용자 본인의 기억.
 *   어느 AI 가 기록했든(author) 같은 주체로 비교한다.
 *
 * 문자열 user_id 는 앞뒤 공백을 뺀다. 문자열이 아닌 값(숫자 ID 등)도 누군가를 가리키는 값이라
 * 소유자와 섞지 않고 그 값(JSON)을 주체로 쓴다 — 다른 사람의 주장이 소유자 기억과 비교돼
 * disputed 가 되는 일을 막는다.
 *
 * 알려진 한계: 소유자가 Discord 에 직접 쓴 글은 user_id 가 소유자 Discord ID 라 `owner` 기억과
 * 비교되지 않는다 — 코어는 소유자의 Discord ID 를 모른다(봇 설정 ownerUserId 에만 있다).
 */
export function conflictSubjectKey(node: { metadata: Record<string, unknown> }): string {
  const userId = node.metadata.user_id;
  const id = userId === undefined || userId === null ? ""
    : typeof userId === "string" ? userId.trim() : JSON.stringify(userId);
  return id === "" ? OWNER_CONFLICT_SUBJECT : `user:${id}`;
}

/** Pure: should the conflict check run at all for this node? */
export function shouldCheckConflict(
  memoryType: MemoryType,
  author: string,
): boolean {
  return CONFLICT_ELIGIBLE_TYPES.has(memoryType) && author !== "";
}

/** allowedIds 가 undefined 면 모든 행이 허용이다(readMemoryVisibility 계약). */
function visibleIn(allowedIds: ReadonlySet<number> | undefined): (id: number) => boolean {
  return allowedIds === undefined ? () => true : (id) => allowedIds.has(id);
}

/** 충돌 쌍으로 판정된 후보 — 유사도는 contradicts 엣지의 weight 로 남는다. */
interface ConflictPairCandidate {
  node: MemoryNode;
  similarity: number;
}

/** 추출 자식 -> 원문으로 가는 엣지의 관계. */
const ORIGIN_EDGE_RELATION: EdgeRelation = "merged_into";

/**
 * WP-B1-20T T6(설계 5.11, D13) — 충돌 쌍으로 판정된 후보들 사이에서 가려질 원문의 id.
 *
 * 자식 C 와 그 원문 O 가 둘 다 쌍일 때만 O 를 뺀다. C 가 O 본문에서 뽑힌 더 구체적인 현재 주장이라,
 * 새 기억 N 이 O 와 C 둘 다에 contradicts 로 이어져 C 만 supersede 해도 N-O 가 해소되지 않은 채 남는
 * 사례(B1-10S 선택 (i))를 막는다. O 만 쌍이면(C 는 다른 주장) 뺄 이유가 없다 — 실제 충돌이라 잇는다.
 * 엣지 provenance 가 regex 인 쌍(원자 -> 원문)은 보지 않는다: 원자와 원문이 둘 다 쌍이면 둘 다 잇는다.
 * 자기 자신으로 가는 엣지는 원문 관계가 아니라 건너뛴다.
 *
 * 일괄 질의 1회. pairIds 는 이미 FTS 후보 상한(CONFLICT_FTS_CANDIDATE_LIMIT)건 안에서 쌍이 된 후보라 매 check()
 * 호출당 상수 규모다.
 */
function originIdsOfPairedChildren(db: Database, pairIds: readonly number[]): ReadonlySet<number> {
  const placeholders = pairIds.map(() => "?").join(", ");
  const rows = db
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(
      `SELECT DISTINCT target_id FROM knowledge_edges
       WHERE relation = ? AND provenance <> ? AND source_id <> target_id
         AND source_id IN (${placeholders}) AND target_id IN (${placeholders})`,
    )
    .all(ORIGIN_EDGE_RELATION, REGEX_EDGE_PROVENANCE, ...pairIds, ...pairIds) as Array<{ target_id: number }>;
  return new Set(rows.map((row) => row.target_id));
}

export interface ConflictCheckerOptions {
  /** 충돌 sim 하한. 운영은 server 가 모델값 주입. 미전달 시 fallback CONFLICT_SIM_LOW. */
  simLow?: number;
  /** 충돌 sim 상한. 운영은 server 가 모델값 주입. 미전달 시 fallback CONFLICT_SIM_HIGH. */
  simHigh?: number;
  /** superseded 노드 importance 곱수 — 디폴트 IMPORTANCE_DECAY (0.7). */
  importanceDecay?: number;
}

export class ConflictChecker {
  private readonly simLow: number;
  private readonly simHigh: number;
  private vectorReads = 0;
  private edgeReads = 0;

  constructor(
    private readonly store: SqliteMemoryStore,
    opts: ConflictCheckerOptions = {},
  ) {
    this.simLow = opts.simLow ?? CONFLICT_SIM_LOW;
    this.simHigh = opts.simHigh ?? CONFLICT_SIM_HIGH;
  }

  /**
   * 테스트 전용 계수기 — 운영 코드는 읽지 않는다. 이 검사기가 지금까지 한 읽기 횟수(누적)이며, check() 한 번이
   * 후보 벡터 일괄 읽기와 쌍 사이 계보 엣지 일괄 읽기를 각각 몇 번 하는지 호출 전후 값의 차로 고정하는 데 쓴다
   * (설계 5.11 — 후보 수와 무관하게 벡터 1회, 쌍이 둘 이상일 때만 엣지 1회. 설계 17.5 — 제외 수가 늘어도 같다).
   */
  get readCounts(): { vectorReads: number; edgeReads: number } {
    return { vectorReads: this.vectorReads, edgeReads: this.edgeReads };
  }

  /**
   * Check for conflict candidates without choosing which assertion is true.
   *
   * Algorithm: FTS5 narrows the candidate set lexically (cheap) — the FTS window is
   * CONFLICT_FTS_CANDIDATE_LIMIT plus the number of excluded ids, and only the first
   * CONFLICT_FTS_CANDIDATE_LIMIT survivors after exclusion are candidates (설계 17.5) —
   * then vec0 vectors are fetched in one batch and cosine-compared against the
   * new node's vector; isConflictPair decides each pair (moderate band, or
   * the high band for a different writing AI). The high band reuses the same
   * candidate query — no extra scan.
   *
   * @returns The number of newly recorded conflict candidates.
   */
  async check(args: {
    newNodeId: number;
    content: string;
    author: string;
    memoryType: MemoryType;
    newVector: Float32Array;
    projectId?: string | null;
    /**
     * 후보에서 제외할 노드 id — 호출자가 "충돌 후보가 될 수 없다"고 정한 상대:
     *  - 편집 재검사(recheckAfterEdit): supersedes 엣지로 대체 관계가 이미 확정된 상대(명시 대체는
     *    역사적 권위라 유사도로 다시 충돌 후보를 만들지 않는다)와 편집한 기억의 계보(조상·자손).
     *  - 추출(MemoryExtractor.storePrepared, 원문을 먼저 저장하는 계보 저장): 추출 자식은 추출 원문과
     *    그 조상을, 원문 자신의 주장(자기 주장 규칙)은 원문의 계보 전체를 뺀다. 한 글에서 나온
     *    같은 내용이라 서로 반대 주장이 아니다.
     * 미전달 = 제외 없음 — 계보 없이 저장된 기억(추출 계보가 없는 호출)의 검사. 이미 contradicts 엣지가
     * 있는 상대는 INSERT OR IGNORE 가 무시하고 revision 도 올리지 않으므로 따로 제외하지 않는다.
     */
    excludeNodeIds?: ReadonlySet<number>;
    /**
     * 후보의 기본 조회 허용 판정. 추출은 한 건 동안 스냅샷 하나에 이번 추출이 만든 노드를
     * 더한 보기(ExtractionVisibility)를 넘긴다 — 자식마다 전체 스캔을 반복하지 않는다(SL-8).
     * 미전달이면 현재 스냅샷으로 판정한다.
     */
    visibility?: MemoryVisibilityCheck;
  }): Promise<number> {
    return withMemoryMutationLock(this.store, async () => {
    const { newNodeId, content, author, memoryType, newVector } = args;
    const projectId = normalizeProjectId(args.projectId);

    if (!shouldCheckConflict(memoryType, author)) {
      return 0;
    }
    const inputNode = await this.store.getNode(newNodeId);
    if (!inputNode) return 0;
    const inputState = readSharedMemory(inputNode.metadata);
    if (inputState.status !== "active" && inputState.status !== "disputed") return 0;
    let inputRevision = inputState.revision;

    // 창 = 후보 상한 + 제외 집합 크기(제외 집합 ∪ 새 노드 자신). 창 안의 제외 대상은 많아야 그 크기라, FTS 가 그만큼
    // 맞는 행을 가졌다면 거른 뒤 상한 건이 남는다 — 같은 계보가 상위를 채워 바깥의 실제 충돌 상대를 놓치지 않는다
    // (설계 17.5). 상한(cap)은 두지 않는다: 계보가 큰 긴 문서에서 같은 누락이 되살아난다.
    const excluded = args.excludeNodeIds;
    const excludedCount = (excluded?.size ?? 0) + (excluded?.has(newNodeId) ? 0 : 1);
    const ftsResults = await this.store.ftsSearch(content, CONFLICT_FTS_CANDIDATE_LIMIT + excludedCount);
    if (ftsResults.length === 0) return 0;

    const candidateIds = ftsResults
      .map(([nid]) => nid)
      .filter((nid) => nid !== newNodeId && !(excluded?.has(nid) ?? false))
      .slice(0, CONFLICT_FTS_CANDIDATE_LIMIT);
    if (candidateIds.length === 0) return 0;

    const candidates = await this.store.getNodesByIds(candidateIds);
    const subject = conflictSubjectKey(inputNode);
    const isVisible = args.visibility !== undefined
      ? (id: number) => args.visibility!.isAllowed(id)
      : visibleIn(readMemoryVisibility(this.store).allowedIds);
    const prefiltered = candidates.filter(
      (c) =>
        conflictSubjectKey(c) === subject &&
        c.projectId === projectId &&
        c.memoryType === memoryType &&
        isVisible(c.id) &&
        isCurrentMemory(c.metadata) &&
        // 원문 보존 노드(preservedRaw=true)는 충돌 후보에서 제외. 자식 노드들과 의미가
        // 비슷한 건 당연한 일이라(자식이 raw 에서 분해돼 나왔으므로) 매 추출마다 자식이
        // 자기 원문과의 충돌 후보로 disputed 가 되는 일을 막는다.
        c.metadata.preservedRaw !== true,
    );
    if (prefiltered.length === 0) return 0;

    // 사전 필터를 통과한 후보 전부의 벡터를 한 번에 읽고 유사도 판정으로 충돌 쌍을 먼저 가른다. 원문
    // 제외(B1-10S, 설계 5.11)는 이 쌍들 사이에서만 한다 — 판정 전에 빼면 자식이 후보라는 이유만으로
    // 원문과의 실제 충돌을 잃는다.
    this.vectorReads += 1;
    const vectors = await this.store.getVectorsByIds(prefiltered.map((c) => c.id));

    const pairs: ConflictPairCandidate[] = [];
    for (const candidate of prefiltered) {
      const candVec = vectors.get(candidate.id);
      if (!candVec) continue;

      const similarity = cosineSimilarity(newVector, candVec);
      // 작성 AI 는 저장된 새 기억의 author 로 본다 — 추출이 같은 본문 흡수로 기존 노드를 돌려받은
      // 경우에도 쌍의 실제 작성자끼리 비교한다.
      if (!isConflictPair({
        similarity, simLow: this.simLow, simHigh: this.simHigh,
        newAuthor: inputNode.author, newContent: inputNode.content,
        existingAuthor: candidate.author, existingContent: candidate.content,
      })) continue;
      pairs.push({ node: candidate, similarity });
    }

    // WP-B1-10S(Medium 3) → WP-B1-20T T6 — preservedRaw 가 없는 원문(auto_capture)도 후보라, 원문 O 와
    // 그 원문에서 추출된 자식 C 가 둘 다 쌍이면 새 기억 N 이 둘 모두와 contradicts 로 이어져 C 만
    // supersede 해도 N-O 가 해소되지 않은 채 남는다. 둘 다 쌍일 때만 원문을 빼고 자식만 잇는다. 쌍이
    // 둘 미만이면 비교할 쌍이 없어 엣지 질의를 건너뛴다(그 밖에는 check 한 번에 일괄 질의 1회).
    let linkable = pairs;
    if (pairs.length >= 2) {
      this.edgeReads += 1;
      const originIds = originIdsOfPairedChildren(this.store.db, pairs.map((p) => p.node.id));
      if (originIds.size > 0) linkable = pairs.filter((p) => !originIds.has(p.node.id));
    }

    let recorded = 0;

    for (const { node: candidate, similarity: sim } of linkable) {
      const added = this.store.db.transaction(() => {
        const row = this.store.db.query("SELECT * FROM knowledge_nodes WHERE id = ?").get(newNodeId) as KnowledgeNodeRow | null;
        const targetRow = this.store.db.query("SELECT * FROM knowledge_nodes WHERE id = ?").get(candidate.id) as KnowledgeNodeRow | null;
        if (!row || !targetRow) return false;
        const current = rowToNode(row);
        const state = readSharedMemory(current.metadata);
        if (state.revision !== inputRevision || current.content !== inputNode.content ||
            !isCurrentMemory(rowToNode(targetRow).metadata)) return false;
        const inserted = this.store.db.query(`INSERT OR IGNORE INTO knowledge_edges
          (source_id, target_id, relation, provenance, source_node_id, weight, created_at)
          VALUES (?, ?, 'contradicts', 'system', ?, ?, ?)`)
          .run(newNodeId, candidate.id, newNodeId, sim, nowKst());
        if (!inserted.changes) return false;
        this.store.db.query("UPDATE knowledge_nodes SET metadata_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify({ ...current.metadata, sharedMemory: { ...state, status: "disputed", revision: state.revision + 1 } }), nowKst(), newNodeId);
        this.store.db.query(`INSERT INTO memory_revisions
          (old_node_id, new_node_id, revision_type, reason, similarity_score, created_at)
          VALUES (?, ?, 'manual', ?, ?, ?)`)
          .run(candidate.id, newNodeId, `충돌 후보: 유사 ${sim.toFixed(2)} — 명시적 확인 필요`, sim, nowKst());
        inputRevision += 1;
        return true;
      })();
      if (added) { recorded += 1; this.store.nodeRepo.bumpDbRevision(); }
    }

    return recorded;
    });
  }

  /**
   * Legacy supersedes edges are historical authority and never retracted by similarity.
   * 편집한 기억의 계보(조상·자손)도 상대에서 뺀다(WP-B1-20T T6): 추출 자식을 고치면 그 원문이, 원문을
   * 주장 변경 없이 고치면(자식이 철회되지 않고 남는다) 그 자식이 같은 글의 같은 내용이라 반대 주장이
   * 아니다. 저장 경로(extractor)와 같은 계보 규칙이다. 같은 원문의 다른 자식(형제)은 지금처럼 비교한다.
   */
  async recheckAfterEdit(args: {
    nodeId: number;
    content: string;
    author: string;
    memoryType: MemoryType;
    newVector: Float32Array;
    projectId?: string | null;
  }): Promise<{ removed: number; added: number }> {
    const existing = await this.store.getSupersedeEdges(args.nodeId);
    const excludeNodeIds = new Set(existing.map((edge) =>
      edge.sourceId === args.nodeId ? edge.targetId : edge.sourceId));
    for (const lineageId of originWholeLineageSync(this.store.db, args.nodeId)) excludeNodeIds.add(lineageId);
    const added = await this.check({
      ...args, newNodeId: args.nodeId, excludeNodeIds,
    });
    return { removed: 0, added };
  }
}
