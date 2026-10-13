/**
 * store-internal/node-repo-read-mixin.ts — 노드 조회·후보 선별 묶음
 * (P3 G5-a 분해 — 옛 node-repository.ts 에서 이동, 내용 무변경).
 *
 * 단건/목록 조회와 backfill 스케줄러 후보 선별(getBackfillCandidates·
 * getUncaptionedImageCandidates)을 담는다. 전부 읽기 전용 — dbRevision 무접촉.
 */

import type { MemoryNode } from "../../memory/types.ts";
import { readMemoryVisibilityFromDatabase } from "../../memory/shared-memory-read.ts";
import type { KnowledgeNodeRow } from "./row-types.ts";
import { rowToNode } from "./helpers.ts";
import type { Constructor, NodeRepoInternals } from "./node-repo-base.ts";
import {
  activeChunkSql,
  backfillEligibilitySql,
  extractionPendingSql,
  lineageInvalidatedChunkSql,
} from "./extraction-state-sql.ts";

/** 백필 후보 조회의 노드 별칭 — 추출 상태 SQL 조각이 이 별칭으로 행을 가리킨다. */
const CANDIDATE_ALIAS = "candidate";
const ELIGIBLE_BY_ID_SQL = `SELECT 1 FROM knowledge_nodes ${CANDIDATE_ALIAS}
  WHERE ${CANDIDATE_ALIAS}.id = ? AND ${backfillEligibilitySql(CANDIDATE_ALIAS)}`;
const ORIGIN_CHUNK_STATE_SQL = `SELECT
    ${extractionPendingSql(CANDIDATE_ALIAS)} AS pending,
    ${activeChunkSql(CANDIDATE_ALIAS)} AS active_chunk,
    ${lineageInvalidatedChunkSql(CANDIDATE_ALIAS)} AS invalidated_chunk
  FROM knowledge_nodes ${CANDIDATE_ALIAS} WHERE ${CANDIDATE_ALIAS}.id = ?`;
const AWAITING_AUTO_CAPTION_SQL =
  "SELECT 1 FROM images WHERE asset_sha256 = ? AND has_caption_auto = 0";

/** 편집 뒤 재청크 판단 재료 — 원문 한 건의 추출 대기 표시와 청크 자식 상태. */
export interface OriginChunkState {
  /** metadata.extracted = 0 — 본문 주장이 바뀌어 추출을 기다린다. */
  pending: boolean;
  /** active 청크 자식(parent_of)이 있다 — 청크가 현재 본문을 나타낸다. */
  activeChunk: boolean;
  /** 계보 무효화로 철회된 청크 자식이 있다 — 편집·철회가 옛 청크를 거뒀다. */
  invalidatedChunk: boolean;
}

export function NodeRepoReadMixin<
  TBase extends Constructor<NodeRepoInternals>,
>(Base: TBase) {
  return class NodeRepoReadMixed extends Base {
    async getNode(id: number): Promise<MemoryNode | null> {
      const row = this.db
        .query("SELECT * FROM knowledge_nodes WHERE id = ?")
        .get(id) as KnowledgeNodeRow | null;
      return row ? rowToNode(row) : null;
    }

    async getNodesByIds(ids: readonly number[]): Promise<MemoryNode[]> {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(",");
      const rows = this.db
        // dynamic SQL: placeholder count varies, keep prepare()
        .prepare(`SELECT * FROM knowledge_nodes WHERE id IN (${placeholders})`)
        .all(...ids) as KnowledgeNodeRow[];
      return rows.map(rowToNode);
    }

    /**
     * 자산 글(메모리) 목록을 삽입 순서(id ASC)로 반환. 1.0b 이후 knowledge_nodes
     * 에는 자산 글만 남으므로 옛 isConcept 분기는 제거됐다(개념은 concept_nodes).
     */
    async listMemoryNodes(options: { limit?: number } = {}): Promise<MemoryNode[]> {
      const limit = Math.min(options.limit ?? 500, 5000);
      const rows = this.db
        .query("SELECT * FROM knowledge_nodes ORDER BY id ASC LIMIT ?")
        .all(limit) as KnowledgeNodeRow[];
      return rows.map(rowToNode);
    }

    /**
     * Most-recently-created nodes, newest first. Ties on `created_at`
     * (SQLite's `datetime('now', 'localtime')` has only second-level precision, so
     * bursts of insertions share a timestamp) are broken by descending id —
     * i.e. the most recently allocated rowid wins.
     *
     * 입력 통로 통합 Task 4 (spec §5 / D8) — 최근 목록에는 원본만 대표로 노출한다.
     * 자식 종류 노드(document_chunk·llm_extract·image_caption)는 제외해 같은 글이 청크·
     * atomic 추출·캡션으로 여러 줄 보이는 도배를 막는다. 원본 종류(auto_capture·document·
     * image_asset·user_explicit)는 노출 유지 — source_type 으로 판정하므로 엣지 조회가
     * 없다(getBackfillCandidates 의 merged_into 엣지 dedup 과는 별개 판정 기준 / Task 3 확정).
     */
    async getRecent(limit: number): Promise<MemoryNode[]> {
      if (limit <= 0) return [];
      const rows = this.db
        .query(
          `SELECT * FROM knowledge_nodes
           WHERE source_type NOT IN ('document_chunk', 'llm_extract', 'image_caption')
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(limit) as KnowledgeNodeRow[];
      return rows.map(rowToNode);
    }

    /**
     * 프로젝트 노드 D2 — 한 프로젝트(project_id)에 속한 글을 최신순으로 돌려준다.
     * 그래프 조립이 프로젝트 → 글 `owns_memory` 허브 선을 그릴 입력이다(표시 전용 읽기).
     *
     * 자식 종류(document_chunk·llm_extract·image_caption)는 getRecent 선례대로 제외해
     * 같은 글이 청크·atomic 추출·캡션으로 여러 줄 허브에 매달리는 도배를 막는다.
     * idx_knowledge_nodes_project 인덱스를 타고 created_at DESC, id DESC 로 최신을 앞세운다.
     *
     * 검색·RRF 와 무관하다. 이름이 검색 채널의 getNodesByProjectId(search-repository.ts·id
     * 배열 반환·RRF 1-hop)와 갈린 것은 의도다 — 그 함수는 그대로 두고 여기는 자식을
     * 거른 MemoryNode 목록을 그래프 표시용으로 돌려준다.
     *
     * limit≤0·빈 projectId·없는 프로젝트는 빈 배열(가짜 0 아닌 정직한 빈 결과).
     */
    async getProjectMemberNodes(
      projectId: string,
      limit: number,
    ): Promise<MemoryNode[]> {
      if (limit <= 0 || projectId === "") return [];
      const rows = this.db
        .query(
          `SELECT * FROM knowledge_nodes
           WHERE project_id = ?
             AND source_type NOT IN ('document_chunk', 'llm_extract', 'image_caption')
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(projectId, limit) as KnowledgeNodeRow[];
      return rows.map(rowToNode);
    }

    /** Count of nodes with `created_at > since` (ISO timestamp). */
    async countNodesSince(since: string): Promise<number> {
      const row = this.db
        .query(
          "SELECT COUNT(*) AS c FROM knowledge_nodes WHERE created_at > ?",
        )
        .get(since) as { c: number };
      return row.c;
    }

    /**
     * 전체 노드를 삽입 순서(id ASC)로 반환. evolver 사이클이 호출하는 메서드.
     * 운영 DB 크기를 고려해 limit를 항상 명시할 것.
     */
    async getAllNodes(limit: number = 10_000): Promise<MemoryNode[]> {
      const rows = this.db
        .query("SELECT * FROM knowledge_nodes ORDER BY id ASC LIMIT ?")
        .all(limit) as KnowledgeNodeRow[];
      return rows.map(rowToNode);
    }

    /**
     * id > afterId 인 노드를 id ASC 로 limit 개 반환 — 전량 순회 페이지 통로.
     * 자동 정리(runAutoCleanup)가 getAllNodes(10_000) 상한으로 1만 초과 노드를
     * 조용히 건너뛰던 구멍을 막는 keyset 페이지네이션(2026-07 감사 High).
     * afterId=0 이 첫 페이지, 마지막 페이지의 끝 id 를 다음 afterId 로 잇는다.
     * limit ≤ 0 은 빈 배열(순회 종료 신호와 동일한 정직한 빈 결과).
     */
    async getNodesAfterId(afterId: number, limit: number): Promise<MemoryNode[]> {
      if (limit <= 0) return [];
      const rows = this.db
        .query(
          "SELECT * FROM knowledge_nodes WHERE id > ? ORDER BY id ASC LIMIT ?",
        )
        .all(afterId, limit) as KnowledgeNodeRow[];
      return rows.map(rowToNode);
    }

    /**
     * 추출 대상 노드를 조회. raw 메모리(`source_type='auto_capture'`, 짧은 글·봇
     * 입력)와 긴 글·문서의 검색용 청크(`source_type='document_chunk'`)를 함께
     * 줍는다. extractor 가 차례로 처리해 atomic 자식으로 세분화한다.
     *
     * 입력 통로 통합 Task 5 (spec §4 / D5·D6 / P1 확정) — 긴 문서는 통째 추출하면
     * Ollama 컨텍스트 윈도우를 넘어 뒷부분이 잘리므로, 청크가 추출 단위다. 원본
     * 노드(청크를 가진 긴 글의 부모)는 추출 입력으로 줍지 않는다(보존만) — 청크가
     * 이미 원문 전체를 한도 이하 묶음으로 나눠 담고 있다.
     *
     * 미추출 판정 = **metadata 플래그**(P1 확정). 청크 자식은 `parent_of`(청크→원본)
     * 엣지로, atomic 추출 자식은 `merged_into`(atomic→청크/raw) 엣지로 연결되므로,
     * 추출 완료를 엣지 relation 으로 판정하면 두 relation 을 혼동한다. 그래서 추출
     * 완료는 노드 metadata 의 `extracted:true` 또는 `extractedTo` 칸(scheduler 가
     * 추출 직후 기록, immediate 경로는 addNode 시점에 기록)으로만 판정한다.
     *
     * Phase 5.6 W5 dedup(2026-05-20)도 보조로 유지 — 옛 immediate 경로 raw 는
     * metadata.extractedTo 와 함께 atomic 자식 merged_into 엣지도 갖는다. 두 신호 중
     * 하나라도 있으면 이미 처리된 것이라 후보에서 빠진다(같은 raw 가 매 사이클 다시
     * 잡혀 hashtag wiring 이 22~24 회 누적되던 옛 bug 차단).
     *
     * SL-2 — 편집으로 본문 주장이 바뀐 원문(extracted = 0 대기)과, 추출 자식이 모두 계보
     * 무효화로 철회된 원문은 다시 후보가 된다. 판정 조각의 단일 출처와 상태 표시 설명은
     * extraction-state-sql.ts. 저장 행은 읽기만 한다.
     *
     * @param opts.limit          한 호출당 최대 갯수.
     * @param opts.since          ISO 시각 — 본 시점 이후 created_at 만.
     * @param opts.minImportance  importance 하한 (낮은 importance 는 노이즈
     *                            가능성 → 백필 우선순위 낮음).
     */
    async getBackfillCandidates(opts: {
      limit: number;
      since?: string;
      minImportance?: number;
    }): Promise<MemoryNode[]> {
      if (opts.limit <= 0) return [];
      const conditions: string[] = [backfillEligibilitySql(CANDIDATE_ALIAS)];
      const params: Array<string | number> = [];
      if (opts.since) {
        conditions.push(`${CANDIDATE_ALIAS}.created_at >= ?`);
        params.push(opts.since);
      }
      if (typeof opts.minImportance === "number") {
        conditions.push(`${CANDIDATE_ALIAS}.importance >= ?`);
        params.push(opts.minImportance);
      }
      const where = conditions.join(" AND ");
      const visible = readMemoryVisibilityFromDatabase(this.db).allowedIds;
      const rows = this.db
        // dynamic SQL: placeholder count varies, keep prepare()
        .prepare(
          `SELECT ${CANDIDATE_ALIAS}.* FROM knowledge_nodes ${CANDIDATE_ALIAS}
           WHERE ${where}
           ORDER BY ${CANDIDATE_ALIAS}.created_at ASC, ${CANDIDATE_ALIAS}.id ASC`,
        )
        .iterate(...params) as Iterable<KnowledgeNodeRow>;
      const current: MemoryNode[] = [];
      for (const row of rows) {
        const node = rowToNode(row);
        if (visible !== undefined && !visible.has(node.id)) continue;
        current.push(node);
        if (current.length >= opts.limit) break;
      }
      return current;
    }

    /**
     * 한 노드가 지금 백필 추출 후보의 구조 조건(종류·추출 상태·청크·문서 파싱 상태)을
     * 만족하는가. getBackfillCandidates 와 같은 SQL 조각이다. 가시성·since·minImportance 는
     * 보지 않는다 — 백필이 잠금 안에서 후보를 다시 확인할 때 가시성은 따로 본다(WP-B1-07).
     */
    isBackfillCandidateEligible(id: number): boolean {
      return this.db.query(ELIGIBLE_BY_ID_SQL).get(id) !== null;
    }

    /**
     * 이 자산의 이미지가 아직 자동 캡션을 기다리는가(images.has_caption_auto = 0). 비전 백필이
     * 잠금 밖 VLM 호출 뒤 잠금 안에서 저장 직전에 다시 확인한다 — 그 사이 다른 흐름이 캡션을
     * 달았으면 저장하지 않는다(WP-B1-07). images 행이 없으면 false.
     */
    isImageAwaitingAutoCaption(assetSha256: string): boolean {
      return this.db.query(AWAITING_AUTO_CAPTION_SQL).get(assetSha256) !== null;
    }

    /** 원문 한 건의 추출 대기 표시와 청크 자식 상태. 노드가 없으면 null. */
    getOriginChunkState(id: number): OriginChunkState | null {
      const row = this.db.query(ORIGIN_CHUNK_STATE_SQL).get(id) as {
        pending: number;
        active_chunk: number;
        invalidated_chunk: number;
      } | null;
      if (row === null) return null;
      return {
        pending: row.pending === 1,
        activeChunk: row.active_chunk === 1,
        invalidatedChunk: row.invalidated_chunk === 1,
      };
    }

    /**
     * Phase 11e G2-3 (T7 / DCL-1) — VLM 캡션이 아직 없는 image_asset 후보를 조회.
     *
     * backfill 스케줄러(vision 갈래)가 주기마다 줍는 후보 묶음. extractor 의
     * `getBackfillCandidates` 가 raw 노드를 importance 기준으로 줍는 것과 같은 정신이되,
     * 이미지는 importance 가 부적합하므로 후보 기준이 다르다(DCL-1):
     *   - `images.has_caption_auto = 0` (자동 캡션 자식 노드가 아직 없는 이미지)
     *   - `created_at ASC` (먼저 들어온 것부터 — 오래된 미캡션 우선)
     *   - `LIMIT batchSize`
     *
     * 신규 업로드 미캡션(mode='backfill' 이라 업로드 통로가 캡션을 건너뛴 것)과 기존
     * 미캡션(옛 D2 소급 대상)이 같은 `has_caption_auto=0` 풀로 흡수된다 — 별도 일회성
     * 도구 불필요(spec §10.4).
     *
     * 조회 양식은 re-embed-images.ts `listImageAssets` 의 join 선례 정합 — image_asset
     * 노드(`knowledge_nodes`)를 `images` 테이블과 `metadata_json.asset_sha256` 으로
     * join 해 `images.mime`(보존 모드 통과 후 실 저장 자산 mime) 권위를 회수한다.
     * mime 권위는 한 곳(`images.mime`) — AssetStore.read 의 ext 도, VLM 호출 mime 도
     * 이 값에서 나온다.
     *
     * metadata.asset_sha256 또는 images row 가 부재한 손상 노드는 join 에서 자연
     * 탈락한다(INNER JOIN). 손상 노드는 후보가 아니라서 조회 결과에 안 나오고, 그래서
     * 스케줄러도 그 노드는 건드리지 않는다(silent fallback 아님 — has_caption_auto 토대
     * 자체가 images row 부재면 갱신 대상이 없는 자연 귀결).
     *
     * @param opts.limit  한 호출당 최대 후보 수 (batchSize).
     */
    getUncaptionedImageCandidates(opts: {
      limit: number;
    }): Array<{ nodeId: number; assetSha256: string; mime: string }> {
      if (opts.limit <= 0) return [];
      const visible = readMemoryVisibilityFromDatabase(this.db).allowedIds;
      const rows = this.db
        .query(
          `SELECT kn.id AS node_id,
                  json_extract(kn.metadata_json, '$.asset_sha256') AS sha256,
                  img.mime AS mime,
                  kn.metadata_json AS metadata_json
             FROM knowledge_nodes kn
             JOIN images img
               ON img.asset_sha256 = json_extract(kn.metadata_json, '$.asset_sha256')
            WHERE kn.source_type = 'image_asset'
              AND img.has_caption_auto = 0
            ORDER BY img.created_at ASC, kn.id ASC`,
        )
        .iterate() as Iterable<{
        node_id: number;
        sha256: string | null;
        mime: string | null;
        metadata_json: string;
      }>;

      const out: Array<{ nodeId: number; assetSha256: string; mime: string }> = [];
      for (const row of rows) {
        if (visible !== undefined && !visible.has(row.node_id)) continue;
        if (!row.sha256 || !row.mime) {
          // image_asset 노드인데 metadata.asset_sha256 또는 images.mime 부재 —
          // 옛 데이터 손상. 명시 warn + skip (silent fallback 금지 / re-embed 선례 정합).
          console.warn(
            `[vision-backfill] image_asset 노드 ${row.node_id} — metadata.asset_sha256 또는 mime 부재, skip`,
          );
          continue;
        }
        out.push({
          nodeId: row.node_id,
          assetSha256: row.sha256,
          mime: row.mime,
        });
        if (out.length >= opts.limit) break;
      }
      return out;
    }
  };
}
