/**
 * store-internal/revision-repository.ts — 리비전 이력 CRUD.
 *
 * insertRevision / getRevisionsForNode / listRecentRevisions 세 메서드를
 * SqliteMemoryStore facade 에서 분리했다.
 *
 * 구현부는 옛 store.ts 그대로. RETURNING id 절 포함, nowKst / rowToMemoryRevision 사용.
 */

import type { Database } from "bun:sqlite";
import type { MemoryRevision, RevisionType } from "../../memory/types.ts";
import type { MemoryRevisionRow } from "./row-types.ts";
import { nowKst, rowToMemoryRevision } from "./helpers.ts";
import { inIdBatches, sqlPlaceholders } from "./id-batches.ts";
import { normalizePlatform } from "../../memory/node-sources/source-ref.ts";

/**
 * 영구 삭제된 노드를 가리키는 수정 이력 행을 지운다(WP-B1-20T 설계 15절). 반환: 지운 행 수.
 *
 * memory_revisions 에는 노드 외래 키가 없어 노드가 지워져도 행이 남고, old_content·new_content 에
 * 지운 본문(예: 지운 Discord 메시지의 글)이 그대로 남는다. 노드 id 를 담는 칸은 old_node_id(항상)와
 * new_node_id(대체·충돌 이력의 상대 노드, 없으면 NULL) 둘이다. 두 칸 중 하나라도 영구 삭제된 노드를
 * 가리키면 그 행에 그 노드의 본문이 담겨 있을 수 있으므로 행 전체를 지운다(누가·언제 고쳤다는 사실도
 * 함께 사라진다 — 본문 없이 사실만 남기는 칸이 이 표에 없다).
 *
 * 영구 삭제 통로(출처 삭제, 단건 영구 삭제, 보관 기간 만료 삭제, 메시지 삭제의 보관표 정리)가 노드를
 * 지우는 같은 트랜잭션 안에서 부른다. 휴지통 이동·복원은 부르지 않는다(노드가 되돌아올 수 있다).
 * 전체 초기화(resetAllMemory)는 표를 통째로 비운다. 두 칸 모두 색인(idx_revisions_old·
 * idx_revisions_new)이 있어 묶음마다 색인 조회 두 번이다.
 */
export function deleteRevisionsOfRemovedNodesSync(db: Database, nodeIds: readonly number[]): number {
  let removed = 0;
  for (const batch of inIdBatches([...new Set(nodeIds)])) {
    const list = sqlPlaceholders(batch.length);
    // dynamic SQL: placeholder count varies, keep prepare()
    removed += db
      .prepare(`DELETE FROM memory_revisions WHERE old_node_id IN (${list}) OR new_node_id IN (${list})`)
      .run(...batch, ...batch).changes;
  }
  return removed;
}

/**
 * 외부 메시지가 지워질 때 그 메시지의 동기 수정이 남긴 수정 이력 행의 본문을 지운다(WP-B1-20U 설계 17.6, 사용자
 * 결정 1). 반환: 바꾼 행 수.
 *
 * source_message_id·source_platform 은 PATCH by-source 의 같은 id 수정과 분리 이력만 적는다. 메시지 삭제
 * (deleteBySource)가 노드 영구 삭제·보관표 정리 뒤 같은 트랜잭션에서 부른다. 영구 삭제된 노드의 행은 이미
 * deleteRevisionsOfRemovedNodesSync 가 통째로 지웠으므로, 여기 닿는 것은 다른 출처로 살아 남은 노드와 휴지통에
 * 남은 노드의 행뿐이다. old_content·new_content 와 두 메시지 칸을 비우고, 누가·언제·왜(editor·edit_source·
 * reason·created_at)와 노드 id·종류는 남긴다 — 메시지 칸도 비워 지운 메시지를 더는 가리키지 않게 한다.
 *
 * 플랫폼 일치 규칙은 출처 행 조회(NodeSourceRepository.findMessageSync)와 같다: platform 이 없으면 플랫폼 무관,
 * 있으면 정규화(소문자·trim)한 같은 플랫폼만, 저장 플랫폼이 NULL 인 행은 플랫폼 준 조회에 걸리지 않는다.
 * 부분 색인 idx_revisions_source_message(v45)를 타는 메시지별 UPDATE 한 번이다.
 */
export function clearMessageRevisionBodiesSync(db: Database, messageId: string, platform: string | null): number {
  const match = messageRevisionMatch(messageId, platform);
  return db
    .query(
      `UPDATE memory_revisions
       SET old_content = NULL, new_content = NULL, source_message_id = NULL, source_platform = NULL
       WHERE ${match.where}`,
    )
    .run(...match.params).changes;
}

/** 한 메시지의 동기 수정이 남긴 수정 이력 행 — 행 id 와 그 수정이 고친 노드(old_node_id). */
export interface MessageEditRevision {
  id: number;
  oldNodeId: number;
}

/**
 * 한 메시지의 동기 수정이 남긴 수정 이력 행(id 오름차순, WP-B1-20U 설계 17.7). 메시지 삭제가 clearMessageRevisionBodiesSync
 * 로 메시지 칸을 비우기 전에, 같은 트랜잭션에서 그 메시지의 수정이 철회한 옛 파생을 찾으려고 부른다. 일치 규칙과 색인은
 * clearMessageRevisionBodiesSync 와 같다.
 */
export function listMessageEditRevisionsSync(db: Database, messageId: string, platform: string | null): MessageEditRevision[] {
  const match = messageRevisionMatch(messageId, platform);
  return db
    .query(`SELECT id, old_node_id AS oldNodeId FROM memory_revisions WHERE ${match.where} ORDER BY id`)
    .all(...match.params) as MessageEditRevision[];
}

/** 한 메시지의 동기 수정 이력 행을 고르는 조건 — 위 두 함수가 같은 플랫폼 일치 규칙을 쓰게 한 곳에 둔다. */
function messageRevisionMatch(messageId: string, platform: string | null): { where: string; params: string[] } {
  const wanted = normalizePlatform(platform);
  return wanted === null
    ? { where: "source_message_id = ?", params: [messageId] }
    : { where: "source_message_id = ? AND source_platform = ?", params: [messageId, wanted] };
}

export class RevisionRepository {
  constructor(private readonly db: Database) {}

  /**
   * 새 revision 행 추가 후 id 반환.
   *
   * revision 생성 경로:
   * - manual: REST/봇 명령 (사용자)
   * - evolution: evolver 사이클 (자동)
   * - duplicate_merge: dedup 흡수 (extractor)
   *
   * newNodeId=null 은 순수 비활성화 (supersede 대상 없이 archive).
   * SQLite RETURNING 절로 id 회수 — last_insert_rowid 분리 호출 회피.
   */
  async insertRevision(args: {
    oldNodeId: number;
    newNodeId: number | null;
    revisionType: RevisionType;
    reason?: string | null;
    similarityScore?: number | null;
    oldContent?: string | null;
    newContent?: string | null;
    editor?: string | null;
    editSource?: string | null;
  }): Promise<number> {
    const result = this.db
      .query(
        `INSERT INTO memory_revisions
          (old_node_id, new_node_id, revision_type, reason,
           similarity_score, old_content, new_content, editor, edit_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        args.oldNodeId,
        args.newNodeId,
        args.revisionType,
        args.reason ?? null,
        args.similarityScore ?? null,
        args.oldContent ?? null,
        args.newContent ?? null,
        args.editor ?? null,
        args.editSource ?? null,
        nowKst(),
      ) as { id: number };
    return result.id;
  }

  /**
   * 한 노드와 관련된 모든 revision. old_node_id 또는 new_node_id 양쪽 매칭.
   * 시간 역순 (최근 변경 먼저).
   */
  async getRevisionsForNode(nodeId: number): Promise<MemoryRevision[]> {
    const rows = this.db
      .query(
        `SELECT * FROM memory_revisions
         WHERE old_node_id = ? OR new_node_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(nodeId, nodeId) as MemoryRevisionRow[];
    return rows.map(rowToMemoryRevision);
  }

  /**
   * 최근 revision 목록. 대시보드 활동 섹션 / 운영 디버깅용.
   * since 와 revisionType 모두 선택. limit 기본 100, 상한 500.
   */
  async listRecentRevisions(
    options: {
      since?: string;
      revisionType?: RevisionType;
      limit?: number;
    } = {},
  ): Promise<MemoryRevision[]> {
    const limit = Math.min(options.limit ?? 100, 500);
    let sql = "SELECT * FROM memory_revisions";
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (options.since) {
      conditions.push("created_at >= ?");
      params.push(options.since);
    }
    if (options.revisionType) {
      conditions.push("revision_type = ?");
      params.push(options.revisionType);
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
    params.push(limit);
    // dynamic SQL: placeholder count varies, keep prepare()
    const rows = this.db.prepare(sql).all(...params) as MemoryRevisionRow[];
    return rows.map(rowToMemoryRevision);
  }
}
