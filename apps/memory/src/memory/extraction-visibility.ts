/**
 * extraction-visibility.ts — 추출 한 건 동안 쓰는 가시성 보기(WP-B1-07, SL-8).
 *
 * 추출은 자식 노드를 하나씩 넣고 자식마다 충돌 검사를 한다. 자식을 넣을 때마다 가시성
 * 변경 번호가 올라가므로, 검사마다 가시성을 새로 읽으면 자식 수만큼 전체 노드 스캔이
 * 반복된다. 이 보기는 스냅샷 하나를 잡아 두고, 이번 추출이 만든 노드 id 만 허용 목록에
 * 더한다.
 *
 * 정확성: 이 보기는 쓰기 잠금(withMemoryMutationLock) 안에서만 쓴다. 그 동안의 쓰기는
 * 이번 추출의 것뿐이다 — 새 노드(admit 으로 허용), 중복 흡수의 mention 증가(가시성 무관),
 * 충돌 검사가 새 노드를 disputed 로 바꾸는 쓰기(검사가 후보 행을 새로 읽는 isCurrentMemory
 * 로 거른다). 새 노드는 계보 엣지가 아직 없어 부모 지지가 필요 없으므로, 현재 기억이면
 * 기본 규칙에서도 허용된다. 시간 경계(validFrom·validUntil)를 지나면 스냅샷을 다시 잡는다.
 */

import {
  getMemoryVisibilitySnapshot,
  type MemoryVisibilityOwner,
  type MemoryVisibilitySnapshot,
} from "./shared-memory-read.ts";

/** 충돌 검사가 후보 한 건의 기본 조회 허용 여부를 묻는 통로. */
export interface MemoryVisibilityCheck {
  isAllowed(id: number): boolean;
}

export class ExtractionVisibility implements MemoryVisibilityCheck {
  private readonly admitted = new Set<number>();

  /**
   * @param owner    가시성을 읽을 DB 또는 store.
   * @param snapshot 호출자가 같은 잠금 안에서 이미 잡은 스냅샷. 없으면 처음 물을 때 잡는다
   *                 (충돌 검사 대상이 없는 추출은 스캔하지 않는다).
   */
  constructor(
    private readonly owner: MemoryVisibilityOwner,
    private snapshot: MemoryVisibilitySnapshot | null = null,
  ) {}

  /** 이번 추출이 만든 노드를 허용 목록에 더한다. */
  admit(id: number): void {
    this.admitted.add(id);
  }

  isAllowed(id: number): boolean {
    if (this.admitted.has(id)) return true;
    const now = Date.now();
    if (this.snapshot === null || now < this.snapshot.windowStart || now >= this.snapshot.windowEnd) {
      this.snapshot = getMemoryVisibilitySnapshot(this.owner, now);
    }
    return this.snapshot.isAllowed(id);
  }
}
