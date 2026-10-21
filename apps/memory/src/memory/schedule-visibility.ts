/**
 * schedule-visibility.ts — "일정 아님" 표시와 되돌리기(홈 일정 목록 정리).
 *
 * 일정 목록(buildDateOccurrences)은 event_at 이 있는 모든 글을 보여 주므로, 날짜가 채워진 일반 메모도 일정으로 뜬다.
 * 이 모듈은 글과 event_at 을 그대로 두고(시간 검색이 계속 찾도록) metadata.scheduleHidden 한 칸만 켜고 끈다.
 *
 *   hidden=true, 자동 등록이 만든 일정 노드  → 그 자동 등록 기록을 되돌린다(일정 노드는 휴지통, 같은 메모에서 다시 안 만들도록 무시 기록).
 *                                             일정 노드가 사라지면 원본 메모가 목록에 다시 뜨므로 원본 메모에도 칸을 켠다.
 *   hidden=true, 그 밖의 글(일반 메모·직접 쓴 #일정:) → 칸을 켜고, 자동 등록이 이 메모에서 일정을 새로 만들지 않도록 무시 기록을 남긴다.
 *   hidden=false                              → 칸만 지운다. 무시 기록·휴지통 일정은 그대로(휴지통은 자체 복원이 있다).
 */
import type { SqliteMemoryStore } from "../db/store.ts";
import { SCHEDULE_HIDDEN_KEY } from "./cleanup-deep-pass/entity-register/constants.ts";
import { EntityRegisterRecordsRepository, SCHEDULE_IGNORE_NAME_KEY } from "./cleanup-deep-pass/entity-register/records-repository.ts";
import { revertEntityRegisterRecord } from "./cleanup-deep-pass/entity-register/revert.ts";
import { withMemoryMutationLock } from "./shared-memory-mutation-lock.ts";

const ERROR_PREFIX = "일정 아님 표시";

/** 요청이 처리할 수 없는 상태 — 라우트가 status 를 그대로 응답 코드로 쓴다. */
export class ScheduleVisibilityError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(`${ERROR_PREFIX}: ${message}`);
    this.name = "ScheduleVisibilityError";
  }
}

export type ScheduleVisibilityAction = "flagged" | "unflagged" | "reverted_schedule";

export interface ScheduleVisibilityResult {
  nodeId: number;
  hidden: boolean;
  action: ScheduleVisibilityAction;
  /** 자동 등록 일정 노드를 되돌렸을 때 되돌린 기록 id. */
  revertedRecordId?: number;
  /** 일정 노드를 되돌린 뒤 원본 메모에도 칸을 켰는가. */
  sourceMemoFlagged?: boolean;
}

function setFlag(store: SqliteMemoryStore, nodeId: number, value: true | null): void {
  if (!store.nodeRepo.setNodeMetadataFlag(nodeId, SCHEDULE_HIDDEN_KEY, value)) {
    throw new Error(`${ERROR_PREFIX}: 노드 ${nodeId} 의 ${SCHEDULE_HIDDEN_KEY} 칸을 쓰지 못함`);
  }
}

export async function setScheduleVisibility(
  store: SqliteMemoryStore,
  nodeId: number,
  hidden: boolean,
): Promise<ScheduleVisibilityResult> {
  return withMemoryMutationLock(store, async () => {
    const node = await store.getNode(nodeId);
    if (!node) throw new ScheduleVisibilityError(`기억 ${nodeId} 없음`, 404);
    if (!hidden) {
      setFlag(store, nodeId, null);
      return { nodeId, hidden: false, action: "unflagged" };
    }
    if (!node.eventAt) throw new ScheduleVisibilityError(`기억 ${nodeId} 은(는) 날짜(event_at)가 없어 일정에 보이지 않음`, 400);

    const records = new EntityRegisterRecordsRepository(store.getRawDb());
    const record = records.activeScheduleRecordForNode(nodeId);
    if (record) {
      await revertEntityRegisterRecord(store, records, record.id);
      const source = await store.getNode(record.sourceNodeId);
      const sourceMemoFlagged = source !== null && source.eventAt !== null;
      if (sourceMemoFlagged) setFlag(store, record.sourceNodeId, true);
      return { nodeId, hidden: true, action: "reverted_schedule", revertedRecordId: record.id, sourceMemoFlagged };
    }
    setFlag(store, nodeId, true);
    records.addIgnore(nodeId, "schedule", SCHEDULE_IGNORE_NAME_KEY, "ignored");
    return { nodeId, hidden: true, action: "flagged" };
  });
}
