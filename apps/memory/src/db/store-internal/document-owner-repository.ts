/**
 * store-internal/document-owner-repository.ts — 문서 기록 주인 표(document_record_owners, v46)의 읽기·쓰기(WP-B1-20U 설계
 * 17.18 설계 1, 결정 D32·D33).
 *
 * 문서 기록(documents 행)마다 주인 노드가 하나다 — 그 입력이 놓인 노드(새 문서 노드, 또는 같은 본문으로 흡수한 노드).
 * addDocumentGraphAtomic 이 노드 INSERT·흡수와 같은 트랜잭션에서 addOwnerSync 로 쓰고, 영구 삭제의 해제 루틴
 * (asset-release.ts)이 지운 노드 id 로 listOwnedDocumentIdsSync 를 불러 해제할 기록을 고른다. 주인 행은 기록이 지워질 때
 * 외래 키 CASCADE 로 함께 지워진다. 노드 metadata(documentId·absorbedDocumentIds)는 주인 판정에 쓰지 않는다: 클라이언트가
 * 쓸 수 있는 칸이라 위조·복제될 수 있다(3.1 의 H2 교훈).
 *
 * /ingest 보상(설계 17.18 설계 3)은 ownerNodeIdSync 로 노드 저장이 커밋됐는지 본다. 서버 시작 정리는 시작 질의 셋을 쓴다
 * — (a) 주인 행 없는 기록, (b) 주인 노드가 두 표 어디에도 없는 기록, (c) 기록 없는 주인 행(외래 키를 끈 외부 도구가 DB 를
 * 바꾼 경우뿐 — 이 저장소의 유일한 지우기). 셋 다 표를 한 번 훑고 행마다 PK 조회를 한다.
 *
 * 메서드는 동기이고 호출자의 트랜잭션·쓰기 잠금 안에서 부른다.
 */

import type { Database } from "bun:sqlite";
import { nowKst } from "./helpers.ts";
import { inIdBatches, sqlPlaceholders } from "./id-batches.ts";

export class DocumentOwnerRepository {
  constructor(private readonly db: Database) {}

  /**
   * 기록 documentId 의 주인을 nodeId 로 적는다. 기록 하나에 주인 하나 — 같은 (기록, 노드) 쌍을 다시 적으면 그대로 두고
   * (같은 기록 id 로 다시 넣은 입력이 같은 노드에 흡수된 경우), 다른 노드가 이미 주인이면 두 번호를 담은 오류로 멈춘다.
   * documents 행이 없으면 외래 키 위반으로 SQLite 오류가 그대로 던져진다. 어느 쪽이든 호출자 트랜잭션 전체가 되돌아간다.
   */
  addOwnerSync(documentId: string, nodeId: number): void {
    const existing = this.ownerNodeIdSync(documentId);
    if (existing !== null) {
      if (existing === nodeId) return;
      throw new Error(
        `문서 기록 ${documentId} 의 주인은 이미 노드 ${existing} 입니다 — 노드 ${nodeId} 로 바꾸지 않습니다(기록 하나에 주인 하나)`,
      );
    }
    this.db
      .query("INSERT INTO document_record_owners (document_id, node_id, created_at) VALUES (?, ?, ?)")
      .run(documentId, nodeId, nowKst());
  }

  /**
   * nodeIds 가 주인인 기록 id(오름차순, 중복 없음). 500개씩 묶어 idx_document_record_owners_node 를 탄다 — 지운 노드
   * 수에 비례하고 표를 훑지 않는다.
   */
  listOwnedDocumentIdsSync(nodeIds: readonly number[]): string[] {
    const out: string[] = [];
    for (const batch of inIdBatches(nodeIds)) {
      // dynamic SQL: placeholder count varies, keep prepare()
      const rows = this.db
        .prepare(`SELECT document_id FROM document_record_owners WHERE node_id IN (${sqlPlaceholders(batch.length)})`)
        .all(...batch) as Array<{ document_id: string }>;
      for (const row of rows) out.push(row.document_id);
    }
    return [...new Set(out)].sort();
  }

  /** 기록 documentId 의 주인 노드 id(PK 조회). 주인 행이 없으면 null. */
  ownerNodeIdSync(documentId: string): number | null {
    const row = this.db
      .query("SELECT node_id FROM document_record_owners WHERE document_id = ?")
      .get(documentId) as { node_id: number } | null;
    return row === null ? null : row.node_id;
  }

  /** 시작 질의 (a) — 주인 행이 없는 기록 id(오름차순). 시작 때는 진행 중인 저장이 없어 버려진 기록뿐이다. */
  listOwnerlessDocumentIdsSync(): string[] {
    const rows = this.db
      .query(
        `SELECT d.document_id AS documentId FROM documents d
         WHERE NOT EXISTS (SELECT 1 FROM document_record_owners o WHERE o.document_id = d.document_id)
         ORDER BY d.document_id`,
      )
      .all() as Array<{ documentId: string }>;
    return rows.map((row) => row.documentId);
  }

  /**
   * 시작 질의 (b) — 기록은 있는데 주인 노드가 살아 있는 표·휴지통 표 어디에도 없는 기록 id(오름차순). 노드 번호는 두
   * 표에서 같다. 기록이 없는 주인 행은 (c) 몫이라 여기서 고르지 않는다.
   */
  listDocumentIdsWithMissingOwnerNodeSync(): string[] {
    const rows = this.db
      .query(
        `SELECT o.document_id AS documentId FROM document_record_owners o
         JOIN documents d ON d.document_id = o.document_id
         WHERE NOT EXISTS (SELECT 1 FROM knowledge_nodes n WHERE n.id = o.node_id)
           AND NOT EXISTS (SELECT 1 FROM knowledge_nodes_archive a WHERE a.id = o.node_id)
         ORDER BY o.document_id`,
      )
      .all() as Array<{ documentId: string }>;
    return rows.map((row) => row.documentId);
  }

  /** 시작 질의 (c) — documents 행이 없는 주인 행을 지운다. 반환: 지운 행의 기록 id(오름차순). */
  deleteOwnersWithoutRecordSync(): string[] {
    const rows = this.db
      .query(
        `DELETE FROM document_record_owners
         WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.document_id = document_record_owners.document_id)
         RETURNING document_id AS documentId`,
      )
      .all() as Array<{ documentId: string }>;
    return rows.map((row) => row.documentId).sort();
  }
}
