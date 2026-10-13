/**
 * store-internal/event-repository.ts — events 큐 CRUD.
 *
 * Phase 7 2차 ① 토대. 알림(정리 제안 ready 등)을 영구 적재해 "하나도 안 놓침" 을
 * 보장하는 큐. id 가 단조 증가하므로 SSE Last-Event-ID 커서로 쓴다 — 어댑터가 끊겼다
 * 재연결하면 마지막 받은 id 다음부터 listSince 로 이어받는다(Task 3 SSE 가 소비).
 * payload 는 자유 JSON — type 별로 형태가 다르다.
 *
 * Phase 7 2차 Task 1.
 */

import type { Database } from "bun:sqlite";
import { nowInZone, pastCutoffInZone } from "./helpers.ts";

/**
 * 한 번에 회신할 이벤트 최대 개수의 기본값. 하드코딩 회피 — 호출자가 limit 인자로
 * 덮어쓸 수 있고, 미지정 시 이 상수를 쓴다. SSE 재연결 이어받기·최근 폴백 조회 둘 다
 * 같은 기본값을 공유한다.
 */
export const DEFAULT_EVENT_LIMIT = 100;

/**
 * P3 G3-c — events 보존 무제한 sentinel. retentionDays 가 이 값이면 정리 안 함
 * (정직한 비활성 — 삭제 0). settings.events.retentionDays 의 최소값과 정합.
 */
export const EVENTS_RETENTION_UNLIMITED = -1;

/** P3 G3-c — purgeOldEvents 결과. 삭제 개수 + 이어받기 보호로 미삭제한 여부. */
export interface EventsPurgeResult {
  /** 실제로 삭제된 events 행 수. */
  deleted: number;
  /** retentionDays 무제한(sentinel)이라 정리를 건너뛰었으면 true. */
  skippedUnlimited: boolean;
  /**
   * 재연결 이어받기 커서 보호로 컷오프를 앞당겨(더 오래된 것만 삭제) 일부 오래된
   * 이벤트를 남긴 경우 true. 보존 창이 이어받기 윈도우를 침범해 경계가 커서로
   * 잘렸음을 뜻한다(호출자가 경고 로그를 남긴다).
   */
  clampedToCursor: boolean;
}

export interface EventRecord {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface EventRow {
  id: number;
  type: string;
  payload_json: string;
  created_at: string;
}

export class EventRepository {
  constructor(private readonly db: Database) {}

  private rowToEvent(row: EventRow): EventRecord {
    return {
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }

  /**
   * 새 이벤트 한 줄을 큐에 추가하고 생성된 단조 증가 id 를 반환한다. id 는 INTEGER
   * PRIMARY KEY AUTOINCREMENT 라 직전 id 보다 항상 크다(SSE 커서 단조성 보장).
   * payload 는 JSON.stringify 로 직렬화 — 호출자는 평범한 JS 객체를 넘긴다.
   *
   * P3 G3-c — created_at 을 nowInZone(설정 시간대)으로 명시 저장한다. 옛 코드는
   * schema default datetime('now')(UTC)에 맡겼는데, 그러면 다른 코어 테이블(설정
   * zone 저장)과 보존 컷오프(설정 zone) 사이에 시간대 혼재가 재발한다. 저장·컷오프를
   * 한 zone 으로 통일해 purgeOldEvents 의 lexicographic 비교가 정확해진다.
   */
  append(type: string, payload: Record<string, unknown>): number {
    const result = this.db
      .query("INSERT INTO events (type, payload_json, created_at) VALUES (?, ?, ?)")
      .run(type, JSON.stringify(payload), nowInZone());
    return Number(result.lastInsertRowid);
  }

  /**
   * afterId 보다 큰 id 의 이벤트를 id 오름차순으로 회신한다(놓침 이어받기). SSE 가
   * Last-Event-ID: N 으로 재연결하면 N 초과분을 먼저 흘리는 통로. limit 미지정 시
   * DEFAULT_EVENT_LIMIT. 결과가 빈 배열이면 "그 id 이후 새 이벤트 없음" 이라는 진짜
   * 빈 상태다(실패 위장 아님).
   */
  listSince(afterId: number, limit: number = DEFAULT_EVENT_LIMIT): EventRecord[] {
    const rows = this.db
      .query(
        `SELECT id, type, payload_json, created_at
         FROM events
         WHERE id > ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(afterId, limit) as EventRow[];
    return rows.map((r) => this.rowToEvent(r));
  }

  /**
   * 가장 최근 이벤트를 id 내림차순으로 limit 개 회신한다(폴백 목록·진단용). limit
   * 미지정 시 DEFAULT_EVENT_LIMIT. id DESC 라 첫 원소가 가장 새 이벤트다.
   */
  listRecent(limit: number = DEFAULT_EVENT_LIMIT): EventRecord[] {
    const rows = this.db
      .query(
        `SELECT id, type, payload_json, created_at
         FROM events
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as EventRow[];
    return rows.map((r) => this.rowToEvent(r));
  }

  /**
   * P3 G3-c — retentionDays 지난 events 를 영구 삭제한다. events 큐는 알림을
   * 영구 적재하는데 DELETE 경로가 없어 무한 성장했다 — trash cron 이 이 메서드로
   * 주기 정리한다.
   *
   * 시간대 정합: created_at 은 append 가 nowInZone(설정 zone)으로 저장하고, 컷오프도
   * pastCutoffInZone(같은 zone)으로 만들어 lexicographic 비교가 정확하다(G3-b 통일).
   *
   * 재연결 이어받기 윈도우 보호(불변식 5): SSE 어댑터가 끊겼다 재연결하면 마지막
   * 받은 id 다음부터 listSince 로 이어받는다. 보존 창이 너무 짧아 아직 이어받을 수
   * 있는(= id > protectAfterId) 이벤트를 지우면 "유실 0" 계약이 깨진다. 그래서
   * protectAfterId 가 주어지면 그 id 이하만 삭제 대상으로 삼아(created_at 컷오프 +
   * id 상한 AND 조건), 살아있는 커서 이후 이벤트는 시간과 무관하게 남긴다. 실제로
   * 컷오프가 커서를 침범했는지(= 컷오프만으로는 커서 이후도 지웠을) 여부를
   * clampedToCursor 로 알려 호출자가 경고를 남기게 한다(정직한 실패 표면).
   *
   * @param retentionDays 보존일. EVENTS_RETENTION_UNLIMITED(-1)면 정리 안 함.
   * @param protectAfterId 이 id 초과 이벤트는 시간과 무관하게 보존(재연결 커서). 미지정 시 보호 없음.
   */
  purgeOldEvents(
    retentionDays: number,
    protectAfterId?: number,
  ): EventsPurgeResult {
    if (retentionDays === EVENTS_RETENTION_UNLIMITED) {
      // 무제한 sentinel — 정직한 비활성(삭제 0). 0 일 등 다른 값은 아래에서 정상 처리.
      return { deleted: 0, skippedUnlimited: true, clampedToCursor: false };
    }

    const cutoff = pastCutoffInZone(
      Date.now() - retentionDays * 24 * 3600 * 1000,
    );

    // 재연결 커서 보호. protectAfterId 가 주어지면 그 id 이하만 삭제한다. 컷오프만
    // 으로는 커서 이후(id > protectAfterId)도 지웠을 후보가 있으면 clampedToCursor.
    if (protectAfterId !== undefined) {
      const wouldExceedCursor = this.db
        .query(
          "SELECT COUNT(*) AS c FROM events WHERE created_at < ? AND id > ?",
        )
        .get(cutoff, protectAfterId) as { c: number };
      const result = this.db
        .query("DELETE FROM events WHERE created_at < ? AND id <= ?")
        .run(cutoff, protectAfterId);
      return {
        deleted: result.changes,
        skippedUnlimited: false,
        clampedToCursor: wouldExceedCursor.c > 0,
      };
    }

    const result = this.db
      .query("DELETE FROM events WHERE created_at < ?")
      .run(cutoff);
    return {
      deleted: result.changes,
      skippedUnlimited: false,
      clampedToCursor: false,
    };
  }
}
