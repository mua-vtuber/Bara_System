/**
 * store-internal/cleanup-proposals-repository.ts — cleanup_proposals CRUD.
 *
 * Phase 7 cleanup-AI 가 emit 한 정리 제안 큐. 상태는 'pending' 으로 들어와 사용자/
 * 관리자 검토 후 결정 상태로 갱신된다. payload 는 자유 JSON —
 * kind 별로 형태가 다르다 (병합 후보, 별칭 후보, 폐기 후보 등). id 는 'cp_' + uuid.
 *
 * Phase 11b T12 / sidecar acceptance.
 *
 * 상태 확장 (AI 사용성 업그레이드 spec 5-9 / T32):
 *   pending           — 미결정(초기값).
 *   applied           — 항목 전건 적용 완료.
 *   partially_applied — 일부 항목만 적용(나머지는 미선택·checksum 불일치·실패).
 *   needs_revision    — 적용 시점 대상이 바뀌어 전건 적용 불가 — AI 재작업 필요.
 *   rejected          — 사용자가 거절(적용 0).
 *   approved          — **옛 값**. 부분 승인 도입 전 단일 승인이 쓰던 이름이다. 새
 *                       코드는 쓰지 않지만 기존 DB 행이 이 값을 들고 있어 읽기 계약에
 *                       남긴다(이행 UPDATE 를 하지 않는다 — 옛 기록의 원래 뜻 보존).
 *
 * 하위 호환 규율: status 칸은 TEXT 자유 값이라 새 값 추가에 스키마 변경이 없다.
 * "pending 이 아니면 처리 완료" 라는 기존 판정이 새 값 전부에 그대로 성립한다.
 */

import type { Database } from "bun:sqlite";

export type CleanupProposalStatus =
  | "pending"
  | "applied"
  | "partially_applied"
  | "needs_revision"
  | "rejected"
  | "approved";

/**
 * 항목 적용 원장 한 줄의 상태.
 *   applied — 적용 성공.
 *   skipped — 적용 안 함(사용자 미선택 또는 적용 시점 checksum 불일치).
 *   failed  — 적용 함수가 구체 오류로 거부.
 */
export type ProposalItemJournalStatus = "applied" | "skipped" | "failed";

/** 항목 적용 원장 한 줄. */
export interface ProposalItemJournalEntry {
  proposalId: string;
  itemKey: string;
  status: ProposalItemJournalStatus;
  /** 사유·오류 문구(적용 성공은 null). */
  detail: string | null;
  /** 적용 직후 대상 지문 — 중단 후 재시도의 대조 기준(적용 항목만 채워진다). */
  afterFingerprint: string | null;
  appliedAt: string;
}

interface JournalRow {
  proposal_id: string;
  item_key: string;
  status: string;
  detail: string | null;
  after_fingerprint: string | null;
  applied_at: string;
}

export interface CleanupProposal {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: CleanupProposalStatus;
  createdAt: string;
  resolvedAt: string | null;
}

interface CleanupProposalRow {
  id: string;
  kind: string;
  payload_json: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

export class CleanupProposalsRepository {
  constructor(private readonly db: Database) {}

  private newId(): string {
    return `cp_${crypto.randomUUID()}`;
  }

  private rowToProposal(row: CleanupProposalRow): CleanupProposal {
    return {
      id: row.id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      status: row.status as CleanupProposalStatus,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }

  /**
   * 새 제안 한 줄을 추가하고 생성된 id ('cp_' + uuid) 를 반환한다.
   * payload 는 JSON.stringify 로 직렬화 — 호출자는 평범한 JS 객체를 넘긴다.
   * status 는 schema default 'pending' 으로 들어간다 (CREATE TABLE default 적용).
   */
  insert(kind: string, payload: Record<string, unknown>): string {
    const id = this.newId();
    this.db
      .query(
        `INSERT INTO cleanup_proposals (id, kind, payload_json) VALUES (?, ?, ?)`,
      )
      .run(id, kind, JSON.stringify(payload));
    return id;
  }

  /**
   * id 로 제안 한 줄을 반환한다. 없으면 null — 실패와 "없음" 을 구별한다.
   * payload_json 은 JSON.parse 적용 후 회신.
   */
  findById(id: string): CleanupProposal | null {
    const row = this.db
      .query("SELECT * FROM cleanup_proposals WHERE id = ?")
      .get(id) as CleanupProposalRow | null;
    if (!row) return null;
    return this.rowToProposal(row);
  }

  /**
   * status='pending' 제안 한 한 created_at ASC 정렬로 회신.
   * paging 은 LIMIT/OFFSET — 0-based offset.
   */
  findPending(limit: number, offset: number = 0): CleanupProposal[] {
    // ORDER BY created_at ASC 가 우선 — 같은 datetime('now') 초 안 들어온 행은
    // rowid (INSERT 순서) 로 안정 정렬. id (uuid) ASC 는 무작위 흩어져 INSERT
    // 순서 보장 불가 — 따라서 rowid 를 보조 키로 사용.
    const rows = this.db
      .query(
        `SELECT * FROM cleanup_proposals
         WHERE status = 'pending'
         ORDER BY created_at ASC, rowid ASC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as CleanupProposalRow[];
    return rows.map((r) => this.rowToProposal(r));
  }

  /**
   * 같은 kind·payload.nodeId 의 대기 제안 id 목록(같은 메모 제안 대체용). findPending 은
   * 쪽 단위라 대기 제안 전부를 본다는 보장이 없어 따로 둔다.
   */
  findPendingIdsByNode(kind: string, nodeId: number): string[] {
    return (this.db
      .query("SELECT id FROM cleanup_proposals WHERE kind = ? AND status = 'pending' AND CAST(payload_json ->> '$.nodeId' AS INTEGER) = ?")
      .all(kind, nodeId) as Array<{ id: string }>).map((r) => r.id);
  }

  /**
   * 같은 kind·nodeId 의 대기 제안을 needs_revision 으로 대체하고 새 제안을 넣는다 — 한 트랜잭션.
   * 둘 중 하나만 남으면 같은 메모에 대기 제안이 둘이 되거나(대체 누락) 제안이 사라진다(넣기 누락).
   */
  insertSupersedingPendingByNode(kind: string, nodeId: number, payload: Record<string, unknown>): string {
    return this.db.transaction(() => {
      for (const id of this.findPendingIdsByNode(kind, nodeId)) this.updateStatus(id, "needs_revision");
      return this.insert(kind, payload);
    })();
  }

  /**
   * id 의 status 를 갱신한다. 갱신된 행이 1 = true, 0 (없는 id) = false.
   * status != 'pending' 으로 갱신 시 resolved_at 을 현재 시각으로 함께 기록한다.
   */
  updateStatus(id: string, status: CleanupProposalStatus): boolean {
    const result = status === "pending"
      ? this.db
          .query(
            `UPDATE cleanup_proposals SET status = ?, resolved_at = NULL WHERE id = ?`,
          )
          .run(status, id)
      : this.db
          .query(
            `UPDATE cleanup_proposals SET status = ?, resolved_at = datetime('now') WHERE id = ?`,
          )
          .run(status, id);
    return result.changes === 1;
  }

  // ── 항목 적용 원장 (spec 5-9 / T32) ────────────────────────────────────────

  /**
   * 한 제안의 원장 줄 전부를 item_key 정렬로 회신한다. 원장이 비어 있으면 빈 배열 —
   * "아직 아무 항목도 적용 안 됨" 이라는 정직한 사실이다(실패 위장 아님).
   */
  listJournal(proposalId: string): ProposalItemJournalEntry[] {
    const rows = this.db
      .query(
        `SELECT * FROM cleanup_proposal_item_journal
         WHERE proposal_id = ?
         ORDER BY item_key ASC`,
      )
      .all(proposalId) as JournalRow[];
    return rows.map((r) => ({
      proposalId: r.proposal_id,
      itemKey: r.item_key,
      status: r.status as ProposalItemJournalStatus,
      detail: r.detail,
      afterFingerprint: r.after_fingerprint,
      appliedAt: r.applied_at,
    }));
  }

  /**
   * 이미 적용(status='applied')된 항목 열쇠 집합을 회신한다. 중단 복구의 핵심 —
   * 재적용 시도가 이 집합에 든 항목을 건너뛴다(같은 변경 두 번 적용 차단).
   *
   * skipped·failed 는 포함하지 않는다: 그 항목들은 쓰기가 안 일어났으므로 재시도
   * 대상이다(적용된 것만 건너뛴다).
   */
  appliedItemKeys(proposalId: string): Set<string> {
    const rows = this.db
      .query(
        `SELECT item_key FROM cleanup_proposal_item_journal
         WHERE proposal_id = ? AND status = 'applied'`,
      )
      .all(proposalId) as Array<{ item_key: string }>;
    return new Set(rows.map((r) => r.item_key));
  }

  /**
   * 원장 한 줄을 기록한다. 같은 (proposal_id, item_key) 가 이미 있으면 덮어쓴다 —
   * 앞선 시도가 skipped/failed 로 남긴 줄을 재시도 결과로 갱신하는 통로이자, 적용 직후
   * 남긴 줄에 after_fingerprint 를 덧붙이는 통로다.
   *
   * 원자성 경계(정직한 서술): 이 INSERT 는 적용 쓰기와 **같은 트랜잭션이 아니다**.
   * 적용 함수(applyLensDraft)가 자기 트랜잭션을 소유하고 커밋한 뒤 돌아오므로, 호출부가
   * 그 쓰기를 자기 트랜잭션으로 감쌀 수 없다. 따라서 "적용 커밋 ~ 이 INSERT" 사이에
   * 프로세스가 죽으면 적용은 됐는데 원장에 없는 상태가 남는다.
   *
   * 그 창이 데이터를 깨지는 않는다: 재시도는 적용 시점 지문 대조에서 걸려 전건 거부되므로
   * 같은 변경이 두 번 적용되지 않는다. 증상은 "그 제안은 자동 재개 불가(재작업)" 다.
   * 이 원장의 역할은 쓰기 원자성 보증이 아니라 **복구 장부**이며, 창을 좁히는 책임은
   * 호출부에 있다(적용 직후 이 기록을 최우선으로 부른 뒤 지문을 덧붙인다).
   */
  recordJournalEntry(
    proposalId: string,
    itemKey: string,
    status: ProposalItemJournalStatus,
    detail: string | null,
    afterFingerprint: string | null = null,
  ): void {
    this.db
      .query(
        `INSERT INTO cleanup_proposal_item_journal
           (proposal_id, item_key, status, detail, after_fingerprint)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (proposal_id, item_key) DO UPDATE SET
           status = excluded.status,
           detail = excluded.detail,
           after_fingerprint = excluded.after_fingerprint,
           applied_at = datetime('now')`,
      )
      .run(proposalId, itemKey, status, detail, afterFingerprint);
  }

  /**
   * 재시도 대조 기준 지문 — 가장 최근에 적용된 항목이 남긴 "적용 직후" 지문.
   * 적용 이력이 없거나 지문이 안 남았으면 null(첫 시도로 취급 — 제안 시점 지문 사용).
   *
   * 정렬은 applied_at 최신 우선 + item_key 보조. 같은 초에 여러 항목이 적용돼도
   * 마지막 한 줄이 결정적으로 뽑힌다(적용 순서 = item_key 순서라 보조 키가 맞다).
   */
  readResumeFingerprint(proposalId: string): string | null {
    const row = this.db
      .query(
        `SELECT after_fingerprint FROM cleanup_proposal_item_journal
         WHERE proposal_id = ? AND status = 'applied' AND after_fingerprint IS NOT NULL
         ORDER BY applied_at DESC, item_key DESC
         LIMIT 1`,
      )
      .get(proposalId) as { after_fingerprint: string } | null;
    return row?.after_fingerprint ?? null;
  }
}
