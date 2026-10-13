/**
 * home/detail-trash-control.ts
 *
 * 홈 대시보드 상세 표면의 삭제(휴지통 이동) 버튼 — 개별 삭제 spec T4.
 * confirm 문구·파생 건수 계산·API 호출·토스트·목록 갱신을 이 모듈에 모아
 * dashboard-entry.ts 는 조립만 담당한다(mini-graph.ts 와 같은 분리 패턴).
 */

import { el } from "../ui/dom.ts";
import { showToast } from "../form/toast.ts";
import { trashMemory } from "./dashboard-api.ts";

export interface TrashedResult {
  trashed: number;
  cascadeTrashedIds: number[];
}

export interface DetailTrashControlDeps {
  memoryId: number;
  /** 이미 로드된 상세 데이터의 metadata — 재조회하지 않고 재사용한다. */
  metadata: Record<string, unknown> | undefined;
  /**
   * 성공 시 목록·그래프 등 핵심 데이터 재조회. trash API 응답(원문 id + cascade 자식
   * id)을 그대로 받아 호출자가 검색 결과 등 부가 상태를 정리할 수 있게 한다.
   */
  onTrashed: (result: TrashedResult) => Promise<void> | void;
  confirmFn?: (message: string) => boolean;
}

/** metadata.extractedTo 배열 길이. 부재·비배열은 0(파생 없음)으로 취급한다. */
export function extractedToCount(metadata: Record<string, unknown> | undefined): number {
  const raw = metadata?.["extractedTo"];
  return Array.isArray(raw) ? raw.length : 0;
}

export function trashConfirmMessage(approxCount: number): string {
  return `이 기억을 휴지통으로 옮긴다 (파생 항목 약 ${approxCount}건 포함).\n` +
    "휴지통에서 복원 가능, 보존 기간이 지나면 자동 영구 삭제.\n\n진행할까?";
}

/** 상세 화면에 붙일 삭제 버튼 블록을 만든다. */
export function detailTrashControl(deps: DetailTrashControlDeps): HTMLElement {
  const { memoryId, metadata, onTrashed } = deps;
  const confirmFn = deps.confirmFn ?? globalThis.confirm.bind(globalThis);

  const button = el(
    "button",
    { type: "button", className: "node-window__trash-toggle detail-trash-btn" },
    "삭제",
  ) as HTMLButtonElement;

  button.addEventListener("click", () => {
    void (async () => {
      const approxCount = extractedToCount(metadata);
      const ok = confirmFn(trashConfirmMessage(approxCount));
      if (!ok) return;

      button.disabled = true;
      try {
        const res = await trashMemory(memoryId);
        showToast(
          `휴지통으로 이동 (파생 ${res.cascadeTrashedIds.length}건 포함) — 휴지통에서 복원 가능`,
          "success",
        );
        await onTrashed(res);
      } catch (error) {
        showToast(`삭제 실패: ${(error as Error).message}`, "error");
        button.disabled = false;
      }
    })();
  });

  return el("div", { className: "node-window__trash detail-trash" }, button);
}
