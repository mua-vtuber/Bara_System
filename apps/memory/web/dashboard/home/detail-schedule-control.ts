/**
 * home/detail-schedule-control.ts
 *
 * 홈 대시보드 상세 표면의 "일정 아님" / "일정으로 다시 보기" 버튼.
 * 글과 날짜는 그대로 두고 일정 목록에서만 빼거나 되돌린다(서버 memory/schedule-visibility.ts).
 * confirm·API 호출·토스트·목록 갱신을 이 모듈에 모아 dashboard-entry.ts 는 조립만 한다(detail-trash-control.ts 와 같은 패턴).
 */

import { el } from "../ui/dom.ts";
import { showToast } from "../form/toast.ts";
import { setScheduleVisibility, type ScheduleVisibilityResult } from "./dashboard-api.ts";
import { DETAIL_SCHEDULE_STRINGS as S } from "./detail-schedule-strings.ts";

/** 서버 metadata 칸 이름 — memory/cleanup-deep-pass/entity-register/constants.ts 의 SCHEDULE_* 와 같은 값. */
const SCHEDULE_HIDDEN_KEY = "scheduleHidden";
const SCHEDULE_OCCURRENCE_KEY = "scheduleOccurrence";

export interface DetailScheduleControlDeps {
  memoryId: number;
  /** 상세에서 읽은 event_at. 없으면(null/빈 값) 일정에 안 보이는 글이라 버튼을 만들지 않는다. */
  eventAt: string | null | undefined;
  /** 이미 로드된 상세 metadata — 재조회하지 않는다. */
  metadata: Record<string, unknown> | undefined;
  /** 성공 시 호출 — 목록·그래프 재조회와, 일정 노드가 휴지통으로 갔으면 선택 해제를 호출자가 맡는다. */
  onChanged: (result: ScheduleVisibilityResult) => Promise<void> | void;
  confirmFn?: (message: string) => boolean;
}

export function isScheduleHidden(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[SCHEDULE_HIDDEN_KEY] === true;
}

/** 버튼을 보일 글인가 — 날짜가 있어야 일정 목록에 오를 수 있다. */
export function hasScheduleDate(eventAt: string | null | undefined): boolean {
  return typeof eventAt === "string" && eventAt.trim().length > 0;
}

/** 자동 등록이 만든 일정 노드이거나 #일정: 입력 노드 — 표시 칸(scheduleOccurrence)이 켜진 글. */
export function isScheduleNode(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[SCHEDULE_OCCURRENCE_KEY] === true;
}

/** 상세 화면에 붙일 버튼 블록. 날짜 없는 글이면 null. */
export function detailScheduleControl(deps: DetailScheduleControlDeps): HTMLElement | null {
  if (!hasScheduleDate(deps.eventAt)) return null;
  const { memoryId, metadata, onChanged } = deps;
  const confirmFn = deps.confirmFn ?? globalThis.confirm.bind(globalThis);
  const hidden = isScheduleHidden(metadata);

  const button = el(
    "button",
    { type: "button", className: "au-btn au-btn--ghost au-btn--small detail-schedule-btn" },
    hidden ? S.showButton : S.hideButton,
  ) as HTMLButtonElement;

  button.addEventListener("click", () => {
    void (async () => {
      if (!hidden && !confirmFn(S.hideConfirm(isScheduleNode(metadata)))) return;
      button.disabled = true;
      try {
        const res = await setScheduleVisibility(memoryId, !hidden);
        showToast(hidden ? S.showDone : S.hideDone(res.action === "reverted_schedule"), "success");
        await onChanged(res);
      } catch (error) {
        showToast(S.failed((error as Error).message), "error");
        button.disabled = false;
      }
    })();
  });

  return el("div", { className: "detail-schedule" }, button);
}
