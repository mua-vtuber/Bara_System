/**
 * store-internal/node-source-repository.ts — 기억 노드 출처 목록 표(memory_node_sources, 보관표 쪽
 * memory_node_sources_archive)의 읽기·쓰기(WP-B1-20T 설계 6.1).
 *
 * 출처 종류·키·입력 판정은 memory/node-sources/source-ref.ts 한 곳이 정하고, 이 저장소는 그 행을
 * 넣고·찾고·보관표로 옮기고·되살리고·메시지 삭제 때 보관표를 정리한다. 이름이 Sync 로 끝나는 메서드는
 * 동기이고 호출자의 트랜잭션·쓰기 잠금 안에서 부른다. 여러 문장을 쓰는 메서드는 스스로도 트랜잭션으로
 * 묶는다 — 단독으로 불려도 반쪽만 쓰이지 않고, 바깥 트랜잭션 안에서는 bun:sqlite 가 저장점으로 중첩한다.
 *
 * 플랫폼 인자: null(또는 빈 문자열)이면 플랫폼 무관, 값이 있으면 소문자·trim 정규화 뒤 같은 플랫폼만.
 * 저장 행의 platform 이 NULL(모름)이면 플랫폼을 준 조회에는 걸리지 않는다(옛 일치 규칙과 같음).
 */

import type { Database } from "bun:sqlite";
import {
  ARCHIVED_LINEAGE_KIND,
  archivedLineageKeyOf,
  normalizePlatform,
  restoreSourceRef,
  sourceKeyOf,
  type ArchivedNodeSourceKind,
  type NodeSourceRef,
} from "../../memory/node-sources/source-ref.ts";
import { nowKst } from "./helpers.ts";
import { inIdBatches, sqlPlaceholders } from "./id-batches.ts";
import { REMOVED_HOLDER_RETURNING, type RemovedAssetHolders, type RemovedNodeRow } from "./asset-release.ts";

const LIVE_TABLE = "memory_node_sources";
const ARCHIVE_TABLE = "memory_node_sources_archive";
type SourceTable = typeof LIVE_TABLE | typeof ARCHIVE_TABLE;

const SOURCE_COLUMNS = "node_id, source_key, kind, platform, external_id, detail_json, created_at";

export interface NodeSourceRow {
  nodeId: number;
  key: string;
  kind: ArchivedNodeSourceKind;
  platform: string | null;
  externalId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

interface SourceRecord {
  node_id: number;
  source_key: string;
  kind: ArchivedNodeSourceKind;
  platform: string | null;
  external_id: string | null;
  detail_json: string;
  created_at: string;
}

/**
 * detail_json 은 이 저장소만 JSON.stringify 로 쓰는 칸이다. 객체가 아니면 손상이라 빈 값으로 덮지 않고
 * 어느 행인지 밝혀 멈춘다.
 */
function parseDetail(table: SourceTable, record: SourceRecord): Record<string, unknown> {
  const where = `${table} 행(node_id=${record.node_id}, source_key=${record.source_key})`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.detail_json);
  } catch (error) {
    throw new Error(`${where}의 detail_json 을 JSON 으로 읽을 수 없습니다`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${where}의 detail_json 이 JSON 객체가 아닙니다`);
  }
  return parsed as Record<string, unknown>;
}

/** detail 의 문자열 칸(없거나 다른 모양이면 뺀다 — 표시·감사용 칸이라 판정에 쓰지 않는다). */
function detailString(
  detail: Record<string, unknown>,
  key: "attachmentId" | "channel" | "actor" | "reason",
): string | undefined {
  const value = detail[key];
  return typeof value === "string" ? value : undefined;
}

/** detail 의 id 칸(문자열 또는 null). 칸이 없거나 다른 모양이면 undefined. */
function detailId(detail: Record<string, unknown>, key: "channelId" | "guildId"): string | null | undefined {
  const value = detail[key];
  return typeof value === "string" || value === null ? value : undefined;
}

/**
 * 살아 있는 표의 message 행을 같은 출처 참조로 되돌린다 — 메시지 수정 분리(설계 5.6)가 새 노드에 "이
 * 메시지" 출처를 줄 때 쓴다. 키·플랫폼·메시지 id 는 행 그대로라 뒤의 삭제 조회가 새 노드를 같은 메시지로
 * 찾는다. 첨부 행이면 detail 의 attachmentId 를 옮기고, 칸 값(플랫폼·메시지 id·첨부 id)으로 키를 다시 만들어
 * 행의 키와 맞는지 확인한다(WP-B1-20U 설계 17.8). message 가 아닌 행과 키가 어긋난 행은 멈춘다.
 */
export function messageSourceRefOfRow(row: NodeSourceRow): NodeSourceRef {
  if (row.kind !== "message") {
    throw new Error(`출처 행(node_id=${row.nodeId}, source_key=${row.key})은 message 종류가 아니라 ${row.kind} 입니다`);
  }
  const detail: NodeSourceRef["detail"] = {};
  const channelId = detailId(row.detail, "channelId");
  const guildId = detailId(row.detail, "guildId");
  const attachmentId = detailString(row.detail, "attachmentId");
  const channel = detailString(row.detail, "channel");
  const actor = detailString(row.detail, "actor");
  const reason = detailString(row.detail, "reason");
  if (channelId !== undefined) detail.channelId = channelId;
  if (guildId !== undefined) detail.guildId = guildId;
  if (attachmentId !== undefined) detail.attachmentId = attachmentId;
  if (channel !== undefined) detail.channel = channel;
  if (actor !== undefined) detail.actor = actor;
  if (reason !== undefined) detail.reason = reason;
  const ref: NodeSourceRef = { kind: "message", key: row.key, platform: row.platform, externalId: row.externalId, detail };
  assertMessageRefConsistent(ref);
  return ref;
}

/**
 * 메시지 행이 그 메시지의 글 행인가(첨부 id 없는 키, WP-B1-20U 설계 17.8). 행의 플랫폼으로 글 행 키를 만들어
 * 비교한다 — 키 문자열을 쪼개 읽지 않는다. 같은 메시지의 첨부 행은 false.
 */
export function isMessageTextRow(row: { key: string; platform: string | null }, messageId: string): boolean {
  return row.key === sourceKeyOf({ kind: "message", platform: row.platform, messageId });
}

function toRow(table: SourceTable, record: SourceRecord): NodeSourceRow {
  return {
    nodeId: record.node_id,
    key: record.source_key,
    kind: record.kind,
    platform: record.platform,
    externalId: record.external_id,
    detail: parseDetail(table, record),
    createdAt: record.created_at,
  };
}

/**
 * message 행은 삭제 조회(kind·external_id·platform 칸)와 재전송 판정(키)이 같은 메시지를 가리켜야 한다.
 * 두 쪽이 어긋난 참조(손으로 만든 키, 정규화 안 한 플랫폼, detail 의 첨부 id 와 다른 키)는 조용히 넣지 않고 멈춘다.
 */
function assertMessageRefConsistent(ref: NodeSourceRef): void {
  if (ref.kind !== "message") return;
  if (ref.externalId === null) {
    throw new Error(`message 출처(${ref.key})에 externalId(messageId)가 없습니다`);
  }
  if (ref.platform !== normalizePlatform(ref.platform)) {
    throw new Error(`message 출처(${ref.key})의 platform '${ref.platform}' 이 정규화(소문자·trim)되지 않았습니다`);
  }
  const expected = sourceKeyOf({
    kind: "message", platform: ref.platform, messageId: ref.externalId, attachmentId: ref.detail.attachmentId,
  });
  if (ref.key !== expected) {
    throw new Error(`message 출처 키 '${ref.key}' 가 칸 값으로 만든 키 '${expected}' 와 다릅니다`);
  }
}

export class NodeSourceRepository {
  constructor(private readonly db: Database) {}

  /** 행 1개. 새로 들어갔으면 true, 같은 (노드, 키)가 이미 있으면 false(아무것도 바꾸지 않음). */
  insertSync(nodeId: number, ref: NodeSourceRef): boolean {
    assertMessageRefConsistent(ref);
    const result = this.db
      .query(`INSERT OR IGNORE INTO ${LIVE_TABLE} (${SOURCE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(nodeId, ref.key, ref.kind, ref.platform, ref.externalId, JSON.stringify(ref.detail), nowKst());
    return result.changes > 0;
  }

  /** 노드 묶음의 행(500개씩 IN). 요청한 id 마다 항목이 있고, 행이 없는 노드는 빈 목록이다. */
  listSync(nodeIds: readonly number[]): Map<number, NodeSourceRow[]> {
    const out = new Map<number, NodeSourceRow[]>();
    for (const id of nodeIds) if (!out.has(id)) out.set(id, []);
    for (const batch of inIdBatches([...out.keys()])) {
      // dynamic SQL: placeholder count varies, keep prepare()
      const records = this.db
        .prepare(
          `SELECT ${SOURCE_COLUMNS} FROM ${LIVE_TABLE}
           WHERE node_id IN (${sqlPlaceholders(batch.length)})
           ORDER BY node_id, source_key`,
        )
        .all(...batch) as SourceRecord[];
      for (const record of records) out.get(record.node_id)!.push(toRow(LIVE_TABLE, record));
    }
    return out;
  }

  /**
   * 메시지 행 찾기 — 글 행과 첨부 행 모두. platform 이 null 이면 플랫폼 무관, 값이 있으면 같은 플랫폼만. 노드 id
   * 오름차순. 행의 platform 도 돌려준다 — 글 행인지 가릴 때 그 플랫폼으로 키를 만들어 비교한다(isMessageTextRow).
   */
  findMessageSync(
    messageId: string,
    platform: string | null,
  ): Array<{ nodeId: number; key: string; platform: string | null }> {
    return this.findMessageRows(LIVE_TABLE, messageId, platform);
  }

  /**
   * 보관 출처 표(휴지통 노드)의 메시지 행 찾기 — 일치 규칙은 findMessageSync 와 같다. 메시지 수정에서 뺀 첨부
   * (WP-B1-20U 설계 17.9)가 휴지통에 있는 첨부 노드의 행도 고르는 데 쓴다.
   */
  findArchivedMessageSync(
    messageId: string,
    platform: string | null,
  ): Array<{ nodeId: number; key: string; platform: string | null }> {
    return this.findMessageRows(ARCHIVE_TABLE, messageId, platform);
  }

  private findMessageRows(
    table: SourceTable,
    messageId: string,
    platform: string | null,
  ): Array<{ nodeId: number; key: string; platform: string | null }> {
    const wanted = normalizePlatform(platform);
    const records = (
      wanted === null
        ? this.db
            .query(
              `SELECT node_id, source_key, platform FROM ${table}
               WHERE kind = 'message' AND external_id = ? ORDER BY node_id, source_key`,
            )
            .all(messageId)
        : this.db
            .query(
              `SELECT node_id, source_key, platform FROM ${table}
               WHERE kind = 'message' AND external_id = ? AND platform = ? ORDER BY node_id, source_key`,
            )
            .all(messageId, wanted)
    ) as Array<{ node_id: number; source_key: string; platform: string | null }>;
    return records.map((record) => ({ nodeId: record.node_id, key: record.source_key, platform: record.platform }));
  }

  deleteSync(nodeId: number, key: string): void {
    this.db.query(`DELETE FROM ${LIVE_TABLE} WHERE node_id = ? AND source_key = ?`).run(nodeId, key);
  }

  /**
   * 한 행을 다른 노드로 옮긴다(메시지 수정 분리, 설계 5.6). 대상 노드에 같은 키가 이미 있으면 그 행을 두고
   * 원래 노드의 행만 지운다. 원래 노드에 그 키가 없으면 멈춘다 — 옮길 출처가 없는데 옮긴 것처럼 넘어가지 않게.
   */
  moveRowSync(fromNodeId: number, toNodeId: number, key: string): void {
    if (fromNodeId === toNodeId) {
      throw new Error(`moveRowSync: 출처 행(${key})을 같은 노드 ${fromNodeId} 로 옮길 수 없습니다`);
    }
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT OR IGNORE INTO ${LIVE_TABLE} (${SOURCE_COLUMNS})
           SELECT ?, source_key, kind, platform, external_id, detail_json, created_at
           FROM ${LIVE_TABLE} WHERE node_id = ? AND source_key = ?`,
        )
        .run(toNodeId, fromNodeId, key);
      const removed = this.db
        .query(`DELETE FROM ${LIVE_TABLE} WHERE node_id = ? AND source_key = ?`)
        .run(fromNodeId, key);
      if (removed.changes === 0) {
        throw new Error(`moveRowSync: 노드 ${fromNodeId} 에 출처 행(${key})이 없습니다`);
      }
    })();
  }

  /**
   * 휴지통 이동: nodeIds 의 출처 행을 보관 출처 표로 옮기고, lineageParents 에 든 노드마다 그 순간의 계보
   * 부모 id 를 archived_lineage 행(external_id = 부모 id)으로 남긴다. knowledge_nodes_archive 에 그 노드 행이
   * 먼저 있어야 한다(외래 키). 계보 부모를 받은 노드는 nodeIds 안에 있어야 하고, 자기 자신을 부모로 둘 수 없다.
   */
  moveToArchiveSync(nodeIds: readonly number[], lineageParents: ReadonlyMap<number, number[]>): void {
    const moving = [...new Set(nodeIds)];
    const movingSet = new Set(moving);
    for (const [nodeId, parents] of lineageParents) {
      if (!movingSet.has(nodeId)) {
        throw new Error(`moveToArchiveSync: 계보 부모를 받은 노드 ${nodeId} 가 이번에 옮기는 노드 목록에 없습니다`);
      }
      if (parents.includes(nodeId)) {
        throw new Error(`moveToArchiveSync: 노드 ${nodeId} 의 계보 부모에 자기 자신이 들어 있습니다`);
      }
    }
    this.db.transaction(() => {
      for (const batch of inIdBatches(moving)) {
        const list = sqlPlaceholders(batch.length);
        // dynamic SQL: placeholder count varies, keep prepare()
        this.db
          .prepare(
            `INSERT OR IGNORE INTO ${ARCHIVE_TABLE} (${SOURCE_COLUMNS})
             SELECT ${SOURCE_COLUMNS} FROM ${LIVE_TABLE} WHERE node_id IN (${list})`,
          )
          .run(...batch);
        this.db.prepare(`DELETE FROM ${LIVE_TABLE} WHERE node_id IN (${list})`).run(...batch);
      }
      const insertLineage = this.db.query(
        `INSERT OR IGNORE INTO ${ARCHIVE_TABLE} (${SOURCE_COLUMNS}) VALUES (?, ?, ?, NULL, ?, '{}', ?)`,
      );
      const now = nowKst();
      for (const [nodeId, parents] of lineageParents) {
        for (const parentId of new Set(parents)) {
          insertLineage.run(nodeId, archivedLineageKeyOf(parentId), ARCHIVED_LINEAGE_KIND, String(parentId), now);
        }
      }
    })();
  }

  /**
   * 휴지통 복원: 보관된 출처 행 중 archived_lineage 가 아닌 것을 살아 있는 표로 되돌리고, 그 노드의 보관 출처
   * 행을 모두 지운다. 되돌릴 행이 없으면 restore:<actor> 행을 더한다(되살린 사람의 보존 의사).
   * knowledge_nodes 에 그 노드 행이 먼저 있어야 한다(외래 키). 반환: 복원 뒤 그 노드의 출처 행 전부.
   */
  restoreFromArchiveSync(nodeId: number, actor: string): NodeSourceRow[] {
    return this.db.transaction(() => {
      const restorable = this.db
        .query(`SELECT COUNT(*) AS c FROM ${ARCHIVE_TABLE} WHERE node_id = ? AND kind <> ?`)
        .get(nodeId, ARCHIVED_LINEAGE_KIND) as { c: number };
      this.db
        .query(
          `INSERT OR IGNORE INTO ${LIVE_TABLE} (${SOURCE_COLUMNS})
           SELECT ${SOURCE_COLUMNS} FROM ${ARCHIVE_TABLE} WHERE node_id = ? AND kind <> ?`,
        )
        .run(nodeId, ARCHIVED_LINEAGE_KIND);
      this.db.query(`DELETE FROM ${ARCHIVE_TABLE} WHERE node_id = ?`).run(nodeId);
      if (restorable.c === 0) this.insertSync(nodeId, restoreSourceRef(actor));
      return this.listSync([nodeId]).get(nodeId)!;
    })();
  }

  /**
   * 메시지 삭제의 보관표 정리(설계 5.5). 반환: 보관표에서 영구 삭제한 노드 id(오름차순).
   *   1) 보관 출처 표에서 그 메시지 행을 지운다.
   *   2) 이번에 행을 잃은 보관 노드 중 남은 행이 하나도 없는 것을 knowledge_nodes_archive 에서 지운다.
   *   3) 살아 있는 쪽에서 지워진 노드(deletedLiveIds)와 2 에서 지운 노드로 sweepArchiveForDeletedNodesSync 를
   *      부른다 — archived_lineage 반복 정리 규칙은 그 함수 한 곳이다(단건 영구 삭제도 같은 함수를 쓴다).
   * 이번 정리에서 행을 잃지 않은 보관 노드는 건드리지 않는다. holders 를 주면 보관표에서 지운 노드 행을 거기
   * 모은다(첨부 해제, WP-B1-20U 설계 17.17). keys 를 주면 1 에서 그 메시지 행 중 키가 keys 에 든 행만 지운다(메시지
   * 수정에서 뺀 첨부, WP-B1-20U 설계 17.9) — 나머지 단계는 같다.
   */
  sweepArchiveForMessageSync(
    messageId: string,
    platform: string | null,
    deletedLiveIds: readonly number[],
    holders?: RemovedAssetHolders,
    keys?: ReadonlySet<string>,
  ): number[] {
    const wanted = normalizePlatform(platform);
    return this.db.transaction(() => {
      const messageNodeIds = keys === undefined
        ? this.deleteArchivedMessageRows(messageId, wanted)
        : this.deleteArchivedMessageKeyRows(messageId, wanted, [...keys]);
      const purgedByMessage = this.purgeArchiveNodesWithoutRows([...new Set(messageNodeIds)], holders);
      const purgedByLineage = this.sweepArchiveForDeletedNodesSync([...deletedLiveIds, ...purgedByMessage], holders);
      return [...purgedByMessage, ...purgedByLineage].sort((a, b) => a - b);
    })();
  }

  /** 보관 출처 표에서 그 메시지 행(platform 은 정규화된 값, null 이면 플랫폼 무관)을 지우고 행을 잃은 노드 id. */
  private deleteArchivedMessageRows(messageId: string, platform: string | null): number[] {
    const records = (
      platform === null
        ? this.db
            .query(`DELETE FROM ${ARCHIVE_TABLE} WHERE kind = 'message' AND external_id = ? RETURNING node_id`)
            .all(messageId)
        : this.db
            .query(
              `DELETE FROM ${ARCHIVE_TABLE} WHERE kind = 'message' AND external_id = ? AND platform = ?
               RETURNING node_id`,
            )
            .all(messageId, platform)
    ) as Array<{ node_id: number }>;
    return records.map((record) => record.node_id);
  }

  /** deleteArchivedMessageRows 와 같되 키가 keys 에 든 행만(500개씩 IN). */
  private deleteArchivedMessageKeyRows(messageId: string, platform: string | null, keys: readonly string[]): number[] {
    const platformClause = platform === null ? "" : " AND platform = ?";
    const platformParams = platform === null ? [] : [platform];
    const nodeIds: number[] = [];
    for (const batch of inIdBatches(keys)) {
      // dynamic SQL: placeholder count varies, keep prepare()
      const records = this.db
        .prepare(
          `DELETE FROM ${ARCHIVE_TABLE} WHERE kind = 'message' AND external_id = ?${platformClause}
           AND source_key IN (${sqlPlaceholders(batch.length)}) RETURNING node_id`,
        )
        .all(messageId, ...platformParams, ...batch) as Array<{ node_id: number }>;
      for (const record of records) nodeIds.push(record.node_id);
    }
    return nodeIds;
  }

  /**
   * 영구 삭제된 노드에만 기대던 보관 노드 정리(설계 5.5 의 3단계 반복, 17.3). 반환: 보관표에서 영구 삭제한
   * 노드 id(오름차순, deletedIds 자신은 넣지 않는다).
   *   1) 이번에 지워진 노드 id(처음엔 deletedIds)를 가리키는 archived_lineage 행을 지운다.
   *   2) 그 행을 잃은 보관 노드 중 남은 행이 하나도 없는 것을 knowledge_nodes_archive 에서 지운다.
   *   3) 2 에서 지운 노드로 1 로 돌아간다. 새로 지울 노드가 없으면 멈춘다.
   * 지운 보관 노드의 수정 이력은 호출자가 같은 트랜잭션에서 지운다. holders 를 주면 지운 보관 노드 행을 거기 모은다.
   */
  sweepArchiveForDeletedNodesSync(deletedIds: readonly number[], holders?: RemovedAssetHolders): number[] {
    return this.db.transaction(() => {
      const purged: number[] = [];
      const purgedSet = new Set<number>();
      let deletedThisPass = [...new Set(deletedIds)];
      while (deletedThisPass.length > 0) {
        const candidates = this.dropLineageRowsPointingAt(deletedThisPass).filter((id) => !purgedSet.has(id));
        const newlyPurged = this.purgeArchiveNodesWithoutRows([...new Set(candidates)], holders);
        for (const id of newlyPurged) {
          purged.push(id);
          purgedSet.add(id);
        }
        deletedThisPass = newlyPurged;
      }
      return purged.sort((a, b) => a - b);
    })();
  }

  /** archived_lineage 행 중 부모가 parentIds 인 것을 지우고, 행을 잃은 보관 노드 id 를 돌려준다. */
  private dropLineageRowsPointingAt(parentIds: readonly number[]): number[] {
    const touched: number[] = [];
    for (const batch of inIdBatches(parentIds.map(String))) {
      // dynamic SQL: placeholder count varies, keep prepare()
      const records = this.db
        .prepare(
          `DELETE FROM ${ARCHIVE_TABLE}
           WHERE kind = ? AND external_id IN (${sqlPlaceholders(batch.length)}) RETURNING node_id`,
        )
        .all(ARCHIVED_LINEAGE_KIND, ...batch) as Array<{ node_id: number }>;
      for (const record of records) touched.push(record.node_id);
    }
    return touched;
  }

  /**
   * candidates 중 보관 출처 행이 하나도 남지 않은 노드를 보관표에서 지우고 그 id 를 돌려준다(오름차순). holders 를
   * 주면 지운 노드 id 를 거기 모은다(첨부 해제, 설계 17.18 D33).
   */
  private purgeArchiveNodesWithoutRows(candidates: readonly number[], holders?: RemovedAssetHolders): number[] {
    const purged: number[] = [];
    for (const batch of inIdBatches(candidates)) {
      const list = sqlPlaceholders(batch.length);
      // dynamic SQL: placeholder count varies, keep prepare()
      const held = new Set(
        (
          this.db
            .prepare(`SELECT DISTINCT node_id FROM ${ARCHIVE_TABLE} WHERE node_id IN (${list})`)
            .all(...batch) as Array<{ node_id: number }>
        ).map((record) => record.node_id),
      );
      const bare = batch.filter((id) => !held.has(id));
      if (bare.length === 0) continue;
      const records = this.db
        .prepare(
          `DELETE FROM knowledge_nodes_archive WHERE id IN (${sqlPlaceholders(bare.length)}) ${REMOVED_HOLDER_RETURNING}`,
        )
        .all(...bare) as RemovedNodeRow[];
      holders?.addRows(records);
      for (const record of records) purged.push(record.id);
    }
    return purged.sort((a, b) => a - b);
  }
}
