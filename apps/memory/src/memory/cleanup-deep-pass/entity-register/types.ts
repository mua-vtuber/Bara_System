/** entity-register/types.ts — 항목·일정 자동 등록 단계의 공용 형식. */

/** 판정 대상 메모 한 개. createdAt = knowledge_nodes.created_at("YYYY-MM-DD HH:MM:SS"). */
export interface EntityRegisterMemo {
  nodeId: number;
  content: string;
  createdAt: string;
  /** 이미 연결된 이름(사람 mentions·태그 개념·identity 항목) — AI에 알려 주고 판정에서 건너뛴다. */
  alreadyLinked: string[];
}

export interface AiEntity {
  type: string;
  name: string;
}

/** AI가 메모 하나에 대해 돌려주는 답(spec 3장 4번). */
export interface EntityRegisterAiResult {
  nodeId: number;
  entities: AiEntity[];
  /** 본문의 날짜 표현 글자 그대로. */
  eventDateText: string | null;
  /** 메모 작성일 기준으로 계산한 날짜 "YYYY-MM-DD". */
  eventDate: string | null;
  scheduleTitle: string | null;
}

/** 기존 항목 한 개 — 사람은 persons, 나머지는 entities 행. */
export interface NameIndexEntry {
  typeName: string;
  id: string;
  name: string;
  aliases: string[];
}

export interface EntityNameIndex {
  byType: Map<string, NameIndexEntry[]>;
}

export type ProposeReason = "homonym" | "similar" | "honorific" | "auto_apply_off";

export type EntityRegisterOption =
  | { kind: "link_existing"; targetId: string; targetName: string; addAlias: boolean }
  | { kind: "create"; name: string; aliasFromMemo: string | null }
  | { kind: "ignore" };

export type DiscardReason = "not_in_text" | "ignored" | "already_linked" | "unknown_type" | "invalid_name";

export type EntityDecision =
  | { action: "discard"; type: string; name: string; reason: DiscardReason }
  | { action: "auto_link"; type: string; name: string; target: NameIndexEntry }
  | { action: "auto_create"; type: string; name: string }
  | { action: "propose"; type: string; name: string; reason: ProposeReason; options: EntityRegisterOption[] };

export type ScheduleProposeReason = "relative" | "mismatch" | "auto_apply_off" | "title_invalid" | "replace_existing";

export type ScheduleDecision =
  | { action: "none"; reason: "no_date" | "date_text_not_in_text" | "ignored" | "already_registered" }
  | { action: "auto"; title: string; date: string; dateText: string }
  | {
      action: "propose";
      reason: ScheduleProposeReason;
      title: string;
      date: string | null;
      dateText: string;
      existingScheduleNodeId: number | null;
    };

export interface MemoJudgement {
  nodeId: number;
  entities: EntityDecision[];
  schedule: ScheduleDecision;
  memoDate: MemoDateDecision;
}

/**
 * 원본 메모의 event_at 칸 읽기 결과 — 행이 없으면(판정 직전에 지워짐) found:false.
 * source 는 metadata_json.fieldSources.event_at(출처 기록이 없으면 null) — 사유 문구와 되돌리기 검사가 읽는다.
 */
export type MemoEventAtState =
  | { found: false }
  | { found: true; eventAt: string | null; source: "direct" | "system" | "inferred" | null };

/** 이 메모에서 이 단계가 이미 만든 살아 있는 일정. */
export interface ActiveSchedule {
  nodeId: number;
  date: string;
  title: string;
}

/** 메모 날짜 채우기를 제안으로 보내는 이유(yearless-date-cleanup spec 3.3 — 일정 판정과 같은 규칙). */
export type MemoDateProposeReason = "relative" | "mismatch" | "auto_apply_off";

/** 메모 날짜를 채우지 않는 이유 — spec 3.3 표의 1~6번. */
export type MemoDateNoneReason =
  | "memo_missing" | "already_set" | "ignored" | "no_date" | "date_text_not_in_text" | "not_yearless";

/** 원본 메모의 event_at 채우기 판정. 날짜(YYYY-MM-DD)만 다루고 시각은 다루지 않는다. */
export type MemoDateDecision =
  | { action: "none"; reason: MemoDateNoneReason }
  | { action: "auto"; date: string; dateText: string }
  | { action: "propose"; reason: MemoDateProposeReason; date: string | null; dateText: string };

/**
 * 아래 두 목록의 값은 마이그레이션(db/migrations-internal/v48-entity-register.ts, 목록을 넓힌
 * v51-entity-register-memo-date.ts)의 entity_register_records CHECK(decided_by IN …, item_kind IN …)에도 적혀 있다.
 * 값을 더하거나 바꾸면 이미 배포된 DB 의 CHECK 가 그 값을 거부하므로, 표를 다시 만드는 새 마이그레이션을 함께 더해야 한다.
 */
export type RecordDecidedBy = "auto" | "approved";
export type RecordItemKind = "entity_created" | "entity_linked" | "schedule_created" | "memo_date_filled";
